// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 capability 插件（P4 存量拆解 B⑤ 收官，agent-plugin-architecture-
// plan §5 B 表 ⑤）——十五项会话级能力（工具注册十件 + 表尾非工具五件）
// 全量经 ctx.capabilities 第八贡献通道贡献（插件形状对齐 B④
// prompt-segments-plugin 先例：定义留真源文件 agent/blueprint.ts 的
// firstPartyCapabilities()，插件只做装载接线）。
//
// 收官勘定（B⑤，2026-08-24）：
//   - 零漂移：注册序 = firstPartyCapabilities() 清单序 = 迁移前出厂表序
//     ——十五项全量经通道贡献后，通道在册环境的 factoryComposition()
//     capabilities 快照与迁移前出厂表逐项全等（convergence 双 preset
//     effective 快照守护，字节零漂移按构造成立；converge-tools 与
//     code-execution-tool 双双 install 期快照 visibleTools() 的表序依赖
//     由清单序保住——中间分批会击穿该依赖，故十五件单批收官）。
//   - 无实例缓存判断（与 tools 通道 rowCtx 锁存不同）：贡献是
//     AgentCapability 对象本体（install/when 是函数），install 每装配
//     重调、install 内 new 的对象每装配新鲜——①c 路线一同款语义。
//   - 寻址域：十五项 key 照旧进 roster capabilities 域（行 id = key），
//     patch/preset 寻址面不变（minimal 禁 graph-hooks 既有消费者零变化）；
//     解析须在 capability 通道在册环境（生产 = loadBuiltinPlugins 先于
//     bootShell 组合链；测试 = withFirstPartyCapabilityChannel 通道腰）。
//   - 出厂 builtinCapabilities() 退役：本通道是出厂 capability 面的唯一
//     来源（B④ builtinPromptSections 退役同款终态）。

import { firstPartyCapabilities } from '../agent/blueprint';
import type { Context } from '../cordis';

/** 第一方 capability 插件——装载 firstPartyCapabilities()（十五项全量）。
 *  注册序 = 清单序 = 迁移前出厂表序（装配字节零漂移按构造）。 */
export const capabilitySegmentsPlugin = {
  name: 'hologram/capability-segments',
  inject: ['capabilities'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = firstPartyCapabilities().map((cap) => ctx.capabilities.register(cap));
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'capability-segments');
  },
};
