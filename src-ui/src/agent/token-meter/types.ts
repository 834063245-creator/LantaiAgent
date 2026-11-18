// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter 词汇表 — 兰台对 DSH `@deepseek-ai/dsh-token-meter` 的投影。
//
// 语义来源（逐条对齐 DSH，不发明新口径）：
//   - 分桶计量：输入四桶互不重叠（未缓存输入 / 缓存读 / 缓存写 / 输出），
//     DSH TokenUsageProjection 的四字段同形；
//   - 请求压力（pressure）只算 prompt 侧（输入 + 缓存读写），**不含输出**——
//     「上下文占用」问的是下一次请求的提示词有多大，不是上一次账单有多大
//     （DSH `pressureFrom` 注释原文：input plus cache traffic, no output）；
//   - 投影占用（projected）：采样后表面又长了多少 → 压力 + 表面带符号增量；
//   - 上下文构成（breakdown）：系统提示 / 工具 schema / 对话三段，**估算值**，
//     描述构成而非计费规模（DSH contextBreakdown 同判）；
//   - 每轮用量：一次用户输入 → 若干步请求，逐轮汇总（DSH deriveTurnTokenUsage）。
//
// ── 压力基准（baseline）：以提供方 usage 为锚（2026-11-19，对齐 DSH
//    `TokenMeasurement.baseline`）────────────────────────────────────────────
//
// 口径变更（**可感知**）：在此之前「上下文占用」有两个不相干的分子——
//   UI 读数 = 压力 + 表面增量；压缩触发判定 = 全量启发式重算。分词器估低时，
//   提示条说 85% 而判定说 79%，于是「看着要压却一路不压」（或反过来）。现在两处
//   **同源同判据**，都走锚：
//
//   pressure = baseline.tokens + surfaceDeltaTokens
//            = 最近一次成功请求的 `prompt_tokens` + 此后表面积的**带符号增量**
//
// 为什么这样更准：全量重算是「本地启发式量整份载荷」，系统性带着分词器偏差
// （Anthropic <8%、CJK/JSON schema 更差）；锚式只有**锚之后新增的那部分**走
// 启发式，前缀部分恒定在提供方真值上，于是读数与压缩判定都贴着真值。
//
// 四个不变式（违反即返工，与 `usage.ts` 的口径纪律同一档）：
//   ① 锚只来自**有 usage 的**请求（失败/中止不产生锚，只计数）；
//   ② 锚可复用 ⇔ **信封同构**（`TokenEnvelopeSignature`：模型 + 工具集 + 载荷前缀
//      逐条同构）——换模型 / 换工具集 / 压缩遮蔽 / 会话替换 / 撤回一律退回全量估算，
//      判据显式可测（`anchorVerdict`），不靠「看起来不对就重算」；
//   ③ 增量是**带符号**的（压缩会让 surface 变小、临时提醒会换批），投影夹零；
//   ④ 构成（breakdown）**永远**是启发式三段，不许拿它去对齐 `prompt_tokens`——
//      锚只抬高/压低分子的基准，不改构成。
//
// 与 DSH 的对应：`baseline.kind === 'usage'` ⇔ 兰台的 `'usage'`（锚可用）；
// `'estimated'` ⇔ 无锚或锚对不上（全量启发式）；`'none'` ⇔ 什么都没有。
// DSH 用 `requestHeader` 的规范化信封比对，兰台用 `TokenEnvelopeSignature`——
// 同一件事：**只有信封同构才敢复用那条 usage**。

import type { Message, Usage } from '../../provider/types';

/** 计费分桶 — 四个互不重叠的桶（加总 = 该次请求的计费输入 + 输出）。 */
export interface TokenBuckets {
  /** 未命中缓存的输入（按全价计费的 prompt 部分）。 */
  uncachedInputTokens: number;
  /** 命中前缀缓存的输入（读取价）。 */
  cacheReadTokens: number;
  /** 写缓存的输入（创建价；Anthropic 独有，OpenAI 兼容协议恒 0）。 */
  cacheWriteTokens: number;
  /** 输出（含思考 token）。 */
  outputTokens: number;
}

/** 上下文构成（启发式估算，三项之和 = 请求载荷估算量）。
 *  ⚡ 2026-09-22：对话段**含附图**的视觉 token（按提供方发布的像素网格计价，
 *  见 image-tokens.ts）——图是对话内容的一部分，不新开第四段（纸墨三阶，见
 *  design-spec §9.1）；细目在 EnvelopeMeasure.imageTokens / TokenRequestRecord
 *  的诊断行。 */
