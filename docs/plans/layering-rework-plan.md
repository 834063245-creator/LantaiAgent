# 分层重构（Layering Rework）— engine 纯化 + 壳层瘦身 + 应用层新生 施工计划

> 立项：2026-08-24 · 状态：**L1-L4 已落地 + L5 文档收尾 + L5b crate 化欠账满偿（2026-08-25）；待真机验收四项** · 版本：v1.3
> 触发：用户架构判断「图谱分析 engine 成了实施意义上的后端，但它本身不是后端」「壳层也塞了太多东西」「多会话并行两个工作区时 engine 全局单例必撞」。用户要求**彻底方案，无远期，一路推到底**。
> 本文档自包含：接手会话读完本文 + `AGENTS.md` + `CONVENTIONS.md` + `INVARIANTS.md` 即可开工。
> 前置依赖：`session-unify-plan.md`（会话统一，施工中）——本计划**等 session-unify 收尾后开工**（两者都动存储层，避免两线作战）。
> 上游已验收：`docs/archive/workspace-ownership-root-cure-handoff.md`（工作区归属根治）。

## 0. 一句话

**三个职责各自归位**：壳管通道和边界，应用层管业务和数据归属，engine 管纯计算。engine 从「分析器 + 数据家 + 服务单例」退化为**无状态分析器**；壳层从「通道 + 业务 + 权限 + 进程」瘦身为**通道/权限/进程**；中间新生一个按工作区实例化的**应用层（数据上下文）**。

## 1. 现状快照与耦合清单（代码定位）

### 1.1 engine 的四顶帽子（分析器长成了数据家）

| 帽子 | 职责 | 代码定位 |
|---|---|---|
| 分析器 | tree-sitter 建 AST、依赖分析、图结构、社区 | `engine/src/analysis/`、`engine/src/pipeline/`、`engine/src/graph/`（node/edge/query/resolver/import_resolver） |
| 数据家 | 图库持久化、全文索引、向量索引 | `engine/src/storage/`（sqlite/store/memory/snapshot/incremental/string_arena）、`engine/src/vector/`（vectors.usearch + slots） |
| 服务单例 | MCP 工具面、路由、跨请求状态 | `engine/src/mcp.rs`、`engine/src/routing/`、`engine/src/tools/` |
| 合并/查询面 | merge gate、hooks 消费图数据 | `engine/src/graph/merge.rs`、`engine/src/tools/`（hologram 工具） |

**核心问题**：`hologram.db`、FTS5、向量索引是**按工作区绑定的数据**，却住在**全局单例 engine** 内部。分析器（无状态计算）与数据家（有状态存储）混在同一进程同一实例。

### 1.2 壳层的四份活（通道长成了业务层）

| 活 | 职责 | 代码定位 |
|---|---|---|
| RPC 通道 | 路由、参数校验、返回形状 | `src-tauri/src/rpc.rs`（命令分支表 + 形状分派） |
| 命令业务 | 文件/工作区/图/数据流/git/搜索/编辑器/插件安装 等业务逻辑 | `src-tauri/src/commands/`（18 模块：constraints/dataflow/editor/engine_dispatch/external/filesystem/git_cmds/graph/hologram/identity/isolation/plugin_install/protocol_bridge/search/shell/web/workspace） |
| 横切设施 | 权限沙箱、敏感词、审计、进程沙箱 | `confined_fs.rs`、`permissions/`、`sensitive.rs`、`audit.rs`、`os_sandbox.rs`、`sandbox.rs` |
| 进程管理 | 桌面自动化、MCP 桥、pty、LSP | `uia/`、`cdp/`、`desktop.rs`、`mcp_manager.rs`、`pty_manager.rs`、`lsp_manager.rs`、`llm_proxy.rs` |

**核心问题**：**应用层没有独立存在**。业务逻辑（工作区编排、图命令、hologram 命令）直接住在壳里，壳同时是通道和业务，所以又厚又混。

### 1.3 并行撞车场景（用户点破的真实矛盾）

```
会话 A（工作区 X）─┐
                  ├─→ 壳(rpc.rs) ─→ engine（全局单例）
会话 B（工作区 Y）─┘
```

