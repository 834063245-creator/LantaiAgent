// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理 seam 守护（平台化 Phase 1 · D3，2026-08-27）：
//   ① 裸路径（无装配）→ SUBAGENT_PROVIDER 响亮报错（显式降级，对齐 P1-C2 精神）
//   ② 生产装配（helper）后 builtin/in-process 在册且为默认（后注册胜取尾）
//   ③ 外部 provider 后注册胜覆盖；dispose 分层回落（对齐 llm/renderers 语义）
//   ④ 消费路由：Agent.spawnSubAgent 经注册表派发（probe provider 接管返回）
// 默认 provider 行为与现状逐字节一致由既有 spawn 套件钉住（impl 原样透传）。

// 注意用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { ToolRegistry } from '../src/agent/tool';
import { activeSubagentProviders, type SubagentProvider } from '../src/composition/subagent-service';
import type { Provider } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

function fakeProvider(tag: string): Provider {
  return {
    name: () => tag,
    stream: async function* () {
      /* 探针不产流 */
    },
  };
}

function newAgent(): ReturnType<typeof createTestAgent> {
  return createTestAgent(fakeProvider('main'), new ToolRegistry(), 'sys', {});
}

describe('子代理 seam（ctx.subagents · D3）', () => {
  it('① 裸路径：无装配 → SUBAGENT_PROVIDER 响亮报错', async () => {
    const agent = newAgent();
    await expect(agent.spawnSubAgent('probe', 'do')).rejects.toThrow(/SUBAGENT_PROVIDER/);
  });

  it('② 生产装配后 builtin/in-process 在册且为默认', async () => {
    await ensureProductionChannelsBooted();
    const list = activeSubagentProviders();
    expect(list.map((p) => p.id)).toContain('builtin/in-process');
    expect(list[list.length - 1]?.id).toBe('builtin/in-process');
  });

  it('③ 后注册胜：外部 provider 覆盖默认；dispose 分层回落', async () => {
    const root = await ensureProductionChannelsBooted();
    const probe: SubagentProvider = {
      id: 'probe/acp',
      spawn: async () => ({ text: 'PROBE-REPORT' }),
    };
    const dispose = root.subagents.register(probe);
    const during = activeSubagentProviders();
    expect(during[during.length - 1]?.id).toBe('probe/acp');
    dispose();
    const after = activeSubagentProviders();
    expect(after[after.length - 1]?.id).toBe('builtin/in-process');
  });

  it('④ 消费路由：Agent.spawnSubAgent 经注册表派发（probe 接管返回）', async () => {
    const root = await ensureProductionChannelsBooted();
    const probe: SubagentProvider = {
      id: 'probe/route',
      spawn: async () => ({ text: 'PROBE-REPORT' }),
    };
    const dispose = root.subagents.register(probe);
    const out = await newAgent().spawnSubAgent('probe', 'do');
    expect(out.text).toBe('PROBE-REPORT');
    dispose();
  });
});
