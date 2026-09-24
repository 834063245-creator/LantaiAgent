// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置插件宿主模块面（first-party-hot-reload-plan 增补四施工）——
// 构建产物（builtin/<face>/ 双走查形态）经 window.__lantai_plugin_host__.mods
// 取用的项目模块真实例注册表。
//
// 为什么是「共享真实例」而不是产物内联副本：面组件消费的 zustand store /
// 服务 active 访问器（provider/catalog 动态拉取态、
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
import { EventKind } from '../../agent/agent-types';
// S3：工具域/段贡献插件对象导入已拆除——产物域真源自带；此处只导工具工厂
// 运行时值（faceDeps 取用面）。（z（engine-domain 运行时取用）随图谱退役
// 移除，2026-09-09。）
import { firstPartyCapabilities } from '../../agent/blueprint';
import { COMPACTION_NOTICE_MARK, DEFAULT_COMPACT_RATIO, DEFAULT_RETAIN_RATIO } from '../../agent/compaction-contract';
import { registerCompactionImplementation } from '../../agent/compaction-impl';
import { DEFAULT_C_IN, DEFAULT_C_OUT, LOSS_FACTOR_PER_EVENT } from '../../agent/compaction-tracker';
// 批 3a 归家：wait/office/cordis 三域工厂已随包 ⇒ 撤桥，改桥它们仍住内核的依赖面。
import { SubAgentStatus } from '../../agent/coordinator';
import { activeDynamicRunner } from '../../agent/dynamic-runner/dynamic-runner-service';
import { extractFilePath, WRITE_TOOLS } from '../../agent/file-ownership';
import { parseGitLogCommits, parseGitStatusPorcelain } from '../../agent/git-porcelain';
import { registerGoalImplementation } from '../../agent/goal-impl';
import { enqueueIsolationOp } from '../../agent/isolation-queue';
import { log } from '../../agent/logger';
import { errText, parseFilePathArg } from '../../agent/loop-helpers';
import { createMemoryTools } from '../../agent/memory';
import {
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
} from '../../agent/message-contract';
import { registerMultiagentComm } from '../../agent/multiagent-impl';
import { registerPlanImplementation } from '../../agent/plan/plan-impl';
import { execStreamedShell } from '../../agent/runtime/queued-shell';
import { assertSupportedSchema, extractJsonObject, validateObjectJsonSchema } from '../../agent/schema-validate';
import { isAbsolutePath, ownerContext, resolveAgainstRoot, stickyCwdOf } from '../../agent/session-context';
import { buildCompactedSummaryMessage } from '../../agent/session-log';
import { createSkillTool, scanSkills } from '../../agent/skills';
import { parseIsolationDiff } from '../../agent/spill';
import { registerStateHooksImplementation } from '../../agent/state-hooks-impl';
import {
  buildPreReadBlock,
  cacheBuildResult,
  formatDiagnostics,
  invalidateBlameEntry,
  refreshGitBlame,
} from '../../agent/state-inject';
import { getSubAgentActivity, STUCK_THRESHOLD_S } from '../../agent/subagent-activity';
import { registerSubagentRuntime } from '../../agent/subagent-runtime-impl';
import { spawnSubAgentImpl } from '../../agent/subagent-spawn';
import { registerSubAgentTools } from '../../agent/subagent-tools-impl';
import { createTaskTools } from '../../agent/task';
import { countMessage, countMessages, countText } from '../../agent/token-counter';
import { foldToolResults, nextFoldBoundary } from '../../agent/tool-fold';
import { hasImageRefs } from '../../agent/tool-images';
// 批 4c-2 归家：agent-isolation / ask 两族进包 ⇒ 撤工厂桥；两族只余 defineTool/类型面。
import { defineTool, toInputJsonSchema } from '../../agent/tools/define-tool';
import { resolveGuardToolName } from '../../agent/tools/domains';
import { createAssetTools } from '../../agent/tools/show-asset';
import { parseStructuredError } from '../../agent/tools/structured-error';
import { useCoreStore } from '../../app/chat/core-instance';
import { extractImageFiles, previewUrlFor } from '../../app/chat/image-intake';
import { filterCommands, listCommands, slashOnly } from '../../app/commands/command-catalog';
import { ensureSkillCatalog } from '../../app/commands/skill-catalog';
import { Icon } from '../../app/Icon';
import { useDialogEscape } from '../../app/overlay';
import { PluginBoundary } from '../../app/PluginBoundary';
import { ConfirmDialog } from '../../app/panels/settings/ConfirmDialog';
// 批 1 归家：McpPage / PluginsPage / SkillsPage 已迁 plugins/builtin/settings-domain/
// （改为逐符号桥，见下方「批 1」段）；ProviderPage 家族仍在内核（批 9）。
import { ProviderPage } from '../../app/panels/settings/ProviderPage';
import { useShellStore } from '../../app/shell-store';
import { WinControls } from '../../app/WinControls';
import { onTopbarDoubleClick, onTopbarPointerDown } from '../../app/window-drag';
import { isMockMode, watchFileDragDrop } from '../../bridge';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
import { activationConflict, activationSkipped } from '../../composition/activation';
import { ContributionChannel } from '../../composition/contribution-channel';
import { activeFsProviders } from '../../composition/fs-service';
import { activeOverlayContributions, subscribeOverlayContributions } from '../../composition/overlay-service';
import { reapplyComposition, selectPreset } from '../../composition/preset-assembly';
import { discoverPresets, stringifyPatchYaml } from '../../composition/preset-discovery';
import { builtinPresets, isValidPresetId } from '../../composition/presets';
import { firstPartyPromptSections } from '../../composition/prompt-sections';
import { resolveAssetBlock, resolveRenderer } from '../../composition/renderer-service';
import { ownerIdOf, ownerSeamView } from '../../composition/seam-scope';
import { activeShellProviders } from '../../composition/shell-service';
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
  viewportCenterWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../paper/canvas-math';
