// Convergence 测试基建 — preset 维度（S1-0，设计件 designs/S1-convergence-per-preset.md §2）。
//
// Preset = 命名的行集合 + 组合序。
//   standard = 恰好等于现行装配：内置行按现行表序、外部贡献为空集。
//   minimal（S4-1b freeze，CR 用户批准）= 从运行时 preset 表派生：
//   composition/presets.ts 的 minimal（禁 builtin/browser-desktop +
//   builtin/web 工具行 + graph-hooks capability）经 resolvePresetComposition
//   派生行集合——真源单一，minimal 定义改了这里自动跟（不手抄清单）。
//
// 确定性按构造保证，不按环境保证（§2.3 关键修正）：
//   specs 构造装配时显式传贡献集——贡献集是 preset 定义的纯函数，
//   不是「测试环境装没装插件」的函数。测试环境/用户机器状态不影响 gate 结果。
//
// baseline 布局（§2.2 零迁移）：
//   standard（含缺省）→ baseline/phase-N/ 原地不动（按定义它就是 standard 快照）；
//   其他 preset → baseline/preset-<name>/phase-N/，产生自独立 freeze commit。

import type { Tool } from '../../../src/agent/tool';
import { resolvePresetComposition } from '../../../src/composition/presets';
import type { BuiltinToolRow } from '../../../src/composition/tool-rows';

/** 行贡献：一行可装配的工具（S1 期间行在 TS 常量表过渡；S2 起数据文件化）。
 *  id 供装载期寻址与冲突报告；factory 保证行未装配时零副作用。 */
export interface ToolContribution {
  id: string;
  factory: () => Tool;
}

export interface PresetDefinition {
  name: string;
  /** 组合序 = 数组序（前缀缓存语义依赖此序，S1-3 起由行表固化）。 */
  contributions: ToolContribution[];
  /** preset 解析产物的工具行（S4-1b minimal——减法型 preset 的行集合；
   *  undefined = 加法型 preset（standard——出厂行表 + contributions）。 */
  toolRows?: BuiltinToolRow[];
}

/** standard preset：内置行 + 空贡献 = 现行装配（零漂移的参照系）。 */
export const STANDARD_PRESET: PresetDefinition = { name: 'standard', contributions: [] };

/** minimal preset（S4-1b freeze）：从运行时 preset 表派生（真源单一）。 */
export const MINIMAL_PRESET: PresetDefinition = {
  name: 'minimal',
  contributions: [],
  toolRows: resolvePresetComposition('minimal').tools,
};

/** 从环境解析 preset。
 *  缺省 standard（不设 CONVERGENCE_PRESET = 现行行为零变化——回滚保证）。
 *  未知 preset 显式报错，不静默回退 standard：回退会让 preset-<name> 的
 *  baseline 比对静默变成 standard 比对，防自证协议不允许。 */
export function resolvePreset(env: NodeJS.ProcessEnv = process.env): PresetDefinition {
  const name = env.CONVERGENCE_PRESET || 'standard';
  if (name === 'standard') return STANDARD_PRESET;
  if (name === 'minimal') return MINIMAL_PRESET;
  // 非 standard preset 的行集合在此登记（先定义、后 freeze baseline，两步走）。
  throw new Error(
    '[convergence] 未知 preset: ' +
      name +
      '。preset 行集合需在 helpers/presets.ts 登记并经独立 freeze commit' +
      '（CONVERGENCE_RECORD=1 + change request 审批）生成 baseline/preset-' +
      name +
      '/ 快照后才能参与比对。',
  );
}

/** baseline 子目录前缀：standard → ''（沿用 baseline/phase-N/ 原地布局，零迁移）；
 *  其他 preset → 'preset-<name>/'。snapshot.ts 的路径解析统一走这里。 */
export function presetBaselineDir(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.CONVERGENCE_PRESET || 'standard';
  return name === 'standard' ? '' : 'preset-' + name + '/';
}
