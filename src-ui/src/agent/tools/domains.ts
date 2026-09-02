// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 领域工具收敛 — 把 ~70 个细粒度工具折叠成 8 个领域工具（fs/shell/git/search/web/agent/task/memory）。
// 设计：
//   - 每个领域工具 = action 判别联合（zod discriminatedUnion），动作参数直接继承旧工具的 JSON Schema，
//     避免手写参数映射造成"schema key / execute key / Rust 参数名"三处漂移（见 tests/tool-param-contract.test.ts）。
//   - execute 委托给 registry 中仍保留的旧工具（隐藏但可解析），逻辑零复制。
//   - 旧工具通过 ToolRegistry.hide() 从 schemas() 消失，但 get() 仍可解析（防御模型幻觉旧名、保持测试兼容）。
//   - 参数预处理腰（tool-ergonomics design-1 rev2）：fs/git/search 三域的路径语义参数
//     在派发前做同义键归一 / 相对路径解析 / 省缺填充（per-owner 上下文，session-context.ts）；
//     Rust 强制层零改动——腰只补全「模型可见意图」，校验仍由 Rust 漏斗原样执行。

import {
  clearFocusPath,
  clearFocusWindow,
  focusPathOf,
  isAbsolutePath,
  ownerContext,
  resolveAgainstRoot,
  setFocusPath,
  setFocusWindow,
  type WindowLocator,
} from '../session-context';
import type { Tool, ToolRegistry } from '../tool';

interface JsonProp {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonProp>;
  required?: string[];
}

/**
 * 领域工具面向模型的 JSON Schema：扁平 object，而不是 discriminated union 的 oneOf。
 * DeepSeek 等严格校验的 OpenAI 兼容端点要求工具参数根节点为 type: "object"，
 * oneOf 根节点会直接 400（Invalid schema for function 'fs' ... got 'type: null'）。
 * action 为必选枚举；各动作私有参数合并为可选属性，跨动作参数在描述中标注所属动作。
 */
/** path 族可见键归一映射（design-1 rev2 §2.3）：合并期把旧工具的同义路径键
 *  折到单一 `path`（fs 的 filePath/projectPath、search 的 directory）——
 *  模型可见面 16 键收敛，normalizeArgs 反向桥保证旧工具仍收原键。 */
const CANONICAL_PATH_KEY: Record<string, string> = { filePath: 'path', directory: 'path', projectPath: 'path' };

/** path 族共享描述（fs/git/search 三域统一；relative/省缺语义一处承载，取代逐 action 标注）。 */
export const PATH_PARAM_DESC =
  'Target path. Relative paths resolve against the workspace root; ' +
  'where the action allows omitting it, omitted = the workspace root.';

/** path 族语义键集合（模型输入侧 camelCase 形态；rpc 转换在后）。 */
const PATH_FAMILY = new Set(['path', 'filePath', 'directory', 'projectPath']);
/** 可解析相对路径的键（比 PATH_FAMILY 宽：move 的 from/to 也是路径语义）。 */
const PATH_RESOLVE_FAMILY = new Set([...PATH_FAMILY, 'from', 'to']);
/** 参数预处理腰的适用域（design-1 rev2 §2.1——其它域的 from/to 等是非路径语义，绝不着腰）。 */
const PATH_WAIST_DOMAINS = new Set(['fs', 'git', 'search']);
/** 省缺填充 = workspace root 的域（全部 action）。fs 单列（按 action 白名单）。 */
const PATH_DEFAULT_DOMAINS = new Set(['git', 'search']);
const PATH_DEFAULT_FS_ACTIONS = new Set(['list', 'glob', 'constraints', 'write_constraints']);

/** 焦点态规格（design-2 rev2）：set = 成功后设焦；fill = 省缺时从焦点填充。
 *  desktop 粘性窗口为 all-or-nothing 填充（模型给了任一定位字段即不补——
 *  per-field 会把不同窗口的 hwnd/title 混进同一 locator，自查缺陷 B）。 */
