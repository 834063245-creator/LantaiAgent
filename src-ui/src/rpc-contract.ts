// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC 契约 — 前后端 IPC 的单一类型事实源（前端侧投影）。
//
// 后端唯一权威源：src-tauri/src/rpc.rs（当前 106 个 RPC 方法，由
// scripts/gen-rpc-contract-md.cjs 生成目录）。本文件的 RpcContract 是
// typedRpc 可见的 UI 子集；Agent 工具调用走 agent/tool.ts 的 agentInvoke 动态分发。
// 维护纪律：后端加/改方法 → 同步更新本文件 RpcContract；
// docs/agents/frontend-rpc-contract.md 由 scripts/gen-rpc-contract-md.cjs
// 从 rpc.rs 生成，勿手改。
//
// 约定：
// - 参数键一律写 snake_case（与 Rust 端一致）；bridge.rpc() 对已是
//   snake_case 的键是直通，对 camelCase 键会自动转换，但契约内统一 snake_case。
// - result（rpc Value 化第二步，2026-08-22）：
//     `// JSON`  = JSON 形态。Rust 出口（rpc.rs rpc_result_shape 表）已把表内
//                 命令展开为真结构化 Value，typedJsonRpc 直接透传；表外 JSON
//                 命令（hologram_call/get_graph_page 等，形态不恒定或体量不可控）
//                 仍返 JSON 字符串，typedJsonRpc 双形态兼容（string 走 parse）。
//     `// text`  = 纯文本（文件内容、base64、git stdout、错误信息等）。
// - 新增前端一律用 typedRpc / typedListen，接线错误在编译期暴露；JSON 命令
//   用 typedJsonRpc（双形态 shim 在那里）。

import { z } from 'zod';

// biome-ignore lint/style/noRestrictedImports: 唯二受权的裸 rpc/listen 出口之一（另一个是 tool.ts 的 agentInvoke 动态分发豁免）
import { listen, rpc } from './bridge';

// ─────────────────────────────────────────────────────────────
// 方法契约
// ─────────────────────────────────────────────────────────────

/** Agent 上下文的公共可选参数（写操作需 is_agent + _agent_id 走权限路径）。
 *  workspace-session-ownership-rework（2026-08-27）：`_session_id` 已退役——
 *  引擎决议只跟活动工作区（单槽）走，会话 id 不参与引擎路由。 */
interface AgentCtx {
  is_agent?: boolean;
  _agent_id?: string;
  [key: string]: unknown;
}

export interface RpcContract {
  // ── 应用层：数据上下文（L1）────────────────────────────
  // （workspace-session-ownership-rework 2026-08-27：session_attach/detach/
  //  focus 三命令退役——会话只在所属工作区内打开，引擎决议只看活动工作区，
  //  无需会话绑定/焦点投影。）
  /** 数据上下文清单（诊断）。 */
  context_list: {
    params: Record<string, never>;
    result: string; // JSON
  };

  // ── Engine 调度 ──────────────────────────────────────────
  hologram_call: {
    params: { tool: string; args?: Record<string, unknown> } & AgentCtx;
    result: string; // JSON
  };
  hologram_tools_list: {
    params: Record<string, never>;
    result: string; // JSON
  };

  // ── Graph ────────────────────────────────────────────────
  // Phase 1.5（engine-plugin-extraction）：分页运输栈拆除——graphData =
  // 聚合快照（get_graph_snapshot / load_graph_json），按文件符号索引走
  // hologram_file_nodes 轻查询；跨边界不再传全量图体。
  load_graph_json: {
    params: { path?: string };
    result: string; // JSON — 聚合快照
  };
  analyze_and_load: {
    params: { path: string; force?: boolean };
    result: string; // JSON — 轻状态（分析完成后经 get_graph_snapshot 装载）
  };
  get_graph_snapshot: {
    params: Record<string, never>;
    result: string; // JSON — 聚合快照
  };
  hologram_file_nodes: {
    params: { file: string };
    result: string; // JSON — { file, count, nodes: [{id,name,kind,fan_in,fan_out}] }
  };

  // ── Git ──────────────────────────────────────────────────
  // （git_status / git_diff_unstaged / git_diff_staged / git_log / git_stage /
  //   git_stage_all / git_commit / git_push / git_pull / git_init / git_checkout /
  //   git_create_branch / git_stash_push / git_stash_pop / git_discard / git_blame
  //   已迁内核插件 builtin.git，走 tool_call——kernel-plugin-runtime P2-3。
  //   内部直呼统一经下方 kernelGitCall 助手。）