- engine 单例持有按工作区绑定的 `hologram.db` / 向量索引 / FTS5；
- 两会话两工作区并行时，图库归属无架构保证；当前靠「调用带 path 参数 + 多数调用串行」三个侥幸撑着（见 §8 风险）；
- merge gate / hooks 的图数据消费走 engine 单例，没有"当前工作区上下文"概念，并发即竞态。

## 2. 根因

**职责没有分家，中间缺了一层该有的应用层。**

- engine 是「分析器」却拥有了后端才该有的东西（库/索引/会话状态）——分析器不该是数据的家；
- 壳是「通道」却承担了业务逻辑——通道不该是业务的办公室；
- 正确的四层中「应用层（业务编排/数据归属/工作区上下文）」不存在，业务被就近压进壳，数据被就近压进 engine。

这是「从工具长成平台」的演化路径病：分析器先跑起来，数据顺手放旁边，后来加会话/权限/工具，就近堆，自然长成「engine 即后端、壳即业务」。

## 3. 目标架构（一次到位，无远期）

```
┌─ UI（React）────────────────────────────┐
│  只跟壳说话，不知道 engine 存在           │
└──────────────┬───────────────────────────┘
┌──────────────▼───────────────────────────┐
│  壳层（Shell）：RPC 路由 / 权限沙箱 /      │
│  进程生命周期 / 审计 / 敏感词              │
│  （通道与边界，不写业务）                  │
└──────────────┬───────────────────────────┘
┌──────────────▼───────────────────────────┐
│  应用层（App Layer，新生）：               │
│  按工作区实例化的 DataContext：            │
│  - 图库/索引/向量 的归属与生命周期          │
│  - 业务编排（工作区/会话/图命令）           │
│  - merge gate / hooks 的数据供应           │
│  - 权限查询（供壳层沙箱调用）              │
└──────────────┬───────────────────────────┘
┌──────────────▼───────────────────────────┐
│  engine（纯无状态分析器）：                │
│  输入代码/路径 → 产出分析结果              │
│  不持有库、不持有索引、不持有状态          │
└───────────────────────────────────────────┘
```

**并行语义**：两个会话两个工作区 = 两个 DataContext 实例 + 一个共享无状态 engine。互不干扰，天然正确。

## 4. 施工阶段（L1-L5，按依赖序，每阶段独立可验证可 commit）

> 编号 L 段（Layering/分层）。每阶段完成即 commit（用户断连频繁，落盘优先）。全部阶段做完才叫收工，无"远期"。

### L1 数据上下文抽象（立边界 + 运行时上下文按工作区实例化）

> **设计参照（DSH 对标，2026-08-24 调研）**：`d:/useful/deepseek-harness`
> `packages/workspace/workspace/src/entity.ts` + `types.ts`、`packages/client/runtime/src/client/workspaces/service.ts`、`packages/client/runtime/src/client/sessions/manager.ts`（session.create）。
>
> DSH 五条铁律（本阶段设计的直接参照）：
> 1. **会话是第一公民，自带 cwd 事实**——session header 持有 canonical cwd，独立于任何工作区存在；删工作区注册，会话无损。
> 2. **工作区 = 注册表容器**——`WorkspaceId` 是 uuid（非路径，路径会重写，锚点必须稳定）；`path` canonical 化后永不重写；持有有序会话账。
> 3. **attach = 事实校验非声明**——绑定会话靠校验（header cwd 存在且 canonical === workspace.path，缺一拒绝），不靠口头归属。
> 4. **出生与绑定分离**——session.create 先出生（blank）再 attach；attach 失败会话仍在（Ungrouped），不销毁。
> 5. **运行时锚点 = 当前会话，工作区是派生投影**——启动恢复/新建会话先看 current session，其次 recentWorkspace（由会话活跃度推导）；工作区永远是配角。
>
> 对兰台的修正（用户点破「工作区逻辑没彻底改好」）：兰台锚点顺序反了——现状是「当前工作区单例决定会话的 Agent 上下文（图/权限/cwd）」，目标形态是「会话自持 workspace 事实（U1 已加字段），DataContext 按工作区实例化，会话打开时 attach 到自己的工作区 DataContext，当前工作区退化为 UI 投影」。

**目标**：壳层新生 `DataContext`（按工作区实例化），把对 engine 存储/索引/图查询的访问全部收口到上下文；**会话打开时从卷快照 `workspace` 字段 attach 到对应 DataContext（事实校验，非声明）**；engine 接口改为**显式携带上下文/路径**，禁止隐式全局状态访问。

