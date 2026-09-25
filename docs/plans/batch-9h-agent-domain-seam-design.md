# 批 9h 施工单 —— agent 域四件红账的接缝化归家（agent-loop-service / skill-domain / memory-domain / task-domain）

> 状态：**Proposed（2026-09-26 立，实测侦察已附）**。真值账本 = [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)
> （本文件只是施工单；数字以账本 §5 与 `npm --prefix src-ui run plugin-home:report` 重测为准）。
>
> 缘起：批 9 前九笔（9a/9b/9c-1~3/9d/9e/9g-1~2/9h-1）已把红区压到 **5 产物 / 10 文件 / 3,573 行**
> （2026-09-26 实测），其中四件是同一类病灶：**实现被内核 `new` 出来 / 被内核 runtime 直接调用**，
> 不是「按文件搬」能解决的。批 3 复核时已把它们改期（「整件搬会造宿主→插件反向依赖」），
> 批 6/7 已为这类病灶立好接缝范式——本单就是把范式套到四件上。

## 1. 四件实测（2026-09-26，逐文件消费者）

| 红账条目 | 内核实现（物理行） | 内核构造/调用点（file） | 已随包的消费面 | 判据 |
|---|---|---|---|---|
| `agent-loop-service` | `agent/agent-loop/default-loop.ts` **469** | `agent.ts:23`（`opts.agentLoop ?? defaultAgentLoop` 回落）· `agent-loop-active.ts:10`（`resolveAgentLoop()` 兜底） | 本包 `index.ts`（`AgentLoopService` 类 + 注册表）桥 `defaultAgentLoop`（faceDeps 键） | **半壳收口**：注册表已在产物域，只剩「出厂默认实现」留内核 |
| `skill-domain` | `agent/skills.ts` **377** + `agent/builtin-skills.ts` **358**（出厂技能内容） | `workspace.ts`（`new SkillRegistry`）· `agent/runtime/agent-builder.ts` · `agent/runtime/runtime.ts`（`scanSkills`）· `composition/tool-rows.ts` | 本包 `index.ts`；settings-domain 的 SkillsPage 读同一面 | 类被内核构造 + 出厂内容表（`BUILTIN_SKILLS` 只被 `skills.ts` 消费）⇒ 内容与实现同族 |
| `memory-domain` | `agent/memory.ts` **733** + `agent/memory-bundle-client.ts` **134** | `workspace.ts`（`new MemoryManager` + `memoryBundleIngest`）· `agent/context.ts` · `agent/runtime/agent-builder.ts` · `agent/runtime/types.ts`（类型）· `composition/tool-rows.ts` | 本包 `index.ts` 桥 `createMemoryTools` | 类被内核构造；无第三处内核读写 |
| `task-domain` | `agent/task.ts` **178** + `agent/task-board.ts` **319** + 随行 `board-persistence.ts` **121** · `tools/board-status.ts` **78**（board-status 已被 capability-segments 认领） | `task.ts`：`workspace.ts` / `agent/runtime/{runtime,agent-builder}.ts` / `composition/tool-rows.ts`（`TaskManager`）；`task-board.ts`：`agent/{agent,context}.ts` · `runtime/{runtime,types}.ts` · `state-hooks-contract.ts` · `subagent-runtime-contract.ts` · `ui/agent-panel-store.ts`（`TaskBoard` 类型） | 本包 `index.ts`；state-hooks / subagent-in-process 桥 | **最难一件**：`TaskBoard` 是 10 个内核件的类型/值面（含两条契约文件） |

## 2. 统一接缝范式（照抄批 6/7，不发明新机制）

每件按**四件套**落：

1. **契约面留内核**（`agent/<x>-contract.ts`）：接口/形状 + 「实现面」接口（工厂或动词表）。
   纯类型与常量，零运行时依赖。
2. **登记表留内核**（`agent/<x>-impl.ts`）：`register/active/require/clearForTest` 四件；service 语义
   （`require*` 缺实现 fail-loud，报错带具名原因 + 装载提示）。
3. **实现随包**：`git mv` 内核实现文件进 `plugins/builtin/<dir>/`，包内 `host.ts` / `host.aliased.ts`
   桥它仍住内核的依赖面（面尽量小：只桥**单例/工厂**，纯函数能内联就内联）。
