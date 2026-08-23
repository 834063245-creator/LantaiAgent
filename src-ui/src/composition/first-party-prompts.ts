// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 prompt 段插件通道（P4 存量拆解 B④ 收官，
// agent-plugin-architecture-plan §5）。
//
// 两个职责（镜像 B① composition/first-party-tools.ts）：
//   1. 插件清单单一真源：经 ctx.prompts 贡献段的第一方插件列表——
//      plugins/loader.ts 的 BUILTIN_PLUGINS 表尾与无引导环境的通道装配腰
//      （下方 withFirstPartyPromptChannel）消费同一份，杜绝两处手抄漂移。
//   2. 通道装配腰：为「无 UI 引导环境」（convergence 夹具）复现生产装配
//      的 prompt 贡献面——根 Context + prompts service + 本清单插件，
//      assembleSystemPrompt 的 activePromptContributions() 因此与生产同路
//      取贡献。生产路径（main.ts → loadBuiltinPlugins）不经这里——装载器
//      是唯一引导入口，本腰只服务测试/工具环境（它们不跑 main.ts）。
//
// B④ 收官（2026-08-23）：13 第一方段全量经本通道贡献（promptSegmentsPlugin
// 装载 firstPartyPromptSections()）——无通道环境缺省拼装 = 空提示词，
// 出厂面的复现必须经本腰（obstacle ③ 注册面依赖）。
//
// 语义提醒：prompt 通道无实例缓存（每次拼装重调 render，贡献直收
// PromptSectionContext 装配期真值）——与 tools 通道的 rowCtx 锁存不同，
// 动态插值段（graph-snapshot/memory/claude-md）无跨装配串扰面。

import { Context } from '../cordis';
import { promptSegmentsPlugin } from '../plugins/prompt-segments-plugin';
import type { LantaiPlugin } from '../plugins/types';
import { promptsServicePlugin } from './prompt-service';

/** 经 ctx.prompts 贡献段的第一方插件（表序 = 贡献注册序）。
 *  B④ 收官：promptSegmentsPlugin 装载全部 13 第一方段。 */
export function firstPartyPromptPlugins(): LantaiPlugin[] {
  return [promptSegmentsPlugin];
}

/** 在第一方 prompt 段通道激活期间执行 run（通道随调用拆卸）。
 *  prompts service 先装载（清单插件的 inject ['prompts'] 依赖可解析）；
 *  拆卸逆序（服务 dispose 守卫式清空活动读取面——prompt 是字节敏感面）。 */
export async function withFirstPartyPromptChannel<T>(run: () => Promise<T>): Promise<T> {
  const root = new Context();
  const fibers = [await root.plugin(promptsServicePlugin)];
  for (const plugin of firstPartyPromptPlugins()) {
    fibers.push(await root.plugin(plugin));
  }
  try {
    return await run();
  } finally {
    for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
  }
}
