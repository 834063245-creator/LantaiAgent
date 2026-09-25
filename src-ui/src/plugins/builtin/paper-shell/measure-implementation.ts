// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-shell 测量实现面（批 9c-4b，2026-09-26）——登记进内核 `paper/measure-seam.ts` 的
// 唯一实现对象（形状 = 契约 `paper/measure-contract.ts` 的 `MeasureImplementation`）。
//
// 引擎本体（`measure.ts` 2,016 行 + 版式 token `type-tokens.ts` 807 行）就在本包内；
// 本文件只把内核真读的三个动词按契约面组装——内核读点（`paper/ink.ts` 的墨迹走查缓存键、
// `state/messages-store.ts` 的切卷清态）经门面取用，因此「引擎住哪」对它们透明。
//
// 实例所有权：引擎是**无状态纯函数集合 + 模块级观察高度账**，随包只有一份（产物域经宿主桥
// 登记进内核同一张表）——这正是 9c-4a 立接缝的目的：改版式 token 从此免重建 exe。

import type { MeasureImplementation } from '../../../paper/measure-contract';
import { clearObservedHeightsForSession, inkSourcesFor, measureSignature } from './measure';

export const measureImplementation: MeasureImplementation = {
  inkSourcesFor,
  measureSignature,
  clearObservedHeightsForSession,
};
