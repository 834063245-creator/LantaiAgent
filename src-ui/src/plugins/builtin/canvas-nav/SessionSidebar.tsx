// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar — 当前工作区案卷管理侧边栏（Stage-3 挂载 + 2026-08-31 注疏重排）。
//
// 职责：管「这个工作区有哪些案卷、什么状态、怎么出生/改名/合卷/删除」。
//   - 全量列表：摊开案卷（sess store）+ 未摊开已存卷（listSavedSessions）
//     两源合流，常驻滚动、不截断。
//   - 注疏分节：摊开中（OPEN）/ 已合卷（CLOSED），节头点线引出 + 等宽计数；
//     当前卷 = 朱砂左条 + 淡朱砂洗底（与画布活跃卷界栏同语义）。
//   - 检索：常驻检索条即输即滤（filterRows 纯函数；Esc 清空）。
//   - 键盘：↑↓/Home/End 移动游标（roving tabindex + 就近滚动）、Enter/Space
//     摊开定位、F2 改名、Delete 两击确认删除、Esc 解除删除武装。
//   - 行操作：改名 / 合卷（收起，数据保留）/ 删除（两击确认）。
//   - 新建按钮（出生仪式：createNewSession，自动落位画布线性排比）。
//   - 可折叠：收起 = 只剩书脊（折叠状态走 dock-store）。
//
// 挂载：画布导航插件贡献行（plugins/builtin/canvas-nav/index.ts →
// ctx.panels 注册 'canvas-sidebar' 面板，side:'left' + unmountOnClose），
// 随纸面板开合。
// 消费 ctx.space（activeSpace()：展开未摊开卷/定位）+ 现有 core 会话命令。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例（store 单例不可内联副本），react 由构建期别名桥共享。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeSpace,
  agentSessionState,
  getChatStore,
  msgStoreFor,
  useAskStore,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
} from './host';
import {
  filterRows,
  mergeSessionRows,
  type SessionStatus,
  type SidebarRow,
  sessionMeta,
  splitSections,
  statusLabel,
} from './session-sidebar-model';
import './session-sidebar.css';

/** 行状态点（数据源：exec.isRunning + ask pending + 消息数；未摊开卷 = done）。 */
function computeStatus(
  panelId: string,
  row: Pick<SidebarRow, 'id' | 'open' | 'msgCount'>,
  activeSid: number | null,
  askPending: boolean,
): SessionStatus {
  if (row.open) {
    const exec = agentSessionState.getExec(panelId, row.id);
    if (exec?.isRunning) {
      return askPending && activeSid === row.id ? 'pending' : 'running';
    }
  }
  return row.msgCount > 0 ? 'done' : 'idle';
}

