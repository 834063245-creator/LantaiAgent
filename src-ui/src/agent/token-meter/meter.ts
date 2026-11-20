// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionTokenMeter — 每卷一份的 token 计量器（DSH `ctx.tokenMeter` 的兰台落位）。
//
// 一个 fold + 一个锚点（DSH 设计理念，逐条对齐；压力基准口径见 `types.ts` 文件头）：
//   - fold：每次请求落一条 TokenRequestRecord（构成 + 用量 + 信封签字），逐条累进四桶、
//     逐轮汇总、刷新压力采样；
//   - 锚点：**最近一次成功请求**（有 usage 的那条）= 提供方真值锚。锚带三样东西：
//     压力（`prompt_tokens`）、表面基准点（该次发出时刻的启发式表面量）、信封签字；
//   - 投影（projected）：锚之后表面又长了/缩了多少，以**带符号增量**叠回锚压力
//     ——水位在一次回合流式期间站住不动，跨到下一个请求才前进（与 DSH pressure/
//     projected 同语义）。压缩遮蔽会让增量变负，夹零后读数掉下来（压缩自己不上报
//     usage，压力单独做不到这件事，这正是 projected 存在的理由）；
//   - 表面（surface）：载荷估算量，每个 step 边界由 Agent 刷新一次；表面**有两种尺子**
//     ——`recordAnchoredSurface`（锚 + 增量，与提供方同尺）与 `recordSurface`（全量
//     启发式）。锚对不上时只能退后者，读数也随之诚实降级（`baseline.kind`）。
//
// 为什么不做「从会话日志回放」：兰台 SessionLog 只承载模型可见事实
// （message/reset/retract/compaction），用量不在其中且不落盘；把用量塞进
// session-log 会牵动 Phase 5 契约快照与三入口白名单。本模块的账本快照
// （snapshot/restore）走卷文件落盘，等价达成「重启不丢账」。

