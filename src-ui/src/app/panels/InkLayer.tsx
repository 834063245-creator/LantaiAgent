// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// InkLayer — 缩远墨迹层（P4 LOD）：远缩档的屏幕空间 canvas，把可见块的
// 「真墨」行条骨架画出来（paper/ink），替代整棵 DOM 块树——远看真卷轴全景。
// rAF 直读 canvas-view-store（不进 React 渲染帧——画布支「分层渲染」支柱）；
// 骨架几何缓存于 InkCache（签名命中零重算）。本层 pointer-events: none，
// 远缩导航仍走小地图 / 书脊 / Home 回原点。

import { useEffect, useRef } from 'react';
import type { SourcedBlock } from '../../paper/block-model';
import { worldToScreen } from '../../paper/canvas-math';
import { type InkCache, inkColorOf, inkForBlock, inkForText } from '../../paper/ink';
import type { RegionView } from '../../paper/region-view';
import type { PaperStrip } from '../../paper/selection';
import { useCanvasViewStore } from '../../state/canvas-view-store';

interface InkLayerProps {
  regionsRef: React.MutableRefObject<RegionView[]>;
  /** 有效折叠态（与 DOM 渲染同一 foldedOf——折叠块画桩条） */
  foldedOf: (b: SourcedBlock) => boolean;
  inkCache: InkCache;
  /** 公共物（工作区级）：纸条 + 孤儿钉快照块（源卷未摊开时仍要见墨） */
  strips: PaperStrip[];
  orphanBlocks: SourcedBlock[];
}

/** 墨条屏幕高：行高 × zoom 的一半（粗细感），clamp [1, 9]px。 */
function barH(lineH: number, zoom: number): number {
  return Math.max(1, Math.min(9, lineH * zoom * 0.5));
}

export function InkLayer({ regionsRef, foldedOf, inkCache, strips, orphanBlocks }: InkLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: regionsRef 是稳定 ref——rAF 每帧直读最新 regions，不进依赖
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const { view, canvasSize } = useCanvasViewStore.getState();
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(canvasSize.w * dpr);
      const H = Math.round(canvasSize.h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);
      // 视口世界矩形（外扩一屏——块半高粗判即可，多余墨条被画布裁掉）
      const vx0 = (0 - view.panX) / view.zoom - 600;
      const vx1 = (canvasSize.w - view.panX) / view.zoom + 600;
      const vy0 = (0 - view.panY) / view.zoom - 800;
      const vy1 = (canvasSize.h - view.panY) / view.zoom + 800;

      const drawBlock = (b: SourcedBlock, x: number, y: number): void => {
        const ink = inkForBlock(b, foldedOf(b), inkCache);
        const bottom = y + (ink.bars.length > 0 ? ink.bars[ink.bars.length - 1].dy + ink.lineH : 14);
        if (y > vy1 || bottom < vy0) return;
        ctx.fillStyle = inkColorOf(b.kind);
        const h = barH(ink.lineH, view.zoom);
        for (const bar of ink.bars) {
          const p = worldToScreen(view, x + bar.x0, y + bar.dy);
          if (p.y < -h || p.y > canvasSize.h + h || p.x > canvasSize.w || p.x + bar.w * view.zoom < 0) continue;
          ctx.fillRect(p.x, p.y, Math.max(2, bar.w * view.zoom), h);
        }
      };

      for (const r of regionsRef.current) {
        // 横向预筛（流区 x 区间与视口相交才进块循环）
        const half = r.anchor.width / 2;
        if (r.anchor.anchorX + half < vx0 || r.anchor.anchorX - half > vx1) continue;
        for (const b of r.blocks) {
          if (b.state === 'flow') {
            const slot = r.layout.get(b.id);
            if (!slot) continue;
            drawBlock(b, slot.x, slot.y);
          } else {
            drawBlock(b, b.x, b.y);
          }
        }
      }
      // 孤儿钉快照（公共物：源卷不在纸上也在墨）
      for (const b of orphanBlocks) drawBlock(b, b.x, b.y);
      // 纸条（外框 + 墨条）
      ctx.strokeStyle = '#55503f';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#55503f';
      for (const s of strips) {
        if (s.x > vx1 || s.x + s.w < vx0 || s.y > vy1 || s.y + 160 < vy0) continue;
        const p = worldToScreen(view, s.x, s.y);
        ctx.strokeRect(p.x, p.y, s.w * view.zoom, 96 * view.zoom);
        const ink = inkForText(s.text, s.w);
        const h = barH(ink.lineH, view.zoom);
        for (const bar of ink.bars) {
          const bp = worldToScreen(view, s.x + bar.x0, s.y + 34 + bar.dy);
          ctx.fillRect(bp.x, bp.y, Math.max(2, bar.w * view.zoom), h);
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [foldedOf, inkCache, strips, orphanBlocks]);

  return <canvas ref={canvasRef} className="pp-ink-layer" />;
}
