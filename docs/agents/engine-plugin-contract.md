# 引擎开放面契约（Engine Plugin Contract）

> 生成物（勿手改）。真源：`engine/src/contract.rs`（版本 + 壳专属方法清单）、`engine/src/tools/mod.rs`（域表 + 可寻址工具面）。
> 重新生成：`node scripts/gen-engine-plugin-contract.cjs`（根目录薄壳）或 `npm run gen:engine-contract`（src-ui）。
> 契约面文件变更 → 必须升 `ENGINE_CONTRACT_VERSION` + 重新生成本文档 + 同步 `src-ui/tests/engine-contract.test.ts` 的 `EXPECTED_SHELL_METHODS`，同 commit。
> **机械拦截**：`engine/src/contract.rs` 的 `contract_face_fingerprint_matches` 对拍 `CONTRACT_FACE_FINGERPRINT`（`ENGINE_CONTRACT_FILES` 逐文件哈希 + 版本）——改了契约面而不更新指纹 = `cargo test` 红。

## 契约版本

| 项 | 值 |
|---|---|
| 当前版本 | 10 |
| 模型可见工具数（`tools/list` 缺省面） | 7（4 域 + 3 未折叠） |
| 可寻址工具数（`tools/call` 原名直达） | 36 |
| 壳专属方法数 | 11 |
| GraphJSON 权威源 | engine/src/tools/mod.rs `graph_snapshot_value` |

## 模型可见默认工具面（tools/list 默认返回，契约 v6 起恒定）

### 域工具（只读工具折叠为 `域 + action` 调用面）

| 域 | 只读 | 动作 → 原名 |
|---|---|---|
| `graph` | ✓ | `explore`→`explore_deps`，`symbols`→`search_symbols`，`semantic`→`semantic_search`，`neighbors`→`get_neighbors`，`impact`→`trace_impact`，`path`→`find_dep_path`，`inspect`→`inspect_symbol`，`community`→`get_community`，`clusters`→`cluster_report`，`summary`→`graph_summary` |
| `analysis` | ✓ | `cycles`→`detect_cycles`，`coupling`→`coupling_report`，`fragile`→`fragile_modules`，`blindspots`→`arch_blindspots`，`conflicts`→`thread_conflicts`，`boundaries`→`check_boundaries`，`unused`→`find_unused`，`timeline`→`project_timeline`，`grpc`→`grpc_services`，`flows`→`list_flows`，`flow`→`get_flow`，`affected_flows`→`get_affected_flows`，`async`→`async_edges`，`dataflow`→`trace_dataflow`，`preflight`→`preflight_check` |
| `lsp` | ✓ | `resolve`→`resolve_call`，`infer_type`→`infer_type`，`implementations`→`find_implementations`，`references`→`find_references` |
| `ops` | ✓ | `validate`→`validate_project`，`health`→`project_health`，`status`→`engine_status`，`diff`→`graph_diff` |

调用形态：`tools/call {"name":"graph","arguments":{"action":"impact","nodeId":"…"}}`。
每个域另带保留动作 `action:"help"` —— 回该域全部动作的完整说明书
（完整 description / 参数表 / required，取自 `ToolSchema` 单一真源）。
折叠**无损**：原文只是从常驻上下文挪到按需一问。

### 动作路由提示（模型实际看到的迷你说明书）

**`graph`**

- `explore`（`explore_deps`）：NL dependency exploration in one call (flow + blast radius + relationships + source + alerts) — START HERE when unsure which action fits; it auto-disambiguates
- `symbols`（`search_symbols`）：fuzzy name → matching nodes with IDs/types/locations — your FIRST step when you know the name but not the node ID; then graph(neighbors) or graph(inspect)
- `semantic`（`semantic_search`）：meaning-based search over the embedding index — use when you don't know the exact name; the index is built during analyze, so if it returns nothing check ops(status) (vector_index)
- `neighbors`（`get_neighbors`）：1-hop who-depends-on-whom of a node — call after graph(symbols) to see immediate coupling (这个模块被谁依赖？)
- `impact`（`trace_impact`）：downstream blast radius layered by distance — run BEFORE editing any high-fan-in symbol (改这个会炸多少地方？)
- `path`（`find_dep_path`）：every dependency route from A to B with hop count and edge types — when you need to know HOW two modules are connected (A 是怎么依赖到 B 的？)
- `inspect`（`inspect_symbol`）：one symbol's full picture: identity/degree/community + ALL in/out edges grouped by kind — supersedes symbol_history; use after graph(symbols)
- `community`（`get_community`）：which Leiden cluster a node belongs to (+ parent community, sibling nodes) — for the global map use graph(clusters)
- `clusters`（`cluster_report`）：global community map sorted by size with member lists — high-level architecture read; for a single node use graph(community)
- `summary`（`graph_summary`）：graph stats: nodes/edges, language breakdown, density, top modules, resolution rate — start a session here, then drill in with the other actions

