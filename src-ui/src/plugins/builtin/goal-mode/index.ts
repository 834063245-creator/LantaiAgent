// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 模式插件 · 真源产物（批 6b，2026-09-24）。
//
// 形态说明：本产物**不贡献任何通道行**——它把 goal 循环实现登记进内核登记表
// （`agent/goal-impl.ts`），内核 `Agent.runGoal/resumeGoal` 查表取用。状态容器
// （`agent/goal-manager.ts`：记录 + 会话快照 + 持久化）留内核——它由
// `workspace.ts` / `app/chat/chat-core.ts` 构造（宿主→插件禁反）。
//
// 分类 = feature（可禁用）：禁用/未装载 ⇒ 登记表为空 ⇒ /goal 命令得到具名失败
// （「目标模式不可用：…产物未装载或被禁用」），不静默。

import type { Context } from '../../../cordis';
import { registerGoalImplementation } from './host';
import { goalModeImplementation } from './implementation';

export const goalModePlugin = {
  name: 'hologram/goal-mode',
  inject: [],
  apply(ctx: Context) {
    ctx.effect(() => registerGoalImplementation(goalModeImplementation), 'goal-mode');
  },
};

export default goalModePlugin;
