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

import type { MouseEvent as ReactMouseEvent } from 'react';
import { createContext, useContext } from 'react';
import type { SourcedBlock } from './block-model';
import type { InkCache } from './ink';
import type { MinimapRegionInput } from './minimap-core';
import type { WorldRect } from './region-geom-contract';
import type { RegionView } from './region-view';

/** 创作坞消费的低频上下文（动作 + 活跃会话）。 */
export interface PaperDockContextValue {
  /** 当前活跃会话 id（sess store 单一权威的镜像；null = 无活跃）。 */
  activeSessionId: string | null;
  /** 视口飞到指定会话的指定世界 y（目次带点击跳转 / 书脊定位同族）。 */
  flyToPoint: (sessionId: string, worldY: number) => void;
  /** 无目标卷视口飞行（小地图点击跳转——视口中心滑到该世界点，保 zoom）。 */
  glideTo: (worldX: number, worldY: number) => void;
  /** **创作坞拖动锁能力位**（2026-09-17 用户方案）：纸壳（槽主人）持锁态与写面，
   *  坞只在书眉工具行渲染那枚单字工具（`移` ↔ `锁`）。按能力位纪律（同 token 账本
   *  「不实现 = 无读数，不炸链路」）：**宿主不给 = 坞不渲染该工具**，其余照旧
   *  ——「只重载单个产物」的版本偏斜窗口里不会炸。 */
  composerLock?: { unlocked: boolean; toggle: () => void };
  /** **图版架手势能力位**（2026-09-23 丙案 §9.5）：架归**产物流**（compose-dock 的
   *  AssetRack），而两个手势的机制在**槽主人**手里——架不另起一套拖拽/折叠机制
   *  （「同一个动作一个实现」）。按能力位纪律（同 composerLock）：**宿主不给 =
   *  该手势不发生**，架其余部分照旧（只重载单个产物的版本偏斜窗口里不炸）。
   *  - `expandBlock`：架上签条单击时若该块处于收起态则**连展开**（折叠覆盖表在
   *    槽主人手里，架碰不到）；
   *  - `dragBlockOut`：架上签条按住拖出 = **复用既有钉手势**（use-paper-drag 的
   *    D-R2-1 路径：跟手预览 → 松手定夺，纸上落钉 = 公共物）。 */
  expandBlock?: (blockId: string) => void;
  dragBlockOut?: (e: ReactMouseEvent, block: SourcedBlock) => void;
}

/** 目次带消费的高频上下文（流区派生几何）。 */
export interface PaperRegionContextValue {
  regions: RegionView[];
  activeSessionId: string | null;
  viewRect: WorldRect;
  canvasSize: { w: number; h: number };
  /** 创作坞**几何**（2026-09-17）：`bottom` = 视口底 → 坞下边（无覆盖时 = 出厂抬高
   *  96），`height` = 坞实测高。**不代算**，由两家消费面各按自己的规矩派生：
   *   - **让位带** = `bottom + height`（坞的**实际位置**）——会被坞当场压住的贴底件
   *     （小地图默认位；CSS 侧的递牒卡宿主 / 插件 dock 走 `--composer-band`）；
   *   - **出厂底带** = `96 + height`——**目次带专用**（用户 2026-09-17 裁定：
   *     目次带不随坞浮动而压缩，只按出厂位让位，护住「内容尾不藏进坞后」那条
   *     2026-09-01 实机整改）。取代旧的 `composerHeight`（坞实测高单值）。 */
  composerDock: { bottom: number; height: number };
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
