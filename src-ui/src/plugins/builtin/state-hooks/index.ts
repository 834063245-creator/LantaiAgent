// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks 插件 · 真源产物（批 6c，2026-09-24）。
//
// 形态说明：本产物**不贡献任何通道行**——它把四个出厂 hook 工厂登记进内核登记表
// （`agent/state-hooks-impl.ts`），内核 `agent/blueprint.ts` 的两条 capability
// （state-hooks / board-tracking-hook）查表取用。机制面（Hook/PreflightHook 接口 +
// 两个注册表类）与数据源（`agent/state-inject.ts` / `cache-store.ts`）留内核。
//
// 分类 = service（不可禁用）：未登记时装配期 fail-loud（hook 管道是内核语义）。

import type { Context } from '../../../cordis';
import { registerStateHooksImplementation } from './host';
import { stateHooksImplementation } from './implementation';

export const stateHooksPlugin = {
  name: 'hologram/state-hooks',
  inject: [],
  apply(ctx: Context) {
    ctx.effect(() => registerStateHooksImplementation(stateHooksImplementation), 'state-hooks');
  },
};

export default stateHooksPlugin;
