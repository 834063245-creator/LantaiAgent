// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/measure-seam — 测量引擎接缝（批 9c-4a，2026-09-26）。
//
// 形状照抄批 6/7/8 的接缝：契约面住 `paper/measure-contract.ts`，实现在 9c-4b 之后由
// `plugins/builtin/paper-shell/` 的 apply 登记；**内核读点**（`paper/ink.ts` 与
// `state/messages-store.ts`）改走下方门面，于是「引擎住哪」对它们透明。
//
// 9c-4a 期的过渡态（**9c-4b 会删掉这两处**，判据写在施工单 §4）：
//   1. `KERNEL_DEFAULT` = 内核 `./measure` 的三个动词——引擎此刻仍在内核，故接缝先做**派发**
//      （产物登记的实现优先，否则用内核默认）；9c-4b 把 `KERNEL_DEFAULT` 换成 `null` +
//      fail-loud，同时引擎整件进包。
//   2. 本文件静态 import `./measure`：**无环**（measure 不反向 import 本文件），且保住了
//      「内核读点在引擎未登记时仍可用」的现状语义。
//
// 为什么单列接缝而不是直接调 `./measure`：9c-4b 的搬运只动本文件的三行 + 一次 `git mv`，
// 内核读点零改动（批 6/7 的同类批次实测：接缝先行的搬运不会把调用点卷进 diff）。

import {
  clearObservedHeightsForSession as kernelClearObservedHeightsForSession,
  inkSourcesFor as kernelInkSourcesFor,
  measureSignature as kernelMeasureSignature,
} from './measure';
import type { MeasureImplementation } from './measure-contract';

export type { InkSource, MeasureImplementation } from './measure-contract';

/** 9c-4a 过渡态的内核默认实现（9c-4b 删除 → `null` + fail-loud）。 */
const KERNEL_DEFAULT: MeasureImplementation = {
  inkSourcesFor: kernelInkSourcesFor,
  measureSignature: kernelMeasureSignature,
  clearObservedHeightsForSession: kernelClearObservedHeightsForSession,
};

let _impl: MeasureImplementation | null = KERNEL_DEFAULT;

/** 产物登记实现（9c-4b 起由 `paper-shell` 的 apply 调用；测试域可复现装载态）。 */
export function registerMeasureImplementation(impl: MeasureImplementation): void {
  _impl = impl;
}

/** 当前实现（未登记 = `KERNEL_DEFAULT`；9c-4b 后为 null）。 */
export function activeMeasureImplementation(): MeasureImplementation | null {
  return _impl;
}

/** 撤销登记（产物 fiber dispose 与测试复位共用；9c-4a 期回落内核默认）。 */
export function clearMeasureImplementation(): void {
  _impl = KERNEL_DEFAULT;
}

/** 缺实现时的具名错误（9c-4b 起会真正抛出：引擎缺席 = 纸面高度全崩）。 */
const PAPER_MEASURE_UNAVAILABLE =
  'PAPER_MEASURE_UNAVAILABLE: 纸面测量引擎缺席——请确认内置产物 hologram/paper-shell 已装载' + '（该产物不可禁用）。';

function requireImpl(): MeasureImplementation {
  if (!_impl) throw new Error(PAPER_MEASURE_UNAVAILABLE);
  return _impl;
}

// ── 门面（内核读面；签名与 `./measure` 同名同形，调用点零改写成本）──

/** 块墨迹走查（`paper/ink.ts` 的缓存未命中路径）。 */
export function inkSourcesFor(block: Parameters<MeasureImplementation['inkSourcesFor']>[0], folded: boolean) {
  return requireImpl().inkSourcesFor(block, folded);
}

/** 测量签名（`paper/ink.ts` 的墨迹缓存键）。 */
export function measureSignature(
  block: Parameters<MeasureImplementation['measureSignature']>[0],
  folded: boolean,
  sidecarFolded = false,
  sidecarOut = false,
): string {
  return requireImpl().measureSignature(block, folded, sidecarFolded, sidecarOut);
}

/** 清观察高度账的会话级切片（`state/messages-store.ts` 切卷/清态）。 */
export function clearObservedHeightsForSession(): void {
  requireImpl().clearObservedHeightsForSession();
}
