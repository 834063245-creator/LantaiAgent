// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 运行态域（paper-panel-split C1）——纸面运行态（2026-09-06 升格）：任一摊开
// 卷在跑 → 画布底缘石青细线呼吸 + 各在跑卷尾落笔点 + 书眉「行卷中」。
// 订阅面 = subscribeExecAll（exec 实例表变更 → 全部重挂 + 既有实例起停——
// 实例迟到/被换时捕获式订阅指空对象，start() 不可见）+ sess 列表（合卷/改名
// 重算清单）。单一真相 = runningSessions 集合，streamLive（呼吸线）由 size
// 派生，不单独持态。

import { useEffect, useState } from 'react';
import { agentSessionState, getChatStore } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 空运行集（引用恒定）——runningSessions state 的「无在跑」基值。 */
const NO_RUNNING_SESSIONS: ReadonlySet<number> = new Set<number>();

/** 运行集镜像（paper-panel-split C1，自 PaperPanel 2728-2766 域内原样搬入）。 */
export function useRunningSessions(core: PaperCore | null, activeSessionId: number | null) {
  const [runningSessions, setRunningSessions] = useState<ReadonlySet<number>>(NO_RUNNING_SESSIONS);
  useEffect(() => {
    if (!core) {
      setRunningSessions(NO_RUNNING_SESSIONS);
      return;
    }
    const sync = () => {
      // 运行态唯一读面（v43）：runningSessions = 本面板在跑的卷（含种类）。
      // 不再各自遍历 sess 表取账本实例——读面收成一处，与创作坞/侧栏/退出守卫同源。
      const next = new Set(agentSessionState.runningSessions(core.panelId).map((r) => r.sid));
      // 引用稳定守卫：rehang 期 sync 每实例表 bump 必发，无变化不动引用——
      // 下游 memo 链（含 TocStrip 等）不因空转重渲。
      setRunningSessions((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };
    const unExecAll = agentSessionState.subscribeExecAll(core.panelId, sync);
    const unSess = getChatStore(core.panelId).sess.subscribe(sync);
    return () => {
      unExecAll();
      unSess();
    };
  }, [core]);
  /** 任一摊开卷在跑——画布呼吸线（.pp-canvas.pp-stream-live）。 */
  const streamLive = runningSessions.size > 0;
  /** 活跃卷在跑——书眉「行卷中」（StatusLine 消费）。 */
  const activeRunning = activeSessionId != null && runningSessions.has(activeSessionId);
  return { runningSessions, streamLive, activeRunning };
}
