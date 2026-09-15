# 引擎独立插件化：兰台进程外 + MCP 契约（engine-plugin-extraction）

> **已归档（2026-09-16 · 文档面重构）**——全计划竣工（Phase 0-5，2026-08-29：兰台改连进程外引擎、摘掉 hologram-engine 依赖、Phase 4 免编译扩展面与 Phase 5 收口同日落地）。现状指针：`ARCHITECTURE.md` §5/§6 + 生成物 `docs/agents/engine-plugin-contract.md`；现状入口 `docs/plans/README.md`。

> 状态：**全计划竣工**（Phase 0-5，2026-08-29。兰台已从内嵌改连进程外引擎、hologram-engine 依赖已摘；
> Phase 4 免编译扩展面 + Phase 5 收口同日落地）。
> 立项拍板（2026-08-29）：①做彻底——兰台从内嵌改连进程；
> ②DSH 不共包——hologram-dsh 保持现状，两个宿主各自有各自的胶水；③monorepo 子目录——不开新仓。
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

> **2026-08-29 已落地（v1）**：`engine/src/contract.rs`（`ENGINE_CONTRACT_VERSION` + 载体文件清单 + 壳专属方法清单）；
> `engine_status` 新增 `contract` 字段；`DEFAULT_MCP_TOOLS` 升 pub；守卫测试（引擎 4 用例 + TS 5 用例）；
> 生成文档 + 生成器（`gen:engine-contract` / `check:engine-contract` 字节稳定）。
> **2026-08-29 复盘修订（v2）已落地**：砍分页 → 从 `SHELL_METHODS` 删 `get_graph_page` / `graph_meta` / `get_full_graph`，
> 新增 `graph_snapshot`（聚合快照）+ `file_nodes`（按文件符号索引）→ 共 **10 个壳方法**；`ENGINE_CONTRACT_VERSION` = 2；
> 文档重生成 + TS 守卫 `EXPECTED_SHELL_METHODS` 同步（`timeline_record` 补 detail/node_id 可选参数）。

### Phase 1 — 引擎侧壳专属方法实现（10 个，全部 hidden tools）✅ 已落地（2026-08-29）

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

施工落点与关键决策（2026-08-29 实测全绿，lib 584）：

- **hidden 机制**：schema 注册进 `all_schemas`（category=`shell`）但不进 `DEFAULT_MCP_TOOLS` ——
  tools/list 不可见、tools/call 可达（与 `symbol_history` 同型）；`handle_tools_call` 的
  `get_schema` 存在性校验因此对壳方法放行。守卫测试三层钉住：引擎
  `test_shell_methods_contract_alignment`（契约 ↔ schema ↔ dispatch 三面对齐）+
  `test_shell_methods_absent_from_tools_list`（行为面）+ mcp `test_tools_list_hides_shell_methods`。
- **实现在 `engine/src/tools/handlers/shell.rs`**：10 个 handler；`analyze_with_progress` 复用
  `is_long_running` + progressToken 的既有进度轮询（path 必填，与 `analyze_project` 同纪律）；
  `cache_stale` 的遍历规则单一真源 = `GRAMMAR_LOADER.supported_extensions()`（+proto）+
  `discovery::is_ignored_path`（替代壳侧硬编码 EXTS/SKIP 表，Phase 1.5 壳侧删除时零漂移）；
  `ensure_ready` 的异根拒绝用 canonicalize 比对（进程绑定单根纪律）。
- **watcher 事件桥下沉 `engine::watcher`**（进程级封顶队列 64，`push/take_watcher_event`）：
  `maybe_autostart_watcher` 起 watcher 时**回调常驻**（不再传 None）；`try_incremental` 完成摘要
  也进桥（旧实现硬编码 `&None` —— 单跑靠 OS watcher 兜底、并行下 notify 事件丢失即断链的
  测试不稳定根因）；`watcher_subscribe` 只 `ensure_watching` **绝不 stop+start 重启**
  （notify 同目录重注册存在事件丢失窗口，A/B 实验证实）。mcp.rs 主循环空闲轮询 drain 队列 →
  `notifications/message`（data=JSON 串）推宿主；`is_long_running` 加 `analyze_with_progress`。
