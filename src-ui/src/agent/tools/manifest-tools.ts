// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// manifest-tools — 从内核插件 manifest 生成 Agent 可见工具（kernel-plugin-runtime Phase 1）。
//
// 工具面的单一真源 = Rust 侧 manifest（src-tauri/src/tool_plugins/<name>/manifest.json，
// 经 scripts/gen-plugin-manifests.cjs 镜像到 kernel-manifests.generated.ts）。
// schema 不再走路由 zod——见 INVARIANTS #8 修订：单一真源原则不变，真源从 TS zod
// 换成 Rust manifest；运行时校验回归插件侧参数提取。
// execute 走统一 tool_call RPC（agentInvoke 恒注入 isAgent）。

import type { Tool, ToolExecutor } from '../tool';
import { KERNEL_MANIFESTS } from './kernel-manifests.generated';

/** manifest 单工具声明（生成物镜像的类型面）。 */
export interface KernelToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  read_only?: boolean;
}

/** 内核插件 manifest（生成物镜像的类型面）。 */
export interface KernelToolManifest {
  id: string;
  version: string;
  trust: 'system' | 'official' | 'third_party';
  description?: string;
  capabilities?: string[];
  tools: KernelToolSpec[];
}

export function kernelManifestOf(id: string): KernelToolManifest {
  const manifest = KERNEL_MANIFESTS.find((m) => m.id === id);
  if (!manifest) throw new Error(`manifest-tools: 内核插件 '${id}' 不在生成物清单内`);
  return manifest;
}

/** 从 manifest 生成 Tool——名称/描述/schema 字节 = manifest 字节（convergence 纪律）。 */
export function manifestTool(manifestId: string, toolName: string, exec: ToolExecutor): Tool {
  const manifest = kernelManifestOf(manifestId);
  const spec = manifest.tools.find((t) => t.name === toolName);
  if (!spec) throw new Error(`manifest-tools: 插件 '${manifestId}' 无工具 '${toolName}'`);
  const parameters = spec.schema;
  return {
    name: () => spec.name,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) =>
      exec('tool_call', { plugin: manifestId, tool: spec.name, args }, onProgress, signal),
  };
}

/** search 域工具族（builtin.search）——原 zod 定义的逐字节转录，表序不变。 */
export function createSearchTools(exec: ToolExecutor): Tool[] {
  return [manifestTool('builtin.search', 'search_content', exec)];
}

/** web 域工具族（builtin.web）——原 zod 定义的逐字节转录，表序不变。 */
export function createWebTools(exec: ToolExecutor): Tool[] {
  return [manifestTool('builtin.web', 'web_search', exec), manifestTool('builtin.web', 'web_fetch', exec)];
}
