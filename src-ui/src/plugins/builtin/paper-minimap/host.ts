// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 小地图插件宿主依赖面 · 开发/测试域（2026-09-05 插件化；增补四同款双走查）。
// tsc / vitest / bundle 域直连真实模块；esbuild 产物域构建期重定向到
// './host.aliased.ts'（宿主桥 mods 共享真实例）。两域形状必须一致
// （host.aliased.ts 以 `typeof import('./host')` 对拍）：本文件只做
// re-export，不改写任何实现。

export type { SourcedBlock } from '../../../paper/block-model';
export type { InkCache } from '../../../paper/ink';
export { inkColorOf } from '../../../paper/ink';
export type { MinimapRegionInput } from '../../../paper/minimap-core';
export {
  clampViewportFrame,
  inkBarsFor,
  minimapProject,
  regionFrame,
} from '../../../paper/minimap-core';
export { usePaperDock, usePaperRegion } from '../../../paper/overlay-context';
export type { RegionView } from '../../../paper/region-view';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
