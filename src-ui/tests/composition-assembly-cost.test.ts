// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层装配成本 —— **确定性计数台**（S6 P3 前置性能门，2026-09-15）。
//
// 与 tests/bench/composition-assembly.bench.ts 的分工（关键，别混）：
//   - 基准台（vitest bench）：量**时间/内存**，只报告不进红绿——本机 DSH 宿主
//     进程自身常占一个核（实测 pid 常驻 1.5GB / 1700s+ CPU），时间 rme 常在
//     8–29%，绝对值不构成可靠红绿信号（同判断见 tests/perf-paper-pan.test.tsx 头注）。
//   - 本台：断**结构性事实**（谁被调了几次、实例是否同一份），与机器负载无关，
//     因此能进常态套件当回归钉子。P3 会往装配路径上加「激活账 / requires 校验 /
//     exclusive 冲突检测」，本台就是它的**成本形态基线**。
//
// 钉住的六条形态（每条都对应一条真实机制，退化即红）：
//   ① 行工厂每装配恰调用一次/行（buildToolRegistry 的 Promise.all 语义）；
//   ② **族实例缓存（内层）**：同一个行工厂被调两次 ⇒ 同名工具**同一实例** ——
//      plugins/builtin/contribution-helpers.ts 的 `family ??= build(exec)`；
//   ③ **贡献实例缓存（外层）**：两次建表（同一份贡献行）⇒ 同名工具**同一实例** ——
//      composition/services.ts 的 ToolsService.register 在注册时建一次并缓存实例
//      （S4-1.5「工具实例不随每次装配重建」）；
//      ⚠️ 两层是**独立**的：2026-09-15 破测实证——去掉内层 `??=` 时 ③ 仍绿
//      （外层缓存兜住了），故 ② 必须**绕过外层**直接打行工厂本身；
//   ④ 新通道 apply ⇒ 族重建（实例不同）—— ②③ 的负向对照，证明其相等不是空断言；
//   ⑤ 组合解析零拷贝：cache 读返回同一对象（P2 的 owner 查表是 Map.get + 既有引用）；
//   ⑥ seam 作用域查表零拷贝 + 对称清理（P2 装配期值注入的调用期成本形态）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildToolRegistry } from '../src/agent/runtime/agent-builder';
import type { Tool, ToolRegistry } from '../src/agent/tool';
import {
  activationPlan,
  activationStates,
  clearActivationsForTest,
  declareActivation,
  releaseActivation,
  retainActivation,
} from '../src/composition/activation';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { effectiveComposition } from '../src/composition/preset-assembly';
import { factoryComposition, type ResolvedComposition, resolveRoster } from '../src/composition/roster';
import { registerSeamScope, seamScopeOf } from '../src/composition/seam-scope';
import { activeToolContributions } from '../src/composition/services';
import type { BuiltinToolRow } from '../src/composition/tool-rows';
import { SubAgentPool } from '../src/plugins/builtin/subagent-in-process/coordinator';
import { TaskManager } from '../src/plugins/builtin/task-domain/task';

/** 计数用包装行：记调用次数，原样转发给真实 factory。 */
function countingRows(rows: BuiltinToolRow[]): { rows: BuiltinToolRow[]; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const wrapped = rows.map((row) => ({
    ...row,
    factory: (rowCtx: Parameters<BuiltinToolRow['factory']>[0]) => {
      calls.set(row.id, (calls.get(row.id) ?? 0) + 1);
      return row.factory(rowCtx);
    },
  }));
  return { rows: wrapped, calls };
}

function buildWith(toolRows: BuiltinToolRow[]): Promise<ToolRegistry> {
  return buildToolRegistry({
    deps: {},
    taskManager: new TaskManager(),
    subAgentPool: new SubAgentPool(),
    toolRows,
  });
}

let standard: ResolvedComposition;

beforeAll(async () => {
  standard = await withFirstPartyToolChannel(() => withFirstPartyCapabilityChannel(async () => factoryComposition()));
});

afterAll(() => {
  // 本台只读组合产物；无长驻副作用需要收尾（seam 作用域用例自带 disposer）。
});

