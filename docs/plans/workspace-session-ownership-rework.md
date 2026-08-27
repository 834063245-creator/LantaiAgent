# 工作区会话归属重构 — 会话物理归属工作区（Workspace-Owned Sessions）

> 立项：2026-08-27 · 状态：**代码全量落地（P1-P4 四 commit：40a43875 → 7b1d5a3e → cc0df8c0 → 147f9373）；剩 P5 实机验收（用户实跑）** · 版本：v3
> 一句话：把「全局会话池 + workspace 元数据标签」反转为「会话物理归属工作区」——
> 每个工作区在 `{workspace}/.lantai/sessions/` 里管自己的会话，切换工作区 = 切换会话集，
> 从**结构上**消灭三类病根：字符串标签串味 / 跨工作区撞号覆写 / 焦点投影决议错位。
>
> **本计划推翻 `session-unify-plan.md`（2026-08-24，「会话全局化，工作区降级为元数据」）**
> 的方向。旧计划的诊断仍有效（当时的双存储位/首页指针单点是真病灶），但它的解法
> （全局池 + workspace 字段）在实机上炸出新病灶（撞号覆写 / 焦点串味）。本计划是
> **带两代教训的反转**，不是退回旧模型。
>
> **已拍板决策（2026-08-27 用户）**：
> - D1 **历史全局卷直接归档**（`sessions.bak-20260827`，代码永不回读，不迁移）。
> - D2 **砍掉跨工作区续开**（用户不认识该功能——它是全局池模型的产物，非需求）。
> - D3 **案卷编号 = 工作区内编号**（切区可能重号，区内唯一）。
> - D4 **在途未提交 diff 作废丢弃**（不 commit；可保留件被新模型吸收）。
> - D5（计划假设，用户可推翻）：占位工作区 / 零目录会话彻底退役。

## 0. 现状快照（2026-08-27 实机实证 + 代码定位）

- 会话统一 U1-U4（2026-08-25 归零重建）后：**所有工作区**的会话扁平躺在
  `~/.lantai/sessions/{id}.json`（全局单一命名空间），每个卷文件里塞一个 `workspace`
  字符串字段标明归属。
- 用户实机症状（2026-08-27）：**一整个大乱套，无法归因**。工作区里留着一批未提交的
  补丁（`clear_focus` / `saveAllSessions` / 全局扫最大号发号 / `session_detach` /
  拆 NDJSON 孤儿），每个都是在一个病灶上打补丁——补丁自身就是"架构稀碎"的证据。
- 实机炸因（工作区 diff 注释自述）：
  - `HoloGramHG 1-4 覆写 openhanako 同号卷` —— 跨工作区发号撞号，后写覆写他区卷。
  - `openhanako 会话 5/8 丢失` —— 切走工作区时在途 autosave 被 epoch 丢弃，全局 JSON 永不落盘。
- 历史对照：`session-unify-plan.md` 里旧模型的病灶（项目内/用户级双存储位、首页靠
  `lastProjectRoot` 指针单点、ledger 按项目隔离）**本计划必须避免重蹈**。

## 1. 诊断（每条带代码定位 + 实锤）

### 病灶 1：归属是「字符串标签」不是「结构」
- `src-ui/src/ui/chat-session.ts:595-597` `normWs()` 路径归一，`readVolumeJSON`
  （`:615-621`）靠字符串比对判断"这个卷属不属于当前工作区"。
- Rust 侧 `src-tauri/src/app/mod.rs:140-158` `read_volume_workspace` 读卷内
  `workspace` 字段当归属事实；`:239-245` attach 用 canonical_root 校验目录存在。
- **后果**：大小写差异、尾斜杠、目录改名、字段缺失/坏值——任一不一致，会话就
  "跑到别处"或"消失"。数据归属不是物理位置，是**一份随时可能对不上的元数据**。

### 病灶 2：全局命名空间 + 目录扫描发号 = 跨工作区撞号覆写
- `src-ui/src/ui/chat-session.ts:626-644` `scanMaxSessionId` 扫全局目录；
  `autoRestoreLastSession`（`:806-820`）用全局最大号当下限。
- **实锤**：2026-08-27 `HoloGramHG 1-4 覆写 openhanako 同号卷`——两个工作区
  mint 出同号卷，后写覆写他区卷文件。当前补丁（扫全局 max）本质是全局竞态：
  多实例 / 扫描窗口内新建 / 目录缺失都会复炸。

