// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩域**契约面**（批 6d-1，2026-09-24 上收）：实现将归产物包 `plugins/builtin/compaction/`，
// 契约住内核——宿主接口（Agent 类本轮换面）、跨层常量（UI 与 Agent 共读）在此单一真源。
//
// 三条边界：
//   - `CompactionHost` = 压缩域对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）；
//   - `COMPACTION_NOTICE_MARK` = 压缩提示行前缀（**UI 与内核共读**：`ui/chat-stream.ts`
//     据此识别压缩提示；批 6d-1 前它住在实现文件里 ⇒ UI 直引实现，跨层）；
//   - `SUMMARY_OUTPUT_BUDGET` = 摘要调用输出上限缺省（内核 Agent 初始化 + 摘要管线共用）。

import type { Message, Provider, ToolSchema, Usage } from '../provider/types';
import type { AgentEvent } from './agent-types';
import type { CompactionTracker } from './compaction-tracker';
import type { ExecStateInstance } from './execution-state';
import type { Tool, ToolRegistry } from './tool';

/** 压缩域对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface CompactionHost {
  readonly session: Message[];
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly contextWindow: number;
  readonly compactionTracker: CompactionTracker;
  readonly _execState: ExecStateInstance;
  _sink: (ev: AgentEvent) => void;
  compactRatio: number;
  recentKeep: number;
  /** 自动压缩尾部保留的 token 预算比例（占 contextWindow；0 缺省用
   *  DEFAULT_RETAIN_RATIO）。手动 /compact 不消费它（保留 recentKeep 条）。 */
  retainRatio: number;
  /** 摘要调用的输出上限（token）——缺省 SUMMARY_OUTPUT_BUDGET；
   *  配置面 = .lantai/compaction-config.json 的 summaryMaxTokens。 */
  summaryMaxTokens: number;
  compactStuck: boolean;
  compactRetryAfterLen: number;
  compactFailCount: number;
  compactRunning: boolean;
  _compactionConfigPath: string | null;
  _compactionTrackerPath: string | null;
  _compactSummary: string | null;
  _compactTailStart: number;
  stormSig: string;
  stormCount: number;
  /** 工具结果折叠边界 + 窗口（payloadMessages 尾段消费）。 */
  _toolFoldBoundary: number;
  _toolResultWindow: number;
  /** Phase 5 事件日志 — 压缩折叠事件（session/compaction）直写。 */
  _sessionLog: { append(kind: string, data: unknown): void };
  _foldHead(): number;
  payloadMessages(): Message[];
  tokenCountWithEstimation(): number;
  /** 与主请求同一份工具 schema —— 回放前缀对齐的另一半（tools 在 wire 上先于 messages 进
   *  token 流，不带上它前缀在 system 之后即分叉）。选择器按 user 请求锁存 ⇒ 同请求内字节稳定。 */
  requestToolSchemas(): ToolSchema[];
}

/** 压缩提示行前缀——UI（chat-stream 识别压缩提示）与内核（通知文案）共读。 */
export const COMPACTION_NOTICE_MARK = '[上下文压缩]';

/** 摘要调用的输出上限（token）缺省值（8192，对齐 DSH）。 */
export const SUMMARY_OUTPUT_BUDGET = 8192;

// ── 跨域形状（批 6d-2 上收：内核 Agent 与产物实现共用；实现面进包前它们是实现文件的自有类型）──

export interface CompactionConfig {
  compactRatio: number;
  recentKeep: number;
  /** 摘要调用的输出上限（token）——缺省 = SUMMARY_OUTPUT_BUDGET（8192，对齐 DSH）。
   *  手写此文件即可改；自动调优只透传，不改写它。 */
  summaryMaxTokens?: number;
  tunedAt: number; // 上次调优时间戳
  sampleCount: number; // 使用的压缩事件数量
  avgCompressionRatio: number;
  avgLossFactor: number;
  reasoning: string; // 人类可读的说明
}

/** 尾部保留的 token 预算，占 contextWindow 的比例（对齐 DSH retainRatio 0.16）。
 *  computeCompactRegionImpl 从尾部往回累计 token 到 ≥ 此比例×窗口，
 *  再钳制到完整回合边界 — 工具密集会话里保证模型手里有足够近期工作现场，
 *  而不是旧实现 max(4, recentKeep) 那样只留几条消息。 */
export const DEFAULT_RETAIN_RATIO = 0.16;

/** 正常触发水位（占 contextWindow 比例；agent.ts 构造缺省同源）。 */
export const DEFAULT_COMPACT_RATIO = 0.8;

/** 单次摘要调用的产物。usage 缺省 = 提供方未回报（该次调用不可归因）。 */
export interface SummaryCall {
  text: string;
  /** 写进本次请求的输出上限（= 摘要 cap；适配器另按模型 maxTokens 钳制） */
  maxTokens: number;
  usage?: Usage;
}

/** 摘要区段（summarizeRegion / mergePartials）的产物。 */
export interface SummaryRun {
  text: string;
  /** 有环节降级为机械提取 / 拼接（机械提取是兜底，但降级必须可见且可归因） */
  degraded: boolean;
  /** 降级原因（degraded=true 时非空） */
  failure?: string;
  /** 本次区段的全部调用账（**含失败那次** —— 空返回的 usage 正是归因核心） */
  calls: SummaryCall[];
}

/** 压缩域实现面——产物包 `hologram/compaction` 在 apply 期经
 *  `registerCompactionImplementation` 登记；内核 `Agent` 的方法与 `agent-builder`
 *  的工具注册查表取用（**service 语义**：缺实现 = 装歪了，调用点 fail-loud）。 */
export interface CompactionImplementation {
  foldHead(host: CompactionHost): number;
  payloadMessages(host: CompactionHost): Message[];
  setCompactionConfigPath(host: CompactionHost, projectPath: string): void;
  loadCompactionTracker(host: CompactionHost): Promise<void>;
  loadCompactionConfig(host: CompactionHost): Promise<CompactionConfig | null>;
  applyAutoTuneConfig(host: CompactionHost): Promise<CompactionConfig | null>;
  computeCompactRegion(
    host: CompactionHost,
    mode?: 'auto' | 'manual',
  ): { region: Message[]; tailStart: number; priorSummary: string | null } | null;
  compactNow(host: CompactionHost, signal: AbortSignal): Promise<string>;
  compactIfNeeded(host: CompactionHost, signal: AbortSignal): Promise<string>;
  maybeCompact(host: CompactionHost, usage: Usage | undefined): void;
  summarizeRegion(
    host: CompactionHost,
    signal: AbortSignal,
    msgs: Message[],
    priorSummary?: string | null,
  ): Promise<SummaryRun>;
  summaryProvider(host: CompactionHost): Promise<{ prov: Provider; window: number }>;
  callSummaryLLM(
    host: CompactionHost,
    signal: AbortSignal,
    messages: Message[],
    shape?: { replay: boolean; tools?: ToolSchema[] },
  ): Promise<SummaryCall>;
  mergePartials(
    host: CompactionHost,
    signal: AbortSignal,
    priorSummary: string | null,
    partials: string[],
    budgetTokens: number,
  ): Promise<SummaryRun>;
  createCompactionTools(
    getTracker: () => import('./compaction-tracker').CompactionTracker | null,
    getCurrentParams: () => {
      compactRatio: number;
      recentKeep: number;
      retainRatio: number;
      contextWindow: number;
      summaryMaxTokens: number;
    },
    loadConfig: () => Promise<CompactionConfig | null>,
  ): Tool[];
}
