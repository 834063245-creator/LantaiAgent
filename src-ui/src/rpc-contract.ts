// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC 契约 — 前后端 IPC 的单一类型事实源（前端侧投影）。
//
// 后端唯一权威源：src-tauri/src/rpc.rs（当前 135 个 RPC 方法，由
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
  git_status: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_diff_unstaged: { params: { path: string; file: string } & AgentCtx; result: string }; // text — git stdout（truncate 截断）
  git_diff_staged: { params: { path: string; file: string } & AgentCtx; result: string }; // text — git stdout（truncate 截断）
  git_stage: { params: { path: string; files: string[] } & AgentCtx; result: string }; // JSON
  git_stage_all: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_commit: { params: { path: string; message: string } & AgentCtx; result: string }; // JSON
  git_push: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_pull: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_log: { params: { path: string; limit?: number } & AgentCtx; result: string }; // JSON
  git_init: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_checkout: { params: { path: string; branch: string } & AgentCtx; result: string }; // JSON
  git_create_branch: { params: { path: string; name: string } & AgentCtx; result: string }; // JSON
  git_stash_push: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_stash_pop: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_discard: { params: { path: string; file: string } & AgentCtx; result: string }; // JSON
  git_blame: { params: { path: string; file: string; _agent_id?: string }; result: string }; // JSON

  // ── 文件系统 ─────────────────────────────────────────────
  list_directory: {
    params: { path: string; filter_ignored?: boolean } & AgentCtx;
    result: string; // JSON
  };
  list_directory_flat: {
    params: { path: string } & AgentCtx;
    result: string; // JSON
  };
  read_file_content: {
    params: { file_path: string; offset?: number; limit?: number; raw?: boolean } & AgentCtx;
    result: string; // text — 文件内容（默认带行号；raw=true 返回原文——P1-3 JSON 读取面）
  };
  read_memory_batch: {
    params: { paths?: string[] };
    result: string; // JSON — {path: content|null} 映射（Value 化：Rust 出口已展开）
  };
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
  read_file_base64: {
    params: { file_path: string } & AgentCtx;
    result: string; // text — base64
  };
  write_file_content: {
    params: { file_path: string; content: string } & AgentCtx;
    result: string; // text
  };
  log_append: {
    params: { path: string; content: string; _agent_id?: string };
    result: string; // "null"
  };
  create_directory: {
    params: { path: string } & AgentCtx;
    result: string; // "null"
  };
  get_global_memory_dir: {
    params: Record<string, never>;
    result: string; // text — 目录路径
  };
  delete_file_or_dir: {
    params: { path: string } & AgentCtx;
    result: string; // "null"
  };
  rename_file_or_dir: {
    params: { file_path: string; new_name: string } & AgentCtx;
    result: string; // "null"
  };
  move_file: {
    params: { from: string; to: string } & AgentCtx;
    result: string; // "null"
  };

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
  glob: {
    params: { pattern: string; path?: string } & AgentCtx;
    result: string; // JSON
  };

  // ── Web ──────────────────────────────────────────────────
  web_search: { params: { query: string; max_results?: number; _agent_id?: string }; result: string }; // JSON
  web_fetch: { params: { url: string; _agent_id?: string }; result: string }; // JSON

  // ── Shell ────────────────────────────────────────────────
  exec_command: {
    params: {
      command: string;
      cwd?: string;
      timeout_ms?: number;
      run_in_background?: boolean;
      is_agent?: boolean;
      /** worktree 隔离 id（executor 注入 _agent_id 时的别名） */
      agent_id?: string;
      /** 通知路由身份（bus agent id）— 后台任务通知 owner 与 kill 所有权，优先于 agent_id */
      _owner_id?: string;
      stream_tool_id?: string;
      interpreter?: 'bash' | 'pwsh';
    };
    result: string; // text 或 JSON（流式 started 响应）
  };
  bash_output: { params: { job_id: number }; result: string }; // text
  bash_kill: { params: { job_id: number; agent_id?: string; _owner_id?: string }; result: string }; // text
  bash_wait: { params: { job_id: number; timeout_ms?: number }; result: string }; // text
  shell_env: { params: Record<string, never>; result: string }; // JSON
  drain_bg_notifications: { params: { agent_id: string }; result: string }; // JSON — 只排干该 agent 自己的后台任务通知

  // ── 编辑器 ───────────────────────────────────────────────
  edit_file: {
    params: { file_path: string; old_string: string; new_string: string; replace_all?: boolean } & AgentCtx;
    result: string; // text — 编辑结果/错误信息
  };

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
  read_constraints: { params: { project_path: string }; result: string }; // JSON
  write_constraints: { params: { project_path: string; content: string }; result: string }; // "null"

  // ── 数据流 ───────────────────────────────────────────────
  dataflow_save: {
    params: { query: string; content?: string; explore_result?: string; dataflow_result?: string };
    result: string; // text
  };
  dataflow_query: { params: { trace_id?: string; list?: boolean }; result: string }; // JSON
  dataflow_delete: { params: { trace_id: string }; result: string }; // text

  // ── PTY ──────────────────────────────────────────────────
  pty_spawn: {
    params: { cwd: string; shell?: string; cols: number; rows: number };
    result: string; // text — session id
  };
  pty_write: { params: { session_id: number; data: string }; result: string }; // "null"
  pty_resize: { params: { session_id: number; cols: number; rows: number }; result: string }; // "null"
  pty_kill: { params: { session_id: number }; result: string }; // "null"

  // ── LSP ──────────────────────────────────────────────────
  lsp_start: { params: { language: string; root_uri: string }; result: string }; // text — session id
  lsp_request: {
    params: { session_id: number; method: string; params?: Record<string, unknown> };
    result: string; // JSON
  };
  lsp_stop: { params: { session_id: number }; result: string }; // "null"

  // ── 浏览器审计 / 后台活动（UI 展示层）────────────────────
  // Agent 工具走 agentInvoke 动态分发；UI 组件只读查询用本条目。
  browser_audit: {
    params: { agent?: string; limit?: number };
    result: string; // JSON — { count, entries: string[] }（entries 为审计 JSON 字符串）
  };
  background_activity: {
    params: Record<string, never>;
    result: string; // JSON — { shells: BgJobSnapshot[], browsers: BrowserActivity[] }
  };

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
  list_directory: z.array(dirEntrySchema),
  list_directory_flat: z.array(dirEntrySchema),
  read_memory_batch: z.record(z.string(), z.nullable(z.string())),
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
  shell_env: z
    .object({
      os: z.string(),
      shell: z.string(),
      shell_path: z.string(),
      shell_version: z.string().optional(),
      bundled: z.boolean().optional(),
      notes: z.string(),
    })
    .passthrough(),
  git_status: z
    .object({
      branch: z.string(),
      ahead: z.number(),
      behind: z.number(),
      files: z.array(
        z
          .object({
            path: z.string(),
            status: z.string(),
            staged: z.boolean(),
            old_path: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
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
