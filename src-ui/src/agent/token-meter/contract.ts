// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter 契约面（§4-6 A，2026-09-26）——分桶代数 + 每卷账本形状 + 实现面。
//
// 背景（总账 §4-6）：`agent/token-meter/`（六件 874 行 + `token-counter.ts` 89）
// 既不在内核 service 清单、也无 feature 产物认领 ⇒ 分类缺口（账本 §5 灰区一条）。
// 用户 2026-09-25 裁定 A：立第 16 个内核 service `ctx.tokenMeter`。
//
// 本文件是**消费面**的真源（谁要读 token 账，读这里；不看实现文件）：
//   - `TokenLedger` —— 每卷一本账的形状（实现 = `meter.ts` 的 `SessionTokenMeter`）；
//   - `TokenAlgebra` —— 分桶代数的形状（实现 = `usage.ts`；四桶互不重叠且加总恒等于
//     提供方 `prompt_tokens` 的口径纪律由它一处承担）；
//   - `TokenMeterImplementation` —— 服务实现面（每卷账本工厂 + 代数）。
//
// **录入点仍唯一 = `Agent.streamOnce`**（`CLAUDE.md` 硬约束的口径纪律）——
// 立 service 不动记账方向：本面只出「造账本/恢复账本/读代数」三个动作，
// 没有任何写入账本的第二条路。
//
// 缺席语义：service = 内核不可禁用 ⇒ 缺实现**具名 fail-loud**
// （`TOKEN_METER_UNAVAILABLE`，见 `service.ts` 的 `requireTokenMeter()`）。

import type { Usage } from '../../provider/types';
import type { TokenBuckets, TokenLedgerSnapshot, TokenMeasurement, TokenRequestRecord } from './types';

/** 消费面类型出口（真源 = `types.ts`；本文件是唯一的对外类型入口）。 */
export type {
  ContextBreakdown,
  TokenBuckets,
  TokenLedgerSnapshot,
  TokenMeasurement,
  TokenRequestRecord,
  TurnTokens,
} from './types';

/** 每卷一本的 token 账本（真源实现 = `meter.ts` 的 `SessionTokenMeter`）。
 *
 *  生命周期归**持有者**：Agent 侧每卷一本（`Agent._tokenMeter`）、随卷落盘/恢复；
 *  服务只负责造与恢复，不持有任何账本实例（否则「每卷一本」会退化成进程一本）。 */
export interface TokenLedger {
  /** 模型上下文窗口（0 = 未知 ⇒ `percent()` 不报读数）。 */
  setContextWindow(window: number): void;
  /** 记一次「服务商未回报」的采样载荷增量（构成估算面）。 */
  recordSurface(tokens: number): void;
  /** 落一条请求记录（录入点的唯一产物形状）。 */
  recordRequest(record: TokenRequestRecord): void;
  /** 本卷读数（纯读，含构成/压力/投影/逐轮）。 */
  measure(): TokenMeasurement;
  /** 上下文占用百分比；窗口未知或无压力时 undefined。 */
  percent(): number | undefined;
  /** 账本里是否有事实（空账本不落盘）。 */
  readonly hasData: boolean;
  /** 落盘快照（空账本 null）。 */
  snapshot(): TokenLedgerSnapshot | null;
}

/** 分桶代数（真源实现 = `usage.ts`）。
 *
 *  产品/插件读用量读数一律经 `ctx.tokenMeter.usage`（或本包宿主桥）取用，
 *  不 import 内核实现文件——代数是**口径的单点**，副本即口径漂移的入口。 */
export interface TokenAlgebra {
  /** 提供方 Usage → 四桶（残差法：不信任各家 miss 口径，只信任总量）。 */
  bucketsFrom(usage: Usage): TokenBuckets;
  /** prompt 侧计费输入 = 三个输入桶之和（= 提供方 `prompt_tokens`）。 */
  billedInputTokens(b: TokenBuckets): number;
  /** 请求压力（prompt 侧，不含输出）——「上下文占用」的分子。 */
  pressureTokens(b: TokenBuckets): number;
  /** 计费总量 = 输入三桶 + 输出。 */
  totalTokens(b: TokenBuckets): number;
  addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets;
  bucketsEqual(a: TokenBuckets, b: TokenBuckets): boolean;
  /** 全零判定（空账本快照不落盘的依据）。 */
  isZeroBuckets(b: TokenBuckets): boolean;
  /** 缓存命中率文本（部分命中绝不四舍五入成 100%）；无计费输入时 null。 */
  cacheHitPercentText(cacheReadTokens: number, promptTokens: number, decimalPlaces?: 0 | 1): string | null;
  /** 紧凑 token 数：517 / 12.2k / 517k / 1.2M。 */
  formatTokens(value: number): string;
  /** 精确千分位（明细行用，不缩写）。 */
  formatExactTokens(value: number): string;
  /** 零桶常量（只读）。 */
  readonly ZERO_BUCKETS: TokenBuckets;
}

/** 服务实现面（`ctx.tokenMeter` 的结构上界；类本体 = `service.ts`）。 */
export interface TokenMeterImplementation {
  /** 造一本新账（每卷一本；调用方持有）。 */
  createLedger(): TokenLedger;
  /** 从卷文件快照恢复账本（毒化数据降级为空账，绝不抛）。 */
  restoreLedger(snapshot: TokenLedgerSnapshot | null | undefined): TokenLedger;
  /** 分桶代数（唯一实例，见 `TokenAlgebra`）。 */
  readonly usage: TokenAlgebra;
}