改动点：
- `src-tauri/src/` 新增 `app/`（应用层模块）或 `context.rs`：`WorkspaceDataContext`——持有工作区路径（canonical 归一化）、图库句柄、索引句柄、向量句柄、生命周期（create/destroy/refresh）；会话侧 `attachSession(workspace)` 校验（卷快照 workspace 字段存在且目录在，缺一拒绝/降级 Ungrouped）。
- `rpc.rs`：命令分派前解析请求所属会话 → 会话 attach 的 DataContext → 传上下文进命令实现（不再以「当前工作区」为隐式锚）。
- `commands/` 各模块：图相关命令（graph/hologram/engine_dispatch）从"调 engine 全局"改为"经 DataContext 调 engine（携带工作区标识）"。
- engine 侧：`mcp.rs`/`routing.rs` 请求入口增加上下文/路径参数（不搬存储，只立访问边界）。
- 「当前工作区」退化为 UI 投影（由当前会话推导，DSH recentWorkspace 同款）；删除工作区注册不影响会话卷（会话在全局位独立存在）。

**验收判据**：
- 单工作区行为完全不变（测试基线不红）。
- 双工作区并行时，图查询经各自 DataContext，无共享状态写入（新增并发守卫测试）。
- 跨工作区会话打开：attach 到自己的工作区 DataContext（workspace 字段校验）；零目录/目录缺失 → Ungrouped 最小上下文，会话照常可用。
- `cargo test`（engine + src-tauri）全绿。

### L2 存储外置（数据家出 engine）

**目标**：`hologram.db`、FTS5、向量索引从 engine 内部移到 DataContext 层；engine 不再"拥有"任何数据文件，退化为无状态分析器。

改动点：
- `engine/src/storage/`（sqlite/store/snapshot/incremental）：**迁移出 engine**，落到 `src-tauri` 的 DataContext 实现（或独立 crate，见 Q1）；engine 的 graph 查询改为接收"已打开的库句柄/索引引用"（由上层注入）。
- `engine/src/vector/`：向量化计算保留在 engine（纯计算），但 `vectors.usearch` 文件归属 DataContext；engine 产出向量，上层落盘。
- `engine/src/graph/merge.rs` 与 hooks 消费：图数据从 DataContext 拿，不再隐式访问 engine 内部存储。
- engine 暴露面收窄：`lib.rs` 导出改为"纯分析 + 向量化计算"接口，存储类导出移除。

**验收判据**：
- engine `cargo test` 全绿（存储测试迁移到新层后重跑）。
- 图分析→落盘→再查询的闭环经 DataContext 全通。
- 多工作区各持各的库句柄，并发写入互不覆盖（新增 e2e 测试）。

### L3 壳层瘦身（业务逻辑出壳）

**目标**：`commands/` 里的业务逻辑（workspace 编排、graph/hologram 命令、数据流）抽到应用层；壳保留路由/权限/进程。

改动点：
- `commands/workspace.rs`、`commands/graph.rs`、`commands/hologram.rs`、`commands/engine_dispatch.rs`、`commands/dataflow.rs`：业务实现迁入 `app/`（应用层）模块，`commands/` 只留薄壳（参数校验 + 调应用层）。
- `rpc.rs`：命令分派改调应用层入口（业务归位）。
- 横切设施（confined_fs/permissions/sensitive/audit/os_sandbox）**留在壳层**（它们就是边界，见 §3 目标架构）；权限查询接口开放给应用层使用。

**验收判据**：
- RPC 行为不变（`cargo test` 全绿；前端 vitest 契约测试不红）。
- `commands/` 各文件显著变薄（业务迁出，可 grep 抽查）。
- 壳层文件职责可一句话说清（通道/边界/进程）。

### L4 并行语义落地（merge gate / hooks 数据源改造）

**目标**：merge gate、hooks、图谱数据消费全部经 DataContext 供应；多工作区并发是**架构保证**而非调用方自觉。

改动点：
- merge gate 相关命令/工具：数据源改 DataContext（按请求工作区）。
- hooks（preRunHook、graph-updated 消费等）：图数据经 DataContext 取。
- 新增多工作区并发 e2e：两工作区同时分析 + 同时 merge gate + 同时 hooks，断言无串写、无错位。