import type { Usage } from '../../provider/types';
import type { TokenLedger } from './contract';
import { anchorVerdict, surfaceDeltaTokens } from './estimate';
import type {
  ContextBreakdown,
  TokenAnchoredPressure,
  TokenAnchorProbe,
  TokenBaseline,
  TokenBaselineKind,
  TokenBuckets,
  TokenEnvelopeSignature,
  TokenLedgerSnapshot,
  TokenMeasurement,
  TokenRequestRecord,
  TokenUsageAnchor,
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

/** 每卷 token 计量器（纯状态机，无 IO、无 React）。
 *  形状 = 契约面 `TokenLedger`（`contract.ts`；§4-6 A 起消费方读契约不读本文件）。 */
export class SessionTokenMeter implements TokenLedger {
  private _totals: TokenBuckets = { ...ZERO_BUCKETS };
  private _attempts = 0;
  private _turnSlots = new Map<number, TurnTokens>();
  private _turnOrder: number[] = [];
  private _last: { turn: number; step: number; buckets: TokenBuckets } | undefined;
  /** 提供方锚（最近一次**成功**请求）；失败/中止不产生锚。 */
  private _anchor: TokenUsageAnchor | undefined;
  private _surfaceTokens = 0;
  /** 当前表面量挂在哪把尺子上（'usage' = 锚 + 增量；'estimated' = 全量启发式）。 */
  private _surfaceBasis: TokenBaselineKind = 'estimated';
  private _breakdown: ContextBreakdown | undefined;
  private _contextWindow = 0;

  /** 上下文窗口（换模型/改覆盖时热同步；0 = 未知）。 */
  setContextWindow(window: number): void {
    this._contextWindow = Number.isFinite(window) && window > 0 ? Math.round(window) : 0;
  }

  /** 刷新当前表面量（**全量启发式**口径：无锚或锚已失效时的读数）。
   *  调用方声明「这个数字与锚不同尺」⇒ 投影随之作废（不拿两把尺子相减）。 */
  recordSurface(tokens: number): void {
    if (!Number.isFinite(tokens)) return;
    this._surfaceTokens = Math.max(0, Math.round(tokens));
    this._surfaceBasis = 'estimated';
  }

  /** 刷新当前表面量（**锚 + 增量**口径：调用方已核验锚仍同构，见 `anchoredPressure`）。
   *  无锚时无从投影 ⇒ 降级为 `recordSurface`（没有锚就没有锚尺，不编造）。 */
  recordAnchoredSurface(tokens: number): void {
    if (!Number.isFinite(tokens)) return;
    this._surfaceTokens = Math.max(0, Math.round(tokens));
    this._surfaceBasis = this._anchor === undefined ? 'estimated' : 'usage';
  }

  /** 最近一次成功请求的锚（含信封签字）；一条都没跑过时 undefined。 */
  anchor(): TokenUsageAnchor | undefined {
    return this._anchor;
  }

  /**
   * 以提供方锚回答当前压力（**判定与 UI 读数的唯一计算口**）。
   *
   * 三条判据全过才复用（`anchorVerdict`：模型 / 工具集 / 载荷前缀同构），命中时
   * 顺手把「锚 + 增量」记成当前表面量 —— 于是 `measure().projectedTokens` 与这里
   * 返回的压力**恒等**（pre-flight 判定与墨量册读数不可能再分裂）。对不上则原样
   * 交回具名原因，由调用方退回全量估算并留痕（错误不静默）。
   */
  anchoredPressure(probe: TokenAnchorProbe): TokenAnchoredPressure {
    const anchor = this._anchor;
    if (anchor === undefined) return { ok: false, reason: 'no-anchor' };
    const verdict = anchorVerdict(anchor, probe);
    if (!verdict.ok) return verdict;
    const delta = surfaceDeltaTokens(anchor, probe, verdict.cut);
    this.recordAnchoredSurface(anchor.surfaceTokens + delta);
    return { ok: true, pressure: Math.max(0, anchor.pressureTokens + delta), surfaceDeltaTokens: delta };
  }

  /**
   * 落一条请求记录：构成入库 +（有回报时）用量入账 + 锚换新。
   *
   * 失败/中止的请求也计数（attempts + 轮内步数）——它们确实发了出去，
   * 只是没有账单；把失败请求从「步数」里抹掉会让每轮步数与实况对不上。
   * **不产生锚**：锚只来自提供方回报过 usage 的那条（口径纪律 ①）。
   */
  recordRequest(record: TokenRequestRecord): void {
    this._breakdown = record.breakdown;
    if (Number.isFinite(record.surfaceTokens)) this._surfaceTokens = Math.max(0, Math.round(record.surfaceTokens));
    if (Number.isFinite(record.contextWindow) && record.contextWindow > 0) this._contextWindow = record.contextWindow;
    this._attempts += 1;

    const slot = this._turnSlot(record.turn);
    slot.steps += 1;

    const usage: Usage | undefined = record.usage;
    if (!usage) {
      // 没有账单就保留旧锚（它仍是上一次的真值）。表面量已随本次发出载荷刷新；
      // 它属于哪把尺子不在这里猜——下一次 pre-flight 会按锚重算（`anchoredPressure`）。
      if (this._anchor === undefined) this._surfaceBasis = 'estimated';
      return;
    }

    const buckets = bucketsFrom(usage);
    const pressure = pressureTokens(buckets);
    this._totals = addBuckets(this._totals, buckets);
    slot.uncachedInputTokens += buckets.uncachedInputTokens;
    slot.cacheReadTokens += buckets.cacheReadTokens;
    slot.cacheWriteTokens += buckets.cacheWriteTokens;
    slot.outputTokens += buckets.outputTokens;
    slot.totalTokens = totalTokens(slot);
    slot.peakPressureTokens = Math.max(slot.peakPressureTokens, pressure);

    // 锚换新：全零回报（本地回放/占位）不构成锚 —— 否则水位会被一条空 usage
    // 归零，占用显示凭空塌掉。采样点 = **此刻的表面量**（= 本次发出的载荷估算），
    // 于是刚记完账时增量恰为 0、投影恰等于压力（DSH 同判）。
    if (pressure > 0 || buckets.outputTokens > 0) {
      this._anchor = {
        pressureTokens: pressure,
        surfaceTokens: this._surfaceTokens,
        transientTokens: Math.max(0, Math.round(record.transientTokens)),
        signature: record.signature,
      };
      this._surfaceBasis = 'usage';
      this._last = { turn: record.turn, step: record.step, buckets };
    }
  }

  /** 当前读数（纯读，无副作用——React 渲染路径可直接调用）。 */
  measure(): TokenMeasurement {
    const window = this._contextWindow > 0 ? this._contextWindow : undefined;
    const anchor = this._anchor;
    const surfaceDelta = anchor === undefined ? 0 : this._surfaceTokens - anchor.surfaceTokens;
    // 只有「当前表面确实按锚尺算出来的」才允许投影：锚换模型/被遮蔽之后，
    // 压力与表面量不同尺，相减出来的数会骗人（宁可报估算，不报错数）。
    const projected =
      anchor !== undefined && this._surfaceBasis === 'usage'
        ? Math.max(0, anchor.pressureTokens + surfaceDelta)
        : undefined;

    let usedTokens: number | undefined;
    let usedSource: TokenMeasurement['usedSource'] = 'none';
    if (projected !== undefined) {
      usedTokens = projected;
      usedSource = 'projected';
    } else if (window !== undefined && this._surfaceTokens > 0) {
      usedTokens = this._surfaceTokens;
      usedSource = 'surface';
    }

    const baseline: TokenBaseline =
      projected !== undefined && anchor !== undefined
        ? { kind: 'usage', tokens: anchor.pressureTokens }
        : this._surfaceTokens > 0
          ? { kind: 'estimated', tokens: this._surfaceTokens }
          : { kind: 'none', tokens: 0 };

    return {
      ...(anchor === undefined ? {} : { pressureTokens: anchor.pressureTokens }),
      ...(projected === undefined ? {} : { projectedTokens: projected }),
      baseline,
      surfaceDeltaTokens: surfaceDelta,
      surfaceTokens: this._surfaceTokens,
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(usedTokens === undefined ? {} : { usedTokens }),
      usedSource,
      ...(window === undefined || usedTokens === undefined
        ? {}
        : { percent: Math.min(100, Math.round((usedTokens / window) * 100)) }),
      // 内部状态按值交出——调用方一次就地改（stats.totals.outputTokens = 0）就会永久写坏账本。
      ...(this._breakdown === undefined ? {} : { breakdown: { ...this._breakdown } }),
      totals: { ...this._totals },
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
      version: 2,
      totals: { ...this._totals },
      attempts: this._attempts,
      turns: this._turnOrder.map((t) => ({ ...(this._turnSlots.get(t) as TurnTokens) })),
      ...(this._last === undefined ? {} : { last: { ...this._last, buckets: { ...this._last.buckets } } }),
      ...(this._anchor === undefined ? {} : { anchor: cloneAnchor(this._anchor) }),
      surfaceTokens: this._surfaceTokens,
      ...(this._breakdown === undefined ? {} : { breakdown: { ...this._breakdown } }),
      contextWindow: this._contextWindow,
    };
  }

  /** 从快照重建（毒化数据一律降级为缺省，绝不抛——旧存档/手改文件不炸启动）。
   *
   *  恢复后的表面**一律按估算读**（`_surfaceBasis = 'estimated'`）：快照里的锚签字
   *  还能不能对上当前载荷，只有 Agent 拿到载荷以后才知道（`anchoredPressure` 核验
   *  通过才归位）。宁可先报估算，也不拿没核验过的锚当分子。 */
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
    meter._anchor = sanitizeAnchor(snapshot.anchor);
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

/** 锚的深拷贝（快照不把内部对象递出去——调用方改了也不回灌账本）。 */
function cloneAnchor(anchor: TokenUsageAnchor): TokenUsageAnchor {
  return { ...anchor, signature: { ...anchor.signature } };
}

/** 快照里的锚：形状不全（旧存档 / 手改文件）⇒ 整条丢弃（无锚 = 按估算读，不假装）。 */
function sanitizeAnchor(source: TokenUsageAnchor | undefined): TokenUsageAnchor | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const signature = sanitizeSignature(source.signature);
  if (!signature) return undefined;
  const pressure = safeInt(source.pressureTokens);
  if (pressure <= 0) return undefined;
  return {
    pressureTokens: pressure,
    surfaceTokens: safeInt(source.surfaceTokens),
    transientTokens: safeInt(source.transientTokens),
    signature,
  };
}

function sanitizeSignature(source: TokenEnvelopeSignature | undefined): TokenEnvelopeSignature | undefined {
  if (!source || typeof source !== 'object' || typeof source.model !== 'string' || typeof source.chain !== 'string') {
    return undefined;
  }
  return {
    model: source.model,
    toolsCount: safeInt(source.toolsCount),
    toolsTokens: safeInt(source.toolsTokens),
    messages: safeInt(source.messages),
    chain: source.chain,
  };
}

function safeInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