**`analysis`**

- `cycles`（`detect_cycles`）：circular dependencies, mode all/data/llm — pure_code cycles are natural, ignore them; run before large refactors to see what can't be untangled (有没有循环依赖？)
- `coupling`（`coupling_report`）：one module's L1(imports)→L4(temporal) coupling breakdown + fan-in/out + cycle participation — needs module (auth 模块耦合有多深？)
- `fragile`（`fragile_modules`）：top-N most coupled modules by structural fan-in/out × coupling depth — well-designed hubs rank high too; for dataflow/temporal coupling use analysis(dataflow\|async)
- `blindspots`（`arch_blindspots`）：architecture linter: L4 encapsulation violations, unlocked concurrency, LLM feedback loops — filter all/L4/thread/cycle (项目有什么隐藏的架构问题？); lighter than ops(validate)
- `conflicts`（`thread_conflicts`）：thread × shared-resource conflict matrix (shared vars with multiple writers) — omit nodeId for the global map (哪些地方有并发问题？)
- `boundaries`（`check_boundaries`）：boundary rule enforcer: source/target patterns (glob\|regex) + edge kinds → violations — run before AND after a refactor to prove no new violations
- `unused`（`find_unused`）：dead-code candidates (zero non-defines in-edges) — ALWAYS review before deleting: non_defines_in_degree>0 means real callers, and entry points/tests are intentional
- `timeline`（`project_timeline`）：chronological project audit log (analysis runs, commits, violations, constraint checks) — since/limit to window it (最近项目发生了什么变化？)
- `grpc`（`grpc_services`）：gRPC map from .proto files: per-method implementation status (implemented/missing) + client call-site count — for one method's callers use graph(inspect\|impact)
- `flows`（`list_flows`）：execution flows sorted by criticality (entry point → full call chain) — then analysis(flow) to drill into one (核心业务流程是什么？)
- `flow`（`get_flow`）：one flow's full call path (function name, file, line, entry → deepest callee) — pass the id or name from analysis(flows)
- `affected_flows`（`get_affected_flows`）：execution flows passing through changed files — maps a change to the business paths it impacts; run before merging (改了 auth.js 会影响哪些流程？)
- `async`（`async_edges`）：all async/temporal edges: triggers, awaits/callbacks, scheduled tasks, sequenced calls — for async coupling, race conditions, temporal chains (有哪些异步依赖？)
- `dataflow`（`trace_dataflow`）：syntax-level identifier read/write census per function scope — HEURISTIC, not semantic dataflow (no interprocedural, aliasing or taint); pass the file paths; for precise per-call answers use lsp(resolve)
- `preflight`（`preflight_check`）：change rehearsal: blast radius + risk level (low→critical) + shared-variable impacts + temporal signals — ALWAYS call before editing high-fan-in files (这个改动安全吗？)

**`lsp`**

- `resolve`（`resolve_call`）：resolve a call to its concrete definition(s) via native LSP (polymorphic dispatch, struct methods, inheritance) — when the graph shows do_thing() and you need to know WHICH do_thing
- `infer_type`（`infer_type`）：type of an expression/field/variable/return via LSP hover — falls back to call-target inference when no LSP is available (这个变量是什么类型？)
- `implementations`（`find_implementations`）：all implementations of an interface/trait/abstract class (full implementation tree) — click the definition, then call this (谁实现了这个 trait？)
- `references`（`find_references`）：every reference to a symbol across the codebase — includeDeclaration=true adds the definition; high count → run graph(impact) before changing it

**`ops`**

- `validate`（`validate_project`）：full constraint validation: re-analyze + baseline diff + every structural check → violations AND passing rules (全面检查/有没有违规？); for a lighter first pass use analysis(blindspots)
- `health`（`project_health`）：health snapshot: coupling density 0-100, recent trends, top-changed files, most-interconnected modules — the score is coupling density, not code quality (项目最近怎么样？)
- `status`（`engine_status`）：engine status: loading phase, node/edge counts, storage, uptime, contract version, per-tool call counts — call this when tools return empty or before trusting the graph (引擎就绪了吗？)
- `diff`（`graph_diff`）：diff the current graph against a baseline JSON snapshot (added/removed/modified nodes, edge-count deltas) — NOT a git diff; for file-level changes use the git tool