- **bin 测试拆除**：main.rs tests 模块 27 个全删（TCP 旧协议面 Phase 3 本就拆；其 analyze 用例
  与 DSH 常驻引擎进程叠加出「测试 hang」误判链——测试 0.1s 全过，慢在冷链接 + 误杀
  `serve` 子进程的观察假象）。`engine_teardown_global` 新增（测试 teardown 清全局槽 +
  停 watcher）。
- **DoD 达成**：全部壳方法在 dispatch 可达（stdio 会话测试 + 契约对拍）；引擎门禁全绿
  （lib 584 / bin 0 / doc 0）；双工作区并发 e2e 随 Phase 2 进程形态差分补齐。

### Phase 1.5 — 前端分页拆除 + graphData → snapshot 迁移（2026-08-29 新增）✅ 已落地（2026-08-29）

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
- **DoD 达成（2026-08-29 实测全绿）**：`graphData` 消费面（hooks/agent-builder/tool-rows 开关/prompt-sections）全绿；
  128MB IPC 护栏问题消失；前端 build + vitest（200 文件 1883）+ biome 0/0 + convergence 零漂移 +
  引擎 584 / 壳 417 全绿。

施工落点与关键决策（2026-08-29）：

- **聚合单一真源上收引擎**：`tools::graph_snapshot_value(&Graph, source_root)` 与
  `tools::file_nodes_value(&Graph, root, file)`（pub）——引擎 `graph_snapshot`/`file_nodes`
  壳方法与壳侧内嵌 RPC（`get_graph_snapshot`/`load_graph_json`/`hologram_file_nodes`）三路同源，
  Phase 2 transport 切换零逻辑漂移。快照带 `source_root`（冷启动恢复信号）。
- **缓存新鲜度上收**：`tools::staleness::compute_cache_stale`（pub）——壳方法 `cache_stale`
  与壳层 `direct_analyze`/冷启动门同源；hologram_graph.json 归档退役（SQLite 唯一持久化，
  快照按需算），壳侧硬编码 EXTS/SKIP 表删除。
- **RPC 面**：拆 `get_graph_meta`/`get_graph_page`/`get_full_graph`（前端零调用的死面）+
  壳 main.rs 三段旧回归测试（分页等价/diff JSON/序列化饿死——旧行为陪葬）；加
  `get_graph_snapshot`/`hologram_file_nodes`；`load_graph_json` 重定义为快照形态；
  `analyze_and_load` 回轻状态；RpcResultShape 守卫测试同步。
- **前端 graphData = GraphSnapshot**（hooks.ts 契约类型，`asGraphSnapshot` 宽容收窄）：
  workspace.ts 删 loadGraphPages/mergePageIntoGraph/rebuildLevel0Communities/reloadGraphPaged/
  mergeGraphDiff/CachedGraphMeta/GraphPage 与 opts.skipAnalysis（快照毫秒级，装载统一为
  「load_graph_json 即时 + analyze_and_load fire-and-forget + graph-updated 重拉」）；
  workspace-flip-b3.test.ts 重写为新结构钉（含分页栈禁回潮断言），graph-paging.test.ts 删除。
- **GraphContext 重造**（file_nodes 按需索引 + 缓存）：`createGraphContext(fetcher, engine)`，
  `warmFile`（幂等在途去重）/`invalidate`（图更新失效）；enrich（异步）先 warm 再读始终新鲜；
  preflight（同步接口）未预热 → 保守无警告 + 后台预热（eventBus `tool/preflight` 同步管道与
  convergence baseline 零接触——避免异步化涟漪）；buildFileNodeIndex 全量建索引退役。
- **记忆锚点收缩**：extractGraphNodeNames 从全量节点名改为 snapshot top 扇入/扇出枢纽名
  （聚合面自然范围；kernel 级仓库全量名单本就过重）。
- **convergence fixture 零漂移构造**：FIXED_GRAPH_SNAPSHOT 与旧 FIXED_GRAPH_DATA 的
  buildGraphSnapshot 聚合输出逐字节等价（4 节点/4 边 | 2 社区 2/2 | import:2,call:2 |
  枢纽 core(2)/util(2)）——system-prompt.fixture 无需变更审批，check 通过。

