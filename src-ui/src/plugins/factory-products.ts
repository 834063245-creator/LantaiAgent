// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂产物清单（S5，plugin-bundle-retirement）——
// 29 个出厂插件产物的源码域插件对象（dev/vitest 域装载用）+ 名单
// （loadExternalPlugins 在 dev 模式下过滤产物通道重复装载用）。
//
// 生产形态：这些插件从磁盘产物通道（loadExternalPlugins）装载——本清单
// 不进生产 bundle（import.meta.env.DEV 分支，vite 死代码消除）。
// 开发形态：vite HMR 直接装载本清单（源码热重载，产物仅发布形态）。
//
// 表序 = 原 BUILTIN_PLUGINS 的贡献注册序（字节契约——组合解析快照 /
// 工具契约生成 / DeepSeek 前缀缓存都依赖此序，不得重排）。

import { firstPartyCapabilityPlugins } from '../composition/first-party-capabilities';
import { firstPartyPromptPlugins } from '../composition/first-party-prompts';
import { firstPartyToolPlugins } from '../composition/first-party-tools';
import { canvasNavPlugin } from './builtin/canvas-nav';
import { composeDockPlugin } from './builtin/compose-dock';
import { builtinFsPlugin } from './builtin/fs-builtin';
import { builtinGraphPlugin } from './builtin/graph-builtin';
import { llmAdaptersPlugin } from './builtin/llm-adapters';
import { paperPlugin } from './builtin/paper-shell';
import { builtinRenderersPlugin } from './builtin/renderers';
import { builtinSessionsPlugin } from './builtin/sessions-builtin';
import { settingsPlugin } from './builtin/settings-domain';
import { builtinShellPlugin } from './builtin/shell-builtin';
import { inProcessSubagentPlugin } from './builtin/subagent-in-process';
import type { LantaiPlugin } from './types';

/** 29 个出厂产物插件对象（表序 = 原 BUILTIN_PLUGINS 贡献注册序）。 */
export function factoryProductPlugins(): LantaiPlugin[] {
  return [
    // S2 供应商（6）
    llmAdaptersPlugin,
    inProcessSubagentPlugin,
    builtinFsPlugin,
    builtinShellPlugin,
    builtinSessionsPlugin,
    builtinGraphPlugin,
    // 既有产物（增补四：渲染器 + UI 四面，5）
    builtinRenderersPlugin,
    paperPlugin,
    settingsPlugin,
    canvasNavPlugin,
    composeDockPlugin,
    // S3 工具域 + 段贡献（18）
    ...firstPartyToolPlugins(),
    ...firstPartyPromptPlugins(),
    ...firstPartyCapabilityPlugins(),
  ];
}

/** 29 个出厂产物名（dev 模式 loadExternalPlugins 过滤用——防止产物通道
 *  重复装载已在源码域装载的出厂插件）。 */
export function factoryProductNames(): Set<string> {
  return new Set(factoryProductPlugins().map((p) => p.name));
}