  // ── 文件系统 ─────────────────────────────────────────────
  // （fs 工具域已收敛到 fs_cap 能力口直呼——2026-09-04 fs 域收口，builtin.fs
  //   信封退役。内部 I/O 统一经下方 fsCapCall 一族助手，is_agent=false 用户路径。）
  get_last_project: {
    params: Record<string, never>;
    result: string; // JSON — 最近工作区路径 "path"/null（冷启动恢复信号，与图谱引擎无关）
  };
  workspace_list: {
    params: Record<string, never>;
    result: string; // JSON — 已知工作区清单（注册表 + 各工作区会话计数/dir_exists/graph_engine，含空工作区）
  };
  workspace_rename: { params: { path: string; name: string }; result: string }; // "null"
  workspace_toggle_pin: { params: { path: string; pinned: boolean }; result: string }; // "null"
  workspace_remove: { params: { path: string }; result: string }; // "null" — 删除该工作区全部会话 + 解除登记（删除失败报错且不解除登记）
  /** per-workspace 图谱引擎开关（首页卡片徽标切换入口）。生效语义 = 装配期一次（在途不活拆）。 */
  workspace_set_graph_engine: { params: { path: string; enabled: boolean }; result: string }; // "null"
  /** 新建工作区目录：~/Documents/兰台/<名字>，返回归一化路径。只建目录不登记（登记随后续 activate）。 */
  workspace_create_dir: { params: { name: string }; result: string }; // JSON — 归一化路径字符串

  // ── 内核插件运行时（kernel-plugin-runtime，2026-09-03）──────────
  // 统一工具入口：args 说 manifest schema 的语言（camelCase 键）；_agent_id meta 嵌在 args 内。
  tool_call: {
    params: {
      plugin: string;
      tool: string;
      args?: Record<string, unknown>;
    } & AgentCtx;
    result: string; // JSON
  };
  plugin_tool_manifests: {
    params: Record<string, never>;
    result: string; // JSON（全量 ToolManifest 数组）
  };

  // ── 能力口（R2 试点，kernel-capability-r2-search-pilot.md）──────────
  // search_cap：search 全文扫描能力口（fs 能力族变体，v3 §4）——不经 tool_call
  // 信封 / PluginRegistry。参数键 = 顶层 snake_case（bridge.rpc() 会把 camelCase
  // 转 snake——工具 execute 侧必须先把 schema 的 camelCase 参数映射为 snake_case
  // 再直呼；R2-a 曾直接摊 camelCase 导致可选参数全被转换吞掉，键位修复见
  // manifest-tools searchCapTool）。is_agent/agent_id 显式传（Agent 过 require_read
  // 闸 / UI 只解析；resolve_read_dispatch 需要 agent_id 做 worktree 前向映射）。
  search_cap: {
    params: {
      directory: string;
      pattern: string;
      file_types?: string;
      max_results?: number;
      use_regex?: boolean;
      context_lines?: number;
      output_mode?: 'content' | 'files_with_matches' | 'count';
      show_line_numbers?: boolean;
      head_limit?: number;
      offset?: number;
      glob_filter?: string;
      is_agent?: boolean;
      agent_id?: string | null;
    };
    result: string; // JSON — 与 builtin.search search_content 同形状
  };

  // ── 能力口（R3-a + 收口，kernel-capability-c3-design.md）──────────
  // fs_cap：fs 能力族直呼入口（read/list/list_flat/glob/write/delete/rename/
  // create_dir/append/read_base64/memory_batch/global_memory_dir）——不经
  // tool_call 信封 / PluginRegistry / PluginToolAdapter。参数键顶层 snake_case
  // （bridge.rpc() 转换幂等）；is_agent/agent_id 显式传（Agent 过
  // resolve_*_dispatch 闸 / UI 只解析）。编排（缺省/输出格式）归 TS。
  fs_cap: {
    params: {
      action:
        | 'read'
        | 'list'
        | 'list_flat'
        | 'glob'
        | 'write'
        | 'delete'
        | 'rename'
        | 'create_dir'
        | 'append'
        | 'read_base64'
        | 'memory_batch'
        | 'global_memory_dir';
      path?: string;
      from?: string;
      to?: string;
      file_path?: string;
      pattern?: string;
      dir?: string;
      content?: string;
      offset?: number;
      limit?: number;
      line_numbers?: boolean;
      filter_ignored?: boolean;
      paths?: string[];
      workspace_root?: string;
      is_agent?: boolean;
      agent_id?: string | null;
    };
    result: string; // JSON — read={path,content} / read_base64={path,base64} / list|list_flat={entries} / glob={pattern,count,truncated,results} / memory_batch=Record<path,content|null> / 写类={path}
  };

