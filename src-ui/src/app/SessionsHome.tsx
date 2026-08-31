// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页 = 工作区管理面（Stage-5 补尾：已知工作区实体）。
//
// 定案（docs/plans/canvas-space/stage-2.md §3.5 方案 A + Stage-5 补尾拍板）：
// **不并存——画布即主界面**。首页管「你有哪些工作区」：新建工作区（创建
// 目录或指定已有目录 + per-workspace 图谱引擎勾选，2026-08-31 拍板）、
// 改名、固定常用、移除（连带删卷，模态勾选确认——不做退路）、进画布；
// 工作区内的会话管理交给画布旁的侧边栏（出生仪式在那边，开口即开卷）。
//
// 数据源：`workspace_list` 单一来源——Rust 把 ~/.lantai/workspaces.json 注册表
// 全量列出，每个工作区的会话计数/最近时间扫**自己的会话根**
// `{path}/.lantai/sessions/`（workspace-session-ownership-rework 2026-08-27）。
// 工作区内的会话管理交给画布旁的侧边栏；会话只在所属工作区内可见。
//
// 版式对齐 prototype/lantai.html 案卷首页（2026-08-23 视觉迭代）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { typedJsonRpc, typedRpc } from '../rpc-contract';
import { graphEngineEnabled, loadSettings } from '../settings';
import { pickFolder, workspaceFlow } from '../shell/rows/workspace';
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
  /** 工作区根目录在磁盘上是否仍存在（false = 「目录已丢失」诚实显示并禁进）。 */
  dir_exists?: boolean;
  /** per-workspace 图谱引擎旗标（null = 未显式选择，回退全局默认值）。 */
  graph_engine?: boolean | null;
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

/** 路径等值比较（大小写/斜杠不敏感——与 Rust registry norm_path 同规）。
 *  本地内联小函数：避免 import workspace.ts 巨型模块图进首页。 */
function isSamePath(a: string, b: string): boolean {
  return (
    a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  );
}

