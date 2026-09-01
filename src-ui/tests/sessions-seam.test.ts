// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化 seam 守护（平台化 Phase 2 · D11 施工⑥，2026-08-27）：
//   ① 裸路径（无装配）→ SESSION_PERSISTENCE_PROVIDER 响亮报错（显式降级）
//   ② builtin 映射表：五动作 → 现有 Rust 命令恒等（P2-C1 形状钉）
//
// 注：2026-09-01 AgentStore 内存化后，本 seam 已无生产消费者（原消费面 =
// agent-store 磁盘 CRUD，见 agent-store.ts 头注）。①② 保留守护 seam 自身
// 契约；seam 骨架的拆除与否另行立案（动它会牵动平台化七 seam 骨架）。

import { SESSIONS_COMMAND_BY_ACTION } from '../src/agent/sessions-provider';
import { sessionExecute } from '../src/composition/session-persistence-service';

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
});
