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

import type { Message, Provider, ToolSchema } from '../provider/types';
import type { AgentEvent } from './agent-types';
import type { CompactionTracker } from './compaction-tracker';
import type { ExecStateInstance } from './execution-state';
import type { ToolRegistry } from './tool';

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
