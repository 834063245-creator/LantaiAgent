# 分层重构（Layering Rework）— engine 纯化 + 壳层瘦身 + 应用层新生 施工计划

> 立项：2026-08-24 · 状态：**Proposed·Draft（计划已立，等待开工窗口）** · 版本：v1
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

## 5. 关键文件地图（改动面汇总）

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
