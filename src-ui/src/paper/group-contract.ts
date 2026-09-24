// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/group-contract — 工作单元**形状契约**（批 9c-3，2026-09-26）。
//
// 为什么类型留内核：`WorkUnit` 是内核区域视图模型（`paper/region-view.ts` 的 RegionView.units）
// 与外层（compose-dock 的阶段锚派生）共用的形状；**实现**（封套 pass：块序列 → 工作单元、
// 节奏档、封口判据）随 paper-shell 产物走。

import type { RhythmFamily } from './grammar';

/** 单元种类（版式语义，非工具语义——完整语义见 `plugins/builtin/paper-shell/group.ts` 头注）。 */
export type UnitKind = 'user' | 'work' | 'recovery' | 'narrative' | 'anchor' | 'annotation' | 'terminal' | 'artifact';

export interface WorkUnit {
  /** 单元 id：锚首成员块 id（`u:{blockId}`）——前缀扩展下 id 稳定。 */
  id: string;
  kind: UnitKind;
  /** 成员块 id（流序）；封口后只增不减。 */
  memberIds: string[];
  /** 封口 = 全部成员来自非 streaming 消息（回顾性稳定的边界）。 */
  sealed: boolean;
  /** 节律族（刀5 A）：work/recovery 单元已表态的工具族（读/写/验证/落款）；
   *  未表态（null）= 开放单元尚未被已知族认领——族不切节奏（other 兜底延伸）。
   *  verify 工作单元的链毕「阶段完成」锚（刀5 C）以此判据。 */
  family?: RhythmFamily | null;
}
