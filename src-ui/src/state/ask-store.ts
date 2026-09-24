// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-store — ask_user 工具的 UI 请求队列（P1 事件归零：替代 bus 'prompt:ask' 事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：runtime-adapter 的 BuilderDeps.onAskUser（Agent ask_user 工具触发）。
// 唯一消费者：chat-core（订阅 seq → 消费 pending → PromptShelf.showAsk → callback）。
// callback-in-store 先例：overlay-store.TranslatorSession —— pending 请求跨
// chat-core 重建存活（构造时回放）；bus 时代 emit 早于订阅即静默丢失。
//
// 并发会话（2026-08-26）：单坑 pending → 每会话队列。两卷同时 ask_user
// 互不覆盖（旧单坑：后者覆盖前者 → 前者 callback 永挂 → Agent 死等）。
// 归属解析：AskRequest.agentId（executor 注入的 _owner_id）经
// agentSessionState.sessionOfAgent 上溯到主 Agent → 所属卷；子 Agent 的
// 请求挂到父卷（用户在父卷的上下文里回答）。

import { create } from 'zustand';
import { agentSessionState } from '../agent/agent-session-state';
import type { AskUserRequest } from '../agent/tool';

/** ask_user 的一次提问请求（callback 由 agent 侧持有，答案经其回传）。
 *  单问 → string[] | null；批量 → (string[] | null)[] | null（对齐 questions）。 */
export type AskRequest = AskUserRequest;

interface AskState {
  /** 每会话待处理请求（消费即出队；seq 单调递增区分先后） */
  pendingBySession: Map<number, AskRequest[]>;
  seq: number;
  /** 取走指定会话的队首请求（无请求返回 null）。 */
  consumeAsk: (sessionId: number) => AskRequest | null;
  /** 取走任意在途请求（chat-core 重建回放：按 seq 最老优先）。 */
  consumeAnyAsk: () => AskRequest | null;
}

export const useAskStore = create<AskState>((set, get) => ({
  pendingBySession: new Map(),
  seq: 0,
  consumeAsk: (sessionId) => {
    const queue = get().pendingBySession.get(sessionId);
    if (!queue || queue.length === 0) return null;
    const [head, ...rest] = queue;
    const next = new Map(get().pendingBySession);
    if (rest.length > 0) next.set(sessionId, rest);
    else next.delete(sessionId);
    set({ pendingBySession: next });
    return head;
  },
  consumeAnyAsk: () => {
    const map = get().pendingBySession;
    // seq 最老的在途请求优先（两卷同时排队时先答先问的）
    let oldest: { sid: number; req: AskRequest } | null = null;
    for (const [sid, queue] of map) {
      const head = queue[0];
      if (head && (!oldest || head.id < oldest.req.id)) oldest = { sid, req: head };
    }
    if (!oldest) return null;
    return get().consumeAsk(oldest.sid);
  },
}));

/** 解析 ask 请求归属的卷（agentId → 主 Agent → 卷；无身份/未登记 = null
 *  → 调用方按活跃卷兜底）。子 Agent 的 _owner_id 即其自身 bus id，
 *  sessionOfAgent 未登记 → 经 parentId 上溯由调用方处理（见 runtime-adapter）。 */
export function askSessionOf(req: AskRequest): number | null {
  if (!req.agentId) return null;
  return agentSessionState.sessionOfAgent(req.agentId)?.sessionId ?? null;
}

/** 推送一次提问请求（Agent 侧 ask_user 工具调用）。 */
export function pushAsk(req: AskRequest): void {
  useAskStore.setState((s) => {
    const sid = askSessionOf(req);
    const key = sid ?? -1; // -1 = 无归属（活跃卷兜底）队列
    const queue = [...(s.pendingBySession.get(key) ?? []), req];
    const next = new Map(s.pendingBySession);
    next.set(key, queue);
    return { pendingBySession: next, seq: s.seq + 1 };
  });
}