4. **内核调用点改查表**：`new X(...)` → `requireX().create(...)`；类型 import 改指向契约文件；
   名册该条 `impl` 销账、`plugin-home-ledger` NOTES 与计数同步。

**序纪律**：这四件都不产出工具行/prompt 段（工具行由 `composition/tool-rows.ts` 按域声明），
因此**不该**引起 convergence 基线漂移；基线零改动是「搬移等价」的最强证据。

## 3. 子批切分与顺序（每批门禁全绿再下一批）

| 子批 | 内容 | 量 | 要点 / 风险 |
|---|---|---|---|
| **9h-2** | `agent-loop-service` 半壳收口：`default-loop.ts` 整件随包 | 469 | ① **契约面流程**：`default-loop.ts` 在 `composition/contract-version.ts` 的契约文件清单里 ⇒ 改路径 + 版本 51 → 52 + `docs/agents/open-surface-contract.md` 行 + `npm run gen:contract-fingerprint`（18 文件）同 commit；② `agent-loop-active.ts` 的 `resolveAgentLoop()` 去掉 `defaultAgentLoop` 兜底 ⇒ 无服务时 fail-loud（具名错误 + 装载提示），`tests/setup.ts` 复现「loader 已跑过」（照 9b 的 LSP 先例）；③ 名册标 `required: true`（loop 缺席 = 一个会话都跑不起来）；④ 桥位仅 3 个新键（`typedRpcWithTimeout` / `finishReasonMessage` / `StreamingToolExecutor`），其余 6 个已在宿主面 |
| **9h-3** | `skill-domain`：`skills.ts` 377 + `builtin-skills.ts` 358 随包 | 735 | ① `SkillRegistry` 类被 `workspace.ts` 构造 ⇒ 契约面出 `SkillRegistry` 接口 + `SkillImplementation.createRegistry(...)`；② `runtime.ts` 的 `scanSkills`（读出厂技能目录）与 `settings-domain` SkillsPage 走同一面 ⇒ 登记表读面 + 桥；③ 出厂技能内容（`BUILTIN_SKILLS`）随包 = 改技能免重建 exe |
| **9h-4** | `memory-domain`：`memory.ts` 733 + `memory-bundle-client.ts` 134 随包 | 867 | ① `MemoryManager` 接口化 + 工厂；`memoryBundleIngest`（workspace 单点调用）走同一实现面；② 内核 `agent/context.ts` / `runtime/types.ts` 只类型 import ⇒ 指契约文件；③ 拆包时注意 `memory-bundle-client` 的 MCP/引擎附属依赖（当前只 workspace 消费） |
| **9h-5** | ✅ **已落（2026-09-26，整包一次搬完）**：`task-domain`：`task.ts` 178 + `task-board.ts` 319 + `board-status.ts` 78 随包；`board-persistence.ts` 121 判**内核共享面** | 575 | ① `TaskBoard` 出现在两条**契约文件**（`state-hooks-contract.ts` / `subagent-runtime-contract.ts`）与 `ui/agent-panel-store.ts` ⇒ 契约面留 `TaskBoardFace` / `TaskBoardProxyFace` / `TaskBoardReadFace`（实现随包）；② runtime 的 per-session 板与 proxy 生命周期留在内核装配层，实现只提供工厂 ✓；③ 风险最高、放最后 ✓。**§3.1 的结论生效**：不切 5a/5b，一次搬完整包；**`board-persistence.ts` 判共享**（内核 `discovery-board.ts` 与包内 `task-board.ts` 共用，随包会让内核反向依赖产物源码）⇒ 名册 `shared` 认领，红区 696 → 575 行 |

### 3.1 9h-5a 首次尝试的实测结论（2026-09-26，**已整段回退，不 commit 半成品**）

按四件套把 `task.ts` 搬进包（`agent/task-contract.ts` + `agent/task-impl.ts` 门面 + capability-segments
改走门面）后，门禁红在三处，其中**两处是「部分搬迁」这一形态本身的产物**，不是实现错误：

1. **`plugin-home-ledger` 的「每条登记的实现真源仍被该包引用」会红**：该守卫要求包**至少引用一条**
   自己名册 `impl` 条目；`task.ts` 搬走后包不再引用任何一条（余下 board 三件是**内核侧红账**，
   包从来只经 `agent/tools/board-status.ts` 的桥间接用其中一件，而那件由 capability-segments 桥）
   ⇒ 守卫按「全部不再引用 = 已搬完」判红。**结论：该守卫与「包自持实现 + 余账未搬」的中间态不兼容**
   ——要么一次搬完整包（9h-5a+5b 同批），要么先改判据（不建议：守卫的口径本身没错）。