interface FocusSpec {
  kind: 'path' | 'window';
  set: ReadonlySet<string>;
  fill: ReadonlySet<string>;
}
const DESKTOP_WINDOW_ACTIONS: ReadonlySet<string> = new Set([
  'uia_tree',
  'uia_find',
  'uia_read',
  'uia_wait',
  'uia_click',
  'uia_right_click',
  'uia_type',
  'uia_select',
  'uia_expand',
  'uia_scroll',
  'uia_keys',
  'uia_activate',
  'uia_fill',
  'uia_window_shot',
]);
const FOCUS_SPECS: Record<string, FocusSpec> = {
  fs: { kind: 'path', set: new Set(['read', 'write', 'edit']), fill: new Set(['read', 'edit']) },
  desktop: { kind: 'window', set: DESKTOP_WINDOW_ACTIONS, fill: DESKTOP_WINDOW_ACTIONS },
};

/** 显式窗口定位参数提取（三字段全空 = 无显式定位）。 */
function explicitWindowLocator(args: Record<string, unknown>): WindowLocator | undefined {
  const hwnd = typeof args.hwnd === 'number' ? args.hwnd : undefined;
  const pid = typeof args.pid === 'number' ? args.pid : undefined;
  const title = typeof args.title === 'string' && args.title !== '' ? args.title : undefined;
  if (hwnd === undefined && pid === undefined && title === undefined) return undefined;
  return { hwnd, pid, title };
}

function domainParametersSchema(
  entries: Array<[string, string]>,
  registry: ToolRegistry,
  pathKeyDesc?: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: entries.map(([a]) => a),
      description: 'Which operation to perform.',
    },
  };
  const sources = new Map<string, Array<{ action: string; prop: JsonProp }>>();

  for (const [action, oldName] of entries) {
    const old = registry.get(oldName);
    if (!old) continue;
    const oldSchema = (old.parameters() ?? {}) as JsonSchema;
    for (const [rawKey, rawProp] of Object.entries(oldSchema.properties ?? {})) {
      if (rawKey === 'action') continue; // 保留域判别字段，避免旧工具参数覆盖
      const key = CANONICAL_PATH_KEY[rawKey] ?? rawKey;
      const prop = rawProp as JsonProp;
      const list = sources.get(key);
      if (list) list.push({ action, prop });
      else sources.set(key, [{ action, prop }]);
    }
  }

  for (const [key, list] of sources) {
    const merged: JsonProp = { ...list[0].prop };
    const described = list.filter((s) => s.prop.description);
    if (key === 'path' && pathKeyDesc) {
      merged.description = pathKeyDesc;
    } else if (described.length === 1) {
      merged.description = described[0].prop.description;
    } else if (described.length > 1) {
      merged.description = described.map((s) => `${s.prop.description} (action: ${s.action})`).join('; ');
    }
    properties[key] = merged;
  }

  return { type: 'object', properties, required: ['action'] };
}

/** 参数预处理腰的上下文（design-1 rev2 §2.3）。 */
export interface NormalizePathCtx {
  /** owner id（executor 注入的 _owner_id/_agent_id）——per-owner 上下文查键。 */
  ownerId?: string;
  /** 该 action 的 path 族参数省缺时填充 workspace root（git 全族/search/fs 白名单）。 */
  defaultPathToRoot?: boolean;
}

