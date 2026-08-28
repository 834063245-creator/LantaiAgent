# 引擎开放面契约（Engine Plugin Contract）

> 生成物（勿手改）。真源：`engine/src/contract.rs`（版本 + 壳专属方法清单）、`engine/src/tools/mod.rs`（模型工具面）。
> 重新生成：`node scripts/gen-engine-plugin-contract.cjs`（根目录薄壳）或 `npm run gen:engine-contract`（src-ui）。
> 契约面文件变更 → 必须升 `ENGINE_CONTRACT_VERSION` + 重新生成本文档 + 同步 `src-ui/tests/engine-contract.test.ts` 的 `EXPECTED_SHELL_METHODS`，同 commit。

## 契约版本

| 项 | 值 |
|---|---|
| 当前版本 | 1 |
| 模型可见默认工具数 | 36 |
| 壳专属方法数 | 11 |
| GraphJSON 权威源 | src-ui/src/scene/graph-types.ts |

## 模型可见默认工具面（tools/list 默认返回）

`explore_deps` · `search_symbols` · `semantic_search` · `get_neighbors` · `trace_impact` · `find_dep_path` · `inspect_symbol` · `get_community` · `async_edges` · `fragile_modules` · `detect_cycles` · `thread_conflicts` · `coupling_report` · `project_timeline` · `arch_blindspots` · `grpc_services` · `preflight_check` · `graph_summary` · `cluster_report` · `graph_diff` · `analyze_project` · `validate_project` · `project_health` · `rename_symbol` · `engine_status` · `check_boundaries` · `find_unused` · `trace_dataflow` · `list_flows` · `get_flow` · `get_affected_flows` · `resolve_call` · `infer_type` · `find_implementations` · `find_references` · `import_scip`

## 壳专属方法（host API，永不进模型 tools/list）

| 方法 | 说明 | 读写 | 接线阶段 |
|---|---|---|---|
| `get_graph_page` | 返回 UI 分页图数据（GraphJSON 页）。壳专属——模型工具面不暴露原始图转储。 | 只读 | phase1 |
| `graph_meta` | 图元信息：node/edge 计数、community 层级、分页尺寸。壳专属。 | 只读 | phase1 |
| `get_full_graph` | 全量 GraphJSON 转储（nodes/edges/communities）。壳专属。 | 只读 | phase1 |
| `analyze_with_progress` | 全量分析并持久化，进度经 MCP notifications/progress 推送。壳专属。 | 写 | phase1 |
| `save` | 持久化 store 到磁盘（.lantai/hologram.db）。壳专属。 | 写 | phase1 |
| `fts_search` | FTS5 全文搜索（内容级，区别于 search_symbols 的符号名模糊）。壳专属。 | 只读 | phase1 |
| `timeline_record` | 记录时间线事件（写动作）。壳专属。 | 写 | phase1 |
| `diff` | 基线 diff：baseline.json 与当前图比对。壳专属。 | 只读 | phase1 |
| `ensure_ready` | 确保引擎就绪（同根幂等 / 异根报错）。壳专属。 | 只读 | phase1 |
| `cache_stale` | 缓存是否过期（源码 mtime 与图缓存比对）。壳专属。 | 只读 | phase1 |
| `watcher_subscribe` | 订阅 watcher 通知（graph-updated 推送，MCP notification）。壳专属。 | 写 | phase1 |

### 壳专属方法参数

| 方法 | 参数 |
|---|---|
| `get_graph_page` | page (integer)，page_size (integer) |
| `graph_meta` | （无参数） |
| `get_full_graph` | （无参数） |
| `analyze_with_progress` | path (string) |
| `save` | （无参数） |
| `fts_search` | query (string)，limit (integer) |
| `timeline_record` | event (string) |
| `diff` | baseline_path (string) |
| `ensure_ready` | path (string) |
| `cache_stale` | path (string) |
| `watcher_subscribe` | （无参数） |

## 消费方式

引擎以 `hologram-engine serve`（stdio MCP）或 TCP 9777 暴露同一契约面。
兰台（Phase 3 起）与 DSH（hologram-dsh）经 stdio MCP 消费；Unity 等外部客户端走 TCP 9777 数据面。
壳专属方法经 `tools/call` 调用（与模型工具同一注册面），但 `tools/list` 永不返回它们。

