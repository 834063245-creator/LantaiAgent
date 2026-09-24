// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 键盘走卷域（paper-panel-split C4）——画布对键盘党的入口（2026-08-30 中期
// 件）：Alt+↑↓ 块间 / Alt+←→ 卷间。块序 = 流序（尾=最新），以「视口中心
// 最近块」为基准 ±1 飞行（flyToPoint 复用，目次带同款动画）；卷间 = 激活 +
// 飞到流区。isEditing / 命令面板打开时不抢键；preventDefault 压 WebView 的
// Alt+←→ 导航。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect } from 'react';
import type { FlowGeom } from '../../../paper/region-geom-contract';
import type { RegionView } from './host';
import { getChatStore, useCanvasViewStore, useShellStore, viewportCenterWorld } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 键盘走卷（paper-panel-split C4，自 PaperPanel 2022-2094 域内原样搬入）。 */
export function useJumpKeys(params: {
  core: PaperCore | null;
  canvasSize: { w: number; h: number };
  regionsRef: MutableRefObject<RegionView[]>;
  flyToPoint: (sessionId: string, worldY: number) => void;
  flyToRegion: (sessionId: string) => void;
  activateRegion: (sessionId: string) => void;
}) {
  const { core, canvasSize, regionsRef, flyToPoint, flyToRegion, activateRegion } = params;

  const jumpBlock = useCallback(
    (dir: 1 | -1) => {
      if (!core) return;
      const sessSt = getChatStore(core.panelId).sess.getState();
      const active = sessSt.sessions[sessSt.activeIdx];
      if (!active) return;
      const region = regionsRef.current.find((r) => r.sessionId === String(active.id));
      if (!region) return;
      const geomById = new Map<string, FlowGeom>(region.flowGeom.map((g) => [g.id, g]));
      const flow = region.blocks.filter((b) => b.state === 'flow' && geomById.has(b.id));
      if (flow.length === 0) return;
      const view = useCanvasViewStore.getState().view;
      const centerY = viewportCenterWorld(view, canvasSize.w, canvasSize.h).y;
      let cur = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < flow.length; i++) {
        const g = geomById.get(flow[i].id);
        if (!g) continue;
        const d = Math.abs(centerY - (g.y + g.h / 2));
        if (d < best) {
          best = d;
          cur = i;
        }
      }
      const target = flow[Math.min(flow.length - 1, Math.max(0, cur + dir))];
      const g = geomById.get(target.id);
      if (!g) return;
      flyToPoint(region.sessionId, g.y + g.h / 2);
    },
    [core, flyToPoint, canvasSize.w, canvasSize.h, regionsRef],
  );
  const jumpRegion = useCallback(
    (dir: 1 | -1) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      if (st.sessions.length === 0) return;
      const next = Math.min(st.sessions.length - 1, Math.max(0, st.activeIdx + dir));
      if (next === st.activeIdx) return;
      const target = st.sessions[next];
      activateRegion(String(target.id));
      flyToRegion(String(target.id));
    },
    [core, activateRegion, flyToRegion],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (useShellStore.getState().paletteOpen) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        jumpBlock(e.key === 'ArrowDown' ? 1 : -1);
      } else {
        e.preventDefault();
        jumpRegion(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpBlock, jumpRegion]);
}