**验收判据**：
- 并发 e2e 通过（见上）。
- 无任何路径隐式访问 engine 单例存储（grep 守卫测试）。
- 用户真机：双工作区并行会话（两个项目各开一卷同时跑）无错乱。

### L5 数据迁移与收尾

**目标**：现有 `hologram.db`/向量/索引按工作区归位到 DataContext 数据目录；全量门禁；真机验收。

改动点：
- 迁移逻辑：旧 `.lantai/hologram.db`（工作区级）→ DataContext 数据目录（保持每工作区一份，路径对齐 session-unify 的 workspace 元数据语义）。
- 旧路径兼容期：读旧库迁移，迁移完成后只读退役。
- 文档更新：`ARCHITECTURE.md` 分层图、`AGENTS.md` 目录结构/验证基线、`docs/plans/README.md` 登记。

**验收判据**：
- 用户数据完整迁移（原图/索引/向量可查）。
- `cd engine && cargo test`、`cd src-tauri && cargo test`、`cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`（0/0）全绿。
- 真机验收：单工作区功能不回归 + 双工作区并行正常。

## 4.1 L1 施工设计定稿（2026-08-24 晚，施工中）

> 前置依赖 session-unify 已竣工（真机验收通过），Q4 开工条件成立。

**施工序（每步独立 commit）**：

- **C1 引擎侧地基（engine crate）**：
  1. `ENGINE` 全局 `RwLock<Option<Engine>>` → `RwLock<Option<Arc<Engine>>>`；`Engine::init(&mut self)` → `(&self)`（字段本就全内部可变）；新增 `Engine::new_shared(root) -> Arc<Engine>`（Arc 包裹 + `self_ref: Weak` 自引用，供 watcher 线程升级）。
  2. **线程局部当前引擎（TLS）**：`engine::current_engine() / with_current(arc, f)`——所有 `engine_*` 全局自由函数入口先查 TLS 再落全局。壳层 `hologram_call` 在 spawn_blocking 线程上 `with_current(会话引擎, dispatch)`，工具处理器（tools/mod.rs `with_store/with_graph/project_root`）自动吃到正确引擎。**纪律：TLS 只允许在同步闭包内存在（Drop 清理），禁跨 .await**（R7 教训：异步共享态归因必串；本处单线程闭包限定无此问题）。跨工作区并行 dispatch 零锁串行、零换绑竞态。
  3. **watcher 实例化**：`Engine::handle_watcher_changes` 由静态（吃全局 ENGINE）改 `(&self)` 实例方法——这是多实例化的**必改洞**：否则各 context 的 watcher 会互相串写全局引擎的 store。`maybe_full_reanalyze` 内全局调用改实例调用。非共享实例（`Engine::new()` 直建，测试用）不自动起 watcher。
- **C2 壳层应用层（src-tauri/src/app/）**：
  - `WorkspaceDataContext { root: PathBuf(canonical), engine: Arc<Engine>, sessions: Mutex<HashSet<u64>> }` + `AppContexts { contexts, sessions: HashMap<u64, SessionBinding>, focus: Option<u64> }`（Tauri managed state）。
  - **会话 attach = 事实校验**：`session_attach { session_id, legacy_root? }` 读卷快照（全局位优先 → legacy 目录回退）取 `workspace` 字段为事实；目录在 → canonical → ensure context → 绑定；卷缺/字段空/目录不在 → **Ungrouped**（最小上下文，会话照常可用）。新生会话（卷未落盘）可用 `workspace` 声明绑定（DSH 规则 4：出生与绑定分离），卷落盘后以卷为事实。
  - `session_focus`（UI 投影驱动）/ `session_detach`（GC：无会话绑定且非焦点且非单槽活跃的 context 释放）/ `context_list`。
  - `workspace_activate` 兼容腰：确保对应 context（单槽时代与 context 时代同引擎实例，杜绝双实例漂移）；`WorkspaceHandle` 持 `engine: Option<Arc<Engine>>`，壳层 mtime watcher 改调实例 `try_incremental`（修掉它吃全局引擎的串写风险）。
