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
import {
  clampWindowSize,
  PLUGIN_WINDOW_DEFAULT_H,
  PLUGIN_WINDOW_DEFAULT_W,
  type WindowGeometry,
  type WindowSize,
} from '../plugins/window-metrics';

/** 窗口定义（manifest.app 折算——装载期登记；kind/mode/title 已归一）。 */
export interface PluginWindowDef {
  pluginName: string;
  /** 窗内容入口 URL（装载期解析：资产形态 = 资产 origin + 插件名 + app.entry；
   *  远端形态 = app.url 原样——视口 iframe 的 src）。 */
  entryUrl: string;
  /** 入口形态（2026-09-13，app 入口二态）：
   *    · `asset`——插件自包含 HTML（资产通道）；iframe opaque origin，宿主桥是
   *      它唯一的能力通道；
   *    · `remote`——环回远端页（app.url）；iframe 给 allow-same-origin（跨源
   *      文档保住自己 origin 以便同源 SSE/fetch），**不绑宿主桥**。
   *  帧据此选 sandbox 与桥绑定策略——判定单一真源在本字段，不在渲染处重推。 */
  kind: 'asset' | 'remote';
  mode: PluginWindowMode;
  title: string;
  /** 文档通道（manifest.app.documents 折算，批 1 只读）：true 才允许开窗带文档
   *  载荷、桥面才解析 `doc.read`。判定单一真源在本字段（渲染处不重推）。 */
  documents: boolean;
  /** manifest.app.size 折算的首选初始尺寸（v75）——**只在用户没拖过时**生效；
   *  用户拖过的几何由 window-facility 从 localStorage 恢复并优先传进来。 */
  size?: WindowSize;
}

/** 开着窗口实例（iframe 视口渲染源）。 */
export interface PluginWindowInstance {
  windowId: string;
  pluginName: string;
  mode: PluginWindowMode;
  /** 浮动窗位置（dock/fullscreen 模式忽略；拖拽经 moveWindow 写回）。 */
  x: number;
  y: number;
  /** 浮动窗尺寸（px；dock/fullscreen 模式忽略；拖右下角握把经 resizeWindow 写回）。
   *  **尺寸归用户**：窗口是 iframe 视口，软件内容形态千差万别，写死一个宽高
   *  等于替所有插件决定「一页纸多大」。 */
  w: number;
  h: number;
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
   *  真开新窗 → opened=true（v1 每插件单窗）。
   *
   *  `seed` = 起手几何（用户落盘过的几何 / manifest 声明尺寸由 window-facility
   *  夹好传进来）；缺 x/y 走瀑布级联，缺 w/h 取 manifest 声明，再缺省 460×360。
   *  本 store 保持纯状态层：不读 window、不读 localStorage。 */
  openWindow: (pluginName: string, seed?: Partial<WindowGeometry>) => OpenWindowResult | null;
  /** 关窗：返回所属插件名（调用方据此通知治理器），未开 → null。 */
  closeWindow: (windowId: string) => string | null;
  /** 聚焦：海拔置顶（未开 = no-op）。 */
  focusWindow: (windowId: string) => void;
  /** 三模式切换（floating/dock/fullscreen）。 */
  setWindowMode: (windowId: string, mode: PluginWindowMode) => void;
  /** 浮动窗拖拽写回位置。 */
  moveWindow: (windowId: string, x: number, y: number) => void;
  /** 浮动窗尺寸写回（右下角握把 / 键盘微调）。夹持在调用点——本 store 是纯状态
   *  层，不读 window（与 moveWindow 同一条纪律）。 */
  resizeWindow: (windowId: string, w: number, h: number) => void;
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

  openWindow: (pluginName, seed) => {
    const st = get();
    const existing = st.windows.find((w) => w.pluginName === pluginName);
    if (existing) {
      get().focusWindow(existing.windowId);
      return { windowId: existing.windowId, opened: false };
    }
    const def = st.defs[pluginName];
    if (!def) return null;
    const windowId = `${pluginName}#${++st.seq}`;
    const cascade = cascadePosition(st.windows.length);
    const size = clampWindowSize(
      seed?.w ?? def.size?.w ?? PLUGIN_WINDOW_DEFAULT_W,
      seed?.h ?? def.size?.h ?? PLUGIN_WINDOW_DEFAULT_H,
    );
    const instance: PluginWindowInstance = {
      windowId,
      pluginName,
      mode: def.mode,
      x: Math.round(seed?.x ?? cascade.x),
      y: Math.round(seed?.y ?? cascade.y),
      w: size.w,
      h: size.h,
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

  resizeWindow: (windowId, width, height) =>
    set((st) => ({
      windows: st.windows.map((w) => (w.windowId === windowId ? { ...w, w: width, h: height } : w)),
    })),

  resetPluginWindowsForTests: () => set({ defs: {}, windows: [], seq: 0, zTop: 1 }),
}));
