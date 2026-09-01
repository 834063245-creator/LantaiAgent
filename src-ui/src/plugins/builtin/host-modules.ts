// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置插件宿主模块面（first-party-hot-reload-plan 增补四施工）——
// 构建产物（builtin/<face>/ 双走查形态）经 window.__lantai_plugin_host__.mods
// 取用的项目模块真实例注册表。
//
// 为什么是「共享真实例」而不是产物内联副本：面组件消费的 zustand store /
// 服务 active 访问器（CommandRegistry.instance、provider/catalog 动态拉取态、
// paper/measure 观察缓存）/ React Context（PaperDockContext 等）都是模块级
// 单例——产物内联副本会分裂状态（产物组件订阅到影子 store，UI 串流）。
// 本注册表把 bundle 域的唯一实例交给产物域消费；只有面组件本体与其 CSS
// 进入产物（视觉迭代的热更面）。
//
// 形状纪律：mods 的 key 分三组——faceDeps（四面组件共享依赖）/ toolDomains
// （16 工具域插件对象——产物域薄重导出）/ segments（段贡献插件对象）。
// 产物域的 host.aliased.ts 以 `typeof import('./host')` 对拍本表取用形状。
//
// 循环导入注记：本文件被 plugins/loader.ts 引用，而 faceDeps.SettingsDeps
// 里的 PluginsPage 反向引用 loader 的 activate/deactivate——三处都是运行期
// 取用（组件渲染 / 按钮回调），无模块初始化期解引用，ESM 循环安全。

import { agentSessionState } from '../../agent/agent-session-state';
import { useCoreStore } from '../../app/chat/core-instance';
import { Icon } from '../../app/Icon';
import { useDialogEscape } from '../../app/overlay';
import { ConfirmDialog } from '../../app/panels/settings/ConfirmDialog';
import { PluginsPage } from '../../app/panels/settings/PluginsPage';
import { ProviderPage } from '../../app/panels/settings/ProviderPage';
import { useShellStore } from '../../app/shell-store';
import { WinControls } from '../../app/WinControls';
import { isMockMode, watchFileDragDrop } from '../../bridge';
import { activeOverlayContributions, subscribeOverlayContributions } from '../../composition/overlay-service';
import { selectPreset } from '../../composition/preset-assembly';
import { resolveAssetBlock, resolveRenderer } from '../../composition/renderer-service';
import { activeSpace } from '../../composition/space-service';
import { setLang } from '../../i18n';
import { createSettleSelector, hitRegionAtWorld, viewportCenterWorld } from '../../paper/active-region';
import {
  ANCHOR,
  layoutRegion,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewForAnchor,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../paper/canvas-math';
import { createFocusFlightScheduler } from '../../paper/focus-flight';
import { defaultFolded, foldLabel, isFoldable } from '../../paper/fold';
import { composerSubmitOnKey } from '../../paper/ime';
import { createInkCache, inkColorOf, inkForBlock, inkForText, lodActive } from '../../paper/ink';
import {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  needsObservedHeight,
  reportObservedBlockHeight,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
} from '../../paper/measure';
import { PaperDockContext, PaperRegionContext, usePaperDock, usePaperRegion } from '../../paper/overlay-context';
import { classifyDropZone, makeStrip, selectionMaskRects, stashStripPositionAt } from '../../paper/selection';
import { sheetCharacter } from '../../paper/sheet';
import {
  clampRegionW,
  defaultRegionFor,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
} from '../../paper/space';
import {
  buildTurnAnchors,
  computeSlider,
  deriveMarks,
  grabOffsetAt,
  jumpViewTopAt,
  nearestAnchorAt,
  scrubViewTop,
  stripToWorld,
  unreadBand,
  viewportMarker,
} from '../../paper/toc';
import { collapseToolGroups, translateMessagesCached } from '../../paper/translate';
import { injectPaperTokens } from '../../paper/type-tokens';
import { viewportWorldRect, visibleFlowWindow, visiblePinnedIds } from '../../paper/virtualize';
import { capabilitySegmentsPlugin } from '../../plugins/capability-segments-plugin';
import {
  agentDomainPlugin,
  agentIsolationDomainPlugin,
  askDomainPlugin,
  assetDomainPlugin,
  browserDesktopDomainPlugin,
  cordisDomainPlugin,
  fsDomainPlugin,
  gitDomainPlugin,
  hologramDomainPlugin,
  memoryDomainPlugin,
  searchDomainPlugin,
  shellDomainPlugin,
  skillDomainPlugin,
  taskDomainPlugin,
  waitDomainPlugin,
  webDomainPlugin,
} from '../../plugins/coding-domain-plugins';
import { promptSegmentsPlugin } from '../../plugins/prompt-segments-plugin';
import {
  findModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  onDynamicFetchChange,
  searchModels,
} from '../../provider/catalog';
import { resolveApiKey } from '../../provider/credentials';
import { thinkingOptionsFor } from '../../provider/thinking';
import { typedJsonRpc } from '../../rpc-contract';
import {
  autoUpdateCheckEnabled,
  effectiveModels,
  graphEngineEnabled,
  loadSettings,
  loadSettingsWithSecrets,
  onSettingsSaved,
  persistSecrets,
  removeSecret,
  saveSettings,
} from '../../settings';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import { useAskStore } from '../../state/ask-store';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { blockFromSnapshot, getCanvasStore, scheduleCanvasSave, snapshotFromBlock } from '../../state/canvas-store';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { getComposeStore, resolveNewSessionDefault } from '../../state/compose-store';
import { useCompositionStore } from '../../state/composition-store';
import { useDockStore } from '../../state/dock-store';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, useModeStore } from '../../state/mode-store';
import { usePresetStore } from '../../state/preset-store';
import { useUpdateStore } from '../../state/update-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
import { CommandRegistry } from '../../ui/command-registry';
import { iconHtml } from '../../ui/icons';