  // ── Shell ────────────────────────────────────────────────
  // （exec_command / bash_output / bash_kill / bash_wait / shell_env /
  //   background_activity / drain_bg_notifications 已迁内核插件 builtin.shell，
  //   走 tool_call——kernel-plugin-runtime P2-4。内部直呼统一经下方 kernelShellCall
  //   助手；shell:output / shell:done 事件双通道原样保留（§4.3 裁决）。）

  // ── 编辑器 ───────────────────────────────────────────────
  // （edit_file 已迁内核插件 builtin.editor，走 tool_call——kernel-plugin-runtime P2-1）

  // ── 身份认证 / 权限 ──────────────────────────────────────
  permission_ask_response: {
    params: {
      request_id: string;
      allow: boolean;
      remember?: boolean;
      rule_to_add?: string | null;
      rule_behavior?: 'allow' | 'deny' | 'ask';
    };
    result: string; // "null"
  };
  set_permission_mode: { params: { mode: string }; result: string }; // "null"
  credential_store: { params: { provider: string; key: string }; result: string }; // "null"
  credential_get: { params: { provider: string }; result: string }; // JSON
  credential_delete: { params: { provider: string }; result: string }; // "null"
  llm_proxy_port: { params: Record<string, never>; result: string }; // 端口号字符串（0=不可用）

  // ── 插件安装通道（S4-3）─────────────────────────────────
  /** 安装插件：source_kind = registry（name/version?/registry?）|
   *  tarball（location = URL 或本地 .tgz 路径）| local_dir（location =
   *  本地目录——复制进 plugins 根）。expect_name 可选校验 manifest.name。
   *  force = true 跳过版本守卫（平台化 P3：同名重装默认比较 manifest.version
   *  ——升级原子换装，同版本/降级拒绝）。返回安装的插件目录名。
   *  生效时机：重启（Phase 4 改运行时生效）。 */
  plugin_install: {
    params: {
      source_kind: 'registry' | 'tarball' | 'local_dir';
      name?: string;
      version?: string;
      registry?: string;
      location?: string;
      expect_name?: string;
      force?: boolean;
    };
    result: string; // 插件名（JSON 字符串）
  };
  /** 卸载插件（删目录；幂等）。生效时机：重启。 */
  plugin_uninstall: { params: { name: string }; result: string }; // "null"
  /** 启用/禁用插件（plugins.json 读改写）。生效时机：重启。 */
  plugin_set_enabled: { params: { name: string; enabled: boolean }; result: string }; // "null"
  /** 插件目录绝对路径（S4-4 乙机器桥：manifest mcpServers 的 stdio command
   *  相对插件目录解析）。名字围栏同 uninstall；目录不存在 = 错误。 */
  plugin_dir: { params: { name: string }; result: string }; // 绝对路径

  // ── Agent 隔离（worktree）────────────────────────────────
  agent_isolation_create: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_diff: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_merge: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_discard: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_status: { params: Record<string, never>; result: string }; // JSON
  agent_isolation_force_purge: { params: { agent_id: string }; result: string }; // JSON

  // ── 外部服务 ─────────────────────────────────────────────
  sandbox_status: { params: Record<string, never>; result: string }; // JSON — {degraded,reason}（Value 化：Rust 出口已展开）

  // ── Hologram 遗留命令 ────────────────────────────────────
  hologram_run_check: { params: { path?: string }; result: string }; // JSON
  hologram_record_event: {
    params: { event_type: string; file?: string; summary: string };
    result: string; // "null"（fire-and-forget）
  };

  // ── 工作区 ───────────────────────────────────────────────
  workspace_activate: {
    params: { path: string; graph_engine?: boolean | null };
    result: string;
  }; // "null" — graph_engine 缺省 = 保持注册表现值；显式值随登记写入（新建工作区 sheet）
  workspace_deactivate: { params: Record<string, never>; result: string }; // "null"
  workspace_start_watcher: { params: Record<string, never>; result: string }; // "null"

  // ── 会话持久化 ───────────────────────────────────────────
  // （workspace-session-ownership-rework 2026-08-27：chat 会话 NDJSON
  //  session_append 已拆——只写不读孤儿退役；唯一保留路径 = 工作区会话根
  //  全量快照（saveActiveSession/saveSessionById）。agent 侧
  //  session-log.ndjson 是另一条保留路径，见 agent_session_append。）
  agent_session_append: {
    params: { project_path: string; agent_id: string; messages: Record<string, unknown>[]; rewrite?: boolean };
    result: string; // "null"
  };

  // ── 约束 ─────────────────────────────────────────────────
  // （read_constraints / write_constraints 已迁内核插件 builtin.constraints，
  //   走 tool_call——kernel-plugin-runtime P2-1）

