// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话存储 — 会话生命周期。
// 消息存于每会话 store：getMessagesStore(`${storeId}:${sessionId}`)

import { create } from 'zustand';
import { createScopedStore } from './scoped-store';

export interface ChatSessionMeta {
  id: number;
  label: string;
  /** 立卷时刻（ISO）——卷首档行「日期」的唯一真源（2026-09-16 卷首重排 B 案）。
   *  起卷 = 当场时刻；摊开磁盘卷 = 卷日志头行的 createdAt（卷本体真源，
   *  与投影缓存 savedAt「最后落盘」是两回事，不混用）。旧卷无此字段 = 档行不显日期。 */
  createdAt?: string;
}

interface SessionStore {
  sessions: ChatSessionMeta[];
  activeIdx: number;
  sessionTokens: Record<number, number>;
  nextSessionId: number;
  msgIdSeq: number;

  setSessions: (sessions: ChatSessionMeta[]) => void;
  setActiveIdx: (idx: number) => void;
  /** 改名（C8 书脊题签）：id 定位改 label——仅改内存，落盘走会话保存链。 */
  renameSession: (id: number, label: string) => void;
  setSessionTokens: (id: number, count: number) => void;
  removeSession: (id: number) => void;
  setNextSessionId: (id: number) => void;
  setMsgIdSeq: (seq: number) => void;
}

export type SessionStoreApi = ReturnType<typeof createSessionStoreImpl>;

function createSessionStoreImpl() {
  return create<SessionStore>((set) => ({
    sessions: [],
    activeIdx: -1,
    sessionTokens: {},
    nextSessionId: 1,
    msgIdSeq: 0,

    setSessions: (sessions) => set({ sessions }),
    setActiveIdx: (activeIdx) => set({ activeIdx }),
    renameSession: (id, label) =>
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, label } : x)) })),
    setSessionTokens: (id, count) => set((s) => ({ sessionTokens: { ...s.sessionTokens, [id]: count } })),
    removeSession: (id) =>
      set((s) => {
        const { [id]: _, ...restTokens } = s.sessionTokens;
        return { sessionTokens: restTokens };
      }),
    setNextSessionId: (nextSessionId) => set({ nextSessionId }),
    setMsgIdSeq: (msgIdSeq) => set({ msgIdSeq }),
  }));
}

// ── 每面板注册表 ──

const scoped = createScopedStore('__lantai_session_stores__', createSessionStoreImpl);

export const getSessionStore = scoped.getStore;

/** 从注册表中移除面板的会话 store。
 *  （2026-08-04：生产暂未接线，但有单元测试保护 — disposePanelStores 的组成部分） */
export function disposeSessionStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

// ── 非响应式访问器 ──
// （2026-08-04 清理：getSessions/getActiveIdx/getActiveSessionId/getSessionTokens/
//   getMsgIdSeq 全工程零调用，已删；nextMsgId/getNextSessionId 在用，保留）

export function nextMsgId(storeId?: string): string {
  const store = getSessionStore(storeId);
  const st = store.getState();
  const id = st.msgIdSeq + 1;
  store.setState({ msgIdSeq: id });
  return `m${id}`;
}
