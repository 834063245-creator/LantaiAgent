// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 运行看门狗 —— 「等人」豁免（2026-10-31 用户拍板）。
//
// Why：提问卡挂起时用户可能离开很久。旧行为把「用户在答题」与「链路卡死」当成同一件事
// （无进展 20 分钟 → 作废本轮），于是用户回来答了也没人收（本轮已死）。裁定是
// **宁可等，不许替用户判死** ⇒ 等用户期间冻结无进展计时，恢复时把挂起时长扣除。
//
// 覆盖：
//   1. 基线：不挂起时，无进展到阈值即作废（豁免没有把看门狗本身废掉）
//   2. 挂起期间超过阈值不作废
//   3. 恢复后按「挂起前那一刻」继续算（不白送一个完整预算，也不把挂起时长算进去）
//   4. 引用计数：并发提问（多层挂起）任一层还在等就不作废
//   5. 门面幂等：重复 resume 不重复扣时长
//   6. 无登记 signal（压缩 / 子 Agent 内轮）= no-op，不炸

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pauseWhileAwaitingAgent,
  pauseWhileAwaitingUser,
  RunPulse,
  runWatchdogThresholds,
  setRunWatchdogThresholds,
} from '../src/agent/run-watchdog';

/** 看门狗巡检间隔（`WATCHDOG_TICK_MS` 私有常量）——推进到这个边界才会判一次。 */
const TICK = 30_000;

const THRESHOLDS = { warnMs: 2_000, abandonMs: 5_000 };

function makePulse(signal: AbortSignal, agentId?: string) {
  const state = { warned: 0, abandoned: [] as number[] };
  const pulse = new RunPulse({
    runId: 7,
    kind: 'turn',
    agentId,
    onAbandon: () => state.abandoned.push(1),
    onWarn: () => state.warned++,
  });
  // deadline 永不 resolve，作废时 reject —— 先挂 no-op handler，免得成未处理拒绝。
  void pulse.deadline.catch(() => {});
  pulse.bindSignal(signal);
  return { pulse, state };
}

