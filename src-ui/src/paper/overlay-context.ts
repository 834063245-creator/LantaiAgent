// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/overlay-context — PaperPanel 向覆盖层贡献（创作坞/目次带/小地图）暴露的
// 数据与动作上下文（Stage-4）。
//
// 拆两个 context 的目的：创作坞是视口固定 UI，不应因平移/缩放（viewRect /
// regions 每帧变）而重渲染；目次带则需要 region 数据画刻度。所以：
//   - PaperDockContext：动作 + 活跃会话（低频变化）——ComposerDock 消费；
//   - PaperRegionContext：流区派生数据（高频）——TocStrip 消费。
// 两个都只由 PaperPanel 提供（画布上下文内部形态；覆盖层组件经插件贡献行
// 渲染在 PaperPanel 内，因此可安全消费）。
//
// 2026-09-05 插件化：小地图（paper-minimap 插件）也消费这两个 context——
// PaperRegionContext 补 minimap 数据面（内容包围盒 + 墨迹稳定快照 + 墨迹缓存，
// 全部是 PaperPanel 的 P2-3 缓存原样下发，引用稳定纪律不破），
// PaperDockContext 补 glideTo（无目标卷视口飞行——小地图点击跳转）。

import { createContext, useContext } from 'react';
import type { SourcedBlock } from './block-model';
import type { InkCache } from './ink';
import type { MinimapRegionInput } from './minimap-core';
import type { RegionView } from './region-view';
import type { WorldRect } from './virtualize';

/** 创作坞消费的低频上下文（动作 + 活跃会话）。 */
export interface PaperDockContextValue {
  /** 当前活跃会话 id（sess store 单一权威的镜像；null = 无活跃）。 */
  activeSessionId: string | null;
  /** 视口飞到指定会话的指定世界 y（目次带点击跳转 / 书脊定位同族）。 */
  flyToPoint: (sessionId: string, worldY: number) => void;
  /** 无目标卷视口飞行（小地图点击跳转——视口中心滑到该世界点，保 zoom）。 */
  glideTo: (worldX: number, worldY: number) => void;
}

/** 目次带消费的高频上下文（流区派生几何）。 */
export interface PaperRegionContextValue {
  regions: RegionView[];
  activeSessionId: string | null;
  viewRect: WorldRect;
  canvasSize: { w: number; h: number };
  /** 创作坞实际高度（rework P3-1——目次带底部随它定位） */
  composerHeight: number;
  /** 有效折叠态（2026-09-01 目次带 minimap 化：内容指纹与主渲染同一折叠
   *  真源——用户覆盖表 + defaultFolded 规则态，PaperPanel 原样下发）。 */
  foldedOf: (b: SourcedBlock) => boolean;
  /** 小地图数据面（2026-09-05 插件化）：PaperPanel 的 P2-3 缓存原样下发——
   *  content = 跨流区内容包围盒（含公共物），geo = 墨迹稳定快照（pan 帧
   *  引用稳定，canvas 重画零浪费），inkCache = 缩远墨迹缓存实例。 */
  minimap: { content: WorldRect; geo: MinimapRegionInput[] };
  inkCache: InkCache;
}

export const PaperDockContext = createContext<PaperDockContextValue | null>(null);
export const PaperRegionContext = createContext<PaperRegionContextValue | null>(null);

/** 创作坞消费面（必须在 PaperPanel 内渲染）。 */
export function usePaperDock(): PaperDockContextValue {
  const v = useContext(PaperDockContext);
  if (!v) throw new Error('usePaperDock 必须在 PaperPanel 内使用');
  return v;
}

/** 目次带/覆盖层数据消费面（必须在 PaperPanel 内渲染）。 */
export function usePaperRegion(): PaperRegionContextValue {
  const v = useContext(PaperRegionContext);
  if (!v) throw new Error('usePaperRegion 必须在 PaperPanel 内使用');
  return v;
}
