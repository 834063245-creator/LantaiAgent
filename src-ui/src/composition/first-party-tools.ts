// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方工具插件通道（P4 存量拆解 B① + ②，agent-plugin-architecture-plan §5）。
//
// 两个职责：
//   1. 插件清单单一真源：经 ctx.tools 贡献工具的第一方域插件列表——
//      plugins/loader.ts 的 BUILTIN_PLUGINS 表尾与无引导环境的通道装配腰
//      （下方 withFirstPartyToolChannel）消费同一份，杜绝两处手抄漂移。
//   2. 通道装配腰：为「无 UI 引导环境」（convergence 夹具 / 契约文档生成）
//      复现生产装配的插件工具面——根 Context + 四 service + 本清单插件，
//      buildToolRegistry 内的 pluginToolRows() 因此与生产同路取贡献。
//      生产路径（main.ts → loadBuiltinPlugins）不经这里——装载器是唯一
//      引导入口，本腰只服务测试/工具环境（它们不跑 main.ts）。
//
// 语义提醒：通道内的贡献经 pluginToolRows 实例缓存（首装配实例跨装配
// 复用）；收 rowCtx 的贡献必须自担语义等价（见 services.ts ToolContribution
// ——清单内五族均为无状态 codingExec 族，语义等价勘定见
// plugins/coding-domain-plugins.ts 文件头）。

import { Context } from '../cordis';
import {
  agentIsolationDomainPlugin,
  fsDomainPlugin,
  gitDomainPlugin,
  searchDomainPlugin,
  shellDomainPlugin,
} from '../plugins/coding-domain-plugins';
import type { LantaiPlugin } from '../plugins/types';
import { compositionServicesPlugin } from './services';

/** 经 ctx.tools 贡献工具的第一方域插件（表序 = 贡献注册序；B① git/search
 *  + ② fs/shell/agent-isolation，均为无状态 codingExec 族）。 */
export function firstPartyToolPlugins(): LantaiPlugin[] {
  return [gitDomainPlugin, searchDomainPlugin, fsDomainPlugin, shellDomainPlugin, agentIsolationDomainPlugin];
}

/** 在第一方工具插件通道激活期间执行 run（通道随调用拆卸）。
 *  四 service 先装载（清单插件的 inject ['tools'] 依赖可解析）；拆卸逆序。 */
export async function withFirstPartyToolChannel<T>(run: () => Promise<T>): Promise<T> {
  const root = new Context();
  const fibers = [await root.plugin(compositionServicesPlugin)];
  for (const plugin of firstPartyToolPlugins()) {
    fibers.push(await root.plugin(plugin));
  }
  try {
    return await run();
  } finally {
    for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
  }
}
