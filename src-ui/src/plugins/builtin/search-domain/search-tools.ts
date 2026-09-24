// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// search 域模型族工具（**归家后真源**，2026-09-24 批 4b）。
//
// 来历：原 `agent/tools/manifest-tools.ts`（历史名）一文件载 search/web 两域——
// 而两域是两个产物包 ⇒ 一个文件不可能同时住在两个包里。本批按域拆开：
// search 半边进本包（含随行编排件 `./search-assembly`），web 半边进 `web-domain`。
//
// schema 真源演进（R2 试点，kernel-capability-r2-search-pilot.md）：
// - Phase 1（P0-2 脚手架）：真源 = Rust manifest（manifest.json → generated 镜像）。
// - R2-d(1)（2026-09-04）：search 域 schema 真源**回 TS zod**（INVARIANTS #8
//   原版语义）；search_content 不再从 kernel-manifests 镜像取 schema，改由域内 zod
//   转录（逐字节等价于退役前 manifest 发射，收敛零漂移）。
// - R2-d(2)（2026-09-05）：编排同域——search_cap 能力口收窄为纯扫描（统一原始
//   命中集 + max_matches/max_files 收窄键），三形态组装/分页/行号显示由
//   `./search-assembly` 重建。
// - execute 走 search_cap 能力口直呼（不经 tool_call 信封）。

import { z } from 'zod';
import { type Tool, type ToolExecutor, toInputJsonSchema } from './host';
import { assembleSearchOutput, parseScanOutput, type SearchToolArgs, toScanParams } from './search-assembly';

/** search 域工具族（R2 试点）——schema 真源 = 下方 zod 转录（R2-d(1)，
 *  不再从 kernel-manifests 镜像取 builtin.search 字节）；execute 从 tool_call
 *  信封换 search_cap 能力口直呼 + camelCase→snake_case 键映射（键位修复，
 *  R2-a 曾摊 camelCase 被 bridge.rpc() 顶层转换吞掉可选参数）。表序不变。 */
export function createSearchTools(exec: ToolExecutor): Tool[] {
  return [searchCapTool(exec)];
}

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
 *  命中集），三形态组装/分页/行号显示在本域 `./search-assembly` 重建。 */
export function searchCapTool(exec: ToolExecutor): Tool {
  const parameters = toInputJsonSchema(searchContentSchema.passthrough());
  return {
    name: () => SEARCH_CONTENT_NAME,
    description: () => SEARCH_CONTENT_DESCRIPTION,
    parameters: () => parameters,
    readOnly: () => true,
    execute: async (args, onProgress, signal) => {
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
    },
  };
}
