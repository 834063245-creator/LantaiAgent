// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳运行时句柄（S2-3 实例化）— main.ts 模块级单例的归宿。
//
// 定位（S2 设计件 §2.6）：ShellRefs 是应用级单例句柄集合（starGraph /
// chatPanel / workspace / 状态机 / agentViz），不是面板业务状态——非响应式
// imperative 句柄，不进 zustand、不触 INVARIANTS #1（对齐 app/shell-store
// 的 app 级单例先例，但本件连 store 都不是：纯 TypeScript 对象，壳行
// boot 的唯一入参）。
//
// 可空性契约（行序即构造序）：starGraph 在 WebGL2 不可用时为 null（兜底
// 提示层保住 React 壳）；chatPanel 构造于行 3、其后恒非空；workspace 在
// 无活动工作区时为 null；agentViz 构造于行 2（依赖 starGraph）。壳行代码
// 沿用 main.ts 现状判空纪律——不假设前行必然成功（失败隔离：单行 boot
// 抛错不炸整个引导，后续行对缺帐句柄优雅降级）。
//
// FileViewer 惰性句柄（Monaco ~5MB 不进首屏 bundle）：模块级缓存，
// loadFileViewer 动态 import 后 FV() 取实例——nav 行 / workspace 流 /
// Esc 分层共用。

import type { ChatCore } from '../app/chat/chat-core';
import { useShellStore } from '../app/shell-store';
import { WorkspaceStateMachine } from '../lifecycle/state-machine';
import type { StarGraph } from '../scene/graph';
import type { AgentVisualizer } from '../ui/agent-visualizer';
import type { Workspace } from '../workspace';

/** 壳引导期共享句柄集合 — 壳行 boot(refs) 的唯一入参。 */
export interface ShellRefs {
  starGraph: StarGraph | null;
  chatPanel: ChatCore | null;
  workspace: Workspace | null;
  agentViz: AgentVisualizer | null;
  wsMachine: WorkspaceStateMachine;
}

// ── DOM 句柄（index.html 静态节点；模块级立即解析，与 main.ts 原时机一致）──
export const graphEl = document.getElementById('graph')!;

// ── refs 单例（app 级唯一；状态机构造无副作用）──
export const shellRefs: ShellRefs = {
  starGraph: null,
  chatPanel: null,
  workspace: null,
  agentViz: null,
  wsMachine: new WorkspaceStateMachine(),
};

// ── 状态条目辅助（P1：DOM 状态栏已移除，日志环在 shell-store）──
export function pushStatus(msg: string): void {
  useShellStore.getState().pushStatus(msg);
}

export function setLoading(active: boolean, folder?: string): void {
  useShellStore.getState().setAnalyzing(active ? 'open' : null);
  if (active) pushStatus(`正在分析 ${folder || ''}...`);
}

// ── FileViewer 惰性句柄（Monaco 不进初始 bundle）──
let _FileViewer: typeof import('../ui/file-viewer')['FileViewer'] | null = null;

export async function loadFileViewer(): Promise<void> {
  if (!_FileViewer) {
    const mod = await import('../ui/file-viewer');
    _FileViewer = mod.FileViewer;
  }
}

export function FV(): typeof import('../ui/file-viewer')['FileViewer'] | null {
  return _FileViewer;
}
