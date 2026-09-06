// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话/画布镜像域（paper-panel-split C1）——PaperPanel 的 store 订阅面收拢：
// sess 列表/活跃镜像、每会话消息快照、画布状态读面（useSyncExternalStore）、
// 画布变更防抖落盘。纯镜像 + 订阅，无派生几何；布局派生在 use-paper-regions。

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CanvasStore, ChatMessage } from './host';
import {
  getCanvasStore,
  getChatStore,
  msgStoreFor,
  scheduleCanvasSave,
  type useCoreStore,
  useShellStore,
} from './host';

/** 面板核类型（useCoreStore 所持 core 的非空形状）——各域 hook 的 core 入参共用。 */
export type PaperCore = NonNullable<ReturnType<typeof useCoreStore.getState>['core']>;

/** 稳定空画布——core 缺席时 useSyncExternalStore 读面（无核心面板 = 空态，方法 no-op） */
const EMPTY_CANVAS: CanvasStore = {
  spread: {},
  pins: {},
  strips: [],
  activeSessionId: null,
  deletedSessionIds: new Set(),
  getRegion: () => undefined,
  getPin: () => undefined,
  getPins: () => ({}),
  getStrips: () => [],
  setRegion: () => {},
  moveRegion: () => {},
  ensureRegion: () => {},
  removeRegion: () => {},
  setPin: () => {},
  movePin: () => {},
  resizePin: () => {},
  unpin: () => {},
  replacePins: () => {},
  addStrip: () => {},
  moveStrip: () => {},
  resizeStrip: () => {},
  removeStrip: () => {},
  replaceStrips: () => {},
  setActiveRegion: () => {},
  markSessionDeleted: () => {},
  replaceDeletedSessionIds: () => {},
  loadCanvas: () => {},
  clearCanvas: () => {},
};

/** 会话/画布镜像（paper-panel-split C1，自 PaperPanel 562-666 域内原样搬入）。
 *  一切订阅面单一 owner：sess 列表 + 活跃卷、每会话消息快照（流式只动自己
 *  流区 → 只重算该流区）、canvasState（Stage-5 工作区级唯一真相）、
 *  paperTick（画布变更 → 防抖落盘 + regions memo 显式失效信号）。 */
export function usePaperSessions(core: PaperCore | null) {
  /* ── 会话集（一纸多卷：全部摊开会话 = 全部流区）──
   * sess store 订阅：列表 + 活跃 idx（活跃流区单一权威 = sess activeIdx） */
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  useEffect(() => {
    if (!core) return;
    const sess = getChatStore(core.panelId).sess;
    const sync = () => {
      const st = sess.getState();
      setSessions(st.sessions.map((s) => ({ id: s.id, label: s.label })));
      const active = st.sessions[st.activeIdx];
      setActiveSessionId(active ? active.id : null);
    };
    sync();
    return sess.subscribe(sync);
  }, [core]);

  /* ── 每会话消息快照（流式只动自己流区的消息 → 只重算该流区）── */
  const [regionMsgs, setRegionMsgs] = useState<Record<string, { messages: readonly ChatMessage[]; tick: number }>>({});
  useEffect(() => {
    if (!core) return;
    const unsubs: Array<() => void> = [];
    for (const s of sessions) {
      const store = msgStoreFor(core.panelId, s.id);
      const sync = () => {
        const messages = store.getState().messages;
        setRegionMsgs((prev) => {
          const cur = prev[s.id];
          if (cur && cur.messages === messages) return prev; // 引用未变 = 无新内容
          return { ...prev, [s.id]: { messages, tick: (cur?.tick ?? 0) + 1 } };
        });
      };
      unsubs.push(store.subscribe(sync));
      sync();
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [core, sessions]);

  /* 会话合卷后修剪无主消息快照（防内存残留） */
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    setRegionMsgs((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const stale = keys.some((k) => !ids.has(Number(k)));
      if (!stale) return prev;
      const next = { ...prev };
      for (const k of keys) if (!ids.has(Number(k))) delete next[k];
      return next;
    });
  }, [sessions]);

  /* 活跃流区镜像：canvas-store.activeSessionId 跟随 sess activeIdx（单一权威），
   * setActiveRegion 引用短路——同值不触发订阅（不产生无谓画布保存）。 */
  useEffect(() => {
    if (!core) return;
    getCanvasStore(core.panelId)
      .getState()
      .setActiveRegion(activeSessionId != null ? String(activeSessionId) : null);
  }, [core, activeSessionId]);

  /* 画布状态响应式读面（Stage-5：state/canvas-store 工作区级唯一真相）。
   * useSyncExternalStore——zustand 原生 subscribe/getState，引用稳定
   * （pins/spread/strips 对象引用不变 = 无重渲染 + translate 缓存命中）。 */
  const canvasStoreId = core?.panelId ?? null;
  const canvasState = useSyncExternalStore<CanvasStore>(
    useCallback(
      (cb: () => void) => (canvasStoreId ? getCanvasStore(canvasStoreId).subscribe(cb) : () => {}),
      [canvasStoreId],
    ),
    useCallback(() => (canvasStoreId ? getCanvasStore(canvasStoreId).getState() : EMPTY_CANVAS), [canvasStoreId]),
  );

  /* 画布状态变更 → 防抖落盘（工作区画布状态文件）。Stage-5：布局/公共物
   * 不再随会话快照落盘，独立走 {workspace}/.lantai/canvas.json。 */
  const [paperTick, setPaperTick] = useState(0);
  useEffect(() => {
    if (!core) return;
    const canvas = getCanvasStore(core.panelId);
    return canvas.subscribe(() => {
      setPaperTick((t) => t + 1);
      const pp = useShellStore.getState().projectPath;
      if (pp) scheduleCanvasSave(core.panelId, pp);
    });
  }, [core]);

  const activeSessionKey = activeSessionId != null ? String(activeSessionId) : null;

  return { sessions, activeSessionId, activeSessionKey, regionMsgs, canvasState, paperTick };
}
