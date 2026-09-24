// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层装配成本基准台（S6 P3 前置性能门，2026-09-15；设计件 §3.7）。
//
// 口径（对齐 DSH 的「每卷内存增量 + 挂载耗时」，并补兰台特有的两个）：
//   1. **全卷挂载**：createAgentFromContext → dispose 全链（prompt 组装 + 注册表
//      克隆 + blueprint capability 安装）——用户在创作坞「开一卷」付的钱。
//   2. **建注册表冷/热**：冷 = 新通道 apply（建族 + 全量 schema 生成 + 注册 +
//      领域收敛）；热 = 族实例已缓存后裸建表。**分栏是纪律不是偏好**：
//      plugins/builtin/contribution-helpers.ts 的 `family ??= build(rowCtx.codingExec)`
//      把族锁存在首次 apply 的闭包里，冷热差一个数量级，混测即噪声。
//   3. **组合解析**：resolveRoster（纯函数）/ effectiveComposition（cache 读）。
//   4. **调用期**：fs 工具派发（含 S6 P2 新增的 owner 查表）与裸查表基准线。
//   5. **内存探针**（报告制）：单卷常驻增量 / 次卷边际增量，gc 后取 heapUsed 差。
//
// 三条纪律（都来自本仓实测踩坑）：
//   - **时间只报告、不进红绿**：本机有并发工作线时事件循环会被饿死
//     （tests/perf-paper-pan.test.tsx 头注实测「原始码 5-10.8ms 随机漂移」）。
//     结构性回归由 tests/composition-assembly-cost.test.ts 的确定性计数钉死。
//   - **丢弃 warmup 轮**：模块求值 / Vite transform / 首装配建族都不算成本
//     （tinybench 的 warmup 已覆盖；冷栏的「每次新 apply」是刻意建模）。
//   - **基线不跨机对拍**：JSON 落 tests/bench/baseline/，只作本机前后回归；
//     DSH 的 0.17–1.31MB / 38–135ms 也是它自己机器上的数。
//
// 跑法：`npm run bench:assembly`（NODE_ENV=test + NODE_OPTIONS=--expose-gc 已钉在
// 脚本里）；JSON 落盘用 `npm run bench:assembly:json`；对拍历史基线用
// `npx vitest bench --dir tests/bench --compare tests/bench/baseline/assembly-baseline.json`。
//
// 本文件**不被 `vitest run` 收**（vitest.config.ts 的 include 只认
// `tests/**/*.test.ts(x)`）——基准与门禁分家，避免把时间噪声带进常态套件。

import { afterAll, beforeAll, bench, describe } from 'vitest';
import { AgentContext } from '../../src/agent/context';
import { buildToolRegistry } from '../../src/agent/runtime/agent-builder';
import { AgentRuntime } from '../../src/agent/runtime/runtime';
import { TaskManager } from '../../src/agent/task';
import { type Tool, ToolRegistry } from '../../src/agent/tool';
import { withFirstPartyCapabilityChannel } from '../../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../../src/composition/first-party-tools';
import { effectiveComposition } from '../../src/composition/preset-assembly';
import { resolvePresetComposition } from '../../src/composition/presets';
import { factoryComposition, type ResolvedComposition, resolveRoster } from '../../src/composition/roster';
import { registerSeamScope, seamScopeOf } from '../../src/composition/seam-scope';
import { createFsTools } from '../../src/plugins/builtin/fs-domain/fs-tools';
import { SubAgentPool } from '../../src/plugins/builtin/subagent-in-process/coordinator';
import { readOnlyTool, scriptedProvider } from '../convergence/helpers/fixtures';
import { ensureProductionChannelsBooted } from '../helpers/composition-boot';

// ── 装配夹具（与 convergence specs 同款：手工 ctx + 缺省 inputs）──

let rt: AgentRuntime;
let standard: ResolvedComposition;
let minimal: ResolvedComposition;
let disposeScope: (() => void) | null = null;
let seq = 0;

function makeCtx(agentId: string): AgentContext {
  const tools = new ToolRegistry();
  tools.register(readOnlyTool());
  return new AgentContext(
    { agentId, parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
    {
      provider: scriptedProvider([]),
      tools,
      eventSink: () => {},
      messageBus: rt.getBus(),
    },
  );
}

/** 挂载一卷并立刻销毁（幂等 dispose；不销毁会跨迭代堆体力、把时间数字带偏）。 */
async function mountOnce(composition: ResolvedComposition, systemPrompt?: string): Promise<void> {
  const h = await rt.createAgentFromContext(
    makeCtx(`bench-${seq++}`),
    systemPrompt ? { systemPrompt } : {},
    undefined,
    composition,
  );
  h.dispose();
}

/** 裸建一张表（两种行源：冷栏每次新 apply 的贡献行 / 热栏早先捕获的行表）。 */
function buildOnce(toolRows: ResolvedComposition['tools']): Promise<ToolRegistry> {
  return buildToolRegistry({
    deps: {},
    taskManager: new TaskManager(),
    subAgentPool: new SubAgentPool(),
    toolRows,
  });
}

/** 冷栏：新通道 apply（贡献行在册才可寻址）→ 建表；闭包随腰拆卸，族缓存归零。 */
function buildCold(): Promise<ToolRegistry> {
  return withFirstPartyToolChannel(() => withFirstPartyCapabilityChannel(() => buildOnce(factoryComposition().tools)));
}

// ── 内存探针（报告制，无断言）──

/** 三次取最小（min 比 median 更稳：GC 噪声只会抬高读数，不会压低）。 */
function settledHeapUsed(gc: () => void): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    gc();
    min = Math.min(min, process.memoryUsage().heapUsed);
  }
  return min;
}

