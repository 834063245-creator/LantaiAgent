// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂产物清单（S5/S5b，plugin-bundle-retirement；2026-09-06 单一真源换轨）——
// 30 个出厂插件产物的源码域插件对象（dev/vitest 域装载用）+ 名单
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
//   2. 18 个经 composition 通道函数（firstPartyToolPlugins 16 + PromptPlugins 1
//      + CapabilityPlugins 1——薄层各自 import 自己的 builtin）。
// 两路拍平成 dir → plugin 映射后**按名册 buildOrder 排序输出**（序不手写）。
//（graph-builtin / engine-domain 随图谱全量退役移除，2026-09-09——31→29；
//  office-domain 2026-09-13 C 路新增——29→30。**两组计数一律以 builtin-roster.json
//  条目数为准**——下方 M4 收口注已记过一次「注释写 29、实测覆盖 30」的手抄漂移。）

import { firstPartyCapabilityPlugins } from '../composition/first-party-capabilities';
import { firstPartyPromptPlugins } from '../composition/first-party-prompts';
import { firstPartyToolPlugins } from '../composition/first-party-tools';
import { agentLoopServicePlugin } from './builtin/agent-loop-service';
import { askCardsPlugin } from './builtin/ask-cards';
import { canvasNavPlugin } from './builtin/canvas-nav';
import { composeDockPlugin } from './builtin/compose-dock';
import { builtinFsPlugin } from './builtin/fs-builtin';
import { goalModePlugin } from './builtin/goal-mode';
import { llmAdaptersPlugin } from './builtin/llm-adapters';
import { paperMinimapPlugin } from './builtin/paper-minimap';
import { paperRenderersPlugin } from './builtin/paper-renderers';
import { paperPlugin } from './builtin/paper-shell';
import { builtinRenderersPlugin } from './builtin/renderers';
import { builtinSessionsPlugin } from './builtin/sessions-builtin';
import { sessionsHomePlugin } from './builtin/sessions-home';
import { settingsPlugin } from './builtin/settings-domain';
import { builtinShellPlugin } from './builtin/shell-builtin';
import { inProcessSubagentPlugin } from './builtin/subagent-in-process';
import { BUILTIN_ROSTER } from './builtin-roster';
import type { LantaiPlugin } from './types';

/** 30 个出厂产物插件对象（表序 = 名册 buildOrder——贡献注册序字节契约）。
 *  映射函数内构造（惰性）：模块加载期不访问插件对象值（loader 顶层 DEV
 *  展开在 import 图求值中调用本函数——settings-domain 环回时若顶层已读
 *  其插件对象会 TDZ），调用时全部模块已就绪。
 *
 *  M4 收口（2026-09-14）：原先把这一列拆成 `direct`（12）与 `viaChannels`（17）
 *  两个数组——**分区是惰性的**：两者只喂同一个并集，没有任何代码问「某个产物
 *  属于哪一路」，也没有任何校验保证放对了数组（放错也照跑）；而那组计数本身
 *  就是过期手抄（注释写 29，实测覆盖 30）。现合成单列——两个来源的差异是
 *  import 图的既成事实（② 那层间接是破环用的，见文件头注），不需要在数据结构
 *  上再表态一次。覆盖性仍由下方逐名册条目 fail-loud 兜底，且新增**同名成簇**
 *  检测：两个插件名派生出同一个 dir 时，旧的 Object.fromEntries 会静默后者胜。 */
export function factoryProductPlugins(): LantaiPlugin[] {
  const plugins: LantaiPlugin[] = [
    // ① 直接 import 的产物（供应商 / 渲染器 / UI 面 / agent-loop-service）
    llmAdaptersPlugin,
    inProcessSubagentPlugin,
    builtinFsPlugin,
    builtinShellPlugin,
    builtinSessionsPlugin,
    builtinRenderersPlugin,
    // 批 8b（2026-09-25）：纸面块渲染器十一 kind 全谱归产物（名册 required——不可禁用）
    paperRenderersPlugin,
    // 批 9e（2026-09-26）：案卷首页归产物（名册 required——应用唯一入口页），经 ctx.rootViews 'home' 槽贡献
    sessionsHomePlugin,
    // 批 9e-3（2026-09-26）：ask / 权限卡架归产物（名册 required——唯一承接面），经 'overlay' 槽贡献
    askCardsPlugin,
    paperPlugin,
    settingsPlugin,
    canvasNavPlugin,
    composeDockPlugin,
    paperMinimapPlugin,
    agentLoopServicePlugin,
    goalModePlugin,
    // ② 经 composition 通道函数取得的产物（薄层各自 import 自己的 builtin——
    //    这层间接是破环用的：settings-domain → SettingsPanel → PluginsPage →
    //    loader → factory-products 的直接环会让 settingsPlugin 在 BUILTIN_PLUGINS
    //    顶层展开求值时未初始化，见文件头注）
    ...firstPartyToolPlugins(),
    ...firstPartyPromptPlugins(),
    ...firstPartyCapabilityPlugins(),
  ];
  const dirToPlugin = new Map<string, LantaiPlugin>();
  for (const p of plugins) {
    const dir = p.name.replace(/^hologram\//, '');
    const prev = dirToPlugin.get(dir);
    if (prev && prev !== p) {
      throw new Error(`出厂产物名撞车: ${dir}——两个插件对象派生同一 dir，名册寻址会歧义`);
    }
    dirToPlugin.set(dir, p);
  }
  return BUILTIN_ROSTER.map((e) => {
    const plugin = dirToPlugin.get(e.dir);
    if (!plugin) throw new Error(`名册条目缺插件对象映射: ${e.dir}——factory-products 漏 import`);
    return plugin;
  });
}

/** 30 个出厂产物名（dev 模式 loadExternalPlugins 过滤用——防止产物通道
 *  重复装载已在源码域装载的出厂插件）。 */
export function factoryProductNames(): Set<string> {
  return new Set(factoryProductPlugins().map((p) => p.name));
}
