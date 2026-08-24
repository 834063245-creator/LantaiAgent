# 会话统一（Session Unify）— 全局会话池施工计划（交接版）

> 立项：2026-08-24 · 状态：**竣工（U1-U4 全部落地，待真机验收）** · 版本：v2（施工级，2026-08-24 升级；§6 四项拍板已落定）
>
> **竣工记录（2026-08-24）**：
> - U1 全局存储位 `504e9bc7`：workspace 字段 + 全局位统一落盘 + 双读 + 同号撞卷消解 + 发号扫两目录
> - U2 全局目录索引 `868e2512`：user_sessions_list 全局化（legacy_root 兼容源）+ 首页砍 lastProjectRoot + 跨区续开 switch(skipAnalysis) + 会话行显示工作区
> - U3 视图定型 `05d32fe8`：SpineRack 收窄 + 验收钉 ×3
> - U4 总目退役 `a6cce933`：_ledger.json/_active.json 全链拆除，恢复 = 扫描推导最近 3 卷（RESTORE_OPEN_MAX）
> - **待真机验收四项**：重启首页全量列表（169 旧卷经 legacy_root 可见）/ 跨工作区开卷内容正确 / 新建落全局位 / 重启摊开最近 3 卷
>
> **验收修正（2026-08-24 用户实机 + 本轮施工）**：
> - ✅ 首页全量列表（legacy_root 可见）——修复真 bug：SessionsHome 调 `get_last_project` 误用 typedJsonRpc，对裸路径二次 JSON.parse 抛错致 legacy_root 恒空；改 typedRpc 后 50 条可见。
> - ✅ **重启不自动摊开（Q-B，用户拍板）**：autoRestoreLastSession 重写为只发号对账；loadSessionFromDisk 句柄惰性化（无 Key 也摊开内容层）+ readVolumeData 承崩溃加速契约；首页/书脊新建守卫去活跃会话依赖；死代码（restoreOpenSet/ensureBaselineSession/restoredLabel）删除。门禁全绿：vitest 1690 / build / biome 0。用户实机验证通过。
> - ✅ 会话统一整线竣工（2026-08-24 晚）：U1-U4 + 验收修正全部落地，真机验收通过。
> 触发：用户实机反馈「会话管理复杂、侧边栏无法统管、首页/恢复乱」→ 产品定调「会话全局化，工作区降级为元数据」。
> 本文档自包含：接手会话读完本文 + `AGENTS.md` + `CONVENTIONS.md` + `INVARIANTS.md` 即可开工，无需重读会话历史。
> 前置事实源：`src-ui/src/ui/chat-session.ts`、`src-ui/src/state/session-ledger.ts`、`src-ui/src/app/SessionsHome.tsx`、`src-ui/src/app/panels/SpineRack.tsx`、`src-tauri/src/commands/filesystem.rs`、`src-ui/src/shell/rows/cold-start.ts`、`src-ui/src/shell/rows/persistence.ts`。
> 上游已验收：`docs/archive/workspace-ownership-root-cure-handoff.md`（工作区归属根治 Phase A-E + boot 序洞真根因修复，用户实机验收通过，2026-08-24）。

## 0. 一句话

**会话是自己的全局公民**：一个实体一个稳定身份，全局目录唯一索引（跨工作区统管），工作区降级为会话快照里的 `workspace` 元数据；画布里铺的是卡片不是会话，会话收敛成一张对话卡片。

## 1. 现状快照（2026-08-24 实机实证）