/** 每卷常驻增量 + 逐卷边际增量（DSH 的「每卷 ~0.17/1.31MB」对位）。
 *  三轮取 marginals 的中位数——首卷读数受 GC 噪声支配（实测出现过 -0.02MB
 *  这种物理上不可能的负值），单点不可引用。 */
async function runMemoryProbe(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    console.log('[bench] 无 --expose-gc：内存探针跳过（用 npm run bench:assembly 跑）');
    return;
  }
  const MB = 1024 * 1024;
  for (const [name, comp] of [
    ['standard', standard],
    ['minimal', minimal],
  ] as const) {
    const handles: Array<{ dispose(): void }> = [];
    const marks: number[] = [settledHeapUsed(gc)];
    for (let i = 0; i < 3; i++) {
      handles.push(
        await rt.createAgentFromContext(
          makeCtx(`mem-${name}-${i}-${seq++}`),
          { systemPrompt: 'bench' },
          undefined,
          comp,
        ),
      );
      marks.push(settledHeapUsed(gc));
    }
    for (const h of handles) h.dispose();
    const marginals = [marks[1] - marks[0], marks[2] - marks[1], marks[3] - marks[2]].map((d) => d / MB);
    const sorted = [...marginals].sort((a, b) => a - b);
    console.log(
      `[bench] 内存 · ${name}：逐卷边际 [${marginals.map((m) => m.toFixed(2)).join(' / ')}]MB` +
        ` · 中位 ${sorted[1].toFixed(2)}MB · 三卷合计 ${((marks[3] - marks[0]) / MB).toFixed(2)}MB` +
        `（基线 ${(marks[0] / MB).toFixed(1)}MB）`,
    );
  }
}

beforeAll(async () => {
  // seam 服务（fs/shell/subagents/llm/sessions/agentLoop）——生产在册面
  await ensureProductionChannelsBooted();
  // 两份组合产物：standard = 出厂（零 patch）；minimal = 出厂精简（真实减法 preset）
  const pair = await withFirstPartyToolChannel(() =>
    withFirstPartyCapabilityChannel(async () => {
      return [factoryComposition(), resolvePresetComposition('minimal')] as const;
    }),
  );
  standard = pair[0];
  minimal = pair[1];
  rt = new AgentRuntime();
  await rt.ready();
  // 热栏预热：先把族建出来（否则第一次迭代会替冷栏买单）
  await buildOnce(standard.tools);
  // 调用期夹具的 owner 作用域（bench 期常驻；键与用例里的 _owner_id 同源）
  disposeScope = registerSeamScope('bench-owner', standard.seamDisabled);
  await runMemoryProbe();
});

afterAll(() => {
  // 卷已逐个 dispose；AgentRuntime 无整体拆卸 API（tests 惯例：句柄即所有权）
  disposeScope?.();
});

// ── 1. 全卷挂载（用户「开一卷」付的钱）──

describe('装配 · 全卷挂载（含 prompt 组装）', () => {
  bench(
    'standard',
    async () => {
      await mountOnce(standard);
    },
    { warmupIterations: 3, iterations: 12 },
  );
  bench(
    'minimal',
    async () => {
      await mountOnce(minimal);
    },
    { warmupIterations: 3, iterations: 12 },
  );
});

describe('装配 · 全卷挂载（prompt 预置：只量装配面）', () => {
  bench(
    'standard',
    async () => {
      await mountOnce(standard, 'bench system prompt');
    },
    { warmupIterations: 3, iterations: 12 },
  );
});

// ── 2. 建注册表（冷：建族 + schema 生成；热：复用族实例）──

describe('装配 · 建注册表', () => {
  bench(
    '冷（新通道 apply：建族 + 全量 schema 生成 + 注册 + 收敛）',
    async () => {
      await buildCold();
    },
    { warmupIterations: 2, iterations: 5 },
  );
  bench(
    '热（族实例已缓存：注册 + 领域收敛）',
    async () => {
      await buildOnce(standard.tools);
    },
    { warmupIterations: 3, iterations: 15 },
  );
});

// ── 3. 组合解析（cache 读 vs 纯函数）──

describe('装配 · 组合解析', () => {
  bench(
    'resolveRoster（纯函数，零 patch）',
    () => {
      resolveRoster(standard, []);
    },
    { warmupIterations: 2, iterations: 1000 },
  );
  bench(
    'effectiveComposition（preset-assembly cache 读）',
    () => {
      effectiveComposition('standard');
    },
    { warmupIterations: 2, iterations: 1000 },
  );
});

// ── 4. 调用期：fs 派发含 S6 P2 新增的 owner 查表 ──

describe('调用期 · fs 工具派发（含 owner 查表）', () => {
  const tools = createFsTools(async () => 'dispatch');
  const readTool = tools.find((t) => t.name() === 'read_file_content') as Tool;

  bench(
    'owner 命中（本卷组合的裁剪面在册）',
    async () => {
      await readTool.execute({ filePath: '/x', _owner_id: 'bench-owner' });
    },
    { warmupIterations: 2, iterations: 500 },
  );
  bench(
    'owner 缺席（无组合上下文的全局兜底路径）',
    async () => {
      await readTool.execute({ filePath: '/x' });
    },
    { warmupIterations: 2, iterations: 500 },
  );
  bench(
    'seamScopeOf（裸查表基准线）',
    () => {
      seamScopeOf('bench-owner');
    },
    { warmupIterations: 2, iterations: 100_000 },
  );
});

// 调用期夹具的 owner 作用域 disposer（beforeAll 里按已解析的组合登记）
