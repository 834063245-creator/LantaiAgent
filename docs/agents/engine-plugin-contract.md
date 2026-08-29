# 引擎开放面契约（Engine Plugin Contract）

> 生成物（勿手改）。真源：`engine/src/contract.rs`（版本 + 壳专属方法清单）、`engine/src/tools/mod.rs`（模型工具面）。
> 重新生成：`node scripts/gen-engine-plugin-contract.cjs`（根目录薄壳）或 `npm run gen:engine-contract`（src-ui）。
> 契约面文件变更 → 必须升 `ENGINE_CONTRACT_VERSION` + 重新生成本文档 + 同步 `src-ui/tests/engine-contract.test.ts` 的 `EXPECTED_SHELL_METHODS`，同 commit。

## 契约版本

| 项 | 值 |
|---|---|
| 当前版本 | 4 |
| 模型可见默认工具数 | 36 |
| 壳专属方法数 | 11 |
| GraphJSON 权威源 | src-ui/src/scene/graph-types.ts |

## 模型可见默认工具面（tools/list 默认返回）

`explore_deps` · `search_symbols` · `semantic_search` · `get_neighbors` · `trace_impact` · `find_dep_path` · `inspect_symbol` · `get_community` · `async_edges` · `fragile_modules` · `detect_cycles` · `thread_conflicts` · `coupling_report` · `project_timeline` · `arch_blindspots` · `grpc_services` · `preflight_check` · `graph_summary` · `cluster_report` · `graph_diff` · `analyze_project` · `validate_project` · `project_health` · `rename_symbol` · `engine_status` · `check_boundaries` · `find_unused` · `trace_dataflow` · `list_flows` · `get_flow` · `get_affected_flows` · `resolve_call` · `infer_type` · `find_implementations` · `find_references` · `import_scip`

## 壳专属方法（host API，永不进模型 tools/list）

| 方法 | 说明 | 读写 | 接线阶段 |
|---|---|---|---|
| `graph_snapshot` | 聚合快照：节点/边数、社区分布、边类型、top 扇入、类数。壳专属——进程外形态下前端不搬原始图，graphData = 一次轻量查询。 | 只读 | phase1 |
| `file_nodes` | 按文件返回符号索引（id/name/kind/fanIn/fanOut）。壳专属——取代前端全量建索引。 | 只读 | phase1 |
| `analyze_with_progress` | 全量分析并持久化，进度经 MCP notifications/progress 推送。force=true 跳过缓存新鲜度门；默认缓存新鲜（非空且未过期）时直接返回 cached 不重分析。壳专属。 | 写 | phase1 |
| `save` | 持久化 store 到磁盘（.lantai/hologram.db）。壳专属。 | 写 | phase1 |
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

