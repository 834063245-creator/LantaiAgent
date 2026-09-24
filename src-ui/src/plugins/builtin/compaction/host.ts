// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// compaction · 宿主依赖面 · 开发/测试域。
//
// 本包**不自持内核实现**：契约面（`agent/compaction-contract.ts`：宿主接口 + 配置形状 +
// 摘要账形状 + 跨层常量）与记账面（`agent/compaction-tracker.ts`）留内核；策略（成本模型/
// 触发点/调优/报告/工具面）与管线（折叠状态机/摘要管线）归本包。内核依赖逐符号桥。

export { EventKind } from '../../../agent/agent-types';
export type {
  CompactionConfig,
  CompactionHost,
  CompactionImplementation,
  SummaryCall,
  SummaryRun,
} from '../../../agent/compaction-contract';
export {
  COMPACTION_NOTICE_MARK,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_RETAIN_RATIO,
} from '../../../agent/compaction-contract';
export { registerCompactionImplementation } from '../../../agent/compaction-impl';
export type { CompactionEvent, CompactionSessionStats, CompactionTracker } from '../../../agent/compaction-tracker';
export {
  DEFAULT_C_IN,
  DEFAULT_C_OUT,
  LOSS_FACTOR_PER_EVENT,
} from '../../../agent/compaction-tracker';
export { extractFilePath, WRITE_TOOLS } from '../../../agent/file-ownership';
export { log } from '../../../agent/logger';
export { parseFilePathArg } from '../../../agent/loop-helpers';
export { buildCompactedSummaryMessage } from '../../../agent/session-log';
export { countMessage, countMessages, countText } from '../../../agent/token-counter';
export type { Tool, ToolRegistry } from '../../../agent/tool';
export { foldToolResults, nextFoldBoundary } from '../../../agent/tool-fold';
export { defineTool } from '../../../agent/tools/define-tool';
export { resolveGuardToolName } from '../../../agent/tools/domains';
export { streamWithIdleTimeout } from '../../../provider/idle-stream';
export type { Message, Provider, ToolSchema, Usage } from '../../../provider/types';
export { ChunkType } from '../../../provider/types';
export { kernelReadFile, kernelWriteFile } from '../../../rpc-contract';