### 病灶 3：焦点投影 = 决议链回退的串味源
- Rust 单全局焦点槽：`src-tauri/src/app/mod.rs:290-300` `focus_session` /
  `focused_context`；决议链 `resolve_engine`（`:379-400`）= `显式 root → 会话 →
  焦点 → 单槽回退`，外加 `sessions` 会话绑定表（`:168-172`）。
- 前端单例投影：`src-ui/src/state/session-scope.ts` 的 `currentSessionId`；
  `src-ui/src/agent/tool.ts:187-195` `agentInvoke` 把它注入 `_session_id`。
- **后果**：无 `_session_id` 的引擎调用沿**旧工作区的焦点会话**解析到旧引擎——
  图查询/时间线/工具作用于错误项目。工作区里 in-flight 补丁 `clear_focus` +
  `resetSessionState` 清 `currentSessionId`，正是在堵这个洞（补丁 = 病灶证据）。

### 病灶 4：持久化路径三代叠加（架构稀碎）
- NDJSON 增量 `session_append`（只写不读孤儿，in-flight diff 正在拆）；
- 全局 JSON 快照（现唯一路径）；
- 用户级目录兜底 `_userSessionsDir ?? '/.lantai/sessions'`（`:566-602`）；
- localStorage 备份（已拆）。
- 每代都是"在当前模型上叠一层"，没有一次是"删干净再换"。

### 病灶 5：存储位与视图投影双重锚点靠 RPC 时序对账
- 前端 `Workspace.path`（`shellRefs.workspace`）+ Rust `WorkspaceState` + 焦点槽 +
  会话绑定，四处状态靠 `workspace_activate/deactivate` + `session_attach/focus/detach`
  的调用时序维持同步；`switchWorkspace` 复用同一 ChatCore/panelId，
  `resetSessionState`（`chat-session.ts:130-160`）靠人肉清理清单——任何一环漏清就串味。

### 病灶 6（历史教训，防三度踩坑）：旧 per-workspace 模型为什么也烂
- `session-unify-plan.md` §2 诊断：项目内 `.lantai/sessions/` + 用户级目录**双存储位**、
  首页靠 `lastProjectRoot → 图 meta` 指针单点（指针断全空）、ledger 按项目隔离。
- **本计划必须避免**：单一存储位、首页以工作区注册表为真源（无指针推导）、
  无 ledger 依赖。

## 2. 目标模型（设计定稿）

### 2.1 归属与存储：工作区 = 容器
- 会话唯一存储位 = **`{workspace}/.lantai/sessions/{id}.json`**（与 `canvas.json`
  同级——画布已经是工作区级，会话归位后全工作区数据一个家）。
- 工作区 = 注册表（`~/.lantai/workspaces.json`，**已有**）+ 目录双重实体；
  零目录会话已退役（Stage-5 拍板 a）→ **不存在第二存储位**。
- 卷快照里的 `workspace` 字段**删除**——存储位置即事实，无需标签匹配。
- 首页 = 工作区清单（注册表真源）→ 每区会话列表（扫该区 `.lantai/sessions/`）。
- **无全局会话列表**（`user_sessions_list` 退役）——会话只在其所属工作区内可见。

### 2.2 发号：每工作区独立
- `nextSessionId` 从**本工作区** `.lantai/sessions/` 扫描（或落一个 `_next.json` 小账），
  跨工作区不可能撞号（不同目录，天然隔离）。
- 案卷编号（"案卷 N"）语义 = 工作区内编号（D3 已拍板）；id 只在本区内有意义。

### 2.3 归属判定（Rust）：结构即事实，会话不跨区
- **会话只在所属工作区内打开**（D2 砍掉跨区续开）→ 任何可打开的会话都属于
  **活动工作区**（单槽 `WorkspaceState`）。
- 因此 Rust 侧**不再需要** `sessions` 绑定表、`focus` 槽、`session_attach /
  session_focus / session_detach` 三命令。上下文生命周期 = 活动工作区（ensure 于
  activate，GC 于 deactivate），会话只是该工作区内的文件 + 前端 store 状态。