  // ── 数据流 ───────────────────────────────────────────────
  dataflow_save: {
    params: { query: string; content?: string; explore_result?: string; dataflow_result?: string };
    result: string; // text
  };
  dataflow_query: { params: { trace_id?: string; list?: boolean }; result: string }; // JSON
  dataflow_delete: { params: { trace_id: string }; result: string }; // text

  // （pty_spawn/write/resize/kill 已迁内核插件 builtin.pty——PTY 会话经 tool_call
  //   信封消费，kernel-plugin-runtime P2-6；pty-output 事件行仍在本文件 EventContract。）

  // （lsp_start/request/stop 已迁内核插件 builtin.lsp——LSP 会话经 tool_call
  //   信封消费（kernelLspCall），lsp-message 事件行仍在本文件 EventContract，
  //   kernel-plugin-runtime P2-6。）

  // （background_activity 已迁内核插件 builtin.shell——状态栏 HUD 经
  //   kernelShellCall('background_activity') 信封消费，kernel-plugin-runtime P2-4。
  //   browser_audit 已迁 builtin.browser——审计查询经浏览器域工具信封消费，
  //   无 typedRpc 直呼点，RpcContract 行随 RPC 分支退役，kernel-plugin-runtime P2-5。）

  // ── MCP / ACP stdio 桥 ────────────────────────────────────
  protocol_bridge_spawn: {
    params: { id: string; command: string; args?: string[] };
    result: string;
  };
  protocol_bridge_write: {
    params: { id: string; line: string };
    result: string;
  };
  protocol_bridge_kill: {
    params: { id: string };
    result: string;
  };
}

// ─────────────────────────────────────────────────────────────
// 事件契约（Rust 侧 app.emit，前端 listen）
// ─────────────────────────────────────────────────────────────

export interface EventContract {
  /** 权限请求弹窗（响应走 rpc permission_ask_response） */
  'permission-ask': {
    requestId: string;
    tool: string;
    path: string;
    reason: string;
    danger: string;
    agentId: string;
    suggestions: { rule: string; behavior: 'allow' | 'deny' | 'ask' }[];
  };
  /** analyze_and_load 进度 */
  'analyze-progress': { current: number; total: number; file: string };
  /** analyze_and_load 心跳 */
  'analyze-heartbeat': { label: string; elapsed: string };
  /** analyze_and_load 阶段切换 */
  'analyze-phase': { phase: string; message: string };
  /** LSP 消息 */
  'lsp-message': { session_id: number; message: unknown };
  /** 前台 shell 输出流 */
  'shell:output': { streamId: string; kind: 'stdout' | 'stderr'; chunk: string };
  /** 前台 shell 结束 */
  'shell:done': { streamId: string; exitCode: number; error?: string };
  /** 内核插件工具的增量输出流（P2-4 §4.1：ToolContext::emit_progress 按
   *  _callId 键控回推；TS 侧 manifest 工具经 withProgressStream 自持订阅
   *  转发到 onProgress。与 shell:output/shell:done 正交——shell 不迁自有流式） */
  'tool_call:progress': { callId: string; chunk: string };
  /** 图变更摘要（workspace.rs 发射，分析完成后触发前端重载分页图） */
  'graph-updated': string;
  /** PTY 输出（src-tauri 发射；旧前端未监听，新前端用 PTY 时需要） */
  'pty-output': { session_id: number; data: string };
  /** MCP/ACP stdio 桥 stdout 行 */
  'protocol-bridge:output': { id: string; line: string };
  /** MCP/ACP stdio 桥子进程退出 */
  'protocol-bridge:exit': { id: string };
  /** 后台任务有新通知（完成/停滞）— utils/bg_jobs.rs 监视线程发射；
   *  owner = 发起该 job 的 agent id，null 表示用户/UI 发起（不投给任何 agent）。
   *  前端监听后排干该 owner 的通知并经 MessageBus systemNotify 唤醒 idle agent。 */
  'bg:note': { jobId: number; owner: string | null };
  /** 组合层热重载（S4-2，src-tauri composition_watcher.rs 发射）：根级
   *  roster.patch.yml 变更（"modified" | "removed"）→ 前端 patch-loader
   *  重跑 reload → composition-store 更新（新 Agent 装配即用新组合；
   *  在途会话不动——创建时点冻结语义）。 */
  'composition:changed': string;
}

// ─────────────────────────────────────────────────────────────
// 类型化调用层
// ─────────────────────────────────────────────────────────────

export type RpcMethodName = keyof RpcContract;
export type RpcParamsOf<M extends RpcMethodName> = RpcContract[M]['params'];
export type RpcResultOf<M extends RpcMethodName> = RpcContract[M]['result'];

