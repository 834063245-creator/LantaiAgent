// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 prompt 段插件（P4 存量拆解 B④ 试点，agent-plugin-architecture-plan
// §5 B 表 ④）——memory / claude-md 两段从 composition/prompt-sections 行表
// 迁入 ctx.prompts 第六贡献通道（插件形状对齐 B① git-search-plugin 先例：
// 定义留真源文件，插件只做装载接线）。
//
// 搬运勘定（B④，2026-08-23）：
//   - 零漂移约束：贡献恒在解析产物末尾（A-1 已定型语义）——迁出段必须是
//     出厂表表尾后缀，否则拼装字节序变化（击穿 system-prompt.fixture 与
//     前缀缓存）。memory/claude-md 是表尾两段，贡献位 = 表尾原位。
//   - 无实例缓存障碍（与 tools 通道 rowCtx 锁存不同）：prompt 通道每次
//     拼装重调 render，render 直收 PromptSectionContext 装配期真值——
//     动态插值段（memorySection/claudeMdSection）每装配现算，语义与表内
//     段逐字一致。
//   - 寻址域收窄：迁出段脱离 roster 组合解析域——patch/preset 寻址
//     memory/claude-md 报「未知段 id」整体拒绝（错误可见）；纳入寻址域
//     属 S4-4 机器桥批（同 B① git/search 先例）。

import { migratedPromptSections } from '../composition/prompt-sections';
import type { Context } from '../cordis';

/** 第一方 prompt 段插件——装载 migratedPromptSections()（B④ 迁出段）。
 *  注册序 = 段函数序 = 迁出前表尾序（拼装字节零漂移按构造）。 */
export const promptSegmentsPlugin = {
  name: 'hologram/prompt-segments',
  inject: ['prompts'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = migratedPromptSections().map((section) => ctx.prompts.register(section));
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'prompt-segments');
  },
};