- **C3 壳层路由（命令族）**：解析链 **显式 path 参数 → `_session_id` → 焦点会话 → 单槽工作区 → 全局兜底**；`utils/graph_io.rs` 全家族签名改收 `&Engine`；`hologram_call` 解析引擎后 TLS 绑定 dispatch；filesystem/editor 的 timeline 记录路由到解析引擎。
- **C4 前端接线**：rpc-contract 增 `session_attach/focus/detach/context_list` + `AgentCtx._session_id`；`agentInvoke` 注入活跃会话 id（session-scope store）；SessionsHome 开卷 → attach+focus；switchSession → focus；shell-store `projectPath` 语义改为「焦点会话工作区的投影」；`gen:rpc-contract` 再生成。

**L1 明确边界（后续阶段消化）**：权限沙箱仍单槽（跨工作区并行 fs 写在 L1 仍聚焦区失败关闭——不损坏，只拒绝；per-context 权限在 L3/L4）；多工作区并行 UI（画布模型，session-unify §3.4 挂起项）不做，L1 交付的是 Rust 侧架构就绪 + 并发守卫测试。

## 4.2 L1 施工进度（2026-08-25 凌晨）

- ✅ **C1 引擎侧地基**（commit `2771a430`）：Arc 化 + `Engine::new_shared` + TLS 当前引擎（`with_current`，全部 `engine_*` 自由函数前置检查）+ watcher 实例化（`handle_watcher_changes(&self)`——多实例串写洞修复）+ `engine_bind_global_shared`。engine 测试全绿（675+27+1）。
- ✅ **C2/C3 壳层应用层 + 命令族路由**（commit `9a0edfa6`）：`app/`（WorkspaceDataContext/AppContexts/attach 事实校验/GC/决议链）+ 四命令（session_attach/detach/focus/context_list）+ workspace_activate 兼容腰（同根同实例）+ 壳层 watcher 实例化 + graph/hologram/engine_dispatch 全族决议路由 + hologram_call TLS 绑定 dispatch + filesystem/editor 时间线路由 + 图分页测试实例化（全局锁退役）。cargo test 全绿（bin 419 + 集成 14）。
- ✅ **C4 前端接线**（commit `fb16c09a`）：rpc-contract 四命令 + `AgentCtx._session_id`；`state/session-scope.ts`（活跃会话 store）；`agentInvoke` 恒注入 `_session_id`；`chat-session.ts` 三入口接线（switchSession→focus；loadSessionFromDisk→attach+focus[legacy_root=projectPath]；createNewSession→新生声明绑定）；gen-rpc-contract 再生成（顺修脚本分区 off-by-one：`^\s*` 吞换行致首分支归上区——存量 bug）。门禁：vitest 171 文件 1692 用例 + build + biome 0/0 全绿。**L1 至此四步全部落地。**
- **mcp.rs 上下文参数项**的落地形态说明：Q3 拍板 MCP 面留 engine（stdio serve 是独立进程，其全局 ENGINE 天然单实例正确）；进程内工具面（hologram_call）的「上下文参数」= 分派入口 `with_current` 绑定——不逐 handler 穿线而以线程局部路由达成同构语义（L2/L4 engine 纯化时再评估是否需要显式参数化）。

## 4.3 L2 施工进度（2026-08-25 凌晨）

- ✅ **C5 存储外置（所有权语义落地）**（本 commit）：
  - engine `storage` 新增 **StoreHost**（GraphStore + timeline 专用连接）——数据文件（hologram.db/FTS5/快照）的**所有权单元**，由宿主（壳层数据上下文 / engine 二进制）创建并**注入** Engine（共享句柄 `Arc<Mutex<StoreHost>>`）；Engine 是计算与访问的执行方，不再唯一拥有数据。
  - **Engine 绑定单根终身不变**：`Engine::open(root)`（宿主开 store 注入，返回即 Ready）取代 `new()+init()`；`init()` 降级为兼容校验（同根幂等 / 异根 Err——切换 = 新建实例）；`engine_init` 全局路径切根 = 换整个实例（旧实例 watcher 经 Weak 自灭）。
  - 壳层 `WorkspaceDataContext` 显式持 `store_host` 共享句柄——应用层可直接持久化/检查库（L3 业务归位的数据面就位）。
  - **验收 e2e 落钉**：`analyze_persist_query_loop_via_context`（分析→落盘→查询闭环经上下文：engine.read 与 store_host 直查同源一致；GC 后重开从 SQLite 读回同量节点）+ 既有双工作区并发不串写测试。engine 676+27+1 全绿、src-tauri bin 420 + 集成 14 全绿。
