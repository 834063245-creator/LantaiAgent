// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内核 service 插件表（**单一真源**，批 9a §4-15，2026-09-26）。
//
// 病灶（账本 §4-15）：`loader.ts` 的 `BUILTIN_PLUGINS`（13 个插件对象）与
// `first-party-manifest.ts` 的 `SERVICE_META`（13 个 name → description）**两处手写同一份名单**，
// 只靠守护测试对拍——加/删一个内核 service 要改两处，漏一处靠测试才发现。
//
// 收口：本文件是**唯一**列名单的地方（表序 = 装载序 = 贡献注册序 = 字节契约，不得重排）；
//   - `loader.ts`：`BUILTIN_PLUGINS = SERVICE_PLUGINS.map((e) => e.plugin)`（对象来自本表）
//   - `first-party-manifest.ts`：`SERVICE_META` 由本表派生（name 从 plugin.name 取，
//     description 从本表取）——清单面零手写名单。
//
// 叶性纪律：本文件只 import 13 个内核插件对象与类型；**不得** import `loader` / `first-party-manifest` /
// `factory-products`（那会成环：loader → 本表 ← manifest，而 manifest 也被 loader 引）。
// 13 个插件模块自身对这三个模块零依赖（实测 2026-09-26）。

import { codeRuntimePlugin } from '../agent/code-run/runtime-service';
import { dynamicRunnerPlugin } from '../agent/dynamic-runner/dynamic-runner-service';
import { capabilitiesServicePlugin } from '../composition/capability-service';
import { fsServicePlugin } from '../composition/fs-service';
import { hooksServicePlugin } from '../composition/hook-service';
import { overlayServicePlugin } from '../composition/overlay-service';
import { promptsServicePlugin } from '../composition/prompt-service';
import { rendererServicePlugin } from '../composition/renderer-service';
import { compositionServicesPlugin } from '../composition/services';
import { sessionPersistenceServicePlugin } from '../composition/session-persistence-service';
import { shellServicePlugin } from '../composition/shell-service';
import { spaceServicePlugin } from '../composition/space-service';
import { subagentsServicePlugin } from '../composition/subagent-service';
import { lspServicePlugin } from '../ui/lsp-client';
import type { LantaiPlugin } from './types';

/** 内核 service 表项：插件对象 + 清单文案（UI 展示）。 */
export interface ServicePluginEntry {
  plugin: LantaiPlugin;
  /** 清单 description（`FIRST_PARTY_MANIFEST` 的 service 段从此读，勿双写）。 */
  description: string;
}

/** 14 个内核 service（**表序 = 装载序 = 字节契约**；加/删只许动本表）。
 *  第 14 位 `lsp-service`（批 9b §4-13）：此前游离在清单外（`ui/lsp-client.ts` 自建第二个根
 *  Context 当兜底）⇒ 不受「内核不可禁用」覆盖、不进 boot 审计；现由 loader 装载。 */
export const SERVICE_PLUGINS: readonly ServicePluginEntry[] = [
  {
    plugin: compositionServicesPlugin,
    description: '组合层五 service 本体（panels/commands/tools/llm/activation 注册表）',
  },
  { plugin: subagentsServicePlugin, description: '子代理服务注册表（seam/subagents）' },
  { plugin: fsServicePlugin, description: '文件域服务注册表（seam/fs）' },
  { plugin: shellServicePlugin, description: '命令域服务注册表（seam/shell）' },
  { plugin: sessionPersistenceServicePlugin, description: '会话持久化服务注册表（seam/sessionPersistence）' },
  { plugin: spaceServicePlugin, description: '空间服务（工作区/会话空间）' },
  { plugin: overlayServicePlugin, description: '覆盖层服务' },
  { plugin: rendererServicePlugin, description: '块渲染器注册表（第五贡献通道，后注册胜）' },
  { plugin: promptsServicePlugin, description: 'system-prompt 段贡献注册表（第六通道）' },
  { plugin: hooksServicePlugin, description: '工具管道钩子注册表（第七通道）' },
  { plugin: capabilitiesServicePlugin, description: '会话级能力贡献注册表（第八通道）' },
  { plugin: codeRuntimePlugin, description: 'code_execution 执行腰沙箱' },
  { plugin: dynamicRunnerPlugin, description: '运行时插件定义/执行（cordis 域，approval + 半沙箱）' },
  { plugin: lspServicePlugin, description: '语言服务（LSP）会话与 provider 注册（工作区 fiber 挂载 + 内核兜底实例）' },
];
