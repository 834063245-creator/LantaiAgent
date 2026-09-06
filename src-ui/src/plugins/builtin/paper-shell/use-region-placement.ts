// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 新卷落位域（paper-panel-split C1）——未落位流区的默认落位 effect。
// 独立文件（不并入 use-region-move）因挂载序硬约束：本 effect 必须先于
// use-paper-viewport 的「重挂清除/R2 冷启动聚焦兜底」effect 执行——兜底要
// 读到落位后的 canvas.spread 才能定位首个摊开卷（见 paper-panel-split-plan §3）。

import { useEffect } from 'react';
import { getCanvasStore, nearestFreeRegion, useCanvasViewStore, viewportCenterWorld } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 新会话默认落位（paper-panel-split C1，自 PaperPanel 708-735 原样搬入）。
 *  Stage-5 用户拍板改：X 线性 → 最近空位，不分栏——未落位的流区落在「当前
 *  视口中心」最近的空列（X 吸附栅格，Y 取视口中心）。展开绑定视角聚焦（调用
 *  方 requestFocus）——落点可预期且一定看得到。ensureRegion 幂等——只补缺，
 *  不覆盖已摆放位置（重启恢复的位置不碰）。 */
export function useRegionPlacement(core: PaperCore | null, sessions: Array<{ id: number; label: string }>) {
  useEffect(() => {
    if (!core) return;
    const canvas = getCanvasStore(core.panelId).getState();
    const missing = sessions.filter((s) => !canvas.spread[String(s.id)]);
    if (missing.length === 0) return;
    const v = useCanvasViewStore.getState();
    const center = viewportCenterWorld(v.view, v.canvasSize.w, v.canvasSize.h);
    const occupied: Array<{ sessionId: string; anchorX: number; width: number }> = Object.entries(canvas.spread).map(
      ([sid, r]) => ({
        sessionId: sid,
        anchorX: r.anchorX,
        width: r.width,
      }),
    );
    for (const s of missing) {
      const sid = String(s.id);
      if (canvas.spread[sid]) continue;
      const region = nearestFreeRegion(occupied, center.x, center.y);
      canvas.ensureRegion(sid, region);
      occupied.push({ sessionId: sid, anchorX: region.anchorX, width: region.width });
    }
  }, [core, sessions]);
}