export const SessionSidebar = memo(function SessionSidebar() {
  const core = useCoreStore((s) => s.core);
  const [rows, setRows] = useState<SidebarRow[]>([]);
  /** 当前活跃卷 id（渲染当前卷朱砂标记；status 计算也要用）。 */
  const [activeSid, setActiveSid] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 键盘游标（roving tabindex）：可见行中当前聚焦的卷 id。 */
  const [cursorId, setCursorId] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  /** 新建防抖（双击竞态：createNewSession 发号在 await factory 之后）。 */
  const newBusyRef = useRef(false);
  const [newBusy, setNewBusy] = useState(false);
  /** 删除二次确认：已武装的卷 id（第一击变红，再击才删；null = 未武装）。 */
  const confirmingDeleteIdRef = useRef<number | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  const refresh = useCallback(() => {
    if (!core) return;
    const panelId = core.panelId;
    const pp = useShellStore.getState().projectPath;
    const st = getChatStore(panelId).sess.getState();
    const active = st.sessions[st.activeIdx]?.id ?? null;
    setActiveSid(active);
    // 并发会话：任一卷有在途提问即标记活跃卷 pending（提问卡本身带卷徽标）
    const askPending = useAskStore.getState().pendingBySession.size > 0;
    const open = st.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      msgCount: msgStoreFor(panelId, s.id).getState().messages.length,
    }));
    void core
      .listSavedSessions(pp)
      .then((saved) => {
        const merged = mergeSessionRows(open, saved).map((r) => ({
          ...r,
          status: computeStatus(panelId, r, active, askPending),
        }));
        setRows(merged);
      })
      .catch(() => {
        const merged = mergeSessionRows(open, []).map((r) => ({
          ...r,
          status: computeStatus(panelId, r, active, askPending),
        }));
        setRows(merged);
      });
  }, [core]);

  useEffect(() => {
    if (!core) return;
    refresh();
    const panelId = core.panelId;
    // 每卷消息 store 订阅（2026-09-01 面审）：行注记「N 块」数的是消息条数，
    // 此前只订 sess/ask/agent/space——流式追加/回填后块数恒陈旧（种子注入后
    // 侧边栏恒「0 块」实锤）。会话集变化时重挂订阅。
    let unMsgs: Array<() => void> = [];
    const syncMsgSubs = () => {
      for (const u of unMsgs) u();
      unMsgs = [];
      const st = getChatStore(panelId).sess.getState();
      for (const s of st.sessions) unMsgs.push(msgStoreFor(panelId, s.id).subscribe(refresh));
    };
    syncMsgSubs();
    const unSess = getChatStore(panelId).sess.subscribe(() => {
      syncMsgSubs();
      refresh();
    });
    const unAgents = agentSessionState.subscribe(refresh);
    const unAsk = useAskStore.subscribe(refresh);
    const unSpace = activeSpace()?.subscribe(refresh);
    // rework P4-1：工作区路径变化（进工作区/切换）必须重拉 listSavedSessions——
    // 首拉若早于 projectPath 落定（Workspace.open 之后才写 shell-store），
    // 会拉到空集且再无重试点。
    const unShell = useShellStore.subscribe((s, prev) => {
      if (s.projectPath !== prev.projectPath) refresh();
    });
    return () => {
      for (const u of unMsgs) u();
      unSess();
      unAgents();
      unAsk();
      unSpace?.();
      unShell();
    };
  }, [core, refresh]);

  /** 取消删除武装（改名/点击行/新建等任何其它动作都解武）。 */
  const cancelDeleteConfirm = useCallback(() => {
    confirmingDeleteIdRef.current = null;
    setConfirmingDeleteId(null);
  }, []);

  /* ── 行点击：摊开/定位 ── */
  const onRowClick = useCallback(
    (row: SidebarRow) => {
      if (!core) return;
      cancelDeleteConfirm(); // 点击行 = 其它意图，解除删除武装
      setCursorId(row.id);
      const sid = String(row.id);
      if (row.open) {
        activeSpace()?.focus(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      } else {
        activeSpace()?.expand(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      }
    },
    [core, cancelDeleteConfirm],
  );

  /* ── 行操作：改名 / 合卷（收起）/ 删除 ── */
  const commitRename = useCallback(
    (id: number, label: string) => {
      if (!core) return;
      const next = label.trim();
      if (!next) {
        setRenamingId(null);
        return;
      }
      const st = getChatStore(core.panelId).sess.getState();
      const open = st.sessions.some((s) => s.id === id);
      if (open) core.renameSession(id, next);
      else void core.renameSavedSession(id, next);
      setRenamingId(null);
      refresh();
    },
    [core, refresh],
  );

  const onCollapse = useCallback(
    (id: number) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx < 0) return;
      if (agentSessionState.getExec(core.panelId, id)?.isRunning) {
        setLocalNotice('运行中的卷不能合卷——先停止再收起');
        return;
      }
      core.closeSession(idx);
      refresh();
    },
    [core, refresh],
  );

  const onDelete = useCallback(
    (id: number) => {
      if (!core) return;
      if (agentSessionState.getExec(core.panelId, id)?.isRunning) {
        setLocalNotice('运行中的卷不能删除——先停止再移除');
        return;
      }
      // 二次确认（2026-08-28 会话管理专项，用户拍板）：第一击武装（按钮变红），
      // 再击才真正写墓碑——「删」与「改」「合」相邻，防误触不可撤销。
      if (confirmingDeleteIdRef.current !== id) {
        confirmingDeleteIdRef.current = id;
        setConfirmingDeleteId(id);
        return;
      }
      confirmingDeleteIdRef.current = null;
      setConfirmingDeleteId(null);
      const pp = useShellStore.getState().projectPath;
      void core.deleteSessionFile(pp, id);
      refresh();
    },
    [core, refresh],
  );

  const onNew = useCallback(() => {
    if (!core) return;
    setLocalNotice(null);
    // busy 防抖（2026-08-28 会话管理专项）：createNewSession 先 await factory
    // 再发号自增——双击落在 await 窗口内会读到同一 nextSessionId → 同号双建
    // + 泄漏一个 Agent 句柄。防抖期间忽略重复点击。
    if (newBusyRef.current) return;
    newBusyRef.current = true;
    setNewBusy(true);
    // 出生 = 一种展开：绑定视角聚焦（用户拍板）——新卷落点（最近空位）
    // 相对视口中心，聚焦把它带到眼前
    void (async () => {
      try {
        await core.createNewSession();
        const st = getChatStore(core.panelId).sess.getState();
        const sid = st.sessions[st.activeIdx]?.id;
        if (sid != null) useCanvasViewStore.getState().requestFocus(String(sid));
      } finally {
        newBusyRef.current = false;
        setNewBusy(false);
      }
    })();
  }, [core]);

  const onCollapseSidebar = useCallback(() => {
    useDockStore.getState().closePanel('canvas-sidebar');
  }, []);

  /* ── 检索 ── */
  const visible = useMemo(() => filterRows(rows, query), [rows, query]);
  const sections = useMemo(() => splitSections(visible), [visible]);
  const flat = useMemo(() => [...sections.open, ...sections.closed], [sections]);

  /* 游标随可见行收窄而收敛（过滤/删除后游标行可能消失）。 */
  useEffect(() => {
    if (flat.length === 0) {
      if (cursorId !== null) setCursorId(null);
      return;
    }
    if (cursorId === null || !flat.some((r) => r.id === cursorId)) {
      setCursorId(flat[0].id);
    }
  }, [flat, cursorId]);

  /* ── 检索条键盘：Esc 清空；↓ 直落列表首行 ── */
  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuery('');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = flat[0];
        if (first) {
          setCursorId(first.id);
          rowRefs.current.get(first.id)?.focus();
        }
      }
    },
    [flat],
  );

  /* ── 列表键盘导航：↑↓/Home/End 移动游标，F2 改名，Delete 两击删除。
   *  Enter/Space 交给行自身激活处理（事件自行内冒泡到此，不劫持）。 ── */
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingId !== null) return; // 改名输入自理（Enter/Escape 已在行内截停）
      if (flat.length === 0) return;
      const idx = flat.findIndex((r) => r.id === cursorId);
      let next = -1;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1);
      else if (e.key === 'ArrowUp') next = idx < 0 ? 0 : Math.max(0, idx - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = flat.length - 1;
      else if (e.key === 'F2' && idx >= 0) {
        e.preventDefault();
        const row = flat[idx];
        cancelDeleteConfirm();
        setRenamingId(row.id);
        setDraftLabel(row.label || `案卷 ${row.id}`);
        return;
      } else if (e.key === 'Delete' && idx >= 0) {
        e.preventDefault();
        onDelete(flat[idx].id);
        return;
      } else {
        return;
      }
      e.preventDefault();
      const row = flat[next];
      setCursorId(row.id);
      rowRefs.current.get(row.id)?.focus();
      rowRefs.current.get(row.id)?.scrollIntoView?.({ block: 'nearest' });
    },
    [flat, cursorId, renamingId, onDelete, cancelDeleteConfirm],
  );

  /* Esc（列表外，如书眉/检索失焦后）解除删除武装——改名输入的 Esc 不冒泡。 */
  const onRootKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancelDeleteConfirm();
    },
    [cancelDeleteConfirm],
  );

  if (!core) return null;

  const renderRow = (r: SidebarRow) => {
    const isRenaming = renamingId === r.id;
    const isCurrent = r.open && r.id === activeSid;
    return (
      // biome-ignore lint/a11y/useSemanticElements: 行容器内含行操作按钮，button 嵌套交互元素非法——用 div 承载行级点击
      <div
        key={r.id}
        ref={(el) => {
          if (el) rowRefs.current.set(r.id, el);
          else rowRefs.current.delete(r.id);
        }}
        role="button"
        tabIndex={cursorId === r.id ? 0 : -1}
        className={`ss-row${r.open ? ' open' : ''}${isCurrent ? ' current' : ''}`}
        title={`${r.label || `案卷 ${r.id}`}${isCurrent ? ' · 当前卷' : ''} · ${statusLabel(r.status)}`}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onRowClick(r)}
        onFocus={() => setCursorId(r.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(r);
          }
        }}
      >
        <span className={`ss-dot ss-dot-${r.status}`} role="presentation" />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="ss-rename-input"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename(r.id, draftLabel);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingId(null);
              }
              e.stopPropagation();
            }}
            onBlur={() => commitRename(r.id, draftLabel)}
          />
        ) : (
          <div className="ss-row-main">
            <span className="ss-label">{r.label || `案卷 ${r.id}`}</span>
            <span className="ss-meta">{sessionMeta(r)}</span>
          </div>
        )}
        {!isRenaming && (
          <div className="ss-actions">
            <button
              type="button"
              title="改名"
              onClick={(e) => {
                e.stopPropagation();
                cancelDeleteConfirm();
                setRenamingId(r.id);
                setDraftLabel(r.label || `案卷 ${r.id}`);
              }}
            >
              改
            </button>
            {r.open && (
              <button
                type="button"
                title="合卷（收起，数据保留）"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelDeleteConfirm();
                  onCollapse(r.id);
                }}
              >
                合
              </button>
            )}
            {confirmingDeleteId === r.id ? (
              <button
                type="button"
                className="ss-danger"
                title="再点一次确认删除（不可撤销）；点其它处取消"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
              >
                确删?
              </button>
            ) : (
              <button
                type="button"
                title="彻底删除（点两次确认）"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
              >
                删
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="ss-sidebar" aria-label="当前工作区案卷管理" onKeyDown={onRootKeyDown}>
      <div className="ss-head">
        <span className="ss-title">案卷</span>
        <span className="ss-count">SESSIONS · {rows.length}</span>
        <button
          type="button"
          className="ss-fold"
          title="收起侧边栏（只剩书脊）"
          aria-label="收起侧边栏"
          onClick={onCollapseSidebar}
        >
          ◂
        </button>
      </div>

      <div className="ss-search">
        <span className="ss-search-lbl">检</span>
        <input
          type="text"
          value={query}
          placeholder="卷名或卷号…"
          aria-label="检索案卷"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      {localNotice && (
        <div className="ss-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘导航容器（↑↓/F2/Delete 经事件冒泡统一处理） */}
      <div className="ss-list" onKeyDown={onListKeyDown}>
        {sections.open.length > 0 && (
          <div className="ss-section">
            <div className="ss-section-head">
              <span className="t">摊开中</span>
              <span className="leader" role="presentation" />
              <span className="n">OPEN · {sections.open.length}</span>
            </div>
            {sections.open.map(renderRow)}
          </div>
        )}
        {sections.closed.length > 0 && (
          <div className="ss-section">
            <div className="ss-section-head">
              <span className="t">已合卷</span>
              <span className="leader" role="presentation" />
              <span className="n">CLOSED · {sections.closed.length}</span>
            </div>
            {sections.closed.map(renderRow)}
          </div>
        )}
        {rows.length === 0 && <div className="ss-empty">本工作区暂无案卷</div>}
        {rows.length > 0 && visible.length === 0 && <div className="ss-empty">无匹配案卷</div>}
      </div>

      <div className="ss-foot">
        <button
          type="button"
          className="ss-new"
          onClick={onNew}
          disabled={newBusy}
          title={newBusy ? '正在创建…' : undefined}
        >
          ＋ 另起一卷
        </button>
      </div>
    </aside>
  );
});