- **已 commit**：工作区归属根治 Phase A-E（`afe93298`→`ae3eaad5`）+ boot 序洞真根因修复（`fb8d57a0`，含 `aebfda8d`/`fce7d38e` 守护）。用户**实机验收通过**：新 EXE 下装配链通、能正常发消息、装配错误消失。**此前复现的 `ToolRegistry: cannot alias unknown tool "read_file_content"` 确认是旧 EXE 未含 `fb8d57a0`，非代码残留。**
- **用户实机症状（本次实测）**：重启后**案卷栏/首页什么都没有**；会话内容是否正确用户已无法确认；零目录/项目之分用户无感知（正是本次要解决的问题）。
- **磁盘实况（硬证据）**：
  - 项目级 `D:\HoloGramHG\.lantai\sessions\`：**169 卷**（id 1..230，含空档）；`_ledger.json` 存在：open=1（id 230）、activeId=230、nextSessionId=233；`_active.json`：lastId=230、nextId=233。
  - 用户级 `C:\Users\Administrator\.lantai\sessions\`：**仅 1 卷**（`1.json`）。
  - `D:\HoloGramHG\.last_project` = `D:\HoloGramHG`（指针本身正确）。
- **结论**：会话数据完整在盘；首页空 = 读取指针断（见 §2.2），非数据丢失。

## 2. 根因诊断（代码定位 + 实锤）

### 2.1 乱根：会话被工作区「物理绑架」（三处，均有代码定位）

| # | 绑架点 | 定位 | 后果 |
|---|---|---|---|
| P1 | `sessionsDir(projectPath)` 按工作区落盘：绑项目进 `<项目>/.lantai/sessions/`，没绑进 `~/.lantai/sessions/` | `ui/chat-session.ts` | 存储物理分家，全局列表无从谈起 |
| P2 | `SessionsHome` 双列表合并（项目 `listSavedSessions(root)` + 零目录 `user_sessions_list`），靠 `lastProjectRoot()` 单点决定「哪来的会话」 | `app/SessionsHome.tsx` `lastProjectRoot`/`useEffect` | 指针一断，项目会话整列隐形 |
| P3 | `_ledger.json` 总目按项目隔离（`ledgerFile(projectPath)`），开合册/发号随工作区记账 | `state/session-ledger.ts` | 连「摊开哪些」都按工作区隔离 |

### 2.2 首页空的实锤机制（2026-08-24 排查链）

```
用户 169 卷在 D:\HoloGramHG\.lantai\sessions
  → 首页项目列表 = listSavedSessions(lastProjectRoot())
  → lastProjectRoot() 图引擎开时读 load_graph_json 的 meta.source_root
     （src-tauri/src/commands/graph.rs:7 load_graph_json；冷启动 handle 未绑定
       时走 .last_project，缓存未就绪/无缓存 → Err）
  → Err/无 source_root → 返回 null → 项目列表扫 0 卷
  → 用户列表只扫 ~/.lantai/sessions（仅 1 卷）
  → 首页空