### Phase 2 — 壳侧 transport 抽象（加第二条路，不翻默认）✅ 已落地（2026-08-29）

- ✅ `EngineTransport` trait（`src-tauri/src/engine_transport.rs`）：`call(method, args)` 统一方法面
  （Phase 1 壳方法契约 v2 + 模型工具全名）；`InProcessTransport`（with_current → dispatch，缺省）|
  `McpRemoteTransport`（每工作区一个 `engine serve` 子进程：惰性 spawn / ready+initialize 握手 /
  通知行过滤 / isError 转译 / 崩溃重启一次 / Drop 关停）；`HOLOGRAM_ENGINE_TRANSPORT=inprocess|mcp`
  （缺省 inprocess = 行为零变化）
- ✅ AppContexts 接线：WorkspaceDataContext.remote 槽（惰性 Arc\<McpRemoteTransport\>）+
  shutdown 对称关停 + `resolve_transport`（与 resolve_engine 同决议链）
- ✅ 服务收口：graph_service（load_graph_json / get_graph_snapshot / hologram_file_nodes 经 transport，
  冷启动新鲜度留痕走 cache_stale 壳方法）+ dispatch_service::call_dispatched 传输化（回落全局臂保留）
- ✅ 差分对拍（`tests/engine_transport_parity.rs`）：内嵌臂（new_shared + ToolRegistry::dispatch）vs
  进程外臂（真引擎 serve + mini MCP client），查询面 5 方法逐字节等价（graph_snapshot / file_nodes /
  fts_search / ensure_ready / cache_stale）；副作用命令不进差分（elapsed_secs 非确定）
- ✅ 收口实测（2026-08-29 接手窗口）：对拍绿（remote 臂 0.1s）+ 全量门禁绿（引擎 lib 584 /
  壳 bins+lib 420 + 集成 16 / 前端全量，commit 时点终值见 commit message）。门禁途中顺手收口
  两类既有测试病灶 + 一类环境污染：
  - **白名单守卫过期条目**：engine_impact 死面拆除使 `graph_service.rs :: engine_read` 直调消失 →
    `engine_global_direct_calls_are_whitelisted` 的「白名单条目必须真实存在」fail-closed 按预期打红 →
    过期条目同步删除；
  - **registry 测试进程级 env 竞态**：`with_temp_home` 翻转 USERPROFILE/HOME 无互斥，并行测试线程互踩
    （4 例假红：write_atomic os error 3 / 注册表计数互串）→ 写侧 Mutex 串行化（翻转→执行→还原全程持锁）；
  - **cdp e2e 环境自续污染**：失败测试遗留的僵尸 chrome（`--remote-debugging-port` + D:\tmp 测试 profile）
    与残留 profile 目录让后续每轮「端口 10s 未就绪」复现 → 清僵尸树 + profile 目录后复跑即绿；
    「PowerShell `>` 重定向原生命令收尾假挂」（exe 已退出但 PS 管道不收尾，前台也复现）定性为环境坑
    非代码缺陷——小输出直捕获 / 大输出 `cmd /c` 重定向。
  - **顺手修掉一个生产级真 bug（D13 引入）**：全量 vitest 恒报 `1 error`（worker heap OOM）但测试
    计数全过——二分定位到 `session-differential` 的 insertMessage 用例自旋：D13 `_loopHost()` 把
    `pendingInserts` 以数组引用快照进 loop host，而 `Agent._applyPendingInserts()` 重绑
    `this._pendingInserts = []`，loop 终止检查（`pendingInserts.length === 0`）读到过期引用 →
    插队消息应用后循环永转（生产面 = 任何排队消息 + 无工具调用轮 = 会话无限轮转直到内存爆）。
    修复 = `_loopHost` 改 getter 暴露活引用。此前会话的「全量绿」记录实际带着这颗雷（error 被
    忽略或未复跑）。
- 待办（随 Phase 3）：`hologram_service.run_check` 仍内嵌（壳编排面，Phase 3 一并处理）
- **DoD 达成**：`McpRemoteTransport` 在测试环境全程可用；差分测试钉住等价；默认仍是内嵌（行为零变化）

