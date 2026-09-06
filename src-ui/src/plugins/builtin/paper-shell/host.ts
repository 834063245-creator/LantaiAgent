// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
//
// 面组件（PaperPanel/InkLayer/StatusLine）与插件本体的项目内依赖全部从
// 这里取：tsc / vitest / bundle 域直连真实模块（类型检查保真）；esbuild
// 产物域构建期重定向到 './host.aliased.ts'（宿主桥 mods 共享真实例）。
// 两域形状必须一致（host.aliased.ts 以 `typeof import('./host')` 对拍）：
// 本文件只做 re-export，不改写任何实现。
// 加出口三处同步：① 本文件 ② host.aliased.ts 镜像（漏了产物构建 esbuild 红）
// ③ host-modules.ts faceDeps（漏了 satisfies 封蜡 tsc 红）——2026-09-02
// 划词白屏事故即漏了第 ③ 处，exe 里才炸出。

export { agentSessionState } from '../../../agent/agent-session-state';
export { useCoreStore } from '../../../app/chat/core-instance';
export { Icon } from '../../../app/Icon';
export { useDialogEscape } from '../../../app/overlay';
/* 保险丝 b（2026-09-03 生产事故立法）：渲染面错误边界——面组件/块渲染器
 * 的崩溃隔离（单插件渲染崩溃只死自己那格，React 整树卸载绝迹）。 */
export { PluginBoundary } from '../../../app/PluginBoundary';
export { useShellStore } from '../../../app/shell-store';
export { WinControls } from '../../../app/WinControls';
export {
  activeOverlayContributions,
  subscribeOverlayContributions,
} from '../../../composition/overlay-service';
export { resolveAssetBlock, resolveRenderer } from '../../../composition/renderer-service';
/* 创作坞 v2（2026-08-31）：案头签条开卷（activeSpace.expand）+ 流区运行
 * 呼吸线（agentSessionState exec 订阅）——faceDeps 已含，此处只补开发域出口。 */
export { activeSpace } from '../../../composition/space-service';
export type { RegionHitRect } from '../../../paper/active-region';
export {
  createSettleSelector,
  hitRegionAtWorld,
  viewportCenterWorld,
} from '../../../paper/active-region';
// 类型面（产物域经 host.aliased 对拍）
export type { SourcedBlock } from '../../../paper/block-model';
/* 纸面运行态（2026-09-06）：湿墨判定纯函数——RegionView.writingBlockId 的
 * 派生源（faceDeps 已含 host 形状封蜡，三处同步缺一即红）。 */
export { writingBlockIdOf } from '../../../paper/block-model';
// paper 几何 / 墨迹 / 测量 / 选择 / 翻译 / 虚拟化 / 上下文
export {
  ANCHOR,
  layoutRegion,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewForAnchor,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../../paper/canvas-math';
export { createFocusFlightScheduler } from '../../../paper/focus-flight';
export { defaultFolded, foldLabel, isFoldable } from '../../../paper/fold';
export type { WorkUnit } from '../../../paper/group';
/* stream-rhythm 刀2（2026-09-03）：工作单元 pass——节奏档的产出面
 * （groupWorkUnits → unitMembership/leadOf/rhythmAssign 喂布局；
 * sealedMessageIdsOf 定封口）。 */
export { groupWorkUnits, leadOf, rhythmAssign, sealedMessageIdsOf, unitMembership } from '../../../paper/group';
export type { BlockInk, InkCache } from '../../../paper/ink';
export {
  createInkCache,
  inkColorOf,
  inkForBlock,
  inkForText,
  lodActive,
} from '../../../paper/ink';
export type { BlockMeasureCache } from '../../../paper/measure';
export {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  needsObservedHeight,
  reportObservedBlockHeight,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
} from '../../../paper/measure';
export { PaperDockContext, PaperRegionContext } from '../../../paper/overlay-context';
export type { RegionView } from '../../../paper/region-view';
export {
  mergeSelectionLines,
  selInkPaths,
  selSeedOf,
} from '../../../paper/sel-ink';
export type { MaskRect, PaperStrip } from '../../../paper/selection';
export {
  classifyDropZone,
  makeStrip,
  selectionMaskRects,
  stashStripPositionAt,
} from '../../../paper/selection';
export { sheetCharacter } from '../../../paper/sheet';
export type { StreamRegionState } from '../../../paper/space';
export {
  clampRegionW,
  defaultRegionFor,
  nearestFreeRegion,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
} from '../../../paper/space';
export type { MessageTranslateCache } from '../../../paper/translate';
export { collapseToolGroups, translateMessagesCached } from '../../../paper/translate';
export { injectPaperTokens } from '../../../paper/type-tokens';
export type { FlowGeom, PinnedGeom } from '../../../paper/virtualize';
export { viewportWorldRect, visibleFlowWindow, visiblePinnedIds } from '../../../paper/virtualize';
export { useBgAlertStore } from '../../../state/bg-alert-store';
export type { CanvasStore } from '../../../state/canvas-store';
export { blockFromSnapshot, getCanvasStore, scheduleCanvasSave, snapshotFromBlock } from '../../../state/canvas-store';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
export { useDockStore } from '../../../state/dock-store';
export { useUpdateStore } from '../../../state/update-store';
export { getChatStore, msgStoreFor } from '../../../ui/chat-store';
export type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '../../../ui/message-model';
