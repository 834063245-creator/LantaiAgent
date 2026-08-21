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

/** 星图统计 — 由 StarGraph.updateStatus 写入（V5 后无写入方；保留结构
 *  供后续图数据面板复用，graphStats 恒 null）。 */
export interface GraphStats {
  nodes: number;
  edges: number;
  /** structural / data / temporal 边计数 */
  s: number;
  d: number;
  t: number;
  /** L3 / L4 耦合信号（>0 时显示徽标） */
  l3: number;
  l4: number;
  /** 折叠模式下的星座数（0 = 非折叠） */
  galaxies: number;
}

export type AnalyzingKind = 'open' | 'reanalyze' | null;

interface ShellState {
  /** 当前工作区路径（空 = 未打开） */
  projectPath: string;
  /** 状态栏左侧文本 */
  statusText: string;
  /** 状态日志（环形，上限 15；id 单调递增供 React key 使用） */
  statusLog: Array<{ id: number; msg: string }>;
  /** 星图统计（V5 后无写入方，恒 null） */
  graphStats: GraphStats | null;
  /** 简报违规徽标数（0 = 无） */
  violations: number;
  /** 分析进行中（打开=open / 重分析=reanalyze） */
  analyzing: AnalyzingKind;
  paletteOpen: boolean;

  /** 写状态文本并压入日志环 */
  pushStatus: (msg: string) => void;
  /** 仅写状态文本（不进日志） */
  setStatusText: (msg: string) => void;
  setProjectPath: (p: string) => void;
  setGraphStats: (g: GraphStats) => void;
  setViolations: (n: number) => void;
  setAnalyzing: (k: AnalyzingKind) => void;
  setPaletteOpen: (b: boolean) => void;
}

const STATUS_LOG_MAX = 15;
let _logSeq = 0;

export const useShellStore = create<ShellState>((set) => ({
  projectPath: '',
  statusText: '就绪',
  statusLog: [],
  graphStats: null,
  violations: 0,
  analyzing: null,
  paletteOpen: false,

  pushStatus: (msg) =>
    set((st) => ({
      statusText: msg,
      statusLog: [...st.statusLog, { id: ++_logSeq, msg }].slice(-STATUS_LOG_MAX),
    })),
  setStatusText: (msg) => set({ statusText: msg }),
  setProjectPath: (p) => set({ projectPath: p }),
  setGraphStats: (g) => set({ graphStats: g }),
  setViolations: (n) => set({ violations: n }),
  setAnalyzing: (k) => set({ analyzing: k }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),
}));
