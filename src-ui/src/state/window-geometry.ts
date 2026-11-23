// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮动窗几何落盘（2026-11-23，窗口几何记忆批）。
//
// 语义：**用户拖过的几何优先**——开窗时先读本模块（localStorage），有就按它；
// 没有才轮到 manifest.app.size，最后才是 460×360。key = 插件名（窗定义的身份），
// 所以换插件版本、禁用再启用都不丢；卸载后残留一条无害（下次同名插件回来接着用）。
//
// 存储形态：`{ v: 1, windows: { [插件名]: { x, y, w, h } } }`。v 留给未来迁移
// （读到不认识的版本 = 当没有，不尝试猜）。
//
// 毒化容忍（对齐 state/plugin-prefs.ts 的纪律）：坏 JSON / 非数值 / 越界 → 该条
// 当没有；写失败（配额耗尽）warn 不炸——几何丢了只是回到缺省，不是故障。
//
// 夹持在读取时做（视口由调用点传进来）：上次关机时的分辨率/显示器未必还是现在
// 这台——**恢复的窗必须还抓得回来**（clampWindowGeometry 保书眉可达）。

import { clampWindowGeometry, type ViewportSize, type WindowGeometry } from './window-metrics';

const STORAGE_KEY = 'lantai.pluginWindowGeometry';
const SCHEMA_VERSION = 1;

interface PersistedShape {
  v: number;
  windows: Record<string, WindowGeometry>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 一条落盘记录 → 几何（坏形状 = null，不猜）。 */
function asGeometry(value: unknown): WindowGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as Record<string, unknown>;
  if (!isFiniteNumber(g.x) || !isFiniteNumber(g.y) || !isFiniteNumber(g.w) || !isFiniteNumber(g.h)) return null;
  return { x: g.x, y: g.y, w: g.w, h: g.h };
}

function readAll(): Record<string, WindowGeometry> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (!parsed || parsed.v !== SCHEMA_VERSION || !parsed.windows || typeof parsed.windows !== 'object') return {};
    const out: Record<string, WindowGeometry> = {};
    for (const [name, value] of Object.entries(parsed.windows)) {
      // 名字来自 JSON（可能被手改）：只收非空串，且挡掉原型链键。
      if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
      const geometry = asGeometry(value);
      if (geometry) out[name] = geometry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(windows: Record<string, WindowGeometry>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: PersistedShape = { v: SCHEMA_VERSION, windows };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('[plugin-window-geometry] localStorage 写入失败（配额耗尽？），几何仅本次会话生效:', e);
  }
}

/** 读一个插件的落盘几何（读时夹进当前视口——换屏/改分辨率后窗仍抓得回来）。
 *  没有记录 = null（调用点据此回落到 manifest.app.size / 缺省）。 */
export function loadWindowGeometry(pluginName: string, viewport?: ViewportSize): WindowGeometry | null {
  const geometry = readAll()[pluginName];
  return geometry ? clampWindowGeometry(geometry, viewport) : null;
}

/** 记一个插件的几何（手势结束 / 键盘微调后落一次——不在每帧写）。 */
export function saveWindowGeometry(pluginName: string, geometry: WindowGeometry): void {
  if (!pluginName) return;
  const all = readAll();
  const normalized = clampWindowGeometry(geometry);
  all[pluginName] = normalized;
  writeAll(all);
}

/** 测试复位（清 localStorage 键）。 */
export function resetWindowGeometryForTests(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
