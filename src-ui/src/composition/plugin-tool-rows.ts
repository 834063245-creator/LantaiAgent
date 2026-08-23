// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件工具行折算（S4-1.5 消费闭环）—— ctx.tools 贡献 → BuiltinToolRow。
//
// 折算规则（设计件 §2.3）：
//   - 行 id = 'plugin/' + 贡献 id（贡献 id 约定 '<插件名>/<工具名>'——npm
//     scope 风格；插件名段防跨插件撞名，'plugin/' 前缀防撞 builtin 行
//     （'builtin/<family>'）——preset/patch 可用行 id 寻址禁用某个插件工具，
//     组合均匀性不破）；
//   - factory 缓存实例：注册期调用一次贡献 factory，之后装配复用同一 Tool
//     实例（工具可能持状态/连接——不随每次装配重建）；dispose 时清缓存
//     （onToolContributionsChanged 订阅，见 services.ts 的 fire 点）。
//
// 生效时机：下次 Agent 装配（S1 既有语义）——本模块不触即时信号。

import type { Tool } from '../agent/tool';
import { activeToolContributions, onToolContributionsChanged } from './services';
import type { BuiltinToolRow } from './tool-rows';

// ── 贡献 id → 实例缓存（模块级可变态归属 CONVENTIONS §1.10 第 3 类：
//  键控自清理——贡献 dispose 即全表失效，生命周期 = 进程）。──
// B①（2026-08-23）起贡献 factory 可选收装配上下文（rowCtx.codingExec 等）；
// 缓存语义不变：首装配的 ctx 被锁存进实例——收 ctx 的贡献必须自担跨装配
// 语义等价（无状态 exec 可搬；装配期真值族如 ask/wait 不经此通道）。
const instanceCache = new Map<string, Tool[]>();

// 贡献变更（register/dispose）→ 清缓存（register 的清空是幂等无害：新贡献
// 尚无缓存条目；dispose 的清空是正确性必需——被卸载的工具实例不得再进装配）。
onToolContributionsChanged(() => instanceCache.clear());

/** 插件工具行（无贡献/无服务 = 空集——装配面叠加在 builtin 行表之后）。 */
export function pluginToolRows(): BuiltinToolRow[] {
  return activeToolContributions().map((c) => ({
    id: 'plugin/' + c.id,
    factory: (ctx) => {
      let cached = instanceCache.get(c.id);
      if (!cached) {
        cached = [c.factory(ctx)];
        instanceCache.set(c.id, cached);
      }
      return cached;
    },
  }));
}