- **L2 欠账（诚实记录，后续阶段消化）**：
  1. **物理 crate 收窄**：`lib.rs` 的 `pub mod storage` 导出暂不收——StoreHost 的物理家仍在 engine crate（shell 直接 import）。收窄前置 = storage 独立 crate 化（机械搬家，语义已定），归入 L5 收尾批。
  2. **vector 检索注册表实例化**：`vector::get_or_load_index(root)` 按根键控的静态注册表，数据文件已随工作区物理分家；注册表搬进 context 与 hooks/工具数据源同批，归入 L4。

> **欠账满偿（2026-08-25 L5b，本 commit）**：上两条全部收清。
> ① storage/vector/graph 三 crate 物理拆出（`hologram-storage` / `hologram-vector` / `hologram-graph`，根 Cargo.toml 建 workspace，五成员）——
> graph 纯类型层（Node/Edge/Graph/ID 驻留器，零项目内依赖；node.rs 的
> code_extension_set 原吃 `crate::engine::GRAMMAR_LOADER`，改为 engine 启动时
> 经 `set_code_extensions` 注入，未注入时退化通用默认表）；vector 纯计算层
> （usearch/ort 依赖随迁）；storage 数据家层（依赖 graph+vector，**不依赖
> engine**——否则循环；GraphStore::reindex_vectors 的增量向量重建是历史接缝）。
> incremental.rs 迁 pipeline/（依赖 adapter 重解析，是分析行为不是数据持有）。
> engine 三门面再导出，内部几百处 `crate::storage::vector::` 引用零改动。
> ② vector 注册表已 L4-C7 按根键控，本次随 crate 化自然归位。
> 验收钉：壳层守卫测试 `shell_storage_vector_refs_use_dedicated_crates`
> （再经 engine 门面引 storage/vector 类型即红）；CI engine job 改 workspace
> 全量测试（用户拍板 2026-08-25）。engine 死依赖清除（bincode/rusqlite/
> ort/usearch 随职责迁移到新 crate）。



| 文件/目录 | 阶段 | 角色 |
|---|---|---|
| `src-tauri/src/`（新增 `app/` 或 `context.rs`） | L1-L4 | 应用层新生：DataContext + 业务归位 |
| `src-tauri/src/rpc.rs` | L1/L3 | 分派前解析工作区 → 传 DataContext；命令改调应用层 |
| `src-tauri/src/commands/*` | L1/L3 | 图/工作区/数据流命令薄壳化；业务迁 app/ |
| `src-tauri/src/confined_fs.rs`、`permissions/`、`sensitive.rs`、`audit.rs`、`os_sandbox.rs` | 不动 | 横切边界留在壳层（正当职责） |
| `engine/src/storage/`、`engine/src/vector/` | L2 | 存储/向量数据归属迁 DataContext；engine 纯化 |
| `engine/src/graph/merge.rs`、`engine/src/tools/` | L2/L4 | merge gate/hooks 数据源改 DataContext |
| `engine/src/lib.rs` | L2 | 导出面收窄为纯分析接口 |
| `engine/src/mcp.rs`、`routing.rs` | L1 | 请求入口携带上下文（MCP 面是否保留见 Q3） |
| `docs/ARCHITECTURE.md`、`AGENTS.md` | L5 | 分层图与基线更新 |

**明确不动**：`src-ui/src/composition/**`、`src-ui/src/agent/**` 装配层、`.github/workflows/ci.yml`、`graph-layout`/`gpu-layout`。前端 RPC 契约若变化（携带工作区上下文）走 `docs/agents/frontend-rpc-contract.md` 重新生成流程。

## 4.4 L3 施工进度（2026-08-25 凌晨）

- ✅ **C6 壳层瘦身**（本 commit）：`commands/{graph,hologram,engine_dispatch,workspace,dataflow}.rs` 五文件薄壳化——参数提取 + State 转换 + 横切（权限检查/changed_files 快取/窗口标题）留壳，业务实现迁入 `app/services/`（graph_service / hologram_service / dispatch_service / workspace_service / dataflow_service，零语义改写）。rpc.rs 分派面不变（仍调 commands 薄壳）。验收：cargo test 全绿（bin 420 + 集成 14）；commands/ 五文件均 <100 行薄壳，职责一句话=「通道参数 ↔ 应用层服务」。
- 顺修既有 flaky：`tests/hologram_dispatch_test.rs` 14 用例共享全局 ENGINE 的 clear+write 并行竞态（L2 时序变化后实测撞上，单跑恒绿）——进程内串行锁钉死（engine 侧 global_engine_test_guard 同款先例）。

