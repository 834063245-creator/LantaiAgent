// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugin-window-store — 插件应用窗口注册表（app shell 四件套 · 件 A，S3）。
// app 级单例 store（CONVENTIONS §1.2，对齐 dock-store 形态）。
//
// 两层状态：
//   - defs    ：manifest.app 声明折算的窗口定义（数据——装载期登记，
//               卸载注销；启动器/设施 API 的寻址源）；
//   - windows ：开着窗口实例（iframe 视口的渲染源——PluginWindowsHost 订阅）。
//
// 分层铁律：本 store 是纯状态层——受治进程联动（notifyPluginWindowOpened/
// Closed，mcp-bridge 治理器的窗口计数闸）不在 store 里做，由 plugins/
// window-facility.ts 包装层调用（plugins → state 是既定方向，反向禁止）。
//
// v1 寻址策略（计划 §5-S3「按插件 id 与 role 寻址」的 v1 收缩）：每插件
// 单窗——openWindow 对已开窗插件聚焦已有窗（软件 = 一扇窗；多窗计数机制
// 在治理器侧保留，多窗形态是设施面的未来扩展位）。

import { create } from 'zustand';
import type { PluginWindowMode } from '../plugins/types';

/** 窗口定义（manifest.app 折算——装载期登记；mode/title 已归一）。 */
export interface PluginWindowDef {
  pluginName: string;
  /** 窗内容入口 URL（装载期解析：资产 origin + 插件名 + app.entry——
   *  视口 iframe 的 src，插件自包含 HTML）。 */
  entryUrl: string;
  mode: PluginWindowMode;
  title: string;
}

/** 开着窗口实例（iframe 视口渲染源）。 */
export interface PluginWindowInstance {
  windowId: string;
  pluginName: string;
  mode: PluginWindowMode;
  /** 浮动窗位置（dock/fullscreen 模式忽略；拖拽经 moveWindow 写回）。 */
  x: number;
  y: number;
  /** 焦点海拔（单调递增——最后触碰的窗在最上；store 持计数器）。 */
  z: number;
}

/** openWindow 结果：windowId + 是否真开了新窗（聚焦已有窗 = false——
 *  设施层据此只在真开窗时通知治理器，窗口计数与真实开窗恒等）。 */
export interface OpenWindowResult {
  windowId: string;
  opened: boolean;
}

interface PluginWindowState {
  /** 窗口定义（key = 插件名；装载登记 / 卸载注销——loader 包装层调用）。 */
  defs: Record<string, PluginWindowDef>;
  /** 开着窗口实例表。 */
  windows: PluginWindowInstance[];
  /** windowId 代次计数器（`<插件名>#<n>`——关窗不复用，重开换代。 */
  seq: number;
  /** 焦点海拔计数器（单调递增）。 */
  zTop: number;

  /** 装载期登记窗口定义（重装载路径直接覆盖）。 */
  registerAppDef: (def: PluginWindowDef) => void;
  /** 卸载注销：摘定义 + 关掉该插件全部开窗。返回被关掉的实例
   *  （调用方 window-facility 据此逐窗通知治理器关窗事件）。 */
  unregisterAppDef: (pluginName: string) => PluginWindowInstance[];
  /** 开窗：无定义 → null；已有该插件开窗 → 聚焦已有窗（opened=false）；
   *  真开新窗 → opened=true（v1 每插件单窗）。 */
  openWindow: (pluginName: string) => OpenWindowResult | null;
  /** 关窗：返回所属插件名（调用方据此通知治理器），未开 → null。 */
  closeWindow: (windowId: string) => string | null;
  /** 聚焦：海拔置顶（未开 = no-op）。 */
  focusWindow: (windowId: string) => void;
  /** 三模式切换（floating/dock/fullscreen）。 */
  setWindowMode: (windowId: string, mode: PluginWindowMode) => void;
  /** 浮动窗拖拽写回位置。 */
  moveWindow: (windowId: string, x: number, y: number) => void;
  /** 测试复位（vitest 同 worker 模块态跨用例共享——防串味）。 */
  resetPluginWindowsForTests: () => void;
}

/** 浮动窗缺省位置：瀑布级联（每窗右下错位一格，环回防出屏）。 */
function cascadePosition(index: number): { x: number; y: number } {
  const step = index % 6;
  return { x: 96 + step * 36, y: 72 + step * 30 };
}

export const usePluginWindowStore = create<PluginWindowState>((set, get) => ({
  defs: {},
  windows: [],
  seq: 0,
  zTop: 1,

  registerAppDef: (def) => set((st) => ({ defs: { ...st.defs, [def.pluginName]: def } })),

  unregisterAppDef: (pluginName) => {
    const st = get();
    const closed = st.windows.filter((w) => w.pluginName === pluginName);
    if (closed.length === 0 && !(pluginName in st.defs)) return [];
    const { [pluginName]: _dropped, ...restDefs } = st.defs;
    set({ defs: restDefs, windows: st.windows.filter((w) => w.pluginName !== pluginName) });
    return closed;
  },

  openWindow: (pluginName) => {
    const st = get();
    const existing = st.windows.find((w) => w.pluginName === pluginName);
    if (existing) {
      get().focusWindow(existing.windowId);
      return { windowId: existing.windowId, opened: false };
    }
    const def = st.defs[pluginName];
    if (!def) return null;
    const windowId = `${pluginName}#${++st.seq}`;
    const { x, y } = cascadePosition(st.windows.length);
    const instance: PluginWindowInstance = {
      windowId,
      pluginName,
      mode: def.mode,
      x,
      y,
      z: ++st.zTop,
    };
    set({ windows: [...st.windows, instance] });
    return { windowId, opened: true };
  },

  closeWindow: (windowId) => {
    const st = get();
    const target = st.windows.find((w) => w.windowId === windowId);
    if (!target) return null;
    set({ windows: st.windows.filter((w) => w.windowId !== windowId) });
    return target.pluginName;
  },

  focusWindow: (windowId) =>
    set((st) => ({
      windows: st.windows.map((w) => (w.windowId === windowId ? { ...w, z: st.zTop + 1 } : w)),
      zTop: st.zTop + 1,
    })),

  setWindowMode: (windowId, mode) =>
    set((st) => ({ windows: st.windows.map((w) => (w.windowId === windowId ? { ...w, mode } : w)) })),

  moveWindow: (windowId, x, y) =>
    set((st) => ({
      windows: st.windows.map((w) => (w.windowId === windowId ? { ...w, x, y } : w)),
    })),

  resetPluginWindowsForTests: () => set({ defs: {}, windows: [], seq: 0, zTop: 1 }),
}));
