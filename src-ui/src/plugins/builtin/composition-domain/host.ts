// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition-domain · 宿主依赖面 · 开发/测试域。
//
// 「创作者模式」那半边的内核依赖面：preset 读写要的 store / 组合解析 / 发现 /
// 落盘 / YAML 序列化全部留内核（产物不得裸 import 内核模块与裸包 yaml——
// 内联副本会分裂 store 与解析缓存），本文件只做 re-export，不改写实现。

export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export { reapplyComposition } from '../../../composition/preset-assembly';
export { discoverPresets, parsePatchYamlText, stringifyPatchYaml } from '../../../composition/preset-discovery';
export { builtinPresets, isValidPresetId, type PresetEntry } from '../../../composition/presets';
export {
  type CompositionPatch,
  CompositionPatchError,
  factoryComposition,
  parseCompositionPatch,
  type ResolvedComposition,
  resolveRoster,
} from '../../../composition/roster';
export type { BuiltinToolRow } from '../../../composition/tool-rows';
export { kernelCreateDirectory, kernelReadFile, kernelWriteFile, typedRpc } from '../../../rpc-contract';
export { usePresetStore } from '../../../state/preset-store';