## 4.5 L4 施工进度（2026-08-25 凌晨）

- ✅ **C7 并行语义落地**（本 commit）：
  - merge gate / hooks 数据源：L1-C3 决议链已实质完成（run_check 经 graph_service::resolve 吃实例 store；graph-updated 消费走已决议的 get_graph_page；preRunHook 是记忆召回不吃图数据）——本批落钉验证。
  - **vector 并行洞修复（L2 欠账项 2 清账）**：`CACHED_INDEX` 单槽静态 → **按根键控 HashMap**（旧形态双工作区互踩——A 的语义搜索用 B 的索引+错位 id 表）；`invalidate_cache`/`try_begin_build`/`end_build` 全部改按根/按索引路径（B 重建不误伤 A 热缓存；双工作区重建不再互相跳过）。
  - **双工作区并发 e2e**：`two_workspaces_parallel_analyze_and_check`——双线程同时全量分析 + 同时简报（run_full_check 吃实例图），各见其标、不见他标（无串写），简报产出可用。
  - **grep 守卫**：`engine_global_direct_calls_are_whitelisted`——壳层 engine 全局函数直连点白名单钉死（4 处 = 决议链 None 兜底臂），新增直连即红；白名单条目反查存在（防腐烂）。
  - 门禁：engine 677+27+1、src-tauri bin 421 + 集成 14 全绿。
- 剩余：真机双工作区并行验收（用户项，见 §7）。

## 4.6 L5 施工进度（2026-08-25 凌晨）

- ✅ **数据迁移结论：零迁移**。hologram.db/FTS5/快照/向量文件本就落 `<工作区>/.lantai/`（每工作区一份）——L1-L4 改变的是**所有权与访问路径**（全局单例隐式归属 → 按工作区实例显式归属 + 会话决议），数据物理位置从未变化。计划预想的「DataContext 独立数据目录」在 Q1（壳内模块）+ 最小迁移原则下无必要：数据跟着工作区走即与 session-unify 的 workspace 语义天然对齐。无旧路径兼容期需求。
- ✅ **文档更新**：ARCHITECTURE.md（分层图含应用层 + §2.1 运行时事实改写 + §5.1 Engine API + §10.2 + 基线数字）；AGENTS.md（目录结构 src-tauri 行 + 验证基线）；docs/plans/README.md（三线状态 + 真机验收欠账表）。
- **storage 物理 crate 化欠账**（L2 §4.3 已记录）：StoreHost 物理家在 engine crate、shell 直接 import——收窄 `pub mod storage` 导出的前置是 storage 独立 crate 化（机械搬家，语义已定）。**本窗口不动**：收益纯组织性、风险纯机械性，留给后续窗口或 L5b；不阻塞任何验收。
  **→ 已于 L5b（2026-08-25 同日）满偿**：见 §4.3 欠账满偿记录（三 crate 拆出 + workspace + 守卫测试 + CI 全量）。
- **全量门禁（2026-08-25 实测）**：engine 705（677+27+1）、src-tauri bin 421 + 集成 14、src-ui build + vitest + biome 0/0 全绿。
  **→ L5b 后新基线（2026-08-25 实测）**：workspace 五 crate——hologram-graph 44+doc 1、hologram-vector 16+1 ignored、hologram-storage 46、engine lib 571 + bin 27（单线程）、src-tauri bin 422（含新守卫）+ 集成 14（单线程）；总数对账守恒（lib 677 = 571 + 46 + 17 + 43）。⚠️ 已知环境坑：engine bin 与 src-tauri 集成测试**并行模式本机偶发 hang**（单线程必绿、逻辑零回归；全局 ENGINE + watcher 线程时序，同 L3 hologram_dispatch_test 先例）——跑这两处加 `-- --test-threads=1`。
- **真机验收四项（用户项）**：① 单工作区零回归（开卷/切卷/图查询/工具调用如常）；② 双工作区并行（两会话两项目同时图查询无错乱）；③ 跨工作区续开（首页点他工作区卷 → 图上下文正确）；④ Ungrouped 会话可用（零目录卷打开不报图错误）。

