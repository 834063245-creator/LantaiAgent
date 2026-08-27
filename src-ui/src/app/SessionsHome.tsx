// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页 = 工作区管理面（Stage-5 补尾：已知工作区实体）。
//
// 定案（docs/plans/canvas-space/stage-2.md §3.5 方案 A + Stage-5 补尾拍板）：
// **不并存——画布即主界面**。首页管「你有哪些工作区」：绑定目录（= 创建/
// 登记工作区）、改名、固定常用、移除（连带删卷，需确认）、进画布；
// 工作区内的会话管理交给画布旁的侧边栏（出生仪式在那边）。
//
// 数据源（Stage-5 补尾）：`workspace_list` 单一来源——Rust 把
// ~/.lantai/workspaces.json 注册表与会话推导合流（空工作区也可见，
// 未登记的旧绑定自动补齐）；不再由会话倒推工作区卡。零目录桶仍走
// user_sessions_list（退役对象：要么绑目录要么归档）。
//
// 版式对齐 prototype/lantai.html 案卷首页（2026-08-23 视觉迭代）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { typedJsonRpc, typedRpc } from '../rpc-contract';
import { workspaceFlow } from '../shell/rows/workspace';
import { useDockStore } from '../state/dock-store';
import { useUpdateStore } from '../state/update-store';
import { useShellStore } from './shell-store';
import { WinControls } from './WinControls';

/** 已知工作区行（Rust WorkspaceSummary 同形——注册表 + 会话推导合流）。 */
interface KnownWorkspace {
  path: string;
  name?: string | null;
  last_opened_at: string;
  pinned: boolean;
  session_count: number;
  latest_saved_at?: string | null;
}

/** 工作区显示名：登记名优先，缺省 = 路径末段。 */
function wsDisplayName(ws: KnownWorkspace): string {
  if (ws.name?.trim()) return ws.name.trim();
  return pathBasename(ws.path);
}

function pathBasename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const last = norm.split('/').filter(Boolean).pop();
  return last ?? norm;
}

