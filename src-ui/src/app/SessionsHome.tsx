// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页（workspace-flip 批 1，D-W1-1 纯会话优先；
// V5 拆除 2026-08-22 后为纸壳关掉后的唯一去向——换卷/续开/绑定目录）。
//
// 版式对齐 prototype/lantai.html 案卷首页（2026-08-23 视觉迭代）：
// 顶部书眉（印章+兰台+设置入口）+ kicker + 大标题 + 描述 + 案卷列表
// （日期/标题/leader 点线/#编号·N 块）+ 新建按钮 + 底部 footer。
//
// 数据：真实会话消息（项目会话 listSavedSessions + 零目录 user_sessions_list）。
// 视觉契约：docs/design/lantai-design-spec.md（注疏横排 / 朱砂=人 / 圆角恒 0）。

import { useCallback, useEffect, useState } from 'react';
import { typedJsonRpc } from '../rpc-contract';
import { graphEngineEnabled, loadSettings } from '../settings';
import { workspaceFlow } from '../shell/rows/workspace';
import { useDockStore } from '../state/dock-store';
import { useUpdateStore } from '../state/update-store';
import { ensureUserSessionsDir } from '../ui/chat-session';
import { getChatStore } from '../ui/chat-store';
import { useCoreStore } from './chat/core-instance';
import { WinControls } from './WinControls';

/** 零目录会话行（Rust UserSessionEntry 同形） */
interface UserSession {
  id: number;
  label: string;
  msg_count: number;
  saved_at: string;
}

/** 项目会话行（listSavedSessions 产物同形） */
interface ProjectSession {
  id: number;
  label: string;
  msgCount: number;
  savedAt: string;
}

/** 冷启动缓存图 meta 的 source_root（上次打开项目）——读一次，失败 = null。 */
async function lastProjectRoot(): Promise<string | null> {
  if (!graphEngineEnabled(loadSettings())) {
    try {
      return await typedJsonRpc<string | null>('get_last_project', {});
    } catch {
      return null;
    }
  }
  try {
    const meta = await typedJsonRpc<{ meta?: { source_root?: string } }>('load_graph_json', {});
    return meta?.meta?.source_root || null;
  } catch {
    return null;
  }
}

/** 案卷日期列：MM-DD（原型 .session-row .date 同款） */
function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '——';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 顶栏拖拽窗口 — CSS -webkit-app-region: drag 无效时（Linux WM）用
 *  Tauri 原生拖拽兜底。 */
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

/** 合并两组会话并按 savedAt 降序；项目会话在前（原型「案卷」单一时间序） */
interface MergedSession {
  key: string;
  kind: 'project' | 'user';
  id: number;
  label: string;
  msgCount: number;
  savedAt: string;
}

