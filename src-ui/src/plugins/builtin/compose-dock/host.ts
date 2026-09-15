// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// tsc / vitest / bundle 域直连真实模块；esbuild 产物域构建期重定向到
// './host.aliased.ts'（宿主桥 mods 共享真实例）。两域形状必须一致
// （host.aliased.ts 以 `typeof import('./host')` 对拍）：本文件只做
// re-export，不改写任何实现。

export { agentSessionState } from '../../../agent/agent-session-state';
export { useCoreStore } from '../../../app/chat/core-instance';
export { extractImageFiles, previewUrlFor } from '../../../app/chat/image-intake';
export { useShellStore } from '../../../app/shell-store';
export type { FileDragEvent } from '../../../bridge';
export { isMockMode, watchFileDragDrop } from '../../../bridge';
// 组合芯片（S6 P1e）：preset 清单/选择态读取面 + 全局默认选择入口 + 卷消息面
// （空白判据 = 本卷消息数，与写路径二道闸同一把尺子）
export { selectPreset } from '../../../composition/preset-assembly';
export type { SourcedBlock } from '../../../paper/block-model';
export { composerSubmitOnKey } from '../../../paper/ime';
export { createInkCache, INK_FAIL, inkBarColorOf, inkColorOf, inkForBlock } from '../../../paper/ink';
export { usePaperDock, usePaperRegion } from '../../../paper/overlay-context';
export type { StageUnitInput, TocMark, TocMarkInput, TocRange, TocSlider } from '../../../paper/toc';
export {
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
} from '../../../paper/toc';
export type { TocInkBucket, TocInkLine } from '../../../paper/toc-ink';
export { buildTocInkBuckets } from '../../../paper/toc-ink';
export {
  findModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  onDynamicFetchChange,
  searchModels,
} from '../../../provider/catalog';
export { resolveApiKey } from '../../../provider/credentials';
// 类型面（产物域经 host.aliased 对拍）
export type { StoredThinking, ThinkingMode } from '../../../provider/thinking';
export { thinkingOptionsFor } from '../../../provider/thinking';
export type { ChatImageRef, ModelDescriptor, Protocol } from '../../../provider/types';
export { typedJsonRpc } from '../../../rpc-contract';
export type { ProviderSettings } from '../../../settings';
export { effectiveModels, loadSettings, modelContextWindow, modelInput, onSettingsSaved } from '../../../settings';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
export type { ComposeSessionPrefs } from '../../../state/compose-store';
export { getComposeStore, resolveNewSessionDefault } from '../../../state/compose-store';
export type { PermissionMode } from '../../../state/mode-store';
export { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, useModeStore } from '../../../state/mode-store';
export type { PresetStoreState } from '../../../state/preset-store';
export { usePresetStore } from '../../../state/preset-store';
export { getChatStore, msgStoreFor } from '../../../ui/chat-store';
export { CommandRegistry } from '../../../ui/command-registry';
export { iconHtml } from '../../../ui/icons';