/** 方法名/参数在编译期受 RpcContract 约束的 rpc 调用。 */
export async function typedRpc<M extends RpcMethodName>(method: M, params: RpcParamsOf<M>): Promise<RpcResultOf<M>> {
  return rpc<RpcResultOf<M>>(method, params);
}

/** 带超时的类型化调用——只给「每步都会经过、且失败可安全跳过」的
 *  best-effort 调用兜底（如 loop 顶部的 drain_bg_notifications / plan
 *  提醒读取）。Tauri invoke 本身无超时语义：Rust 侧卡死或回包丢失时，
 *  无界 await 会让 run() 永不 settle（UI 永卡运行态的挂起源之一）。
 *  不要 blanket 化——bash 等长任务工具调用没有超时才是正确语义。
 *  超时后底层 invoke 仍可能在途：调用方须保证超时分支的跳过是安全的。 */
export async function typedRpcWithTimeout<M extends RpcMethodName>(
  method: M,
  params: RpcParamsOf<M>,
  timeoutMs: number,
): Promise<RpcResultOf<M>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      typedRpc(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`rpc ${method} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 解析 Rust 返回的 JSON 字符串（ok_json 类方法）。"null" 会解析为 null。 */
export function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/** JSON 返回命令的类型化调用（rpc Value 化两步 + 边界运行时校验层，2026-09-01）：
 *  parse 收进本函数（调用点不手写双重编码）；result 形状经 rpcResultSchemas
 *  safeParse，违形即 throw（错误信息带方法名 + zod issue 摘要，宪法四）。
 *  method 收紧为已收编命令集（keyof typeof rpcResultSchemas）——新调用未入表
 *  命令 = 编译错，签名即守卫；`// text` 命令继续 typedRpc 直通。
 *  双形态兼容（Value 化第二步）：JsonValue 形态命令在 Rust 出口已展开为真
 *  结构化 Value，直接校验；浏览器 mock / 表外形态仍返 JSON 字符串，parse
 *  慢路径后同样校验。校验规整后返回新对象——同引用透传属性退役。 */
export async function typedJsonRpc<M extends keyof typeof rpcResultSchemas>(
  method: M,
  params?: RpcParamsOf<M>,
): Promise<RpcSchemaResultOf<M>> {
  const raw = await rpc<unknown>(method, params ?? {});
  const value: unknown = typeof raw === 'string' ? parseJson(raw) : raw;
  const parsed = rpcResultSchemas[method].safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`rpc ${String(method)}: 返回形状违反契约 — ${issues}`);
  }
  return parsed.data as RpcSchemaResultOf<M>;
}

// ─────────────────────────────────────────────────────────────
// 运行时契约：JSON 命令 result 形状（rpc 边界运行时校验层，2026-09-01）
// ─────────────────────────────────────────────────────────────

/** DirEntry 递归形状（Rust utils::DirEntry 序列化同形——children 键恒在，
 *  无子为 null；truncated 截断旗标偶现）。list_directory / list_directory_flat 共用。 */
export type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  children: DirEntry[] | null;
  truncated?: boolean;
};

const dirEntrySchema: z.ZodType<DirEntry> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      path: z.string(),
      is_dir: z.boolean(),
      children: z.nullable(z.array(dirEntrySchema)),
      truncated: z.boolean().optional(),
    })
    .passthrough(),
);

/** list_directory / list_directory_flat 信封化后的返回形状校验（导出供
 *  rpc-result-schemas.test.ts 四态守护——旧 rpcResultSchemas 行已随 RPC 退役）。 */
export const dirEntryArraySchema = z.array(dirEntrySchema);

// ─────────────────────────────────────────────────────────────
// fs 能力口直呼便捷封装（kernel-capability-c3-design.md fs 域收口）
// ─────────────────────────────────────────────────────────────
// 内部持久化 I/O（canvas / 会话卷 / 记忆 / 技能 / 日志 / 渲染资产）的统一
// 出口：fs_cap 能力口直呼（builtin.fs 信封已退役——2026-09-04 fs 域收口）。
// 参数键 = fs_cap 顶层 snake_case（bridge.rpc() 转换幂等）；调用方一律用户
// 路径（is_agent=false 显式传——resolve_*_dispatch 只解析不过 Ask）。
// 返回 = fs_cap JSON 字符串，各 helper 解析取所需字段。

/** fs_cap 能力口直呼（返回 JSON 字符串）。is_agent=false = 用户路径。 */
function fsCapCall(params: RpcParamsOf<'fs_cap'>): Promise<string> {
  return typedRpc('fs_cap', params);
}

