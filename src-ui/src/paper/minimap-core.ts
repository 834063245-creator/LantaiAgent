// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/minimap-core — 小地图纯函数（R3 多卷版，2026-09-05）。
//
// 从 MinimapView（PaperPanel.tsx）抽出的投影/取色/墨条纯逻辑——可单测、
// 渲染层只管画。P2-3 性能纪律：墨条投影只依赖内容侧（blocks/layout/extent），
// 平移帧零重画由调用方（MinimapView 的 useEffect 依赖表）保证。

import type { SourcedBlock } from './block-model';
import type { InkCache } from './ink';
import { inkForBlock } from './ink';
import type { RegionView } from './region-view';

/** 墨迹投影所需的最小流区字段（RegionView 超集兼容）——R3 多卷版
 *  小地图的稳定快照类型：PaperPanel 以 sameKey 复合键缓存产出快照，
 *  pan 帧（内容不变）快照引用稳定 → MinimapView 墨迹 effect 零重画。 */
export type MinimapRegionInput = Pick<
  RegionView,
  'sessionId' | 'stubbed' | 'extent' | 'blocks' | 'layout' | 'flowGeom' | 'pinnedGeom' | 'lastBlockCount'
>;

/** 小地图内容包围盒（跨流区 + 公共物）→ 投影几何（屏幕 px）。
 *  原 MinimapView 内联公式抽离：等比缩放 + 居中留白。 */
export interface MinimapProjection {
  scale: number;
  offX: number;
  offY: number;
}

export function minimapProject(
  content: { x0: number; y0: number; x1: number; y1: number },
  W: number,
  H: number,
  pad = 8,
): MinimapProjection {
  const cw = Math.max(1, content.x1 - content.x0);
  const ch = Math.max(1, content.y1 - content.y0);
  const scale = Math.min((W - pad) / cw, (H - pad) / ch);
  const offX = (W - pad - cw * scale) / 2;
  const offY = (H - pad - ch * scale) / 2;
  return { scale, offX, offY };
}

/** 卷色盘：按卷序（sessionNum 循环）取古籍色——镜像 tokens.css 主色语汇。
 *  循环取色保证多卷至少可区分；测试钉住色值。 */
const REGION_COLORS = ['#a63a2e', '#2f4a5e', '#4a6b3a', '#7a5a3a', '#5e3a5e', '#3a5e5c'] as const;

export function regionColor(index: number): string {
  const c = REGION_COLORS[index % REGION_COLORS.length];
  return c ?? 'rgba(38, 34, 28, 0.6)';
}

/** 单卷在小地图上的墨条投影（画布坐标已换算到小地图内，含 pad 偏移）。
 *  非 stub 卷：用 blocks/layout 真墨（同活跃墨迹逻辑——每块 inkForBlock 条）；
 *  stub 卷（离屏）：extent 占位框 + blockCount 估算砖（不拖全量，P2-2 语义）。 */
export interface MinimapInkBar {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
}

export function inkBarsFor(
  region: MinimapRegionInput,
  foldedOf: (b: SourcedBlock) => boolean,
  inkCache: InkCache,
  content: { x0: number; y0: number; x1: number; y1: number },
  proj: MinimapProjection,
): MinimapInkBar[] {
  const out: MinimapInkBar[] = [];
  const { scale, offX, offY } = proj;
  const toX = (x: number) => 4 + (x - content.x0) * scale + offX;
  const toY = (y: number) => 4 + (y - content.y0) * scale + offY;

  if (region.stubbed) {
    // 离屏卷：extent 包围盒占位砖 + 内容量估算（stub 快照已知 blockCount）
    const e = region.extent;
    if (!e) return out;
    const w = Math.max(2, (e.x1 - e.x0) * scale);
    const h = Math.max(2, (e.y1 - e.y0) * scale);
    // 估算高度：blockCount 行 → 每行按 6px 折算（不要画满整框，留呼吸）
    const estH = Math.min(h, Math.max(3, (region.lastBlockCount ?? 0) * 6 * scale));
    out.push({ x: toX(e.x0), y: toY(e.y0), w, h: estH, kind: 'stub' });
    return out;
  }

  // 真墨：活跃/在视卷全量块墨条（等效原 P4b 逻辑，但放宽到任意卷）
  const flow = region.blocks.filter((b) => b.state === 'flow');
  // 块数 > 50 = 密度档：每块只画首行（缩略不逐行）
  const density = flow.length > 50;
  for (const b of flow) {
    const slot = region.layout.get(b.id);
    if (!slot) continue;
    const ink = inkForBlock(b, foldedOf(b), inkCache);
    const bar0 = ink.bars[0];
    if (!bar0) continue;
    const kind = b.kind;
    if (density) {
      out.push({
        x: toX(slot.x + bar0.x0),
        y: toY(slot.y),
        w: Math.max(1, bar0.w * scale),
        h: 1.5,
        kind,
      });
      continue;
    }
    const h = Math.max(0.5, ink.lineH * scale * 0.5);
    for (const bar of ink.bars) {
      out.push({
        x: toX(slot.x + bar.x0),
        y: toY(slot.y + bar.dy),
        w: Math.max(0.5, bar.w * scale),
        h,
        kind,
      });
    }
  }
  return out;
}

/** 卷在小地图上的包围盒框（非 stub 用 blocks/layout 真几何；stub 用 extent）。
 *  返回 null = 无内容（空卷）——调用方跳过画框。 */
export function regionFrame(
  region: MinimapRegionInput,
  content: { x0: number; y0: number; x1: number; y1: number },
  proj: MinimapProjection,
): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  if (region.stubbed) {
    const e = region.extent;
    if (!e) return null;
    x0 = e.x0;
    y0 = e.y0;
    x1 = e.x1;
    y1 = e.y1;
  } else {
    for (const g of region.flowGeom) {
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w);
      y1 = Math.max(y1, g.y + g.h);
    }
    for (const g of region.pinnedGeom) {
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w);
      y1 = Math.max(y1, g.y + g.h);
    }
    if (!Number.isFinite(x0)) return null;
  }
  const { scale, offX, offY } = proj;
  return {
    x: 4 + (x0 - content.x0) * scale + offX,
    y: 4 + (y0 - content.y0) * scale + offY,
    w: Math.max(2, (x1 - x0) * scale),
    h: Math.max(2, (y1 - y0) * scale),
  };
}

/** 视口框投影 clamp 到容器内（2026-09-05 红框事故保险丝）：content 极小/视口
 *  极大时，视口框的投影可能远超小地图容器——clamp 到 [2, W-2]×[2, H-2]，
 *  任意状况红框不溢出。纯函数便于测试。 */
export function clampViewportFrame(
  frame: { left: number; top: number; width: number; height: number },
  W: number,
  H: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.max(2, Math.min(W - 2, frame.left)),
    top: Math.max(2, Math.min(H - 2, frame.top)),
    width: Math.max(2, Math.min(W - 2, frame.width)),
    height: Math.max(2, Math.min(H - 2, frame.height)),
  };
}