describe('运行看门狗的「等人」豁免', () => {
  const original = runWatchdogThresholds();
  let open: RunPulse[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(THRESHOLDS);
  });

  afterEach(() => {
    for (const p of open) p.end();
    open = [];
    setRunWatchdogThresholds(original);
    vi.useRealTimers();
  });

  const track = (p: RunPulse) => {
    open.push(p);
    return p;
  };

  it('基线：不挂起时无进展到阈值即作废', () => {
    const { pulse, state } = makePulse(new AbortController().signal);
    track(pulse);
    vi.advanceTimersByTime(TICK);
    expect(state.abandoned).toHaveLength(1);
    expect(pulse.abandoned).toBe(true);
  });

  it('挂起期间超过阈值不作废（用户答题不算卡死）', () => {
    const { pulse, state } = makePulse(new AbortController().signal);
    track(pulse);
    pulse.suspendForAwait();
    expect(pulse.awaitingUser).toBe(true);
    // 远超 5s 阈值、覆盖多个巡检周期
    vi.advanceTimersByTime(TICK * 10);
    expect(state.abandoned).toHaveLength(0);
    expect(state.warned).toBe(0);
    expect(pulse.abandoned).toBe(false);
  });

  it('恢复后按挂起前那一刻继续算：挂起时长不计入，阈值照常生效', () => {
    const { pulse, state } = makePulse(new AbortController().signal);
    track(pulse);
    vi.advanceTimersByTime(1_000); // 挂起前已静默 1s
    pulse.suspendForAwait();
    vi.advanceTimersByTime(TICK * 5); // 挂起 2.5 分钟
    pulse.resumeFromAwait();
    expect(pulse.awaitingUser).toBe(false);
    // 恢复瞬间：无进展应仍在 1s 量级（挂起时长已扣除），而不是 2.5 分钟
    expect(pulse.noProgressMs).toBeLessThan(THRESHOLDS.abandonMs);
    // 再走一个巡检周期：1s + 30s 已超 5s 阈值 ⇒ 正常作废
    vi.advanceTimersByTime(TICK);
    expect(state.abandoned).toHaveLength(1);
  });

  it('引用计数：并发提问只要还有一层在等就不作废', () => {
    const { pulse, state } = makePulse(new AbortController().signal);
    track(pulse);
    pulse.suspendForAwait();
    pulse.suspendForAwait(); // 第二个提问卡
    pulse.resumeFromAwait(); // 第一个答完
    vi.advanceTimersByTime(TICK * 4);
    expect(pulse.awaitingUser).toBe(true);
    expect(state.abandoned).toHaveLength(0);
    pulse.resumeFromAwait(); // 第二个也答完
    vi.advanceTimersByTime(TICK);
    expect(state.abandoned).toHaveLength(1);
  });

  it('多余 resume 不欠账：本来没挂起时调用不改变计时、不倒流', () => {
    const { pulse } = makePulse(new AbortController().signal);
    track(pulse);
    vi.advanceTimersByTime(500);
    const before = pulse.noProgressMs;
    pulse.resumeFromAwait(); // 从未挂起
    expect(pulse.awaitingUser).toBe(false);
    expect(pulse.noProgressMs).toBeGreaterThanOrEqual(before);
    expect(pulse.noProgressMs).toBeLessThan(THRESHOLDS.abandonMs);
  });

  it('无登记 signal / 无 signal：门面是 no-op（压缩、子 Agent 内轮照旧零开销）', () => {
    expect(() => pauseWhileAwaitingUser(undefined)()).not.toThrow();
    expect(() => pauseWhileAwaitingUser(null)()).not.toThrow();
    expect(() => pauseWhileAwaitingUser(new AbortController().signal)()).not.toThrow();
  });

  it('门面经 signal 登记表寻址：返回的恢复函数只生效一次', () => {
    const signal = new AbortController().signal;
    const { pulse } = makePulse(signal);
    track(pulse);
    vi.advanceTimersByTime(800);
    const resume = pauseWhileAwaitingUser(signal);
    expect(pulse.awaitingUser).toBe(true);
    vi.advanceTimersByTime(TICK * 2);
    resume();
    expect(pulse.awaitingUser).toBe(false);
    const afterFirst = pulse.noProgressMs;
    resume(); // 幂等：不重复扣
    expect(pulse.noProgressMs).toBeGreaterThanOrEqual(afterFirst - 5);
  });

  it('已作废的轮不再挂起（作废是既成事实，冻结也回不来）', () => {
    const { pulse } = makePulse(new AbortController().signal);
    track(pulse);
    vi.advanceTimersByTime(TICK);
    expect(pulse.abandoned).toBe(true);
    pulse.suspendForAwait();
    expect(pulse.awaitingUser).toBe(false);
  });

  // ── 权限卡：不持有 signal 的等待面，按 agentId 寻址（2026-10-31） ──

  it('权限卡按 agentId 寻址：该 Agent 的本轮被挂起，答完恢复后照常计时', () => {
    const { pulse, state } = makePulse(new AbortController().signal, 'main-1');
    track(pulse);
    const resume = pauseWhileAwaitingAgent('main-1');
    expect(pulse.awaitingUser).toBe(true);
    vi.advanceTimersByTime(TICK * 6);
    expect(state.abandoned).toHaveLength(0);
    resume();
    expect(pulse.awaitingUser).toBe(false);
    vi.advanceTimersByTime(TICK);
    expect(state.abandoned).toHaveLength(1);
  });

  it('按 agentId 寻址是精确的：A 卷在等批准不豁免 B 卷', () => {
    const a = makePulse(new AbortController().signal, 'main-a');
    const b = makePulse(new AbortController().signal, 'main-b');
    track(a.pulse);
    track(b.pulse);
    const resume = pauseWhileAwaitingAgent('main-a');
    vi.advanceTimersByTime(TICK);
    expect(a.state.abandoned).toHaveLength(0);
    expect(b.state.abandoned).toHaveLength(1);
    resume();
  });

  it('未登记 / 空 agentId = no-op（子 Agent 未起 run、游离请求 / 恢复期）', () => {
    expect(() => pauseWhileAwaitingAgent(undefined)()).not.toThrow();
    expect(() => pauseWhileAwaitingAgent(null)()).not.toThrow();
    expect(() => pauseWhileAwaitingAgent('nobody')()).not.toThrow();
  });

  it('轮次收尾后该 agentId 不再指向旧轮（同一 agent 串行起轮不串账）', () => {
    const first = makePulse(new AbortController().signal, 'main-x');
    first.pulse.end();
    const stale = pauseWhileAwaitingAgent('main-x');
    expect(first.pulse.awaitingUser).toBe(false);
    stale();

    const second = makePulse(new AbortController().signal, 'main-x');
    track(second.pulse);
    const fresh = pauseWhileAwaitingAgent('main-x');
    expect(second.pulse.awaitingUser).toBe(true);
    fresh();
    expect(second.pulse.awaitingUser).toBe(false);
  });
});
