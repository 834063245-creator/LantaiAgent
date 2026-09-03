// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs seam 守护（平台化 Phase 2 · D11，2026-08-27）：
//   ① 裸路径（无装配）→ FS_PROVIDER 响亮报错（显式降级）
//   ② builtin/rust-fs 默认 + 消费路由：工具 execute 经注册表→dispatch 腰，
//      命令名/args 恒等（P2-C1 行为逐字节一致）
//   ③ rename 键名改写保持（path/new_name → filePath/newName）
//   ④ fake 替换（内存 fs）零消费面改动，dispatch 腰不被触碰（P2-C2）
//   ⑤ P2-C3 守卫：plan 激活 → executor 管道层拦截 fs(write)——provider 与
//      dispatch 均未触；plan 未激活时同一 provider 正常服务（gate 在管道层）

// 注意用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { AgentEventBus, attachPlanGate } from '../src/agent/events';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import { createFsTools, fsExecute } from '../src/agent/tools/coding';
import type { FsAction, FsProvider } from '../src/composition/fs-service';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

const stubExec: ToolExecutor = async () => 'stub';

function toolByName(name: string, exec: ToolExecutor): Tool {
  const t = createFsTools(exec).find((x) => x.name() === name);
  if (!t) throw new Error(`fs 工具缺失: ${name}`);
  return t;
}

function memoryFs(files: Map<string, string>, calls: string[]): FsProvider {
  return {
    id: 'test/memory-fs',
    async execute(action, args) {
      calls.push(action);
      if (action === 'read') return files.get(String(args.filePath)) ?? '(memory: ENOENT)';
      if (action === 'write') {
        files.set(String(args.filePath), String(args.content));
        return '(memory: written)';
      }
      if (action === 'edit') {
        const p = String(args.filePath);
        const cur = files.get(p) ?? '';
        files.set(p, cur.split(String(args.oldString)).join(String(args.newString)));
        return '(memory: edited)';
      }
      return `(memory-fs) ${action}`;
    },
  };
}