### Phase 3 — 翻默认 + 内嵌退役（做彻底那一刀）✅ 已落地（2026-08-29 两步全竣工）

> **第一步（默认翻 McpRemote + legacy 面拆除）**：
> - `transport_mode()` 缺省 = **Mcp**（`HOLOGRAM_ENGINE_TRANSPORT=inprocess` 为调试逃生口）；
> - legacy `start_mcp_server` / `stop_mcp_server` RPC 分支拆除（rpc.rs / rpc-contract.ts，前端零调用）+
>   `mcp_manager.rs` 整文件删除（McpManager + 3 个测试）+ `commands/external.rs` 的 MCP_MANAGER /
>   stop_mcp 拆除（保留 MEMORY_BUNDLE_CHILD + sandbox_status）+ `lifecycle::McpService` 退役
>   （ResourceLedger 注册行删除）+ `workspace_service` 切卷 stop_mcp 调用拆除；
> - `frontend-rpc-contract.md` 再生成（156→151 方法，同 commit 纪律）。
>
> **第二步（摘 hologram-engine Cargo 依赖）竣工记录（2026-08-29，对照 10 项清单）**：
> 1. ✅ `engine_transport.rs`：InProcessTransport 整臂 + TransportMode 枚举 + env 退役；
>    EngineTransport trait（单实现也留层）一并拆除——全链路直用具体型 `Arc<McpRemoteTransport>`。
> 2. ✅ **notification 泵（本步最大设计活）**：EngineSession 重写——常驻读线程按 id 路由
>    （带 id 行 → 在途请求通道；通知行 → 进程级封顶队列 cap 64 丢最旧）；EOF fail-close
>    全部在途请求（错误封套 → 上层重启重试）。同会话并发调用天然多路复用（stdin 串行 +
>    id 路由），修复旧 with_process 独占会话 + 工具级 isError 也杀进程重启的病灶
>    （CallError::Tool 与 Transport 分型，仅传输断裂重启重试一次）。壳侧 pump =
>    `WorkspaceHandle::start_watcher` 重写：`notifications/progress` → analyze-phase /
>    analyze-progress / analyze-heartbeat；`notifications/message`（watcher 摘要 / analyze_done）
>    → graph_snapshot 重查 → emit `graph-updated`（载荷形状与旧壳侧 watcher 一致）。
>    壳侧 mtime 轮询 watcher（collect_file_mtimes / compute_watcher_diff）整体退役——
>    引擎进程自带 notify watcher（engine_init 自动带事件桥起）。
> 3. ✅ **新壳方法 `run_check`（第 11 个 hidden tool，契约 v3）**：简报编排真源上收
>    （load_baseline → 空图兜底同步分析 → run_full_check → save_baseline → 时间线记录
>    quiet/baseline_seed 门，与旧壳侧逐语义等价）；异根拒绝（同 ensure_ready）。
>    `analyze_with_progress` 增加 `force` 参数——缓存新鲜度门上收（新鲜 → cached 直回，
>    旧 direct_analyze 语义等价）；分析完成后 save_baseline + 事件桥推 analyze_done。
>    `ENGINE_CONTRACT_VERSION` = 3；引擎守卫 10→11 + TS 守卫 EXPECTED_SHELL_METHODS 同步 +
>    生成文档再生成。
> 4. ✅ `hologram_service.rs`：run_check → transport `run_check`；record_event → transport
>    `timeline_record`（node_id="" 与 None 落库等价）。无工作区显式报错（全局兜底臂随内嵌
>    形态退役——行为变更：未开卷时 hologram_record_event / hologram_call 由「写/查全局引擎」
>    改为报「未打开工作区」）。
> 5. ✅ `editor.rs` / `filesystem.rs`：timeline → transport `timeline_record`
>    （utils::record_timeline_transport 共享 helper；WorkspaceHandle 持 transport 代替 engine）；
>    白名单守卫清零（壳内 engine 全局直连 = 0）。
> 6. ✅ `is_ignored_path` 归置：IGNORED_DIRS / is_ignored_dir_name / is_ignored_path 迁
>    `hologram-graph/src/ignore.rs`（测试随迁 + 补 .lantai 用例），engine discovery re-export
>    保内部路径零改动；壳侧 utils/editor/filesystem/search 四处改引 `hologram_graph::`。
> 7. ✅ `app/mod.rs`：WorkspaceDataContext 去 `Arc<Engine>`；store_host 壳自开
>    （`hologram_storage::StoreHost::open`，与引擎进程同库并发）；engine_bind_global_shared /
>    resolve_engine 退役；ContextInfo.ready 改 store 判定；analyze_persist_query_loop 单测
>    重写为进程级 e2e（见 10）。
> 8. ✅ `graph_io.rs`：缩水为 transport 版 `run_analyze_with_progress`（发起 → engine_status
>    轮询等待 → graph_snapshot 重查 → emit graph-updated——补直「全量分析后快照从不重拉」
>    的旧缺口）；direct_analyze / graph_snapshot_json / regenerate_file_graph（Phase 1.5 起即
>    死代码：其输入 hologram_graph.json 已不产出）整链删除 + 前端 fileGraphData 死状态删除。
> 9. ✅ `dispatch_service.rs` 回落臂拆除（hologram_call 必须有工作区）；tools_list → transport
>    `tools/list`（hologram_tools_list RPC 改 async，前端 loadHologramSchemas 契约不变）；
>    engine_binary / dispatch_engine / hologram_dispatch_test.rs（工具行为引擎侧自测已覆盖）删除。
> 10. ✅ 双工作区进程级 e2e + 崩溃重启 e2e（engine_transport.rs 测试模块，引擎二进制缺席自动
>     跳过）：两工作区各 spawn 一 serve、FTS 符号互不可见；硬杀子进程 → 下一次调用自动重启
>     且从 SQLite 恢复（持久化闭环 = 旧 analyze_persist_query_loop 的 transport 形态）。
>     engine_transport_parity.rs（内嵌臂对拍，内嵌臂已退役）删除。
> - **DoD 达成（2026-08-29 实测）**：`src-tauri/Cargo.toml` 无 hologram-engine（Cargo.lock 同步）；
>   `hologram_engine` 路径引用 grep 零残留（仅守卫测试字面量/注释）；全量门禁绿（分项数字见
>   commit message）；待真机验收：开卷/切卷/图查询/工具调用/merge gate/图 hooks 全链路如常；
>   崩溃恢复不挂主进程。
> - 行为变更清单（结果可查）：① hologram_call / hologram_record_event 无工作区时显式报错；
>   ② 引擎关闭的工作区首次 agent 写/编辑会惰性拉起引擎进程（timeline 照常落库——与旧行为一致）；
>   ③ 全量分析完成后现在确定性地发 graph-updated（旧形态 watcher 只覆盖增量路径，冷启动后
>   图预热清理依赖用户再改文件）；④ 工具级 isError 不再触发引擎进程重启。

