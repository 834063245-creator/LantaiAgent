// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布导航插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
//
// 面组件（SpineRack/SessionSidebar）与插件本体的项目内依赖全部从这里取：
//   - tsc / vitest / bundle 域：本文件直连真实模块（类型检查保真）；
//   - esbuild 产物域：构建期把 './host' 重定向到 './host.aliased.ts'
//     （宿主桥 window.__lantai_plugin_host__.mods 共享真实例——store/
//     service 单例不可内联副本）。
//
// 两域形状必须一致（host.aliased.ts 以 `typeof import('./host')` 对拍）：
// 本文件只做 re-export，不改写任何实现。

export { agentSessionState } from '../../../agent/agent-session-state';
export type { ExecStateInstance } from '../../../agent/execution-state';
export { useCoreStore } from '../../../app/chat/core-instance';
export { useShellStore } from '../../../app/shell-store';
export { activeSpace } from '../../../composition/space-service';
export { screenToWorld } from '../../../paper/canvas-math';
export { pickDropAnchor } from '../../../paper/space';
export { useAskStore } from '../../../state/ask-store';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
export { useDockStore } from '../../../state/dock-store';
export { useSessionVolumesStore } from '../../../state/session-volumes-store';
export { getChatStore, msgStoreFor } from '../../../ui/chat-store';
