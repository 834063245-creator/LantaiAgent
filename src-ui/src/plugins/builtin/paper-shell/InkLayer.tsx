// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// InkLayer — 缩远墨迹层（P4 LOD → P4c 远景三档，2026-09-06）：远缩档的屏幕
// 空间 canvas，把可见内容按档位画——
//   文字档（0.36-0.55）真文字缩微（真纸面质感，本档半可读成立）；
//   行影档（0.14-0.36）「文字的影子」——真行宽/真行距的墨条（与小地图同
//   语言），单块字号跌破可读阈的块也在此档就地降影；
//   剪影档（<0.14）块级墨影 + 文类色签边——段落节奏可见，不画逐行噪声。
// 远档接管卷名（地志标签语义——字号有下限，地图标签逻辑）。
// rAF 直读 canvas-view-store（不进 React 渲染帧——画布支「分层渲染」支柱）；
// 骨架（行文+几何）缓存于 InkCache（签名命中零重算）。本层 pointer-events:
// none，远缩导航仍走小地图 / 书脊 / Home 回原点。
//
// 2026-09-07（用户拍板：LOD 不再隐藏钉在画布上的卡片）：钉住块 / 纸条 /
// 孤儿钉在远缩档恒走 DOM 渲染（PaperPanel 不再以 lod 门控），本层只画
// **流块**墨迹——DOM 面与 canvas 面不叠画同一物（ink canvas 在世界层之上，
// 叠画即重影）。
//
// 像素对齐（P4c）：所有屏幕坐标取整到设备像素——半像素小字/细条加倍糊，
// 距离观感的第一杀手。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { useEffect, useRef } from 'react';
import type { InkCache, LodTier, RegionView, SourcedBlock } from './host';
import {
  INK_LABEL_ALPHA,
  INK_LABEL_MIN_PX,
  INK_SIL_ACCENT_ALPHA,
  INK_SIL_MASS_ALPHA,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LOD_TEXT_MIN_PX,
  lodTierOf,
  useCanvasViewStore,
  worldToScreen,
} from './host';

/** 卷名标签字体栈（= tokens.css --f-song 字面量——canvas ctx.font 不吃
 *  CSS var()，镜像纪律同墨色：改 token 两处同步）。 */
const LABEL_FONT_STACK = '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 墨源 rgb 基色（= tokens.css --ink-* 的 rgba(38,34,28,α) 同一瓶墨）。
 *  canvas 2D 不吃 CSS var，字面量在此单点声明——改墨色时与 tokens.css 同步。 */
const INK_RGB = '38, 34, 28';

interface InkLayerProps {
  regionsRef: React.MutableRefObject<RegionView[]>;
  /** 有效折叠态（与 DOM 渲染同一 foldedOf——折叠块画桩条） */
  foldedOf: (b: SourcedBlock) => boolean;
  inkCache: InkCache;
}

/** 桩条屏幕高（折叠/空块的短矩形——text 为空串的墨条走矩形路径）。 */
function stubH(zoom: number): number {
  return Math.max(1.5, Math.min(10, 14 * zoom * 0.6));
}