### Phase 4 — 免编译扩展（第三方插件面）✅ 已落地（2026-08-29）

- ✅ `engine/src/plugins/mod.rs`：manifest 解析（serde_yaml + `deny_unknown_fields`——拼错字段可见失败）
  + 装载编排（`engine_init` 首行 `ensure_loaded`，先于 watcher 扩展表快照与任何分析）+ 全局状态
  （`STATE` = dir/loaded/errors；四张运行时表：语言适配器行 / 数据流配置 / 框架模式 / 工具条目）
- ✅ `HOLOGRAM_PLUGIN_DIR` env 指向扩展目录（设了就用，缺失即 warn 可见）；缺省
  `<project_root>/plugins`（存在才用）；都不满足 = 无扩展（no-op，不清表——已装载显式目录后
  无配置的 engine_init 不回退，测试进程并行安全）
- ✅ **语言注册表**：manifest 声明 `extensions` + `grammar`（`builtin: python` 复用静态语法——
  GrammarLoader 增 `named` 表寻址；或 `dll:` + `symbol:` 显式 cdylib，available 表改存全路径
  `AvailableGrammar`，与 grammars/ 目录扫描同一惰性 libloading 通道）+ `queries`
  （structure/dataflow .scm 运行时读盘，`Box::leak` 一次性转 `'static` 与 include_str! 共享
  进程生命周期语义；func/class kinds 同法）——AdapterRegistry::new() 尾部读表注册
  （first-wins 语义下只补缺口；装载期显式拒绝与内置扩展名冲突的 manifest）
