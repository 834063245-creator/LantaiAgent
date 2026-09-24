// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/region-view — 流区渲染派生数据（PaperPanel 的最小隔离单元）类型。
//
// Stage-2/3 起 RegionView 内联在 PaperPanel.tsx；Stage-4 创作坞/目次带以
// 贡献行渲染在 PaperPanel 内（经 overlay-service），需要消费同一份派生数据
// ——本文件把类型外提为共享模块（纯类型零运行时，避免 PaperPanel ↔ 组件
// 的循环 import）。

import type { SourcedBlock } from './block-model';
import type { WorkUnit } from './group';
import type { FlowGeom, PinnedGeom } from './region-geom-contract';
import type { StreamRegionState } from './space';

/** 单会话（流区）的完整渲染态——派生计算的最小隔离单元：
 *  一个会话吐字只重算它自己的栈（"单流区更新=常数"铁律）。
 *  Stage-5：公共物（钉住块/纸条）已升格为工作区级（state/canvas-store），
 *  不再随流区归属——本类型不含 strips/pinned，渲染层读全局画布状态。 */
export interface RegionView {
  sessionId: string;
  sessionNum: number;
  label: string;
  /** 立卷时刻（ISO）——卷首档行的「日期」。真源 = 卷日志头行（起卷当场 / 摊开磁盘卷），
   *  见 state/session-store 的 ChatSessionMeta.createdAt。旧卷缺席 = 档行不显日期
   *  （不编造）。 */
  createdAt?: string;
  anchor: StreamRegionState;
  blocks: SourcedBlock[];
  layout: Map<string, { x: number; y: number }>;
  flowGeom: FlowGeom[];
  pinnedGeom: PinnedGeom[];
  flowWindow: { first: number; lastExcl: number };
  visibleIds: Set<string>;
  seq: Map<string, string>;
  /** 流区内容顶（世界 y——最旧块顶） */
  regionTop: number;
  /** 流区内容底（世界 y = 锚点 y——最新块底边） */
  regionBottom: number;
  /** 流区容器高（世界单位，含头部留白） */
  regionHeight: number;
  /** 卷首头高度（世界单位，measureFolioHeadHeight 实测——流区框向上扩展包住卷首） */
  folioH: number;
  /** 工作单元（stream-rhythm 刀3：groupWorkUnits 产出原样进核心缓存）——
   *  目次带阶段导航（刀4）与阶段语义的消费源；stub 卷为空。 */
  units: readonly WorkUnit[];
  /** 阶段首块（stream-rhythm 刀2：来文块）——渲染层给阶段细线 + 阶段开卷语义。 */
  stageLeadIds: ReadonlySet<string>;
  /** 单元界首块（stream-rhythm 刀5 D：work 单元首成员且上方非来文）——
   *  渲染层给单元界短规线；叙述/恢复/墓碑不发。 */
  unitLeadIds: ReadonlySet<string>;
  /** 验证链毕块（stream-rhythm 刀5 C：verify 工作单元末成员，链毕判据见
   *  rhythmAssign）——渲染层给「✓ 阶段完成」锚消费。 */
  verifyDoneIds: ReadonlySet<string>;
  /** 正在书写的块 id（2026-09-06 纸面运行态：writingBlockIdOf 派生——
   *  source part 未干墨的最末块）。渲染层据此给湿墨尾点；全干/null。
   *  stub 卷为 null。 */
  writingBlockId: string | null;
  /** P2-2 卷级虚拟化（2026-09-02）：true = 视口外 stub——blocks/flowGeom 为空
   *  数组，跳过全量派生（translate/adapt/measure/layout）。消费面（小地图
   *  extent / 孤儿钉 openBlockIds / 页脚块数）用最近一次全量构建值：
   *  extent / lastBlockIds / lastBlockCount（regionExtentRef 登记）。
   *  活跃卷与拖拽/缩放中的卷永不 stub。 */
  stubbed?: boolean;
  extent?: { x0: number; y0: number; x1: number; y1: number };
  lastBlockIds?: ReadonlySet<string>;
  lastBlockCount?: number;
}
