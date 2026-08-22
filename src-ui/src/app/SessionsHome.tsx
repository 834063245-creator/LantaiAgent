// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页（workspace-flip 批 1，D-W1-1 纯会话优先；
// V5 拆除 2026-08-22 后为纸壳关掉后的唯一去向——换卷/续开/绑定目录）。
//
// 入口三件：
//   - 新建案卷（零目录通用会话）/ 新建案卷 · 绑定目录（图谱后台预热）
//   - 项目会话：上次打开项目的 sessions（冷启动缓存图 source_root →
//     listSavedSessions）；无缓存 = 空
//   - 零目录会话：user_sessions_list RPC（~/.hologram/sessions/；
//     loadSessionFromDisk('') 经 sessionsDir 路由用户级目录）
//
// V5 拆除语义：旧「唤起聊天面板（summonPanel）」交互退役——「新建/续开」
// 直接开纸面板（纸壳是唯一主界面）；顶栏承载窗口拖拽与控制
// （decorations:false 的自定义标题栏职责自 CommandBar 迁来）。

import { useCallback, useEffect, useState } from 'react';
import { typedJsonRpc } from '../rpc-contract';
import { workspaceFlow } from '../shell/rows/workspace';
import { useDockStore } from '../state/dock-store';
import { ensureUserSessionsDir } from '../ui/chat-session';
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

/** 冷启动缓存图 meta 的 source_root（上次打开项目）——读一次，失败 = null */
async function lastProjectRoot(): Promise<string | null> {
  try {
    const meta = await typedJsonRpc<{ meta?: { source_root?: string } }>('load_graph_json', {});
    return meta?.meta?.source_root || null;
  } catch {
    return null;
  }
}

/** 顶栏拖拽窗口 — CSS -webkit-app-region: drag 无效时（Linux WM）用
 *  Tauri 原生拖拽兜底（与旧 CommandBar 同款策略）。 */
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

/** 标题栏双击最大化（点击区域不是按钮时） */
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
  const core = useCoreStore((s) => s.core);
  const openPanel = useDockStore((s) => s.openPanel);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<ProjectSession[]>([]);
  const [userSessions, setUserSessions] = useState<UserSession[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 零目录会话装配点（批 2）：目录缓存先于列表/续开解析
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

  /** 新会话（零目录通用会话）：占位 Agent 已由冷启动装配——开纸即聊 */
  const onNewSession = useCallback(() => {
    openPanel('paper');
  }, [openPanel]);

  /** 新会话 + 绑定目录：选目录 → switchWorkspace（图谱后台预热的入口）
   *  → 开纸面板。 */
  const onNewSessionWithDir = useCallback(() => {
    openPanel('paper');
    void workspaceFlow.switchWorkspace();
  }, [openPanel]);

  /** 续开项目会话：载盘 + 开纸 */
  const onResumeProject = useCallback(
    (s: ProjectSession) => {
      if (!core || !projectRoot) return;
      openPanel('paper');
      void core.loadSessionFromDisk(projectRoot, s.id);
    },
    [core, projectRoot, openPanel],
  );

  /** 续开零目录会话（批 2）：projectPath='' 路由用户级目录——载盘 + 开纸 */
  const onResumeUser = useCallback(
    (s: UserSession) => {
      if (!core) return;
      openPanel('paper');
      void core.loadSessionFromDisk('', s.id);
    },
    [core, openPanel],
  );

  return (
    <div className="sh-root">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 窗口拖拽热区（decorations:false 的标题栏——拖动/双击最大化是窗口语义非控件语义；实际可交互目标只有按钮） */}
      <header className="sh-titlebar" onPointerDown={handleBarPointerDown} onDoubleClick={handleBarDoubleClick}>
        <span className="sh-titlebar-drag" />
        <WinControls />
      </header>
      <div className="sh-brand">
        <span className="sh-seal" role="img" aria-label="印章：蘭臺">
          <b>蘭</b>
          <b>臺</b>
        </span>
        <h1>兰台</h1>
        <span className="sh-tagline">档案 · 工作台</span>
      </div>

      <div className="sh-actions">
        <button type="button" className="sh-primary-btn" onClick={onNewSession}>
          新建案卷
        </button>
        <button type="button" className="sh-secondary-btn" onClick={onNewSessionWithDir}>
          新建案卷 · 绑定目录
        </button>
      </div>

      {projectSessions.length > 0 && (
        <div className="sh-section">
          <div className="sh-section-title">{projectRoot}</div>
          {projectSessions.slice(0, 6).map((s) => (
            <button type="button" className="sh-session-row" key={s.id} onClick={() => onResumeProject(s)}>
              <span className="sh-session-label">{s.label || `案卷 ${s.id}`}</span>
              <span className="sh-session-meta">
                {s.msgCount} 条 · {s.savedAt}
              </span>
            </button>
          ))}
        </div>
      )}

      {userSessions.length > 0 && (
        <div className="sh-section">
          <div className="sh-section-title">通用案卷</div>
          {userSessions.slice(0, 6).map((s) => (
            <button type="button" className="sh-session-row" key={s.id} onClick={() => onResumeUser(s)}>
              <span className="sh-session-label">{s.label || `案卷 ${s.id}`}</span>
              <span className="sh-session-meta">
                {s.msg_count} 条 · {s.saved_at}
              </span>
            </button>
          ))}
        </div>
      )}

      {projectSessions.length === 0 && userSessions.length === 0 && (
        <p className="sh-empty-hint">从一卷新案卷开始——需要 Agent 干活时再绑目录。</p>
      )}
    </div>
  );
}
