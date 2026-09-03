// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell seam 守护（平台化 Phase 2 · D11 施工⑤，2026-08-27）：
//   ① 裸路径（无装配）→ SHELL_PROVIDER 响亮报错（显式降级）
//   ② builtin/rust-shell 默认 + 消费路由：run_shell → exec_command 恒等透传（P2-C1）
//   ③ fake 替换（内存 shell）零消费面改动，dispatch 腰不被触碰（P2-C2）
//   ④ P2-C3 守卫：plan 激活 → executor 管道层拦截 shell(run)——provider 与
//      dispatch 均未触（subprocess 并入本 seam 的强制层语义同此）

// 注意用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { AgentEventBus, attachPlanGate } from '../src/agent/events';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import { createShellTools, shellExecute } from '../src/agent/tools/coding';
import type { ShellAction, ShellProvider } from '../src/composition/shell-service';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

const stubExec: ToolExecutor = async () => 'stub';

function toolByName(name: string, exec: ToolExecutor): Tool {
  const t = createShellTools(exec).find((x) => x.name() === name);
  if (!t) throw new Error(`shell 工具缺失: ${name}`);
  return t;
}

function memoryShell(jobs: Array<{ id: number; out: string }>, calls: string[]): ShellProvider {
  let next = 1;
  return {
    id: 'test/memory-shell',
    async execute(action, args) {
      calls.push(action);
      if (action === 'run') {
        const id = next++;
        jobs.push({ id, out: `[memory] ${String(args.command)}` });
        return `(memory: job ${id})`;
      }
      if (action === 'output') {
        const job = jobs.find((j) => j.id === Number(args.jobId));
        return job ? `${job.out}\n[cwd: /mem]` : '(memory: no such job)';
      }
      return `(memory-shell) ${action}`;
    },
  };
}

describe('shell seam（ctx.shell · D11 施工⑤）', () => {
  it('① 裸路径：无装配 → SHELL_PROVIDER 响亮报错', async () => {
    const t = toolByName('run_shell', stubExec);
    await expect(t.execute({ command: 'ls' })).rejects.toThrow(/SHELL_PROVIDER/);
  });

  it('② builtin 默认 + 消费路由：run_shell → exec_command 恒等透传（P2-C1）', async () => {
    const root = await ensureProductionChannelsBooted();
    expect(root.shell.list().map((p) => p.id)).toContain('builtin/rust-shell');
    const dispatchCalls: Array<{ name: string; args: unknown }> = [];
    const spyExec: ToolExecutor = async (name, args) => {
      dispatchCalls.push({ name, args });
      return 'ok:rust';
    };
    const meta = { command: 'cargo test', _agent_id: 'agent-42' };
    const out = await toolByName('run_shell', spyExec).execute(meta);
    expect(out).toBe('ok:rust');
    expect(dispatchCalls).toHaveLength(1);
    // P2-4 信封化：恒等保证的载体从命令名移到信封——plugin.tool 寻址
    // builtin.shell.exec_command，args 原样透传（含 _agent_id）。
    expect(dispatchCalls[0]?.name).toBe('tool_call');
    const env = dispatchCalls[0]?.args as {
      plugin?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };
    expect(env.plugin).toBe('builtin.shell');
    expect(env.tool).toBe('exec_command');
    expect(env.args).toMatchObject({ command: 'cargo test', _agent_id: 'agent-42' });
  });

  it('③ fake 替换：内存 shell 零消费面改动，dispatch 腰不被触碰（P2-C2）', async () => {
    const root = await ensureProductionChannelsBooted();
    const jobs: Array<{ id: number; out: string }> = [];
    const calls: string[] = [];
    let rustDispatchCalls = 0;
    const spyExec: ToolExecutor = async () => {
      rustDispatchCalls++;
      return 'ok:rust';
    };
    const dispose = root.shell.register(memoryShell(jobs, calls));
    // 消费面零改动：同一 createShellTools 工厂、同一 execute 形状
    const run = await toolByName('run_shell', spyExec).execute({ command: 'echo hi', runInBackground: true });
    expect(run).toMatchObject({});
    const out = await toolByName('bash_output', spyExec).execute({ jobId: jobs[0]?.id ?? 1 });
    expect(out).toContain('[memory] echo hi');
    expect(calls).toEqual(['run', 'output']);
    expect(rustDispatchCalls).toBe(0); // 替代 provider 不触碰 Rust 派发腰
    dispose();
    // 回落 builtin → 同一调用回到 Rust 腰
    await toolByName('bash_output', spyExec).execute({ jobId: 999 });
    expect(rustDispatchCalls).toBe(1);
  });

  it('④ P2-C3：plan 激活拦截 shell(run)——provider 与 dispatch 均未触', async () => {
    const root = await ensureProductionChannelsBooted();
    const jobs: Array<{ id: number; out: string }> = [];
    const providerCalls: string[] = [];
    const dispatchCalls: string[] = [];
    const spyExec: ToolExecutor = async (name) => {
      dispatchCalls.push(name);
      return 'ok:rust';
    };
    const dispose = root.shell.register(memoryShell(jobs, providerCalls));

    const shellTool: Tool = {
      name: () => 'shell',
      description: () => 'shell domain via seam',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => false,
      domain: () => 'shell',
      actions: () => ['run', 'output', 'kill', 'wait'],
      readOnlyActions: () => [],
      execute: async (args) =>
        shellExecute(String((args as { action?: unknown }).action) as ShellAction, args, spyExec),
    };
    const registry = new ToolRegistry();
    registry.register(shellTool);
    const ps = new PlanStateManager();
    const gate = (name: string, args: Record<string, unknown>, tool: Tool) => planGateCheck(ps, name, args, tool);
    const bus = new AgentEventBus();
    attachPlanGate(bus, gate);
    const executor = new StreamingToolExecutor(registry, () => {}, null, null, bus);

    // plan 未激活 → 放行，内存 provider 服务（dispatch 不触——替代实现）
    executor.addTool({ id: 'c0', name: 'shell', arguments: '{"action":"run","command":"echo hi"}' });
    const pass = await executor.awaitRemaining();
    expect(pass[0]?.output).toContain('(memory: job');
    expect(providerCalls).toEqual(['run']);
    expect(dispatchCalls).toEqual([]);

    // plan 激活 → 管道层拦截，provider/dispatch 均未触（换 provider 不豁免 gate）
    ps.enter('/proj');
    const ex2 = new StreamingToolExecutor(registry, () => {}, null, null, bus);
    ex2.addTool({ id: 'c1', name: 'shell', arguments: '{"action":"run","command":"rm -rf /"}' });
    const blocked = await ex2.awaitRemaining();
    expect(blocked[0]?.output).toContain('[已拦截]');
    expect(providerCalls).toEqual(['run']); // 未新增
    expect(dispatchCalls).toEqual([]); // 未新增
    dispose();
  });
});
