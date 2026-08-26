// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SpineRack — 书脊列 = 画布空间导航器（Stage-3，docs/plans/canvas-space/stage-3.md）。
//
// 隐喻：案头多卷并陈——左缘一列函套书脊，一卷一脊（只列**摊开**的卷；
// 未摊开的卷在侧边栏 SessionSidebar 管），当前卷「抽出一半」。
//
// 职责（2026-08-25 用户反馈收敛——书脊只管空间定位，功能别太多）：
//   - 左键 = 定位器：ctx.space.focus 切活跃会话 + canvas-view-store
//     requestFocus 让 PaperPanel 把摄像机轻动画飞到该流区最新块。
//   - 拖动 = 落位（抽书放桌）：按住书脊拖进画布，幽灵预览，松手在
//     「竖向不打架」的空列展开（pickDropAnchor：x 吸附网格 + 跳过占用列，
//     y 取用户落点），经 ctx.space.place 落位。
//   - hover 小卡 = 合卷（收起，数据保留；自动存）——改名/删除留在侧边栏
//     （会话管理那一摊）。右键菜单已按用户反馈移除。
//
// 挂载：画布导航插件贡献行（plugins/canvas-nav-plugin.ts → ctx.panels
// 注册 'canvas-spine' 面板，side:'left' + unmountOnClose），随纸面板开合。
// 消费 ctx.space（activeSpace() 读面 + 四命令），不新增核心 API。
// 视口动画经 canvas-view-store 与 PaperPanel 共享（app 级单例）。

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import type { ExecStateInstance } from '../../agent/execution-state';
import { activeSpace } from '../../composition/space-service';
import { screenToWorld } from '../../paper/canvas-math';
import { pickDropAnchor } from '../../paper/space';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { useDockStore } from '../../state/dock-store';
import { getChatStore } from '../../ui/chat-store';
import { useCoreStore } from '../chat/core-instance';
import './spine-rack.css';

/** 拖动阈值（px）：超过即视为拖脊（区分点击定位）。 */
const DRAG_THRESHOLD = 6;

/** 卷运行态快照（书脊小点）：isRunning 直读 exec store。 */
function readRunning(storeId: string, sid: number): boolean {
  const exec = agentSessionState.getExec(storeId, sid);
  return !!exec && exec.isRunning;
}

export const SpineRack = memo(function SpineRack() {
  const core = useCoreStore((s) => s.core);
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());

  /* 会话列表 + 运行态同步：sess store 订阅 + agentSessionState 版本订阅
   * + ctx.space 订阅（流区位置/活跃变化）→ 全量重读。 */
  const resync = useCallback(() => {
    if (!core) return;
    const st = getChatStore(core.panelId).sess.getState();
    setSessions(st.sessions.map((s) => ({ id: s.id, label: s.label })));
    const active = st.sessions[st.activeIdx];
    setActiveId(active ? active.id : null);
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
    const unSpace = activeSpace()?.subscribe(resync);
    return () => {
      unSess();
      unAgents();
      unSpace?.();
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
  }, [core, sessions, resync]);

  /* ── 手势 1：左键定位器 ── */
  const onLocate = useCallback(
    (id: number) => {
      if (!core) return;
      activeSpace()?.focus(String(id));
      useCanvasViewStore.getState().requestFocus(String(id));
    },
    [core],
  );

  /* ── 手势 2：拖动落位（抽书放桌）── */
  const dragRef = useRef<{ id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const onSpineMouseDown = useCallback((e: React.MouseEvent, id: number) => {
    if (e.button !== 0) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, moved: false };
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setGhost({ x: e.clientX, y: e.clientY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d?.moved || !core) return;
      // 画布坐标换算：读 .pp-canvas 的视口 rect（只读坐标，不建游离 DOM——
      // 书脊是 DockPanel 上层覆盖，跨组件取坐标是 ponytail 例外）。
      const rect = document.querySelector('.pp-canvas')?.getBoundingClientRect();
      if (!rect) return;
      const v = useCanvasViewStore.getState().view;
      const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const space = activeSpace();
      const regions = space?.getState().regions ?? [];
      const anchor = pickDropAnchor(regions, String(d.id), w.x, w.y);
      space?.place(String(d.id), anchor.anchorX, anchor.anchorY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── hover 小卡：合卷（收起，数据保留 + 自动存）── */
  const onClose = useCallback(
    (id: number) => {
      if (!core || readRunning(core.panelId, id)) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx >= 0) core.closeSession(idx);
    },
    [core],
  );

  if (!core) return null;

  return (
    <div className="sr-rack" role="tablist" aria-label="画布书脊（空间导航器）">
      <button
        type="button"
        className="sr-sidebar-toggle"
        title="会话侧边栏（可折叠）"
        onClick={() => useDockStore.getState().openPanel('canvas-sidebar')}
      >
        <span className="sr-sidebar-toggle-label">会话</span>
      </button>

      {sessions.map((s) => {
        const isActive = s.id === activeId;
        const isRunning = runningIds.has(s.id);
        return (
          <div
            key={s.id}
            className={['sr-spine', isActive ? 'sr-active' : '', isRunning ? 'sr-running' : ''].join(' ')}
          >
            <div
              className="sr-spine-main"
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              title={`${s.label}${isRunning ? '（运行中）' : ''} — 左键定位 · 拖动落位 · hover 合卷`}
              onClick={() => onLocate(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onLocate(s.id);
                }
              }}
              onMouseDown={(e) => onSpineMouseDown(e, s.id)}
            >
              <span className="sr-label" dir="ltr">
                {s.label}
              </span>
              {isRunning && <span className="sr-run-dot" role="presentation" />}
            </div>

            {/* hover 小卡：卷名 + 运行态 + 合卷钮（改名/删除在侧边栏——各管一摊） */}
            <div className="sr-hover-card">
              <div className="sr-hover-title">{s.label}</div>
              <div className="sr-hover-meta">{isRunning ? '运行中 · 不可合卷' : '左键定位 · 拖动落位'}</div>
              <button
                type="button"
                className="sr-close-btn"
                disabled={isRunning || sessions.length <= 1}
                onClick={() => onClose(s.id)}
              >
                合卷（自动存）
              </button>
            </div>
          </div>
        );
      })}
      {sessions.length === 0 && <div className="sr-empty">画布暂无摊开的卷</div>}

      {/* 拖动落位幽灵预览（屏幕坐标浮层——抽书放桌的即时应答） */}
      {ghost && (
        <div className="sr-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="sr-drag-ghost-tag">放桌</span>
        </div>
      )}
    </div>
  );
});
