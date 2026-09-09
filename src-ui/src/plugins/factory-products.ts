// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂产物清单（S5/S5b，plugin-bundle-retirement；2026-09-06 单一真源换轨）——
// 29 个出厂插件产物的源码域插件对象（dev/vitest 域装载用）+ 名单
//（loadExternalPlugins 在 dev 模式下过滤产物通道重复装载用）。
//
// 生产形态：这些插件从磁盘产物通道（loadExternalPlugins）装载——本清单
// 不进生产 bundle（import.meta.env.DEV 分支，vite 死代码消除）。
// 开发形态：vite HMR 直接装载本清单（源码热重载，产物仅发布形态）。
//
// 表序 = 名册 buildOrder（单一真源：src/plugins/builtin-roster.json）——贡献
// 注册序 = 装载序 = 组合解析快照 / 工具契约生成 / DeepSeek 前缀缓存的字节契约。
//
// ⚠ 循环 import 纪律（2026-09-06 实测：全 31 直接 import 会让 s3-settings-domain
// 测试在模块加载期炸——settings-domain → SettingsPanel → PluginsPage → loader
// → factory-products 的直接环使 settingsPlugin 在 BUILTIN_PLUGINS 顶层展开
// 求值时未初始化）。插件对象来源分两路，与换轨前一致（已验证无环）：
//   1. 12 个直接 builtin（供应商 + 渲染器 + UI 面 + agent-loop-service）；
//   2. 17 个经 composition 通道函数（firstPartyToolPlugins 15 + PromptPlugins 1
//      + CapabilityPlugins 1——薄层各自 import 自己的 builtin）。
// 两路拍平成 dir → plugin 映射后**按名册 buildOrder 排序输出**（序不手写）。
// （graph-builtin / engine-domain 随图谱全量退役移除，2026-09-09——31→29。）

import { firstPartyCapabilityPlugins } from '../composition/first-party-capabilities';
import { firstPartyPromptPlugins } from '../composition/first-party-prompts';
import { firstPartyToolPlugins } from '../composition/first-party-tools';
import { agentLoopServicePlugin } from './builtin/agent-loop-service';
import { canvasNavPlugin } from './builtin/canvas-nav';
import { composeDockPlugin } from './builtin/compose-dock';
import { builtinFsPlugin } from './builtin/fs-builtin';
import { llmAdaptersPlugin } from './builtin/llm-adapters';
import { paperMinimapPlugin } from './builtin/paper-minimap';
import { paperPlugin } from './builtin/paper-shell';
import { builtinRenderersPlugin } from './builtin/renderers';
import { builtinSessionsPlugin } from './builtin/sessions-builtin';
import { settingsPlugin } from './builtin/settings-domain';
import { builtinShellPlugin } from './builtin/shell-builtin';
import { inProcessSubagentPlugin } from './builtin/subagent-in-process';
import { BUILTIN_ROSTER } from './builtin-roster';
import type { LantaiPlugin } from './types';

/** 29 个出厂产物插件对象（表序 = 名册 buildOrder——贡献注册序字节契约）。
 *  映射函数内构造（惰性）：模块加载期不访问插件对象值（loader 顶层 DEV
 *  展开在 import 图求值中调用本函数——settings-domain 环回时若顶层已读
 *  其插件对象会 TDZ），调用时全部模块已就绪。 */
export function factoryProductPlugins(): LantaiPlugin[] {
  const direct: LantaiPlugin[] = [
    llmAdaptersPlugin,
    inProcessSubagentPlugin,
    builtinFsPlugin,
    builtinShellPlugin,
    builtinSessionsPlugin,
    builtinRenderersPlugin,
    paperPlugin,
    settingsPlugin,
    canvasNavPlugin,
    composeDockPlugin,
    paperMinimapPlugin,
    agentLoopServicePlugin,
  ];
  const viaChannels: LantaiPlugin[] = [
    ...firstPartyToolPlugins(),
    ...firstPartyPromptPlugins(),
    ...firstPartyCapabilityPlugins(),
  ];
  const dirToPlugin: Record<string, LantaiPlugin> = Object.fromEntries(
    [...direct, ...viaChannels].map((p) => [p.name.replace(/^hologram\//, ''), p]),
  );
  return BUILTIN_ROSTER.map((e) => {
    const plugin = dirToPlugin[e.dir];
    if (!plugin) throw new Error(`名册条目缺插件对象映射: ${e.dir}——factory-products 漏 import`);
    return plugin;
  });
}

/** 29 个出厂产物名（dev 模式 loadExternalPlugins 过滤用——防止产物通道
 *  重复装载已在源码域装载的出厂插件）。 */
export function factoryProductNames(): Set<string> {
  return new Set(factoryProductPlugins().map((p) => p.name));
}
