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

import { setActiveAgentLoop } from '../../agent/agent-loop/agent-loop-active';
import { defaultAgentLoop } from '../../agent/agent-loop/default-loop';
import { agentSessionState } from '../../agent/agent-session-state';
// S3：工具域/段贡献插件对象导入已拆除——产物域真源自带；此处只导工具工厂
// 运行时值（faceDeps 取用面）。（z（engine-domain 运行时取用）随图谱退役
// 移除，2026-09-09。）
import { firstPartyCapabilities } from '../../agent/blueprint';
import { createMemoryTools } from '../../agent/memory';
import { createSkillTool } from '../../agent/skills';
import { spawnSubAgentImpl } from '../../agent/subagent-spawn';
import { createTaskTools } from '../../agent/task';
import { createBrowserTools, createDesktopTools } from '../../agent/tools/browser';
import {
  createAgentIsolationTools,
  createAskUserTools,
  createFsTools,
  createGitTools,
  createShellTools,
} from '../../agent/tools/coding';
import { CORDIS_TOOL_NAMES, createCordisTools } from '../../agent/tools/cordis';
import { createSearchTools, createWebTools } from '../../agent/tools/manifest-tools';
import { createOfficeTools } from '../../agent/tools/office';
import { createAssetTools } from '../../agent/tools/show-asset';
import { createAgentStatusTool, createSubAgentTool } from '../../agent/tools/subagent';
import { createWaitTool } from '../../agent/tools/wait';
import { useCoreStore } from '../../app/chat/core-instance';
import { extractImageFiles, previewUrlFor } from '../../app/chat/image-intake';
import { Icon } from '../../app/Icon';
import { useDialogEscape } from '../../app/overlay';
import { PluginBoundary } from '../../app/PluginBoundary';
import { ConfirmDialog } from '../../app/panels/settings/ConfirmDialog';
import { McpPage } from '../../app/panels/settings/McpPage';
import { PluginsPage } from '../../app/panels/settings/PluginsPage';
import { ProviderPage } from '../../app/panels/settings/ProviderPage';
import { SkillsPage } from '../../app/panels/settings/SkillsPage';
import { useShellStore } from '../../app/shell-store';
import { WinControls } from '../../app/WinControls';
import { onTopbarDoubleClick, onTopbarPointerDown } from '../../app/window-drag';
import { isMockMode, watchFileDragDrop } from '../../bridge';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
import { activationConflict, activationSkipped } from '../../composition/activation';
import { ContributionChannel } from '../../composition/contribution-channel';
import { activeOverlayContributions, subscribeOverlayContributions } from '../../composition/overlay-service';
import { selectPreset } from '../../composition/preset-assembly';
import { compositionDir, createPresetFromTemplate, rescanPresets } from '../../composition/preset-authoring';
import { firstPartyPromptSections } from '../../composition/prompt-sections';
import { resolveAssetBlock, resolveRenderer } from '../../composition/renderer-service';
import { activeSpace } from '../../composition/space-service';
import { Service } from '../../cordis';
import { setLang } from '../../i18n';
import { writingBlockIdOf } from '../../paper/block-model';
import {
  ANCHOR,
  autoPanVector,
  layoutRegion,
  nextZoomStep,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewForAnchor,
  viewportCenterWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../paper/canvas-math';
import { createFocusFlightScheduler } from '../../paper/focus-flight';
import { defaultFolded, foldLabel, isFoldable } from '../../paper/fold';
import { groupWorkUnits, leadOf, rhythmAssign, sealedMessageIdsOf, unitMembership } from '../../paper/group';
import { composerSubmitOnKey } from '../../paper/ime';
import {
  createInkCache,
  INK_FAIL,
  INK_LABEL_ALPHA,
  INK_LABEL_MIN_PX,
  INK_SIL_ACCENT_ALPHA,
  INK_SIL_MASS_ALPHA,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LOD_TEXT_MIN_PX,
  lodActive,
  lodFarActive,
  lodTierOf,
} from '../../paper/ink';
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
import { clampViewportFrame, inkBarsFor, minimapProject, regionFrame } from '../../paper/minimap-core';
import { PaperDockContext, PaperRegionContext, usePaperDock, usePaperRegion } from '../../paper/overlay-context';
import { mergeSelectionLines, selInkPaths, selSeedOf } from '../../paper/sel-ink';
import { classifyDropZone, makeStrip, selectionMaskRects, stashStripPositionAt } from '../../paper/selection';
import { sheetCharacter } from '../../paper/sheet';
import {
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
} from '../../paper/space';
import {
  buildStageAnchors,
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
import { buildTocInkBuckets } from '../../paper/toc-ink';
import { collapseToolGroups, translateMessagesCached } from '../../paper/translate';
import { injectPaperTokens } from '../../paper/type-tokens';
import { viewportWorldRect, visibleFlowWindow, visiblePinnedIds } from '../../paper/virtualize';
import { createAnthropicProvider } from '../../provider/anthropic';
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
import { createOpenAIProvider } from '../../provider/openai';
import { createResponsesProvider } from '../../provider/responses';
import { thinkingOptionsFor } from '../../provider/thinking';
import {
  kernelAppendFileDurable,
  kernelDeleteFile,
  kernelListDirectory,
  kernelReadFileRaw,
  kernelTruncateFile,
  kernelWriteFile,
  typedJsonRpc,
} from '../../rpc-contract';
import {
  autoUpdateCheckEnabled,
  canvasWheelMode,
  effectiveModels,
  loadSettings,
  loadSettingsWithSecrets,
  modelContextWindow,
  modelInput,
  onSettingsSaved,
  persistSecrets,
  removeSecret,
  saveSettings,
} from '../../settings';
import { leaveToHome } from '../../shell/rows/workspace';
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

/** 宿主桥供面封蜡（2026-09-02 划词白屏事故立法）：faceDeps 此前是手抄清单，
 *  host.ts 加出口漏注册时 tsc/测试全绿（两域测试都直连真身）、exe 里才炸
 *  （产物域 impl.X = undefined → TypeError → 整树卸载）。satisfies 四面
 *  host 形状后，漏注册在本文件保存即 tsc 红——失败从「用户 exe 运行时」
 *  搬回「写代码时」。 */
type FaceBridgeSeal = Record<keyof typeof import('./canvas-nav/host'), unknown> &
  Record<keyof typeof import('./compose-dock/host'), unknown> &
  Record<keyof typeof import('./paper-minimap/host'), unknown> &
  Record<keyof typeof import('./paper-shell/host'), unknown> &
  Record<keyof typeof import('./settings-domain/host'), unknown> &
  Record<keyof typeof import('./sessions-builtin/host'), unknown> &
  Record<keyof typeof import('./subagent-in-process/host'), unknown> &
  Record<keyof typeof import('./llm-adapters/host'), unknown> &
  Record<keyof typeof import('./web-domain/host'), unknown> &
  Record<keyof typeof import('./browser-desktop-domain/host'), unknown> &
  Record<keyof typeof import('./git-domain/host'), unknown> &
  Record<keyof typeof import('./search-domain/host'), unknown> &
  Record<keyof typeof import('./fs-domain/host'), unknown> &
  Record<keyof typeof import('./shell-domain/host'), unknown> &
  Record<keyof typeof import('./agent-isolation-domain/host'), unknown> &
  Record<keyof typeof import('./ask-domain/host'), unknown> &
  Record<keyof typeof import('./skill-domain/host'), unknown> &
  Record<keyof typeof import('./memory-domain/host'), unknown> &
  Record<keyof typeof import('./task-domain/host'), unknown> &
  Record<keyof typeof import('./agent-domain/host'), unknown> &
  Record<keyof typeof import('./wait-domain/host'), unknown> &
  Record<keyof typeof import('./cordis-domain/host'), unknown> &
  Record<keyof typeof import('./asset-domain/host'), unknown> &
  Record<keyof typeof import('./office-domain/host'), unknown> &
  Record<keyof typeof import('./prompt-segments/host'), unknown> &
  Record<keyof typeof import('./capability-segments/host'), unknown> &
  Record<keyof typeof import('./agent-loop-service/host'), unknown>;

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
  // P-1 authoring 环境（2026-09-14）：设置面板「组合」节的作者动作
  compositionDir,
  createPresetFromTemplate,
  rescanPresets,
  // S6 P3b：激活诊断读面（第四栏「被跳过」= 激活失败的插件 + 原因；独占冲突回看）
  activationSkipped,
  activationConflict,
  // paper 域（几何/墨迹/测量/选择/翻译/虚拟化/上下文）
  viewportCenterWorld,
  writingBlockIdOf,
  // paper-minimap 插件（2026-09-05）：minimap-core 纯几何（inkColorOf 已在下）
  clampViewportFrame,
  inkBarsFor,
  minimapProject,
  regionFrame,
  ANCHOR,
  autoPanVector,
  nextZoomStep,
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
  groupWorkUnits,
  leadOf,
  rhythmAssign,
  sealedMessageIdsOf,
  unitMembership,
  createInkCache,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  INK_FAIL,
  lodActive,
  lodFarActive,
  lodTierOf,
  LOD_TEXT_MIN_PX,
  INK_SIL_MASS_ALPHA,
  INK_SIL_ACCENT_ALPHA,
  INK_LABEL_MIN_PX,
  INK_LABEL_ALPHA,
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
  buildStageAnchors,
  nearestAnchorAt,
  viewportMarker,
  buildTocInkBuckets,
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
  mergeSelectionLines,
  selInkPaths,
  selSeedOf,
  sheetCharacter,
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
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
  PluginBoundary,
  ConfirmDialog,
  /* 离开工作区回首页（2026-09-08）：paper-shell 确认弹层确认后触发——运行时
   * 真关工作区在壳层 workspace 流（host.ts 出口与 faceDeps 同步）。 */
  leaveToHome,
  McpPage,
  PluginsPage,
  ProviderPage,
  SkillsPage,
  // 设置 / provider / rpc / i18n
  autoUpdateCheckEnabled,
  canvasWheelMode,
  effectiveModels,
  loadSettings,
  loadSettingsWithSecrets,
  modelContextWindow,
  // B5 multimodal-image：生效输入模态解析（覆盖 ?? 目录 ?? ['text']）——
  // 创作坞附图门禁与 ModelSelector「视」徽标同链消费
  modelInput,
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
  extractImageFiles,
  previewUrlFor,
  thinkingOptionsFor,
  typedJsonRpc,
  // sessions-builtin（2026-09-05 seam 动作面重设计）：默认 provider 换
  // kernel* 具名 helper（D-3/D-4——行为与今日直连逐字节一致 + 测试 mock 面
  // 零迁移）。
  // （typedRpc 孤儿键随 sessions-builtin 换轨移除——旧默认 provider 走 RPC
  //  直呼的唯一供给源；现无任何产物 host 面消费它。
  //  agentInvoke 先例（graph-builtin）随图谱退役删除，2026-09-09。）
  kernelReadFileRaw,
  kernelListDirectory,
  kernelWriteFile,
  // Phase 1 事件日志（2026-09-15 DSH 参照移植）：durable append 进宿主桥
  // （append_events 动作的落盘面——fsync 版 kernel helper）。
  kernelAppendFileDurable,
  kernelDeleteFile,
  kernelTruncateFile,
  spawnSubAgentImpl,
  createAnthropicProvider,
  createOpenAIProvider,
  createResponsesProvider,
  setLang,
  iconHtml,
  // 创作坞 v2（2026-08-31）：引（typedJsonRpc 文件枚举）/ 拖放入卷（Tauri 原生通道）
  isMockMode,
  watchFileDragDrop,
  // S3 工具域真源产物运行时依赖（经宿主桥 mods.faceDeps 取用）
  createWebTools,
  createGitTools,
  createSearchTools,
  createFsTools,
  createShellTools,
  createAgentIsolationTools,
  createAskUserTools,
  createBrowserTools,
  createDesktopTools,
  createSkillTool,
  createMemoryTools,
  createTaskTools,
  createSubAgentTool,
  createAgentStatusTool,
  createWaitTool,
  createCordisTools,
  CORDIS_TOOL_NAMES,
  // 标题栏交互（2026-09-14 app-region 退役）：顶部浮件拖拽/双击最大化的原生实现
  onTopbarPointerDown,
  onTopbarDoubleClick,
  createAssetTools,
  // office 域（2026-09-13 C 路）——**漏登记会让产物域 impl.createOfficeTools = undefined
  // → apply 期 TypeError → boot gate fail-loud 挂住 → chat 壳行不起（表现为
  // 「会话核心未初始化，无法绑定目录」）**。本文件顶部的 FaceBridgeSeal 是编译期守卫：
  // 新域漏登记 = tsc 红（本条即那次事故的补登记）。
  createOfficeTools,
  firstPartyPromptSections,
  firstPartyCapabilities,
  // S5b agent-loop-service 产物运行时依赖
  ContributionChannel,
  Service,
  defaultAgentLoop,
  setActiveAgentLoop,
} satisfies FaceBridgeSeal;

/** 宿主桥 mods 注册表（loader installPluginHostBridge 注入）。
 *  S3：toolDomains/segments 薄重导出已拆除——产物域真源自带插件对象。 */
export function pluginHostMods(): Record<string, unknown> {
  return { faceDeps };
}

/** 运行时宿主面键集（保险丝 a 对拍真源，2026-09-03 生产事故立法）：
 *  产物 face.json 声明的需求键以此为对拍面——缺键 = 产物与 exe 版本偏斜，
 *  装载器拒载（bundle 兜底行不位移），渲染期整树卸载的偏斜类事故绝迹。 */
export function faceDepsKeys(): ReadonlySet<string> {
  return new Set(Object.keys(faceDeps));
}

/** 宿主面指纹（保险丝 a′，2026-09-14 立法）——键集（排序）的 FNV-1a 32 位十六进制。
 *
 *  为什么需要它：保险丝 a 只在「产物要的键运行时没有」时开火，而这**只是偏斜的
 *  一种形态**。同日事故（乙 批把 INK_FAIL / buildTocInkBuckets 加进宿主面后按
 *  「只换产物」部署）：产物 face.json 声明的键在 exe 里也没有 → a 开火了，但由于
 *  S5 已把 displace 兜底退役（产物是唯一装载面），结果是**该插件整面缺席**，而非
 *  §8.5 承诺的「拒载 + bundle 兜底行不倒」。且**作者期毫无信号**——`npm run build`
 *  不会告诉你"本批动了宿主面，光换产物必炸"。
 *  指纹把这条边界变成可读数字：基线 `src/plugins/host-surface.baseline.json` 由
 *  `npm run gen:host-surface` 生成、由 tests/host-surface-seal.test.ts 封印（改宿主面
 *  必须同 commit 更新基线）；构建脚本把它写进每个产物 face.json 并**与本批 HEAD 的
 *  基线对比**，变了就大字告警；装载器拿产物声明的指纹与运行时对拍，报错从"缺键 A、B"
 *  升级为"产物需宿主面 <a>，当前 exe <b>"。
 *
 *  keys 可注入（缺省 = 运行时真源）——纯函数，测试可直接对拍稳定性与敏感性。 */
export function hostSurfaceFingerprint(keys: Iterable<string> = faceDepsKeys()): string {
  const sorted = [...keys].sort();
  let h = 0x811c9dc5; // FNV-1a 32
  for (const k of sorted) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // 键分隔符（防 "ab"+"c" 与 "a"+"bc" 撞同一指纹）
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
