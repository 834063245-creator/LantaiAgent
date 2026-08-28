# 引擎独立插件化：兰台进程外 + MCP 契约（engine-plugin-extraction）

> 状态：Proposed·Draft（2026-08-29 立项，用户拍板三点：①做彻底——兰台从内嵌改连进程；
> ②DSH 不共包——hologram-dsh 保持现状，两个宿主各自有各自的胶水；③monorepo 子目录——不开新仓）
> 本文是「把图谱引擎拆成独立插件」的唯一计划。与 v11 分析引擎计划（算法面：
> 预算/降噪/动态边）是两条独立线，互不阻塞。
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
2. **前端 RPC 契约可零改动**：前端消费引擎的路径（`hologram_call` / `get_graph_page` / `get_graph_meta` /
   `analyze_and_load` / `engine_impact` / `graph-updated` 事件）全部经 `typedRpc/typedListen` → src-tauri 命令。
   手术全部在**两个 Rust 侧**（引擎 + 壳）——TS 侧 43 插件 / convergence baseline / 前端测试零接触。
   这是本计划爆炸半径被压住的核心性质。
3. **跨边界有真实成本的三条数据路径**：
   - **图分页**：`graph_io.rs` 现在直读进程内 `MemoryIndex` 算 page / hierarchical communities / diff / 缓存（大图逐页拉全量 JSON 不现实）
   - **watcher 增量推送**：现在进程内 watcher 改共享 index → 壳发 `graph-updated`；跨边界要引擎 → 壳的推送通道
   - **持久化/审计**：`store_host` 现在是壳与引擎共享 Arc（L2 注入面）；跨边界后数据归属整个移到引擎进程
4. **引擎二进制已是独立发布物**：GitHub Releases 附件（`hologram-engine-win32-x64.exe`，install.mjs 按 tag 下载），
   这正好是「插件」的物理形态。

## 2. 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│  图谱引擎插件（独立维护单元，本仓 engine/ + hologram-*/ 子树）     │
│                                                              │
│  hologram-engine 进程（每工作区一个）                           │
│   ├─ stdio MCP：36 模型工具 + N 个壳专属方法（hidden tools）      │
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
- 拓扑：**每工作区一个引擎进程**（推荐，待拍板 §6）——隔离最干净、复用 McpManager spawn 机制、
  与现状「每工作区一个 Engine 实例」语义对齐；代价是 N×进程内存（EXE 页跨进程共享，典型 1-3 工作区可接受）。
- 数据归属：`.lantai/hologram.db` 等由引擎进程自己 `StoreHost::open`（L2 注入面反转回引擎自持）；
  `audit.jsonl` 留壳侧（壳记录自己的动作，不动）。
- monorepo 布局：**不动物理路径**（engine/ 已是子目录）；边界靠契约 + 守卫测试钉死，不靠挪目录。
  若后续证明物理收编有价值，作为独立里程碑再议。

## 3. 阶段计划（每阶段门禁全绿才进下一段）

### Phase 0 — 契约化（纯文档 + 守卫测试，零行为变化）

> **2026-08-29 已落地**：`engine/src/contract.rs`（`ENGINE_CONTRACT_VERSION=1` + 载体文件清单 + 11 个壳专属方法清单）；
> `engine_status` 新增 `contract` 字段（版本 + 壳方法名，宿主可探测）；`DEFAULT_MCP_TOOLS` 升 pub 供契约消费；
> 守卫测试：引擎 `contract::tests` 4 用例 + `src-ui/tests/engine-contract.test.ts` 5 用例（版本/唯一性/与模型工具零冲突/定稿双登记）；
> 生成文档 `docs/agents/engine-plugin-contract.md` + 生成器 `scripts/gen-engine-plugin-contract.cjs` → `src-ui/scripts/gen-engine-plugin-contract.ts`（`npm run gen:engine-contract` / `check:engine-contract`，字节稳定无时间戳）。

- 引擎 MCP 工具面版本化：契约版本号（组合层 `composition/contract-version.ts` 的先例照搬，引擎侧镜像一份）；
  36 工具名 / schema / 输出形态冻结；`HOLOGRAM_MCP_TOOLS` 开关语义不变
- GraphJSON 数据契约钉死：`src-ui/src/scene/graph-types.ts` 已是唯一权威源（viewer 复用中），补一份引擎侧类型声明的对拍守卫
- 新增「壳专属方法」清单定稿（hidden tools，不进 `tools/list`，形如 `symbol_history` 的隐藏先例）：
  `get_graph_page` / `graph_meta` / `get_full_graph` / `analyze_with_progress`（进度走 notification）/
  `save` / `fts_search` / `timeline_record` / `diff`（baseline）/ `ensure_ready` / `cache_stale` /
  watcher 订阅（notification push）
