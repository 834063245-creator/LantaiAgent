# 引擎独立插件化：兰台进程外 + MCP 契约（engine-plugin-extraction）

> 状态：In progress（2026-08-29 立项，用户拍板三点：①做彻底——兰台从内嵌改连进程；
> ②DSH 不共包——hologram-dsh 保持现状，两个宿主各自有各自的胶水；③monorepo 子目录——不开新仓）
> **2026-08-29 复盘修订**：全仓旧时代残留清点后拍板——**图分页整链删除**（为已退役 3D 星图 + 即将消失的
> IPC 128MB 护栏服务的双重死代码），契约壳方法清单随之修订（删 3 加 2），新增「前端分页拆除」阶段。
> **2026-08-29 拓扑拍板：A（每工作区一个引擎进程）**——壳消费形态与 DSH 完全同构（一进程一根 + stdio MCP，引擎零改动）；
> 否决 B（单进程多根：要改引擎 serve 多根模式 + MCP 契约被工作区寻址污染 + 双部署形态）。
> 本文是「把图谱引擎拆成独立插件」的唯一计划。与 v11 分析引擎计划（算法面：预算/降噪/动态边）是两条独立线。
> 背景拍板史：2026-08-23 已定「Rust 侧插件化标准形态 = 外部 MCP server」；本文把它兑现成兰台自身的消费方式。

---

## 0. 一句话

**图谱引擎的唯一运行时实体 = `hologram-engine` 进程**，对外只讲一个契约（MCP 工具面 + GraphJSON 数据面）；
兰台从「把 crate 编进进程」改成「每工作区 spawn 一个引擎进程、经 stdio MCP 消费」；
DSH / Unity / 任意 MCP 客户端消费的是同一个二进制、同一份契约——这就是「独立插件，从始至终 DSH 插件 + MCP 服务」。

## 1. 现状盘点（2026-08-29 实测，非拍脑门）

图谱能力今天摊在四个面，只有一面已经独立：

| 面 | 内容 | 状态 |
|---|---|---|
| Rust 引擎 | `hologram-engine` crate：27 语言 / 36 MCP 工具 / 存储·向量·图三 crate / LSP / SCIP / dataflow / louvain | **已是独立 crate + 独立二进制**（`serve` = stdio MCP，TCP 9777）；但被 src-tauri **内嵌**为主路径 |
| TS 图谱域工具 | `hologram(...)` 27 动作 + `DOMAIN_SPECS` 折叠 + `composition/graph-service.ts` | 经 `hologram_call` RPC → src-tauri → 内嵌引擎；挂在兰台组合层 |
| 图数据消费 | `agent/hooks.ts` `buildGraphSnapshot` / `merge-gate.ts` `runGraphGate` / `agent-builder.ts` 装配拉 fragile·cycles·health·blindspots | 直接吃兰台 agent runtime + RPC |
| DSH 集成 | `dsh-bundle`（`@a834063245/hologram-dsh`） | **已经是进程外正确形态**：cordis 行 + `dsh-mcp-client` stdio spawn 引擎 + viewer 同源构建 |

**关键事实（决定了计划可行性与排法）：**

1. **内嵌是主路径，但外部 MCP 路径没死**：`WorkspaceDataContext` 每工作区持 `Arc<Engine>`（`Engine::new_shared`），
   src-tauri 直调引擎 248 处（21 文件，集中在 `app/mod.rs` 60 / `graph_io.rs` 42 / `graph_service.rs` 25 /
   `main.rs` 21 / `workspace.rs` 16 / `hologram_service.rs` 16）；同时 `mcp_manager.rs`（McpManager：spawn `engine.exe serve`
   走 stdin/stdout JSON-RPC + 崩溃追踪 + 降级回退）+ `commands/external.rs` 的 `start_mcp_server/stop_mcp_server` RPC +
   `lifecycle.rs` 关停任务 + `workspace_service.rs` 切工作区 `stop_mcp()` **全部还在接线**。
   → **「切进程外」= 复活并现代化一套现成机制，不是从零造。**
