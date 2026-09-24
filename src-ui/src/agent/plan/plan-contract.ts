// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式**契约面**（批 6a，2026-09-24 从 plan-tools.ts 上收）：实现在产物包
// `plugins/builtin/plan-mode/`，类型与接口住内核——内核（blueprint / agent /
// agent-builder / agent-types）与 UI（message-model / block-model / builtin-renderers）
// 引用本件即可，**不必反向依赖产物包**（宿主→插件禁反）。
//
// 三条边界（与账本 §6.2 / capability-impl-seam-design.md 一致）：
//   - 审批三件（PlanReviewRequest / PlanApprovalResponse / PlanOptionOutcome）=
//     聊天流卡片与工具之间的数据契约；
//   - PlanReminderInjector = loop 只读面（getReminder/resetOnUserInput）；
//   - PlanModeImplementation = 产物包经登记表（agent/plan/plan-impl.ts）提供给内核的实现面。

import type { EventSink } from '../agent-types';
import type { Tool } from '../tool';
import type { PlanState, PlanStateManager } from './plan-state';

/** 方案选项的执行语义：execute=批准后立即执行（默认）；archive=批准但仅留档，用户说开工才动手。 */
export type PlanOptionOutcome = 'execute' | 'archive';

export interface PlanReviewRequest {
  planFilePath: string;
  planContent: string;
  options?: { label: string; description: string; outcome?: PlanOptionOutcome }[];
  callback: (response: PlanApprovalResponse) => void;
}

export type PlanApprovalResponse =
  | { decision: 'approved'; selectedLabel?: string; outcome?: PlanOptionOutcome }
  | { decision: 'revise'; feedback: string }
  | { decision: 'rejected' };

/** runLoop 每轮读取的提醒注入器读面（实现 = 产物包 plan-injection.ts）。 */
export interface PlanReminderInjector {
  getReminder(turn: number, planState: PlanState, planContent: string): string | null;
  resetOnUserInput(): void;
}

/** plan 模式实现面——产物包 `hologram/plan-mode` 在 apply 期经
 *  `registerPlanImplementation` 登记；内核 blueprint 的两条 capability 查表取用
 *  （capability 条目原位不动 ⇒ capability 表序零漂移）。 */
export interface PlanModeImplementation {
  createEnterTool(planState: PlanStateManager, projectPath: string): Tool;
  createExitTool(planState: PlanStateManager, eventSink?: EventSink): Tool;
  createInjector(): PlanReminderInjector;
}
