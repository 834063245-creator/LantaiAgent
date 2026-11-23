// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮动窗几何的单点真源（2026-11-23，窗口可调尺寸批）。
//
// 谁消费：plugin-window-store（缺省尺寸 / manifest 声明尺寸的夹持）/
// PluginWindowFrame（拖拽、键盘、落盘前的夹持）/ window-facility（落盘几何恢复）。
// 上下界住在 `plugins/types.ts`（manifest.app.size 是契约面，尺寸围栏必须随
// 契约文件走指纹）——本模块只从那里取值，任何地方不得再写 460/360/320/240 字面量。
//
// 夹持是纯函数（不读 window）：视口由调用点传进来——store 层保持可测，
// 组件/设施层在浏览器里量内联尺寸。

import { APP_WINDOW_SIZE_MAX, APP_WINDOW_SIZE_MIN } from './types';

/** 缺省尺寸（px）：manifest.app.size 未声明时的起手值（一张「便签」量）。 */
export const PLUGIN_WINDOW_DEFAULT_W = 460;
export const PLUGIN_WINDOW_DEFAULT_H = 360;

/** 尺寸上下界（= `manifest.app.size` 的围栏，单一真源在 types.ts）。 */
export const PLUGIN_WINDOW_MIN_W = APP_WINDOW_SIZE_MIN.w;
export const PLUGIN_WINDOW_MIN_H = APP_WINDOW_SIZE_MIN.h;
export const PLUGIN_WINDOW_MAX_W = APP_WINDOW_SIZE_MAX.w;
export const PLUGIN_WINDOW_MAX_H = APP_WINDOW_SIZE_MAX.h;

/** 视口护栏：窗与视口边缘留 24px（与 plugin-windows.css 的 max-width/max-height 同值）。 */
export const PLUGIN_WINDOW_VIEWPORT_MARGIN = 24;

/** 拖动/恢复时书眉至少要露出的宽高（px）——窗可以挂出屏幕，但得抓得回来。 */
export const PLUGIN_WINDOW_MIN_VISIBLE_W = 120;
export const PLUGIN_WINDOW_MIN_VISIBLE_H = 48;

export interface WindowSize {
  w: number;
  h: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowGeometry extends WindowPosition, WindowSize {}

export interface ViewportSize {
  w: number;
  h: number;
}

/** 尺寸夹持：最小 320×240、最大 2400×1600；给视口时再夹到「视口减 24」
 *  （视口小于下限时保下限——宁可挂出去一点，也不能把窗挤没）。 */
export function clampWindowSize(w: number, h: number, viewport?: ViewportSize): WindowSize {
  const maxW = viewport
    ? Math.min(PLUGIN_WINDOW_MAX_W, viewport.w - PLUGIN_WINDOW_VIEWPORT_MARGIN)
    : PLUGIN_WINDOW_MAX_W;
  const maxH = viewport
    ? Math.min(PLUGIN_WINDOW_MAX_H, viewport.h - PLUGIN_WINDOW_VIEWPORT_MARGIN)
    : PLUGIN_WINDOW_MAX_H;
  return {
    w: Math.round(Math.min(Math.max(PLUGIN_WINDOW_MIN_W, w), Math.max(PLUGIN_WINDOW_MIN_W, maxW))),
    h: Math.round(Math.min(Math.max(PLUGIN_WINDOW_MIN_H, h), Math.max(PLUGIN_WINDOW_MIN_H, maxH))),
  };
}

/** 位置夹持：书眉恒可达（x ∈ [0, 视口宽-120]、y ∈ [0, 视口高-48]）。
 *  视口未知（store/测试）时原样取整——不替调用点凭空夹一个视口。 */
export function clampWindowPosition(x: number, y: number, viewport?: ViewportSize): WindowPosition {
  if (!viewport) return { x: Math.round(x), y: Math.round(y) };
  const maxX = Math.max(0, viewport.w - PLUGIN_WINDOW_MIN_VISIBLE_W);
  const maxY = Math.max(0, viewport.h - PLUGIN_WINDOW_MIN_VISIBLE_H);
  return {
    x: Math.round(Math.min(Math.max(0, x), maxX)),
    y: Math.round(Math.min(Math.max(0, y), maxY)),
  };
}

/** 一次夹全（恢复落盘几何 / manifest 声明尺寸时用）。 */
export function clampWindowGeometry(geometry: WindowGeometry, viewport?: ViewportSize): WindowGeometry {
  const size = clampWindowSize(geometry.w, geometry.h, viewport);
  const position = clampWindowPosition(geometry.x, geometry.y, viewport);
  return { ...position, ...size };
}
