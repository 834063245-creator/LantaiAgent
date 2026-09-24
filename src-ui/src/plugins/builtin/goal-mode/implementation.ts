// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 模式实现对象（批 6b）：把循环的两条入口折成内核契约面 `GoalModeImplementation`，
// 由 index.ts 在 apply 期登记进 `agent/goal-impl.ts`。

import { resumeGoalImpl, runGoalImpl } from './goal-loop';
import type { GoalModeImplementation } from './host';

export const goalModeImplementation: GoalModeImplementation = {
  runGoal: runGoalImpl,
  resumeGoal: resumeGoalImpl,
};
