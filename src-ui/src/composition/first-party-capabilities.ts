// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 capability 插件通道（P4 存量拆解 B⑤ 收官，
// agent-plugin-architecture-plan §5；路线钉在 A3 设计件 §2.8）。
//
// 两个职责（镜像 B④ composition/first-party-prompts.ts）：
//   1. 插件清单单一真源：经 ctx.capabilities 贡献会话级能力的第一方插件
//      列表——plugins/loader.ts 的 BUILTIN_PLUGINS 表尾与无引导环境的
//      通道装配腰（下方 withFirstPartyCapabilityChannel）消费同一份，
//      杜绝两处手抄漂移。
//   2. 通道装配腰：为「无 UI 引导环境」（convergence 夹具 / 契约文档生成）
//      复现生产装配的 capability 面——根 Context + capabilities service +
//      本清单插件，factoryComposition 的 activeCapabilityContributions()
//      因此与生产同路取贡献。生产路径（main.ts → loadBuiltinPlugins）不经
//      这里——装载器是唯一引导入口，本腰只服务测试/工具环境（它们不跑
//      main.ts）。
//
// B⑤ 收官（2026-08-24）：十五项第一方 capability 全量经本通道贡献
// （capabilitySegmentsPlugin 装载 firstPartyCapabilities()——序 = 迁移前
// 出厂表序，单批零漂移按构造）；出厂 builtinCapabilities() 退役——
// 无通道环境的 capabilities 域 = 空表（B④ prompt 域注册面依赖同款语义：
// 出厂面的复现必须经本腰，寻址 capability id 的解析同理）。
//
// 语义提醒：capability 通道无实例缓存（贡献是 AgentCapability 对象本体，
// install 每装配重调）——与 tools 通道的 rowCtx 锁存不同，无跨装配串扰面；
// 子 Agent 不自动继承（spawnSubAgent 手工装配不经 blueprint——既有语义）。

import { Context } from '../cordis';
import { capabilitySegmentsPlugin } from '../plugins/builtin/capability-segments';
import type { LantaiPlugin } from '../plugins/types';
import { capabilitiesServicePlugin } from './capability-service';

/** 经 ctx.capabilities 贡献会话级能力的第一方插件（表序 = 贡献注册序
 *  = 迁移前出厂表序）。B⑤ 收官：capabilitySegmentsPlugin 装载全部
 *  十五项第一方 capability。 */
export function firstPartyCapabilityPlugins(): LantaiPlugin[] {
  return [capabilitySegmentsPlugin];
}

/** 在第一方 capability 通道激活期间执行 run（通道随调用拆卸）。
 *  capabilities service 先装载（清单插件的 inject ['capabilities'] 依赖
 *  可解析）；拆卸逆序（服务 dispose 守卫式清空活动读取面——capability
 *  表序是字节敏感面）。 */
export async function withFirstPartyCapabilityChannel<T>(run: () => Promise<T>): Promise<T> {
  const root = new Context();
  const fibers = [await root.plugin(capabilitiesServicePlugin)];
  for (const plugin of firstPartyCapabilityPlugins()) {
    fibers.push(await root.plugin(plugin));
  }
  try {
    return await run();
  } finally {
    for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
  }
}
