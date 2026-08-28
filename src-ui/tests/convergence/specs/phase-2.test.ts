// Phase 2 — 工具执行管道类型化事件（验证计划 §4 Phase 2 T0）。
//
// T0：AGENT_EVENT_MAP 每个事件声明 mode 且 ∈ serial|parallel|waterfall|emit；
//     五个管道事件（guard/preflight/around/result/error）齐备。
// 冻结 baseline 对拍：hook-pipeline.trace 夹具经 eventBus 路径跑（平台化 Phase 5
// 后 executor 唯一管道），产出与 phase-0/hook-pipeline.trace.json 冻结 baseline
// 逐字节一致——事件面无漂移的收敛级证明（executor legacy 直调参数已拆，见
// streaming-executor.ts）。
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_MAP, EVENT_MODES } from '../../../src/agent/events';
import { snapshot } from '../helpers/snapshot';
import { runTraceCase, traceCases } from '../helpers/trace-fixtures';

describe('phase-2 T0 结构门禁 — 事件声明', () => {
  it('每个事件声明合法 mode', () => {
    const events = Object.keys(AGENT_EVENT_MAP) as Array<keyof typeof AGENT_EVENT_MAP>;
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const name of events) {
      const mode = AGENT_EVENT_MAP[name].mode;
      expect(
        EVENT_MODES.includes(mode),
        `事件 ${name} 的 mode "${mode}" 非法——必须 ∈ ${EVENT_MODES.join('|')}（验证计划 Phase 2 T0）`,
      ).toBe(true);
    }
  });

  it('五个管道事件齐备（guard/preflight/around/result/error）', () => {
    for (const name of ['tool/guard', 'tool/preflight', 'tool/around', 'tool/result', 'tool/error'] as const) {
      expect(AGENT_EVENT_MAP[name], `缺少事件声明 ${name}`).toBeDefined();
    }
  });
});

describe('phase-2 冻结 baseline 对拍 — eventBus 路径 vs phase-0 baseline', () => {
  it('fixture 经 eventBus 路径产出与 phase-0 冻结 baseline 逐字节一致', async () => {
    const traces = [];
    for (const c of traceCases()) {
      traces.push(await runTraceCase(c));
    }
    // 直接写 phase-0 的快照名：与冻结 baseline 比对，而非另立 baseline
    snapshot('phase-0/hook-pipeline.trace.json', { count: traces.length, traces });
  });
});
