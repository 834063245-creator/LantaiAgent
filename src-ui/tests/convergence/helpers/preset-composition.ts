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
//
// ①b（2026-08-23）：minimal 寻址 plugin 行——解析须在 withFirstPartyToolChannel
// 腰内做（贡献行在册才可寻址；phase-0 路径经 buildStandardRegistry 的腰
// 内惰性求值天然满足，本 helper 的调用方须腰内求值——standard 路径零
// 依赖不受影响）。
// B⑤（2026-08-24）：capability 域出厂表退役（十五项第一方 capability 经
// ctx.capabilities 通道注册）——phase-1 effective 快照消费
// composition.capabilities（fromRoster 装配蓝图），standard 与 minimal
// 两条路径的解析都必须在 withFirstPartyCapabilityChannel 腰内做
//（standard 的 capability 面 = 通道快照；minimal 另寻址 state-hooks
// key——无通道 = 空能力表/未知 key，快照会失真）。组合是值——解析产物
// 带出通道使用（compositionOverride 穿线）。

import { withFirstPartyCapabilityChannel } from '../../../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../../../src/composition/first-party-tools';
import { resolvePresetComposition } from '../../../src/composition/presets';
import { factoryComposition, type ResolvedComposition } from '../../../src/composition/roster';

/** 当前 preset 的组合解析产物（CONVERGENCE_PRESET 路由）。
 *  异步：preset 寻址 plugin 行/capability id 的解析在工具 + capability
 *  双通道腰内执行（贡献行与第一方 capability 在册——B⑤ 后 capabilities
 *  域的通道快照 = 生产出厂面）。 */
export async function resolveCurrentComposition(): Promise<ResolvedComposition> {
  const name = process.env.CONVERGENCE_PRESET || 'standard';
  return withFirstPartyToolChannel(() =>
    withFirstPartyCapabilityChannel(() => {
      if (name === 'standard') return factoryComposition();
      if (name === 'minimal') return resolvePresetComposition('minimal');
      throw new Error('[convergence] 未知 preset: ' + name + '（helpers/preset-composition 只路由 standard/minimal）');
    }),
  );
}
