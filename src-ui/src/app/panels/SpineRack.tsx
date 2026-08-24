// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SpineRack — 书脊列（C8 多卷切换，2026-08-22 用户拍板走隐喻流派）。
//
// 职责收窄（会话统一 U3 / Q3 最小方案，2026-08-24）：本列只管「当前工作区
// 视图内摊开的卷」——全局目录（案卷首页 SessionsHome 单列表）是唯一总入口，
// 跨工作区续开/全部卷检索都走那里；此处不列全局目录、不记账、不做会话管理。
// 卡片排布/画布空间模型是挂起的独立议题（本组件届时演进为画布的开卷卡）。
//
// 隐喻：案头多卷并陈——左缘一列函套书脊（线装书脊在左、书口在右），
// 一卷一脊，当前卷「抽出一半」（朱砂侧条 + 深墨），点脊换卷（switchSession），
// 列尾虚脊「另起一卷」（createNewSession）。恒显（单卷也是一条脊——
// 机制可见性优先，藏了用户就找不到入口）。
//
// 题签：卷名默认「案卷 N」（首句自动命名沿用 autoTitleSessionIfDefault），
// 双击进入改名（renameSession——sess store 单写入口 + 改名即落盘）。
//
// 合卷：hover 书脊展开小卡（卷名 + 运行态 + 「合卷」钮）。合卷自动存
// （closeSession 内先落盘再 dispose——用户拍板「自动存比较好」）。
// 运行中的卷：合卷钮降级为「运行中」态（避免半途 dispose agent；
// abort 语义留给显式停止，不做静默杀）。至少保留一卷（closeSession 守卫）。
//
// 挂载：PaperPanel 左缘（书眉之下、画布之左）。app 组件，scoped store
// 经 getChatStore(core.panelId).sess 订阅；运行态经 agentSessionState
// 版本号 + exec.onChange 订阅（exec 是 zustand vanilla——订阅后 setState 触发）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import type { ExecStateInstance } from '../../agent/execution-state';
import { getChatStore } from '../../ui/chat-store';
import type { ChatCore } from '../chat/chat-core';
import './spine-rack.css';

/** 本地提示条（冷启动死路防护——同 PaperPanel localNotice 模式：
 *  无活跃会话时 chat-core 的 addNotice 被 _resolveSessionTarget 丢弃，
 *  书脊入口的失败必须纸面直示，否则零反馈 = 假阴性）。 */
function LocalNotice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="sr-notice">
      {text}
      <button type="button" onClick={onClose}>
        知道了
      </button>
    </div>
  );
}

/** 卷运行态快照（书脊小点）：isRunning 直读 exec store。 */
function readRunning(storeId: string, sid: number): boolean {
  const exec = agentSessionState.getExec(storeId, sid);
  return !!exec && exec.isRunning;
}

