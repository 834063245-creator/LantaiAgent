// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plan 模式插件 · 真源产物（批 6a，2026-09-24）。
//
// 形态说明：本产物**不贡献任何通道行**（无 tools/prompts/capability 行）——它把
// plan 模式实现登记进内核登记表（`agent/plan/plan-impl.ts`），内核 `agent/blueprint.ts`
// 的两条 capability（plan-tools / plan-injector）查表取用。这样 capability 表序
// （字节敏感面）零漂移，实现却已归产物 ⇒ 改 plan 工具/文案 = 换产物不重编译。
//
// 分类 = feature（可禁用）：禁用/未装载 ⇒ 登记表为空 ⇒ 两条 capability 静默不装
// （模型工具面少 enter/exit_plan_mode）。

import type { Context } from '../../../cordis';
import { registerPlanImplementation } from './host';
import { planModeImplementation } from './implementation';

export const planModePlugin = {
  name: 'hologram/plan-mode',
  inject: [],
  apply(ctx: Context) {
    ctx.effect(() => registerPlanImplementation(planModeImplementation), 'plan-mode');
  },
};

export default planModePlugin;
