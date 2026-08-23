// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 prompt 段插件（P4 B④ 收官，agent-plugin-architecture-plan §5
// B 表 ④）——全部 13 段（试点 memory/claude-md + 续批 graph-snapshot +
// 收官批 10 段）经 ctx.prompts 第六贡献通道贡献（插件形状对齐 B①
// git-search-plugin 先例：定义留真源文件，插件只做装载接线）。
//
// 收官勘定（B④，2026-08-23）：
//   - 零漂移：贡献序 = 迁移前出厂表序（firstPartyPromptSections 数组序）
//     ——13 段全量经通道贡献后，缺省拼装（空解析产物 + 贡献）与迁移前
//     出厂面逐字节全等（system-prompt.fixture 快照守护，双 preset 实测）。
//   - 无实例缓存障碍（与 tools 通道 rowCtx 锁存不同）：prompt 通道每次
//     拼装重调 render，render 直收 PromptSectionContext 装配期真值——
//     动态插值段（graphSnapshot/memorySection/claudeMdSection）每装配
//     现算，语义与表内时代逐字一致。
//   - 寻址域收窄（收官终态）：13 段全部脱离 roster 组合解析域——patch/
//     preset 寻址任一第一方段 id 报「未知段 id」整体拒绝（错误可见）；
//     全寻址恢复属 S4-4 机器桥批（同 B① git/search 先例）。

import { firstPartyPromptSections } from '../composition/prompt-sections';
import type { Context } from '../cordis';

/** 第一方 prompt 段插件——装载 firstPartyPromptSections()（13 段全量）。
 *  注册序 = 段清单序 = 迁移前出厂表序（拼装字节零漂移按构造）。 */
export const promptSegmentsPlugin = {
  name: 'hologram/prompt-segments',
  inject: ['prompts'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = firstPartyPromptSections().map((section) => ctx.prompts.register(section));
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'prompt-segments');
  },
};
