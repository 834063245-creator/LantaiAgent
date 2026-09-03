// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/grammar — 事件语义分类（stream-rhythm 刀1：docs/plans/stream-rhythm-plan.md §2.3）。
//
// 版式语法表的事件词表是「推导」不是「数据」：会话流里只有 tool call
// （name + args），读 / 写 / 验证 / 提交四族由分类器从名字面 + 参数推导：
//   ① 领域名 → 旧语义名：复用 ui/tool-semantics 的 resolveSemanticToolName
//      （DOMAIN_SPECS 是单一权威源，此处不存第三份 name→name 映射）；
//   ② 旧语义名 → 族：本文件的族表（族是版式语义——节奏档与阶段标记的判据，
//      不是工具语义——此处即权威）。
//
// 兜底铁律（计划 §2.3）：远端 MCP / 插件工具名字面动态（S4-4 乙形态），
// 未知名绝不破语法——落 other（调用方带 readOnly 证据时落 read）。分类错
// 不致命：族只影响节奏与标记，不进任何正确性路径。
//
// run_shell 单列：同名工具族随 command 内容变——test/build/lint 模式 =
// 验证族（写族 → 验证族链毕出「阶段完成」标记的判据），其余 = other。

import { resolveSemanticToolName } from '../ui/tool-semantics';

/** 工具族（版式语义：观察轻 / 产物重 / 验证换气 / 落款锚）。 */
export type ToolFamily = 'read' | 'write' | 'verify' | 'commit' | 'other';

/** 旧语义名 → 族（第一方默认表；领域动作经 resolveSemanticToolName 反查到旧名后入表）。 */
const FAMILY_BY_SEMANTIC_NAME: Record<string, ToolFamily> = {
  // fs 观察面
  read_file_content: 'read',
  list_directory: 'read',
  glob: 'read',
  search_content: 'read',
  read_constraints: 'read',
  // git 观察面
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  git_blame: 'read',
  // 图查询（graph 域全部只读）
  search_symbols: 'read',
  semantic_search: 'read',
  get_neighbors: 'read',
  trace_impact: 'read',
  find_dep_path: 'read',
  inspect_symbol: 'read',
  explore_deps: 'read',
  get_community: 'read',
  cluster_report: 'read',
  graph_summary: 'read',
  detect_cycles: 'read',
  coupling_report: 'read',
  fragile_modules: 'read',
  arch_blindspots: 'read',
  check_boundaries: 'read',
  thread_conflicts: 'read',
  async_edges: 'read',
  find_unused: 'read',
  list_flows: 'read',
  get_flow: 'read',
  get_affected_flows: 'read',
  trace_dataflow: 'read',
  preflight_check: 'read',
  grpc_services: 'read',
  graph_diff: 'read',
  dataflow_query: 'read',
  // lsp / ops 观察面
  resolve_call: 'read',
  infer_type: 'read',
  find_implementations: 'read',
  find_references: 'read',
  validate_project: 'read',
  project_health: 'read',
  engine_status: 'read',
  project_timeline: 'read',
  // web / 任务板 / 记忆观察面
  web_fetch: 'read',
  task_get: 'read',
  task_list: 'read',
  agent_board: 'read',
  hologram_memory_read: 'read',
  hologram_memory_list: 'read',
  // agent 协调观察面（spawn/merge 等动作面落 other）
  agent_status: 'read',
  agent_list: 'read',
  agent_inbox: 'read',
  agent_lookup: 'read',
  agent_discover: 'read',
  // browser / desktop 观察面
  browser_targets: 'read',
  browser_sessions: 'read',
  browser_snapshot: 'read',
  browser_content: 'read',
  browser_inspect: 'read',
  browser_report: 'read',
  browser_console: 'read',
  browser_network: 'read',
  browser_network_detail: 'read',
  browser_network_har: 'read',
  browser_status: 'read',
  browser_audit: 'read',
  desktop_probe: 'read',
  desktop_uia_tree: 'read',
  desktop_uia_find: 'read',
  desktop_uia_read: 'read',
  desktop_uia_wait: 'read',
  desktop_uia_window_shot: 'read',
  desktop_status: 'read',
  desktop_audit: 'read',
  // 资产 / shell 轮询观察面
  show_asset: 'read',
  list_block_kinds: 'read',
  bash_output: 'read',
  bash_wait: 'read',
  // fs 写面（File Change）
  write_file: 'write',
  edit_file: 'write',
  create_directory: 'write',
  move_file: 'write',
  rename_file: 'write',
  delete_file: 'write',
  write_constraints: 'write',
  // git 写面 / 图与符号写面
  git_stage: 'write',
  git_push: 'write',
  git_pull: 'write',
  git_checkout: 'write',
  git_create_branch: 'write',
  git_stash_push: 'write',
  git_stash_pop: 'write',
  git_discard: 'write',
  git_init: 'write',
  rename_symbol: 'write',
  import_scip: 'write',
  hologram_memory_save: 'write',
  hologram_memory_delete: 'write',
  dataflow_save: 'write',
  // 落款
  git_commit: 'commit',
};

