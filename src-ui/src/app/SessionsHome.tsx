// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页 → 工作区总览（Stage-2 一纸多卷「方案 A」）。
//
// 定案（docs/plans/canvas-space/stage-2.md §3.5）：**不并存——画布即主界面**。
// 首页只做「工作区列表 + 进入动作」：一整个工作区 = 一块画布，选完进画布；
// 工作区内的会话管理交给画布旁的最小侧边栏（新建 + 列表）。
//
// 工作区清单从全局会话列表（user_sessions_list 单一来源）按 workspace 字段
// 分组推导（无需新后端 RPC）：有卷的工作区各一张卡 + 「零目录」桶（无绑定
// 目录的卷）。进入 = 打开纸画布 + （必要时）切到该工作区；Q-B：进入不自动
// 摊开任何卷，卷由用户在画布侧边栏另起/展开。
//
// 版式对齐 prototype/lantai.html 案卷首页（2026-08-23 视觉迭代）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { typedJsonRpc } from '../rpc-contract';
import { workspaceFlow } from '../shell/rows/workspace';
import { useCanvasViewStore } from '../state/canvas-view-store';
import { useDockStore } from '../state/dock-store';
import { useUpdateStore } from '../state/update-store';
import { ensureUserSessionsDir } from '../ui/chat-session';
import { getChatStore } from '../ui/chat-store';
import { useCoreStore } from './chat/core-instance';
import { useShellStore } from './shell-store';
import { WinControls } from './WinControls';

/** 全局会话行（Rust UserSessionEntry 同形）——workspace：卷归属工作区（可空 = 零目录卷）。 */
interface UserSession {
  id: number;
  label: string;
  msg_count: number;
  saved_at: string;
  workspace?: string | null;
}

/** 卷所属工作区的短名（路径末段；零目录卷 = null 不显示）。 */
function workspaceShortName(ws: string | null | undefined): string {
  if (!ws) return '';
  const norm = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  const last = norm.split('/').filter(Boolean).pop();
  return last ?? norm;
}

/** 案卷日期列：MM-DD（原型 .session-row .date 同款） */
function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '——';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 顶栏拖拽窗口 — CSS -webkit-app-region: drag 无效时（Linux WM）用 Tauri 原生拖拽兜底。 */
interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}
function handleBarPointerDown(e: React.PointerEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('button, input, kbd, .wc-btns')) return;
  if (document.documentElement.getAttribute('data-platform') !== 'linux') return;
  const ta = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (ta?.invoke) {
    ta.invoke('plugin:window|start_dragging', {
      label: ta.metadata?.currentWindow?.label || 'main',
    }).catch((err) => console.warn('start_dragging failed', err));
  }
}

/** 标题栏双击最大化 */
function handleBarDoubleClick(e: React.MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('button, input, kbd, .wc-btns')) return;
  const ta = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (ta?.invoke) {
    ta.invoke('plugin:window|toggle_maximize', {
      label: ta.metadata?.currentWindow?.label || 'main',
    }).catch((err) => console.warn('toggle_maximize failed', err));
  }
}

interface WorkspaceCard {
  workspace: string;
  name: string;
  sessions: UserSession[];
  latest: string;
}

