// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// manifest-tools — 从内核插件 manifest 生成 Agent 可见工具（kernel-plugin-runtime Phase 1）。
//
// 工具面单一真源的演进（R2 试点，kernel-capability-r2-search-pilot.md）：
// - Phase 1（P0-2 脚手架）：真源 = Rust manifest（manifest.json → generated 镜像）。
// - R2-d(1)（2026-09-04）：search 域 schema 真源**回 TS zod**（INVARIANTS #8
//   原版语义——R2 试点域先回；R5 全量拆 manifest 脚手架时其余域同迁）。search_content
//   不再从 kernel-manifests 镜像取 schema，改由域内 zod 转录（逐字节等价于退役前
//   manifest 发射，收敛零漂移）。
// - R2-d(2)（2026-09-05）：编排同域——search_cap 能力口收窄为纯扫描（统一原始
//   命中集 + max_matches/max_files 收窄键），三形态组装/分页/行号显示回本域
//   search-assembly.ts 重建（schema 真源 + 编排同域，r2-search-pilot §8）。
// - execute 走 search_cap 能力口直呼（R2-a 信封换直呼：不经 tool_call 信封）。
//
// 注：web/browser/uia/pty/lsp 域仍取 manifest 镜像（Phase 1/2 存量，R3-R5
// 分批迁回 zod）。

import { z } from 'zod';
import type { Tool, ToolExecutor } from '../tool';
import { toInputJsonSchema } from './define-tool';
import { KERNEL_MANIFESTS } from './kernel-manifests.generated';
import { assembleSearchOutput, parseScanOutput, type SearchToolArgs, toScanParams } from './search-assembly';

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

/** search 域工具族（R2 试点）——schema 真源 = 下方 zod 转录（R2-d(1)，
 *  不再从 kernel-manifests 镜像取 builtin.search 字节）；execute 从 tool_call
 *  信封换 search_cap 能力口直呼 + camelCase→snake_case 键映射（键位修复，
 *  R2-a 曾摊 camelCase 被 bridge.rpc() 顶层转换吞掉可选参数）。表序不变。 */
export function createSearchTools(exec: ToolExecutor): Tool[] {
  return [searchCapTool(exec)];
}

// ═══════════════════════════════════════════════════════════════
// 能力口工具（R2 试点，kernel-capability-r2-search-pilot.md）——
// execute 直呼 search_cap 能力口（不经 tool_call 信封 / PluginRegistry）。
// R2 语义：编排未迁前，能力口输出与 builtin.search 完全同形状，纯执行通道
// 换轨；权限真权路径同 resolve_read_dispatch（Agent 过闸 / UI 只解析）。
// ═══════════════════════════════════════════════════════════════

/**
 * search_content schema — R2-d(1) zod 真源转录（2026-09-04）。
 * 逐键等价于退役前 builtin.search manifest.json 的 schema 发射（键名 camelCase、
 * 描述、default、int 下界 -9007199254740991、上界、enum、additionalProperties
 * 空对象全对齐——探针实测仅 optional-string 的 description/type 值内键序有差，
 * 收敛快照 stableStringify 字典序无感，零漂移）。
 * 键映射注：schema 面说 manifest 语言（camelCase，模型可见契约不变）；
 * execute 出口把 camelCase 映射 snake_case 直呼 search_cap（bridge.rpc()
 * 顶层转换只作用于 snake_case 直传键——R2-a 键位断层修复，见 rpc-contract）。
 */
const searchContentSchema = z.object({
  directory: z.string().describe('Absolute path to the directory to search in'),
  pattern: z.string().describe('Text or regex pattern to search for (case-insensitive)'),
  fileTypes: z.string().describe('Optional comma-separated file extensions to filter (e.g. ".ts,.py,.rs")').optional(),
  maxResults: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(200)
    .default(50)
    .describe('Maximum number of results to return (default: 50, max: 200)'),
  useRegex: z
    .boolean()
    .default(false)
    .describe(
      'Set to true to interpret pattern as a regex (e.g. "function\\\\s+\\\\w+"). Default: false (literal substring)',
    ),
  contextLines: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .default(0)
    .describe('Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.'),
  outputMode: z
    .enum(['content', 'files_with_matches', 'count'])
    .default('content')
    .describe(
      'Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content.',
    ),
  showLineNumbers: z.boolean().default(true).describe('Include line numbers in output (default: true)'),
  headLimit: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .default(250)
    .describe('Max results/files to return (default: 250, 0 = unlimited)'),
  offset: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .default(0)
    .describe('Skip first N results for pagination (default: 0)'),
  globFilter: z.string().describe('Additional glob filter on file paths (e.g. "**/*.rs", "src/**/*.ts")').optional(),
});