/** run_shell 的验证命令模式（test/build/lint/typecheck 族的判据；
 *  误漏方向安全——漏判落 other 仍在工作单元内，只是不出「阶段完成」标记）。 */
const VERIFY_COMMAND_RE =
  /(cargo\s+(test|build|check|clippy)|(npm|pnpm|yarn)(\s+run)?\s+(test|build|lint|verify|typecheck|check)|npx\s+(vitest|jest|tsc|eslint|biome|playwright|mocha)|\b(vitest|jest|pytest|tsc|eslint|biome|ruff|mypy|mocha|make|cmake)\b|go\s+(test|vet|build)|gradle\s+(build|test)|mvn\s+(test|build)|dotnet\s+(test|build))/i;

/** 从工具参数 JSON 提取字符串字段（流式半程 JSON 解析失败 = undefined）。 */
function argString(argsJson: string | undefined, key: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const v = (JSON.parse(argsJson) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 工具调用 → 版式族。readOnly 是未知名的唯一兜底证据（动态名面兜底铁律）。 */
export function classifyTool(name: string, argsJson?: string, readOnly = false): ToolFamily {
  const sem = resolveSemanticToolName(name, argsJson);
  if (sem === 'run_shell') {
    const command = argString(argsJson, 'command') ?? '';
    return VERIFY_COMMAND_RE.test(command) ? 'verify' : 'other';
  }
  return FAMILY_BY_SEMANTIC_NAME[sem] ?? (readOnly ? 'read' : 'other');
}

/** 工具块 → 版式族（tool / code 块便捷面；code_execution 的族不可知，落 other）。 */
export function toolFamilyOfBlock(block: { kind: string; payload: unknown }): ToolFamily | null {
  if (block.kind !== 'tool') return null;
  const p = block.payload as { name?: string; args?: string };
  if (typeof p.name !== 'string') return null;
  return classifyTool(p.name, typeof p.args === 'string' ? p.args : undefined);
}

/* ── 节律族（stream-rhythm 刀5：族边界切单元的判据面）──
 * 用户真机反馈「整个会话流还是瀑布」的根因之一：刀1 的四族推导没有布局面
 * 消费。节律族 = 版式语法真正用来切节奏的族——other 不表态（观察不到关系
 * 就不断节奏；远端 MCP / 未知名不破语法铁律的节奏层延伸）。 */

/** 节律族：参与单元切分的四族（读 / 写 / 验 / 落款）。 */
export type RhythmFamily = 'read' | 'write' | 'verify' | 'commit';

/** 已表态族才参与节奏；other 收敛为 null（不表态）。 */
export function rhythmFamily(f: ToolFamily): RhythmFamily | null {
  return f === 'other' ? null : f;
}

/** 工具调用 → 节律族（translate 组切分与 group 单元切分共用的判据入口）。 */
export function rhythmFamilyOfTool(name: string, argsJson: string | undefined, readOnly = false): RhythmFamily | null {
  return rhythmFamily(classifyTool(name, argsJson, readOnly));
}

/** 块 → 节律族（布局消费单一入口）：
 *  tool → 自身节律族；toolgroup → 子项末位已表态族（组按族切开后恒同族，
 *  历史混组兜底取末位）；其余 kind（code / subagent / 夹注…）→ null 不表态。 */
export function rhythmFamilyOfBlock(block: { kind: string; payload: unknown }): RhythmFamily | null {
  const p = block.payload as {
    name?: string;
    args?: string;
    readOnly?: boolean;
    items?: Array<{ name?: string; args?: string; readOnly?: boolean }>;
  };
  if (block.kind === 'tool') {
    if (typeof p.name !== 'string') return null;
    return rhythmFamilyOfTool(p.name, typeof p.args === 'string' ? p.args : undefined, p.readOnly === true);
  }
  if (block.kind === 'toolgroup') {
    let last: RhythmFamily | null = null;
    for (const it of p.items ?? []) {
      if (typeof it?.name !== 'string') continue;
      const f = rhythmFamilyOfTool(it.name, typeof it.args === 'string' ? it.args : undefined, it.readOnly === true);
      if (f) last = f;
    }
    return last;
  }
  return null;
}