- ✅ **框架注册表**：manifest 声明 `routes`（glob 候选模式 + method；glob→regex 编译，
  字面 `.` 经 escape 不当任意符）——`detect_framework_routes` 在内置检测器之后跑
  manifest 检测，命中文件按「剥模式前缀 + 剥扩展名」推导 URL 注入 route 节点（无 handler 边）
- ✅ **工具注册表**：manifest 声明 schema（params 对齐 ParamDef 形状，ptype 白名单校验）+
  `handler` id——`tools::builtin_handler` 注册表（= DEFAULT_MCP_TOOLS 全量 36 id 的运行时
  dispatch 形态；守卫测试钉全覆盖；壳专属方法刻意不入表——host API 不经 manifest 暴露）；
  dispatch `_ =>` 兜底按名寻址；tools/list 缺省面 = DEFAULT ∪ manifest 工具
  （`HOLOGRAM_MCP_TOOLS` 显式白名单优先，`*` = 全量 ∪ manifest）；mcp.rs 未知工具校验改
  `knows_tool`（静态 ∪ manifest）
- ✅ `engine_status` 新增 `extensions` 字段：`{dir, loaded[], errors[]}`——单 manifest 失败
  （坏 yaml / 未知版本 / 撞名 / 缺文件 / 未知 handler）只记 errors + warn，**不阻断引擎启动**
- ✅ 兼容管控：`manifest_version: 1`（未知版本 = 拒绝装载）；引擎开放面契约升 **v4**
  （ENGINE_CONTRACT_FILES + grammar_loader.rs / plugins/mod.rs；changelog 记 extensions 字段
  + tools/list 面 + HOLOGRAM_PLUGIN_DIR）
- **DoD 达成**：`examples/engine-plugins/`（mylang.yml + pagesfw.yml + mytools.yml + 两份 .scm）
  三 manifest **零行 Rust** 端到端生效——`test_manifest_end_to_end` 钉死：engine_init 装载
  → engine_status 三扩展可见 → .myl 文件经 manifest .scm 提取出符号 → config_for_ext 命中
  manifest 数据流配置 → tools/list 含 manifest 工具且 dispatch 可调 → 候选模式注入 route 节点
  → 同 env 重入幂等。16 用例全绿（glob/URL 推导、解析错误矩阵、grammar 注册/冲突、
  handler 注册表全覆盖守卫）

### Phase 5 — 收口（文档 / 布局 / 历史）✅ 已落地（2026-08-29）

- ✅ `gen-engine-plugin-contract` 挂 doc-sync 门禁（`scripts/doc-sync.cjs` generators 登记第 5 项——
  生成器字节稳定 + `--check` 对拍，doc-sync 全绿）
- ✅ `docs/plans/README.md` 计划现状入口换血（引擎插件化行 = 全计划竣工）+ `HISTORY.md` 里程碑行
- ✅ 计划本文：状态头 + Phase 4/5 施工落点记录（本节）
- 物理收编（`plugins/hologram-engine/` 子树）：未做——本计划不预设，维持 monorepo 子目录现状
  （§2 拍板），若有价值作为独立里程碑再议

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

> **2026-08-29 清理执行**：8.1 后三项 + 8.3 全部物理残留已清（详见各条）；
> 8.2 的 `#[tauri::command]` 死装饰（实测 87 处，非 91）+ TCP 9777 旧协议分支留待
> 专项核签（函数可能用 `tauri::State` 参数，需逐个验签名）；8.4 bench 脚本与研究文档
> 冲突（研究文档记为活跃基准工具），存疑未动。门禁全绿（引擎 592 / 前端 1894+4skip /
> build / biome 0/0 / convergence exit 0）。

### 8.1 为「已退役 3D 星图 + 旧前端」服务（砍分页 = 最大块）

