// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// profile 断言（S6 §3.7 欠账 / §7.8）——「会话数不进门禁矩阵」。
//
// 命题：**同一 preset 在会话数 1 / 2 / 5 下，每卷的有效装配快照逐字节一致。**
// 它证明的是「门禁矩阵的维度 = 出厂 preset 集合，不是并存会话数」——如果并存
// 卷数会改变单卷的模型可见面（例如激活账、共享注册表、seam 视图被写成全局态），
// 那么两轨快照的作证力就漏了一个维度，而用户最容易踩的恰恰是并存场景。
//
// 口径（设计件 §7.8）：同一 preset、N 卷并存、对拍**每卷**的 tool-schemas 字节
// + 激活账读数恰为 N（副作用只启动一次——引用计数语义）。**不新增 baseline
// 快照**（同测试内对拍 ⇒ 零审批成本；快照是「出厂 preset 维度」的事）。
//
// 破测（2026-09-15 注入验证）：把激活账写成全局单值（refcount 不按持有者集合
// 计）→ 账读数断言红；把 seam 视图写成模块全局（第二卷覆盖第一卷）→ 若两卷
// seamDisabled 不同则字节断言红（本用例的 standard 两卷构造性为空，故另由
// tests/seam-composition.test.ts 的序列 D 用例兜住）。

import { afterEach, describe, expect, it, vi } from 'vitest';
// 批 6c：出厂 hook 实现（state-hooks 产物）在生产由装载器常驻登记；
// service 类 ⇒ 缺实现装配期 fail-loud——本文件自行装配 Agent，须先复现该登记态。
import { installStateHooksForTest } from './helpers/state-hooks-impl';

installStateHooksForTest();

// 批 6d-2：压缩实现（compaction 产物）在生产由装载器常驻登记；service 类 ⇒ 缺实现 fail-loud。
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { SubAgentPool } from '../src/agent/coordinator';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { activationStates, clearActivationsForTest, declareActivation } from '../src/composition/activation';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { factoryComposition, type ResolvedComposition } from '../src/composition/roster';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import type { SubAgentSpawner } from '../src/plugins/builtin/agent-domain/subagent-tools';
import type { Provider } from '../src/provider/types';

function stubProvider(): Provider {
  return {
    name: () => 'stub',
    model: () => 'stub',
    stream: async function* () {
      /* 探针不产流 */
    },
  } as unknown as Provider;
}

const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;

/** 开 N 卷（同一份组合产物），返回每卷的工具 schema 序列化字节 + 句柄
 *  （句柄留给调用方——「并存期间的账读数」要在关卷前断言）。 */
async function schemasForSessionsKeeping(
  rt: AgentRuntime,
  comp: ResolvedComposition,
  n: number,
): Promise<{ bytes: string[]; handles: Array<{ dispose(): void }> }> {
  const bytes: string[] = [];
  const handles: Array<{ dispose(): void }> = [];
  for (let i = 0; i < n; i++) {
    const h = await rt.createAgent(
      {
        projectPath: '',
        provider: stubProvider(),
        tools: new ToolRegistry(),
        subAgentPool: new SubAgentPool(),
        subAgentSpawner: stubSpawner,
        eventSink: () => {},
      },
      comp,
    );
    const agent = (h as unknown as { _getAgent(): { tools: ToolRegistry } })._getAgent();
    bytes.push(JSON.stringify(agent.tools.schemas()));
    handles.push(h);
  }
  return { bytes, handles };
}

/** 开 N 卷并全部关掉（纯字节对拍用）。 */
async function schemasForSessions(rt: AgentRuntime, comp: ResolvedComposition, n: number): Promise<string[]> {
  const { bytes, handles } = await schemasForSessionsKeeping(rt, comp, n);
  for (const h of handles) h.dispose();
  return bytes;
}

afterEach(() => {
  clearActivationsForTest();
});

describe('S6 §7.8 profile 断言：会话数不进门禁矩阵', () => {
  it('同一 preset 在 1 / 2 / 5 卷下，每卷的工具面字节完全一致（含 standard 全量面）', async () => {
    const comp = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => factoryComposition()),
    );
    const rt = new AgentRuntime(undefined, undefined, comp);
    await rt.ready();

    const one = await schemasForSessions(rt, comp, 1);
    const two = await schemasForSessions(rt, comp, 2);
    const five = await schemasForSessions(rt, comp, 5);

    expect(one[0]?.length ?? 0).toBeGreaterThan(2); // 非空断言（空集会让本条变成空真）
    expect(two).toEqual([one[0], one[0]]); // 第二卷逐字节等于第一卷
    expect(five).toEqual([one[0], one[0], one[0], one[0], one[0]]); // 五卷同理
  });

  it('并存卷数只进激活账（副作用起一次），不进任何单卷的可见面', async () => {
    const log: string[] = [];
    const comp = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => factoryComposition()),
    );
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    // 声明激活的插件：它的行在组合里（借用一条真实第一方行的属主名）
    declareActivation('hologram/web-domain', {
      resources: ['stdio'],
      start: () => {
        log.push('start');
      },
      stop: () => {
        log.push('stop');
      },
    });
    const rt = new AgentRuntime(undefined, root, comp);
    await rt.ready();

    const four = await schemasForSessionsKeeping(rt, comp, 4);
    expect(new Set(four.bytes).size).toBe(1); // 四卷字节同一份（并存不改变单卷可见面）
    expect(log).toEqual(['start']); // 副作用只启动一次（引用计数）
    expect(activationStates()).toEqual([{ plugin: 'hologram/web-domain', holders: 4, started: true, failure: null }]);

    for (const h of four.handles) h.dispose();
    await vi.waitFor(() => expect(activationStates()).toEqual([])); // 全部关卷 ⇒ 归零
    expect(log).toEqual(['start', 'stop']);

    await fiber.dispose();
  });
});
