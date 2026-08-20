// Convergence 测试基建 — preset 的组合解析入口（S4-1b）。
//
// standard → factoryComposition()（零漂移参照系——与 runtime 缺省组合的
// 行集合等价，但用独立解析保证「缺省路径未被动过」的收敛口径）；
// minimal → resolvePresetComposition('minimal')（与 helpers/presets 的
// MINIMAL_PRESET.toolRows 同源派生——真源单一）。
//
// phase-1 effective 快照经 createAgent 第 2 参（compositionOverride）消费；
// phase-0 full/plan 快照经 buildStandardRegistry(toolRows) 消费——两条
// 路径的行集合一致性由 preset 真源（composition/presets.ts）保证。

import { resolvePresetComposition } from '../../../src/composition/presets';
import { factoryComposition, type ResolvedComposition } from '../../../src/composition/roster';

/** 当前 preset 的组合解析产物（CONVERGENCE_PRESET 路由）。 */
export function resolveCurrentComposition(): ResolvedComposition {
  const name = process.env.CONVERGENCE_PRESET || 'standard';
  if (name === 'standard') return factoryComposition();
  if (name === 'minimal') return resolvePresetComposition('minimal');
  throw new Error('[convergence] 未知 preset: ' + name + '（helpers/preset-composition 只路由 standard/minimal）');
}
