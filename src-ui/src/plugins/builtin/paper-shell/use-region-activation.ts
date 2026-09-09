// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 激活域（paper-panel-split C4）——显式动作的活跃会话落定原语。
// 2026-09-10 拍板：浏览态自动跟随（视口中心命中 + 400ms 停留三道闸）整体
// 退役——猜意图的守卫群（手动 800ms/缩放 600ms/输入锁存/命中外扩）全是
// 为它服役的，一并拆除；活跃会话只由显式动作转移（点流区背景/键盘跳卷/
// 书脊定位/侧边栏/新建/摊开/恢复），换主恒可预期。

import { useCallback } from 'react';
import { getCanvasStore, getChatStore } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 激活域：把指定会话落定为活跃（显式动作共用出口）。 */
export function useRegionActivation(params: { core: PaperCore | null }) {
  const { core } = params;

  /* ── 流区激活（显式动作立即切：点流区背景 / 键盘跳卷）── */
  const activateRegion = useCallback(
    (sessionId: string) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => String(s.id) === sessionId);
      if (idx < 0) return;
      if (idx !== st.activeIdx) core.switchSession(idx);
      getCanvasStore(core.panelId).getState().setActiveRegion(sessionId);
    },
    [core],
  );

  return { activateRegion };
}
