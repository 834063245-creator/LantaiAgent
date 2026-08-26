// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar — 当前工作区会话管理侧边栏（Stage-3，DSH 范式收窄）。
//
// 职责：管「这个工作区有哪些会话、什么状态、怎么出生/改名/收起/删除」。
//   - 全量列表：摊开会话（sess store）+ 未摊开已存卷（listSavedSessions）
//     两源合流，常驻滚动、不截断。
//   - 状态点：pending（ask 交互）> running > done > idle（对齐 DSH 优先级）。
//   - 相对时间、行操作（改名 / 收起=合卷 / 删除；fork/只读后置、归档已砍）。
//   - 新建按钮（出生仪式：createNewSession，自动落位画布线性排比）。
//   - 可折叠：面板关 = 只剩书脊（Plan A 布局，折叠状态走 dock-store）。
//
// 挂载：画布导航插件贡献行（plugins/canvas-nav-plugin.ts → ctx.panels
// 注册 'canvas-sidebar' 面板，side:'left' + unmountOnClose），随纸面板开合。
// 消费 ctx.space（activeSpace()：展开未摊开卷/定位）+ 现有 core 会话命令。

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import { activeSpace } from '../../composition/space-service';
import { useAskStore } from '../../state/ask-store';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { useDockStore } from '../../state/dock-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
import { useCoreStore } from '../chat/core-instance';
import { useShellStore } from '../shell-store';
import {
  mergeSessionRows,
  relativeTime,
  type SessionStatus,
  type SidebarRow,
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
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  const refresh = useCallback(() => {
    if (!core) return;
    const panelId = core.panelId;
    const pp = useShellStore.getState().projectPath;
    const st = getChatStore(panelId).sess.getState();
    const activeSid = st.sessions[st.activeIdx]?.id ?? null;
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
          status: computeStatus(panelId, r, activeSid, askPending),
        }));
        setRows(merged);
      })
      .catch(() => {
        const merged = mergeSessionRows(open, []).map((r) => ({
          ...r,
          status: computeStatus(panelId, r, activeSid, askPending),
        }));
        setRows(merged);
      });
  }, [core]);

  useEffect(() => {
    if (!core) return;
    refresh();
    const panelId = core.panelId;
    const unSess = getChatStore(panelId).sess.subscribe(refresh);
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
      unSess();
      unAgents();
      unAsk();
      unSpace?.();
      unShell();
    };
  }, [core, refresh]);

  /* ── 行点击：摊开/定位 ── */
  const onRowClick = useCallback(
    (row: SidebarRow) => {
      if (!core) return;
      const sid = String(row.id);
      if (row.open) {
        activeSpace()?.focus(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      } else {
        activeSpace()?.expand(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      }
    },
    [core],
  );

  /* ── 行操作：改名 / 收起（合卷）/ 删除 ── */
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
        setLocalNotice('运行中的卷不能收起——先停止再合卷');
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
      const pp = useShellStore.getState().projectPath;
      void core.deleteSessionFile(pp, id);
      refresh();
    },
    [core, refresh],
  );

  const onNew = useCallback(() => {
    if (!core) return;
    setLocalNotice(null);
    void core.createNewSession();
  }, [core]);

  const onCollapseSidebar = useCallback(() => {
    useDockStore.getState().closePanel('canvas-sidebar');
  }, []);

  if (!core) return null;

  return (
    <aside className="ss-sidebar" aria-label="当前工作区会话管理">
      <div className="ss-head">
        <span className="ss-title">会话</span>
        <span className="ss-count">{rows.length}</span>
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

      {localNotice && (
        <div className="ss-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      <div className="ss-list">
        {rows.map((r) => {
          const isRenaming = renamingId === r.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 行容器内含行操作按钮，button 嵌套交互元素非法——用 div 承载行级点击
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              className={`ss-row${r.open ? ' open' : ''}`}
              title={`${r.label}${r.open ? ' · 已摊开' : ' · 未摊开'} · ${statusLabel(r.status)}`}
              onClick={() => onRowClick(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick(r);
                }
              }}
            >
              <span className={`ss-dot ss-dot-${r.status}`} role="presentation" />
              <div className="ss-row-main">
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
                  <>
                    <span className="ss-label">{r.label || `案卷 ${r.id}`}</span>
                    <span className="ss-meta">
                      {r.open ? '摊开' : '未摊开'} · {r.msgCount} 块 · {relativeTime(r.savedAt)}
                    </span>
                  </>
                )}
              </div>
              {!isRenaming && (
                <div className="ss-actions">
                  <button
                    type="button"
                    title="改名"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(r.id);
                      setDraftLabel(r.label || `案卷 ${r.id}`);
                    }}
                  >
                    改
                  </button>
                  {r.open && (
                    <button
                      type="button"
                      title="收起（合卷，数据保留）"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCollapse(r.id);
                      }}
                    >
                      收
                    </button>
                  )}
                  <button
                    type="button"
                    title="彻底删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(r.id);
                    }}
                  >
                    删
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="ss-empty">本工作区暂无会话</div>}
      </div>

      <div className="ss-foot">
        <button type="button" className="ss-new" onClick={onNew}>
          ＋ 另起一卷
        </button>
      </div>
    </aside>
  );
});
