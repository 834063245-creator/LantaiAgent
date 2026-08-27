# 模型可见工具面契约（生成物）

> 由 `scripts/gen-tool-contract-md.cjs`（经 tsx 运行 `src-ui/scripts/gen-tool-contract-md.ts`）
> 从 `buildToolRegistry` 出厂行表装配产物生成 — 勿手改；工具面变更后重新生成并同 commit。
> 本文档不含时间戳：字节稳定是 `--check` 构建守护的前提。

可见工具 15 个（域折叠形态 + 常驻件）；隐藏旧名 144 个（附录）。

装配说明：标准注册表 = composition 行表出厂序；hologram 动态族（graph/ops/lsp 引擎侧
schema）在本生成环境（无 Tauri bridge / 无引擎连接）恒为空集，引擎侧工具面以引擎
`HOLOGRAM_MCP_TOOLS` 清单与 Rust 测试为准。
范围说明：会话级 capability 工具（Skill / enter_exit_plan_mode / 通信族等）经 blueprint
在会话装配期追加，不在本文档（其契约由 convergence phase 快照钉住）；本文档覆盖
buildToolRegistry 装配产物，与 tool-schemas.full.json 同范围。

## 可见面总览

| 工具 | 只读 | 动作数 | 说明（首行） |
|------|------|--------|--------------|
| [`ask_user`](#ask_user) | ✓ | — | Ask the user one or more questions when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Supports: single question (question/header/options/multiSelect), multiple questions in one call (questions array — recommended for 2+, asked one at a time), and open-ended questions (omit options — the user types a free-text answer). Returns the user's answer(s). |
| [`wait`](#wait) | ✓ | — | Block until a target completes, then return immediately — event-driven, NOT a fixed sleep. Pass agentId to wait for that sub-agent to finish: returns its final status the moment it completes (no polling loops, no guessing durations). For background shell jobs use bash_wait (dedicated tool). Omit agentId and pass durationMs ONLY as a fallback for non-event waits (watcher re-analysis, file appearance). Max 10 minutes per call. |
| [`fs`](#fs) | — | 11 | File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete / constraints / write_constraints. Use fs(read) to inspect files, fs(write)/fs(edit) to modify them. fs(constraints) reads hologram.constraints.yaml; fs(write_constraints) replaces it (read first — extend existing rules rather than dropping them). |
| [`shell`](#shell) | — | 4 | Shell execution: run (build/test commands only, bundled bash by default; interpreter:"pwsh" ONLY for Windows-native tasks like registry/ACL/MSI/COM/WMI), plus output / wait / kill for background jobs. Working directory is sticky per agent (a successful cd persists across calls; results end with a [cwd: ...] line). bash_output returns only NEW bytes since your last read — polling watch modes/dev servers is cheap. Do NOT use shell(run) for file search, code search, or git — use fs/search/git instead. |
| [`git`](#git) | — | 13 | Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame. |
| [`search`](#search) | ✓ | 1 | Search source text across files: content matches, file lists, or match counts. |
| [`web`](#web) | ✓ | 1 | Fetch a URL and return readable text (documentation, API responses, raw files). |
| [`agent`](#agent) | — | 7 | Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation. |
| [`task`](#task) | — | 5 | Task board: create / get / list / update / stop / board. |
| [`browser`](#browser) | — | 39 | Browser control: launch a controlled Chrome/Edge (isolated profile; headless/windowSize/profile/proxy supported), connect to a user-started debug-port browser instance, list/switch isolated account sessions (multi-account), list/attach/switch tabs (new_tab/close_tab), navigate/back/forward/reload, snapshot interactive elements (AX tree preferred, iframe/shadow+accessible-name fallback; ref-based ops), extract page content (text/markdown), inspect/report visual state, read console/network events (paired by requestId) + single request detail + HAR export, manage cookies (list/set/delete), screenshot (fullPage/inline), audit log, and operate (click/hover/type/select/upload/dialog/press with modifiers/scroll/viewport/eval). target="self" = 兰台 webview 只读会话（inspect/report/snapshot/content/console/network/network_detail/network_har/screenshot/status 支持）；省略 target = 已 attach 的外部页面。交互范式：先 snapshot 拿 ref 编号，操作按 ref 引用（不要手写 CSS selector）；操作自带等待与反馈；敏感目标每次单独确认。attach 用 targetId（来自 browser(targets) 的 CDP target id）。connect 连接用户已启动的浏览器实例（端口由用户提供，或先 discover 选择），操作其真实数据；kill 只断开不杀该进程。多账号：browser(launch, profile:"work") 创建独立持久登录态，browser(switch_session,"work") 切换，browser(sessions) 查看；不同 profile 的 cookie/登录态完全隔离。用户没给端口时先 discover 列实例让用户选（进程表查询，用户无需知道端口号）。 |
| [`desktop`](#desktop) | — | 18 | Windows desktop control (in-process UIA COM, millisecond-latency): probe process tree + windows with channel routing advice (cdp/uia/vision per window), read a window control tree (interactive-only by default, paginated), find/read controls, and operate them by ref or selector (click/type/select/expand/scroll/keys/activate). Write actions return world-change feedback (title/focus/value/toggle before→after). Permission model: first takeover of a window asks once (then pattern actions flow); sensitive targets and physical input (coordinate clicks/SendKeys/wheel) always ask separately; a global input lease serializes physical injection across agents. desktop(audit) reviews what was done. desktop(screenshot) is high-privacy and asks every time. Self-drawn apps (WeChat/QQ/DingTalk) expose empty trees — use desktop(uia_window_shot) + vision instead. |
| [`graph`](#graph) | — | 27 | 依赖图查询与分析（27 语言 AST + 符号级引用边）。**改代码前先问图**：定位符号、评估影响面、判断架构都走这里，grep 只能看到文本，图能看到结构。symbols 搜符号（「XX 在哪」）; semantic 语义检索（向量索引，按含义找符号——不知道确切名字时用，如「内存在哪释放」）; neighbors 谁依赖谁(1跳)（「这个模块被谁依赖」）; impact 改某文件的影响面（改前必查）; path 两符号间依赖路径; inspect 单符号全景; explore 自然语言探索依赖; community 模块所属社区; clusters 全局社区地图; summary 图统计+解析率+SCIP 新鲜度; cycles 循环依赖; coupling 单模块耦合画像(L1-L4); fragile 脆弱模块排名; blindspots 架构盲点; boundaries 边界违规; conflicts 线程冲突; async 异步/时序边; unused 死代码; flows 数据流列表; flow 单条数据流; affected_flows 受影响数据流; dataflow 变量使用统计(语法级,非污点); preflight 改前预检(改文件前必须); grpc gRPC 服务映射; diff 与基线图对比; dataflow_save 保存数据流追踪结果（供面板查看，写动作）; dataflow_query 查询已保存的数据流。 |
| [`ops`](#ops) | — | 7 | 工程操作与状态：analyze 全量重分析（慢，后台跑）; validate 全约束校验; health 项目健康快照; status 引擎状态（含工具调用计数/向量索引/LSP）; timeline 审计日志; rename 符号重命名; import_scip 导入 SCIP 索引提升符号级引用精度。 |
| [`lsp`](#lsp) | ✓ | 4 | 语言服务器精确解析（按需启动）：resolve_call 解析调用点的真实定义; infer_type 推断符号类型; implementations 找接口实现; references 找全部引用点。graph 查不到或需要类型级答案时用。 |
| [`cordis`](#cordis) | — | 6 | Dynamic-plugin runtime (shapes mirror DSH tool-cordis): define an immutable package (plain-JS factory returning { name?, apply(ctx) }; sandboxed — dangerous globals are undefined, contributions via guarded ctx.register), run it (first activation asks user approval), stop (chain-recycle contributions), undefine (delete all packages), inspect_list / inspect_self (source + diagnostics, rebuildable trail). |

## 工具明细

### `ask_user`

> Ask the user one or more questions when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Supports: single question (question/header/options/multiSelect), multiple questions in one call (questions array — recommended for 2+, asked one at a time), and open-ended questions (omit options — the user types a free-text answer). Returns the user's answer(s).

- 只读：是

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `question` | — | string | The question to ask the user (single-question form). For 2+ questions use the questions array instead. |
| `header` | — | string | Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File" |
| `options` | — | array\<object\> | 2-4 predefined choices the user can pick from. Omit for an open-ended question — the user types a free-text answer. |
| `multiSelect` | — | boolean | Set to true to allow selecting multiple options (default: false) |
| `questions` | — | array\<object\> | Multiple questions in one call (recommended for 2+). Asked one at a time in order; the returned answers array aligns with this array. Each answer is a string (single choice / free text) or an array of strings (multi-select), or null if the user cancelled. |

### `wait`

> Block until a target completes, then return immediately — event-driven, NOT a fixed sleep. Pass agentId to wait for that sub-agent to finish: returns its final status the moment it completes (no polling loops, no guessing durations). For background shell jobs use bash_wait (dedicated tool). Omit agentId and pass durationMs ONLY as a fallback for non-event waits (watcher re-analysis, file appearance). Max 10 minutes per call.

- 只读：是

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `agentId` | — | string | Sub-agent ID to wait for (from agent_spawn result or agent_status). Waits until it completes/fails/stops. |
| `durationMs` | — | number | Fallback sleep when agentId is omitted (1000 = 1s, max 600000). Prefer agentId/bash_wait. |
| `timeoutMs` | — | number | Max wait in ms (default 600000 = 10 min). |

### `fs`

> File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete / constraints / write_constraints. Use fs(read) to inspect files, fs(write)/fs(edit) to modify them. fs(constraints) reads hologram.constraints.yaml; fs(write_constraints) replaces it (read first — extend existing rules rather than dropping them).

- 只读：否
- 域：`fs`
- action 枚举（11）：`read` · `write` · `edit` · `list` · `glob` · `mkdir` · `move` · `rename` · `delete` · `constraints` · `write_constraints`
- 只读 action：`read` · `list` · `glob` · `constraints`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `filePath` | — | string | Absolute path to the file to read (action: read); Absolute path to the file to create or overwrite (action: write); Absolute path to the file to modify (action: edit) |
| `offset` | — | integer | Line number to start reading from (0-indexed, default: 0) |
| `limit` | — | integer | Maximum number of lines to return (default: all lines) |
| `content` | — | string | Full file content to write (action: write); Full YAML content to write (action: write_constraints) |
| `_forceGate` | — | boolean | Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: write); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: edit); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: move); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: rename); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: delete) |
| `oldString` | — | string | The exact text to find and replace (must match the file exactly, including whitespace) |
| `newString` | — | string | The text to replace it with (must be different from oldString) |
| `replaceAll` | — | boolean | Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times. |
| `path` | — | string | Absolute path to the directory to list (action: list); Directory to search in. Defaults to the current workspace root. (action: glob); Absolute path to the directory to create (action: mkdir); Absolute path to the file/directory to rename (action: rename); Absolute path to the file or directory to delete (action: delete) |
| `pattern` | — | string | Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json") |
| `from` | — | string | Source path |
| `to` | — | string | Destination path |
| `new_name` | — | string | New name (not path, just the name) |
| `projectPath` | — | string | Project root directory path (action: constraints); Project root directory path (action: write_constraints) |

### `shell`

> Shell execution: run (build/test commands only, bundled bash by default; interpreter:"pwsh" ONLY for Windows-native tasks like registry/ACL/MSI/COM/WMI), plus output / wait / kill for background jobs. Working directory is sticky per agent (a successful cd persists across calls; results end with a [cwd: ...] line). bash_output returns only NEW bytes since your last read — polling watch modes/dev servers is cheap. Do NOT use shell(run) for file search, code search, or git — use fs/search/git instead.

- 只读：否
- 域：`shell`
- action 枚举（4）：`run` · `output` · `wait` · `kill`
- 只读 action：`output` · `wait`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `run` / `output` / `wait` / `kill` | Which operation to perform. |
| `command` | — | string | The shell command to run (e.g. "npm test", "cargo build", "pytest -x") |
| `cwd` | — | string | Optional working directory for the command. Defaults to the current workspace root. |
| `timeoutMs` | — | integer | Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min) (action: run); Maximum wait time in milliseconds (default: 60000 = 60s, max: 600000 = 10min) (action: wait) |
| `runInBackground` | — | boolean | Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_wait(id) to wait for completion, bash_kill(id) to stop. |
| `interpreter` | — | `bash` / `pwsh` | Optional interpreter. Default/omit = bundled bash (Unix syntax). Set "pwsh" ONLY for Windows-native tasks bash cannot do (registry queries, ACL, MSI, COM, WMI) — PowerShell syntax required. |
| `jobId` | — | integer | The job ID returned by run_shell with runInBackground: true (action: output); The job ID returned by run_shell with runInBackground: true (action: wait); The job ID returned by run_shell with runInBackground: true (action: kill) |

### `git`

> Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame.

- 只读：否
- 域：`git`
- action 枚举（13）：`status` · `diff` · `log` · `stage` · `commit` · `push` · `pull` · `checkout` · `branch` · `stash` · `unstash` · `discard` · `init`
- 只读 action：`status` · `diff` · `log`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `path` | — | string | Absolute path to the git repository root (action: status); Absolute path to the git repository root (action: diff); Absolute path to the git repository root (action: log); Absolute path to the git repository root (action: stage); Absolute path to the git repository root (action: commit); Absolute path to the git repository root (action: push); Absolute path to the git repository root (action: pull); Absolute path to the git repository (action: checkout); Absolute path to the git repository (action: branch); Absolute path to the git repository (action: stash); Absolute path to the git repository (action: unstash); Absolute path to the git repository (action: discard); Absolute path to the directory (action: init) |
| `file` | — | string | Optional: specific file to diff. If omitted, shows all unstaged changes. (action: diff); File path to discard changes for (relative to repo root) (action: discard) |
| `staged` | — | boolean | Set to true to show staged changes instead of unstaged |
| `count` | — | integer | Number of recent commits to show (default: 10) |
| `files` | — | string | File path(s) to stage, separated by commas. Use "." to stage all. |
| `message` | — | string | Commit message (conventional commits format recommended) (action: commit); Optional stash message for identification (action: stash) |
| `_forceGate` | — | boolean | Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: commit); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: checkout); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: discard) |
| `branch` | — | string | Branch name to switch to (action: checkout); New branch name (action: branch) |

### `search`

> Search source text across files: content matches, file lists, or match counts.

- 只读：是
- 域：`search`
- action 枚举（1）：`content`
- 只读 action：`content`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `content` | Which operation to perform. |
| `directory` | — | string | Absolute path to the directory to search in |
| `pattern` | — | string | Text or regex pattern to search for (case-insensitive) |
| `fileTypes` | — | string | Optional comma-separated file extensions to filter (e.g. ".ts,.py,.rs") |
| `maxResults` | — | integer | Maximum number of results to return (default: 50, max: 200) |
| `useRegex` | — | boolean | Set to true to interpret pattern as a regex (e.g. "function\\s+\\w+"). Default: false (literal substring) |
| `contextLines` | — | integer | Number of context lines before and after each match (like grep -C). Default: 0. Max: 10. |
| `outputMode` | — | `content` / `files_with_matches` / `count` | Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content. |
| `showLineNumbers` | — | boolean | Include line numbers in output (default: true) |
| `headLimit` | — | integer | Max results/files to return (default: 250, 0 = unlimited) |
| `offset` | — | integer | Skip first N results for pagination (default: 0) |
| `globFilter` | — | string | Additional glob filter on file paths (e.g. "**/*.rs", "src/**/*.ts") |

### `web`

> Fetch a URL and return readable text (documentation, API responses, raw files).

- 只读：是
- 域：`web`
- action 枚举（1）：`fetch`
- 只读 action：`fetch`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `fetch` | Which operation to perform. |
| `url` | — | string | The URL to fetch (HTTPS or HTTP only) |

### `agent`

> Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation.

- 只读：否
- 域：`agent`
- action 枚举（7）：`spawn` · `status` · `isolate_create` · `isolate_diff` · `isolate_merge` · `isolate_discard` · `isolate_status`
- 只读 action：`status` · `isolate_diff` · `isolate_status`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `spawn` / `status` / `isolate_create` / `isolate_diff` / `isolate_merge` / `isolate_discard` / `isolate_status` | Which operation to perform. |
| `description` | — | string | Short label for the sub-agent task (3-5 words, used in progress display) |
| `prompt` | — | string | Complete, self-contained task directive for the sub-agent. Must include: what to do, which files to modify, and the expected outcome. Do NOT instruct the sub-agent to run builds or tests — it cannot do so (parallel build tools cause file-lock deadlocks). Verification is the parent agent's responsibility after all sub-agents finish. When spawning multiple sub-agents in parallel, give each a distinct, non-overlapping set of files to avoid write conflicts. |
| `subagent_type` | — | `fresh` / `fork` | Omit to fork (inherits your recent context — DEFAULT). Set to "fresh" for a clean-slate sub-agent. |
| `tool_allowlist` | — | array\<string\> | Optional list of tool names the sub-agent is allowed to use. If omitted, all tools are available. Example: ["read_file", "search_content", "inspect_symbol"] for a read-only research agent. |
| `timeout_minutes` | — | number | Optional timeout override (default 30 minutes). The sub-agent is aborted when it exceeds this. |
| `async` | — | boolean | If true, returns immediately with the sub-agent ID. The sub-agent runs in the background; its result arrives via agent_message (type: "result"). If false (default), blocks until the sub-agent finishes. Use agent_merge to merge completed async sub-agents. |
| `output_schema` | — | object | Optional JSON Schema (object-rooted) the sub-agent result must satisfy. Supported keywords: type/properties/required/additionalProperties/items/enum/const/oneOf. Only valid in blocking mode (async=false). The validated JSON object is returned as the tool result. |
| `agent_id` | — | string | Identifier for this isolation workspace (action: isolate_create); Isolation workspace to diff (action: isolate_diff); Isolation workspace to merge (action: isolate_merge); Isolation workspace to discard (action: isolate_discard) |

### `task`

> Task board: create / get / list / update / stop / board.

- 只读：否
- 域：`task`
- action 枚举（5）：`create` · `get` · `list` · `update` · `stop`
- 只读 action：`get` · `list`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `create` / `get` / `list` / `update` / `stop` | Which operation to perform. |
| `title` | — | string | Short task title (3-8 words) (action: create); New title (optional) (action: update) |
| `detail` | — | string | What needs to be done, in one sentence (action: create); Updated detail text (optional) (action: update) |
| `id` | — | integer | Task ID to fetch (action: get); Task ID to update (action: update); Task ID to stop (action: stop) |
| `status` | — | `pending` / `in_progress` / `completed` / `cancelled` | Optional status filter. Omit to list all. (action: list); New status for the task (action: update) |

### `browser`

> Browser control: launch a controlled Chrome/Edge (isolated profile; headless/windowSize/profile/proxy supported), connect to a user-started debug-port browser instance, list/switch isolated account sessions (multi-account), list/attach/switch tabs (new_tab/close_tab), navigate/back/forward/reload, snapshot interactive elements (AX tree preferred, iframe/shadow+accessible-name fallback; ref-based ops), extract page content (text/markdown), inspect/report visual state, read console/network events (paired by requestId) + single request detail + HAR export, manage cookies (list/set/delete), screenshot (fullPage/inline), audit log, and operate (click/hover/type/select/upload/dialog/press with modifiers/scroll/viewport/eval). target="self" = 兰台 webview 只读会话（inspect/report/snapshot/content/console/network/network_detail/network_har/screenshot/status 支持）；省略 target = 已 attach 的外部页面。交互范式：先 snapshot 拿 ref 编号，操作按 ref 引用（不要手写 CSS selector）；操作自带等待与反馈；敏感目标每次单独确认。attach 用 targetId（来自 browser(targets) 的 CDP target id）。connect 连接用户已启动的浏览器实例（端口由用户提供，或先 discover 选择），操作其真实数据；kill 只断开不杀该进程。多账号：browser(launch, profile:"work") 创建独立持久登录态，browser(switch_session,"work") 切换，browser(sessions) 查看；不同 profile 的 cookie/登录态完全隔离。用户没给端口时先 discover 列实例让用户选（进程表查询，用户无需知道端口号）。

- 只读：否
- 域：`browser`
- action 枚举（39）：`launch` · `connect` · `discover` · `kill` · `sessions` · `switch_session` · `cookies` · `targets` · `attach` · `new_tab` · `close_tab` · `navigate` · `back` · `forward` · `reload` · `snapshot` · `content` · `inspect` · `report` · `console` · `network` · `network_detail` · `network_har` · `screenshot` · `audit` · `click` · `hover` · `type` · `select` · `upload` · `dialog` · `press` · `scroll` · `viewport` · `eval` · `status` · `wait` · `fill` · `navigate_snapshot`
- 只读 action：`discover` · `sessions` · `targets` · `snapshot` · `content` · `inspect` · `report` · `console` · `network` · `network_detail` · `network_har` · `screenshot` · `audit` · `status` · `wait`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `url` | — | string | Optional URL to open in the controlled browser (action: launch); set/delete: cookie URL (either url or domain is required) (action: cookies); URL to open in the new tab (default about:blank) (action: new_tab); URL to navigate to (action: navigate); URL to navigate to (action: navigate_snapshot) |
| `port` | — | integer | Debug port (default: auto-probe from 9223; 9222 is reserved for 兰台 webview) (action: launch); Debug port of the running browser instance (e.g. 9223) (action: connect) |
| `headless` | — | boolean | Run Chrome without a visible window (default false) |
| `windowSize` | — | object | Launch window size (--window-size=width,height) |
| `profile` | — | string | Named persistent account profile/session slot (e.g. "work"); omit for temporary default profile |
| `proxy` | — | string | Chrome --proxy-server value (e.g. "socks5://127.0.0.1:1080") |
| `proxyBypass` | — | string | Chrome --proxy-bypass-list value (e.g. "localhost;127.0.0.1") |
| `session` | — | string | Optional account slot name to register this instance under (default: default) (action: connect); Account session slot name to activate (action: switch_session) |
| `op` | — | `list` / `set` / `delete` | Cookie operation |
| `urls` | — | array\<string\> | list: only return cookies for these URLs (default all cookies in this browser context) |
| `name` | — | string | set/delete: cookie name |
| `value` | — | string | set: cookie value (action: cookies); Option value (preferred) or visible option text (action: select) |
| `domain` | — | string | set/delete: cookie domain (either url or domain is required) |
| `path` | — | string | set/delete: cookie path (default /) |
| `httpOnly` | — | boolean | set: HttpOnly flag |
| `secure` | — | boolean | set: Secure flag |
| `sameSite` | — | `Strict` / `Lax` / `None` | set: SameSite restriction |
| `expires` | — | number | set: expiration time in Unix seconds (default session cookie) |
| `targetId` | — | string | CDP target id from browser(targets) — not "self" (action: attach); CDP target id of the tab to close (action: close_tab) |
| `scope` | — | string | Optional CSS selector to limit the snapshot (default: whole page) (action: snapshot); Optional CSS selector to limit extraction (default: whole page) (action: content); Optional CSS selector to limit the scan (default: whole page) (action: report) |
| `maxResults` | — | integer | Max elements per page (default 80) (action: snapshot); Max elements (default 20) (action: inspect); Max elements in the snapshot (default 80) (action: navigate_snapshot) |
| `offset` | — | integer | Skip this many interactive elements (for paging; default 0) (action: snapshot); Skip this many content characters (for paging; default 0) (action: content) |
| `target` | — | string | "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: snapshot); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: content); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: inspect); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: report); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: console); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: network); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: network_detail); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: network_har); "self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面 (action: screenshot) |
| `format` | — | `text` / `markdown` | Output format: text (default) or markdown |
| `maxChars` | — | integer | Max content characters per page (default 8000) |
| `selector` | — | string | CSS selector (or ref number from snapshot) of element(s) to inspect (action: inspect); Ref number from snapshot or CSS selector of element to click (action: click); Ref number from snapshot or CSS selector of element to hover (action: hover); Ref number from snapshot or CSS selector of input/textarea/contenteditable to focus (action: type); Ref number from snapshot or CSS selector of the <select> element (action: select); CSS selector (or ref) of the file input, required if no recent file chooser event (action: upload); Ref number or CSS selector to scroll into view (action: scroll); CSS selector to wait for (appears + visible) (action: wait) |
| `props` | — | array\<string\> | Optional subset: geometry/style/text/contrast |
| `limit` | — | integer | Max entries (default 30) (action: console); Max entries (default 30) (action: network); Max entries to export (default 100; max 200) (action: network_har); Max entries (default 50) (action: audit); Max dialog entries when querying (default 10) (action: dialog) |
| `requestId` | — | string | requestId from browser(network) entries |
| `fullPage` | — | boolean | Capture beyond the viewport (full scrollable page, default false) |
| `inline` | — | boolean | Return a base64 data URL directly when <= 3MB (default false) |
| `text` | — | string | Text to type |
| `replace` | — | boolean | Replace existing value before typing (clears then dispatches input/change events) |
| `files` | — | array\<string\> | Absolute local file paths to set |
| `accept` | — | boolean | Omit to query pending dialogs; true = accept, false = dismiss |
| `promptText` | — | string | Text to enter for a prompt dialog |
| `key` | — | string | Key name (Enter/Tab/Escape/ArrowUp/ArrowDown/... or single char) |
| `modifiers` | — | array\<string\> | Modifier keys held during the press (e.g. ["ctrl"] + key "a" = Ctrl+A) |
| `direction` | — | string | Page scroll direction: down/up/top |
| `width` | — | integer | Viewport width in CSS pixels |
| `height` | — | integer | Viewport height in CSS pixels |
| `deviceScaleFactor` | — | number | Device pixel ratio (default 1) |
| `mobile` | — | boolean | Emulate a mobile viewport (default false) |
| `expr` | — | string | JS expression to evaluate |
| `ms` | — | integer | Fixed sleep in milliseconds (capped at 30000) |
| `fields` | — | array\<object\> | Fields to fill, in order |

### `desktop`

> Windows desktop control (in-process UIA COM, millisecond-latency): probe process tree + windows with channel routing advice (cdp/uia/vision per window), read a window control tree (interactive-only by default, paginated), find/read controls, and operate them by ref or selector (click/type/select/expand/scroll/keys/activate). Write actions return world-change feedback (title/focus/value/toggle before→after). Permission model: first takeover of a window asks once (then pattern actions flow); sensitive targets and physical input (coordinate clicks/SendKeys/wheel) always ask separately; a global input lease serializes physical injection across agents. desktop(audit) reviews what was done. desktop(screenshot) is high-privacy and asks every time. Self-drawn apps (WeChat/QQ/DingTalk) expose empty trees — use desktop(uia_window_shot) + vision instead.

- 只读：否
- 域：`desktop`
- action 枚举（18）：`probe` · `screenshot` · `uia_tree` · `uia_find` · `uia_read` · `uia_wait` · `uia_click` · `uia_right_click` · `uia_type` · `uia_select` · `uia_expand` · `uia_scroll` · `uia_keys` · `uia_activate` · `uia_fill` · `uia_window_shot` · `audit` · `status`
- 只读 action：`probe` · `screenshot` · `uia_tree` · `uia_find` · `uia_read` · `uia_wait` · `uia_window_shot` · `audit` · `status`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `route` | — | boolean | Attach per-window channel routing advice (default true); false = bare snapshot, faster |
| `hwnd` | — | integer | Window handle from desktop_probe (hwnd field) (action: uia_tree); Window handle from desktop_probe (action: uia_find); Window handle (action: uia_read); Window handle (action: uia_wait); Window handle (re-locate if tree changed) (action: uia_click); Window handle (action: uia_right_click); Window handle (action: uia_type); Window handle (action: uia_select); Window handle (action: uia_expand); Window handle (action: uia_scroll); Window handle (action: uia_keys); Window handle from desktop_probe (action: uia_activate); Window handle (action: uia_fill); Window handle from desktop_probe (action: uia_window_shot) |
| `pid` | — | integer | Process id - resolves to its main window (action: uia_tree); Process id (action: uia_find); Process id (action: uia_read); Process id (action: uia_wait); Process id (action: uia_click); Process id (action: uia_right_click); Process id (action: uia_type); Process id (action: uia_select); Process id (action: uia_expand); Process id (action: uia_scroll); Process id (action: uia_keys); Process id (action: uia_activate); Process id (action: uia_fill); Process id (action: uia_window_shot) |
| `title` | — | string | Window title substring (fuzzy, first match) (action: uia_tree); Window title substring (action: uia_find); Window title substring (action: uia_read); Window title substring (action: uia_wait); Window title substring (action: uia_click); Window title substring (action: uia_right_click); Window title substring (action: uia_type); Window title substring (action: uia_select); Window title substring (action: uia_expand); Window title substring (action: uia_scroll); Window title substring (action: uia_keys); Window title substring (action: uia_activate); Window title substring (action: uia_fill); Window title substring (action: uia_window_shot) |
| `depth` | — | integer | Limit tree to N levels (real hierarchy with indentation) |
| `all` | — | boolean | Include non-interactive layout elements (default false = interactive only) (action: uia_tree); Include non-interactive elements (default false) (action: uia_find) |
| `offset` | — | integer | Skip this many listed controls (for paging; default 0) |
| `max_results` | — | integer | Max controls per page (default 80) |
| `name` | — | string | Control name substring (case-insensitive) (action: uia_find); Control name, exact match case-insensitive (action: uia_read); Control name, exact match case-insensitive (action: uia_wait); Control name, exact match case-insensitive (e.g. "Equals", "Seven") (action: uia_click); Control name, exact match case-insensitive (action: uia_right_click); Control name, exact match case-insensitive (action: uia_type); Item name, exact match case-insensitive (action: uia_select); Control name, exact match case-insensitive (action: uia_expand); Control name, exact match case-insensitive (action: uia_scroll) |
| `control_type` | — | string | e.g. Button, Edit, ListItem, MenuItem, CheckBox (action: uia_find); ControlType, e.g. Button, Edit (action: uia_read); ControlType (action: uia_wait); ControlType, e.g. Button, Edit, ListItem, MenuItem, CheckBox (action: uia_click); ControlType, e.g. Button, Edit, ListItem (action: uia_right_click); ControlType, e.g. Edit, ComboBox (action: uia_type); ControlType: ListItem, TreeItem, TabItem... (action: uia_select); ControlType: ComboBox, TreeItem... (action: uia_expand); ControlType, e.g. Pane, List, ScrollBar (action: uia_scroll) |
| `automation_id` | — | string | Exact automation id (action: uia_find); Exact automation id (action: uia_read); Exact automation id (action: uia_wait); Exact automation id (e.g. "equalButton", "num7Button") (action: uia_click); Exact automation id (action: uia_right_click); Exact automation id (action: uia_type); Exact automation id (action: uia_select); Exact automation id (action: uia_expand); Exact automation id (action: uia_scroll) |
| `enabled` | — | boolean | Filter by enabled state |
| `ref` | — | integer | Control ref from desktop_uia_tree/find (action: uia_read); Control ref from desktop_uia_tree/find (action: uia_wait); Control ref from desktop_uia_tree/find (use instead of name/automation_id/control_type) (action: uia_click); Control ref from desktop_uia_tree/find (action: uia_right_click); Control ref (usually an Edit/ComboBox) (action: uia_type); Control ref (the ListItem/TreeItem/TabItem to select) (action: uia_select); Control ref (the ComboBox/TreeItem to toggle) (action: uia_expand); Control ref (scrollable pane/list) (action: uia_scroll) |
| `until` | — | `exists` / `enabled` / `value` | Condition to wait for |
| `value` | — | string | Expected value (required when until=value) |
| `timeout_ms` | — | integer | Max wait in ms (default 10000, max 30000) |
| `text` | — | string | Text to type |
| `direction` | — | `up` / `down` / `left` / `right` | Scroll direction |
| `amount` | — | number | Scroll amount (>=1 large step, <1 small step; wheel ticks); default 1 |
| `key` | — | string | Key name (Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/single char) |
| `modifiers` | — | array\<string\> | Modifier keys held (e.g. ["ctrl"] + key "a" = Ctrl+A) |
| `fields` | — | array\<object\> | Fields to fill, in order |
| `limit` | — | integer | Max entries (default 50) |

### `graph`

> 依赖图查询与分析（27 语言 AST + 符号级引用边）。**改代码前先问图**：定位符号、评估影响面、判断架构都走这里，grep 只能看到文本，图能看到结构。symbols 搜符号（「XX 在哪」）; semantic 语义检索（向量索引，按含义找符号——不知道确切名字时用，如「内存在哪释放」）; neighbors 谁依赖谁(1跳)（「这个模块被谁依赖」）; impact 改某文件的影响面（改前必查）; path 两符号间依赖路径; inspect 单符号全景; explore 自然语言探索依赖; community 模块所属社区; clusters 全局社区地图; summary 图统计+解析率+SCIP 新鲜度; cycles 循环依赖; coupling 单模块耦合画像(L1-L4); fragile 脆弱模块排名; blindspots 架构盲点; boundaries 边界违规; conflicts 线程冲突; async 异步/时序边; unused 死代码; flows 数据流列表; flow 单条数据流; affected_flows 受影响数据流; dataflow 变量使用统计(语法级,非污点); preflight 改前预检(改文件前必须); grpc gRPC 服务映射; diff 与基线图对比; dataflow_save 保存数据流追踪结果（供面板查看，写动作）; dataflow_query 查询已保存的数据流。

- 只读：否
- 域：`graph`
- action 枚举（27）：`symbols` · `semantic` · `neighbors` · `impact` · `path` · `inspect` · `explore` · `community` · `clusters` · `summary` · `cycles` · `coupling` · `fragile` · `blindspots` · `boundaries` · `conflicts` · `async` · `unused` · `flows` · `flow` · `affected_flows` · `dataflow` · `preflight` · `grpc` · `diff` · `dataflow_save` · `dataflow_query`
- 只读 action：`symbols` · `semantic` · `neighbors` · `impact` · `path` · `inspect` · `explore` · `community` · `clusters` · `summary` · `cycles` · `coupling` · `fragile` · `blindspots` · `boundaries` · `conflicts` · `async` · `unused` · `flows` · `flow` · `affected_flows` · `dataflow` · `preflight` · `grpc` · `diff` · `dataflow_query`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `query` | — | string | — |
| `nodeId` | — | string | — |
| `from` | — | string | — |
| `to` | — | string | — |
| `module` | — | string | — |
| `files` | — | array | — |
| `path` | — | array | — |
| `beforePath` | — | string | — |
| `content` | — | string | — |
| `traceId` | — | string | — |
| `list` | — | boolean | — |

### `ops`

> 工程操作与状态：analyze 全量重分析（慢，后台跑）; validate 全约束校验; health 项目健康快照; status 引擎状态（含工具调用计数/向量索引/LSP）; timeline 审计日志; rename 符号重命名; import_scip 导入 SCIP 索引提升符号级引用精度。

- 只读：否
- 域：`ops`
- action 枚举（7）：`analyze` · `validate` · `health` · `status` · `timeline` · `rename` · `import_scip`
- 只读 action：`health` · `status` · `timeline` · `import_scip`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `analyze` / `validate` / `health` / `status` / `timeline` / `rename` / `import_scip` | Which operation to perform. |
| `path` | — | string | — |
| `oldName` | — | string | — |
| `newName` | — | string | — |

### `lsp`

> 语言服务器精确解析（按需启动）：resolve_call 解析调用点的真实定义; infer_type 推断符号类型; implementations 找接口实现; references 找全部引用点。graph 查不到或需要类型级答案时用。

- 只读：是
- 域：`lsp`
- action 枚举（4）：`resolve_call` · `infer_type` · `implementations` · `references`
- 只读 action：`resolve_call` · `infer_type` · `implementations` · `references`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `resolve_call` / `infer_type` / `implementations` / `references` | Which operation to perform. |

### `cordis`

> Dynamic-plugin runtime (shapes mirror DSH tool-cordis): define an immutable package (plain-JS factory returning { name?, apply(ctx) }; sandboxed — dangerous globals are undefined, contributions via guarded ctx.register), run it (first activation asks user approval), stop (chain-recycle contributions), undefine (delete all packages), inspect_list / inspect_self (source + diagnostics, rebuildable trail).

- 只读：否
- 域：`cordis`
- action 枚举（6）：`define` · `run` · `stop` · `undefine` · `inspect_list` · `inspect_self`
- 只读 action：`inspect_list` · `inspect_self`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `define` / `run` / `stop` / `undefine` / `inspect_list` / `inspect_self` | Which operation to perform. |
| `kind` | — | `new` / `existing` | new = 创建插件并追加首个包；existing = 向已拥有的插件追加包 |
| `idPrefix` | — | string | kind=new：3-6 个小写英文字母的语义前缀（宿主补唯一后缀） |
| `pluginId` | — | string | kind=existing：已拥有插件的 id (action: define); cordis_define 返回的插件 id (action: run); 要停用的插件 id (action: stop); 要删除的插件 id (action: undefine); 插件 id（省略 = 列出全部） (action: inspect_self) |
| `name` | — | string | 包的短名（可读） |
| `purpose` | — | string | 一句话的用户可读目的 |
| `code` | — | string | 插件工厂源码（纯 JS 函数体，return { name?, apply(ctx) }） |
| `packageId` | — | string | 要激活的精确包 id (action: run); 精确包 id（返回源码与诊断；必须与 pluginId 同给） (action: inspect_self) |
| `mode` | — | `run` / `update` | run = 首次激活/重启/回滚；update = 从当前包切到另一包 |

## 附录：隐藏旧名（hide + retireRedirect）

以下细粒度旧名已从模型可见面隐藏，运行时调用会被 `retireRedirect` 拦截并给出重定向提示；
内部代码/测试仍可经 `registry.get(name)` 解析。新代码不得重新暴露：

`web_fetch` · `browser_launch` · `browser_connect` · `browser_discover` · `browser_targets` · `browser_kill` · `browser_sessions` · `browser_switch_session` · `browser_cookies` · `browser_attach` · `browser_new_tab` · `browser_close_tab` · `browser_navigate` · `browser_back` · `browser_forward` · `browser_reload` · `browser_snapshot` · `browser_content` · `browser_inspect` · `browser_report` · `browser_console` · `browser_network` · `browser_network_detail` · `browser_network_har` · `browser_click` · `browser_hover` · `browser_type` · `browser_select` · `browser_upload` · `browser_dialog` · `browser_press` · `browser_scroll` · `browser_viewport` · `browser_fill` · `browser_navigate_snapshot` · `browser_wait` · `browser_eval` · `browser_screenshot` · `browser_audit` · `browser_status` · `desktop_probe` · `desktop_screenshot` · `desktop_uia_tree` · `desktop_uia_find` · `desktop_uia_read` · `desktop_uia_wait` · `desktop_uia_click` · `desktop_uia_right_click` · `desktop_uia_type` · `desktop_uia_select` · `desktop_uia_expand` · `desktop_uia_scroll` · `desktop_uia_keys` · `desktop_uia_activate` · `desktop_uia_fill` · `desktop_uia_window_shot` · `desktop_audit` · `desktop_status` · `explore_deps` · `search_symbols` · `semantic_search` · `get_neighbors` · `trace_impact` · `find_dep_path` · `inspect_symbol` · `get_community` · `cluster_report` · `grpc_services` · `fragile_modules` · `detect_cycles` · `thread_conflicts` · `coupling_report` · `arch_blindspots` · `graph_summary` · `async_edges` · `project_timeline` · `analyze_project` · `graph_diff` · `import_scip` · `preflight_check` · `validate_project` · `project_health` · `rename_symbol` · `engine_status` · `check_boundaries` · `find_unused` · `trace_dataflow` · `list_flows` · `get_flow` · `get_affected_flows` · `resolve_call` · `infer_type` · `find_implementations` · `find_references` · `dataflow_save` · `dataflow_query` · `git_status` · `git_diff` · `git_log` · `git_stage` · `git_commit` · `git_push` · `git_pull` · `git_init` · `git_checkout` · `git_create_branch` · `git_discard` · `git_stash_push` · `git_stash_pop` · `search_content` · `read_file_content` · `write_file` · `edit_file` · `list_directory` · `read_constraints` · `write_constraints` · `glob` · `delete_file` · `create_directory` · `move_file` · `rename_file` · `run_shell` · `bash_output` · `bash_kill` · `bash_wait` · `agent_isolation_create` · `agent_isolation_diff` · `agent_isolation_merge` · `agent_isolation_discard` · `agent_isolation_status` · `task_create` · `task_update` · `task_list` · `task_get` · `task_stop` · `agent_spawn` · `agent_status` · `cordis_define` · `cordis_run` · `cordis_stop` · `cordis_undefine` · `cordis_inspect_list` · `cordis_inspect_self` · `read_file`
