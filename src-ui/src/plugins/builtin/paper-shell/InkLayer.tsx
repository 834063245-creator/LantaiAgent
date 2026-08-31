// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// InkLayer — 缩远墨迹层（P4 LOD 返工）：远缩档的屏幕空间 canvas，把可见块的
// 「真文字缩微」直绘出来（paper/ink：materializeLineRange 行原文 + 缩放字号
// fillText）——远看是真实的缩小纸面（真卷轴），替代抽象线条与整棵 DOM 块树。
// rAF 直读 canvas-view-store（不进 React 渲染帧——画布支「分层渲染」支柱）；
// 骨架（行文+几何）缓存于 InkCache（签名命中零重算）。本层 pointer-events:
// none，远缩导航仍走小地图 / 书脊 / Home 回原点。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { useEffect, useRef } from 'react';
import type { BlockInk, InkCache, PaperStrip, RegionView, SourcedBlock } from './host';
import { inkColorOf, inkForBlock, inkForText, useCanvasViewStore, worldToScreen } from './host';

interface InkLayerProps {
  regionsRef: React.MutableRefObject<RegionView[]>;
  /** 有效折叠态（与 DOM 渲染同一 foldedOf——折叠块画桩条） */
  foldedOf: (b: SourcedBlock) => boolean;
  inkCache: InkCache;
  /** 公共物（工作区级）：纸条 + 孤儿钉快照块（源卷未摊开时仍要见墨） */
  strips: PaperStrip[];
  orphanBlocks: SourcedBlock[];
}

/** 桩条屏幕高（折叠/空块的短矩形——text 为空串的墨条走矩形路径）。 */
function stubH(zoom: number): number {
  return Math.max(1.5, Math.min(10, 14 * zoom * 0.6));
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
      // 视口世界矩形（外扩一屏——块高粗判即可，多余墨迹被画布裁掉）
      const vx0 = (0 - view.panX) / view.zoom - 600;
      const vx1 = (canvasSize.w - view.panX) / view.zoom + 600;
      const vy0 = (0 - view.panY) / view.zoom - 800;
      const vy1 = (canvasSize.h - view.panY) / view.zoom + 800;

      const drawBlock = (b: SourcedBlock, x: number, y: number): void => {
        const ink = inkForBlock(b, foldedOf(b), inkCache);
        const bottom = y + (ink.bars.length > 0 ? ink.bars[ink.bars.length - 1].dy + ink.lineH : 14);
        if (y > vy1 || bottom < vy0) return;
        ctx.fillStyle = inkColorOf(b.kind);
        ctx.textBaseline = 'top';
        ctx.font = `${(ink.size * view.zoom).toFixed(2)}px ${ink.stack}`;
        for (const bar of ink.bars) {
          const p = worldToScreen(view, x + bar.x0, y + bar.dy);
          if (p.y < -20 || p.y > canvasSize.h + 20 || p.x > canvasSize.w || p.x + bar.w * view.zoom < 0) continue;
          if (bar.text) {
            ctx.fillText(bar.text, p.x, p.y);
          } else {
            ctx.fillRect(p.x, p.y, Math.max(2, bar.w * view.zoom), stubH(view.zoom));
          }
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
      // 纸条（外框 + 真文字缩微）——墨色=ink-2 alpha 墨 rgba(38,34,28,.7)
      ctx.strokeStyle = 'rgba(38, 34, 28, 0.7)';
      ctx.lineWidth = 1;
      for (const s of strips) {
        if (s.x > vx1 || s.x + s.w < vx0 || s.y > vy1 || s.y + 160 < vy0) continue;
        const p = worldToScreen(view, s.x, s.y);
        ctx.strokeRect(p.x, p.y, s.w * view.zoom, 96 * view.zoom);
        const ink = inkForText(s.text, s.w);
        ctx.fillStyle = 'rgba(38, 34, 28, 0.7)';
        ctx.textBaseline = 'top';
        ctx.font = `${(ink.size * view.zoom).toFixed(2)}px ${ink.stack}`;
        for (const bar of ink.bars) {
          const bp = worldToScreen(view, s.x + bar.x0, s.y + 34 + bar.dy);
          ctx.fillText(bar.text, bp.x, bp.y);
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [foldedOf, inkCache, strips, orphanBlocks]);

  return <canvas ref={canvasRef} className="pp-ink-layer" />;
}

// BlockInk 类型再导出（PaperPanel 端不直接消费，ink.ts 单一来源）
export type { BlockInk };
