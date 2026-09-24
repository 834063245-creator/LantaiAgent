// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// search 输出组装（R2-d(2)，kernel-capability-r2-search-pilot.md §8）——
// search_cap 能力口收窄为纯扫描后，输出三形态（content / files_with_matches /
// count）组装、行号显示、head/offset 分页、截断判定的 TS 编排层（与 schema
// 真源同域：agent/tools/manifest-tools.ts searchCapTool）。
//
// 输出形状逐字节等价于 R2-d(2) 前 Rust search_cap.rs 的组装分支（键序 = 原
// serde_json::json! 构造序——JSON.stringify 保持插入序；消费方 parseJson 后
// 字段语义不变）。缺省值/上限与退役前口内逻辑同款：
//   max_results 缺省 50、上限 200；context_lines 缺省 0、上限 10；
//   output_mode 缺省 content；show_line_numbers 缺省 true；
//   head_limit 缺省 250（0 = 不分页）；offset 缺省 0。
// 扫描收窄键按形态分派：content → max_matches（行级断）；files/count →
// max_files（文件级断，触顶置 budget_truncated）；collect_lines 仅 content
// 为 true（携带命中行与上下文邻居）。

/** 原始命中：上下文邻居行（含命中行自身——ctx=0 时即单行块）。 */
export interface ScanContextLine {
  line: number;
  content: string;
}

/** 原始命中：一次行命中。 */
export interface ScanMatch {
  line: number;
  content: string;
  context: ScanContextLine[];
}

/** 原始命中集的 per-file 条目。 */
export interface ScanFileEntry {
  file: string;
  match_count: number;
  matches: ScanMatch[];
}

/** search_cap 纯扫描返回的统一原始命中集。
 *  （向量语义召回尾键 vector_hits/vector_backend 已随图谱全量退役删除，
 *  2026-09-09——向量边车原经引擎 transport，壳内零引擎接线后不再出现。） */
export interface ScanOutput {
  pattern: string;
  scanned_files: number;
  budget_truncated: boolean;
  files: ScanFileEntry[];
}

/** searchCapTool 的模型面参数（zod 缺省后；编排读的形状——全字段可选 =
 *  execute args 的 Record<string, unknown> 直访形态，必填/类型校验在 schema 面
 *  与 Rust req_str）。 */
export interface SearchToolArgs {
  directory?: string;
  pattern?: string;
  fileTypes?: string;
  maxResults?: number;
  useRegex?: boolean;
  contextLines?: number;
  outputMode?: 'content' | 'files_with_matches' | 'count';
  showLineNumbers?: boolean;
  headLimit?: number;
  offset?: number;
  globFilter?: string;
}

/** 模型面参数 → search_cap 纯扫描参数（顶层 snake；meta 键由调用方附加）。 */
export function toScanParams(args: SearchToolArgs): Record<string, unknown> {
  const mode = args.outputMode ?? 'content';
  const max = Math.min(args.maxResults ?? 50, 200);
  const ctx = Math.min(args.contextLines ?? 0, 10);
  const out: Record<string, unknown> = {
    directory: args.directory,
    pattern: args.pattern,
    context_lines: ctx,
  };
  if (args.fileTypes !== undefined) out.file_types = args.fileTypes;
  if (args.useRegex !== undefined) out.use_regex = args.useRegex;
  if (args.globFilter !== undefined) out.glob_filter = args.globFilter;
  if (mode === 'content') {
    out.max_matches = max;
    out.collect_lines = true;
  } else {
    out.max_files = max;
    out.collect_lines = false;
  }
  return out;
}

/** 解析能力口原始命中集（agentInvoke 回卷的 JSON 字符串 → 结构）。 */
export function parseScanOutput(raw: string): ScanOutput {
  const parsed = JSON.parse(raw) as ScanOutput;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.files)) {
    throw new Error('search_cap: 能力口返回非原始命中集形状（files 缺失）');
  }
  return parsed;
}

/** head/offset 分页（head=0 = 不分页——退役前同款语义）。 */
function paginate<T>(items: T[], head: number, skip: number): T[] {
  return head > 0 ? items.slice(skip, skip + head) : items;
}

/**
 * 统一原始命中集 → 模型面三形态输出（JSON 字符串）。
 * 键序与 R2-d(2) 前 Rust 组装分支逐字节一致（消费方 JSON.parse 语义不变）。
 */
export function assembleSearchOutput(args: SearchToolArgs, scan: ScanOutput): string {
  const mode = args.outputMode ?? 'content';
  const showLn = args.showLineNumbers ?? true;
  const head = args.headLimit ?? 250;
  const skip = args.offset ?? 0;
  const ctx = Math.min(args.contextLines ?? 0, 10);

  let output: Record<string, unknown>;
  if (mode === 'files_with_matches') {
    const files = scan.files.map((f) => f.file).sort();
    const total = files.length;
    output = {
      pattern: scan.pattern,
      count: total,
      truncated: (head > 0 && skip + head < total) || scan.budget_truncated,
      scanned_files: scan.scanned_files,
      budget_truncated: scan.budget_truncated,
      files: paginate(files, head, skip),
    };
  } else if (mode === 'count') {
    // 每文件命中计数降序（同计数序次不保证——退役前 HashMap 迭代序本就非确定）
    const counts = scan.files
      .map((f) => ({ file: f.file, matches: f.match_count }))
      .sort((a, b) => b.matches - a.matches);
    const total = counts.length;
    output = {
      pattern: scan.pattern,
      total_matches: counts.reduce((sum, c) => sum + c.matches, 0),
      file_count: total,
      truncated: (head > 0 && skip + head < total) || scan.budget_truncated,
      scanned_files: scan.scanned_files,
      budget_truncated: scan.budget_truncated,
      files: paginate(counts, head, skip),
    };
  } else {
    // content：原始命中 → 结果条目（上下文块含 is_match 判定与行号显示开关）
    const results = scan.files.flatMap((f) =>
      f.matches.map((m) => ({
        file: f.file,
        match_line: m.line,
        match_content: m.content,
        context: ctx,
        context_block: m.context.map((c) => ({
          line: showLn ? c.line : null,
          content: c.content,
          is_match: c.line === m.line,
        })),
      })),
    );
    const total = results.length;
    output = {
      pattern: scan.pattern,
      count: total,
      truncated: (head > 0 && skip + head < total) || scan.budget_truncated,
      scanned_files: scan.scanned_files,
      budget_truncated: scan.budget_truncated,
      context_lines: ctx,
      results: paginate(results, head, skip),
    };
  }

  return JSON.stringify(output);
}