2. **前端改动面从「零」变为「有界」**：引擎消费路径（`hologram_call` / `graph-updated` 事件）仍走 `typedRpc/typedListen` →
   src-tauri 命令，前端契约主体不动；但 **Phase 1.5 砍分页是一次有界的前端迁移**（workspace.ts 加载器 / hooks.ts 快照消费 /
   cold-start 缓存 / mock-data fixture），有测试兜底。TS 侧 43 插件 / convergence baseline 仍零接触。
3. **跨边界有真实成本的路径**（2026-08-29 复盘后）：

   - **图分页：砍掉，不迁移**。分页只为「已退役 3D 星图」+「Tauri IPC 128MB 护栏」服务（`workspace.ts` 注释自证：
     「V5 拆除后无渲染」「分页只是传输机制」）；Phase 3 进程外后前端根本不该搬原始图。graphData 的三个消费面
     （buildGraphSnapshot 聚合 / buildFileNodeIndex 文件索引 / 就绪开关）全是**查询不是传输**——由两个轻量壳方法取代。
   - **watcher 增量推送**：进程内 watcher 改共享 index → 壳发 `graph-updated`；跨边界要引擎 → 壳的推送通道
   - **持久化/审计**：`store_host` 壳与引擎共享 Arc（L2 注入面）；跨边界后数据归属整个移到引擎进程
4. **引擎二进制已是独立发布物**：GitHub Releases 附件（`hologram-engine-win32-x64.exe`，install.mjs 按 tag 下载）。
5. **全仓旧时代残留清点（2026-08-29）**：除分页栈外，另有 91 个死 `#[tauri::command]` 注解（invoke_handler 只注册
   2 个）、legacy `start_mcp_server/stop_mcp_server` RPC 死面（前端零调用）、`specs/` 6 份零引用孤儿文档、`.venv` /
   `release-bin/` / 两个空目录 / 1 个孤儿 .scm 等物理残留——明细见 §8，按序清理。

## 2. 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│  图谱引擎插件（独立维护单元，本仓 engine/ + hologram-*/ 子树）     │
│                                                              │
│  hologram-engine 进程（每工作区一个）                           │
│   ├─ stdio MCP：36 模型工具 + 10 个壳专属方法（hidden tools）    │
│   ├─ TCP 9777：外部客户端（Unity / DSH viewer）数据面            │
│   └─ 免编译扩展面（Phase 4：manifest：语言/框架/工具）            │
└──────────────────────────────────────────────────────────────┘
      ▲ MCP stdio             ▲ MCP stdio         ▲ MCP / TCP
      │（壳侧进程管理器）       │（cordis 行）        │（外部客户端）
  兰台（每工作区一进程）      DSH（现状不动）        Unity 等
