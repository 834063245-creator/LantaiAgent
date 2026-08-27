// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化 seam 守护（平台化 Phase 2 · D11 施工⑥，2026-08-27）：
//   ① 裸路径（无装配）→ SESSION_PERSISTENCE_PROVIDER 响亮报错（显式降级）
//   ② builtin 映射表：五动作 → 现有 Rust 命令恒等（P2-C1 形状钉）
//   ③ 消费路径（P2-C2 同型）：AgentStore 全 CRUD 经注册表路由，fake provider
//      收到 snake_case 参数原样透传，零消费面改动
//
// 注：本 seam 为基础设施层（非模型工具管道），无 gate 旁路面——强制层
// P2-C3 守卫由 fs/shell seam 覆盖（provider 换实现不影响管道层语义）。

// 注意用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { AgentStore } from '../src/agent/agent-store';
import { SESSIONS_COMMAND_BY_ACTION } from '../src/agent/sessions-provider';
import type { SessionPersistAction, SessionPersistenceProvider } from '../src/composition/session-persistence-service';
import { sessionExecute } from '../src/composition/session-persistence-service';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

describe('sessionPersistence seam（D11 施工⑥）', () => {
  it('① 裸路径：无装配 → SESSION_PERSISTENCE_PROVIDER 响亮报错', async () => {
    await expect(sessionExecute('read', { file_path: '/x/a.json' })).rejects.toThrow(/SESSION_PERSISTENCE_PROVIDER/);
  });

  it('② builtin 映射表：五动作 → 现有 Rust 命令恒等（P2-C1 形状钉）', () => {
    expect(SESSIONS_COMMAND_BY_ACTION).toEqual({
      read: 'read_file_content',
      write: 'write_file_content',
      append: 'agent_session_append',
      appendLog: 'log_append',
      mkdir: 'create_directory',
      delete: 'delete_file_or_dir',
    });
  });

  it('③ 消费路径：AgentStore 全 CRUD 经注册表路由（fake provider 收 snake 参数原样透传）', async () => {
    const root = await ensureProductionChannelsBooted();
    const calls: Array<{ action: SessionPersistAction; args: Record<string, unknown> }> = [];
    const files = new Map<string, string>();
    const fake: SessionPersistenceProvider = {
      id: 'test/memory-sessions',
      async execute(action, args) {
        calls.push({ action, args });
        if (action === 'read') return files.get(String(args.file_path)) ?? '';
        if (action === 'write') {
          files.set(String(args.file_path), String(args.content));
          return 'null';
        }
        if (action === 'append') return 'null';
        return 'null';
      },
    };
    const dispose = root.sessionPersistence.register(fake);

    const store = new AgentStore('/proj');
    await store.save('agent-1', { parentId: null, description: 'probe', status: 'done', createdAt: 1 });
    await store.appendMessages('agent-1', [{ role: 'assistant', content: 'hi' }] as never);
    const loaded = await store.load('agent-1');
    await store.delete('agent-1');

    // 动作序列覆盖五动词（mkdir×2 + write 状态 + read/write 索引 + append + delete）
    const actions = calls.map((c) => c.action);
    expect(actions).toContain('mkdir');
    expect(actions).toContain('append');
    expect(actions).toContain('delete');
    const stateWrite = calls.find((c) => c.action === 'write' && String(c.args.file_path).includes('agent-1/state'));
    expect(stateWrite?.args.content).toContain('"description": "probe"');
    const append = calls.find((c) => c.action === 'append');
    expect(append?.args).toMatchObject({ project_path: '/proj', agent_id: 'agent-1', rewrite: false });
    // load：经 fake 存储读回状态（snake 参数原样透传的证据）
    expect(loaded?.record.id).toBe('agent-1');

    dispose();
  });
});
