// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plan 模式实现对象（批 6a）：把三件实现（两个工具工厂 + 注入器工厂）折成内核契约面
// `PlanModeImplementation`，由 index.ts 在 apply 期登记进 `agent/plan/plan-impl.ts`。

import type { PlanModeImplementation } from './host';
import { PlanModeInjector } from './plan-injection';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-tools';

export const planModeImplementation: PlanModeImplementation = {
  createEnterTool: createEnterPlanModeTool,
  createExitTool: createExitPlanModeTool,
  createInjector: () => new PlanModeInjector(),
};