/** fs_cap read 统一：raw=true → 原文（line_numbers=false）；缺省/raw=false →
 *  行号格式（与旧 read_file_content 默认一致）。返回解析后的实际文件文本。 */
async function fsCapReadText(
  filePath: string,
  opts?: { raw?: boolean; offset?: number; limit?: number },
): Promise<string> {
  const raw = await fsCapCall({
    action: 'read',
    file_path: filePath,
    line_numbers: opts?.raw !== true,
    ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
    ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    is_agent: false,
  });
  try {
    const parsed = parseJson<{ path?: string; content?: unknown }>(raw);
    if (typeof parsed.content === 'string') return parsed.content;
  } catch {
    // 非 JSON（测试 mock / 异常文本）——直通
  }
  return raw;
}

/** 文本读（offset/limit 行号分页；raw=true 返回原文——P1-3 JSON 读取面）。 */
export function kernelReadFile(filePath: string, opts?: { raw?: boolean }): Promise<string> {
  return fsCapReadText(filePath, opts);
}

/** 全量原文读（canvas / 会话卷等 JSON 消费面的惯用形）。 */
export function kernelReadFileRaw(filePath: string): Promise<string> {
  return fsCapReadText(filePath, { raw: true });
}

/** fs_cap 写类 action 返回解析：取 {path} 的 path；非 JSON/无 path（测试 mock
 *  旧文案等）直通 raw——消费端多为 await 丢弃返回，容错直通等价。 */
function fsCapPathOf(raw: string): string {
  try {
    const parsed = parseJson<{ path?: unknown }>(raw);
    if (typeof parsed.path === 'string') return parsed.path;
  } catch {
    // 非 JSON——直通
  }
  return raw;
}

/** 原子写入（父目录自动创建；fs_cap write 返回解析后路径）。 */
export async function kernelWriteFile(filePath: string, content: string): Promise<string> {
  const raw = await fsCapCall({ action: 'write', file_path: filePath, content, is_agent: false });
  return fsCapPathOf(raw);
}

/** 创建目录（含父目录）。 */
export async function kernelCreateDirectory(path: string): Promise<string> {
  const raw = await fsCapCall({ action: 'create_dir', path, is_agent: false });
  return fsCapPathOf(raw);
}

/** 删除文件或目录树（不可逆）。 */
export async function kernelDeleteFile(path: string): Promise<string> {
  const raw = await fsCapCall({ action: 'delete', path, is_agent: false });
  return fsCapPathOf(raw);
}

/** 日志追加（fs_cap append——resolve_write_dispatch 用户路径只解析；旧
 *  builtin.fs log_append 的 EditTool sync 检查对 .lantai 内部写本放行，
 *  语义等价：UI 写 .lantai/logs 不受规则拦）。 */
export async function kernelLogAppend(path: string, content: string): Promise<string> {
  const raw = await fsCapCall({ action: 'append', path, content, is_agent: false });
  return fsCapPathOf(raw);
}

/** 全局记忆目录路径。 */
export async function kernelGlobalMemoryDir(): Promise<string> {
  const raw = await fsCapCall({ action: 'global_memory_dir', is_agent: false });
  return fsCapPathOf(raw);
}

/** list_directory 的 JSON 形状版（递归树/截断旗标同 dirEntrySchema 契约）。
 *  兼容双形状：fs_cap 真返回 {entries} 包装；测试 mock / 旧形态直返裸数组
 *  （mock 模拟 list_directory 返回 DirEntry[]）。 */