/** 老工具唯一的 path 族键（恰一个时返回；from/to 等多键工具返回 undefined）。 */
function oldSinglePathKey(old: Tool): string | undefined {
  const props = ((old.parameters() ?? {}) as JsonSchema).properties ?? {};
  const keys = Object.keys(props).filter((k) => PATH_FAMILY.has(k));
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * 领域扁平 schema 的参数预处理腰：
 * ① path 族同义键归一——老工具恰有一个 path 族键时，模型带来的其它同义键
 *    （path/filePath/directory/projectPath）改写到它；from/to 等多键工具跳过归一。
 * ② 省缺填充——role=resolve+default 的 action 缺 path 时填 workspace root；
 *    无注册上下文时不填（旧工具 zod/req_str loudly 报错，绝不静默兜底）。
 * ③ 相对解析——路径语义键（含 move 的 from/to）的相对值对 workspace root 纯 join
 *    （`..` 原样保留，穿越由 Rust 沙箱拒绝）；绝对路径原样透传。
 * ④ 既有 required 别名桥（newName/new_name 等）——保留兜底。
 * 旧工具 schema 键名零改动；仅 fs/git/search 三域着腰（pathWaist）。
 */
export function normalizeArgs(
  old: Tool,
  rest: Record<string, unknown>,
  pathCtx?: NormalizePathCtx & { pathWaist?: boolean },
): Record<string, unknown> {
  const schema = (old.parameters() ?? {}) as JsonSchema;
  const required = (schema.required ?? []) as string[];
  const out = { ...rest };

  if (pathCtx?.pathWaist) {
    const root = ownerContext(pathCtx.ownerId)?.workspaceRoot;
    const pathKey = oldSinglePathKey(old);

    // ① 同义键归一（单 path 键工具）
    if (pathKey) {
      for (const k of Object.keys(out)) {
        if (k === pathKey || !PATH_FAMILY.has(k) || out[k] === undefined) continue;
        if (out[pathKey] === undefined) {
          out[pathKey] = out[k];
          delete out[k];
        }
      }
    }

    // ② 省缺填充（workspace root）
    if (pathKey && pathCtx.defaultPathToRoot && out[pathKey] === undefined && root) {
      out[pathKey] = root;
    }

    // ③ 相对解析（from/to 等宽族；`..` 不规范化）
    if (root) {
      for (const k of Object.keys(out)) {
        const v = out[k];
        if (PATH_RESOLVE_FAMILY.has(k) && typeof v === 'string' && v !== '' && !isAbsolutePath(v)) {
          out[k] = resolveAgainstRoot(root, v);
        }
      }
    }
  }

  const aliasMap: Record<string, string[]> = {
    filePath: ['path', 'file_path'],
    path: ['filePath'],
    projectPath: ['path', 'project_path'],
    newName: ['new_name'],
    new_name: ['newName'],
  };
  for (const req of required) {
    if (out[req] !== undefined) continue;
    for (const alias of aliasMap[req] ?? []) {
      if (out[alias] !== undefined) {
        out[req] = out[alias];
        break;
      }
    }
  }
  return out;
}

export interface DomainSpec {
  name: string;
  description: string;
  /** action 名 -> 旧工具名 */
  actions: Record<string, string>;
}

/** 领域定义 — 单一事实来源：动作名到旧工具名的映射。 */
export const DOMAIN_SPECS: DomainSpec[] = [
  {
    name: 'fs',
    description:
      'File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete / constraints / write_constraints. ' +
      'Use fs(read) to inspect files, fs(write)/fs(edit) to modify them. ' +
      'fs(constraints) reads hologram.constraints.yaml; fs(write_constraints) replaces it (read first — extend existing rules rather than dropping them). ' +
      'Path params accept workspace-root-relative paths (e.g. "src/agent/tool.ts"); fs(list)/fs(glob)/fs(constraints) may omit the path — omitted = the workspace root. ' +
      'fs(read)/fs(edit) may also omit the path — omitted = the file from your most recent fs(read)/fs(edit) (results end with a [file: ...] line showing where you landed).',
    actions: {
      read: 'read_file_content',
      write: 'write_file',
      edit: 'edit_file',
      list: 'list_directory',
      glob: 'glob',
      mkdir: 'create_directory',
      move: 'move_file',
      rename: 'rename_file',
      delete: 'delete_file',
      constraints: 'read_constraints',
      write_constraints: 'write_constraints',
    },
  },
  {
    name: 'shell',
    description:
      'Shell execution: run (build/test commands only, bundled bash by default; interpreter:"pwsh" ONLY for Windows-native tasks like registry/ACL/MSI/COM/WMI), plus output / wait / kill for background jobs. ' +
      'Working directory is sticky per agent (a successful cd persists across calls; results end with a [cwd: ...] line). ' +
      'bash_output returns only NEW bytes since your last read — polling watch modes/dev servers is cheap. ' +
      'Do NOT use shell(run) for file search, code search, or git — use fs/search/git instead.',
    actions: {
      run: 'run_shell',
      output: 'bash_output',
      wait: 'bash_wait',
      kill: 'bash_kill',
    },
  },
  {
    name: 'git',
    description:
      'Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame. ' +
      'path may be omitted for every action — omitted = the workspace root.',
    actions: {
      status: 'git_status',
      diff: 'git_diff',
      log: 'git_log',
      stage: 'git_stage',
      commit: 'git_commit',
      push: 'git_push',
      pull: 'git_pull',
      checkout: 'git_checkout',
      branch: 'git_create_branch',
      stash: 'git_stash_push',
      unstash: 'git_stash_pop',
      discard: 'git_discard',
      init: 'git_init',
      blame: 'git_blame',
    },
  },
  {
    name: 'search',
    description:
      'Search source text across files: content matches, file lists, or match counts. directory may be omitted — omitted = the workspace root.',
    actions: {
      content: 'search_content',
    },
  },
  {
    name: 'web',
    description: 'Fetch a URL and return readable text (documentation, API responses, raw files).',
    actions: {
      fetch: 'web_fetch',
    },
  },
  {
    name: 'agent',
    description:
      'Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation. ' +
      '委派：agent(spawn) 阻塞到子 Agent 完成，结果即工具返回；同轮发多个可并行。短任务（<1min）用同步 spawn；长任务或互不依赖的并行用 async=true（立即返回 agentId，完成后 result 消息进 inbox——agent(ack) 确认后 agent(merge) 合并）。异步最多 5 并发，池满先 agent(merge) 清理已完成的。 ' +
      '写类任务必须给每个子 Agent 不重叠的文件范围：fork 模式（worktree 隔离，靠 agent(merge) 合并回来）；读/检查类用 fresh 模式（直接改主工作区）。大任务切细、子 Agent 的 prompt 精简、别自己包揽子任务。 ' +
      'agent(merge) 串行合并已完成的 worktree，冲突存为 diff 由你手动应用；合并不可逆，先确认子 Agent 工作无误。 ' +
      'agent(message) 即发（30 分钟过期）；agent(request) 阻塞等回复（30s 默认、最大 120s）。 ' +
      'agent(discover) 发布发现（architecture/bug/pattern/config），agent(lookup) 查他人发现，最新发现每轮自动注入。',
    actions: {
      spawn: 'agent_spawn',
      status: 'agent_status',
      kill: 'agent_kill',
      message: 'agent_message',
      request: 'agent_request',
      reply: 'agent_reply',
      inbox: 'agent_inbox',
      ack: 'agent_ack',
      list: 'agent_list',
      merge: 'agent_merge',
      discover: 'agent_discover',
      lookup: 'agent_lookup',
      isolate_create: 'agent_isolation_create',
      isolate_diff: 'agent_isolation_diff',
      isolate_merge: 'agent_isolation_merge',
      isolate_discard: 'agent_isolation_discard',
      isolate_status: 'agent_isolation_status',
    },
  },
  {
    name: 'task',
    description: 'Task board: create / get / list / update / stop / board.',
    actions: {
      create: 'task_create',
      get: 'task_get',
      list: 'task_list',
      update: 'task_update',
      stop: 'task_stop',
      board: 'agent_board',
    },
  },
  {
    name: 'memory',
    description: 'Persistent project memory: save / read / list / delete.',
    actions: {
      save: 'hologram_memory_save',
      read: 'hologram_memory_read',
      list: 'hologram_memory_list',
      delete: 'hologram_memory_delete',
    },
  },
  {
    name: 'browser',
    description:
      'Browser control: launch a controlled Chrome/Edge (isolated profile; headless/windowSize/profile/proxy supported), connect to a user-started debug-port browser instance, list/switch isolated account sessions (multi-account), list/attach/switch tabs (new_tab/close_tab), navigate/back/forward/reload, ' +
      'snapshot interactive elements (AX tree preferred, iframe/shadow+accessible-name fallback; ref-based ops), extract page content (text/markdown), inspect/report visual state, read console/network events (paired by requestId) + single request detail + HAR export, manage cookies (list/set/delete), screenshot (fullPage/inline), audit log, ' +
      'and operate (click/hover/type/select/upload/dialog/press with modifiers/scroll/viewport/eval). ' +
      'target="self" = 兰台 webview 只读会话（inspect/report/snapshot/content/console/network/network_detail/network_har/screenshot/status 支持）；省略 target = 已 attach 的外部页面。' +
      '交互范式：先 snapshot 拿 ref 编号，操作按 ref 引用（不要手写 CSS selector）；操作自带等待与反馈；敏感目标每次单独确认。' +
      'attach 用 targetId（来自 browser(targets) 的 CDP target id）。' +
      'connect 连接用户已启动的浏览器实例（端口由用户提供，或先 discover 选择），操作其真实数据；kill 只断开不杀该进程。' +
      '多账号：browser(launch, profile:"work") 创建独立持久登录态，browser(switch_session,"work") 切换，browser(sessions) 查看；不同 profile 的 cookie/登录态完全隔离。' +
      '用户没给端口时先 discover 列实例让用户选（进程表查询，用户无需知道端口号）。',
    actions: {
      launch: 'browser_launch',
      connect: 'browser_connect',
      discover: 'browser_discover',
      kill: 'browser_kill',
      sessions: 'browser_sessions',
      switch_session: 'browser_switch_session',
      cookies: 'browser_cookies',
      targets: 'browser_targets',
      attach: 'browser_attach',
      new_tab: 'browser_new_tab',
      close_tab: 'browser_close_tab',
      navigate: 'browser_navigate',
      back: 'browser_back',
      forward: 'browser_forward',
      reload: 'browser_reload',
      snapshot: 'browser_snapshot',
      content: 'browser_content',
      inspect: 'browser_inspect',
      report: 'browser_report',
      console: 'browser_console',
      network: 'browser_network',
      network_detail: 'browser_network_detail',
      network_har: 'browser_network_har',
      screenshot: 'browser_screenshot',
      audit: 'browser_audit',
      click: 'browser_click',
      hover: 'browser_hover',
      type: 'browser_type',
      select: 'browser_select',
      upload: 'browser_upload',
      dialog: 'browser_dialog',
      press: 'browser_press',
      scroll: 'browser_scroll',
      viewport: 'browser_viewport',
      eval: 'browser_eval',
      status: 'browser_status',
      wait: 'browser_wait',
      fill: 'browser_fill',
      navigate_snapshot: 'browser_navigate_snapshot',
    },
  },
  {
    name: 'desktop',
    description:
      'Windows desktop control (in-process UIA COM, millisecond-latency): probe process tree + windows with channel routing advice ' +
      '(cdp/uia/vision per window), read a window control tree (interactive-only by default, paginated), find/read controls, ' +
      'and operate them by ref or selector (click/type/select/expand/scroll/keys/activate). ' +
      'Write actions return world-change feedback (title/focus/value/toggle before→after). ' +
      'Permission model: first takeover of a window asks once (then pattern actions flow); sensitive targets and physical input ' +
      '(coordinate clicks/SendKeys/wheel) always ask separately; a global input lease serializes physical injection across agents. ' +
      'desktop(audit) reviews what was done. desktop(screenshot) is high-privacy and asks every time. ' +
      'Self-drawn apps (WeChat/QQ/DingTalk) expose empty trees — use desktop(uia_window_shot) + vision instead. ' +
      'Locator params (hwnd/pid/title) may be omitted on uia_* actions — omitted = the focused window (set by your last explicit locator or uia_activate).',
    actions: {
      probe: 'desktop_probe',
      screenshot: 'desktop_screenshot',
      uia_tree: 'desktop_uia_tree',
      uia_find: 'desktop_uia_find',
      uia_read: 'desktop_uia_read',
      uia_wait: 'desktop_uia_wait',
      uia_click: 'desktop_uia_click',
      uia_right_click: 'desktop_uia_right_click',
      uia_type: 'desktop_uia_type',
      uia_select: 'desktop_uia_select',
      uia_expand: 'desktop_uia_expand',
      uia_scroll: 'desktop_uia_scroll',
      uia_keys: 'desktop_uia_keys',
      uia_activate: 'desktop_uia_activate',
      uia_fill: 'desktop_uia_fill',
      uia_window_shot: 'desktop_uia_window_shot',
      audit: 'desktop_audit',
      status: 'desktop_status',
    },
  },
  {
    name: 'graph',
    description:
      '依赖图查询与分析（27 语言 AST + 符号级引用边）。**改代码前先问图**：定位符号、评估影响面、判断架构都走这里，grep 只能看到文本，图能看到结构。' +
      '答案带 ⚠️ staleness 横幅 = 图数据落后于当前文件——小改直接读文件确认，大改先 ops(analyze) 刷新；图查不到再退回 search/grep 文本兜底。' +
      'symbols 搜符号（「XX 在哪」）; semantic 语义检索（向量索引，按含义找符号——不知道确切名字时用，如「内存在哪释放」）; neighbors 谁依赖谁(1跳)（「这个模块被谁依赖」）; impact 改某文件的影响面（改前必查）; path 两符号间依赖路径; inspect 单符号全景; explore 自然语言探索依赖; community 模块所属社区; clusters 全局社区地图; summary 图统计+解析率+SCIP 新鲜度; cycles 循环依赖; coupling 单模块耦合画像(L1-L4); fragile 脆弱模块排名; blindspots 架构盲点; boundaries 边界违规; conflicts 线程冲突; async 异步/时序边; unused 死代码; flows 数据流列表; flow 单条数据流; affected_flows 受影响数据流; dataflow 变量使用统计(语法级,非污点); preflight 改前预检(改文件前必须); grpc gRPC 服务映射; diff 与基线图对比; dataflow_save 保存数据流追踪结果（供面板查看，写动作）; dataflow_query 查询已保存的数据流。',
    actions: {
      symbols: 'search_symbols',
      semantic: 'semantic_search',
      neighbors: 'get_neighbors',
      impact: 'trace_impact',
      path: 'find_dep_path',
      inspect: 'inspect_symbol',
      explore: 'explore_deps',
      community: 'get_community',
      clusters: 'cluster_report',
      summary: 'graph_summary',
      cycles: 'detect_cycles',
      coupling: 'coupling_report',
      fragile: 'fragile_modules',
      blindspots: 'arch_blindspots',
      boundaries: 'check_boundaries',
      conflicts: 'thread_conflicts',
      async: 'async_edges',
      unused: 'find_unused',
      flows: 'list_flows',
      flow: 'get_flow',
      affected_flows: 'get_affected_flows',
      dataflow: 'trace_dataflow',
      preflight: 'preflight_check',
      grpc: 'grpc_services',
      diff: 'graph_diff',
      dataflow_save: 'dataflow_save',
      dataflow_query: 'dataflow_query',
    },
  },
  {
    name: 'ops',
    description:
      '工程操作与状态：analyze 全量重分析（慢，后台跑）; validate 全约束校验; health 项目健康快照; status 引擎状态（含工具调用计数/向量索引/LSP）; timeline 审计日志; rename 符号重命名; import_scip 导入 SCIP 索引提升符号级引用精度。',
    actions: {
      analyze: 'analyze_project',
      validate: 'validate_project',
      health: 'project_health',
      status: 'engine_status',
      timeline: 'project_timeline',
      rename: 'rename_symbol',
      import_scip: 'import_scip',
    },
  },
  {
    name: 'lsp',
    description:
      '语言服务器精确解析（按需启动）：resolve_call 解析调用点的真实定义; infer_type 推断符号类型; implementations 找接口实现; references 找全部引用点。graph 查不到或需要类型级答案时用。',
    actions: {
      resolve_call: 'resolve_call',
      infer_type: 'infer_type',
      implementations: 'find_implementations',
      references: 'find_references',
    },
  },
  {
    name: 'cordis',
    description:
      'Dynamic-plugin runtime (shapes mirror DSH tool-cordis): define an immutable package (plain-JS factory returning { name?, apply(ctx) }; sandboxed — dangerous globals are undefined, contributions via guarded ctx.register), run it (first activation asks user approval), stop (chain-recycle contributions), undefine (delete all packages), inspect_list / inspect_self (source + diagnostics, rebuildable trail).',
    actions: {
      define: 'cordis_define',
      run: 'cordis_run',
      stop: 'cordis_stop',
      undefine: 'cordis_undefine',
      inspect_list: 'cordis_inspect_list',
      inspect_self: 'cordis_inspect_self',
    },
  },
];

function buildDomainTool(registry: ToolRegistry, spec: DomainSpec): Tool | null {
  const entries = Object.entries(spec.actions).filter(([, oldName]) => registry.get(oldName) !== undefined);
  if (entries.length === 0) return null;

  const pathWaist = PATH_WAIST_DOMAINS.has(spec.name);
  const parameters = domainParametersSchema(entries, registry, pathWaist ? PATH_PARAM_DESC : undefined);
  // entries 已过滤出注册表存在的旧名；readOnly 经可选链安全求值
  const readOnlyActions = entries.filter(([, oldName]) => registry.get(oldName)?.readOnly() === true).map(([a]) => a);

  return {
    name: () => spec.name,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => readOnlyActions.length === entries.length,
    domain: () => spec.name,
    actions: () => entries.map(([a]) => a),
    readOnlyActions: () => readOnlyActions,
    execute: async (args, onProgress, signal) => {
      const action = (args as { action?: unknown })?.action;
      const oldName = typeof action === 'string' ? spec.actions[action] : undefined;
      const old = oldName ? registry.get(oldName) : undefined;
      if (!old) {
        const available = entries.map(([a]) => a).join(', ');
        return `[${spec.name}] unsupported action "${String(action)}". Available actions: ${available}`;
      }
      const { action: _action, ...rest } = args;
      // 参数预处理腰（design-1 rev2）：per-owner 相对解析 + 省缺填充。
      // owner 身份 = executor 注入的 _owner_id（缺失回退 _agent_id——fork 子 Agent）。
      const a = rest as { _owner_id?: unknown; _agent_id?: unknown };
      const ownerId =
        typeof a._owner_id === 'string' ? a._owner_id : typeof a._agent_id === 'string' ? a._agent_id : undefined;
      const isAction = typeof action === 'string' ? action : '';
      const pathCtx = pathWaist
        ? {
            ownerId,
            pathWaist: true,
            defaultPathToRoot:
              PATH_DEFAULT_DOMAINS.has(spec.name) || (spec.name === 'fs' && PATH_DEFAULT_FS_ACTIONS.has(isAction)),
          }
        : undefined;
      const out = normalizeArgs(old, rest, pathCtx);

      // 焦点态（design-2 rev2）：fill → 派发 → set/回显；fill 后派发失败 → 自愈清焦
      // （错清成本 = 一次重读/重定位；不清成本 = 反复踩死路径）。
      const focus = FOCUS_SPECS[spec.name];
      let filledFromFocus = false;
      if (focus && ownerId && focus.fill.has(isAction)) {
        if (focus.kind === 'path') {
          const pathKey = oldSinglePathKey(old);
          if (pathKey && out[pathKey] === undefined) {
            const fp = focusPathOf(ownerId);
            if (fp !== undefined) {
              out[pathKey] = fp;
              filledFromFocus = true;
            }
          }
        } else if (out.hwnd === undefined && out.pid === undefined && out.title === undefined) {
          const w = ownerContext(ownerId)?.focusWindow;
          if (w) {
            if (w.hwnd !== undefined) out.hwnd = w.hwnd;
            if (w.pid !== undefined) out.pid = w.pid;
            if (w.title !== undefined) out.title = w.title;
            filledFromFocus = w.hwnd !== undefined || w.pid !== undefined || w.title !== undefined;
          }
        }
      }

      try {
        const result = await old.execute(out, onProgress, signal);
        if (focus && ownerId && focus.set.has(isAction)) {
          if (focus.kind === 'path') {
            const pathKey = oldSinglePathKey(old);
            const v = pathKey ? out[pathKey] : undefined;
            if (pathKey && typeof v === 'string' && v !== '') {
              setFocusPath(ownerId, v);
              // 回显（shell `[cwd: ...]` 行先例）：每步落点模型可见
              return `${result}\n[file: ${v}]`;
            }
          } else {
            const loc = explicitWindowLocator(out);
            if (loc) setFocusWindow(ownerId, loc);
          }
        }
        return result;
      } catch (e) {
        if (filledFromFocus && ownerId) {
          if (focus?.kind === 'path') clearFocusPath(ownerId);
          else clearFocusWindow(ownerId);
        }
        throw e;
      }
    },
  };
}

/** 创建领域工具。缺失的旧工具（按配置可选注册）对应的动作被静默跳过。 */
export function createDomainTools(registry: ToolRegistry): Tool[] {
  const tools: Tool[] = [];
  for (const spec of DOMAIN_SPECS) {
    if (registry.get(spec.name)) continue; // 已存在（plan 模式守卫版 / 重复收敛）
    const t = buildDomainTool(registry, spec);
    if (t) tools.push(t);
  }
  return tools;
}

/** 需要从 schemas() 隐藏的旧工具名（含别名）。hide() 对不存在的名字无操作。 */
export function collectHiddenToolNames(): string[] {
  const names = new Set<string>(['read_file', 'symbol_history']);
  for (const spec of DOMAIN_SPECS) {
    for (const oldName of Object.values(spec.actions)) names.add(oldName);
  }
  // browser 领域的细粒度工具全部隐藏 — 领域工具 browser 是唯一可见入口
  for (const n of [
    'browser_launch',
    'browser_connect',
    'browser_discover',
    'browser_kill',
    'browser_sessions',
    'browser_switch_session',
    'browser_cookies',
    'browser_targets',
    'browser_attach',
    'browser_new_tab',
    'browser_close_tab',
    'browser_navigate',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_snapshot',
    'browser_content',
    'browser_inspect',
    'browser_report',
    'browser_console',
    'browser_network',
    'browser_network_detail',
    'browser_network_har',
    'browser_screenshot',
    'browser_audit',
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_select',
    'browser_upload',
    'browser_dialog',
    'browser_press',
    'browser_scroll',
    'browser_viewport',
    'browser_eval',
    'browser_status',
    'browser_wait',
    'desktop_probe',
    'desktop_screenshot',
    'desktop_uia_tree',
    'desktop_uia_find',
    'desktop_uia_click',
    'desktop_uia_right_click',
    'desktop_uia_type',
    'desktop_uia_scroll',
    'desktop_uia_window_shot',
  ]) {
    names.add(n);
  }
  // 运行时后注册的细粒度工具（runtime.ts createAgent 中注入）
  for (const n of [
    'agent_ack',
    'agent_board',
    'agent_discover',
    'agent_inbox',
    'agent_kill',
    'agent_list',
    'agent_lookup',
    'agent_merge',
    'agent_message',
    'agent_reply',
    'agent_request',
  ]) {
    names.add(n);
  }
  return [...names];
}

/** 收敛入口：注册领域工具 + 隐藏旧工具名。
 *  rebuildDomains=true 时先注销已有领域工具再重建（正常模式：补齐运行时后注册的动作）；
 *  rebuildDomains=false 时保留现有领域工具不重建，仅追加隐藏旧名。 */
export function convergeRegistry(registry: ToolRegistry, opts: { rebuildDomains?: boolean } = {}): void {
  const { rebuildDomains = true } = opts;
  if (rebuildDomains) {
    for (const spec of DOMAIN_SPECS) registry.unregister(spec.name);
  }
  for (const t of createDomainTools(registry)) registry.register(t);
  for (const n of collectHiddenToolNames()) registry.hide(n);
}

/** 把领域工具调用解析回旧工具名，供 preflight 门禁 / 图增强 hooks / 子 Agent 关联使用。 */
export function resolveGuardToolName(registry: ToolRegistry, toolName: string, args: Record<string, unknown>): string {
  const t = registry.get(toolName);
  if (!t?.domain) return toolName;
  const action = (args as { action?: unknown })?.action;
  if (typeof action !== 'string') return toolName;
  const spec = DOMAIN_SPECS.find((s) => s.name === toolName);
  return spec?.actions[action] ?? toolName;
}

/** 旧名重定向表：隐藏的旧工具被模型调用时，executor 返回"已淘汰 → 领域动作"而非执行。
 *  仅作用于模型调用路径（streaming-executor）；内部委托 / plan 写入 / 测试直接调旧工具不受影响。 */
const ALIAS_REDIRECTS: Record<string, string> = {
  read_file: 'read_file_content',
  symbol_history: 'inspect_symbol',
};

export function retireRedirect(toolName: string): string | null {
  let name = toolName;
  const visited = new Set<string>();
  while (ALIAS_REDIRECTS[name] && !visited.has(name)) {
    visited.add(name);
    name = ALIAS_REDIRECTS[name];
  }
  for (const spec of DOMAIN_SPECS) {
    for (const [action, oldName] of Object.entries(spec.actions)) {
      if (oldName === name) return `${spec.name}(${action})`;
    }
  }
  return null;
}
