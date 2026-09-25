// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/measure-seam — 测量引擎接缝（批 9c-4a 立，9c-4b 收口，2026-09-26）。
//
// 形状照抄批 6/7/8 的接缝：契约面住 `paper/measure-contract.ts`，实现由
// `plugins/builtin/paper-shell/` 的 apply 登记（登记口经包内宿主桥取用——§0.6 实机事故纪律）；
// **内核读点**（`paper/ink.ts` 的墨迹走查 + `state/messages-store.ts` 的切卷清态）走下方门面，
// 于是「引擎住哪」对它们透明：改版式 token / 测高算法从此免重建 exe。
//
// 9c-4b 收口（本版）：`KERNEL_DEFAULT` 已删——引擎整件随 `paper-shell` 包
// （`measure.ts` 2,016 + `type-tokens.ts` 807），无登记 = 具名 fail-loud
// （`PAPER_MEASURE_UNAVAILABLE`）。该产物名册标 `required`（不可禁用：引擎缺席 = 纸面高度全崩）。
//
// 登记表是**栈**（后注册胜 + 对称弹出，对齐 `composition/contribution-channel.ts` 的行语义）：
// 装配腰（`withFirstParty*Channel`）会加载并 dispose 贡献者 fiber，单值登记会被那次 dispose
// 抹掉（9h-5 实测）⇒ 常驻登记（`tests/setup.ts`）不被后来者的弹出波及。

import type { MeasureImplementation } from './measure-contract';

export type { InkSource, MeasureImplementation } from './measure-contract';

const _impls: MeasureImplementation[] = [];

/** 产物登记实现（`paper-shell` 包 apply 期调用；测试域由 `tests/setup.ts` 复现装载态）。 */
export function registerMeasureImplementation(impl: MeasureImplementation): void {
  _impls.push(impl);
}

/** 当前实现 = 栈顶（未登记 = null——诊断/测试面读用）。 */
export function activeMeasureImplementation(): MeasureImplementation | null {
  return _impls.at(-1) ?? null;
}

/** 对称撤销（产物 fiber dispose）：弹出**本 fiber 注册的那一层**，不波及更早的登记。 */
export function clearMeasureImplementation(): void {
  _impls.pop();
}

/** 测试复位（清空整栈；生产不调用）。 */
export function resetMeasureImplementationForTests(): void {
  _impls.length = 0;
}

/** 缺实现时的具名错误（引擎缺席 = 纸面高度全崩，不静默降级）。 */
const PAPER_MEASURE_UNAVAILABLE =
  'PAPER_MEASURE_UNAVAILABLE: 纸面测量引擎缺席——请确认内置产物 hologram/paper-shell 已装载' + '（该产物不可禁用）。';

function requireImpl(): MeasureImplementation {
  const impl = activeMeasureImplementation();
  if (!impl) throw new Error(PAPER_MEASURE_UNAVAILABLE);
  return impl;
}

// ── 门面（内核读面；签名与包内 `./measure` 同名同形，调用点零改写成本）──

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
