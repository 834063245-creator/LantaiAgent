// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 壳运行时句柄（S2-3 实例化）— main.ts 模块级单例的归宿。
//
// 定位（S2 设计件 §2.6）：ShellRefs 是应用级单例句柄集合（chatPanel /
// workspace / 状态机），不是面板业务状态——非响应式 imperative 句柄，
// 不进 zustand、不触 INVARIANTS #1。
//
// V5 拆除（2026-08-22）：starGraph / agentViz / graphEl / FileViewer 惰性
// 句柄随旧观测台退役——星图不再渲染，图谱数据面走 workspace.graphData
// （后台预热）服务 Agent 工具。starGraph 字段保留为恒 null 的兼容面：
// workspace 流与 chat-core 的类型/判空消费点先收敛，后续 C 段清理。
//
// 可空性契约：chatPanel 构造于 chat 行、其后恒非空；workspace 在无活动
// 工作区时为 null。壳行代码沿用判空纪律——不假设前行必然成功（失败隔离：
// 单行 boot 抛错不炸整个引导，后续行对缺帐句柄优雅降级）。

import type { ChatCore } from '../app/chat/chat-core';
import { useShellStore } from '../app/shell-store';
import { WorkspaceStateMachine } from '../lifecycle/state-machine';
import type { Workspace } from '../workspace';

/** 壳引导期共享句柄集合 — 壳行 boot(refs) 的唯一入参。 */
export interface ShellRefs {
  /** V5 后恒 null（兼容面——星图已退役，见头注）。 */
  starGraph: null;
  chatPanel: ChatCore | null;
  workspace: Workspace | null;
  wsMachine: WorkspaceStateMachine;
}

// ── refs 单例（app 级唯一；状态机构造无副作用）──
export const shellRefs: ShellRefs = {
  starGraph: null,
  chatPanel: null,
  workspace: null,
  wsMachine: new WorkspaceStateMachine(),
};

// ── 状态条目辅助（状态日志环在 shell-store；V5 后状态栏退役，
//    日志保留为 pushStatus 的承接面——工作区流仍大量调用）──
export function pushStatus(msg: string): void {
  useShellStore.getState().pushStatus(msg);
}

export function setLoading(active: boolean, folder?: string): void {
  useShellStore.getState().setAnalyzing(active ? 'open' : null);
  if (active) pushStatus(`正在分析 ${folder || ''}...`);
}
