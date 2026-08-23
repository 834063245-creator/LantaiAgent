// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 prompt 段插件（P4 存量拆解 B④ 试点 + 续批，
// agent-plugin-architecture-plan §5 B 表 ④）——memory / claude-md（试点）
// + graph-snapshot（续批）三段从 composition/prompt-sections 行表迁入
// ctx.prompts 第六贡献通道（插件形状对齐 B① git-search-plugin 先例：
// 定义留真源文件，插件只做装载接线）。
//
// 搬运勘定（B④，2026-08-23）：
//   - 零漂移约束：贡献恒在解析产物末尾（A-1 已定型语义）——迁出段必须是
//     出厂表表尾后缀，否则拼装字节序变化（击穿 system-prompt.fixture 与
//     前缀缓存）。三段即表尾三段（表尾逆序批次：memory/claude-md →
//     graph-snapshot），贡献位 = 表尾原位。
//   - 序保真：migratedPromptSections 数组序 = 迁出前表尾序——表尾逆序
//     批次下新迁段在原表中先于已迁段，续批插数组**头部**（尾部追加会
//     翻转贡献序 = 拼装序漂移）。
//   - 无实例缓存障碍（与 tools 通道 rowCtx 锁存不同）：prompt 通道每次
//     拼装重调 render，render 直收 PromptSectionContext 装配期真值——
//     动态插值段（graphSnapshot/memorySection/claudeMdSection）每装配
//     现算，语义与表内段逐字一致。
//   - 寻址域收窄：迁出段脱离 roster 组合解析域——patch/preset 寻址
//     graph-snapshot/memory/claude-md 报「未知段 id」整体拒绝（错误
//     可见）；纳入寻址域属 S4-4 机器桥批（同 B① git/search 先例）。

import { migratedPromptSections } from '../composition/prompt-sections';
import type { Context } from '../cordis';

/** 第一方 prompt 段插件——装载 migratedPromptSections()（B④ 迁出段）。
 *  注册序 = 段函数序 = 迁出前表尾序（拼装字节零漂移按构造；续批新迁段
 *  在真源数组头部保序）。 */
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
