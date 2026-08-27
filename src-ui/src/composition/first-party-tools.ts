// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方工具插件通道（P4 存量拆解 B① + ② + ①c + ①b，
// agent-plugin-architecture-plan §5）。
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
// 复用）——无状态六族 + browser-desktop 整组行缓存语义等价；①c 七族
// 声明 noCache（每装配重创，装配期真值直收 rowCtx），缓存对其不生效。
//
// ①b 收官（2026-08-23）：builtin 行表清空退役（web + browser-desktop
// 是最后两族）——组合解析域的 tools 行全量 = 插件贡献行；无通道环境
// 的 tools 域 = 空行表（行寻址解析须在通道腰内做）。

import { Context } from '../cordis';
import {
  agentDomainPlugin,
  agentIsolationDomainPlugin,
  askDomainPlugin,
  browserDesktopDomainPlugin,
  cordisDomainPlugin,
  fsDomainPlugin,
  gitDomainPlugin,
  hologramDomainPlugin,
  memoryDomainPlugin,
  searchDomainPlugin,
  shellDomainPlugin,
  skillDomainPlugin,
  taskDomainPlugin,
  waitDomainPlugin,
  webDomainPlugin,
} from '../plugins/coding-domain-plugins';
import type { LantaiPlugin } from '../plugins/types';
import { compositionServicesPlugin } from './services';

/** 经 ctx.tools 贡献工具的第一方域插件（表序 = 贡献注册序 = 装配序；
 *  ①b 后全量十五族：web + browser-desktop（①b 前插，序 = 迁移前行表序）
 *  + hologram（engine-domain）+ git/search/fs/shell/agent-isolation（B①/②
 *  无状态族）+ wait/ask/memory/skill/task/agent（①c 装配期真值族）
 *  + cordis（平台化 Phase 4 · D7 动态插件面——装配期真值族，表尾追加）。 */
export function firstPartyToolPlugins(): LantaiPlugin[] {
  return [
    // ①b（序 = 迁移前行表序：web、browser-desktop 原居 builtin 表首两位）
    webDomainPlugin,
    browserDesktopDomainPlugin,
    // 无状态族（序 = 迁移前行表序：hologram 位次的 engine-domain 在此）
    hologramDomainPlugin,
    gitDomainPlugin,
    searchDomainPlugin,
    fsDomainPlugin,
    shellDomainPlugin,
    agentIsolationDomainPlugin,
    // 装配期真值族（序 = 迁移前行表序：ask/skill/memory/task/agent/wait）
    askDomainPlugin,
    skillDomainPlugin,
    memoryDomainPlugin,
    taskDomainPlugin,
    agentDomainPlugin,
    waitDomainPlugin,
    // 平台化 Phase 4 · D7：动态插件面（装配期真值族——审批通道收 rowCtx.ui）
    cordisDomainPlugin,
  ];
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
