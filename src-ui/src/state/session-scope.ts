// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话作用域（L1 数据上下文的前端投影锚）。
//
// 活跃会话 id 是「当前工作区」UI 投影的推导源（DSH 铁律 5：运行时锚点 =
// 会话，工作区是派生投影）。chat-core 在活跃会话切换时 setCurrentSessionId；
// agentInvoke 读它给引擎命令注入 _session_id（Rust 决议链：会话 → 焦点 →
// 单槽）。vanilla zustand（无 React 绑定）——消费方是命令层不是组件，
// 与 workspace-scope.ts 的 scopeStore 同款形态。

import { createStore } from 'zustand/vanilla';

interface SessionScopeState {
  /** 活跃（焦点）会话 id；null = 无活跃会话（占位/冷启动）。 */
  currentSessionId: number | null;
  setCurrentSessionId: (id: number | null) => void;
}

export const sessionScopeStore = createStore<SessionScopeState>((set) => ({
  currentSessionId: null,
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));

/** 当前活跃会话 id（agentInvoke 注入 _session_id 用）。 */
export function currentSessionId(): number | null {
  return sessionScopeStore.getState().currentSessionId;
}
