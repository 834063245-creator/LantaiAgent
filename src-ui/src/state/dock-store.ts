// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// dock-store — dock 面板开合状态的单一事实源（P3）。
// 替代旧 AppShell 的 isOpen 探针 + syncPanels 快照链，以及各 Controller 的私有 _open。
// 面板组件订阅本 store 渲染；main.ts / workspace.ts 经 getState() 写入。
//
// C14 收缩（2026-08-22）：初始表从旧观测台七键收缩为两个活键——
// settings（常量面）+ paper（组合层贡献）。check/constraints/dataflow/
// agents/tasks 五键随 V5 拆除退役（面板组件已删，写入无挂载面）。
// open 面向 string 开集（S1-5），插件面板键动态写入不进初始表。
// （简报 checkResult 状态随图谱全量退役删除，2026-09-09——run_check 属
//  图数据面，无生产写入方与消费面。）

import { create } from 'zustand';

/** 面板 id——S1-5 起从闭集 union 迁移为 string（composition 架构：外部插件
 *  可贡献面板）；合法 id 清单的运行时校验在 app/panels/panel-def（装载期
 *  自检 id 唯一 + 组件完备），本 store 保持纯状态层不依赖面板清单。 */
export type DockPanelId = string;

interface DockState {
  /** 面板开合（dataflow/settings 由 DockPanel 条件挂载；其余常驻 + class 切换保过渡动画）。
   *  key 面向 string 开集（S1-5）——未注册 id 的静默写入由 panel-def 装载期
   *  校验 + 消费面字面量纪律守住，store 不做调用点校验。 */
  open: Record<string, boolean>;

  /** 关闭守卫（2026-08 UI 大清扫）：面板注册（典型：SettingsPanel 的 dirty 拦截）。
   *  closePanel/togglePanel 的关闭路径先问守卫——false = 拦截（面板自弹确认）。
   *  面板确认后的强关 = 先 unregisterCloseGuard 再 closePanel（守卫已摘，直通）。 */
  closeGuards: Record<string, (() => boolean) | undefined>;
  registerCloseGuard: (id: DockPanelId, guard: () => boolean) => void;
  unregisterCloseGuard: (id: DockPanelId) => void;

  openPanel: (id: DockPanelId) => void;
  closePanel: (id: DockPanelId) => void;
  togglePanel: (id: DockPanelId) => void;
  isOpen: (id: DockPanelId) => boolean;
}

export const useDockStore = create<DockState>((set, get) => ({
  open: {
    settings: false,
    paper: false,
  },
  closeGuards: {},

  registerCloseGuard: (id, guard) => set((st) => ({ closeGuards: { ...st.closeGuards, [id]: guard } })),
  unregisterCloseGuard: (id) =>
    set((st) => {
      if (!(id in st.closeGuards)) return {};
      const { [id]: _dropped, ...rest } = st.closeGuards;
      return { closeGuards: rest };
    }),

  openPanel: (id) => set((st) => ({ open: { ...st.open, [id]: true } })),
  closePanel: (id) => {
    // 关闭守卫：面板注册了守卫且守卫拒绝（自证弹确认中）→ 拦截本次关闭。
    // 强关路径 = 面板先 unregisterCloseGuard 再 closePanel。
    const guard = get().closeGuards[id];
    if (guard && !guard()) return;
    set((st) => ({ open: { ...st.open, [id]: false } }));
  },
  togglePanel: (id) => {
    const st = get();
    if (st.open[id]) {
      st.closePanel(id); // 关闭路径走守卫
    } else {
      st.openPanel(id);
    }
  },
  isOpen: (id) => get().open[id],
}));
