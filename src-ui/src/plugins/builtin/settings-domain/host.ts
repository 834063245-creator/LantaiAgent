// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置域插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// tsc / vitest / bundle 域直连真实模块；esbuild 产物域构建期重定向到
// './host.aliased.ts'（宿主桥 mods 共享真实例）。两域形状必须一致
// （host.aliased.ts 以 `typeof import('./host')` 对拍）：本文件只做
// re-export，不改写任何实现。
//
// 2026-09-24 批 1 归家：`McpPage` / `PluginsPage` / `SkillsPage` / `preset-authoring`
// 已搬进本包 ⇒ 它们的内核依赖从「整页桥」变成**逐符号桥**（下方按模块路径排序的
// 那些新条目——biome organizeImports 会按路径重排，故不再挂小节注释）。
// `ProviderPage` 家族（§2.1 的 2,740 行）与 `ConfirmDialog`（§4-3 归属待裁）仍在内核，
// 照旧整页桥。要点：`scanSkills`（技能列表源，批 3 随 skill-domain 走）、
// 随包引擎开关面（McpPage 卡片）、loader 装卸面（PluginsPage 按钮，运行期取用）、
// `stringifyPatchYaml`（作者面 YAML 序列化留内核——产物不得裸 import）。

// 技能域（SkillsPage 列表源；`agent/skills.ts` 归 skill-domain 见账本批 3）
export { type SkillDef, scanSkills } from '../../../agent/skills';
export { ConfirmDialog } from '../../../app/ConfirmDialog';
// 应用壳件
export { Icon } from '../../../app/Icon';
export { ProviderPage } from '../../../app/panels/settings/ProviderPage';
export { useShellStore } from '../../../app/shell-store';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
export { activationConflict, activationSkipped } from '../../../composition/activation';
// 组合作者面（preset-authoring 归家后仍住内核的机制面）
export { reapplyComposition, selectPreset } from '../../../composition/preset-assembly';
export {
  type DiscoverPresetsOptions,
  discoverPresets,
  stringifyPatchYaml,
} from '../../../composition/preset-discovery';
export { builtinPresets, isValidPresetId, type PresetEntry } from '../../../composition/presets';
export { setLang } from '../../../i18n';
// 随包引擎开关面（McpPage「随包图谱引擎」卡片）
export {
  type BundledEngineInfo,
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
} from '../../../plugins/bundled-engine';
// 装卸面（PluginsPage 的启用/禁用/卸载按钮；与 loader 的循环为运行期取用，见
// host-modules.ts 头注）
export { activateExternalPlugin, deactivateExternalPlugin } from '../../../plugins/loader';
export { type McpServerDecl, McpServerDeclSchema } from '../../../plugins/types';
export { isUserMcpMissingError, parseUserMcpJson, resolveUserMcpJsonPath } from '../../../plugins/user-mcp';
// provider 配置文件通道（2026-09-24 配方改文件批）：设置页显示路径与逐节错误、
// 打开目录、保存时写盘——意图的唯一权威是那份 YAML，这里是它的界面面。
export {
  ensureProvidersDir,
  loadProjectProvidersDoc,
  onProvidersDocChange,
  projectProvidersErrors,
  projectProvidersFatal,
  providersDocStatus,
  providersFilePath,
  retryProvidersPath,
  saveProvidersDoc,
} from '../../../provider/providers-store';
// 强制层 fs 口 + RPC 面（两页 + 作者面的 IO）
export {
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelWriteFile,
  parseJson,
  typedJsonRpc,
  typedRpc,
} from '../../../rpc-contract';
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
export { describeReceipt, useBundledEngineStore } from '../../../state/bundled-engine-store';
export { useCompositionStore } from '../../../state/composition-store';
export { useDockStore } from '../../../state/dock-store';
export { usePluginPrefs } from '../../../state/plugin-prefs';
export { type PluginRecord, usePluginStore } from '../../../state/plugin-store';
export { usePresetStore } from '../../../state/preset-store';
export { useUpdateStore } from '../../../state/update-store';
export { iconHtml } from '../../../ui/icons';
