// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂 capability 段插件 · 真源产物（S3，plugin-bundle-retirement）。
// 原 plugins/capability-segments-plugin.ts 整体迁入。
//
// 批 9h-1（2026-09-26）：十四项 capability **内容表**随包（`./segments`，自
// `agent/blueprint.ts` 逐字搬移、序原样）；内核只留 `AgentBlueprint` 机制 + 形状。

import type { Context } from '../../../cordis';
import { firstPartyCapabilities } from './segments';

/** 第一方 capability 插件——装载 firstPartyCapabilities()（十四项全量）。
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

export default capabilitySegmentsPlugin;