import { defaultFolded, foldLabel, isFoldable } from '../../paper/fold';
import { groupWorkUnits, leadOf, rhythmAssign, sealedMessageIdsOf, unitMembership } from '../../paper/group';
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
  MARGINALIA_TOP,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  needsObservedHeight,
  observedKeyOf,
  reportObservedBlockHeight,
  reportObservedSidecarExtent,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
} from '../../paper/measure';
import { clampViewportFrame, inkBarsFor, minimapProject, regionFrame } from '../../paper/minimap-core';
import { PaperDockContext, PaperRegionContext, usePaperDock, usePaperRegion } from '../../paper/overlay-context';
import { classifyDropZone, makeStrip, selectionMaskRects, stashStripPositionAt } from '../../paper/selection';
import {
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
} from '../../paper/space';
import { collapseToolGroups, translateMessagesCached } from '../../paper/translate';
import { injectPaperTokens } from '../../paper/type-tokens';
import { viewportWorldRect, visibleFlowWindow, visiblePinnedIds } from '../../paper/virtualize';
// 批 1 归家（2026-09-24）：三页进包后的逐符号桥面——引擎开关 / 装卸面 /
// MCP 声明与用户级 mcp.json / 插件与偏好 store。装卸面与 loader 的循环为
// 运行期取用（组件按钮回调），无初始化期解引用，ESM 循环安全（见文件头注）。
import {
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
} from '../../plugins/bundled-engine';
import { activateExternalPlugin, deactivateExternalPlugin } from '../../plugins/loader';
import { McpServerDeclSchema } from '../../plugins/types';
import { isUserMcpMissingError, parseUserMcpJson, resolveUserMcpJsonPath } from '../../plugins/user-mcp';
// 批 2a 归家：llm-adapters 的三方言实现已进产物包 ⇒ 撤掉工厂的 faceDeps 桥
// （kernel 侧零消费者），改桥适配器仍依赖的内核面（seam 契约 / 目录与元数据 /
// 错误分类 / 思考档 / 传输 / 协议默认端点表）。
import {
  clampMaxTokens,
  findModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  onDynamicFetchChange,
  searchModels,
} from '../../provider/catalog';
import { resolveApiKey } from '../../provider/credentials';
import { classifyProviderError } from '../../provider/error-catalog';
import { streamWithIdleTimeout } from '../../provider/idle-stream';
import { modelEntries, parseModelEntry } from '../../provider/model-meta';
// provider 配置文件通道（2026-09-24 配方改文件批）：设置页路径/错误/写盘面
import {
  ensureProvidersDir,
  loadProjectProvidersDoc,
  onProvidersDocChange,
  projectProvidersErrors,
  projectProvidersFatal,
  providersDocStatus,
  providersFilePath,
  retryProvidersPath,
  saveProvidersDoc,
} from '../../provider/providers-store';
import {
  assertEffortDeclared,
  isThinkingMode,
  THINKING_EFFORT_BUDGETS,
  thinkingCapability,
  thinkingOptionsFor,
  thinkingOptionsOrDefault,
} from '../../provider/thinking';
import { proxyFetch } from '../../provider/transport';
import {
  ApiError,
  ChunkType,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
  retryAfterSeconds,
  sanitizeToolPairing,
} from '../../provider/types';
import {
  kernelAppendFileDurable,
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelListDirectory,
  kernelReadFile,
  kernelReadFileRaw,
  kernelTruncateFile,
  kernelWriteFile,
  parseJson,
  typedJsonRpc,
  typedRpc,
} from '../../rpc-contract';
import {
  autoUpdateCheckEnabled,
  canvasWheelMode,
  effectiveModels,
  loadSettings,
  loadSettingsWithSecrets,
  modelContextWindow,
  modelDescriptor,
  modelInput,
  modelThinking,
  onSettingsSaved,
  PROVIDER_PROTOCOL_DEFAULTS,
  persistSecrets,
  removeSecret,
  saveSettings,
} from '../../settings';
import { leaveToHome } from '../../shell/rows/workspace';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import { useAskStore } from '../../state/ask-store';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { describeReceipt, useBundledEngineStore } from '../../state/bundled-engine-store';
import { blockFromSnapshot, getCanvasStore, scheduleCanvasSave, snapshotFromBlock } from '../../state/canvas-store';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { getComposeStore, resolveNewSessionDefault } from '../../state/compose-store';
import { useCompositionStore } from '../../state/composition-store';
import { useDockStore } from '../../state/dock-store';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, useModeStore } from '../../state/mode-store';
import { usePluginPrefs } from '../../state/plugin-prefs';
import { usePluginStore } from '../../state/plugin-store';
import { usePresetStore } from '../../state/preset-store';
import { useSessionVolumesStore } from '../../state/session-volumes-store';
import { useUpdateStore } from '../../state/update-store';
import {
  killShellWork,
  pullShellWork,
  selectSessionWork,
  setOwnerSessionResolver,
  useWorkLedgerStore,
} from '../../state/work-ledger-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
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
  Record<keyof typeof import('./multiagent-comm/host'), unknown> &
  Record<keyof typeof import('./wait-domain/host'), unknown> &
  Record<keyof typeof import('./cordis-domain/host'), unknown> &
  Record<keyof typeof import('./asset-domain/host'), unknown> &
  Record<keyof typeof import('./office-domain/host'), unknown> &
  Record<keyof typeof import('./prompt-segments/host'), unknown> &
  Record<keyof typeof import('./capability-segments/host'), unknown> &
  Record<keyof typeof import('./plan-mode/host'), unknown> &
  Record<keyof typeof import('./goal-mode/host'), unknown> &
  Record<keyof typeof import('./state-hooks/host'), unknown> &
  Record<keyof typeof import('./compaction/host'), unknown> &
  Record<keyof typeof import('./agent-domain/host'), unknown> &
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
  // 批 1 归家（2026-09-24）：作者面三件（compositionDir/createPresetFromTemplate/
  // rescanPresets）已随 preset-authoring 进包 ⇒ 从 faceDeps 撤桥；改桥它们仍留内核的
  // 机制依赖（重扫应用 / 发现 / 内置表 / id 围栏 / patch 序列化）。
  reapplyComposition,
  discoverPresets,
  stringifyPatchYaml,
  builtinPresets,
  isValidPresetId,
  // provider 配置文件通道（2026-09-24 配方改文件批）：路径 / 逐节错误 / 写盘
  saveProvidersDoc,
  providersFilePath,
  providersDocStatus,
  onProvidersDocChange,
  ensureProvidersDir,
  loadProjectProvidersDoc,
  projectProvidersErrors,
  projectProvidersFatal,
  retryProvidersPath,
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
  wheelFactor,
  worldToScreen,
  zoomAt,
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
  MARGINALIA_TOP,
  needsObservedHeight,
  observedKeyOf,
  reportObservedBlockHeight,
  reportObservedSidecarExtent,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
  PaperDockContext,
  PaperRegionContext,
  usePaperDock,
  usePaperRegion,
  // 批 5a 归家（2026-09-24）：toc / toc-ink / ime / sel-ink / focus-flight / sheet /
  // provenance 七件随包 ⇒ 这些 faceDeps 键已撤（包内实现，两域同源）。
  classifyDropZone,
  makeStrip,
  selectionMaskRects,
  stashStripPositionAt,
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
  /* 役册（2026-09-22）：后台工作台账——zustand 单例 + 只读对账口，坞只读；
   * 归属解析器由 workspace 装配期注入（面板 runtime 才有 bus 父子树）。 */
  useWorkLedgerStore,
  selectSessionWork,
  pullShellWork,
  killShellWork,
  setOwnerSessionResolver,
  /* 卷清单变更信号（2026-09-18 侧栏载入批）：canvas-nav 侧栏/书脊订阅——卷文件
   * 落定写入后重读清单投影（写代缓存已就地更行，重读零 I/O）。 */
  useSessionVolumesStore,
  notifyAgentConfigChanged,
  getChatStore,
  msgStoreFor,
  listCommands,
  slashOnly,
  filterCommands,
  ensureSkillCatalog,
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
  ProviderPage,
  // 批 2a 归家（2026-09-24）：llm-adapters 的端点真源（内核协议默认端点表）
  PROVIDER_PROTOCOL_DEFAULTS,
  // 批 1 归家（2026-09-24）：三页进包后的逐符号桥面
  scanSkills,
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
  activateExternalPlugin,
  deactivateExternalPlugin,
  McpServerDeclSchema,
  isUserMcpMissingError,
  parseUserMcpJson,
  resolveUserMcpJsonPath,
  describeReceipt,
  useBundledEngineStore,
  usePluginPrefs,
  usePluginStore,
  kernelCreateDirectory,
  kernelReadFile,
  parseJson,
  typedRpc,
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
  // 2026-09-23 思考下沉：provider 作用域描述符 + 生效思考档位（覆盖 ?? 行值）
  // ——创作坞 pill 换源到与设置页/请求期同一把尺子
  modelDescriptor,
  modelThinking,
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
  thinkingOptionsOrDefault,
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
  // 批 2a：llm-adapters 归家后的依赖面（工厂已随包，不再桥）
  ApiError,
  ChunkType,
  clampMaxTokens,
  classifyProviderError,
  modelEntries,
  parseModelEntry,
  assertEffortDeclared,
  isThinkingMode,
  THINKING_EFFORT_BUDGETS,
  thinkingCapability,
  proxyFetch,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
  retryAfterSeconds,
  sanitizeToolPairing,
  setLang,
  iconHtml,
  // 创作坞 v2（2026-08-31）：引（typedJsonRpc 文件枚举）/ 拖放入卷（Tauri 原生通道）
  isMockMode,
  watchFileDragDrop,
  // S3 工具域真源产物运行时依赖（经宿主桥 mods.faceDeps 取用）
  createSkillTool,
  createMemoryTools,
  createTaskTools,
  // 批 4b 归家（2026-09-24）：search/web 两域实现进包（原 manifest-tools 按域拆）
  // ⇒ 撤这两个工厂键；两域只余平台面（toInputJsonSchema / Tool 类型）。
  // 批 3a 归家（2026-09-24）：wait/office/cordis 三域的工具工厂已随包 ⇒ 撤桥；
  // 改用它们仍住内核的依赖面（defineTool / Tool 类型 / 域私有内核函数）。
  SubAgentStatus,
  defineTool,
  isAbsolutePath,
  ownerContext,
  resolveAgainstRoot,
  stickyCwdOf,
  activeDynamicRunner,
  // 标题栏交互（2026-09-14 app-region 退役）：顶部浮件拖拽/双击最大化的原生实现
  onTopbarPointerDown,
  onTopbarDoubleClick,
  createAssetTools,
  firstPartyPromptSections,
  firstPartyCapabilities,
  // S5b agent-loop-service 产物运行时依赖
  ContributionChannel,
  Service,
  defaultAgentLoop,
  setActiveAgentLoop,
  // 批 4a 归家（2026-09-24）：browser/desktop 实现进包 ⇒ 撤工厂桥，改桥依赖面
  errText,
  toInputJsonSchema,
  parseStructuredError,
  // 批 4c-1 归家：git 工具族进包 ⇒ 撤工厂桥；改桥它仍住内核的解析器
  parseGitLogCommits,
  parseGitStatusPorcelain,
  // 批 4c-3 归家：fs/shell 两族进包 ⇒ 撤工厂桥；改桥 seam 裁剪读面 + 活跃 provider 表
  ownerIdOf,
  ownerSeamView,
  activeFsProviders,
  activeShellProviders,
  // 批 6a 归家：plan 模式实现进包 ⇒ 桥内核登记表 + 事件枚举（kernelReadFile 早已在册）
  registerPlanImplementation,
  EventKind,
  // 批 6b 归家：goal 循环实现进包 ⇒ 桥内核登记表（errText/defineTool 早已在册）
  registerGoalImplementation,
  // 批 6c 归家：出厂 hook 四工厂进包 ⇒ 桥登记表 + 数据源（诊断/blame/构建缓存/附图判定）
  registerStateHooksImplementation,
  buildPreReadBlock,
  cacheBuildResult,
  formatDiagnostics,
  hasImageRefs,
  invalidateBlameEntry,
  refreshGitBlame,
  // 批 6d-2 归家：压缩域实现进包 ⇒ 桥登记表 + 数据源/常量（kernelReadFile/ChunkType/defineTool/EventKind 已在册）
  registerCompactionImplementation,
  streamWithIdleTimeout,
  log,
  buildCompactedSummaryMessage,
  countMessage,
  countMessages,
  countText,
  foldToolResults,
  nextFoldBoundary,
  extractFilePath,
  WRITE_TOOLS,
  parseFilePathArg,
  resolveGuardToolName,
  DEFAULT_C_IN,
  DEFAULT_C_OUT,
  LOSS_FACTOR_PER_EVENT,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_RETAIN_RATIO,
  COMPACTION_NOTICE_MARK,
  // 批 7a 归家：subagent 工具族进包 ⇒ 撤两工厂键；桥 schema 校验 / 子代理活动账 / 登记表
  registerSubAgentTools,
  assertSupportedSchema,
  extractJsonObject,
  validateObjectJsonSchema,
  getSubAgentActivity,
  STUCK_THRESHOLD_S,
  // 批 7b 归家：通信族进包 ⇒ 桥登记表 + 四个错误类 + 目录/删除/列举文件腰
  registerMultiagentComm,
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
  // 批 7c-1 归家：merge / discovery 两工具族进 subagent-in-process 包 ⇒ 桥登记表 + 隔离队列/编译腰
  enqueueIsolationOp,
  execStreamedShell,
  parseIsolationDiff,
  registerSubagentRuntime,
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
