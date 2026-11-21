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
// **浮层全局 ≠ 入口唯一**（2026-11-21 实机报「架阁只在首页」的教训）：
//   浮层搬到 App 根之后，纸壳那枚字件被一起删掉了——于是纸开着时反而没有门。
//   现在入口三处，各自跟着「人在哪」：
//     · 案卷首页顶栏（sessions-home）——纸关着的那一半；
//     · 纸壳顶部浮件（paper-shell）——纸开着的那一半；
//     · 命令 `shelf/open`（本文件）——Ctrl+K / 斜杠面板，任何状态都用键盘摸得到。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { useShelfStore } from './host';
import { ShelfOverlay } from './ShelfOverlay';

/** 架阁插件——rootViews 'overlay' 槽贡献行 + 命令通道（Ctrl+K / 斜杠可达）。 */
export const shelfDomainPlugin = {
  name: 'hologram/shelf-domain',
  inject: ['rootViews', 'commands'],
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
    /* 命令入口（v66）：浮层是应用级的，键盘也得能到——用户停在哪儿（首页 / 纸 /
     * 任意面板之上）都不该被「这一面没摆按钮」挡住。斜杠 `/shelf` 同一条命令。 */
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'shelf/open',
          label: '架阁…（软件与卡片）',
          description: '打开架阁：装进来的软件、入阁的卡片、插件面板',
          group: '面板',
          slash: '/shelf',
          action: { type: 'local', handler: () => useShelfStore.getState().openShelf() },
        }),
      'shelf-command',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default shelfDomainPlugin;
