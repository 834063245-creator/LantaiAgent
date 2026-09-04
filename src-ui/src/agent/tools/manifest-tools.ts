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

/** tool_call:progress 自持订阅（P2-4 §4.2，kernel-plugin-runtime 设计件）：
 *  execute 开始且 args._callId 存在且 onProgress 非空时订阅 tool_call:progress
 *  事件按 callId 过滤转发到 onProgress；settle（成功/异常）即解绑。事件不会
 *  早于 execute 开始（emit 只发生在插件执行期），无竞态窗口——不依赖 exec
 *  链透传 onProgress（生产链在 provider seam 处丢弃它是已知现状）。 */
export async function withProgressStream<T>(
  args: Record<string, unknown>,
  onProgress: ((chunk: string) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const callId = typeof args._callId === 'string' ? args._callId : undefined;
  if (!callId || !onProgress) return run();
  const { typedListen } = await import('../../rpc-contract');
  const unlisten = await typedListen('tool_call:progress', (e) => {
    if (e.callId === callId) onProgress(e.chunk);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

/** manifest 单工具声明（生成物镜像的类型面）。 */
export interface KernelToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  read_only?: boolean;
  /** 权限声明（Rust 侧 dispatch adapter 构造用；非模型面——TS 消费面不读它，
   *  类型面仅为生成物整包序列化镜像的字段覆盖）。 */
  permission?: {
    family: string;
    path_key?: string;
    command_key?: string;
    subcommand?: string;
  };
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
      withProgressStream(args, onProgress, () =>
        exec('tool_call', { plugin: manifestId, tool: spec.name, args }, onProgress, signal),
      ),
  };
}

/** search 域工具族（builtin.search，R2 试点起走能力口）——
 *  schema 仍取 manifest 字节（工具面零漂移），execute 从 tool_call 信封换
 *  search_cap 能力口直呼（searchCapTool）。表序不变。 */
export function createSearchTools(exec: ToolExecutor): Tool[] {
  return [searchCapTool('search_content', 'builtin.search', exec)];
}

// ═══════════════════════════════════════════════════════════════
// 能力口工具（R2 试点，kernel-capability-r2-search-pilot.md）——
// schema 仍取 manifest 字节（工具面零漂移），execute 从 tool_call 信封
// 换内核能力口直呼（search_cap RPC，不经 PluginRegistry / PluginToolAdapter）。
// R2 语义：编排未迁前，能力口输出与 builtin.search 完全同形状，纯执行通道
// 换轨；权限真权路径同 resolve_read_dispatch（Agent 过闸 / UI 只解析）。
// ═══════════════════════════════════════════════════════════════

/** search_cap 能力口参数（manifest schema 的 camelCase 键 + agent ctx）。
 *  与 rpc-contract search_cap 参数面一致；is_agent 由 agentInvoke 同款注入。 */
export function searchCapTool(toolName: string, manifestId: string, exec: ToolExecutor): Tool {
  const manifest = kernelManifestOf(manifestId);
  const spec = manifest.tools.find((t) => t.name === toolName);
  if (!spec) throw new Error(`manifest-tools: 能力口 '${manifestId}' 无工具 '${toolName}'`);
  const parameters = spec.schema;
  return {
    name: () => spec.name,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) =>
      withProgressStream(args, onProgress, () =>
        exec(
          'search_cap',
          // isAgent 由 executor 层 agentInvoke 注入（与 tool_call 同款）——
          // 工具层不手拼，Agent/UI 分流语义集中在 executor 单点。
          { ...args },
          onProgress,
          signal,
        ),
      ),
  };
}

/** web 域工具族（builtin.web）——原 zod 定义的逐字节转录，表序不变。 */
export function createWebTools(exec: ToolExecutor): Tool[] {
  return [manifestTool('builtin.web', 'web_search', exec), manifestTool('builtin.web', 'web_fetch', exec)];
}
