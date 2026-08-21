// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 会话首页（workspace-flip 批 1，D-W1-1 纯会话优先）。
//
// 启动一等入口：最近会话 + [新会话]（零目录通用会话）/ [新会话 + 绑定目录]。
// 替换 index.html 静态欢迎页（INITIALIZE WORKSPACE 选目录前置的时代结束）。
//
// 数据源（批 1 范围）：
//   - 项目会话：上次打开项目的 sessions（冷启动缓存图 source_root →
//     listSavedSessions）；无缓存 = 空
//   - 零目录会话：user_sessions_list RPC（~/.hologram/sessions/；批 2 起
//     可续开——loadSessionFromDisk('') 经 sessionsDir 路由用户级目录）
// 灰框纪律：结构对即可，视觉是 V2 契约的事。

import { useCallback, useEffect, useState } from 'react';
import { parseJson, typedRpc } from '../rpc-contract';
import { workspaceFlow } from '../shell/rows/workspace';
import { ensureUserSessionsDir } from '../ui/chat-session';
import { useCoreStore } from './chat/core-instance';
import { useShellStore } from './shell-store';

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
    const raw = await typedRpc('load_graph_json', {});
    const meta = JSON.parse(raw) as { meta?: { source_root?: string } };
    return meta?.meta?.source_root || null;
  } catch {
    return null;
  }
}

export function SessionsHome() {
  const core = useCoreStore((s) => s.core);
  const setView = useShellStore((s) => s.setView);
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
        const raw = await typedRpc('user_sessions_list', {});
        const parsed = parseJson<UserSession[]>(raw);
        if (alive) setUserSessions(Array.isArray(parsed) ? parsed : []);
      } catch {
        /* 用户级目录不存在 = 空（首启常态） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [core]);

  /** 新会话（零目录通用会话）：占位 Agent 已由冷启动装配——唤起聊天即聊 */
  const onNewSession = useCallback(() => {
    if (!core) return;
    core.summonPanel();
  }, [core]);

  /** 新会话 + 绑定目录：选目录 → switchWorkspace（图谱后台预热的入口） */
  const onNewSessionWithDir = useCallback(() => {
    setView('graph'); // 切工作区流程接管视图
    void workspaceFlow.switchWorkspace();
  }, [setView]);

  /** 续开项目会话：载盘 + 唤起面板 */
  const onResumeProject = useCallback(
    (s: ProjectSession) => {
      if (!core || !projectRoot) return;
      setView('graph');
      void core.loadSessionFromDisk(projectRoot, s.id).then(() => core.summonPanel());
    },
    [core, projectRoot, setView],
  );

  /** 续开零目录会话（批 2）：projectPath='' 路由用户级目录——载盘 + 唤起 */
  const onResumeUser = useCallback(
    (s: UserSession) => {
      if (!core) return;
      core.summonPanel();
      void core.loadSessionFromDisk('', s.id);
    },
    [core],
  );

  return (
    <div className="sh-root">
      <div className="sh-mark">◈</div>
      <h1>兰台</h1>

      <div className="sh-actions">
        <button type="button" className="sh-primary-btn" onClick={onNewSession}>
          新会话
        </button>
        <button type="button" className="sh-secondary-btn" onClick={onNewSessionWithDir}>
          新会话 · 绑定目录
        </button>
      </div>

      {projectSessions.length > 0 && (
        <div className="sh-section">
          <div className="sh-section-title">{projectRoot}</div>
          {projectSessions.slice(0, 6).map((s) => (
            <button type="button" className="sh-session-row" key={s.id} onClick={() => onResumeProject(s)}>
              <span className="sh-session-label">{s.label || `会话 ${s.id}`}</span>
              <span className="sh-session-meta">
                {s.msgCount} 条 · {s.savedAt}
              </span>
            </button>
          ))}
        </div>
      )}

      {userSessions.length > 0 && (
        <div className="sh-section">
          <div className="sh-section-title">通用会话</div>
          {userSessions.slice(0, 6).map((s) => (
            <button type="button" className="sh-session-row" key={s.id} onClick={() => onResumeUser(s)}>
              <span className="sh-session-label">{s.label || `会话 ${s.id}`}</span>
              <span className="sh-session-meta">
                {s.msg_count} 条 · {s.saved_at}
              </span>
            </button>
          ))}
        </div>
      )}

      {projectSessions.length === 0 && userSessions.length === 0 && (
        <p className="sh-empty-hint">从一条新会话开始——需要 Agent 干活时再绑目录。</p>
      )}
    </div>
  );
}
