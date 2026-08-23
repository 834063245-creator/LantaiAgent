// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-store — 纸壳用户层状态（钉住块 + 纸条），按会话隔离。
//
// 收尾 2026-08-24：从 PaperPanel 的 useState/useRef 迁入 zustand store，
// 与会话快照持久化配合（chat-session.ts 保存/恢复）。
//
// 设计：
//   - 按 panelId 作用域（createScopedStore），每面板自己一套 sessions
//   - 每 session 有 pinned（块 id → 坐标）和 strips（纸条数组）
//   - setActiveSession 切换当前活跃会话，组件响应式订阅
//   - 非响应式读取（chat-session 保存路径）：getPaperStore(storeId).getState()
//   - 每面板的 store 实例在 panel 注销时连同 session 数据一起消亡

import { create } from 'zustand';
import type { PaperStrip } from '../paper/selection';
import { createScopedStore } from './scoped-store';

// ── 类型 ──

export interface PaperPinnedState {
  [blockId: string]: { x: number; y: number };
}

export interface PaperSessionState {
  pinned: PaperPinnedState;
  strips: PaperStrip[];
}

/** 稳定空引用——缺失会话的 getPinned/getStrips 返回同一对象，避免无谓重渲染。 */
const EMPTY_PINNED: PaperPinnedState = {};
const EMPTY_STRIPS: PaperStrip[] = [];

/** 会话快照中的持久化形状（与 PaperSessionState 同构）。 */
export interface PaperSessionData {
  pinned?: PaperPinnedState;
  strips?: PaperStrip[];
}

export interface PaperStore {
  /** key = sessionId (string)，每会话独立数据 */
  sessions: Record<string, PaperSessionState>;
  /** 当前活跃会话 id（用于组件响应式订阅） */
  activeSessionId: string | null;

  /** 切换活跃会话 */
  setActiveSession: (sessionId: string | null) => void;

  /** 获取当前会话的 pinned 快照（Record，非响应式） */
  getPinned: (sessionId: string) => PaperPinnedState;
  /** 获取当前会话的 strips 快照 */
  getStrips: (sessionId: string) => PaperStrip[];

  /** 设置/移除一条钉住记录（pos === null 表示收回） */
  setPinned: (sessionId: string, blockId: string, pos: { x: number; y: number } | null) => void;
  /** 拖动中更新 pinned 坐标 */
  movePinned: (sessionId: string, blockId: string, x: number, y: number) => void;
  /** 批量替换 pinned（从持久化恢复） */
  replacePinned: (sessionId: string, pinned: PaperPinnedState) => void;

  /** 添加纸条 */
  addStrip: (sessionId: string, strip: PaperStrip) => void;
  /** 拖动纸条 */
  moveStrip: (sessionId: string, stripId: string, x: number, y: number) => void;
  /** 删除纸条 */
  removeStrip: (sessionId: string, stripId: string) => void;
  /** 批量替换 strips（从持久化恢复） */
  replaceStrips: (sessionId: string, strips: PaperStrip[]) => void;

  /** 从磁盘恢复整个 session 的 paper 数据 */
  loadPaperSession: (sessionId: string, data: PaperSessionData | null) => void;
  /** 移除整个 session 的 paper 数据（关闭会话时） */
  removePaperSession: (sessionId: string) => void;
  /** 清空全部会话数据（切换工作区全量重置时） */
  clearSessions: () => void;
}

// ── 创建 store 实现 ──