/** 四面组件共享依赖（bundle 域真实例）。key = 产物 host.aliased 取用名。 */
const faceDeps = {
  // agent / composition 服务读面
  agentSessionState,
  activeSpace,
  activeOverlayContributions,
  subscribeOverlayContributions,
  resolveAssetBlock,
  resolveRenderer,
  selectPreset,
  // paper 域（几何/墨迹/测量/选择/翻译/虚拟化/上下文）
  createSettleSelector,
  hitRegionAtWorld,
  viewportCenterWorld,
  ANCHOR,
  layoutRegion,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewForAnchor,
  wheelFactor,
  worldToScreen,
  zoomAt,
  createFocusFlightScheduler,
  defaultFolded,
  foldLabel,
  isFoldable,
  createInkCache,
  inkColorOf,
  inkForBlock,
  inkForText,
  lodActive,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  needsObservedHeight,
  reportObservedBlockHeight,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
  PaperDockContext,
  PaperRegionContext,
  usePaperDock,
  usePaperRegion,
  buildTurnAnchors,
  nearestAnchorAt,
  viewportMarker,
  computeSlider,
  grabOffsetAt,
  scrubViewTop,
  jumpViewTopAt,
  stripToWorld,
  deriveMarks,
  unreadBand,
  classifyDropZone,
  makeStrip,
  selectionMaskRects,
  stashStripPositionAt,
  sheetCharacter,
  clampRegionW,
  defaultRegionFor,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
  collapseToolGroups,
  translateMessagesCached,
  injectPaperTokens,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
  composerSubmitOnKey,
  // 状态层（zustand 真实例——影子 store 禁止）
  blockFromSnapshot,
  getCanvasStore,
  scheduleCanvasSave,
  snapshotFromBlock,
  useCanvasViewStore,
  useCompositionStore,
  getComposeStore,
  resolveNewSessionDefault,
  useDockStore,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  PERMISSION_MODES,
  useModeStore,
  usePresetStore,
  useAskStore,
  useBgAlertStore,
  useUpdateStore,
  notifyAgentConfigChanged,
  getChatStore,
  msgStoreFor,
  CommandRegistry,
  useCoreStore,
  // 应用壳件
  Icon,
  useDialogEscape,
  useShellStore,
  WinControls,
  ConfirmDialog,
  PluginsPage,
  ProviderPage,
  // 设置 / provider / rpc / i18n
  autoUpdateCheckEnabled,
  effectiveModels,
  graphEngineEnabled,
  loadSettings,
  loadSettingsWithSecrets,
  onSettingsSaved,
  persistSecrets,
  removeSecret,
  saveSettings,
  getModel,
  findModels,
  searchModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  hasDynamicFetchInflight,
  onDynamicFetchChange,
  resolveApiKey,
  thinkingOptionsFor,
  typedJsonRpc,
  setLang,
  iconHtml,
  // 创作坞 v2（2026-08-31）：引（typedJsonRpc 文件枚举）/ 拖放入卷（Tauri 原生通道）
  isMockMode,
  watchFileDragDrop,
};

/** 经产物通道薄重导出的工具域插件对象（插件名 = S4-4 甲寻址键，零漂移）。 */
const toolDomains = {
  'hologram/web-domain': webDomainPlugin,
  'hologram/browser-desktop-domain': browserDesktopDomainPlugin,
  'hologram/engine-domain': hologramDomainPlugin,
  'hologram/git-domain': gitDomainPlugin,
  'hologram/search-domain': searchDomainPlugin,
  'hologram/fs-domain': fsDomainPlugin,
  'hologram/shell-domain': shellDomainPlugin,
  'hologram/agent-isolation-domain': agentIsolationDomainPlugin,
  'hologram/ask-domain': askDomainPlugin,
  'hologram/skill-domain': skillDomainPlugin,
  'hologram/memory-domain': memoryDomainPlugin,
  'hologram/task-domain': taskDomainPlugin,
  'hologram/agent-domain': agentDomainPlugin,
  'hologram/wait-domain': waitDomainPlugin,
  'hologram/cordis-domain': cordisDomainPlugin,
  'hologram/asset-domain': assetDomainPlugin,
};

/** 段贡献插件对象（B④ prompt 段 / B⑤ capability 段——真源留组合层/蓝图层，
 *  产物域薄重导出走通道）。 */
const segments = {
  'hologram/prompt-segments': promptSegmentsPlugin,
  'hologram/capability-segments': capabilitySegmentsPlugin,
};

/** 宿主桥 mods 注册表（loader installPluginHostBridge 注入）。 */
export function pluginHostMods(): Record<string, unknown> {
  return { faceDeps, toolDomains, segments };
}
