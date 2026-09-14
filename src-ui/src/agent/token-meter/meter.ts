// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionTokenMeter — 每卷一份的 token 计量器（DSH `ctx.tokenMeter` 的兰台落位）。
//
// 一个 fold + 一个锚点（DSH 设计理念，逐条对齐）：
//   - fold：每次请求落一条 TokenRequestRecord（构成 + 用量），逐条累进四桶、
//     逐轮汇总、刷新压力采样；
//   - 锚点：提供方回报的 prompt 侧用量 = 压力基准；采样之后载荷又长了多少，
//     以带符号增量的形式叠回去（projected），因此水位**在一次回合流式期间
//     站住不动**，跨到下一个请求才前进 —— 与 DSH pressure/projected 同语义；
//   - 表面（surface）：载荷估算量，每个 step 边界由 Agent 刷新一次
//     （tokenCountWithEstimation 顺带入库，零额外开销）。
//
// 为什么不做「从会话日志回放」：兰台 SessionLog 只承载模型可见事实
// （message/reset/retract/compaction），用量不在其中且不落盘；把用量塞进
// session-log 会牵动 Phase 5 契约快照与三入口白名单。本模块的账本快照
// （snapshot/restore）走卷文件落盘，等价达成「重启不丢账」。

import type { Usage } from '../../provider/types';
import type {
  ContextBreakdown,
  TokenBuckets,
  TokenLedgerSnapshot,
  TokenMeasurement,
  TokenRequestRecord,
  TurnTokens,
} from './types';
import {
  addBuckets,
  billedInputTokens,
  bucketsFrom,
  cacheHitPercentText,
  pressureTokens,
  totalTokens,
  ZERO_BUCKETS,
} from './usage';

/** 每卷 token 计量器（纯状态机，无 IO、无 React）。 */
export class SessionTokenMeter {
  private _totals: TokenBuckets = { ...ZERO_BUCKETS };
  private _attempts = 0;
  private _turnSlots = new Map<number, TurnTokens>();
  private _turnOrder: number[] = [];
  private _last: { turn: number; step: number; buckets: TokenBuckets } | undefined;
  private _pressureTokens: number | undefined;
  private _sampledSurfaceTokens: number | undefined;
  private _surfaceTokens = 0;
  private _breakdown: ContextBreakdown | undefined;
  private _contextWindow = 0;

  /** 上下文窗口（换模型/改覆盖时热同步；0 = 未知）。 */
  setContextWindow(window: number): void {
    this._contextWindow = Number.isFinite(window) && window > 0 ? Math.round(window) : 0;
  }

  /** 刷新载荷估算量（step 边界调用，不产生采样）。 */
  recordSurface(tokens: number): void {
    if (!Number.isFinite(tokens)) return;
    this._surfaceTokens = Math.max(0, Math.round(tokens));
  }

  /**
   * 落一条请求记录：构成入库 +（有回报时）用量入账。
   *
   * 失败/中止的请求也计数（attempts + 轮内步数）——它们确实发了出去，
   * 只是没有账单；把失败请求从「步数」里抹掉会让每轮步数与实况对不上。
   */
  recordRequest(record: TokenRequestRecord): void {
    this._breakdown = record.breakdown;
    if (Number.isFinite(record.surfaceTokens)) this._surfaceTokens = Math.max(0, Math.round(record.surfaceTokens));
    if (Number.isFinite(record.contextWindow) && record.contextWindow > 0) this._contextWindow = record.contextWindow;
    this._attempts += 1;

    const slot = this._turnSlot(record.turn);
    slot.steps += 1;

    const usage: Usage | undefined = record.usage;
    if (!usage) return;

    const buckets = bucketsFrom(usage);
    const pressure = pressureTokens(buckets);
    this._totals = addBuckets(this._totals, buckets);
    slot.uncachedInputTokens += buckets.uncachedInputTokens;
    slot.cacheReadTokens += buckets.cacheReadTokens;
    slot.cacheWriteTokens += buckets.cacheWriteTokens;
    slot.outputTokens += buckets.outputTokens;
    slot.totalTokens = totalTokens(slot);
    slot.peakPressureTokens = Math.max(slot.peakPressureTokens, pressure);

    // 压力采样：全零回报（本地回放/占位）不构成采样 —— 否则水位会被
    // 一条空 usage 归零，占用显示凭空塌掉。
    if (pressure > 0 || buckets.outputTokens > 0) {
      this._pressureTokens = pressure;
      this._sampledSurfaceTokens = this._surfaceTokens;
      this._last = { turn: record.turn, step: record.step, buckets };
    }
  }