export function SessionsHome() {
  const core = useCoreStore((s) => s.core);
  const openPanel = useDockStore((s) => s.openPanel);
  const [sessions, setSessions] = useState<UserSession[]>([]);

  // 单一全局列表（会话统一 U2）：user_sessions_list 一个来源。
  // 刷新时机：挂载期 + 每次纸面板从开到关（回首页即重拉）。
  const paperOpen = useDockStore((s) => s.open.paper);
  useEffect(() => {
    if (paperOpen) return;
    let alive = true;
    void (async () => {
      await ensureUserSessionsDir();
      try {
        const parsed = await typedJsonRpc<UserSession[]>('user_sessions_list', {});
        if (alive) setSessions(Array.isArray(parsed) ? parsed : []);
      } catch {
        /* 目录不存在 = 空（首启常态） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [paperOpen]);

  /** 工作区清单：按 workspace 字段分组（Stage-5：零目录退役——零目录卷
   *  不进工作区卡，独立走「绑定目录/归档」退役动作；无目录不能进画布）。 */
  const workspaces = useMemo<WorkspaceCard[]>(() => {
    const groups = new Map<string, UserSession[]>();
    for (const s of sessions) {
      if (!s.workspace) continue; // 零目录卷不进工作区清单
      const arr = groups.get(s.workspace) ?? [];
      arr.push(s);
      groups.set(s.workspace, arr);
    }
    const out: WorkspaceCard[] = [];
    for (const [ws, list] of groups) {
      list.sort((a, b) => new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime());
      out.push({
        workspace: ws,
        name: workspaceShortName(ws),
        sessions: list,
        latest: list[0]?.saved_at ?? '',
      });
    }
    out.sort((a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime());
    return out;
  }, [sessions]);

  /** 存量零目录卷（Stage-5 退役对象：要么绑目录、要么归档，不能进画布）。 */
  const zeroDirSessions = useMemo(() => sessions.filter((s) => !s.workspace), [sessions]);
  const [notice, setNotice] = useState<string | null>(null);
  const [zeroDirBusy, setZeroDirBusy] = useState(false);

  /** 进入工作区画布：打开纸面板 + （必要时）切到该工作区。
   *  Q-B：进入不自动摊开卷——摊开集由画布状态文件恢复（Stage-5 拍板 11）。 */
  const onEnterWorkspace = useCallback(
    (ws: string) => {
      openPanel('paper');
      if (!ws) return; // 零目录：当前占位工作区即画布，直接进入（退役后不出现）
      const current = useShellStore.getState().projectPath;
      if (ws !== current) {
        void workspaceFlow.switchWorkspace(ws, { skipAnalysis: true });
      }
    },
    [openPanel],
  );

  const onNewSession = useCallback(() => {
    openPanel('paper');
    if (!core) return;
    // 零目录退役（Stage-5 拍板 a）：创建必须要有目录——无工作区先选/建工作区
    if (!useShellStore.getState().projectPath) {
      void workspaceFlow.switchWorkspace();
      return;
    }
    // 出生 = 一种展开：绑定视角聚焦（用户拍板）——新卷落点（最近空位）
    // 相对视口中心，聚焦把它带到眼前
    void (async () => {
      await core.createNewSession();
      const st = getChatStore(core.panelId).sess.getState();
      const sid = st.sessions[st.activeIdx]?.id;
      if (sid != null) useCanvasViewStore.getState().requestFocus(String(sid));
    })();
  }, [core, openPanel]);

  const onNewSessionWithDir = useCallback(() => {
    openPanel('paper');
    void workspaceFlow.switchWorkspace();
  }, [openPanel]);

  /** 零目录卷 → 绑目录：把全部零目录卷归入用户选的工作区。 */
  const onBindZeroDir = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = (await open({ directory: true, multiple: false, title: '选择工作区目录' })) as string | null;
    if (!result || !core) return;
    setZeroDirBusy(true);
    setNotice(null);
    try {
      const n = await core.bindZeroDirSessions(result);
      setNotice(n > 0 ? `已把 ${n} 卷零目录案卷归入工作区` : '没有可绑定的零目录案卷');
    } finally {
      setZeroDirBusy(false);
    }
  }, [core]);

  /** 零目录卷 → 归档：拷贝到归档目录 + 原位墓碑（代码永不回读）。 */
  const onArchiveZeroDir = useCallback(async () => {
    if (!core) return;
    setZeroDirBusy(true);
    setNotice(null);
    try {
      const n = await core.archiveZeroDirSessions();
      setNotice(n > 0 ? `已归档 ${n} 卷零目录案卷` : '没有可归档的零目录案卷');
    } finally {
      setZeroDirBusy(false);
    }
  }, [core]);

  const onOpenSettings = useCallback(() => openPanel('settings'), [openPanel]);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  const totalVolumes = sessions.length;

  return (
    <div className="sh-root">
      {/* 顶部书眉：印章 + 兰台 wordmark + tagline · 右侧设置入口 + 窗口控制 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 窗口拖拽热区（decorations:false 的标题栏） */}
      <header className="sh-head" onPointerDown={handleBarPointerDown} onDoubleClick={handleBarDoubleClick}>
        <div className="sh-brand">
          <span className="sh-seal" role="img" aria-label="印章：蘭臺">
            <b>蘭</b>
            <b>臺</b>
          </span>
          <span className="sh-wordmark">兰台</span>
          <span className="sh-tagline">档案 · 工作台</span>
        </div>
        <div className="sh-head-right">
          <button
            type="button"
            className={`sh-btn-text${updateAvailable ? ' has-update' : ''}`}
            onClick={onOpenSettings}
            title={updateAvailable && updateVersion ? `新版本 ${updateVersion} 可用` : undefined}
          >
            设置
          </button>
          <WinControls />
        </div>
      </header>

      {/* 主区：kicker + 大标题 + 描述 + 工作区列表 + 新建按钮 */}
      <main className="sh-main">
        <p className="sh-kicker">兰台 · 档案</p>
        <h1 className="sh-h1">与 Agent 协作，应当像在纸上书写。</h1>
        <p className="sh-lead">
          在纸面上向 Agent
          拟文，它的每一次思考、读码与计划，都作为注疏落进同一卷案卷——可对照、可钉住、可追溯。一个工作区就是一张纸，摊开多少卷，都在同一片纸上。
        </p>

        <div className="sh-section-title">
          <span className="t">工作区</span>
          <span className="n">WORKSPACES · {workspaces.length}</span>
        </div>

        {workspaces.length > 0 ? (
          <div className="sh-workspaces">
            {workspaces.map((w) => (
              <button
                key={w.workspace}
                type="button"
                className="sh-ws-card"
                onClick={() => onEnterWorkspace(w.workspace)}
                aria-label={`进入工作区：${w.name}（${w.sessions.length} 卷）`}
              >
                <span className="sh-ws-name">{w.name}</span>
                <span className="sh-ws-meta">
                  {w.sessions.length} 卷 · 最近 {formatSessionDate(w.latest)}
                </span>
                <span className="sh-ws-enter">进入画布 →</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="sh-empty-hint">从一卷新案卷开始——需要 Agent 干活时先创建/选择一个工作区目录。</p>
        )}

        {/* 零目录卷退役（Stage-5 拍板 a）：无目录不能进画布——存量零目录卷
         * 要么绑目录（归入某工作区）、要么归档。 */}
        {zeroDirSessions.length > 0 && (
          <div className="sh-zero-dir">
            <span className="sh-zero-dir-title">零目录案卷 · {zeroDirSessions.length} 卷（待退役）</span>
            <span className="sh-zero-dir-desc">这些案卷没有所属工作区，无法进入画布。请归入一个工作区或归档。</span>
            <div className="sh-zero-dir-actions">
              <button type="button" className="sh-btn-text" disabled={zeroDirBusy} onClick={onBindZeroDir}>
                绑定目录
              </button>
              <button type="button" className="sh-btn-text" disabled={zeroDirBusy} onClick={onArchiveZeroDir}>
                归档
              </button>
            </div>
          </div>
        )}
        {notice && <p className="sh-notice">{notice}</p>}

        <div className="sh-actions">
          <button type="button" className="sh-btn-primary" onClick={onNewSession}>
            ＋ 新建案卷
          </button>
          <button type="button" className="sh-btn-text" onClick={onNewSessionWithDir}>
            新建案卷 · 绑定目录
          </button>
        </div>
      </main>

      {/* 底部 footer：左 brand 右当前案卷状态 */}
      <footer className="sh-foot">
        <span>兰台 · 档案</span>
        <span>{totalVolumes > 0 ? `${totalVolumes} 卷案卷 · 就绪` : '尚无案卷'}</span>
      </footer>
    </div>
  );
}