2. **装配腰环境缺实现登记**：`capability-segments` 的 `task-tools` capability 在**每次 Agent 装配**
   调 `createTaskManager()`；而 `tests/convergence/helpers/fixtures.ts`（convergence gate 直接跑它，
   **不经 `tests/setup.ts`**）此前靠「内联 `new TaskManager()`」自足 ⇒ 改走门面后缺登记即 fail-loud。
   **教训（对 9h-5b 与后续批次通用）**：凡把「内核构造」改成「门面取实现」，就必须**同时**在
   `tests/setup.ts` **与** convergence 夹具里登记实现（后者是独立进程入口）；这条要在搬运前先做，
   而不是等门禁红。
3. 最小切口建议：**一次搬完整包**（`task.ts` + board 三件 + `board-status.ts`），或**先只搬
   `board-status.ts`**（它已被 capability-segments 桥、包侧有真实引用），两者都能让守卫口径自洽。

#### 3.1.1 正式落地时的两条新实测结论（2026-09-26，9h-5 落）

4. **登记表必须是「栈」**：装配腰（`withFirstParty*Channel`）在每个块结束时逆序 dispose 贡献者
   fiber，而三域（skill/memory/task）的实现在 `ctx.effect` 里注册、dispose 时撤销 ⇒ **单值登记**
   会被那次 dispose 抹掉：同一个测试里「腰跑完之后」再装配 Agent 就撞 fail-loud（`composition-wiring`
   / `composition-preset-assembly` / `composition-session-count-profile` / `phase-1` 四文件实测红）。
   修法 = 三张登记表改**栈式**（`register` push / `clear` pop / `active` 读栈顶，对齐
   `composition/contribution-channel.ts` 的「后注册胜 + 对称释放」语义）⇒ 常驻登记（`tests/setup.ts`）
   不再被后来者的弹出波及。**通用纪律：凡「产物 apply 期登记 + dispose 期撤销」的登记表，都用栈。**
5. **`board-persistence.ts` 判内核共享面**（不随包）：它是 `TaskBoard`（包内）与 `DiscoveryBoard`
   （内核，§4-5 判 shared）**共用**的面板持久化基础件；随包会让内核反向依赖产物源码（批 8a 立的
   「内核 ↛ 产物源码」守卫钉死）⇒ 名册 `shared: ["agent/board-persistence.ts"]` 认领，包内经宿主桥
   取真实例。红区因此 696 → **575 行**（余 `paper-shell` 806）。

**顺序理由**：9h-2 最便宜且是「最后一个半壳」（§1.2 收口，账本可整节销账）；9h-3/9h-4 是同一形状
（类 + 出厂内容）的中等件；9h-5 牵两条契约文件，最后做 ✓（**已全部落完**）。

## 4. 每批门禁（不得跳过）

`cd src-ui`：`npm run build` · `$env:NODE_ENV='test'; npx vitest run` · `npx biome ci .`（0/0）·
`npm run verify:convergence`（双轨，**基线必须零改动**）· `npm run build:builtin-plugins` ·
`npm run gen:host-surface` + 再跑一次 `build:builtin-plugins`（指纹顺序）· `npm run doc-sync` +
`npm run doc-check`；契约面批次另跑 `npm run gen:contract-fingerprint`。
收尾每批都做：重建 exe（`cmd /c build.cmd`，先杀 `lantai`）+ CDP 探针（宿主面键数 / 产物真身 /
启动零装载失败）+ 账本 §5 与批次表更新（红/灰/认领三色数字重测）。

## 5. 不做什么（防漂移）

- **不扩 manifest 声明面**、不新增 ctx 通道（四件都走既有登记表范式；需要新通道就是设计错了）。
- **不把 `TaskBoard` / `SkillRegistry` 的类型面搬进产物**（内核契约文件与 UI 都在读 ⇒ 会被迫反向依赖）。
- **不为禁用语义加兼容兜底**：`require*` 缺实现一律 fail-loud（用户禁用 = 具名报错，不静默降级）。
- **不动** 与这四件无关的在途文件（`.github/workflows/**` · `engine/**` · 他窗的 `workspace.ts` / `chat-session.ts` 改动）。
