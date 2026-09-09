# 模型可见工具面契约（生成物）

> 由 `scripts/gen-tool-contract-md.cjs`（经 tsx 运行 `src-ui/scripts/gen-tool-contract-md.ts`）
> 从 `buildToolRegistry` 出厂行表装配产物生成 — 勿手改；工具面变更后重新生成并同 commit。
> 本文档不含时间戳：字节稳定是 `--check` 构建守护的前提。

可见工具 16 个（域折叠形态 + 常驻件）；隐藏旧名 104 个（附录）。

装配说明：标准注册表 = composition 行表出厂序；hologram 动态族（graph/ops/lsp 引擎侧
schema）在本生成环境（无 Tauri bridge / 无引擎连接）恒为空集，引擎侧工具面以引擎
`HOLOGRAM_MCP_TOOLS` 清单与 Rust 测试为准。
范围说明：会话级 capability 工具（Skill / enter_exit_plan_mode / 通信族等）经 blueprint
在会话装配期追加，不在本文档（其契约由 convergence phase 快照钉住）；本文档覆盖
buildToolRegistry 装配产物，与 tool-schemas.full.json 同范围。

## 可见面总览

| 工具 | 只读 | 动作数 | 说明（首行） |
|------|------|--------|--------------|
| [`web_search`](#web_search) | ✓ | — | Search the internet for real-time information. Uses a free anonymous search API first; if it fails, automatically falls back to Bing/DuckDuckGo scraping. No API key required. |
| [`ask_user`](#ask_user) | ✓ | — | Ask the user one or more questions when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Supports: single question (question/header/options/multiSelect), multiple questions in one call (questions array — recommended for 2+, asked one at a time), and open-ended questions (omit options — the user types a free-text answer). Returns the user's answer(s). |
| [`wait`](#wait) | ✓ | — | Block until a target completes, then return immediately — event-driven, NOT a fixed sleep. Pass agentId to wait for that sub-agent to finish: returns its final status the moment it completes (no polling loops, no guessing durations). For background shell jobs use bash_wait (dedicated tool). Omit agentId and pass durationMs ONLY as a fallback for non-event waits (watcher re-analysis, file appearance). Max 10 minutes per call. |
| [`show_asset`](#show_asset) | ✓ | — | Create a visual asset block in the conversation (chart/table/metric/graph/html...) rendered as a component. Use for any deliverable that benefits from spatial layout or needs to be referred/updated later (charts, tables, impact graphs, metric dashboards, SVG/HTML cards). The block enters the chat flow and can be pinned to the canvas by the user. Kinds and their payload schemas are listed by list_block_kinds; presentation selects the visual form within the kind white-list (omit for the default). Check list_block_kinds before your first call. |
| [`update_asset`](#update_asset) | ✓ | — | Update an existing asset block in-place by assetId (payload/presentation replace; the block id and pin position keep unchanged — pinned copies update live). Rules: kind is NOT changeable (changing semantics means creating a new asset with show_asset); presentation is changeable (skin swap, within the same kind white-list). Errors name what went wrong and what to do instead. |
| [`list_block_kinds`](#list_block_kinds) | ✓ | — | List all available asset block kinds with their payload JSON Schema, presentation white-lists, and streaming mode. Call before show_asset to learn what you can generate and how the payload must be shaped; the list reflects the live registry (plugin-contributed kinds appear automatically). |
| [`fs`](#fs) | — | 9 | File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete. Use fs(read) to inspect files, fs(write)/fs(edit) to modify them. Path params accept workspace-root-relative paths (e.g. "src/agent/tool.ts"); fs(list)/fs(glob) may omit the path — omitted = the workspace root. fs(read)/fs(edit) may also omit the path — omitted = the file from your most recent fs(read)/fs(edit) (results end with a [file: ...] line showing where you landed). |
| [`shell`](#shell) | — | 4 | Shell execution: run (build/test commands only, bundled bash by default; interpreter:"pwsh" ONLY for Windows-native tasks like registry/ACL/MSI/COM/WMI), plus output / wait / kill for background jobs. Working directory is sticky per agent (a successful cd persists across calls; results end with a [cwd: ...] line). bash_output returns only NEW bytes since your last read — polling watch modes/dev servers is cheap. Do NOT use shell(run) for file search, code search, or git — use fs/search/git instead. |
| [`git`](#git) | — | 13 | Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame. path may be omitted for every action — omitted = the workspace root. Key semantics: file = one file for diff/discard/blame (omit it on diff = all changes); files = comma-separated list (or "." for all) for stage — commit accepts files too and auto-stages them before committing. |
| [`search`](#search) | ✓ | 1 | Search source text across files: content matches, file lists, or match counts. directory may be omitted — omitted = the workspace root. |
| [`web`](#web) | ✓ | 1 | Fetch a URL and return readable text (documentation, API responses, raw files). |
| [`agent`](#agent) | — | 7 | Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation. 委派：agent(spawn) 阻塞到子 Agent 完成，结果即工具返回；同轮发多个可并行。短任务（<1min）用同步 spawn；长任务或互不依赖的并行用 async=true（立即返回 agentId，完成后 result 消息进 inbox——agent(ack) 确认后 agent(merge) 合并）。异步最多 5 并发，池满先 agent(merge) 清理已完成的。 写类任务必须给每个子 Agent 不重叠的文件范围：fork 模式（worktree 隔离，靠 agent(merge) 合并回来）；读/检查类用 fresh 模式（直接改主工作区）。大任务切细、子 Agent 的 prompt 精简、别自己包揽子任务。 agent(merge) 串行合并已完成的 worktree，冲突存为 diff 由你手动应用；合并不可逆，先确认子 Agent 工作无误。 agent(message) 即发（30 分钟过期）；agent(request) 阻塞等回复（30s 默认、最大 120s）。 agent(discover) 发布发现（architecture/bug/pattern/config），agent(lookup) 查他人发现，最新发现每轮自动注入。 |
| [`task`](#task) | — | 5 | Task board: create / get / list / update / stop / board. |
| [`browser`](#browser) | — | 39 | Browser control: launch a controlled Chrome/Edge (isolated profile; headless/windowSize/profile/proxy supported), connect to a user-started debug-port browser instance, list/switch isolated account sessions (multi-account), list/attach/switch tabs (new_tab/close_tab), navigate/back/forward/reload, snapshot interactive elements (AX tree preferred, iframe/shadow+accessible-name fallback; ref-based ops), extract page content (text/markdown), inspect/report visual state, read console/network events (paired by requestId) + single request detail + HAR export, manage cookies (list/set/delete), screenshot (fullPage/inline), audit log, and operate (click/hover/type/select/upload/dialog/press with modifiers/scroll/viewport/eval). target="self" = 兰台 webview 只读会话（inspect/report/snapshot/content/console/network/network_detail/network_har/screenshot/status 支持）；省略 target = 已 attach 的外部页面。交互范式：先 snapshot 拿 ref 编号，操作按 ref 引用（不要手写 CSS selector）；操作自带等待与反馈；敏感目标每次单独确认。attach 用 targetId（来自 browser(targets) 的 CDP target id）。connect 连接用户已启动的浏览器实例（端口由用户提供，或先 discover 选择），操作其真实数据；kill 只断开不杀该进程。多账号：browser(launch, profile:"work") 创建独立持久登录态，browser(switch_session,"work") 切换，browser(sessions) 查看；不同 profile 的 cookie/登录态完全隔离。用户没给端口时先 discover 列实例让用户选（进程表查询，用户无需知道端口号）。 |
| [`desktop`](#desktop) | — | 18 | Windows desktop control (in-process UIA COM, millisecond-latency): probe process tree + windows with channel routing advice (cdp/uia/vision per window), read a window control tree (interactive-only by default, paginated), find/read controls, and operate them by ref or selector (click/type/select/expand/scroll/keys/activate). Write actions return world-change feedback (title/focus/value/toggle before→after). Permission model: first takeover of a window asks once (then pattern actions flow); sensitive targets and physical input (coordinate clicks/SendKeys/wheel) always ask separately; a global input lease serializes physical injection across agents. desktop(audit) reviews what was done. desktop(screenshot) is high-privacy and asks every time. Self-drawn apps (WeChat/QQ/DingTalk) expose empty trees — use desktop(uia_window_shot) + vision instead. Locator params (hwnd/pid/title) may be omitted on uia_* actions — omitted = the focused window (set by your last explicit locator or uia_activate). |
| [`cordis`](#cordis) | — | 6 | Dynamic-plugin runtime (shapes mirror DSH tool-cordis): define an immutable package (plain-JS factory returning { name?, apply(ctx) }; sandboxed — dangerous globals are undefined, contributions via guarded ctx.register), run it (first activation asks user approval), stop (chain-recycle contributions), undefine (delete all packages), inspect_list / inspect_self (source + diagnostics, rebuildable trail). |

## 工具明细

### `web_search`

> Search the internet for real-time information. Uses a free anonymous search API first; if it fails, automatically falls back to Bing/DuckDuckGo scraping. No API key required.

- 只读：是

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `query` | ✓ | string | Search keywords |
| `maxResults` | — | integer | Number of results to return (default 10, max 10) |

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

### `show_asset`

> Create a visual asset block in the conversation (chart/table/metric/graph/html...) rendered as a component. Use for any deliverable that benefits from spatial layout or needs to be referred/updated later (charts, tables, impact graphs, metric dashboards, SVG/HTML cards). The block enters the chat flow and can be pinned to the canvas by the user. Kinds and their payload schemas are listed by list_block_kinds; presentation selects the visual form within the kind white-list (omit for the default). Check list_block_kinds before your first call.

- 只读：是

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `kind` | ✓ | string | 资产语义 kind（list_block_kinds 可查全量与 schema） |
| `presentation` | — | string | 表现形态（kind 白名单内；缺省用默认表现） |
| `title` | — | string | 短标题（snake_case 风格，可作下载/引用名） |
| `payload` | ✓ | unknown | 资产数据（须为 JSON；纯数据，不含回调） |
| `stream` | — | boolean | append 型 kind 可流式构建（终值仍以本调用为准） |

### `update_asset`

> Update an existing asset block in-place by assetId (payload/presentation replace; the block id and pin position keep unchanged — pinned copies update live). Rules: kind is NOT changeable (changing semantics means creating a new asset with show_asset); presentation is changeable (skin swap, within the same kind white-list). Errors name what went wrong and what to do instead.

- 只读：是

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `assetId` | ✓ | string | 资产 id（show_asset 返回） |
| `presentation` | — | string | 新表现形态（kind 白名单内；缺省保持原表现） |
| `payload` | ✓ | unknown | 新资产数据（纯 JSON；整体替换） |

### `list_block_kinds`

> List all available asset block kinds with their payload JSON Schema, presentation white-lists, and streaming mode. Call before show_asset to learn what you can generate and how the payload must be shaped; the list reflects the live registry (plugin-contributed kinds appear automatically).

- 只读：是

### `fs`

> File-system operations: read / write / edit / list / glob / mkdir / move / rename / delete. Use fs(read) to inspect files, fs(write)/fs(edit) to modify them. Path params accept workspace-root-relative paths (e.g. "src/agent/tool.ts"); fs(list)/fs(glob) may omit the path — omitted = the workspace root. fs(read)/fs(edit) may also omit the path — omitted = the file from your most recent fs(read)/fs(edit) (results end with a [file: ...] line showing where you landed).

- 只读：否
- 域：`fs`
- action 枚举（9）：`read` · `write` · `edit` · `list` · `glob` · `mkdir` · `move` · `rename` · `delete`
- 只读 action：`read` · `list` · `glob`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `read` / `write` / `edit` / `list` / `glob` / `mkdir` / `move` / `rename` / `delete` | Which operation to perform. |
| `path` | — | string | Target path. Relative paths resolve against the workspace root; where the action allows omitting it, omitted = the workspace root. |
| `offset` | — | integer | Line number to start reading from (0-indexed, default: 0) |
| `limit` | — | integer | Maximum number of lines to return (default: all lines) |
| `lineNumbers` | — | boolean | Set to true to prefix each line with a cat -n style line number (6-digit + tab). Default: raw file text — use this for exact string matching. |
| `content` | — | string | Full file content to write |
| `_forceGate` | — | boolean | Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: write); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: edit); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: move); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: rename); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: delete) |
| `oldString` | — | string | The exact text to find and replace (must match the file exactly, including whitespace) |
| `newString` | — | string | The text to replace it with (must be different from oldString) |
| `replaceAll` | — | boolean | Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times. |
| `pattern` | — | string | Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json") |
| `from` | — | string | Source path |
| `to` | — | string | Destination path |
| `new_name` | — | string | New name (not path, just the name) |

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

> Git operations: status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame. path may be omitted for every action — omitted = the workspace root. Key semantics: file = one file for diff/discard/blame (omit it on diff = all changes); files = comma-separated list (or "." for all) for stage — commit accepts files too and auto-stages them before committing.

- 只读：否
- 域：`git`
- action 枚举（13）：`status` · `diff` · `log` · `stage` · `commit` · `push` · `pull` · `checkout` · `branch` · `stash` · `unstash` · `discard` · `init`
- 只读 action：`status` · `diff` · `log`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | string（枚举见 action 表/描述） | Which operation to perform. |
| `path` | — | string | Target path. Relative paths resolve against the workspace root; where the action allows omitting it, omitted = the workspace root. |
| `file` | — | string | Optional: specific file to diff. If omitted, shows all unstaged changes. (action: diff); File path to discard changes for (relative to repo root) (action: discard) |
| `staged` | — | boolean | Set to true to show staged changes instead of unstaged |
| `count` | — | integer | Number of recent commits to show (default: 10) |
| `files` | — | string | File path(s) to stage, separated by commas. Use "." to stage all. (action: stage); File path(s) to stage before committing, separated by commas (same syntax as git stage). Omit to commit whatever is already staged. (action: commit) |
| `message` | — | string | Commit message (conventional commits format recommended) (action: commit); Optional stash message for identification (action: stash) |
| `_forceGate` | — | boolean | Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: commit); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: checkout); Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact. (action: discard) |
| `branch` | — | string | Branch name to switch to (action: checkout); New branch name (action: branch) |

### `search`

> Search source text across files: content matches, file lists, or match counts. directory may be omitted — omitted = the workspace root.

- 只读：是
- 域：`search`
- action 枚举（1）：`content`
- 只读 action：`content`

| 参数 | 必选 | 类型 | 说明 |
|------|------|------|------|
| `action` | ✓ | `content` | Which operation to perform. |
| `path` | — | string | Target path. Relative paths resolve against the workspace root; where the action allows omitting it, omitted = the workspace root. |
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

> Sub-agent and inter-agent coordination: spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolation. 委派：agent(spawn) 阻塞到子 Agent 完成，结果即工具返回；同轮发多个可并行。短任务（<1min）用同步 spawn；长任务或互不依赖的并行用 async=true（立即返回 agentId，完成后 result 消息进 inbox——agent(ack) 确认后 agent(merge) 合并）。异步最多 5 并发，池满先 agent(merge) 清理已完成的。 写类任务必须给每个子 Agent 不重叠的文件范围：fork 模式（worktree 隔离，靠 agent(merge) 合并回来）；读/检查类用 fresh 模式（直接改主工作区）。大任务切细、子 Agent 的 prompt 精简、别自己包揽子任务。 agent(merge) 串行合并已完成的 worktree，冲突存为 diff 由你手动应用；合并不可逆，先确认子 Agent 工作无误。 agent(message) 即发（30 分钟过期）；agent(request) 阻塞等回复（30s 默认、最大 120s）。 agent(discover) 发布发现（architecture/bug/pattern/config），agent(lookup) 查他人发现，最新发现每轮自动注入。

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

> Windows desktop control (in-process UIA COM, millisecond-latency): probe process tree + windows with channel routing advice (cdp/uia/vision per window), read a window control tree (interactive-only by default, paginated), find/read controls, and operate them by ref or selector (click/type/select/expand/scroll/keys/activate). Write actions return world-change feedback (title/focus/value/toggle before→after). Permission model: first takeover of a window asks once (then pattern actions flow); sensitive targets and physical input (coordinate clicks/SendKeys/wheel) always ask separately; a global input lease serializes physical injection across agents. desktop(audit) reviews what was done. desktop(screenshot) is high-privacy and asks every time. Self-drawn apps (WeChat/QQ/DingTalk) expose empty trees — use desktop(uia_window_shot) + vision instead. Locator params (hwnd/pid/title) may be omitted on uia_* actions — omitted = the focused window (set by your last explicit locator or uia_activate).

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

`web_fetch` · `browser_launch` · `browser_connect` · `browser_discover` · `browser_targets` · `browser_kill` · `browser_sessions` · `browser_switch_session` · `browser_cookies` · `browser_attach` · `browser_new_tab` · `browser_close_tab` · `browser_navigate` · `browser_back` · `browser_forward` · `browser_reload` · `browser_snapshot` · `browser_content` · `browser_inspect` · `browser_report` · `browser_console` · `browser_network` · `browser_network_detail` · `browser_network_har` · `browser_click` · `browser_hover` · `browser_type` · `browser_select` · `browser_upload` · `browser_dialog` · `browser_press` · `browser_scroll` · `browser_viewport` · `browser_fill` · `browser_navigate_snapshot` · `browser_wait` · `browser_eval` · `browser_screenshot` · `browser_audit` · `browser_status` · `desktop_probe` · `desktop_screenshot` · `desktop_uia_tree` · `desktop_uia_find` · `desktop_uia_read` · `desktop_uia_wait` · `desktop_uia_click` · `desktop_uia_right_click` · `desktop_uia_type` · `desktop_uia_select` · `desktop_uia_expand` · `desktop_uia_scroll` · `desktop_uia_keys` · `desktop_uia_activate` · `desktop_uia_fill` · `desktop_uia_window_shot` · `desktop_audit` · `desktop_status` · `git_status` · `git_diff` · `git_log` · `git_stage` · `git_commit` · `git_push` · `git_pull` · `git_init` · `git_checkout` · `git_create_branch` · `git_discard` · `git_stash_push` · `git_stash_pop` · `search_content` · `read_file_content` · `write_file` · `edit_file` · `list_directory` · `glob` · `delete_file` · `create_directory` · `move_file` · `rename_file` · `run_shell` · `bash_output` · `bash_kill` · `bash_wait` · `agent_isolation_create` · `agent_isolation_diff` · `agent_isolation_merge` · `agent_isolation_discard` · `agent_isolation_status` · `task_create` · `task_update` · `task_list` · `task_get` · `task_stop` · `agent_spawn` · `agent_status` · `cordis_define` · `cordis_run` · `cordis_stop` · `cordis_undefine` · `cordis_inspect_list` · `cordis_inspect_self` · `read_file`