### 未折叠工具（写操作留在顶层）

`analyze_project` · `rename_symbol` · `import_scip`

## 可寻址工具面（折叠不改可达性）

下列原名全部保留 schema，`tools/call` 可按原名直达（壳与外部 MCP 客户端零破坏）：

`explore_deps` · `search_symbols` · `semantic_search` · `get_neighbors` · `trace_impact` · `find_dep_path` · `inspect_symbol` · `get_community` · `async_edges` · `fragile_modules` · `detect_cycles` · `thread_conflicts` · `coupling_report` · `project_timeline` · `arch_blindspots` · `grpc_services` · `preflight_check` · `graph_summary` · `cluster_report` · `graph_diff` · `analyze_project` · `validate_project` · `project_health` · `rename_symbol` · `engine_status` · `check_boundaries` · `find_unused` · `trace_dataflow` · `list_flows` · `get_flow` · `get_affected_flows` · `resolve_call` · `infer_type` · `find_implementations` · `find_references` · `import_scip`

> 可见面**无档位开关**：`HOLOGRAM_MCP_TOOLS` 已随契约 v6 退役（它当初用于裁剪 36 个
> 扁平工具的可见面，折叠后用途消失，且没有任何宿主通道能设它）。设了不再生效，
> 引擎只在日志留一条 warn。

## 壳专属方法（host API，永不进模型 tools/list）

| 方法 | 说明 | 读写 | 接线阶段 |
|---|---|---|---|
| `graph_snapshot` | 聚合快照：节点/边数、社区分布、边类型、top 扇入、类数。壳专属——进程外形态下前端不搬原始图，graphData = 一次轻量查询。 | 只读 | phase1 |
| `file_nodes` | 按文件返回符号索引（id/name/kind/fanIn/fanOut）。壳专属——取代前端全量建索引。 | 只读 | phase1 |
| `analyze_with_progress` | 全量分析并持久化，进度经 MCP notifications/progress 推送。force=true 跳过缓存新鲜度门；默认缓存新鲜（非空且未过期）时直接返回 cached 不重分析。壳专属。 | 写 | phase1 |
| `save` | 持久化 store 到磁盘（.hologram/hologram.db）。壳专属。 | 写 | phase1 |
| `fts_search` | FTS5 全文搜索（内容级，区别于 search_symbols 的符号名模糊）。壳专属。 | 只读 | phase1 |
| `timeline_record` | 记录时间线事件（写动作）。壳专属。 | 写 | phase1 |
| `diff` | 基线 diff：baseline.json 与当前图比对。壳专属。 | 只读 | phase1 |
| `ensure_ready` | 确保引擎就绪（同根幂等 / 异根报错）。壳专属。 | 只读 | phase1 |
| `cache_stale` | 缓存是否过期（源码 mtime 与图缓存比对）。壳专属。 | 只读 | phase1 |
| `watcher_subscribe` | 订阅 watcher 通知（graph-updated 推送，MCP notification）。壳专属。 | 写 | phase1 |
| `run_check` | 简报检查：基线 load/diff/save + 违规信号 + 时间线记录（quiet/baseline_seed 门）一次完成。编排真源在引擎侧。壳专属。 | 写 | phase3 |

### 壳专属方法参数

| 方法 | 参数 |
|---|---|
| `graph_snapshot` | （无参数） |
| `file_nodes` | file (string) |
| `analyze_with_progress` | path (string)，force (boolean) |
| `save` | （无参数） |
| `fts_search` | query (string)，limit (integer) |
| `timeline_record` | event (string)，detail (string)，node_id (string) |
| `diff` | baseline_path (string) |
| `ensure_ready` | path (string) |
| `cache_stale` | path (string) |
| `watcher_subscribe` | （无参数） |
| `run_check` | path (string)，changed_files (array) |

## 消费方式

引擎以 `hologram-engine serve`（stdio MCP）或 TCP 9777 暴露同一契约面。
兰台（Phase 3 起）与 DSH（hologram-dsh）经 stdio MCP 消费；Unity 等外部客户端走 TCP 9777 数据面。
壳专属方法经 `tools/call` 调用（与模型工具同一注册面），但 `tools/list` 永不返回它们。

