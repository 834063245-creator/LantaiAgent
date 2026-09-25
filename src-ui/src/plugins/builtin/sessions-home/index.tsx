// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/sessions-home — 案卷首页第一方插件（批 9e，2026-09-26）。
//
// 原则二/三（插件化分层）：首页是**应用入口页**（列工作区 / 新建 / 改名 / 移除 / 进画布）
// = 产品形态，经 `ctx.rootViews` 贡献到 `'home'` 槽，由 App 外壳渲染——外壳只长通道，
// 不写具体形态（用户 2026-09-26 裁定 A：立统一 `ctx.rootViews` 双槽）。
// 名册标 `required`（不可禁用）：首页是唯一入口，缺席 = 用户无处可去（同 paper-renderers 之理）。
//
// 组件项目内依赖经 './host' 取宿主共享真实例（RPC 通道 / 壳行 workspace 流 / zustand store /
// 窗口壳件——全是内核单例，内联即第二份状态）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { SessionsHome } from './SessionsHome';

/** 案卷首页插件——`rootViews` 的 'home' 槽唯一贡献行。 */
export const sessionsHomePlugin = {
  name: 'hologram/sessions-home',
  inject: ['rootViews'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.rootViews.register({
          id: 'sessions-home',
          slot: 'home',
          component: SessionsHome,
        }),
      'sessions-home',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default sessionsHomePlugin;