const SEARCH_CONTENT_NAME = 'search_content' as const;
const SEARCH_CONTENT_DESCRIPTION =
  'Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.';

/** search_content 能力口工具。schema 自持 zod 真源（R2-d(1)），不再依赖
 *  kernel-manifests 镜像 / manifest spec 查找；execute 直呼 search_cap。
 *  is_agent 由 executor 层 agentInvoke 注入（与 tool_call 同款）。
 *  R2-d(2)（r2-search-pilot §8）：编排同域——能力口收窄为纯扫描（统一原始
 *  命中集），三形态组装/分页/行号显示在本域 search-assembly.ts 重建。 */
export function searchCapTool(exec: ToolExecutor): Tool {
  const parameters = toInputJsonSchema(searchContentSchema.passthrough());
  return {
    name: () => SEARCH_CONTENT_NAME,
    description: () => SEARCH_CONTENT_DESCRIPTION,
    parameters: () => parameters,
    readOnly: () => true,
    execute: (args, onProgress, signal) =>
      withProgressStream(args, onProgress, async () => {
        // camelCase（模型参数）→ snake_case（能力口 RPC 契约）；meta 键透传
        // （_agent_id 已是 snake；isAgent 由 agentInvoke 注入）。编排键
        // （outputMode/showLineNumbers/headLimit/offset）不下沉能力口——由
        // toScanParams 折算为收窄键（max_matches/max_files/collect_lines）。
        const scanParams: Record<string, unknown> = {
          ...toScanParams(args as SearchToolArgs),
        };
        for (const [k, v] of Object.entries(args)) {
          if (k.startsWith('_')) scanParams[k] = v;
        }
        const raw = await exec('search_cap', scanParams, onProgress, signal);
        return assembleSearchOutput(args as SearchToolArgs, parseScanOutput(raw));
      }),
  };
}

// ═══════════════════════════════════════════════════════════════
// web 域模型族 zod 真源（kernel-capability-d4-handle-design.md R4-4 小面
// 清偿，2026-09-05）：builtin.web 插件退役，2 工具 schema 真源回 TS zod
// （逐键等价退役前 manifest 发射）；execute 换 web_cap 能力口直呼
// （maxResults→max_results 顶层映射；口内 WebFetchTool 闸 + SSRF）。
// ═══════════════════════════════════════════════════════════════

const webSearchSchema = z.object({
  query: z.string().describe('Search keywords'),
  maxResults: z.number().int().min(1).max(10).default(10).describe('Number of results to return (default 10, max 10)'),
});

const webFetchSchema = z.object({
  url: z.string().describe('The URL to fetch (HTTPS or HTTP only)'),
});

/** web 域动作 → zod schema（schema 真源表）。 */
const WEB_CAP_SCHEMA = { web_search: webSearchSchema, web_fetch: webFetchSchema } as const;

/** web 域动作 → 模型面 description（manifest 字节转录）。 */
const WEB_CAP_DESCRIPTION: Record<keyof typeof WEB_CAP_SCHEMA, string> = {
  web_search:
    'Search the internet for real-time information. Uses a free anonymous search API first; if it fails, automatically falls back to Bing/DuckDuckGo scraping. No API key required.',
  web_fetch:
    'Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.',
};

/** web_cap 直呼（maxResults 顶层映射 snake；meta 键原样透传）。 */
function webCapCall(
  exec: ToolExecutor,
  action: keyof typeof WEB_CAP_SCHEMA,
  args: Record<string, unknown>,
): Promise<string> {
  const out: Record<string, unknown> = { action };
  for (const [k, v] of Object.entries(args)) {
    out[k === 'maxResults' ? 'max_results' : k] = v;
  }
  return exec('web_cap', out);
}

/** web 域工具族（R4-4 起 zod 真源，不查 builtin.web 镜像）；TS 工具名保持
 *  历史名（模型面契约）；表序不变。 */
export function createWebTools(exec: ToolExecutor): Tool[] {
  const capTool = (action: keyof typeof WEB_CAP_SCHEMA): Tool => {
    const parameters = toInputJsonSchema(WEB_CAP_SCHEMA[action].passthrough());
    return {
      name: () => action,
      description: () => WEB_CAP_DESCRIPTION[action],
      parameters: () => parameters,
      readOnly: () => true,
      execute: (args, onProgress) => withProgressStream(args, onProgress, () => webCapCall(exec, action, args)),
    };
  };
  return [capTool('web_search'), capTool('web_fetch')];
}
