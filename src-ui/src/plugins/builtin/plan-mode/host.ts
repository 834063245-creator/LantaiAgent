// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plan-mode · 宿主依赖面 · 开发/测试域。
//
// 本包**不自持内核实现**：plan 状态机（`agent/plan/plan-state.ts`）与门禁
// （`plan-registry.ts`，强制层）留内核，工具/提醒注入器/文案归本包。内核依赖逐符号桥：
// 登记表 + 读文件腰 + 事件枚举 + defineTool + 类型面（状态机 / 契约面）。

export type { EventSink } from '../../../agent/agent-types';
export { EventKind } from '../../../agent/agent-types';
export type {
  PlanApprovalResponse,
  PlanModeImplementation,
  PlanOptionOutcome,
  PlanReminderInjector,
  PlanReviewRequest,
} from '../../../agent/plan/plan-contract';
export { registerPlanImplementation } from '../../../agent/plan/plan-impl';
export type { PlanState, PlanStateManager } from '../../../agent/plan/plan-state';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export { kernelReadFile } from '../../../rpc-contract';