- 图分页运输栈（见 Phase 1.5）：壳侧 graph_io 8 函数 + 前端 4 loader + 3 RPC + mock fixture
- ~~`chat-core.ts` `ChatFooterHandle` 死槽（V5 后无注册方）~~ ✅ 已删（接口 + 字段 + registerFooter
  方法；`updateFooter` 改显式空操作保留 StreamContext API 契约——冻结文件 chat-stream/
  chat-session 仍调用）
- ~~`shell-store.ts` `graphStats` 死字段（V5 后无写入方）~~ ✅ 已删（GraphStats 接口 + 字段 +
  setter 全链删除；全仓零引用确认）
- `scene/graph-types.ts` `StarGraph` 兼容形状（type-only 壳）——**不动**：深度嵌入冻结文件
  chat-stream.ts/chat-session.ts + 12 个测试 mock，拆除需改冻结文件签名，风险不符收益

### 8.2 装饰性/误导性残留

- **87 个 `#[tauri::command]` 注解**（实测 87，非原记 91）：`invoke_handler` 实际只注册 2 个
  （`rpc::rpc` + `get_active_project`）——壳真实 IPC 面是 rpc.rs 162 分支，这些注解是死装饰。
  **留待专项核签**：函数可能用 `tauri::State`/`Window` 参数，删注解需逐个验签名，量大面广（30+ 文件）。
- ~~legacy `start_mcp_server` / `stop_mcp_server` RPC~~ ✅ Phase 3 已拆（rpc.rs / rpc-contract /
  mcp_manager.rs 整文件删除；全仓仅文档/注释残留）
- TCP 9777 旧协议 20+ 分支（blindspots/timeline/fragile/cycle/coupling_report/graph_summary/community_report/
  community/diff/history/delayed/neighbors/path/search/impact/rename/check/preflight/health）：DSH viewer 只用 3 个
  （get_graph/analyze/reanalyze），其余无已知消费者——**待确认外部 Unity 假设**

### 8.3 孤儿/物理残留（小而明确）

| 件 | 判定 |
|---|---|
| ~~`specs/` 6 份文档（全仓零引用）~~ | ✅ 已删（gitignored 本地残留） |
| ~~`.venv/`（裸 Python venv，1686 文件）~~ | ✅ 已删（gitignored 本地残留） |
| `scripts/bench_resolution.py` + `bench_scip_bridge.py` | **存疑未动**：研究文档记为活跃基准工具（P1-3 尚未接 CI），与「Python 引擎退役残留」判定冲突 |
| ~~`release-bin/`（hologram/hologram.cmd/install.cmd/install.sh）~~ | ✅ 已删（tracked，git rm；全仓零引用确认） |
| ~~`engine/engine-bin/` 空目录~~ | ✅ 已删（gitignored） |
| ~~`engine/tmplinux-stress/`~~ | ✅ 已删（gitignored；含嵌套 .git + 171MB pack，误留 clone） |
| ~~`engine/queries/js_ts_structure.scm`~~ | ✅ 已删（tracked，git rm；`new_js_ts()` 用 ts_structure + js_structure，零代码引用确认） |

### 8.4 存疑待核（不急着动）

- `stress.rs`（48KB）+ main.rs stress CLI：开发压测工具在役，但 48KB 编进 lib 值得商榷
- ~~`get_full_graph`：workspace.ts 还在用（导出/备份？）~~ ✅ Phase 1.5 已拆（workspace.ts 无残留）；
  `tool-rename-impact.test.ts` 的 `KNOWN_TAURI_COMMANDS` 过期条目已清
- `engine/onnxruntime.dll`（13MB）：向量功能 live，别动

### 8.5 已确认健康（不是残留，别误伤）

- three/WebGL 在 src-ui 零残留（renderer = 块渲染器不是 WebGL）；Python 引擎代码零残留（只剩注释）
- louvain/leiden、timeline-store、subagent-sink、graph.ts shim：全 live
- 旧 UI 组件（TimelineHUD/ChatFooter/ChatBeacon/CommandBar/DataflowPanel）：已全部退役，只剩历史注释
