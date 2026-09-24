// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂 prompt 段插件 · 真源产物（S3，plugin-bundle-retirement）。
// 原 plugins/prompt-segments-plugin.ts 整体迁入。

import type { Context } from '../../../cordis';
import { firstPartyPromptSections } from './sections';

/** 第一方 prompt 段插件——装载 firstPartyPromptSections()（全量段）。
 *  注册序 = 段清单序 = 迁移前出厂表序（拼装字节零漂移按构造；2026-09-24
 *  配方改文件批补 provider-config 段——段数以清单函数返回值为唯一真源）。 */
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

export default promptSegmentsPlugin;
