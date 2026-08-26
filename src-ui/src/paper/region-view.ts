// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/region-view — 流区渲染派生数据（PaperPanel 的最小隔离单元）类型。
//
// Stage-2/3 起 RegionView 内联在 PaperPanel.tsx；Stage-4 创作坞/目次带以
// 贡献行渲染在 PaperPanel 内（经 overlay-service），需要消费同一份派生数据
// ——本文件把类型外提为共享模块（纯类型零运行时，避免 PaperPanel ↔ 组件
// 的循环 import）。

import type { PaperPinnedState } from '../state/paper-store';
import type { SourcedBlock } from './block-model';
import type { PaperStrip } from './selection';
import type { StreamRegionState } from './space';
import type { FlowGeom, PinnedGeom } from './virtualize';

/** 单会话（流区）的完整渲染态——派生计算的最小隔离单元：
 *  一个会话吐字只重算它自己的栈（"单流区更新=常数"铁律）。 */
export interface RegionView {
  sessionId: string;
  sessionNum: number;
  label: string;
  anchor: StreamRegionState;
  blocks: SourcedBlock[];
  layout: Map<string, { x: number; y: number }>;
  flowGeom: FlowGeom[];
  pinnedGeom: PinnedGeom[];
  flowWindow: { first: number; lastExcl: number };
  visibleIds: Set<string>;
  seq: Map<string, string>;
  strips: PaperStrip[];
  pinned: PaperPinnedState;
  /** 流区内容顶（世界 y——最旧块顶） */
  regionTop: number;
  /** 流区内容底（世界 y = 锚点 y——最新块底边） */
  regionBottom: number;
  /** 流区容器高（世界单位，含头部留白） */
  regionHeight: number;
}