export async function kernelListDirectory(path: string, filterIgnored?: boolean): Promise<DirEntry[]> {
  const raw = await fsCapCall({ action: 'list', path, filter_ignored: filterIgnored ?? true, is_agent: false });
  const parsed = dirEntryArraySchema.safeParse(listPayloadOf(raw));
  if (!parsed.success) {
    throw new Error(`kernelListDirectory: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** list_directory_flat 的 JSON 形状版（非递归单层）。兼容双形状同 list。 */
export async function kernelListDirectoryFlat(path: string): Promise<DirEntry[]> {
  const raw = await fsCapCall({ action: 'list_flat', path, is_agent: false });
  const parsed = dirEntryArraySchema.safeParse(listPayloadOf(raw));
  if (!parsed.success) {
    throw new Error(`kernelListDirectoryFlat: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** list action 返回载荷提取：{entries} 包装取 entries；裸数组（测试 mock /
 *  旧形态）直用。非 JSON 返回 null（调用方 zod 校验兜错）。 */
function listPayloadOf(raw: string): unknown {
  try {
    const parsed = parseJson<{ entries?: unknown } | unknown[]>(raw);
    if (Array.isArray(parsed)) return parsed;
    return (parsed as { entries?: unknown }).entries ?? null;
  } catch {
    return raw; // 非 JSON——zod safeParse 兜错（字符串非数组 → 失败）
  }
}

/** read_memory_batch 的 JSON 形状版（.lantai 内多文件批量读）。 */
export async function kernelReadMemoryBatch(paths: string[]): Promise<Record<string, string | null>> {
  const raw = await fsCapCall({ action: 'memory_batch', paths, is_agent: false });
  const parsed = z.record(z.string(), z.nullable(z.string())).safeParse(parseJson(raw));
  if (!parsed.success) {
    throw new Error(`kernelReadMemoryBatch: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** 媒体渲染二进制读（read_file_base64——renderer 消费，8MiB 源上限）。 */
export async function kernelReadFileBase64(filePath: string): Promise<string> {
  const raw = await fsCapCall({ action: 'read_base64', file_path: filePath, is_agent: false });
  const parsed = parseJson<{ base64?: string }>(raw);
  if (typeof parsed.base64 !== 'string') return raw;
  return parsed.base64;
}

// ── builtin.git 直呼便捷封装（kernel-plugin-runtime P2-3）──
// 内部消费方（state-inject 的 git_status 状态栏 / git_blame 行级归属缓存）
// 的统一出口：tool_call 信封寻址 builtin.git（旧 RPC 分支随迁退役）。

/** git 域通用信封调用（text 形态结果直通；JSON 形态消费方自行 parseJson）。 */
export function kernelGitCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('tool_call', { plugin: 'builtin.git', tool, args });
}

// ── builtin.shell 直呼便捷封装（kernel-plugin-runtime P2-4）──
// 内部消费方（queued-shell / agent-builder 的执行链、runtime 的 shell_env
// 注入、workspace/default-loop 的 drain_bg_notifications、状态栏 HUD）的统一
// 出口：tool_call 信封寻址 builtin.shell（旧 RPC 分支随迁退役）。args 说
// manifest 语言（camelCase；_owner_id 等 meta 原样嵌 args 内）。

/** shell 域通用信封调用（text 形态结果直通；JSON 形态消费方自行 parseJson）。 */
export function kernelShellCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('tool_call', { plugin: 'builtin.shell', tool, args });
}

// ── builtin.pty 直呼便捷封装（kernel-plugin-runtime P2-6）──
// PTY 会话（旧 rpc.rs PTY 分区）：pty-output 事件仍在 EventContract；
// UI/内部消费方经本封装信封寻址 builtin.pty。

/** pty 域通用信封调用。 */
export function kernelPtyCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('tool_call', { plugin: 'builtin.pty', tool, args });
}

// ── builtin.lsp 直呼便捷封装（kernel-plugin-runtime P2-6）──
// LSP 会话（ui/lsp-client.ts 消费）：lsp-message 事件仍在 EventContract。
// lsp_request 返回 JSON 字符串——调用方 parseJson 后消费（与旧 typedRpc
// 自动展开 JSON 不同——信封统一 text 形态）。

/** lsp 域通用信封调用（text 形态结果直通；JSON 形态调用方自行 parseJson）。 */
export function kernelLspCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('tool_call', { plugin: 'builtin.lsp', tool, args });
}

/** lsp_request 信封调用 + JSON 解析（旧 rpc lsp_request 是 JsonValue 形态，Rust
 *  出口自动展开成对象——信封统一 text 形态后调用方 parseJson 恢复同语义）。 */
export async function kernelLspRequest<T = unknown>(args: {
  session_id: number;
  method: string;
  params?: Record<string, unknown>;
}): Promise<T> {
  return parseJson<T>(await kernelLspCall('lsp_request', args));
}

/** 运行时契约：`// JSON` 注释命令的 result 形状，与上方 RpcContract 的
 *  `// JSON` 注释同源维护（后端加/改方法 → 同步本表；schema 是 result 注释的
 *  运行时投影）。键集 = 已收编命令集；未登记的 `// JSON` 命令 = 当前无
 *  typedJsonRpc 调用点，未来首个调用者出现时签名强制入表。`// text` 禁入。
 *  形状档：全检 = 字段级 zod；粗检 = z.unknown()（载荷随工具/体量不可控，
 *  内容契约归 define-tool 工具面或消费方）。
 *  字段可选性以 Rust Ok 路径真实形状为准（rpc.rs rpc_result_shape 表 + 命令
 *  实现/结构体定义双源核对，2026-09-01 实测；object 一律 passthrough——
 *  边界管形状对错，不做字段集冻结，Rust 加字段不炸前端）。 */
export const rpcResultSchemas = {
  // hologram_call 粗检（唯一 z.unknown() 条目）：载荷形状随底层工具（36+ 动态）
  // 不恒定，内容契约归 define-tool 工具面体系；边界只保「合法 JSON 已解析」
  // （string 慢路径的 parse 已在 schema 之前完成）。
  hologram_call: z.unknown(),
  hologram_tools_list: z.array(
    z
      .object({
        name: z.string(),
        description: z.string(),
        // readOnly / properties 元素 description：引擎 mcp_value 恒写，但浏览器
        // mock 面缺省（历史形状且被 convergence/tool-contract 基线钉住）——optional
        // 兼容两态；消费方 mcpSchemaToTool 自带回退。
        readOnly: z.boolean().optional(),
        inputSchema: z
          .object({
            type: z.string(),
            properties: z.record(
              z.string(),
              z
                .object({
                  type: z.string(),
                  description: z.string().optional(),
                  enum: z.array(z.string()).optional(),
                })
                .passthrough(),
            ),
            required: z.array(z.string()),
          })
          .passthrough(),
      })
      .passthrough(),
  ),
  load_graph_json: z
    .object({
      source_root: z.string(),
      node_count: z.number(),
      edge_count: z.number(),
      file_count: z.number(),
      class_count: z.number(),
      kind_counts: z.record(z.string(), z.number()),
      edge_kind_counts: z.record(z.string(), z.number()),
      communities: z.array(z.object({ id: z.number(), size: z.number() })),
      top_fan_in: z.array(z.object({ id: z.string(), name: z.string(), fan_in: z.number() })),
      top_fan_out: z.array(z.object({ id: z.string(), name: z.string(), fan_out: z.number() })),
    })
    .passthrough(),
  get_last_project: z.nullable(z.string()),
  workspace_list: z.array(
    z
      .object({
        path: z.string(),
        name: z.nullable(z.string()),
        last_opened_at: z.string(),
        pinned: z.boolean(),
        session_count: z.number(),
        latest_saved_at: z.nullable(z.string()),
        dir_exists: z.boolean(),
        graph_engine: z.nullable(z.boolean()),
      })
      .passthrough(),
  ),
  sandbox_status: z
    .object({
      available: z.boolean(),
      degraded: z.boolean(),
      reason: z.string(),
    })
    .passthrough(),
  // （shell_env 已迁内核插件 builtin.shell——runtime 经 kernelShellCall +
  //   parseJson 消费，rpcResultSchemas 表行随之退役，kernel-plugin-runtime P2-4。
  //   git_status 已迁内核插件 builtin.git——state-inject 经 kernelGitCall +
  //   parseJson 消费，表行退役，kernel-plugin-runtime P2-3。）
} satisfies Partial<Record<RpcMethodName, z.ZodType>>;

/** 已收编命令的 result 类型（schema 推导——调用点不再手写泛型）。 */
export type RpcSchemaResultOf<M extends keyof typeof rpcResultSchemas> = z.infer<(typeof rpcResultSchemas)[M]>;

/** workspace_list 元素（Rust WorkspaceSummary 同形）。 */
export type WorkspaceSummary = RpcSchemaResultOf<'workspace_list'>[number];

/** workspace_list 短期缓存（P1-2，2026-09-02）：SessionsHome 挂载拉一次、
 *  Workspace.open 查图谱旗标又拉一次——冷启动 10s 内两调全量扫各工作区
 *  会话根。TTL 内复用同一次结果；过期/写操作（rename/pin/remove/set_graph_engine）
 *  由调用方显式失效（clearWorkspaceListCache）。只缓存成功结果。 */
const WORKSPACE_LIST_TTL_MS = 10_000;
let _wsListCache: { at: number; data: WorkspaceSummary[] } | null = null;

export function clearWorkspaceListCache(): void {
  _wsListCache = null;
}

/** 带短期缓存的 workspace_list——读方一律走此入口。 */
export async function workspaceListCached(): Promise<WorkspaceSummary[]> {
  if (_wsListCache && Date.now() - _wsListCache.at < WORKSPACE_LIST_TTL_MS) {
    return _wsListCache.data;
  }
  const data = await typedJsonRpc('workspace_list', {});
  _wsListCache = { at: Date.now(), data };
  return data;
}

export type EventName = keyof EventContract;

/** 事件名/payload 受 EventContract 约束的 listen。 */
export async function typedListen<E extends EventName>(
  event: E,
  handler: (payload: EventContract[E]) => void,
): Promise<() => void> {
  return listen<EventContract[E]>(event, (e) => handler(e.payload));
}
