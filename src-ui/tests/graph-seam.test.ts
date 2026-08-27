// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// graph seam 守护（平台化 Phase 2 · D11 施工⑦，2026-08-27）：
//   ① 裸路径（无装配）→ GRAPH_PROVIDER 响亮报错（显式降级）
//   ② builtin/rust-graph：invoke 经 hologram_call 派发（P2-C1 恒等透传）
//   ③ fake 替换：图分析后端零消费面改动（P2-C2）
//
// 注：hologram 域为模型工具族——gate 旁路面与 fs/shell 同理在 executor 管道层，
// P2-C3 已由 fs/shell seam 守卫覆盖，不在此重复。

// 注意用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// builtin 经 agentInvoke（'hologram_call'）派发——mock 探针捕获调用参数
const agentInvokeSpy = vi.fn(async (method: string, _params: Record<string, unknown>) => `ok:${method}`);
vi.mock('../src/agent/tool', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/agent/tool')>();
  return {
    ...original,
    agentInvoke: (method: string, params: Record<string, unknown>) => agentInvokeSpy(method, params),
  };
});

import { builtinGraphProvider } from '../src/agent/graph-provider';
import type { GraphProvider } from '../src/composition/graph-service';
import { graphExecute } from '../src/composition/graph-service';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

describe('graph seam（ctx.graph · D11 施工⑦）', () => {
  beforeEach(() => {
    agentInvokeSpy.mockClear();
  });

  it('① 裸路径：无装配 → GRAPH_PROVIDER 响亮报错', async () => {
    await expect(graphExecute('graph_summary', {})).rejects.toThrow(/GRAPH_PROVIDER/);
  });

  it('② builtin 默认：invoke 经 hologram_call 恒等派发（P2-C1）', async () => {
    const root = await ensureProductionChannelsBooted();
    expect(root.graph.list().map((p) => p.id)).toContain('builtin/rust-graph');
    const out = await graphExecute('graph_summary', { path: '/proj' });
    expect(agentInvokeSpy).toHaveBeenCalledWith('hologram_call', { tool: 'graph_summary', args: { path: '/proj' } });
    expect(out).toBe('ok:hologram_call');
  });

  it('③ fake 替换：图分析后端零消费面改动；dispose 回落 builtin（P2-C2）', async () => {
    const root = await ensureProductionChannelsBooted();
    const fake: GraphProvider = {
      id: 'test/remote-graph',
      invoke: async (tool, args) => ({ remote: true, tool, args }),
    };
    const dispose = root.graph.register(fake);
    const out = await graphExecute('graph_neighbors', { nodeId: 'n1' });
    expect(out).toEqual({ remote: true, tool: 'graph_neighbors', args: { nodeId: 'n1' } });
    expect(agentInvokeSpy).not.toHaveBeenCalled(); // 替代 provider 不触 engine 腰
    dispose();
    const back = await graphExecute('graph_summary', {});
    expect(back).toBe('ok:hologram_call');
  });

  it('④ builtin 直接引用：provider 对象可独立使用（MCP/远程包装的形状先例）', async () => {
    const out = await builtinGraphProvider.invoke('graph_cycles', {});
    expect(out).toBe('ok:hologram_call');
  });
});
