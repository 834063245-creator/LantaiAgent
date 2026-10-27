// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-mode · 宿主依赖面 · 开发/测试域（2026-10-23 DSH goal 栈移植 P3）。
//
// 本包**不自持内核实现**：目标状态 = 会话日志（agent/goal/），宿主登记与 activation
// 留内核；本文件是产物包到内核的**唯一**依赖面（构建期折算成 face.json 的键集）。
//
// 与旧 goal-mode 的差别：旧包登记「循环实现」（goal-impl 登记表），新包只贡献
// **工具行 + prompt 段**，直接调用内核目标服务——宿主不再反向依赖产物。

export type { GoalHost } from '../../../agent/goal/service';
export {
  blockGoal,
  completeGoal,
  createGoal,
  DEFAULT_BLOCKED_MIN_ROUNDS,
  editGoal,
  isTopLevelHost,
  pauseGoal,
  readGoal,
  resumeGoal,
} from '../../../agent/goal/service';
export { goalHostOf } from '../../../agent/goal/session-registry';
export type { GoalView } from '../../../agent/goal/types';
export { GoalError } from '../../../agent/goal/types';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
