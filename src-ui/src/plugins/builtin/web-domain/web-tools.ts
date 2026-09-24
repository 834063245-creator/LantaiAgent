// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// web 域模型族工具（**归家后真源**，2026-09-24 批 4b）。
//
// 来历：原 `agent/tools/manifest-tools.ts`（历史名）一文件载 search/web 两域——
// 而两域是两个产物包 ⇒ 一个文件不可能同时住在两个包里。本批按域拆开：
// web 半边进本包（search 半边连同 `./search-assembly` 进 `search-domain`）。
//
// schema 真源（kernel-capability-d4-handle-design.md R4-4 小面清偿，2026-09-05）：
// builtin.web 插件退役，2 工具 schema 真源回 TS zod（逐键等价退役前 manifest 发射）；
// execute 换 web_cap 能力口直呼（maxResults→max_results 顶层映射；口内
// WebFetchTool 闸 + SSRF）。

import { z } from 'zod';
import { type Tool, type ToolExecutor, toInputJsonSchema } from './host';

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
      execute: (args) => webCapCall(exec, action, args),
    };
  };
  return [capTool('web_search'), capTool('web_fetch')];
}