export function SessionsHome() {
  const core = useCoreStore((s) => s.core);
  const openPanel = useDockStore((s) => s.openPanel);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<ProjectSession[]>([]);
  const [userSessions, setUserSessions] = useState<UserSession[]>([]);
  // L1 摊开标记：sess store 订阅（谁已摊开——首页卡片直示，点已开卷 = 换卷）
  const panelId = core?.panelId ?? null;
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!panelId) return;
    const sess = getChatStore(panelId).sess;
    const sync = () => {
      setOpenSet(new Set(sess.getState().sessions.map((s) => s.id)));
    };
    sync();
    const un = sess.subscribe(sync);
    return () => un();
  }, [panelId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await ensureUserSessionsDir();
      const root = await lastProjectRoot();
      if (!alive) return;
      setProjectRoot(root);
      if (root && core) {
        try {
          const list = await core.listSavedSessions(root);
          if (alive) setProjectSessions(list);
        } catch {
          /* 列表失败容忍（目录缺失 = 空列表常态） */
        }
      }
      try {
        const parsed = await typedJsonRpc<UserSession[]>('user_sessions_list', {});
        if (alive) setUserSessions(Array.isArray(parsed) ? parsed : []);
      } catch {
        /* 用户级目录不存在 = 空（首启常态） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [core]);

  const onNewSession = useCallback(() => {
    openPanel('paper');
    // L1 真新建（F1 空壳根治）：旧版只 openPanel——冷启动已恢复旧卷时，
    // 用户点「新建」看到的仍是旧对话。现直调 createNewSession（真建新卷）。
    // 无 key 冷启动死路防护同 SpineRack onNewVolume：无活跃会话时
    // createNewSession 的 addNotice 会被丢弃——前置检查给纸面直示。
    if (!core) return;
    const st = getChatStore(core.panelId).sess.getState();
    if (st.activeIdx < 0 || !st.sessions[st.activeIdx]) {
      window.console.warn('[SessionsHome] 无活跃会话（API Key 未配置？）——新建未执行');
      return;
    }
    void core.createNewSession();
  }, [core, openPanel]);

  const onNewSessionWithDir = useCallback(() => {
    openPanel('paper');
    void workspaceFlow.switchWorkspace();
  }, [openPanel]);

  const onResumeProject = useCallback(
    (s: ProjectSession) => {
      if (!core || !projectRoot) return;
      openPanel('paper');
      void core.loadSessionFromDisk(projectRoot, s.id);
    },
    [core, projectRoot, openPanel],
  );

  const onResumeUser = useCallback(
    (s: UserSession) => {
      if (!core) return;
      openPanel('paper');
      void core.loadSessionFromDisk('', s.id);
    },
    [core, openPanel],
  );

  /** 合并 + 按 savedAt 降序，最新在最上（原型「案卷 Nº 12」在前） */
  const merged: MergedSession[] = [
    ...projectSessions.map(
      (s): MergedSession => ({
        key: `p-${s.id}`,
        kind: 'project',
        id: s.id,
        label: s.label,
        msgCount: s.msgCount,
        savedAt: s.savedAt,
      }),
    ),
    ...userSessions.map(
      (s): MergedSession => ({
        key: `u-${s.id}`,
        kind: 'user',
        id: s.id,
        label: s.label,
        msgCount: s.msg_count,
        savedAt: s.saved_at,
      }),
    ),
  ].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());

  const activeKey = merged.length > 0 ? merged[0].key : null;
  const onOpenSettings = useCallback(() => openPanel('settings'), [openPanel]);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  return (
    <div className="sh-root">
      {/* 顶部书眉：印章 + 兰台 wordmark + tagline · 右侧设置入口 + 窗口控制 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 窗口拖拽热区（decorations:false 的标题栏——拖动/双击最大化是窗口语义非控件语义；实际可交互目标只有按钮） */}
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

      {/* 主区：kicker + 大标题 + 描述 + 案卷列表 + 新建按钮 */}
      <main className="sh-main">
        <p className="sh-kicker">兰台 · 档案</p>
        <h1 className="sh-h1">与 Agent 协作，应当像在纸上书写。</h1>
        <p className="sh-lead">
          在纸面上向 Agent
          拟文，它的每一次思考、读码与计划，都作为注疏落进同一卷案卷——可对照、可钉住、可追溯。没有喧闹的界面，只有一部装得下你全部工作的案卷。
        </p>

        <div className="sh-section-title">
          <span className="t">案卷</span>
          <span className="n">DOSSIERS · {merged.length}</span>
        </div>

        {merged.length > 0 ? (
          <div className="sh-sessions">
            {merged.slice(0, 8).map((s) => {
              const opened = openSet.has(s.id);
              return (
                <button
                  type="button"
                  key={s.key}
                  className={`sh-session-row${s.key === activeKey ? ' active' : ''}${opened ? ' open' : ''}`}
                  onClick={() =>
                    s.kind === 'project'
                      ? onResumeProject({ id: s.id, label: s.label, msgCount: s.msgCount, savedAt: s.savedAt })
                      : onResumeUser({ id: s.id, label: s.label, msg_count: s.msgCount, saved_at: s.savedAt })
                  }
                  aria-label={`打开案卷：${s.label || `案卷 ${s.id}`}${opened ? '（已在案头）' : ''}`}
                >
                  <span className="date">{formatSessionDate(s.savedAt)}</span>
                  <span className="title">{s.label || `案卷 ${s.id}`}</span>
                  <span className="leader" aria-hidden="true" />
                  <span className="meta">
                    {opened && <span className="open-mark">已摊开</span>}#{s.id} · <b>{s.msgCount}</b> 块
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="sh-empty-hint">从一卷新案卷开始——需要 Agent 干活时再绑目录。</p>
        )}

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
        <span>{merged.length > 0 ? `案卷 Nº ${merged[0].id} · 进行中` : '尚无案卷'}</span>
      </footer>
    </div>
  );
}