describe('fs seam（ctx.fs · D11）', () => {
  it('① 裸路径：无装配 → FS_PROVIDER 响亮报错', async () => {
    const t = toolByName('read_file_content', stubExec);
    await expect(t.execute({ filePath: '/x/a.ts' })).rejects.toThrow(/FS_PROVIDER/);
  });

  it('② builtin 默认 + 消费路由：dispatch 收到恒等命令名与 args（P2-C1）', async () => {
    const root = await ensureProductionChannelsBooted();
    expect(root.fs.list().map((p) => p.id)).toContain('builtin/rust-fs');
    const dispatchCalls: Array<{ name: string; args: unknown }> = [];
    const spyExec: ToolExecutor = async (name, args) => {
      dispatchCalls.push({ name, args });
      return 'ok:rust';
    };
    const meta = { filePath: '/x/a.ts', _agent_id: 'agent-42' };
    const out = await toolByName('read_file_content', spyExec).execute(meta);
    expect(out).toBe('ok:rust');
    // P2-2 信封化：恒等保证的载体从命令名移到信封——plugin.tool 寻址
    // builtin.fs.read_file_content，args 原样（含 _agent_id）。
    expect(dispatchCalls).toEqual([
      { name: 'tool_call', args: { plugin: 'builtin.fs', tool: 'read_file_content', args: meta } },
    ]);
  });

  it('③ rename 键名改写保持（path/new_name → filePath/newName）', async () => {
    await ensureProductionChannelsBooted();
    const dispatchCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const spyExec: ToolExecutor = async (name, args) => {
      dispatchCalls.push({ name, args });
      return 'ok';
    };
    await toolByName('rename_file', spyExec).execute({ path: '/x/a.ts', new_name: 'b.ts', _agent_id: 'w1' });
    // P2-2 信封化：折写后的 filePath/newName 在信封 args 内（manifest 语言）
    expect(dispatchCalls[0]?.name).toBe('tool_call');
    const env = dispatchCalls[0]?.args as { plugin?: string; tool?: string; args?: Record<string, unknown> };
    expect(env.plugin).toBe('builtin.fs');
    expect(env.tool).toBe('rename_file_or_dir');
    expect(env.args).toMatchObject({ filePath: '/x/a.ts', newName: 'b.ts', _agent_id: 'w1' });
  });

  it('④ fake 替换：内存 fs 零消费面改动，dispatch 腰不被触碰（P2-C2）', async () => {
    const root = await ensureProductionChannelsBooted();
    const files = new Map<string, string>([['/mem/a.ts', 'hello seam']]);
    const calls: string[] = [];
    let rustDispatchCalls = 0;
    const spyExec: ToolExecutor = async () => {
      rustDispatchCalls++;
      return 'ok:rust';
    };
    const dispose = root.fs.register(memoryFs(files, calls));
    // 消费面零改动：同一个 createFsTools 工厂、同一 execute 调用形状
    const readOut = await toolByName('read_file_content', spyExec).execute({ filePath: '/mem/a.ts' });
    expect(readOut).toBe('hello seam');
    const writeTool = toolByName('write_file', spyExec);
    await writeTool.execute({ filePath: '/mem/a.ts', content: 'replaced' });
    const editOut = await toolByName('edit_file', spyExec).execute({
      filePath: '/mem/a.ts',
      oldString: 'replaced',
      newString: 'edited',
    });
    expect(editOut).toBe('(memory: edited)');
    expect(files.get('/mem/a.ts')).toBe('edited');
    expect(calls).toEqual(['read', 'write', 'edit']);
    expect(rustDispatchCalls).toBe(0); // 替代 provider 不触碰 Rust 派发腰
    dispose();
    // 回落 builtin → 同一调用回到 Rust 腰
    const back = await toolByName('read_file_content', spyExec).execute({ filePath: '/mem/a.ts' });
    expect(back).toBe('ok:rust');
    expect(rustDispatchCalls).toBe(1);
  });

  it('⑤ P2-C3：plan 激活拦截 fs(write)——provider 与 dispatch 均未触；未激活时正常服务', async () => {
    const root = await ensureProductionChannelsBooted();
    const files = new Map<string, string>();
    const providerCalls: string[] = [];
    const dispatchCalls: string[] = [];
    const spyExec: ToolExecutor = async (name) => {
      dispatchCalls.push(name);
      return 'ok:rust';
    };
    const dispose = root.fs.register(memoryFs(files, providerCalls));

    // 消费面经真实 fsExecute 路由的 fs 域工具（形状对齐 plan-gate.test 域工具）
    const fsTool: Tool = {
      name: () => 'fs',
      description: () => 'fs domain via seam',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => false,
      domain: () => 'fs',
      actions: () => ['read', 'write', 'edit', 'list'],
      readOnlyActions: () => ['read', 'list'],
      execute: async (args) => fsExecute(String((args as { action?: unknown }).action) as FsAction, args, spyExec),
    };
    const registry = new ToolRegistry();
    registry.register(fsTool);
    const ps = new PlanStateManager();
    const gate = (name: string, args: Record<string, unknown>, tool: Tool) => planGateCheck(ps, name, args, tool);
    const bus = new AgentEventBus();
    attachPlanGate(bus, gate);
    const executor = new StreamingToolExecutor(registry, () => {}, null, null, bus);

    // plan 未激活 → 放行，内存 provider 服务（dispatch 不触——替代实现）
    executor.addTool({ id: 'c0', name: 'fs', arguments: '{"action":"write","filePath":"/mem/p.ts","content":"x"}' });
    const pass = await executor.awaitRemaining();
    expect(pass[0]?.output).toBe('(memory: written)');
    expect(providerCalls).toEqual(['write']);
    expect(dispatchCalls).toEqual([]);

    // plan 激活 → 管道层拦截，provider/dispatch 均未触（换 provider 不豁免 gate）
    ps.enter('/proj');
    const ex2 = new StreamingToolExecutor(registry, () => {}, null, null, bus);
    ex2.addTool({ id: 'c1', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts","content":"y"}' });
    const blocked = await ex2.awaitRemaining();
    expect(blocked[0]?.output).toContain('[已拦截]');
    expect(providerCalls).toEqual(['write']); // 未新增
    expect(dispatchCalls).toEqual([]); // 未新增
    dispose();
  });
});