## 6. 拍板点（用户终审；**已全部拍板，2026-08-24**）




- **Q1 DataContext 的实现形态**：**✅ A（壳内模块）**——`src-tauri` 内新增 `app/` 层，同进程，每工作区一个实例。进程级隔离不拆（A 是可演进形态，未来需要时再拆，不冲突）。
- **Q2 merge gate/hooks 数据源改造范围**：**✅ A（只改消费路径）**——数据从 DataContext 拿，gate 逻辑不动。本计划拆分层，不重写算法。
- **Q3 engine 的 MCP 工具面去留**：**✅ A（保留在 engine）**——MCP 面是 engine 的对外契约（Cursor/Claude Code stdio 连接），视为分析器的协议适配层，不移动。
- **Q4 开工窗口**：**✅ A（等 session-unify 收尾再开工）**——两者都动存储层，串行推进，避免两线作战。

> 拍板记录：用户四问全拍 A（2026-08-24）。开工时按此执行，不再询问。

## 7. 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| engine | `cd engine && cargo test`（697 基线，存储测试迁移后重跑） |
| 壳 | `cd src-tauri && cargo test`（bin 389 + 集成 14 基线） |
| 前端 | `cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`（0/0） |
| RPC 契约 | 变化时 `npm run gen:rpc-contract` + 前端契约测试 |
| 桌面打包 | `cd src-tauri && cargo tauri build`（最终真机验证） |

**关键测试项**（钉入）：
- 单工作区行为零回归（全量基线）
- 双工作区并发：图查询/merge gate/hooks 无串写（新增 e2e）
- engine 纯化后：无存储模块残留（grep 守卫）
- 数据迁移：旧库内容完整可查

## 8. 风险与边界

- **三个侥幸现状**（本计划要拆掉的）：①串行侥幸（引擎调用多数排队）；②路径侥幸（调用带 path 参数区分）；③单机单进程侥幸。本计划完成后，正确性由架构保证而非侥幸。
- **数据安全**：L2/L5 涉及 `hologram.db`/向量/索引迁移，必须保留兼容期双读，禁止先删旧库。
- **engine 测试大改**：storage 相关测试随模块迁移，工作量不小，按阶段消化。
- **外部兼容**：MCP 工具面（Cursor/Claude Code stdio 连接）按 Q3 保持，避免破坏外部客户端。
- **与 session-unify 接缝**：DataContext 的工作区数据目录语义应与 session-unify 的 `workspace` 元数据/全局位对齐（同一定义，不各造一套路径）。
- **用户环境**：Windows、DevTools 屏蔽——推理靠读代码 + 测试，验证靠用户实测。

## 9. 沟通约定（用户偏好，接手者必读）

- 中文交流，**说人话**，用户反感黑话轰炸。
- 用户深度参与架构判断，会挑战设计——有疑点摆事实讲因果，不要替用户脑补。
- 用户断连频繁：**每阶段 commit**，长任务先写进度再干。
- 涉及拍板点（Q1-Q4）不确定时停下来问用户；用户要求彻底方案，**不要给"先顶着、以后再说"的过渡设计**。

## 10. 开工评估（Preflight）

| 检查项 | 状态 |
|---|---|
| 前置依赖 | ⚠️ 等 `session-unify` 收尾（Q4 拍板并行与否） |
| 耦合点定位 | ✅ 四顶帽子/四份活全部代码定位（§1） |
| 目标架构 | ✅ 四层定稿（§3） |
| 施工阶段 | ✅ L1-L5 每阶段独立可验证（§4） |
| 拍板点 | ✅ Q1-Q4 已全部拍板（2026-08-24，四问全 A，见 §6） |

**结论**：计划已立、拍板已毕，等待开工窗口（Q4 拍板 = session-unify 收尾后开工）。届时按 L1→L5 推到底。

## 11. 相关

- 前置：`session-unify-plan.md`（会话统一，存储层先行稳定）
- 上游：`docs/archive/workspace-ownership-root-cure-handoff.md`（工作区归属根治）
- 挂起：画布空间模型（独立议题，与本次分层正交）
- 现状总览：`docs/plans/README.md`（竣工按惯例归档）