### 2.4 决议链：工作区锚，两条臂
- `resolve_engine = 显式 root（个别命令）→ 活动工作区（WorkspaceState）→ None`。
- `_session_id` 与 `session-scope` 单例投影**退役**——引擎路由不再看会话 id；
  引擎上下文只看"当前活动工作区"。
- 无活动工作区（首页/未绑定）= 无引擎上下文（引擎开关关闭/未绑定时的既有降级语义不变）。

### 2.5 保留与退役清单
保留：`workspaces.json` 注册表、`WorkspaceDataContext` 每区引擎实例 + `contexts` 表
（切回秒开）+ GC、画布工作区级存储、agent 侧 `.lantai/agents/{id}/session.ndjson`
（另一条链，不动）。
退役：`workspace` 字段、`normWs` 匹配、`scanMaxSessionId` 全局扫、焦点槽、`sessions`
绑定表、`session_attach/detach/focus` RPC、`session-scope` 单例投影、`_session_id`
路由、NDJSON `session_append` 残留、`_userSessionsDir` 兜底、`user_sessions_list`
全局列表、`bindZeroDirSessions`/`archiveZeroDirSessions`、`Workspace.placeholder()`。

## 3. 决策点（已拍板 + 待确认）

| # | 项 | 决定 |
|---|---|---|
| D1 | 历史全局卷 | ✅ **整包归档** `sessions.bak-20260827`，代码永不回读 |
| D2 | 跨工作区续开 | ✅ **砍掉**（用户不认识该功能——全局池产物；决议链大幅简化） |
| D3 | 案卷编号语义 | ✅ **工作区内编号**（切区重号、区内唯一） |
| D4 | 在途未提交 diff | ✅ **作废丢弃**（不 commit；session_detach/NDJSON 拆除被新模型吸收） |
| D5 | 占位工作区/零目录退役 | 计划假设为退役（Stage-5 已拍板零目录退役的延续），可推翻 |

## 4. 施工清单（分阶段，每阶段门禁全绿才进下一阶段）

### Phase 1 — Rust 存储/决议重构 ✅（commit 40a43875）
- `src-tauri/src/app/mod.rs`：删 `sessions` 绑定表、`focus` 槽、`attach_session` /
  `detach_session` / `focus_session` / `focused_context` / `clear_focus`；
  `resolve_engine` 改 §2.4 两条臂；`gc_if_unused` 简化（无绑定判定，看保留集/活动）。
- `src-tauri/src/app/commands.rs`：删 `session_attach/detach/focus`。
- `src-tauri/src/app/services/workspace_service.rs`：deactivate 去掉 `clear_focus`，
  GC 逻辑随 `gc_if_unused` 简化。
- `src-tauri/src/commands/workspace.rs`：`registry::remove` 改删 `{ws}/.lantai/sessions/`。
- `src-tauri/src/commands/filesystem.rs`：新增 `workspace_sessions_root(ws)`。
- 引擎命令全链删 `_session_id` 路由（rpc.rs / graph.rs / hologram.rs / engine_dispatch.rs）。
- 测试：删 7 个 attach/focus 用例，新增两条臂决议 + 简化 GC 用例；cargo test 423+14 全绿。
- ⚠ 执行注记：`user_sessions_list` / `get_user_sessions_dir` 的退役**推迟到 P3**
  （前端 SessionHome 与 rust registry::list 仍消费，先动会炸前端——见 P3）。

### Phase 2 — 前端存储/发号/恢复重构 ✅（代码完成，待 commit）
- `src-ui/src/ui/chat-session.ts`：存储位改 `{projectPath}/.lantai/sessions/`（唯一）；
  删 `workspace` 字段写入与 `normWs` 归属比对；发号 = 本区扫描；删 `session_attach/
  focus/detach` 调用与 `sessionScopeStore`；删 NDJSON `appendLastMessage`；
  删 `bindZeroDirSessions`/`archiveZeroDirSessions`（零目录退役）。
- `src-ui/src/agent/tool.ts`：删 `_session_id` 注入；`state/session-scope.ts` 删除。
- `src-ui/src/workspace.ts`：`placeholder()` 退役（低层构造转 public 作测试缝）；
  `shell/rows/workspace.ts` 删 `setupPlaceholderAgent`；`cold-start.ts` 无恢复信号
  落点首页（不装配 Agent）；`persistence.ts` 删 appendLastMessage。