  /** 当前读数（纯读，无副作用——React 渲染路径可直接调用）。 */
  measure(): TokenMeasurement {
    const window = this._contextWindow > 0 ? this._contextWindow : undefined;
    const projected =
      this._pressureTokens !== undefined && this._sampledSurfaceTokens !== undefined
        ? Math.max(0, this._pressureTokens + this._surfaceTokens - this._sampledSurfaceTokens)
        : undefined;

    let usedTokens: number | undefined;
    let usedSource: TokenMeasurement['usedSource'] = 'none';
    if (projected !== undefined) {
      usedTokens = projected;
      usedSource = 'projected';
    } else if (this._pressureTokens !== undefined) {
      usedTokens = this._pressureTokens;
      usedSource = 'pressure';
    } else if (window !== undefined && this._surfaceTokens > 0) {
      usedTokens = this._surfaceTokens;
      usedSource = 'surface';
    }

    return {
      ...(this._pressureTokens === undefined ? {} : { pressureTokens: this._pressureTokens }),
      ...(projected === undefined ? {} : { projectedTokens: projected }),
      surfaceTokens: this._surfaceTokens,
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(usedTokens === undefined ? {} : { usedTokens }),
      usedSource,
      ...(window === undefined || usedTokens === undefined
        ? {}
        : { percent: Math.min(100, Math.round((usedTokens / window) * 100)) }),
      ...(this._breakdown === undefined ? {} : { breakdown: this._breakdown }),
      totals: this._totals,
      attempts: this._attempts,
      turns: this._turnOrder.map((t) => ({ ...(this._turnSlots.get(t) as TurnTokens) })),
      cacheHitPercent: cacheHitPercentText(this._totals.cacheReadTokens, billedInputTokens(this._totals)),
      ...(this._last === undefined ? {} : { last: this._last }),
    };
  }

  /** 占用百分比（0-100 整数）；窗口未知或零用量时 undefined。 */
  percent(): number | undefined {
    const m = this.measure();
    if (m.usedTokens === undefined || m.contextWindow === undefined) return undefined;
    return Math.min(100, Math.round((m.usedTokens / m.contextWindow) * 100));
  }

  /** 是否有账面（决定坞底墨量线显不显）。 */
  get hasData(): boolean {
    return this._attempts > 0;
  }

  /** 可序列化账本快照（随卷落盘；空账本返回 null 不落盘）。 */
  snapshot(): TokenLedgerSnapshot | null {
    if (this._attempts === 0) return null;
    return {
      version: 1,
      totals: { ...this._totals },
      attempts: this._attempts,
      turns: this._turnOrder.map((t) => ({ ...(this._turnSlots.get(t) as TurnTokens) })),
      ...(this._last === undefined ? {} : { last: { ...this._last, buckets: { ...this._last.buckets } } }),
      ...(this._pressureTokens === undefined ? {} : { pressureTokens: this._pressureTokens }),
      ...(this._sampledSurfaceTokens === undefined ? {} : { sampledSurfaceTokens: this._sampledSurfaceTokens }),
      surfaceTokens: this._surfaceTokens,
      ...(this._breakdown === undefined ? {} : { breakdown: { ...this._breakdown } }),
      contextWindow: this._contextWindow,
    };
  }

  /** 从快照重建（毒化数据一律降级为缺省，绝不抛——旧存档/手改文件不炸启动）。 */
  static restore(snapshot: TokenLedgerSnapshot | null | undefined): SessionTokenMeter {
    const meter = new SessionTokenMeter();
    if (!snapshot || typeof snapshot !== 'object') return meter;
    meter._totals = sanitizeBuckets(snapshot.totals);
    meter._attempts = safeInt(snapshot.attempts);
    for (const turn of Array.isArray(snapshot.turns) ? snapshot.turns : []) {
      if (!turn || !Number.isFinite(turn.turn)) continue;
      const slot: TurnTokens = {
        ...sanitizeBuckets(turn),
        turn: safeInt(turn.turn),
        steps: safeInt(turn.steps),
        peakPressureTokens: safeInt(turn.peakPressureTokens),
        totalTokens: safeInt(turn.totalTokens),
      };
      if (!meter._turnSlots.has(slot.turn)) meter._turnOrder.push(slot.turn);
      meter._turnSlots.set(slot.turn, slot);
    }
    if (snapshot.last && Number.isFinite(snapshot.last.turn)) {
      meter._last = {
        turn: safeInt(snapshot.last.turn),
        step: safeInt(snapshot.last.step),
        buckets: sanitizeBuckets(snapshot.last.buckets),
      };
    }
    if (Number.isFinite(snapshot.pressureTokens)) meter._pressureTokens = safeInt(snapshot.pressureTokens);
    if (Number.isFinite(snapshot.sampledSurfaceTokens)) {
      meter._sampledSurfaceTokens = safeInt(snapshot.sampledSurfaceTokens);
    }
    meter._surfaceTokens = safeInt(snapshot.surfaceTokens);
    if (snapshot.breakdown && typeof snapshot.breakdown === 'object') {
      meter._breakdown = {
        systemTokens: safeInt(snapshot.breakdown.systemTokens),
        toolsTokens: safeInt(snapshot.breakdown.toolsTokens),
        messageTokens: safeInt(snapshot.breakdown.messageTokens),
      };
    }
    meter.setContextWindow(safeInt(snapshot.contextWindow));
    return meter;
  }

  /** 取（或建）某轮的汇总槽。 */
  private _turnSlot(turn: number): TurnTokens {
    const key = Number.isFinite(turn) ? Math.max(0, Math.round(turn)) : 0;
    let slot = this._turnSlots.get(key);
    if (!slot) {
      slot = { ...ZERO_BUCKETS, turn: key, steps: 0, peakPressureTokens: 0, totalTokens: 0 };
      this._turnSlots.set(key, slot);
      this._turnOrder.push(key);
    }
    return slot;
  }
}

function sanitizeBuckets(source: Partial<TokenBuckets> | undefined): TokenBuckets {
  return {
    uncachedInputTokens: safeInt(source?.uncachedInputTokens),
    cacheReadTokens: safeInt(source?.cacheReadTokens),
    cacheWriteTokens: safeInt(source?.cacheWriteTokens),
    outputTokens: safeInt(source?.outputTokens),
  };
}

function safeInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
