// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugins/canvas-nav-plugin — 画布导航第一方插件（Stage-3）。
//
// 侧边栏 + 书脊 = 上层形态（原则二/三）：两个面板都以贡献行落位
// （ctx.panels 注册 'canvas-spine' / 'canvas-sidebar'），消费 ctx.space
// （activeSpace() 读面 + focus/expand/place/collapse 四命令），不新增核心 API。
//
// 布局方案 A（stage-3 §3.5）：书脊恒显最左缘 + 侧边栏在其右（可折叠，
// 收起 = 只剩书脊）。两个面板随纸面板开合同步（paper 开 → 全开；
// paper 关 → 全关——侧边栏/书脊只在画布上下文有意义）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约）；
// 装载在 compositionServicesPlugin + spaceServicePlugin 之后（inject 依赖可解析）。

import { SessionSidebar } from '../app/panels/SessionSidebar';
import { SpineRack } from '../app/panels/SpineRack';
import type { Context } from '../cordis';
import { useDockStore } from '../state/dock-store';

/** 画布导航插件——书脊 + 案卷侧边栏双面板贡献 + 开合同步 + toggle 命令。 */
export const canvasNavPlugin = {
  name: 'hologram/canvas-nav',
  inject: ['panels', 'commands', 'space'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'canvas-spine',
          side: 'left',
          title: '书脊',
          icon: 'book',
          unmountOnClose: true,
          component: SpineRack,
        }),
      'canvas-spine-panel',
    );
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'canvas-sidebar',
          side: 'left',
          title: '案卷',
          icon: 'list',
          unmountOnClose: true,
          component: SessionSidebar,
        }),
      'canvas-sidebar-panel',
    );

    // 开合同步：纸面板是这两个覆盖层的生命周期锚（纸关 = 画布上下文退场）。
    // 只在 paper 开合状态翻转时同步——侧边栏自身的收起/展开不重新拉回
    // （否则 collapse 会被订阅回调立即推翻）。
    let prevPaperOpen = useDockStore.getState().open.paper === true;
    const syncPanels = (): void => {
      const paperOpen = useDockStore.getState().open.paper === true;
      if (paperOpen === prevPaperOpen) return;
      prevPaperOpen = paperOpen;
      if (paperOpen) {
        useDockStore.getState().openPanel('canvas-spine');
        useDockStore.getState().openPanel('canvas-sidebar');
      } else {
        useDockStore.getState().closePanel('canvas-spine');
        useDockStore.getState().closePanel('canvas-sidebar');
      }
    };
    ctx.effect(() => {
      syncPanels();
      return useDockStore.subscribe(syncPanels);
    }, 'canvas-nav-sync');

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'canvas/sidebar-toggle',
          label: '案卷侧边栏（开/收起）',
          group: '画布',
          shortcut: '/sidebar',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('canvas-sidebar') },
        }),
      'canvas-sidebar-command',
    );
  },
};