function createPaperStoreImpl() {
  return create<PaperStore>((set, get) => ({
    sessions: {},
    activeSessionId: null,

    setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

    getPinned: (sessionId) => get().sessions[sessionId]?.pinned ?? EMPTY_PINNED,
    getStrips: (sessionId) => get().sessions[sessionId]?.strips ?? EMPTY_STRIPS,

    setPinned: (sessionId, blockId, pos) =>
      set((s) => {
        // 惰性创建：新卷首次钉块时 sessions 尚无条目——静默丢弃 = 钉住丢失
        const prev = s.sessions[sessionId] ?? { pinned: {}, strips: [] };
        const pinned = { ...prev.pinned };
        if (pos === null) {
          delete pinned[blockId];
        } else {
          pinned[blockId] = pos;
        }
        return {
          sessions: { ...s.sessions, [sessionId]: { ...prev, pinned } },
        };
      }),

    movePinned: (sessionId, blockId, x, y) =>
      set((s) => {
        const prev = s.sessions[sessionId];
        if (!prev?.pinned[blockId]) return s;
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...prev, pinned: { ...prev.pinned, [blockId]: { x, y } } },
          },
        };
      }),

    replacePinned: (sessionId, pinned) =>
      set((s) => {
        const prev = s.sessions[sessionId] ?? { pinned: {}, strips: [] };
        return {
          sessions: { ...s.sessions, [sessionId]: { ...prev, pinned } },
        };
      }),

    addStrip: (sessionId, strip) =>
      set((s) => {
        // 惰性创建：新卷首次抽纸条时 sessions 尚无条目
        const prev = s.sessions[sessionId] ?? { pinned: {}, strips: [] };
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...prev, strips: [...prev.strips, strip] },
          },
        };
      }),

    moveStrip: (sessionId, stripId, x, y) =>
      set((s) => {
        const prev = s.sessions[sessionId];
        if (!prev) return s;
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...prev,
              strips: prev.strips.map((st) => (st.id === stripId ? { ...st, x, y } : st)),
            },
          },
        };
      }),

    removeStrip: (sessionId, stripId) =>
      set((s) => {
        const prev = s.sessions[sessionId];
        if (!prev) return s;
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...prev, strips: prev.strips.filter((st) => st.id !== stripId) },
          },
        };
      }),

    replaceStrips: (sessionId, strips) =>
      set((s) => {
        const prev = s.sessions[sessionId] ?? { pinned: {}, strips: [] };
        return {
          sessions: { ...s.sessions, [sessionId]: { ...prev, strips } },
        };
      }),

    loadPaperSession: (sessionId, data) =>
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            pinned: data?.pinned ?? {},
            strips: data?.strips ?? [],
          },
        },
      })),

    removePaperSession: (sessionId) =>
      set((s) => {
        const { [sessionId]: _, ...rest } = s.sessions;
        return { sessions: rest };
      }),

    clearSessions: () => set({ sessions: {}, activeSessionId: null }),
  }));
}

// ── 注册表 ──

const scoped = createScopedStore('__lantai_paper_stores__', createPaperStoreImpl);

export const getPaperStore = scoped.getStore;

/** 非响应式读取当前会话的 paper 数据（供 chat-session 保存路径用）。
 *  恒返回完整形状 {pinned, strips}——落盘 JSON 字段稳定，恢复路径零特判。 */
export function getPaperSessionData(storeId: string, sessionId: number): PaperSessionData {
  const st = getPaperStore(storeId).getState();
  const sid = String(sessionId);
  const sess = st.sessions[sid];
  if (!sess) return { pinned: {}, strips: [] };
  return {
    pinned: sess.pinned,
    strips: sess.strips,
  };
}

/** 非响应式写入 paper 数据（供 chat-session 恢复路径用）。 */
export function loadPaperSessionData(storeId: string, sessionId: number, data: PaperSessionData | null): void {
  const store = getPaperStore(storeId);
  store.getState().loadPaperSession(String(sessionId), data);
}

/** 清除指定 session 的 paper 数据（关闭会话时调用）。 */
export function removePaperSessionData(storeId: string, sessionId: number): void {
  const store = getPaperStore(storeId);
  store.getState().removePaperSession(String(sessionId));
}

/** 清空面板全部 paper 数据（切换工作区全量重置时调用）。 */
export function clearPaperSessions(storeId: string): void {
  const store = getPaperStore(storeId);
  store.getState().clearSessions();
}

/** 测试套件：复位。 */
export function resetPaperStoresForTests(): void {
  // 通过 window 注册表清空所有 paper store 实例
  const key = '__lantai_paper_stores__';
  const w = window as unknown as Record<string, unknown>;
  const stores = w[key] as Map<string, { setState: (s: Partial<PaperStore>) => void }> | undefined;
  if (stores) {
    for (const store of stores.values()) {
      store.setState({ sessions: {}, activeSessionId: null });
    }
  }
}