```

**一句话**：会话可见性被绑在「冷启动图 meta 指针」这个单点上，指针断则全空。这正是 P2 的运行时形态。

### 2.3 概念层乱根

- 会话 ≠ 画布最小单元。画布最小单元是**卡片**；会话收敛成一张「对话卡片」。此区分是本次解耦的心智支柱（§3.4）。
- 状态只在两处：**目录里（存档）** 与 **视图里（运行中）**，无第三种。

## 3. 设计定稿

### 3.1 会话唯一身份

一次会话 = 一条记录，一个稳定 id（数字，沿用现有卷号体系），全局唯一，全生命周期不撞号。所有操作只用这一个 id 指代。

### 3.2 两个容器

| 容器 | 态 | 作用域 | 职责 | 载体 |
|---|---|---|---|---|
| 全局目录 | 全量态 | 跨工作区 | 所有会话的存档与检索，唯一索引 | `~/.lantai/sessions/*.json`（现 `user_sessions_root()`，`HOLOGRAM_SESSIONS_ROOT` 可覆盖） |
| 工作区视图 | 现场态 | 工作区内（同画布同工作区） | 当前开的会话，收敛成卡片 | 画布层（SpineRack 语义退役，见 U3） |

会话在目录里 = 存档；在视图里 = 运行中。

### 3.3 存储：全局统一位 + workspace 元数据

- 所有会话统一写全局位 `~/.lantai/sessions/*.json`（`user_sessions_root()` 真源不变）。
- 卷文件快照新增 `workspace` 字段：绑定的工作区目录（正斜杠归一）或 `null`。
- 项目内 `<项目>/.lantai/sessions/` 降级为**只读兼容源**，不再写新卷。
- `user_sessions_list`（Rust）从「零目录会话列表」进化为「全局会话列表」（返回含 workspace；`deleted` 过滤、4MB 护栏、50 条上限保留）。

### 3.4 会话与画布解耦

- 画布最小单元 = 卡片；会话进入视图时收敛成一张「对话卡片」。
- 同一画布 = 同一工作区（空间是工作区级）；一个工作区视图里多张卡片 = 同一工作区的多个会话 + 其他内容卡。
- 卡片排布/组织规则 = **画布空间模型，独立议题（挂起，本计划不做）**。

### 3.5 兼容迁移（双读，不硬改）

- 打开会话：全局位优先 → 读不到回退项目内 `.lantai/sessions/`（兼容期双读）。
- 撞号消解：不同工作区的同号卷用 `workspace` 字段 + 目录区分，**不全局重号**，避免迁移期覆盖。
- 项目内历史会话随「打开即吸收」自然迁入全局位；旧项目目录待吸收干净后只读退役。
- 毒化容忍沿用：坏 JSON / >4MB / 非数字文件名跳过（INVARIANTS #11 读取纪律不变）。

### 3.6 六操作映射（语义不变，落点统一到全局目录）

| 操作 | 语义 | 现有落点（改后） |
|---|---|---|
| 创建 | 新建一条目录记录（可带 workspace 或 null） | `chat-session.createNewSession` |
| 打开 | 目录挑一条 → 进工作区视图 → 一张对话卡片 | `loadSessionFromDisk`（全局位+workspace 恢复） |
| 切换 | 视图内换当前卡片 | 现有 `switchSession` |
| 关闭 | 视图退回目录，内容落盘 | 落盘两动词（沿用 session-ledger `recordOpenSetChange`/`saveSessionById`） |
| 删除 | 目录清除（`deleted` 标记） | `deleteSessionFile` |
| 查找 | 目录按工作区/时间/模式过滤 | 全局列表筛选（前端） |

## 4. 施工阶段（U1-U4，按依赖序，每阶段独立可验证可 commit）

> 编号 U 段（Unify/统一）。每阶段完成即 commit（用户断连频繁，落盘优先）。不动 composition/agent 装配层（工作区线已验收，勿碰）。

### U1 全局存储位（地基，与拍板点无关，可先行）

**目标**：新写入统一落全局位；卷文件带 `workspace` 字段；读走双读（全局位优先 + 项目目录回退）。

改动点清单（文件: 函数/位置）：
- `ui/chat-session.ts` `SessionSnapshotData`：加 `workspace?: string | null`。
- `ui/chat-session.ts` `writeSessionSnapshot`：data 写入前补 `workspace: projectPath || null`；`sessionFile(projectPath, id)` → 改为 `globalSessionFile(id)`（`sessionsDir` 语义收敛：非空 projectPath 也不再分片，统一全局位；保留 `projectPath=''` 兼容）。
- `ui/chat-session.ts` `readVolumeData` / `readSessionJSON` / `loadSessionFromDisk`：全局位优先，`catch` 回退 `<projectPath>/.lantai/sessions/{id}.json`（双读，仅读不写）。
- `ui/chat-session.ts` `saveActiveSession` / `saveSessionById` / `closeSession` 内 `writeSessionSnapshot` 调用：projectPath 透传保留（写 workspace 字段用），但落盘目标改全局位。
- `ui/chat-session.ts` `scanMaxSessionId` / `sessionFile` / `trackerFile`：路径源改全局位（tracker 迁移见 U4）。
- `state/session-ledger.ts` `ledgerFile`：**按 Q1 拍板**（见 §6）——B 方案则本阶段不改、U4 退役；A 方案则改全局 `_ledger.json`。

**验收判据**：
- 新建会话（`createNewSession`）后，卷文件出现在全局位 `~/.lantai/sessions/{id}.json`，且 JSON 含 `workspace` 字段。
- 绑项目会话落盘后，项目内目录**不再出现新卷文件**（旧卷保留不动）。
- 打开全局位旧卷与项目目录旧卷均成功（双读生效）。
- 既有测试不红（`chat-session.test.ts`/`session-ledger.test.ts` 按新路径语义微调）。

### U2 全局目录索引（拔 P2 病根，首页从空变全）

**目标**：首页/侧边栏单列表统管；`lastProjectRoot` 依赖移除；冷启动恢复走全局位。

改动点清单：
- `src-tauri/src/commands/filesystem.rs` `user_sessions_list`：进化为全局列表——扫描全局位，条目加 `workspace` 字段（从卷 JSON 读）；`UserSessionEntry` 加 `workspace: Option<String>`。
- `src-tauri/src/rpc.rs` / `src-ui/src/rpc-contract.ts`：`user_sessions_list` 返回形状同步（含 workspace）。
- `app/SessionsHome.tsx`：砍 `lastProjectRoot()` + 项目/用户双列表合并，改为**单一全局列表**（`user_sessions_list`）；`listSavedSessions` 调用退役（或降级为 U4 清理）；`onResumeProject`/`onResumeUser` 收敛为 `onResume(entry)` → `loadSessionFromDisk(entry.workspace ?? '', entry.id)`。
- `ui/chat-session.ts` `listSavedSessions`：保留供测试或退役（U4 清理），首页不再消费。
- `shell/rows/cold-start.ts` / `persistence.ts`：冷启动恢复目标路径统一走全局位（`autoRestoreLastSession('')` 语义即全局位，确认 `projectPath=''` 路径全覆盖）。

**验收判据**：
- 重启 → 首页列出**全部**会话（含项目 169 卷 + 用户级卷），不再依赖图 meta 指针。
- 会话行显示所属工作区（workspace 字段，可空）。
- 打开任意卷正常恢复内容（`loadSessionFromDisk(workspace, id)`）。
- Rust 侧 `user_sessions_list` 单测更新（`filesystem.rs` 测试段）并 `cargo test` 绿。

### U3 运行时视图重构（SpineRack 语义退役）

**目标**：全局目录打开进工作区视图；会话以卡片形式进画布；多卷并存/切换语义归画布层（本阶段只定边界，画布空间模型不做）。

改动点清单：
- `app/panels/SpineRack.tsx`：**按 Q3 拍板**——最小方案：SpineRack 保留为「当前工作区视图内的开卷列表」（职责收窄），全局目录为唯一入口；激进方案：SpineRack 退役，开卷列表并入全局侧边栏（本阶段只做职责收窄，激进方案留给画布支）。
- `app/SessionsHome.tsx`：新建/续开入口接全局列表（U2 完成后的自然形态）。
- 打开会话的恢复深度按 **Q2 拍板**（§6）。

**验收判据**：
- 从全局列表打开卷 → 进入视图 → 显示对话内容；多卷并存语义不破。
- 关闭卷 → 回落盘（写全局位）→ 回目录可见。
- C8 交互（换卷/改名/合卷自动存）不回归。

### U4 清理与验证（收尾）

**目标**：按 Q1 处理总目；旧项目目录只读退役；localStorage 决策；全量门禁。

改动点清单：
- 总目 `_ledger.json`：**按 Q1**——B 退役：移除 `ledgerFile` 写入，摊开集重启时由全局位扫描推导（`ensureBaselineSession` 语义吸收）；A 全局化：`ledgerFile` 改全局位单份。
- `_active.json` / `trackerFile`：退役或仅作迁移源（session-ledger 既有语义）。
- 旧项目目录：确认吸收后不再写、不再读（可保留不动，等用户清理）。
- localStorage 双层备份：保留（崩溃加速器，本计划不砍）。
- 全量门禁（§7）。

**验收判据**：
- `cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`（0/0）
- `cd src-tauri && cargo test`（Rust 侧改动段）
- 真机三项：重启首页全量列表 / 跨工作区打开卷内容正确 / 新建落全局位

## 5. 关键文件地图（改动面汇总）

| 文件 | 阶段 | 角色 |
|---|---|---|
| `src-ui/src/ui/chat-session.ts` ⚠️**冻结文件** | U1/U2 | 存储路由收敛、workspace 字段、双读、列表源 |
| `src-ui/src/state/session-ledger.ts` | U1/U4 | 总目按 Q1 处置 |
| `src-ui/src/app/SessionsHome.tsx` | U2/U3 | 单列表统管、lastProjectRoot 移除 |
| `src-ui/src/app/panels/SpineRack.tsx` | U3 | 职责收窄（Q3） |
| `src-tauri/src/commands/filesystem.rs` | U2 | `user_sessions_list` 全局化 |
| `src-tauri/src/rpc.rs` + `src-ui/src/rpc-contract.ts` | U2 | RPC 形状同步 |
| `src-ui/src/shell/rows/cold-start.ts` / `persistence.ts` | U2 | 冷启动恢复路径 |

**明确不动**：`src/composition/**`、`src/agent/**` 装配层（工作区线已验收）、`src-ui/src/workspace.ts`、engine/、`.github/workflows/ci.yml`、`graph-layout`/`gpu-layout`。

## 6. 拍板决策点（用户 2026-08-24 文字终审，全部落定）

- **Q1 总目 `_ledger.json` 去留：拍 B — 退役**。摊开集重启时扫全局位现场推导（`ensureBaselineSession` 语义吸收），总目不再记账。
- **Q2 打开会话恢复深度：拍 A+B — 轻恢复为主，工作区上下文懒加载**。打开历史卷只恢复对话内容（读卷文件，不碰图）；第一次真正需要工作区上下文的时刻（装配 Agent / graph 工具调用）再懒切换工作区——复用现成 `switchWorkspace(workspace, {skipAnalysis: true})`（内部即 `engine_init` 加载 SQLite 缓存，秒级；冷启动恢复走的已是这条验证过的路径）。
  - 实施细则（引擎生命周期澄清后定稿）：engine 是进程内常驻单例（`LazyLock<RwLock<Option<Engine>>>`，链接进壳，全程在场），`engine_init(root)` 廉价（同根复用/异根切换，只加载缓存不分析）——「图工具不可用」不成立，缺的只是「指着谁」。懒加载补的就是这一指。
  - 项目从未分析过（无缓存）→ 不是引擎问题，是没数据：走「先分析」并提示清楚；唯一真无图情形 = 用户手动关闭图谱引擎开关（设置，非故障）。
- **Q3 SpineRack 职责：拍最小方案**。SpineRack 收窄为「当前工作区视图内开卷列表」，全局目录为唯一总入口；激进方案（并入全局侧边栏）留给画布空间模型支。
- **Q4 全局位位置：拍沿用 `~/.lantai/sessions`**（现状，零迁移）。

## 7. 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| 前端逻辑 | `cd src-ui && npx vitest run`（先清 `NODE_ENV=production`） |
| 前端构建 | `cd src-ui && npm run build` |
| 前端格式 | `cd src-ui && npx biome ci .`（0/0；改动文件 `npx biome check --write`） |
| Rust | `cd src-tauri && cargo test`（filesystem/rpc 改动段） |
| 桌面打包 | `cd src-tauri && cargo tauri build`（最终真机验证用） |

**关键测试项**（钉入 vitest）：
- 全会话落全局位（含绑工作区/零目录）；卷 JSON 含 workspace
- 全局列表含跨工作区会话；无 `lastProjectRoot` 依赖（首页不读图 meta）
- 双读回退：全局位缺 → 项目目录旧卷可打开
- 同号跨工作区不互覆（workspace 消解，不重号）
- 冷启动恢复工作集语义沿用 session-ledger 判据
- 纸面 `paper` 字段随卷恢复不受影响

**⚠️ 冻结文件纪律**：`ui/chat-session.ts` 改动前逐条核对文件内 `⚠️ INVARIANT` 注释；保住 INVARIANTS #2/#3（streaming 写 session 缓存、streamingAssistantId 不清空）；不动 streaming 语义本身。

## 8. 风险与边界

- `chat-session.ts` 是冻结文件，U1 改动是其核心状态机语义的架构级需求（用户已授权本计划），但必须逐条核对 INVARIANT，分批小步 commit。
- 迁移期 id 冲突：**不全局重号**，workspace + 双读消解；旧卷只读不写，杜绝覆盖。
- 首页列表性能：全局位目录扫描 + 50 条上限（沿用 `user_sessions_list` 现状）；卷文件 >4MB 跳过（毒化容忍）。
- 与画布空间模型的边界：本计划只定「会话以卡片形式进视图」，卡片排布/组织规则不做（挂起）。
- 用户环境：Windows、DevTools 屏蔽（拿不到 console）——推理靠读代码 + 测试，验证靠用户实测。

## 9. 沟通约定（用户偏好，接手者必读）

- 中文交流，**说人话**，用户反感黑话轰炸。
- 用户深度参与架构判断，会挑战设计——有疑点摆事实讲因果，不要替用户脑补。
- 用户断连频繁：**每阶段 commit**，长任务先写进度再干。
- 涉及拍板点（Q1-Q4）不确定时，停下来问用户，不擅自选激进方案。

## 10. 开工评估（Preflight 结论）

| 检查项 | 状态 |
|---|---|
| 前置装配链（工作区归属根治） | ✅ 用户实机验收通过（新 EXE 能发消息，装配错误消失） |
| 会话数据完整性 | ✅ 169 卷在盘、总目/跟踪文件一致（实机取证） |
| 病根定位 | ✅ 三处代码定位 + 首页空实锤机制（§2.2） |
| 测试基线 | ✅ vitest 79 项关键文件全绿（会话/冷启动/发号/无 Key） |
| 待拍板点 | ⚠️ Q1/Q2 建议开工前拍（或按 §6 建议默认执行）；Q3 最小方案、Q4 沿用可默认 |

**结论：可以开工。** 建议顺序：拍 Q1/Q2（或采纳建议默认）→ U1（地基，与拍板无关）→ U2（拔 P2 病根，用户最痛）→ U3 → U4。每阶段独立 commit、独立验收。

## 11. 相关

- 前置：`docs/archive/workspace-ownership-root-cure-handoff.md`（工作区归属根治，上游已验收）
- 上游：`docs/archive/session-ledger-plan.md`（案卷总目，本计划继承其身份/发号机制）
- 挂起：画布空间模型（独立议题，会话以卡片进视图后另行设计）
- 现状总览：`docs/plans/README.md`（竣工按惯例归档）
