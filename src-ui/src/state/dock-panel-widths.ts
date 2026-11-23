// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 壳面板宽度落盘（2026-11-23，窗口几何记忆批）——与 state/window-geometry.ts
// 同形态：localStorage、按 id 记、坏数据当没有、写失败 warn 不炸。
//
// 为什么落盘（而不是只记在 dock-store 里）：窗口宽度是家具的手感，用户拖完
// 重启回来还是那个宽度才算「记住了」——side bar 的宽度若干年前就是这么做的
// （canvas-nav/SessionSidebar 的 WIDTH_KEY）。本模块只管持久化；夹持（视口相关）
// 归 DockSlot 的 render 与手势（那里才知道视口）。

const STORAGE_KEY = 'lantai.dockPanelWidths';
const SCHEMA_VERSION = 1;
/** 落盘前的粗围栏（视口相关的精确夹持在 DockSlot 里算；这里只挡 0/负数/NaN）。 */
const WIDTH_FLOOR = 120;
const WIDTH_CEIL = 4000;

interface PersistedShape {
  v: number;
  widths: Record<string, number>;
}

function asWidth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(WIDTH_CEIL, Math.max(WIDTH_FLOOR, value)));
}

/** 读全部面板宽度（启动时由 dock-store 灌一次；坏数据/坏版本 = 空表）。 */
export function loadPanelWidths(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (!parsed || parsed.v !== SCHEMA_VERSION || !parsed.widths || typeof parsed.widths !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed.widths)) {
      if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      const width = asWidth(value);
      if (width !== null) out[id] = width;
    }
    return out;
  } catch {
    return {};
  }
}

/** 记一个面板的宽度（拖拽结束 / 键盘微调后落一次）。 */
export function savePanelWidth(panelId: string, width: number): void {
  if (!panelId) return;
  if (typeof localStorage === 'undefined') return;
  const all = loadPanelWidths();
  const normalized = asWidth(width);
  if (normalized === null) return;
  all[panelId] = normalized;
  try {
    const payload: PersistedShape = { v: SCHEMA_VERSION, widths: all };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('[dock-panel-widths] localStorage 写入失败（配额耗尽？），宽度仅本次会话生效:', e);
  }
}

/** 测试复位（清 localStorage 键）。 */
export function resetPanelWidthsForTests(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