export function InkLayer({ regionsRef, foldedOf, inkCache }: InkLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: regionsRef 是稳定 ref——rAF 每帧直读最新 regions，不进依赖
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    /* 档位迟滞状态（帧内直读 zoom 判档——prev 持在闭包，边界独立迟滞
     * 防抖；与 React 侧 lodFar 同边界（paper/ink.ts 单一真源）。 */
    let tier: LodTier = 'text';

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const { view, canvasSize } = useCanvasViewStore.getState();
      tier = lodTierOf(view.zoom, tier);
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

      /* 设备像素对齐（P4c）：worldToScreen 出的是连续屏幕坐标，半像素起笔
       * 在小字/细条上= 双倍抗锯齿糊。snap = 取整到设备像素网格。 */
      const snap = (v: number): number => Math.round(v * dpr) / dpr;

      /* 单块绘制（文字档真缩微 / 其余档行影）。
       * 纸面坐标 = 块世界位（x, y）——流块来自 layout，钉住块用自身位。 */
      const drawBlock = (b: SourcedBlock, x: number, y: number): void => {
        const ink = inkForBlock(b, foldedOf(b), inkCache);
        const bottom = y + (ink.bars.length > 0 ? ink.bars[ink.bars.length - 1].dy + ink.lineH : 14);
        if (y > vy1 || bottom < vy0) return;
        // 文字档且字号够读 → 真文字缩微（本档的质感所在）
        if (tier === 'text' && ink.size * view.zoom >= LOD_TEXT_MIN_PX) {
          ctx.fillStyle = inkColorOf(b.kind);
          ctx.textBaseline = 'top';
          ctx.font = `${(ink.size * view.zoom).toFixed(2)}px ${ink.stack}`;
          for (const bar of ink.bars) {
            const p = worldToScreen(view, x + bar.x0, y + bar.dy);
            const px = snap(p.x);
            const py = snap(p.y);
            if (py < -20 || py > canvasSize.h + 20 || px > canvasSize.w || px + bar.w * view.zoom < 0) continue;
            if (bar.text) {
              ctx.fillText(bar.text, px, py);
            } else {
              ctx.fillRect(px, py, Math.max(2, bar.w * view.zoom), stubH(view.zoom));
            }
          }
          return;
        }
        // 行影档：文字的影子——真行宽/真行距墨条（距离墨量已兑水，见 INK_BAR_COLORS）
        ctx.fillStyle = inkBarColorOf(b.kind);
        const barH = Math.max(1.25, Math.min(3.5, ink.lineH * view.zoom * 0.55));
        for (const bar of ink.bars) {
          const p = worldToScreen(view, x + bar.x0, y + bar.dy);
          const px = snap(p.x);
          const py = snap(p.y);
          if (py < -6 || py > canvasSize.h + 6 || px > canvasSize.w || px + bar.w * view.zoom < 0) continue;
          const w = bar.text ? bar.w * view.zoom : Math.max(2, bar.w * view.zoom);
          ctx.fillRect(px, py, Math.max(1.25, w), barH);
        }
      };

      /* 卷剪影档：块级墨影 + 文类色签边——远看是「纸上有字的灰质」+ 段落
       * 节奏（签边色 = 文类远景化身），不画逐行。块足迹高从 flowGeom 真源取。 */
      const drawSilhouette = (b: SourcedBlock, x: number, y: number, w: number, h: number): void => {
        const bottom = y + h;
        if (y > vy1 || bottom < vy0) return;
        const p = worldToScreen(view, x, y);
        const ph = worldToScreen(view, x, bottom);
        const px = snap(p.x);
        const py = snap(p.y);
        const pw = Math.max(2, w * view.zoom);
        const phh = Math.max(1.25, ph.y - p.y);
        ctx.fillStyle = `rgba(${INK_RGB}, ${INK_SIL_MASS_ALPHA})`;
        ctx.fillRect(px, py, pw, phh);
        // 文类签边（左缘 2-4px 色条）
        ctx.fillStyle = inkBarColorOf(b.kind);
        ctx.globalAlpha = INK_SIL_ACCENT_ALPHA;
        ctx.fillRect(px, py, Math.min(4, Math.max(2, pw * 0.06)), phh);
        ctx.globalAlpha = 1;
      };

      /* 远档卷名（地志标签）：卷首头 DOM 退场后由本层接管——字号有下限
       * （地图标签逻辑），墨色 ink-1（卷首题字同色，朱砂=人铁律不挪用）。
       * 位置 = 卷首（regionTop - folioH 之上）世界位，横向居中卷宽。 */
      const drawRegionLabels = (): void => {
        if (tier === 'text') return;
        const labelPx = Math.max(INK_LABEL_MIN_PX, 32 * view.zoom);
        ctx.fillStyle = `rgba(${INK_RGB}, ${INK_LABEL_ALPHA})`;
        ctx.textBaseline = 'top';
        ctx.font = `700 ${labelPx.toFixed(2)}px ${LABEL_FONT_STACK}`;
        ctx.textAlign = 'center';
        for (const r of regionsRef.current) {
          const half = r.anchor.width / 2;
          if (r.anchor.anchorX + half < vx0 || r.anchor.anchorX - half > vx1) continue;
          const top = worldToScreen(view, r.anchor.anchorX, r.regionTop - r.folioH);
          const py = snap(top.y) - snap(labelPx * 1.6);
          if (py < -20 || py > canvasSize.h) continue;
          ctx.fillText(r.label || `案卷 ${r.sessionNum}`, snap(top.x), py);
        }
        ctx.textAlign = 'left';
      };

      /* 钉住块（含孤儿钉）与纸条不进本层——它们在远缩档仍走 DOM 渲染
       *（2026-09-07 用户拍板：LOD 不再隐藏钉在画布上的卡片），这里只画流块。 */
      if (tier === 'silhouette') {
        for (const r of regionsRef.current) {
          const half = r.anchor.width / 2;
          if (r.anchor.anchorX + half < vx0 || r.anchor.anchorX - half > vx1) continue;
          for (const b of r.blocks) {
            if (b.state !== 'flow') continue;
            const g = r.flowGeom.find((fg) => fg.id === b.id);
            if (!g) continue;
            drawSilhouette(b, g.x, g.y, b.w, g.h);
          }
        }
        drawRegionLabels();
        return;
      }

      for (const r of regionsRef.current) {
        // 横向预筛（流区 x 区间与视口相交才进块循环）
        const half = r.anchor.width / 2;
        if (r.anchor.anchorX + half < vx0 || r.anchor.anchorX - half > vx1) continue;
        for (const b of r.blocks) {
          if (b.state !== 'flow') continue;
          const slot = r.layout.get(b.id);
          if (!slot) continue;
          drawBlock(b, slot.x, slot.y);
        }
      }
      drawRegionLabels();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [foldedOf, inkCache]);

  return <canvas ref={canvasRef} className="pp-ink-layer" />;
}
