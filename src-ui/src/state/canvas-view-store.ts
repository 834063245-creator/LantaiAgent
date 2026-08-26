// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// canvas-view-store — 画布视口共享状态（Stage-3 书脊定位器）。
//
// 背景：画布视口（pan/zoom）原为 PaperPanel 私有 local state——书脊/侧边栏
// 作为插件贡献行（DockPanel 上层覆盖）需要驱动摄像机（左键定位飞过去），
// 必须有一处跨组件共享的视口真源。本 store 是 app 级单例（画布即主界面，
// 一次只有一个纸视图——对齐 dock-store 的单例形态），PaperPanel 读写它，
// 书脊/侧边栏只读 + requestFocus。
//
// pendingFocusId：书脊/侧边栏「定位到某卷」的请求（非空 = 有在途定位）。
// PaperPanel 订阅它：目标流区已摊开则立即动画飞过去并清空；未摊开（expand
// 在途）则保持 pending，流区出现后补飞。定位请求是「到某卷的最新块」——
// 用 viewFocusRegion 把流区锚点（最新块底边）对到屏幕下缘上方。
//
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类）：进程级单例、键控自清理，
// 无跨工作区所有权问题（视口随 PaperPanel 重挂重置）。

import { create } from 'zustand';
import { identityView, type Viewport } from '../paper/canvas-math';

interface CanvasViewState {
  /** 当前视口（world→screen 变换的真源——PaperPanel 写，覆盖件读） */
  view: Viewport;
  /** 画布视口尺寸（屏幕像素；PaperPanel 挂载期 ResizeObserver 写） */
  canvasSize: { w: number; h: number };
  /** 在途定位请求（sessionId）；null = 无。 */
  pendingFocusId: string | null;
  /** 更新视口（PaperPanel 平移/缩放/动画共用）。 */
  setView: (updater: Viewport | ((v: Viewport) => Viewport)) => void;
  /** 更新画布尺寸（幂等——未变不触发订阅）。 */
  setCanvasSize: (w: number, h: number) => void;
  /** 发起/清空定位请求（书脊左键 / 侧边栏行点击）。 */
  requestFocus: (sessionId: string | null) => void;
}

export const useCanvasViewStore = create<CanvasViewState>((set) => ({
  view: identityView(),
  canvasSize: { w: 800, h: 600 },
  pendingFocusId: null,

  setView: (updater) => set((s) => ({ view: typeof updater === 'function' ? updater(s.view) : updater })),

  setCanvasSize: (w, h) => set((s) => (s.canvasSize.w === w && s.canvasSize.h === h ? s : { canvasSize: { w, h } })),

  requestFocus: (sessionId) => set((s) => (s.pendingFocusId === sessionId ? s : { pendingFocusId: sessionId })),
}));