export interface ContextBreakdown {
  /** 系统提示（含随会话重建的 persona/规则/记忆段）。 */
  systemTokens: number;
  /** 工具 schema（每次请求全量重发的那一份）。 */
  toolsTokens: number;
  /** 对话消息（含临时提醒、工具结果与**附图视觉 token**）。 */
  messageTokens: number;
}

/** 请求信封签字 —— DSH `requestHeader` 的兰台对应物（见文件头「压力基准」）。
 *
 *  只用三样东西界定「同构」，且**必须比重新分词便宜**（否则复用锚没有意义）：
 *    ① 模型：换模型 = 换分词器 / 窗口 / 视觉价目，旧锚不可比；
 *    ② 工具 schema 集合：条数 + 满量分词数（换工具集或改定义都会换签）；
 *    ③ 载荷前缀：条数 + 逐条「角色 + 分词数 + 内容长度 + 附图张数」滚动签字。
 *      逐条值按**消息对象身份**缓存（同 `token-counter` 的不可变前提），所以核验
 *      前缀是 O(条数) 次查表，不是 O(字节) 分词。
 *
 *  ⚠ 临时提醒**不在**签字里：它每步换批，是增量的加项而非信封身份（见
 *  `TokenUsageAnchor.transientTokens`）。把它塞进签字会让锚每一步都失效。 */
export interface TokenEnvelopeSignature {
  /** `provider/model`（provenance 与分词器的共同身份）。 */
  model: string;
  /** 工具 schema 条数。 */
  toolsCount: number;
  /** 工具 schema 满量分词数（同时是增量的减项）。 */
  toolsTokens: number;
  /** 本签字覆盖的载荷条数（锚存「当时发出多少条」，核验时用它切前缀）。 */
  messages: number;
  /** 前 `messages` 条的滚动签字（十六进制）。 */
  chain: string;
}

/** 提供方锚 —— 最近一次**成功**请求的 usage + 它的信封签字与表面基准点。
 *
 *  表面量三分量（消息逐条 + 工具 schema + 临时提醒）里只有消息进签字，另两项
 *  各留一份价目当增量减项；`surfaceTokens` 是锚时刻的启发式表面量（projected 的
 *  基准点，DSH `TokenMeasurementAnchor` 同判）。 */
export interface TokenUsageAnchor {
  /** 该次请求的 prompt 侧压力（= 提供方 `prompt_tokens`，不含输出）。 */
  pressureTokens: number;
  /** 该次请求发出时刻的载荷估算量（锚的表面基准点）。 */
  surfaceTokens: number;
  /** 该次请求尾部临时提醒的分词数（增量减项）。 */
  transientTokens: number;
  /** 信封签字（复用判据）。 */
  signature: TokenEnvelopeSignature;
}

/** 压力基准的两种尺子（DSH `TokenMeasurementBaseline.kind` 的兰台子集）。 */
export type TokenBaselineKind = 'usage' | 'estimated';

/** 本次读数挂在哪把尺子上（`tokens` = 该尺子的基值）。 */
export type TokenBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  /** 全量启发式：`tokens` = 当前载荷估算量（没有锚，或锚已对不上）。 */
  | { readonly kind: 'estimated'; readonly tokens: number }
  /** 提供方锚：`tokens` = 最近一次成功请求的 `prompt_tokens`（再加表面增量）。 */
  | { readonly kind: 'usage'; readonly tokens: number };

/** 信封身份 —— 签字函数的输入：模型 + 工具 schema 集合 + 载荷（不含尾部临时提醒）。 */
export interface EnvelopeIdentity {
  /** `provider/model`（与签字里的 `model` 对位）。 */
  model: string;
  /** 当前工具 schema 条数与满量分词数。 */
  toolsCount: number;
  toolsTokens: number;
  /** 当前发送载荷（折叠视图；**不含**尾部临时提醒消息）。 */
  payload: readonly Message[];
}

/** 锚核验材料 = 信封身份 + 尾部临时提醒的分词数（提醒不在签字里，单独入账）。 */
export interface TokenAnchorProbe extends EnvelopeIdentity {
  transientTokens: number;
}

/** 锚失效的具名原因（可日志、可测）：`no-anchor` = 还没有过成功请求（不是失败，
 *  不告警）；`model` / `tools` / `history` = 信封不再同构（换模型 / 换工具集 /
 *  载荷前缀被改写或变短——压缩遮蔽、撤回、会话替换、折叠边界前移都落 `history`）。 */
export type TokenAnchorRejectReason = 'no-anchor' | 'model' | 'tools' | 'history';

/** 锚核验结果：`ok` 时 `cut` = 增量从载荷第几条起算。 */
export type TokenAnchorVerdict =
  | { readonly ok: true; readonly cut: number }
  | { readonly ok: false; readonly reason: TokenAnchorRejectReason };