- `src-ui/src/app/SessionsHome.tsx`：删零目录桶（bind/archive 动作随 P2 退役）；
  `rpc-contract.ts` 删 session_attach/detach/focus + session_append + `_session_id`。
- 测试：重写 agent-exec / workspace-flip-b2 / no-key-cold-start / workspace-fiber /
  session-unify-u3 / session-repro-ghost-volume / audit-fixes #10 / chat-session U1 段
  ——全部改为工作区会话根语义；vitest + build + biome + convergence 全绿。

### Phase 3 — 首页/工作区管理 UI ✅（commit cc0df8c0）
- Rust `registry::list`：每个注册工作区的会话计数/最近时间扫自己的会话根
  （`workspace_sessions_root(&path)`）；「全局位按 workspace 字段推导」回退臂拆除。
- `user_sessions_list` / `get_user_sessions_dir` / `user_sessions_root`
  （含 HOLOGRAM_SESSIONS_ROOT env）退役——Rust 命令 + rpc.rs 分派与 shape 表 +
  前端 RpcContract 同步清除；SessionsHome 数据源注释更新；文档重生成（156 methods）。
- 测试：filesystem.rs 旧列表测试组全删（测的是退役函数）、registry::list 测试改写
  为按工作区会话根计数（临时目录真实落盘）；cargo test 418+14+1 全绿。

### Phase 4 — 清理（拆干净）
- ✅ Rust 残留：rpc.rs `session_append`（chat NDJSON 孤儿）分派臂删除
  （`agent_session_append` 保留——agent 侧 session-log.ndjson 是另一条活链）。
- ✅ D1 数据侧：本机旧全局位已归档在先（`~/.lantai/sessions.bak-20260825` 与
  `.bak-20260827` 都在，全局位本体已不存在——无需再动数据）。
- ✅ 文档：session-unify-plan.md 归档到 docs/archive/ 并加「已被推翻」横幅；
  docs/plans/README.md 三线表改指本计划、分层真机验收 ③④ 标注作废。
- 前端 `normWs`（chat-session 版）/ workspace 字段 / 全局扫：P2 已清
  （canvas-store 自有的 normWs 是画布路径归一，非归属匹配——保留）。

### Phase 5 — 实机验收
- 单工作区零回归（开卷/切卷/图查询/工具调用如常）。
- 双工作区并行：两会话两项目同时跑图查询无错乱（Rust 并发守卫 e2e）。
- **切区后会话列表完全隔离**（A 区卷绝不出现在 B 区）——主验收判据。
- 重启恢复：摊开集/画布按工作区归位。
- 新建 → 落盘 → 重启 → 找得到（案卷 N 按区编号）。
- ⚠ 分层重构验收项 ③（跨工作区续开）随 D2 **作废**，从 README 待验表移除。

## 5. 验证门禁（每阶段，不过不进下一阶段）

| 层 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`（0/0） |
| Agent 运行时/组合层 | `cd src-ui && npm run verify:convergence`（standard 零漂移；先跑基线确认在途 diff 不破坏） |
| 壳 | `cd src-tauri && cargo check` + `cargo test`（bin + 集成，`-- --test-threads=1`） |
| 引擎/存储/图 | 涉及才跑 `cargo test`（本次主要动壳，引擎面不预期变化） |
| 行为变更 | 实机可感知变化写进 commit message（铁律 4） |

> 动刀前（Phase 1 首个 commit 前）先跑一遍受影响面基线测试（vitest + cargo test），
> 绿/红都要记录——铁律 1。基线里的在途 diff 状态先定（D4 已拍板作废）。

## 6. 风险与回退

- **风险 1：历史全局卷归档后旧会话不再可见**——D1 已拍板，且当前模型本身已让用户
  无法信任会话状态，可接受。
- **风险 2：会话按区编号后，跨区引用 sessionId 的旧数据（goal/记忆）错位**——
  归档即不存在，不回读（D1 下无此问题）。
- **风险 3：删 `_session_id` 可能波及引擎命令的会话级行为**（如 agent 子分发审计）
  ——Phase 2/4 逐消费者核对，保留会话 id 作为纯标识（不参与引擎路由）的兜底。
- **回退**：全程按阶段 commit；每阶段门禁全绿才合并。绝不留半截双轨存储。
