// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shelf-domain/host — 本产物的**内核桥**（开发域真源；产物域由 host.aliased.ts 换面）。
//
// 纪律（对齐 paper-shell/host.ts 头注与 host-modules 的 FaceBridgeSeal）：本文件
// **每一个导出都必须是 host-modules.ts 的 faceDeps 键**——守护测试按面桥封条对拍，
// 多一个就红。包内私有件不进本面（消费方直接 from './<file>' 取用）。
//
// ⚠ 为什么必须走桥：直引内核路径会被 esbuild 内联成**第二份实例**——同一份 store
// 两个副本，打包态读写分家（单测看不出来，因为开发域单实例）。

/* 卡片库门面（B1/B5）：读清单 / 读一张 / 写状态 / 重命名 / 删除。
 * 状态桥对面是**卡片库**——入阁的卡不属任何会话，故不走会话级 asset-state。 */
export { deleteCard, listCards, readCard, renameCard, writeCardState } from '../../../agent/card-library';
export { useCoreStore } from '../../../app/chat/core-instance';
/* 面板清单（v66）：架阁软件页 = 插件窗口 ∪ 面板。panelDefs() 是「常量 + ctx.panels
 * 贡献」的合流点，读模块级 activePanelContributions；usePanelDefsStore 是贡献变更
 * 信号（register/dispose → bump）。两者都带模块级态 ⇒ 必须走桥。 */
export { panelDefs } from '../../../app/panels/panel-def';
export { viewportCenterWorld } from '../../../paper/canvas-math';
export { getCanvasStore } from '../../../state/canvas-store';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
export { useDockStore } from '../../../state/dock-store';
export { usePanelDefsStore } from '../../../state/panel-defs-store';
export { usePluginWindowStore } from '../../../state/plugin-window-store';
export { useShelfStore } from '../../../state/shelf-store';
export { useToastStore } from '../../../state/toast-store';
export { getChatStore } from '../../../ui/chat-store';
/* 窗口设施（B7 修复）：开窗必须走设施——它比裸 store 多一步「通知受治进程治理器」，
 * lazy / with-window 档的后端靠这条通知才会被拉起。 */
export { closePluginWindow, openPluginWindow } from '../../window-facility';