/** 案卷日期列：MM-DD（原型 .session-row .date 同款） */
function formatSessionDate(iso: string | null | undefined): string {
  if (!iso) return '——';
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

export function SessionsHome() {
  const openPanel = useDockStore((s) => s.openPanel);

  // ── 已知工作区清单（workspace_list：注册表 + 会话推导合流）──
  const [workspaces, setWorkspaces] = useState<KnownWorkspace[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 内联改名（一次一张卡）。 */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 两段式移除确认：第一击记录待确认路径，再击确认。 */
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  // 刷新时机：挂载期 + 每次纸面板从开到关（回首页即重拉）。
  const paperOpen = useDockStore((s) => s.open.paper);
  useEffect(() => {
    if (paperOpen) return;
    let alive = true;
    void (async () => {
      try {
        const parsed = await typedJsonRpc<KnownWorkspace[]>('workspace_list', {});
        if (alive) setWorkspaces(Array.isArray(parsed) ? parsed : []);
      } catch {
        /* 目录缺席（首启常态）= 空清单 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [paperOpen]);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const parsed = await typedJsonRpc<KnownWorkspace[]>('workspace_list', {});
      setWorkspaces(Array.isArray(parsed) ? parsed : []);
    } catch {
      /* 保留旧清单，失败可见于 console */
      console.warn('[home] workspace_list 刷新失败');
    }
  }, []);

  /** 进入工作区画布：打开纸面板 + （必要时）切到该工作区。
   *  摊开集由画布状态文件恢复（Stage-5 拍板 11）。 */
  const onEnterWorkspace = useCallback(
    (ws: string) => {
      setRemovingPath(null);
      openPanel('paper');
      const current = useShellStore.getState().projectPath;
      if (ws !== current) {
        void workspaceFlow.switchWorkspace(ws, { skipAnalysis: true });
      }
    },
    [openPanel],
  );

  /** 绑定工作区（= 创建/登记）：选目录 → activate → 自动进画布建卷。
   *  出生仪式在画布侧边栏——首页只管工作区本身。 */
  const onBindWorkspace = useCallback(() => {
    openPanel('paper');
    void workspaceFlow.switchWorkspace();
  }, [openPanel]);

  /** 改名提交：空名 = 取消。 */
  const onRenameCommit = useCallback(
    async (path: string) => {
      const next = renameDraft.trim();
      setRenamingPath(null);
      if (!next) return;
      setBusy(true);
      try {
        await typedRpc('workspace_rename', { path, name: next });
        await refreshWorkspaces();
      } catch (e) {
        console.error('[home] workspace_rename failed:', e);
        setNotice(`改名失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [renameDraft, refreshWorkspaces],
  );

  const onTogglePin = useCallback(
    async (ws: KnownWorkspace) => {
      setBusy(true);
      try {
        await typedRpc('workspace_toggle_pin', { path: ws.path, pinned: !ws.pinned });
        await refreshWorkspaces();
      } catch (e) {
        console.error('[home] workspace_toggle_pin failed:', e);
        setNotice(`固定失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refreshWorkspaces],
  );

  /** 移除工作区（彻底：连带删其中全部案卷）——两段式确认后执行。 */
  const onRemoveConfirmed = useCallback(
    async (ws: KnownWorkspace) => {
      setBusy(true);
      setNotice(null);
      try {
        await typedRpc('workspace_remove', { path: ws.path });
        setRemovingPath(null);
        await refreshWorkspaces();
        setNotice(
          `已移除工作区「${wsDisplayName(ws)}」${ws.session_count > 0 ? `（含 ${ws.session_count} 卷案卷）` : ''}`,
        );
      } catch (e) {
        console.error('[home] workspace_remove failed:', e);
        setNotice(`移除失败: ${e instanceof Error ? e.message : String(e)}`);
        setRemovingPath(null);
      } finally {
        setBusy(false);
      }
    },
    [refreshWorkspaces],
  );

  /** 零目录卷退役（workspace-session-ownership-rework 2026-08-27）：零目录
   *  会话概念整体移除——无目录不能进画布、创建必须要有目录。零目录桶的
   *  绑目录/归档动作已随 bindZeroDirSessions/archiveZeroDirSessions 退役。 */

  const onOpenSettings = useCallback(() => openPanel('settings'), [openPanel]);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  const totalVolumes = workspaces.reduce((n, w) => n + w.session_count, 0);

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

      {/* 主区：kicker + 大标题 + 描述 + 工作区管理列表 + 绑定入口 */}
      <main className="sh-main">
        <p className="sh-kicker">兰台 · 档案</p>
        <h1 className="sh-h1">与 Agent 协作，应当像在纸上书写。</h1>
        <p className="sh-lead">
          一个工作区就是一张纸：绑定一个目录，摊开多少卷都在同一片纸上——可对照、可钉住、可追溯。
        </p>

        <div className="sh-section-title">
          <span className="t">工作区</span>
          <span className="n">WORKSPACES · {workspaces.length}</span>
        </div>

        {workspaces.length > 0 ? (
          <div className="sh-workspaces">
            {workspaces.map((w) => {
              const isRenaming = renamingPath === w.path;
              const isConfirmingRemove = removingPath === w.path;
              return (
                <div key={w.path} className="sh-ws-card sh-ws-card--row">
                  <button
                    type="button"
                    className="sh-ws-card-main"
                    onClick={() => onEnterWorkspace(w.path)}
                    aria-label={`进入工作区：${wsDisplayName(w)}（${w.session_count} 卷）`}
                  >
                    <span className="sh-ws-name">
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          className="sh-ws-rename-input"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void onRenameCommit(w.path);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setRenamingPath(null);
                            }
                            e.stopPropagation();
                          }}
                          onBlur={() => void onRenameCommit(w.path)}
                        />
                      ) : (
                        <>
                          {wsDisplayName(w)}
                          {w.pinned && <span className="sh-ws-pin">固定</span>}
                        </>
                      )}
                    </span>
                    <span className="sh-ws-meta" title={w.path}>
                      {w.session_count > 0
                        ? `${w.session_count} 卷 · 最近 ${formatSessionDate(w.latest_saved_at)}`
                        : '空工作区 · 还没有案卷'}
                    </span>
                    <span className="sh-ws-enter">进入画布 →</span>
                  </button>
                  {!isRenaming && !isConfirmingRemove && (
                    <div className="sh-ws-actions">
                      <button
                        type="button"
                        title="重命名"
                        onClick={() => {
                          setRenamingPath(w.path);
                          setRenameDraft(w.name ?? '');
                        }}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        title={w.pinned ? '取消固定' : '固定（置顶）'}
                        disabled={busy}
                        onClick={() => void onTogglePin(w)}
                      >
                        {w.pinned ? '解固' : '固定'}
                      </button>
                      <button
                        type="button"
                        title="移除工作区（连带删除其中的全部案卷）"
                        disabled={busy}
                        onClick={() => setRemovingPath(w.path)}
                      >
                        移除
                      </button>
                    </div>
                  )}
                  {isConfirmingRemove && (
                    <div className="sh-ws-remove-confirm">
                      <span>
                        删除「{wsDisplayName(w)}」及其 {w.session_count} 卷案卷？
                      </span>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => void onRemoveConfirmed(w)}
                      >
                        确认移除
                      </button>
                      <button type="button" onClick={() => setRemovingPath(null)}>
                        取消
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sh-empty-hint">还没有工作区——绑定一个目录，从一卷新案卷开始。</p>
        )}
        {notice && <p className="sh-notice">{notice}</p>}

        <div className="sh-actions">
          <button type="button" className="sh-btn-primary" onClick={onBindWorkspace}>
            ＋ 绑定工作区
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