/** 该工作区的图谱旗标显示值：注册表未显式选择时回退全局默认。 */
function wsGraphOn(ws: KnownWorkspace): boolean {
  return ws.graph_engine ?? graphEngineEnabled(loadSettings());
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
  // listState 三态（2026-08-29 走查）：Rust 侧注册表缺席/毒化返回空表不报错，
  // 因此 RPC 失败必是真故障——不再把错误伪装成「还没有工作区」空态。
  const [workspaces, setWorkspaces] = useState<KnownWorkspace[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 内联改名（一次一张卡）。 */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 新建工作区 sheet（2026-08-31 拍板）：choose = 双路选择 / create = 命名创建。
   *  「指定已有目录」直接走系统选择器，不经 create 阶段。 */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetStage, setSheetStage] = useState<'choose' | 'create'>('choose');
  const [newWsName, setNewWsName] = useState('');
  /** 勾选项 = 「分析此目录」——per-workspace 图谱引擎旗标；默认取全局设置值。 */
  const [newWsEngine, setNewWsEngine] = useState(() => graphEngineEnabled(loadSettings()));
  /** 移除确认模态（2026-08-31 拍板「不做退路、确认做足」）：居中弹窗 + 勾选
   *  承认不可恢复后才能点亮红色删除键；取代旧的卡片内两段式点击确认。 */
  const [removeTarget, setRemoveTarget] = useState<KnownWorkspace | null>(null);
  const [removeAck, setRemoveAck] = useState(false);
  /** 创建页名字输入框焦点（noAutofocus 纪律：ref + effect 取代 autoFocus 属性）。 */
  const createNameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  useEffect(() => {
    if (sheetOpen && sheetStage === 'create') createNameInputRef.current?.focus();
  }, [sheetOpen, sheetStage]);

  // 刷新时机：挂载期 + 每次纸面板从开到关（回首页即重拉）。
  const paperOpen = useDockStore((s) => s.open.paper);
  useEffect(() => {
    if (paperOpen) return;
    let alive = true;
    void (async () => {
      try {
        const parsed = await typedJsonRpc<KnownWorkspace[]>('workspace_list', {});
        if (alive) {
          setWorkspaces(Array.isArray(parsed) ? parsed : []);
          setListState('ready');
        }
      } catch {
        if (alive) setListState('error');
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
      setListState('ready');
    } catch {
      setListState('error');
    }
  }, []);

  /** 进入工作区画布：打开纸面板 + （必要时）切到该工作区。
   *  摊开集由画布状态文件恢复（Stage-5 拍板 11）。
   *  目录已丢失的工作区禁进（调用侧守卫）。 */
  const onEnterWorkspace = useCallback(
    (ws: string) => {
      setRemoveTarget(null);
      openPanel('paper');
      const current = useShellStore.getState().projectPath;
      if (!isSamePath(ws, current)) {
        void workspaceFlow.switchWorkspace(ws);
      }
    },
    [openPanel],
  );

  /** 新建工作区 sheet：创建/指定双路（2026-08-31 拍板——一个按钮管两件事）。
   *  出生仪式在画布——sheet 只负责把工作区实体立起来（建目录/选目录 + 引擎勾选）。 */
  const onOpenCreateSheet = useCallback(() => {
    setNotice(null);
    setNewWsName('');
    setNewWsEngine(graphEngineEnabled(loadSettings()));
    setSheetStage('choose');
    setSheetOpen(true);
  }, []);

  /** 「创建」提交：命名 → ~/Documents/兰台/<名字> → activate（携引擎勾选）→ 进画布。 */
  const onCreateCommit = useCallback(async () => {
    const name = newWsName.trim();
    if (!name || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const path = await typedRpc('workspace_create_dir', { name });
      setSheetOpen(false);
      openPanel('paper');
      await workspaceFlow.switchWorkspace(path, { graphEngine: newWsEngine });
    } catch (e) {
      console.error('[home] workspace_create_dir failed:', e);
      setNotice(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [newWsName, newWsEngine, busy, openPanel]);

  /** 「指定已有目录」提交：系统选择器 → activate（携引擎勾选）→ 进画布。 */
  const onPickCommit = useCallback(async () => {
    if (busy) return;
    const folder = await pickFolder();
    if (!folder) return;
    setSheetOpen(false);
    setNotice(null);
    setBusy(true);
    try {
      openPanel('paper');
      await workspaceFlow.switchWorkspace(folder, { graphEngine: newWsEngine });
    } catch (e) {
      console.error('[home] pick workspace failed:', e);
      setNotice(`打开失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, newWsEngine, openPanel]);

  /** 图谱徽标切换（per-workspace 引擎旗标，2026-08-31 拍板方案一）。
   *  生效语义 = 装配期一次（在途不活拆）——切的是当前激活工作区时提示下次进入生效。 */
  const onToggleGraphEngine = useCallback(
    async (ws: KnownWorkspace) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const next = !wsGraphOn(ws);
        await typedRpc('workspace_set_graph_engine', { path: ws.path, enabled: next });
        await refreshWorkspaces();
        const current = useShellStore.getState().projectPath;
        if (isSamePath(ws.path, current)) {
          setNotice(`「${wsDisplayName(ws)}」图谱引擎已${next ? '开启' : '关闭'}——生效于下次进入该工作区`);
        }
      } catch (e) {
        console.error('[home] workspace_set_graph_engine failed:', e);
        setNotice(`图谱开关失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshWorkspaces],
  );

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

  /** 移除工作区（彻底：连带删其中全部案卷）——模态 + 勾选确认后执行。
   *  「不做退路」拍板（2026-08-31）：没有「仅移出清单」选项；Rust 侧删除
   *  失败会报错且保留登记（不产生孤儿卷）。 */
  const onRemoveConfirmed = useCallback(
    async (ws: KnownWorkspace) => {
      setBusy(true);
      setNotice(null);
      try {
        await typedRpc('workspace_remove', { path: ws.path });
        setRemoveTarget(null);
        setRemoveAck(false);
        await refreshWorkspaces();
        setNotice(
          `已移除工作区「${wsDisplayName(ws)}」${ws.session_count > 0 ? `（含 ${ws.session_count} 卷案卷）` : ''}`,
        );
      } catch (e) {
        console.error('[home] workspace_remove failed:', e);
        setNotice(`移除失败: ${e instanceof Error ? e.message : String(e)}`);
        setRemoveTarget(null);
        setRemoveAck(false);
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
          <span className="sh-seal" role="img" aria-label="印章：蘭臺"></span>
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
        <h1 className="sh-h1">
          与 Agent 协作，应当像在纸上书写<span className="sh-ju">。</span>
        </h1>
        <p className="sh-lead">
          一个工作区就是一张纸：新建或指定一个目录，摊开多少卷都在同一片纸上——可对照、可钉住、可追溯。
        </p>

        <div className="sh-section-title">
          <span className="t">工作区</span>
          <span className="n">WORKSPACES · {workspaces.length}</span>
        </div>

        {listState === 'loading' ? (
          <p className="sh-empty-hint">载入工作区清单…</p>
        ) : listState === 'error' ? (
          <p className="sh-notice">
            工作区清单读取失败。
            <button type="button" className="sh-retry" onClick={() => void refreshWorkspaces()}>
              重试
            </button>
          </p>
        ) : workspaces.length > 0 ? (
          <div className="sh-workspaces">
            {workspaces.map((w) => {
              const isRenaming = renamingPath === w.path;
              const isDead = w.dir_exists === false;
              return (
                <div key={w.path} className={`sh-ws-card sh-ws-card--row${isDead ? ' sh-ws-card--dead' : ''}`}>
                  <button
                    type="button"
                    className="sh-ws-card-main"
                    onClick={() => {
                      if (isDead) {
                        setNotice(`「${wsDisplayName(w)}」的目录已丢失——无法进入。可移除该工作区，或恢复目录后再试`);
                        return;
                      }
                      onEnterWorkspace(w.path);
                    }}
                    aria-label={
                      isDead
                        ? `工作区目录已丢失：${wsDisplayName(w)}`
                        : `进入工作区：${wsDisplayName(w)}（${w.session_count} 卷）`
                    }
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
                      {isDead
                        ? '目录已丢失 · 无法访问案卷'
                        : `图谱${wsGraphOn(w) ? '开' : '关'} · ${
                            w.session_count > 0
                              ? `${w.session_count} 卷 · 最近 ${formatSessionDate(w.latest_saved_at)}`
                              : '空工作区 · 还没有案卷'
                          }`}
                    </span>
                    <span className="sh-ws-enter">进入画布 →</span>
                  </button>
                  {!isRenaming && (
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
                        title={`图谱引擎${wsGraphOn(w) ? '关闭' : '开启'}（本工作区，下次进入生效）`}
                        disabled={busy}
                        onClick={() => void onToggleGraphEngine(w)}
                      >
                        {wsGraphOn(w) ? '关图谱' : '开图谱'}
                      </button>
                      <button
                        type="button"
                        title="移除工作区（连带删除其中的全部案卷）"
                        disabled={busy}
                        onClick={() => {
                          setRemoveTarget(w);
                          setRemoveAck(false);
                        }}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sh-empty-hint">还没有工作区——新建或指定一个目录，从一卷新案卷开始。</p>
        )}
        {notice && <p className="sh-notice">{notice}</p>}

        <div className="sh-actions">
          <button type="button" className="sh-btn-primary" onClick={onOpenCreateSheet}>
            ＋ 新建工作区
          </button>
        </div>
      </main>

      {/* 新建工作区 sheet（2026-08-31 拍板：一个按钮，指定或创建） */}
      {sheetOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消
        <div
          className="sh-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div className="sh-modal" role="dialog" aria-modal="true" aria-label="新建工作区">
            {sheetStage === 'choose' ? (
              <>
                <div className="sh-modal-title">新建工作区</div>
                <div className="sh-modal-body sh-sheet-choose">
                  <button type="button" className="sh-sheet-opt" onClick={() => setSheetStage('create')}>
                    <span className="sh-sheet-opt-t">创建新目录</span>
                    <span className="sh-sheet-opt-d">在「文档 / 兰台」下按名字建一个新文件夹</span>
                  </button>
                  <button type="button" className="sh-sheet-opt" onClick={() => void onPickCommit()}>
                    <span className="sh-sheet-opt-t">指定已有目录</span>
                    <span className="sh-sheet-opt-d">选择磁盘上已有的文件夹作为工作区</span>
                  </button>
                </div>
                <div className="sh-modal-foot">
                  <button type="button" onClick={() => setSheetOpen(false)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="sh-modal-title">创建新目录</div>
                <div className="sh-modal-body">
                  <input
                    ref={createNameInputRef}
                    className="sh-modal-input"
                    value={newWsName}
                    placeholder="工作区名字…"
                    onChange={(e) => setNewWsName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void onCreateCommit();
                      }
                    }}
                  />
                  <label className="sh-modal-check">
                    <input type="checkbox" checked={newWsEngine} onChange={(e) => setNewWsEngine(e.target.checked)} />
                    分析此目录（代码图谱 + 文件监视）
                  </label>
                </div>
                <div className="sh-modal-foot">
                  <button type="button" onClick={() => setSheetStage('choose')}>
                    返回
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !newWsName.trim()}
                    onClick={() => void onCreateCommit()}
                  >
                    创建并进入
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 移除工作区模态（2026-08-31 拍板：不做退路、确认做足） */}
      {removeTarget && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消
        <div
          className="sh-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setRemoveTarget(null);
              setRemoveAck(false);
            }
          }}
        >
          <div className="sh-modal" role="dialog" aria-modal="true" aria-label="移除工作区">
            <div className="sh-modal-title">移除工作区「{wsDisplayName(removeTarget)}」</div>
            <div className="sh-modal-body">
              <p className="sh-modal-text">
                将删除该工作区的全部案卷（
                {removeTarget.session_count > 0 ? `${removeTarget.session_count} 卷` : '当前没有案卷'}
                ）并从清单移除——此操作不可恢复。
              </p>
              <label className="sh-modal-check">
                <input type="checkbox" checked={removeAck} onChange={(e) => setRemoveAck(e.target.checked)} />
                我了解{removeTarget.session_count > 0 ? ` ${removeTarget.session_count} 卷案卷` : '该工作区'}
                将被永久删除且不可恢复
              </label>
            </div>
            <div className="sh-modal-foot">
              <button
                type="button"
                onClick={() => {
                  setRemoveTarget(null);
                  setRemoveAck(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={!removeAck || busy}
                onClick={() => void onRemoveConfirmed(removeTarget)}
              >
                彻底删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 底部 footer：左 brand 右当前案卷状态 */}
      <footer className="sh-foot">
        <span>兰台 · 档案</span>
        <span>{totalVolumes > 0 ? `${totalVolumes} 卷案卷 · 就绪` : '尚无案卷'}</span>
      </footer>
    </div>
  );
}