/** 以锚回答的压力（带增量与具名原因，供调用方留痕）。 */
export type TokenAnchoredPressure =
  | { readonly ok: true; readonly pressure: number; readonly surfaceDeltaTokens: number }
  | { readonly ok: false; readonly reason: TokenAnchorRejectReason };

/** 一次请求的计量记录 — Agent 侧产出（事实面），UI 侧存档（账本面）。 */
export interface TokenRequestRecord {
  /** 第几轮（一次用户输入 = 一轮，Agent 侧计数）。 */
  turn: number;
  /** 轮内第几步（人读序，从 1 起）。 */
  step: number;
  /** 请求信封构成（发出时刻测量）。 */
  breakdown: ContextBreakdown;
  /** 载荷估算总量（= breakdown 三项之和）。 */
  surfaceTokens: number;
  /** 提供方回报的用量；错误路径（无回报）为 undefined。 */
  usage?: Usage;
  /** 记录时刻的上下文窗口（0 = 未知）。 */
  contextWindow: number;
  /** 该请求尾部临时提醒的分词数（**已计入 surfaceTokens**；锚的增量减项）。 */
  transientTokens: number;
  /** 该请求的信封签字（发出时刻）——下一条 usage 复用判据的锚半。 */
  signature: TokenEnvelopeSignature;
}

/** 逐轮用量（DSH TurnTokenUsage 的兰台版：分桶 + 轮内步数 + 压力峰值）。 */
export interface TurnTokens extends TokenBuckets {
  turn: number;
  /** 本轮发出的请求数（含重试）。 */
  steps: number;
  /** 本轮 prompt 侧压力峰值（= 本轮上下文水位）。 */
  peakPressureTokens: number;
  /** 本轮计费总量（输入三桶 + 输出）。 */
  totalTokens: number;
}

/** 可序列化账本快照 — 随卷落盘 / 跨重启恢复的单元。 */
export interface TokenLedgerSnapshot {
  /** 形状版本（2 = 2026-11-19 压力基准批：锚连同信封签字一起落盘）。 */
  version: 2;
  totals: TokenBuckets;
  /** 累计请求次数（含重试与失败尝试）。 */
  attempts: number;
  turns: TurnTokens[];
  /** 最近一次采样（turn/step + 分桶）。 */
  last?: { turn: number; step: number; buckets: TokenBuckets };
  /** 提供方锚（最近一次成功请求）；一条成功请求都没跑过时缺省。
   *  签字随锚落盘 ⇒ 重启后下一次读数仍能**核验**它是否还同构（不能核验时按估算读）。 */
  anchor?: TokenUsageAnchor;
  /** 当前载荷估算（每步边界刷新）。 */
  surfaceTokens: number;
  /** 最近一次请求的构成。 */
  breakdown?: ContextBreakdown;
  /** 上下文窗口（0 = 未知）。 */
  contextWindow: number;
}

/** 计量读数 — UI 消费面（单一 measure() 出口）。 */
export interface TokenMeasurement {
  /** 提供方回报的最新 prompt 侧压力（锚值本身；锚失效时它仍是**上一次的真值**，
   *  但不再参与分子 —— 见 `baseline`）。 */
  pressureTokens?: number;
  /** 压力 + 采样后表面增量 = 下一次请求的提示词规模；只在 `baseline.kind==='usage'`
   *  时给出（锚对不上就没有可比基准，不编造投影）。 */
  projectedTokens?: number;
  /** 本次读数的基准（DSH `TokenMeasurement.baseline`）：usage = 提供方锚；
   *  estimated = 全量启发式；none = 什么都没有。 */
  baseline: TokenBaseline;
  /** 相对锚的表面带符号增量（= 当前表面 − 锚时表面）；无锚时 0。 */
  surfaceDeltaTokens: number;
  /** 当前载荷估算（启发式）。 */
  surfaceTokens: number;
  /** 上下文窗口；未知时 undefined。 */
  contextWindow?: number;
  /** 占用分子：projected ?? surface。 */
  usedTokens?: number;
  /** 分子来源（诚实标注：provider 锚 vs 本地估算）。 */
  usedSource: 'projected' | 'surface' | 'none';
  /** 占用百分比（0-100 整数）；窗口未知时 undefined。 */
  percent?: number;
  /** 上下文构成（估算）。 */
  breakdown?: ContextBreakdown;
  /** 本卷累计计费分桶。 */
  totals: TokenBuckets;
  /** 累计请求次数。 */
  attempts: number;
  /** 逐轮用量（旧 → 新）。 */
  turns: TurnTokens[];
  /** 缓存命中率文本（如 '92.5'）；无计费输入时 null。 */
  cacheHitPercent: string | null;
  /** 最近一次采样。 */
  last?: { turn: number; step: number; buckets: TokenBuckets };
}