describe('装配成本形态（确定性计数，与机器负载无关）', () => {
  it('① 行工厂每装配恰调用一次/行（不重复建行、不漏行）', async () => {
    const { rows, calls } = countingRows(standard.tools);
    expect(rows.length).toBeGreaterThan(10);
    await buildWith(rows);
    expect(calls.size).toBe(rows.length);
    for (const [id, n] of calls) expect(n, `行 ${id} 被调用 ${n} 次`).toBe(1);
  });

  it('② 族实例缓存（内层）：同一个贡献 factory 被调两次 ⇒ 同名工具同一实例', async () => {
    // 必须绕过**行级 instanceCache**（plugin-tool-rows 的模块级 Map）才有意义——
    // 2026-09-15 破测实证：直接打行工厂会命中行级缓存，内层缓存退化也照绿。
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const rowCtx = { codingExec: async () => 'stub' } as unknown as Parameters<BuiltinToolRow['factory']>[0];
        const contrib = activeToolContributions().find((c) => c.id.endsWith('/run_shell'));
        expect(contrib, '应能在册找到 shell 域贡献').toBeDefined();
        const a = await contrib!.factory(rowCtx);
        const b = await contrib!.factory(rowCtx);
        const pick = (out: Tool | Tool[]) => (Array.isArray(out) ? out : [out]).find((t) => t.name() === 'run_shell');
        expect(pick(a)).toBeDefined();
        expect(pick(a)).toBe(pick(b));
      }),
    );
  });

  it('③ 行级 instanceCache（外层）：同一份贡献行建第二张表 ⇒ 同名工具同一实例', async () => {
    const first = await buildWith(standard.tools);
    const second = await buildWith(standard.tools);
    // 行工厂每次装配都会被调用（表必须重建），但实例来自行级缓存 —— 热路径零重建的物理根据
    const a = first.get('run_shell');
    const b = second.get('run_shell');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).toBe(b);
  });

  it('④ 行级缓存兜不住的例外：noCache 贡献每装配重创实例（P3 激活语义的现有旋钮）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const row = pluginToolRows().find((r) => r.id.includes('wait-domain'));
        expect(row, '应能在册找到 wait 域 noCache 行').toBeDefined();
        const rowCtx = {
          codingExec: async () => 'stub',
          subAgentPool: {},
        } as unknown as Parameters<BuiltinToolRow['factory']>[0];
        const a = await row!.factory(rowCtx);
        const b = await row!.factory(rowCtx);
        expect(a.length).toBeGreaterThan(0);
        expect(a[0]).not.toBe(b[0]);
      }),
    );
  });
  it('⑤ 新通道 apply ⇒ 族重建（实例不同）——②③ 的负向对照', async () => {
    const outside = await buildWith(standard.tools);
    const inside = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => buildWith(factoryComposition().tools)),
    );
    expect(inside.get('run_shell')).toBeDefined();
    expect(inside.get('run_shell')).not.toBe(outside.get('run_shell'));
  });

  it('⑥ 组合解析零拷贝：cache 读返回同一对象；纯函数解析每次新对象但行序一致', () => {
    expect(effectiveComposition('standard')).toBe(effectiveComposition('standard'));
    const p = resolveRoster(standard, []);
    const q = resolveRoster(standard, []);
    expect(p).not.toBe(q); // 纯函数不共享产物
    expect(p.tools.map((r) => r.id)).toEqual(q.tools.map((r) => r.id)); // 但序与内容一致
    expect(p.tools.map((r) => r.id)).toEqual(standard.tools.map((r) => r.id)); // 零 patch = 恒等
  });

  it('⑦ seam 作用域查表零拷贝 + 对称清理（P2 装配期值注入的调用期成本形态）', () => {
    const view = standard.seamDisabled;
    expect(seamScopeOf('cost-probe')).toBeUndefined();
    const dispose = registerSeamScope('cost-probe', view);
    expect(seamScopeOf('cost-probe')).toBe(view); // 同一引用 ⇒ 无拷贝/无分配
    dispose();
    expect(seamScopeOf('cost-probe')).toBeUndefined();
    dispose(); // 幂等
  });
});

// S6 P3（激活账）的成本形态——新增记账面不得引入「每装配多次记账」或
// 「每次记账新建账条目」的退化（那是 O(装配数) 的隐藏成本，时间台看不出来）。
describe('⑧⑨ 激活账成本形态（S6 P3）', () => {
  afterEach(() => clearActivationsForTest());

  it('⑧ 每装配每插件恰一次 retain：N 次装配 ⇒ 账 holders 恰 N，副作用只启动一次', async () => {
    let starts = 0;
    declareActivation('acme/cost', {
      start: () => {
        starts++;
      },
    });
    for (let i = 0; i < 3; i++) await retainActivation('acme/cost', `agent-${i}`);
    expect(starts).toBe(1); // 首次激活才 start
    expect(activationStates()).toEqual([{ plugin: 'acme/cost', holders: 3, started: true, failure: null }]);
    // 组合里没有它的行 ⇒ 零记账（不声明/不在组合 = 零成本）；有它的行 ⇒ 恰一次进计划
    expect(activationPlan({ tools: [{ id: 'plugin/other/x' }] })).toEqual([]);
    expect(activationPlan({ tools: [{ id: 'plugin/acme/cost/probe' }] })).toEqual(['acme/cost']);
  });

  it('⑨ 账条目按插件单份（同 holder 重复 retain 不重复计数）+ 陈旧句柄释放幂等', async () => {
    const log: string[] = [];
    declareActivation('acme/cost', {
      start: () => {
        log.push('start');
      },
      stop: () => {
        log.push('stop');
      },
    });
    const h1 = await retainActivation('acme/cost', 'same-holder');
    const h2 = await retainActivation('acme/cost', 'same-holder'); // 同一持有者：Set 判据 ⇒ 不加新条目
    expect(activationStates()).toHaveLength(1);
    expect(activationStates()[0]?.holders).toBe(1);
    expect(log).toEqual(['start']);

    await releaseActivation(h1);
    expect(log).toEqual(['start', 'stop']); // 归零即停 + 账清零
    expect(activationStates()).toEqual([]);
    await releaseActivation(h2); // 陈旧句柄：账已清，无动作（不重复 stop）
    expect(log).toEqual(['start', 'stop']);
  });
});