- **DoD**：契约文档落 `docs/agents/engine-plugin-contract.md`（gen 脚本生成，勿手改）；
  守卫测试钉住「36 工具清单 + 隐藏方法清单」三层对齐（沿用 `tests/engine-tool-surface.test.ts` 模式）；
  内嵌 / DSH / 裸 MCP 三形态看到同一工具面

### Phase 1 — 引擎侧壳专属方法补齐（跨边界的数据路径在引擎侧实现）

- 图分页：`graph_io.rs` 的 page / communities / diff / 缓存逻辑**迁入引擎**（引擎持有 index，按需算页），
  壳侧 `graph_io.rs` 变成薄转发
- 进度：`run_analyze_with_progress` → MCP `notifications/progress`（引擎内自持分析状态）
- watcher：引擎 watcher 事件 → MCP notification（`graph-updated`）→ 壳转发 `typedListen`
- 持久化：`save` / FTS / timeline 落引擎侧方法
- **DoD**：全部壳专属方法在 `engine.exe serve` 下可用；引擎 `cargo test` 全绿（新增方法单测）；
  双工作区并发 e2e 在进程形态下可跑（引擎侧多实例自持）

### Phase 2 — 壳侧 transport 抽象（加第二条路，不翻默认）

- `dispatch_service` / `graph_service` / `hologram_service` / `graph_io` 背后加 `EngineTransport` trait：
  `InProcessTransport`（现状默认）| `McpRemoteTransport`（连引擎进程）
- 复用 + 现代化 `McpManager` 为「每工作区一个进程」的 `EngineProcessManager`（spawn / 就绪握手 /
  崩溃重启 / 关停），改造成不带单例锁的长等待（P1-19 教训已在案）
- **差分对拍**：同一条命令在两个 transport 下逐字节等价（layering-rework 对账守恒的做法照搬）；
  壳 `cargo test` 全绿（含双工作区并发 e2e 双跑）
- **DoD**：`McpRemoteTransport` 在测试环境全程可用；差分测试钉住等价；默认仍是内嵌（行为零变化）

### Phase 3 — 翻默认 + 内嵌退役（做彻底那一刀）

- 默认 transport = `McpRemoteTransport`；`WorkspaceDataContext` 从持 `Arc<Engine>` 改持 `EngineProcessHandle`
  （进程 + MCP client + 事件桥）
- 壳侧 248 处引擎直调收口到 transport（`app/mod.rs` / `graph_io` / `graph_service` / `hologram_service` 等）；
  `src-tauri` 从 Cargo.toml 摘掉 `hologram-engine` 依赖（壳不再内嵌）
- 生命周期：工作区开 = spawn 进程（`serve --project-root`），工作区关 = kill；崩溃 = 重启 + 降级提示
- 清理：legacy `start_mcp_server/stop_mcp_server` RPC 面拆除（前端 rpc-contract 同步）
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
| 前端（应零改动，防回归） | `cd src-ui && npx vitest run` + `npm run build` |
| 组合层（应零改动） | `cd src-ui && npm run verify:convergence` |
| 格式 | `cd src-ui && npx biome ci .`（0/0） |

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 跨边界性能回退（图分页/查询延迟） | 分页/communities 逻辑迁引擎（Phase 1 就做，不等到 Phase 3）；TCP 协议与 viewer 已证明可行 |
| watcher 增量推送断链 | Phase 1 先建 notification 通道，差分测试钉住 graph-updated 时序 |
| 多进程内存/资源 | EXE 页共享；典型 1-3 工作区；崩溃隔离反而是收益 |
| LSP 子进程归属 | 本来就在引擎进程内，跨边界无变化 |
| 248 处直调迁移遗漏 | Phase 2 的 transport 抽象 + 差分对拍兜底；Phase 3 摘依赖后编译期强约束（漏一处就编不过） |
| N 进程与现有单进程假设（MCP 语义） | 拓扑决策 §6 拍板后，Phase 2/3 按该拓扑落 |

## 6. 待拍板（开工 Phase 0 不依赖，Phase 2/3 依赖）

1. **拓扑**：每工作区一个引擎进程（推荐：隔离干净、复用 McpManager、语义对齐现状）
   vs 单进程多根（内存省，但要改引擎 serve 成多根模式、MCP 契约语义复杂化）
2. **壳专属方法命名空间**：隐藏工具（形如 `symbol_history`）vs 独立 `_shell/` 前缀——推荐隐藏工具，复用既有注册面
3. **Phase 0/1 先开工**：契约 + 引擎侧数据路径补齐不依赖任何拓扑决策，可立即启动

## 7. 非目标（本轮明确不做）

- TS 图谱域工具抽成可移植插件包（用户已拍板：不共包，兰台与 DSH 各自胶水）
- dsh-bundle 改造（用户已拍板：先不管）
- 新开 git 仓库（用户已拍板：monorepo 子目录）
- v11 算法面（预算/降噪/动态边）——独立计划，不并入本文
- 引擎物理目录收编——Phase 5 视需要再议
