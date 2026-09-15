// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// panel-defs-store — 面板/命令贡献变更信号（S4-1.5 消费闭环）。
// 发射点：composition/services.ts 的 PanelsService / CommandsService
// register/dispose（贡献变更 → bump —— turn-done-store 同款 tick 模式）。
// 消费者：DockPanel（panels）、CommandPalette（commands）——
// bump 后重取 panelDefs() / 合流清单，即时生效（§2.3 生效语义）。
// （DockRail 已于 V5 拆除一并退役，勿再按旧注释找它。）

import { create } from 'zustand';

export const usePanelDefsStore = create<{ panelDefsTick: number; commandsTick: number }>(() => ({
  panelDefsTick: 0,
  commandsTick: 0,
}));

/** 面板贡献变更（register/dispose）→ DockPanel 重渲染。 */
export function bumpPanelDefs(): void {
  usePanelDefsStore.setState((s) => ({ panelDefsTick: s.panelDefsTick + 1 }));
}

/** 命令贡献变更（register/dispose）→ CommandPalette 重取清单。 */
export function bumpCommands(): void {
  usePanelDefsStore.setState((s) => ({ commandsTick: s.commandsTick + 1 }));
}
