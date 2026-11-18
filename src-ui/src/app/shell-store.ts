// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 壳状态 — 全局唯一的 zustand store。
// 旧代码（main.ts / graph.ts）通过 getState() 写入；新组件通过 hook 订阅。
// 约定（src/app/README.md）：app/** 不 import ui/events.ts。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：view 字段退役（home|graph 的
// 视图切换是旧观测台概念——纸面板开合态在 dock-store，案卷首页
// SessionsHome 常驻为基底层）；状态栏退役后 statusText/statusLog 保留为
// pushStatus 的承接面（工作区流大量调用；R5 时可接入纸壳书眉）。

import { create } from 'zustand';

export type AnalyzingKind = 'open' | 'reanalyze' | null;

interface ShellState {
  /** 当前工作区路径（空 = 未打开） */
  projectPath: string;
  /** 状态栏左侧文本 */
  statusText: string;
  /** 状态日志（环形，上限 15；id 单调递增供 React key 使用；at 记录时刻——
   *  2026-08 UI 大清扫补：翻查「什么时候说的」，向后兼容新增字段） */
  statusLog: Array<{ id: number; msg: string; at?: number }>;
  /** 简报违规徽标数（0 = 无） */
  violations: number;
  /** 分析进行中（打开=open / 重分析=reanalyze） */
  analyzing: AnalyzingKind;
  paletteOpen: boolean;
  /** 设置面板「打开到某页签」的**一次性请求**（2026-11-28 全局搜索批）。
   *  string 而非 SettingsTabId：app 层不 import 插件目录（层次纪律——插件依赖 app，
   *  反之不成立）；页签 id 的合法性由 settings-domain 自己校验（不在册 = 忽略并清）。
   *  SettingsPanel 消费即清，不做常驻态（这是请求，不是状态）。 */
  settingsTab: string | null;
  /** 快捷键总览浮层（2026-11-28「案」抽屉退役批）：入口 = 全局搜索 / runAction('shortcuts')。
   *  与 paletteOpen 同族（一个布尔 = 开/关），不挂面板栈——它是帮助页，不是工作区。 */
  helpOpen: boolean;

  /** 写状态文本并压入日志环 */
  pushStatus: (msg: string) => void;
  /** 仅写状态文本（不进日志） */
  setStatusText: (msg: string) => void;
  setProjectPath: (p: string) => void;
  setViolations: (n: number) => void;
  setAnalyzing: (k: AnalyzingKind) => void;
  setPaletteOpen: (b: boolean) => void;
  /** 请求设置面板落到某页签（消费方 = SettingsPanel，消费即清）。 */
  requestSettingsTab: (tab: string) => void;
  clearSettingsTab: () => void;
  setHelpOpen: (b: boolean) => void;
}

const STATUS_LOG_MAX = 15;
let _logSeq = 0;

export const useShellStore = create<ShellState>((set) => ({
  projectPath: '',
  statusText: '就绪',
  statusLog: [],
  violations: 0,
  analyzing: null,
  paletteOpen: false,
  settingsTab: null,
  helpOpen: false,

  pushStatus: (msg) =>
    set((st) => ({
      statusText: msg,
      statusLog: [...st.statusLog, { id: ++_logSeq, msg, at: Date.now() }].slice(-STATUS_LOG_MAX),
    })),
  setStatusText: (msg) => set({ statusText: msg }),
  setProjectPath: (p) => set({ projectPath: p }),
  setViolations: (n) => set({ violations: n }),
  setAnalyzing: (k) => set({ analyzing: k }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),
  requestSettingsTab: (tab) => set({ settingsTab: tab }),
  clearSettingsTab: () => set({ settingsTab: null }),
  setHelpOpen: (b) => set({ helpOpen: b }),
}));