export function SpineRack({ core }: { core: ChatCore | null }) {
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [activeId, setActiveId] = useState<number>(-1);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  /* 会话列表 + 运行态同步：sess store 订阅（列表/活跃变更）+
   * agentSessionState 版本订阅（agent/exec 注册变化）→ 全量重读。
   * exec 的 isRunning 变化经各 exec.onChange 订阅触发重读（下面第二个 effect）。 */
  const resync = useCallback(() => {
    if (!core) return;
    const st = getChatStore(core.panelId).sess.getState();
    setSessions(st.sessions.map((s) => ({ id: s.id, label: s.label })));
    const active = st.sessions[st.activeIdx];
    setActiveId(active ? active.id : -1);
    const running = new Set<number>();
    for (const s of st.sessions) {
      if (readRunning(core.panelId, s.id)) running.add(s.id);
    }
    setRunningIds(running);
  }, [core]);

  useEffect(() => {
    if (!core) return;
    resync();
    const unSess = getChatStore(core.panelId).sess.subscribe(resync);
    const unAgents = agentSessionState.subscribe(resync);
    return () => {
      unSess();
      unAgents();
    };
  }, [core, resync]);

  /* exec isRunning 变化：对每个会话的 exec 挂 onChange（列表变化时重挂）。 */
  useEffect(() => {
    if (!core) return;
    const unsubs: Array<() => void> = [];
    for (const s of sessions) {
      const exec: ExecStateInstance | null = agentSessionState.getExec(core.panelId, s.id);
      if (exec) unsubs.push(exec.onChange(() => resync()));
    }
    return () => {
      for (const u of unsubs) u();
    };
    // sessions 依赖：新卷出现/合卷后重挂订阅
  }, [core, sessions, resync]);

  const onSwitch = useCallback(
    (id: number) => {
      if (!core || id === activeId) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx >= 0) core.switchSession(idx);
    },
    [core, activeId],
  );

  const onNewVolume = useCallback(() => {
    if (!core) return;
    // 冷启动死路防护：无 agent 工厂时 createNewSession 静默失败（addNotice 被
    // 丢弃）——前置检查给纸面直示（同 onSend 守卫）。
    const st = getChatStore(core.panelId).sess.getState();
    if (st.activeIdx < 0 || !st.sessions[st.activeIdx]) {
      setLocalNotice('当前没有活跃会话——请在设置中配置 API Key（书眉「设置」→ 提供方）后保存，保存后即可另起一卷。');
      return;
    }
    void core.createNewSession();
  }, [core]);

  const onClose = useCallback(
    (id: number) => {
      if (!core) return;
      // 运行中的卷不提供合卷（书脊小卡已降级显示，此处双保险）
      if (readRunning(core.panelId, id)) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx >= 0) core.closeSession(idx);
    },
    [core],
  );

  /* 双击改名：进入编辑态（输入框预填现名，Enter 提交 / Esc 取消 / 失焦提交） */
  const startRename = useCallback((id: number, label: string) => {
    setRenamingId(id);
    setDraftLabel(label);
  }, []);
  const commitRename = useCallback(() => {
    if (!core || renamingId === null) return;
    const next = draftLabel.trim();
    const cur = getChatStore(core.panelId)
      .sess.getState()
      .sessions.find((s) => s.id === renamingId);
    if (next && cur && cur.label !== next) {
      core.renameSession(renamingId, next);
    }
    setRenamingId(null);
  }, [core, renamingId, draftLabel]);
  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  if (!core) return null;

  return (
    <div className="sr-rack" role="tablist" aria-label="案卷书脊">
      {localNotice && <LocalNotice text={localNotice} onClose={() => setLocalNotice(null)} />}
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        const isRunning = runningIds.has(s.id);
        const isRenaming = renamingId === s.id;
        return (
          <div
            key={s.id}
            className={['sr-spine', isActive ? 'sr-active' : '', isRunning ? 'sr-running' : ''].join(' ')}
          >
            <button
              type="button"
              className="sr-spine-main"
              role="tab"
              aria-selected={isActive}
              title={isRenaming ? undefined : `${s.label}${isRunning ? '（运行中）' : ''} — 单击换卷 · 双击题签`}
              onClick={() => {
                if (!isRenaming) onSwitch(s.id);
              }}
              onDoubleClick={() => {
                if (!isRunning) startRename(s.id, s.label);
              }}
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="sr-rename-input"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingId(null);
                    }
                    e.stopPropagation();
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="sr-label" dir="ltr">
                  {s.label}
                </span>
              )}
              {isRunning && <span className="sr-run-dot" role="presentation" />}
            </button>
            {!isRenaming && (
              <div className="sr-hover-card">
                <div className="sr-hover-title">{s.label}</div>
                <div className="sr-hover-meta">{isRunning ? '运行中 · 不可合卷' : '单击换卷 · 双击改名'}</div>
                <button
                  type="button"
                  className="sr-close-btn"
                  disabled={isRunning || sessions.length <= 1}
                  onClick={() => onClose(s.id)}
                >
                  合卷（自动存）
                </button>
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="sr-new" title="另起一卷" onClick={onNewVolume}>
        <span className="sr-new-label">另起一卷</span>
      </button>
    </div>
  );
}