```

不变式（从始至终成立）：**同一个引擎二进制 = DSH 插件核心 + MCP 服务 + 兰台分析后端**。
兰台只是又多了一个消费方；引擎侧没有兰台专属代码。

- 协议：**stdio MCP**（2026-08-23 已定标准形态；McpManager 现成；MCP notification 天然支持 watcher/进度推送；
  N 进程无端口冲突）。TCP 9777 保留给外部客户端，不是壳的主路径。
- 拓扑：**每工作区一个引擎进程**（**2026-08-29 用户拍板：A**）——隔离最干净、复用 McpManager spawn 机制、
  与现状「每工作区一个 Engine 实例」语义对齐；代价是 N×进程内存（EXE 页跨进程共享，典型 1-3 工作区可接受）。
- 数据归属：`.lantai/hologram.db` 等由引擎进程自己 `StoreHost::open`（L2 注入面反转回引擎自持）；
  `audit.jsonl` 留壳侧（壳记录自己的动作，不动）。
- monorepo 布局：**不动物理路径**（engine/ 已是子目录）；边界靠契约 + 守卫测试钉死，不靠挪目录。
  若后续证明物理收编有价值，作为独立里程碑再议。

## 3. 阶段计划（每阶段门禁全绿才进下一段）

### Phase 0 — 契约化（纯文档 + 守卫测试，零行为变化）

> **2026-08-29 已落地（v1）**：`engine/src/contract.rs`（`ENGINE_CONTRACT_VERSION=1` + 载体文件清单 + 11 个壳专属方法清单）；
> `engine_status` 新增 `contract` 字段；`DEFAULT_MCP_TOOLS` 升 pub；守卫测试（引擎 4 用例 + TS 5 用例）；
> 生成文档 + 生成器（`gen:engine-contract` / `check:engine-contract` 字节稳定）。
> **2026-08-29 复盘修订（v2，待施工）**：砍分页 → 从 `SHELL_METHODS` 删 `get_graph_page` / `graph_meta` / `get_full_graph`，
> 新增 `graph_snapshot`（聚合快照）+ `file_nodes`（按文件符号索引）→ 共 **10 个壳方法**；`ENGINE_CONTRACT_VERSION` → 2；
> 重生成文档 + 同步 TS 守卫 `EXPECTED_SHELL_METHODS`。

### Phase 1 — 引擎侧壳专属方法实现（10 个，全部 hidden tools）

最终壳方法清单（host API，永不进模型 `tools/list`）：

| 方法 | 说明 | 替代的旧路径 |
|---|---|---|
| `graph_snapshot` | 聚合快照：节点/边数、社区分布、边类型、top 扇入、类数 | `get_graph_page`+`graph_meta`+`get_full_graph`（砍掉） |
| `file_nodes` | 按文件返回符号索引（id/name/kind/fanIn/fanOut） | 前端 `buildFileNodeIndex` 的全量构建 |
| `analyze_with_progress` | 全量分析，进度经 MCP notification 推送 | `run_analyze_with_progress` |
| `save` | 持久化 store | `engine_save` |
| `fts_search` | FTS5 全文搜索 | `engine_fts_search` |
| `timeline_record` | 记录时间线事件 | `engine_record_timeline` |
| `diff` | 基线 diff（baseline.json → 当前图） | `diff_to_json` |
| `ensure_ready` | 确保引擎就绪（同根幂等/异根报错） | `ensure_engine_ready` |
| `cache_stale` | 图是否过期（源码 mtime 比对） | `cache_is_stale` |
| `watcher_subscribe` | 订阅 watcher 通知（graph-updated 推送） | 进程内 watcher 回调 |

- 逐个接进 `dispatch`（与模型工具同一注册面）；MCP notification 承载进度/watcher 推送
- **DoD**：全部壳方法在 `engine.exe serve` 下可用；引擎 `cargo test` 全绿（新增方法单测）；
  双工作区并发 e2e 在进程形态下可跑

### Phase 1.5 — 前端分页拆除 + graphData → snapshot 迁移（2026-08-29 新增）

砍掉为已退役渲染面服务的分页栈，graphData 从「分页拉全量 nodes/edges」改为「轻量快照」：

- `workspace.ts`：删 `loadGraphPages` / `mergePageIntoGraph` / `rebuildLevel0Communities` / `reloadGraphPaged` / 分页暂存图；
  graphData 装载 = 一次 `graph_snapshot` 查询
- `agent/hooks.ts`：`buildGraphSnapshot` / `buildFileNodeIndex` 改吃 snapshot；`GraphContext.getNodesInFile` 改走 `file_nodes`
  （每文件一次轻查询，比现在「全量建索引」更正确且新鲜）
- `cold-start.ts` + `load_graph_json`：缓存改 snapshot（引擎侧已持久化图，快照按需算，客户端缓存简化）
- `src-tauri/src/utils/graph_io.rs`：删分页函数族（`serialize_cached_graph` / `build_level0_communities_json` /
  `build_hierarchical_communities_json` / `graph_page_index` / `graph_meta_json` / `serialize_graph_page` /
  `cache_is_stale` / `derive_community_label`），`diff_to_json` 视用途；`graph_io` 从 42 处直调大幅缩水
- RPC：`get_graph_page` / `get_graph_meta` 拆除；`analyze_and_load` 去分页形态；`load_graph_json` 重定义
- `mock-data.ts`：分页 fixture 更新
- **DoD**：`graphData` 消费面（hooks/agent-builder/tool-rows 开关/prompt-sections）全绿；128MB IPC 护栏问题消失；
  前端 build + vitest 全绿

### Phase 2 — 壳侧 transport 抽象（加第二条路，不翻默认）

- `dispatch_service` / `graph_service` / `hologram_service` / `graph_io`（缩水后）背后加 `EngineTransport` trait：
  `InProcessTransport`（现状默认）| `McpRemoteTransport`（连引擎进程）
- 复用 + 现代化 `McpManager` 为「每工作区一个进程」的 `EngineProcessManager`（spawn / 就绪握手 /
  崩溃重启 / 关停），改造成不带单例锁的长等待（P1-19 教训已在案）
- **差分对拍**：同一条命令在两个 transport 下逐字节等价（layering-rework 对账守恒的做法照搬）；
  壳 `cargo test` 全绿（含双工作区并发 e2e 双跑）
- **DoD**：`McpRemoteTransport` 在测试环境全程可用；差分测试钉住等价；默认仍是内嵌（行为零变化）

### Phase 3 — 翻默认 + 内嵌退役（做彻底那一刀）

- 默认 transport = `McpRemoteTransport`；`WorkspaceDataContext` 从持 `Arc<Engine>` 改持 `EngineProcessHandle`
  （进程 + MCP client + 事件桥）
- 壳侧 248 处引擎直调收口到 transport（Phase 1.5 缩水后的 `graph_io` + `app/mod.rs` / `graph_service` / `hologram_service` 等）；
  `src-tauri` 从 Cargo.toml 摘掉 `hologram-engine` 依赖（壳不再内嵌）
- 生命周期：工作区开 = spawn 进程（`serve --project-root`），工作区关 = kill；崩溃 = 重启 + 降级提示
- 清理：legacy `start_mcp_server/stop_mcp_server` RPC 面拆除（前端 rpc-contract 同步）；McpManager 被 EngineProcessManager 取代
- **DoD**：内嵌路径从 src-tauri 移除（无编译期残留）；全量门禁绿（壳 bin + 集成 + 双工作区进程级 e2e）；
  真机验收：开卷/切卷/图查询/工具调用/merge gate/图 hooks 全链路如常；崩溃恢复不挂主进程

### Phase 4 — 免编译扩展（第三方插件面）

- 语言/框架/工具三张注册表化 + manifest 驱动（`engine/plugins/*.yml` 声明式：扩展名表 / .scm 路径 /
  框架候选模式 / 工具 schema + handler id），可选 cdylib 逻辑面（grammar_loader 的 libloading 先例）
- 引擎启动读 manifest；`engine_status` 报告已加载扩展；`HOLOGRAM_PLUGIN_DIR` env 指向扩展目录
- **DoD**：写一个示例语言 manifest 端到端生效（不加一行 Rust）；`engine_status` 可见；
  破坏性兼容由契约版本号管控

### Phase 5 — 收口（文档 / 布局 / 历史）

- `docs/plans/README.md` 计划现状入口 + `HISTORY.md` 里程碑行
- 契约生成脚本挂进门禁（`gen-engine-plugin-contract` + doc-sync 模式）
- 若有必要：物理收编（`plugins/hologram-engine/` 子树）作为独立里程碑，本计划不预设

## 4. 门禁（每段 commit 前）

| 层 | 命令 |
|---|---|
| 引擎 | `cd engine && cargo test`（bin 测试 `-- --test-threads=1`） |
| 壳 | `cd src-tauri && cargo test`（集成 `-- --test-threads=1`） |
| 前端 | `cd src-ui && npx vitest run` + `npm run build`（Phase 1.5 起前端有改动，不再是「零改动」） |
| 组合层 | `cd src-ui && npm run verify:convergence` |
| 格式 | `cd src-ui && npx biome ci .`（0/0） |

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 跨边界性能回退（快照/查询延迟） | 分页栈已砍（Phase 1.5），跨边界只传聚合快照与按文件查询；DSH viewer 的 TCP 全量图已证明可行 |
| GraphContextHook 每文件一次 `file_nodes` 查询的延迟 | 单文件小查询，stdio MCP 毫秒级；比现状「全量建索引」更正确且新鲜 |
| watcher 增量推送断链 | Phase 1 先建 notification 通道，差分测试钉住 graph-updated 时序 |
| 多进程内存/资源 | EXE 页共享；典型 1-3 工作区；崩溃隔离反而是收益 |
| LSP 子进程归属 | 本来就在引擎进程内，跨边界无变化 |
| 248 处直调迁移遗漏 | Phase 2 的 transport 抽象 + 差分对拍兜底；Phase 3 摘依赖后编译期强约束（漏一处就编不过）；Phase 1.5 已砍掉 graph_io 大头 |
| N 进程与现有单进程假设（MCP 语义） | 拓扑已拍板 A（每工作区一进程）；Phase 2 按 A 建 EngineProcessManager |
| 前端迁移（Phase 1.5）回归 | graphData 消费面测试（hooks/agent-builder/工具开关）+ vitest 兜底 |

## 6. 待拍板

1. **壳专属方法命名空间**：隐藏工具（形如 `symbol_history`）vs 独立 `_shell/` 前缀——推荐隐藏工具，复用既有注册面
2. **残留清理节奏**（§8）：砍分页（Phase 1.5）先做；91 个死 `#[tauri::command]` 注解 / legacy RPC 死面 / 孤儿小件
   按需穿插，不阻塞主线

## 7. 非目标（本轮明确不做）

- TS 图谱域工具抽成可移植插件包（用户已拍板：不共包，兰台与 DSH 各自胶水）
- dsh-bundle 改造（用户已拍板：先不管）
- 新开 git 仓库（用户已拍板：monorepo 子目录）
- v11 算法面（预算/降噪/动态边）——独立计划，不并入本文
- 引擎物理目录收编——Phase 5 视需要再议

## 8. 相关旧时代残留清点（2026-08-29 全仓排查，供按序清理）

### 8.1 为「已退役 3D 星图 + 旧前端」服务（砍分页 = 最大块）

- 图分页运输栈（见 Phase 1.5）：壳侧 graph_io 8 函数 + 前端 4 loader + 3 RPC + mock fixture
- `chat-core.ts` `ChatFooterHandle` 死槽（V5 后无注册方）
- `shell-store.ts` `graphStats` 死字段（V5 后无写入方）
- `scene/graph-types.ts` `StarGraph` 兼容形状（type-only 壳，服务冻结文件；可留可拆）

### 8.2 装饰性/误导性残留

- **91 个 `#[tauri::command]` 注解**：`invoke_handler` 实际只注册 2 个（`rpc::rpc` + `get_active_project`）
  ——壳真实 IPC 面是 rpc.rs 162 分支，这些注解是死装饰（landmine-map 原记「~30」，实测 91，30+ 文件）
- legacy `start_mcp_server` / `stop_mcp_server` RPC：rpc.rs 有分支 + rpc-contract 声明 + McpManager 活着，
  但**前端零调用**——纯死面（Phase 3 拆）
- TCP 9777 旧协议 20+ 分支（blindspots/timeline/fragile/cycle/coupling_report/graph_summary/community_report/
  community/diff/history/delayed/neighbors/path/search/impact/rename/check/preflight/health）：DSH viewer 只用 3 个
  （get_graph/analyze/reanalyze），其余无已知消费者——待确认外部 Unity 假设

### 8.3 孤儿/物理残留（小而明确）

| 件 | 判定 |
|---|---|
| `specs/` 6 份文档（全仓零引用） | 归档或删 |
| `.venv/` + `scripts/bench_resolution.py` + `bench_scip_bridge.py` | 清（Python 引擎退役残留） |
| `release-bin/`（hologram.cmd/install.cmd/install.sh） | 与现 Tauri 打包核对后清 |
| `engine/engine-bin/` 空目录、`engine/tmplinux-stress/` 空目录 | 删 |
| `engine/queries/js_ts_structure.scm`（38 个查询里唯一孤儿） | 删 |

### 8.4 存疑待核（不急着动）

- `stress.rs`（48KB）+ main.rs stress CLI：开发压测工具在役，但 48KB 编进 lib 值得商榷
- `get_full_graph`：workspace.ts:436/449/1246 还在用（导出/备份？）——看用途再定生死
- `engine/onnxruntime.dll`（13MB）：向量功能 live，别动

### 8.5 已确认健康（不是残留，别误伤）

- three/WebGL 在 src-ui 零残留（renderer = 块渲染器不是 WebGL）；Python 引擎代码零残留（只剩注释）
- louvain/leiden、timeline-store、subagent-sink、graph.ts shim：全 live
- 旧 UI 组件（TimelineHUD/ChatFooter/ChatBeacon/CommandBar/DataflowPanel）：已全部退役，只剩历史注释
