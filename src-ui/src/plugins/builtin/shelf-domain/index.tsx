// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/shelf-domain — **架阁**（软件的门 + 卡片的家）第一方插件。
//
// v66（2026-11-21）**升格**：架阁从「纸壳的家具」搬到**应用级浮层**——
// 经 ctx.rootViews 的 'overlay' 槽贡献（App 根渲染，槽空 = 零渲染）。
//
// 为什么必须搬（用户 2026-11-21 拍板「搬出纸壳，早晚都要搬的」）：
//   架阁自述「**随时可开的查询面**」（state/shelf-store.ts 头注），但它此前挂在
//   PaperPanel 根——纸关着（停在案卷首页）时它整个不存在。承诺从来没兑现过。
//   同批它还成了 panels 通道的**唯一入口**：插件面板注册了却无处可开（见
//   docs/issues/lantai-plugin-panels-no-home）——门必须开在所有界面状态都能摸到的地方。
//
// 形态与数据纪律见 ShelfOverlay 头注（视觉精度另有立项，本批只动结构）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { ShelfOverlay } from './ShelfOverlay';

/** 架阁插件——rootViews 'overlay' 槽贡献行。 */
export const shelfDomainPlugin = {
  name: 'hologram/shelf-domain',
  inject: ['rootViews'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.rootViews.register({
          id: 'shelf',
          slot: 'overlay',
          component: ShelfOverlay,
        }),
      'shelf-overlay',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default shelfDomainPlugin;
