// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置域插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// tsc / vitest / bundle 域直连真实模块；esbuild 产物域构建期重定向到
// './host.aliased.ts'（宿主桥 mods 共享真实例）。两域形状必须一致
// （host.aliased.ts 以 `typeof import('./host')` 对拍）：本文件只做
// re-export，不改写任何实现。

export { ConfirmDialog } from '../../../app/panels/settings/ConfirmDialog';
export { McpPage } from '../../../app/panels/settings/McpPage';
export { PluginsPage } from '../../../app/panels/settings/PluginsPage';
export { ProviderPage } from '../../../app/panels/settings/ProviderPage';
export { SkillsPage } from '../../../app/panels/settings/SkillsPage';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
export { activationConflict, activationSkipped } from '../../../composition/activation';
export { selectPreset } from '../../../composition/preset-assembly';
export { compositionDir, createPresetFromTemplate, rescanPresets } from '../../../composition/preset-authoring';
export { setLang } from '../../../i18n';
export { typedJsonRpc } from '../../../rpc-contract';
export type { AppSettings, ConnectionProbe, ProviderId } from '../../../settings';
export {
  autoUpdateCheckEnabled,
  canvasWheelMode,
  loadSettings,
  loadSettingsWithSecrets,
  persistSecrets,
  removeSecret,
  saveSettings,
} from '../../../settings';
export { notifyAgentConfigChanged } from '../../../state/agent-config-store';
export { useCompositionStore } from '../../../state/composition-store';
export { useDockStore } from '../../../state/dock-store';
export { usePresetStore } from '../../../state/preset-store';
export { useUpdateStore } from '../../../state/update-store';
export { iconHtml } from '../../../ui/icons';
