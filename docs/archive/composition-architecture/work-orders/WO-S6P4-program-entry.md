# WO-S6P4 — 程序入口（按组合起卷 · 拒绝语义 · 评测自举定位）

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：所属线（组合架构 S0-S6）**全段竣工**——本件是历史留存，不作现状口径；组合层现状见 [`docs/composition/README.md`](../../../composition/README.md)，插件契约见 [`docs/plugins/README.md`](../../../plugins/README.md)，在办计划入口见 [`docs/plans/README.md`](../../../plans/README.md)。

> **状态：✅ 执行完毕（2026-09-16，两笔：P4a `4ca7df3e` 入口 + 拒绝语义 / P4b 收官写回；
> 每笔独立全绿：vitest + biome 0/0 + build + convergence 双轨 + doc-sync v39；
> 破测 5 条逐条确认能红——①2红 ②2红 ③4红 ④1红 ⑤1红，结果写进 P4a commit message）。
> 附笔：`tests/ab` 图谱时代化石整删（`43963f2c`，裁定 8②）。**
> 上级设计件：[`designs/S6-per-agent-composition.md`](../designs/S6-per-agent-composition.md)
> §2 序列 C（程序指定组合）+ §3.3（优先级链：显式参数 > 卷级 > 全局默认）+ §4 P4 行 + §6 R7（鉴权论证）。
> 前置批次：P-1 / P0.5 / P0 / P1(a-e) / P2(a/b) / P3(a-d) 全部落地（开工时 HEAD `77ad6fe7`；
> P3 施工实测环境事实见设计件 §8.3，P4 施工实测事实已写回设计件 **§8.4**）。
> 十道判断题的裁定记录见 §7 末（用户原话「全部按推荐施工」）。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > `AGENTS.md` > 本单。
>
> **本单先给结论、再给施工；§7 的十道判断题已裁定。**
> **动手前先读 §1.6（实测缺陷）与 §1.3（三条硬约束）——它们决定本题能不能按设计件的字面做。**

---

## 0. 一句话结论（先说最要紧的）

设计件 §4 的 P4 行字面写「**会话创建 RPC 带 `preset` / MCP 工具参数 / 评测自举**」，但**实测：兰台今天没有任何程序入口能起卷**——
RPC 面 53 个方法里没有会话创建，兰台不是 MCP server，ACP server 是「协议齐、零 boot 接线」的骨架，
模型可见的 17 个域工具里没有任何一个能建卷/开会话/指定组合（§1.1-1.2）。

**所以 P4 不是「给已有入口加一个参数」，而是「先把入口立起来」，并且必须绕开三条硬约束**：

1. **平台边界**：强制层外不得新增 Rust 命令（`src-tauri/tests/platform_boundary_test.rs:3-6/40-61`；
   `docs/plans/composition-architecture/README.md:27`）——「会话创建」是能力契约层的事（README:26 明列 session 持久化为 seam）；
2. **RPC 没有对外 transport**：`invoke` 只在 webview 内（`src-ui/src/bridge.ts:52` `@tauri-apps/api/core`），
   外部程序（Cursor / 评测脚本）根本够不到 RPC——**新增 RPC 解决不了设计件写的「外部程序」诉求**；
3. **模型可见工具 schema 一动就撞 convergence 快照**：`baseline/phase-0/tool-schemas.full.json`（36KB）
   + `preset-minimal/` 同款逐字节对拍 ⇒ 加工具/加参数 = `baseline-change-request` + `record` 审批通道。

⇒ **本单的建议形态（§2 形态甲）：入口落 TS 组合层的程序入口单点（不新增 Rust、不动模型可见面、不升契约）**，
把「外部协议接线（ACP / 兰台作 MCP server）」与「评测自举」显式拆成独立批次（§7 判断题 1 / 6 / 7 / 8）。

---

## 1. 现状（已核实，逐条给证据）

### 1.1 「按组合起卷」今天唯一的实现、唯一的调用者

| 事实 | 位置 / 证据 |
|---|---|
| 卷级组合写路径单点 = `selectSessionPreset(ctx, sessionId, presetId)` | `src-ui/src/app/chat/session-composition.ts:83-118`（校验 `sessionSelectionError` 91-93 → 空白闸 96-98 → 拆句柄 101-102 → 登记 105 → 必要时当场重建 109-116） |
| 它**只被 UI 芯片**调用（生产调用点恰 1 处） | `app/chat/chat-core.ts:717-718` ← 芯片 `plugins/builtin/compose-dock/ComposerDock.tsx:510` |
| 它的文件头早就写明「UI 芯片 / **程序入口共用**」——但**今天程序调用者为零** | `session-composition.ts:82`（注释）+ 全仓 grep：`selectSessionPreset` 的调用者只有上面那一处 |
| 卷创建唯一入口 = `createNewSession(ctx)` | `src-ui/src/ui/chat-session.ts:511`；生产调用点 4 处，**全是 UI 动作**（`SessionSidebar.tsx:505` / `ComposerDock.tsx:694` / `PaperPanel.tsx:715` / 斜杠 `/new` `chat-core.ts:1718`） |
| **新卷句柄按「出生时刻的全局默认」装配**（这是 P4 要改的那一行语义） | `chat-session.ts:540-542`（注释原文：「方案甲：新卷句柄按『出生时刻的全局默认』装配——此刻尚无会话覆盖」） |
| 装配消费点（工厂按**卷登记**重建） | `src-ui/src/workspace.ts:824`（`getRecordedPresetId`）→ `:833`（`effectiveComposition`）→ `:836-837`（`compositionIdentity` 判据）→ `:862-916`（`createAgent(config, compositionOverride)`） |
| 卷级登记载体 | `src-ui/src/agent/agent-session-state.ts:154`（`_presetIdBySession`）+ `:203-211`（存取）；**`removeAgent` 会一并清掉登记**（`:193`）⇒ 写路径顺序「先拆句柄、后登记」是硬契约（设计件 §8.1 事实 3） |

### 1.2 程序入口：四个候选面，今天**全部不存在**

| 候选面 | 实测结论 | 证据 |
|---|---|---|
| **Tauri RPC** | 53 个方法，**零**会话创建 / 跑轮 / 发消息；最沾边的是 `agent_session_append`（只写 `.lantai/agents/{id}/session.ndjson`，零 TS 调用方，与 `.lantai/sessions/` 卷无关） | `src-tauri/src/rpc.rs:343-982`（dispatch）/ `:962-973`；生成物 `docs/agents/frontend-rpc-contract.md:5`「方法总数：53」；`rpc-contract.ts:528-531` |
| **兰台作 MCP server** | **不存在**：`src-ui/src/`、`src-tauri/src/` 均无 server 侧 `initialize` / `tools/list` 处理；`plugins/mcp-bridge.ts` 是 MCP **client**（manifest.mcpServers → 工具行 `plugin/<插件名>/mcp/<server名>`）；引擎（`engine/src/mcp.rs`）是 MCP server，但它只提供图查询，不造对话实体 | `plugins/mcp-bridge.ts:4-46`；`docs/plugins/README.md:24/90-91`；`.mcp.json.example` |
| **ACP server**（「让外部程序把兰台的 Agent 当驱动对象」） | **契约齐、零接线**：`createAcpServer` 只被 `tests/acp-server.test.ts:37/73/122` 调用；`createTauriAcpLineIO`（`agent/mcp/tauri-io.ts:73-74`）**零调用者**；且 `session/new`（`agent/acp/server.ts:212-226`）透传参只有 `onEvent/onStatusChange`，**无组合参数** | `src-ui/src/agent/acp/server.ts:4-12/205-247` |
| **headless / 评测脚本** | `package.json` 28 条 scripts **无 eval / headless**；`tests/convergence/` 能在无 UI 下装配「某 preset 的工具面」（`specs/phase-1.test.ts:90-112`：`createAgent({...}, await resolveCurrentComposition())` → 快照对拍），但**不经卷、不建卷、不发号、不登记**；`tests/helpers/composition-boot.ts` 是 13 插件裸装配底座 | `package.json` scripts；`tests/convergence/helpers/preset-composition.ts:33-42`；`tests/convergence/specs/phase-1.test.ts:90-112` |

**唯一可用的「程序化起卷」是测试里的 UI 入口直调**（`tests/chat-session.test.ts:502` 等 `panel.createNewSession()`，内核 fs 走内存盘 mock）——
它证明「进程内无 UI 起卷」技术上可行，但那不是产品面。

### 1.3 三条硬约束（会直接决定本批形态，逐条给证据）

1. **强制层外不得新增 Rust 命令**：`platform_boundary_test.rs:3-6`（测试头注）+ `:40-61`（20 个 `commands/*.rs` 模块基线）；
   `docs/plans/composition-architecture/README.md:26-27` 明列「session 持久化」属**能力契约层**（seam），
   「强制层外不得新增 Rust 命令」。⇒ **`session_create` 写成 Rust 命令 = 违宪**（除走「强制层改动 + 宪法审查」基线变更通道）。
2. **RPC 无对外 transport**：`src-ui/src/bridge.ts:52`（`invoke` → `@tauri-apps/api/core`）——RPC 只在 webview 内可达；
   本机唯一对外监听面是 LLM 反代 + 插件资产（`src-tauri/src/llm_proxy.rs:4-25`：仅 loopback、只收 `POST/OPTIONS` + `GET /plugins/*`），
   它是 **LLM 反向代理**，不是 agent 驱动 API。
3. **模型可见面的字节成本**：`baseline/phase-0/tool-schemas.full.json`（36KB）+ `preset-minimal/` 双轨逐字节对拍
   （`tests/convergence/specs/phase-1.test.ts:108-112` 同款 + `npm run verify:convergence` 双轨）。
   给任何模型可见工具加参数 / 加动作 ⇒ 两轨快照同时漂 ⇒ **必须走 `baseline-change-request` + `record` 审批**
   （`src-ui/tests/convergence/baseline-change-request.md`），且会重算 DeepSeek 前缀缓存字节面。

### 1.4 卷创建的内部时序（决定「单次装配」要不要碰冻结文件）

```
createNewSession(ctx)                       chat-session.ts:511
  ├─ 514-518 无工作区 → showToast + return（**注意：不抛、不返回失败**）
  ├─ 521 getWorkspaceEpoch()
  ├─ 534-535 发号（任何 await 之前）：id = nextSessionId; nextSessionId = id + 1
  ├─ 537-546 factory 在场则 await factory(id)   ← ★组合决定的那一次装配在这里
  ├─ 549-552 在途切工作区 → dispose + return
  ├─ 567-575 有句柄：seedVolumeLog（570，头行 presetId 取 `agent.presetId`）→ setAgent → bindSession → setExec
  └─ 576-599 写 sessions/activeIdx、清 msgStore、切 board、updateFooter
```

三条推论（写进 §2 的形态选择）：

1. **组合必须在 `:542` 之前登记**，否则工厂走 `getRecordedPresetId → null → 全局默认`（`:540-541` 注释即此语义）；
2. `seedVolumeLog` 的头行 `presetId` 来自 **`agent.presetId`**（`chat-session.ts:326`），而 `agent.presetId` 由工厂 `agent.selectPreset(recordedPresetId)` 回述（`workspace.ts:948`）⇒ **登记对了，卷头自然对**；
3. `createNewSession` **自身不登记 presetId**（全仓 `setRecordedPresetId` 只有 `chat-session.ts:1267/1394`（读盘恢复）与 `session-composition.ts:105`（P1c 写路径）三处）——
   这是「新卷出生即带组合」今天做不到的直接原因。

### 1.5 冻结文件 + 并发线（改动成本的真实形状）

- `src-ui/src/ui/chat-session.ts` 是**冻结文件**（`CONVENTIONS.md:1.1`；`AGENTS.md` §6）；
  本轮并发工作线（会话存盘换轨）正落在这条链上（事件日志八动作、`.ndjson` 权威翻转）。
- `src-ui/src/app/chat/session-composition.ts` 是 P1c 的家，**非冻结**、已在册、静态面纪律成文（文件头 28-43 行 + 守卫 `tests/composition-import-cycle.test.ts`）
  ⇒ **新入口函数落这里**（`ui/` 是冻结残余目录，新文件属封口违规）。
- 本批**预计触碰的共享文件**：`ui/chat-session.ts`（形态甲的「单次装配」路线 3-4 行，见 §2.1）、`app/chat/chat-core.ts`（薄转发，可选）。
  纪律照 P3：**改前 `git status -- <文件>` 查净、改后尽快提交**；每笔只 `git add` 本线显式路径。

### 1.6 实测缺陷（本单调研新发现，**不在**已知病灶清单里，请一并裁定）

`src-ui/tests/ab/`（AB 实验台，4 文件 + `scripts/ab-test/`）**已经腐烂且不会红**：

- `tests/ab/ab-harness.ts:2-8` 从 `src/agent/hooks.ts` 导入 `createGraphContext` / `createGraphContextHook` / `createGraphPreflightHook`——
  这三个符号**已随图谱全量退役（2026-09-09）删除**（现 `hooks.ts` 仅导出 `Hook` / `PreflightHook` / 两 Registry / `createStateReadHook` /
  `createStatePreflightHook` / `createBuildResultHook`，见 `hooks.ts:25/38/76/84/136/162/186`）；
- `tests/ab/ab-tools.ts:430-531` 造的是 `buildMiniGraphTools`（`graph_summary` 等图谱时代工具面）；
- **为什么今天不红**：`ab-trial.test.ts:8` `enabled = Boolean(process.env.AB_ARM)` + `:34` `describe.skipIf(!enabled)`
  ——默认跑法整文件跳过；Vite SSR 变换下未执行的具名导入不抛（取用点不执行）。
  实测：`npx vitest run` 输出 `↓ tests/ab/ab-trial.test.ts (1 test | 1 skipped)`（本单开工前门禁日志），**烂了但不报警**；
- **一旦有人开 `AB_ARM`**：当场 `undefined is not a function` 炸；且它对照的两臂（graph hooks on/off）在图谱退役后**已无差别**，
  整个台子失去存在理由。

⇒ 按仓库「破坏性授权 + 连带清理」精神，**建议顺带整删**（`tests/ab/**` + `scripts/ab-test/**`，一笔独立 commit，
commit message 写明「图谱退役遗留化石，引用已删符号」）；也可单独立项或维持现状——**请裁定（§7 判断题 8）**。

### 1.7 两条尺子与热路径纪律（P4 的选择依据）

| 尺子 | 语义 | 用在哪 |
|---|---|---|
| `selectionError(id)` | **容忍未知 id**（解析侧回退「只叠用户层」——旧卷记着已删 preset 的正确兜底） | 读旧卷 / 运行期解析（`preset-assembly.ts:214-230`） |
| `sessionSelectionError(id)` | **严一档**：不在册也拒（「写一条新记录」≠「读一条旧记录」） | 写新记录（P1c `session-composition.ts:91-93`；`preset-assembly.ts:240-258`） |

热路径纪律（P3 实测，设计件 §8.3 事实 6）：`selectionError` 每卷装配都过 ⇒ 新判据必须在**输入为空时立刻返回**
（`missingRequiredPlugins` 第一行 `if (requires.length === 0) return []`，`:193-195`）——P4 的入口**只在新卷创建时**过，
不在装配热路径上，但仍不得给 `selectionError` 加无谓求值。

---

## 2. 目标形态（建议 = 形态甲：TS 组合层程序入口单点）

### 2.1 入口单点：`createSessionWithPreset`（落 `app/chat/session-composition.ts`）

```ts
/** 程序入口（S6 P4）：按组合起一卷。
 *  优先级链（设计件 §3.3）= 显式参数 > 卷级记录 > 全局默认；
 *  显式参数**落卷**（登记即卷级记录 ⇒ 出生即记录一致、卷头芯片可显示、重开不必再带参）。
 *  不可解析 = **拒绝创建**（不建卷）+ 具名原因——不静默回退（程序入口没有「可见提示」载体，
 *  回退对程序而言就是静默）。 */
export async function createSessionWithPreset(
  ctx: SessionContext,
  presetId?: string,
): Promise<{ ok: true; sessionId: number } | { ok: false; reason: string }>;
```

实现要点（形态甲 + **单次装配**）：

1. **先严格校验**（`sessionSelectionError`，严一档）：不在册 / `requires` 缺插件 / 行 id 不可寻址 ⇒ 立刻返回
   `{ ok:false, reason }`，**一个卷都不建**（拒绝路径零副作用——这是「拒绝创建」的字面语义）；
2. **调 `createNewSession(ctx, { presetId })`**：需要给冻结文件 `ui/chat-session.ts` 的 `createNewSession` 加**一个可选参数**，
   在 `:535`（发号后）与 `:537`（调工厂前）之间登记 `agentSessionState.setRecordedPresetId(ctx.storeId, id, presetId)`
   ⇒ 工厂（`:542`）读到登记 ⇒ 该卷**出生即按指定组合装配一次**（不白装配、不写全局设置）；
3. **返回新卷 id**：`createNewSession` 今天返回 `void`，且**无工作区时静默 return**（`:514-518`）——
   入口若事后读 `sessions[activeIdx].id` 会把**旧活跃卷的 id** 当成新卷返回（真实陷阱）。
   两个做法：**(i)** `createNewSession` 返回 `number | null`（签名变更：4 个 UI 调用点与既有测试忽略返回值 ⇒ 编译零改动）；
   **(ii)** 入口前后对拍 `sessions.length`（`!= before + 1` ⇒ `{ok:false, reason:'需先绑定工作区'}`）。
   **建议 (i)**（消除猜测；代价是同一处冻结文件再多一行）。

> **备选装配路线 = 两步复用（零触碰冻结文件）**：入口 = 严格校验 → `createNewSession(ctx)` → 读回新卷 id → `selectSessionPreset(ctx, sid, presetId)`。
> 代价：**多一次装配**（新卷先按全局默认装配、随即拆掉重建；P3 实测冷装配 22.1ms / 热 5.1ms，`reports/perf-after-S6P3.md:16-17`），
> 且「拒绝」发生在建卷**之后** ⇒ 要么先校验（那就与单次装配同形，只差中间那次白装配），要么建卷后回滚删除（更糟）。
> **请裁定（§7 判断题 2）。**

### 2.2 调用者（本批只立单点，不接线外部协议）

| 调用者 | 本批状态 |
|---|---|
| UI 组合芯片（既有） | **不改**：仍走 `selectSessionPreset`（它拨的是**已存在的空白卷**，与「起卷时指定」是两条不同语义） |
| 斜杠 `/new` / 侧栏出生按钮 / 坞内落笔 / 纸壳空态 CTA | **不改**（无参数 = 全局默认，零漂移） |
| 评测 / 未来 ACP / 未来第三方程序 | **本批只保证可调**（导出 + 测试证明「无 UI 进程内可按组合起卷」）；接线拆独立批次（§7 判断题 7 / 8） |

### 2.3 参数形态与优先级链

- **只收 `presetId: string`（组合身份 id）**，**不接受内联完整组合（patch/YAML 片段）**：
  设计件 §1.4 边界 2 + §3.7 不变式 I1 明写「组合必须是**有限可枚举**的 preset 集合」——
  内联 patch 会打开无界组合空间（门禁矩阵、字节契约、前缀缓存三项验证同时失效），
  且 API 需自带版本化与校验（另一整摊工程）。**若确需程序自带组合，唯一通道 = 先落一份 preset 到
  `~/.lantai/composition/presets/<id>/`（P-1 已有的 authoring 通道），再按 id 起卷。**
- **优先级链**（设计件 §3.3）：`显式 presetId` > `卷级记录` > `全局默认`
  —— 单次装配下前者在创建瞬间**变成**卷级记录（单一真源，不留「本次参数」这第二个真源）。

### 2.4 拒绝语义与错误形状

| 情形 | 行为 | 理由 |
|---|---|---|
| `presetId` 不在册（写错 / 已删改名） | **拒**（不建卷）+ 具名原因（`组合「x」不在册…`） | `sessionSelectionError` 严一档（`preset-assembly.ts:249-258`） |
| `requires` 缺插件 | **拒** + 具名原因（`组合「x」需要插件 Y，但它未装载…`） | 同上（`:220-223`） |
| 行 / 段 / seam id 不可寻址（patch 本体坏） | **拒** + 解析器原话原因 | 同上（`:224-229` 走 `resolveCurrentComposition` 真解析） |
| `presetId === undefined`（不指定） | 走全局默认（= 今天语义，零漂移） | 缺省不上新行为 |
| 无工作区 | **拒** + 原因（不得沿用「静默 return」） | 程序入口必须可判成败（§2.1 要点 3 的陷阱） |
| 工作区在途切换（epoch 过期） | **拒** + 原因（卷未建） | 沿 H1 代际语义（`chat-session.ts:521/549`） |

**错误形状**：本批返回**结构化结果对象**（`{ ok, reason }`），不抛异常——与 P1c `selectSessionPreset` 同形
（`SessionPresetChange`，`session-composition.ts:50`），UI 芯片与新入口**共用同一把尺子与同一形状**（不造第二套错误载体）。
若将来接外部协议（ACP/RPC），由**协议层**把它翻成协议错误码（ACP: JSON-RPC error；RPC: `Err(String)`），
**不在组合层预造协议形状**（那是化石）。

### 2.5 鉴权面（沿设计件 R7）

- **不与权限模式联动**（设计件 §6 R7：程序指定组合**不授予**超出会话创建的能力——能起会话者本就能跑 shell）；
- 组合面只能在**已登记面内**裁剪/回开：禁用行、`disabled:false` 回开 `defaultOff` 行（P1b）、
  `requires` 触发的 lazy 插件激活（P3）——**不引入任何未注册能力**；
- 强制层闸（plan 模式 / 权限引擎 / 沙箱 / 审计）**不因入口而变**：程序指定组合**不是**提权通道。

---

## 3. 默认路径零漂移（构造性论证，非事后观察）

1. **不指定 `presetId` ⇒ 行为逐字不变**：入口是**新增函数**，4 个既有 UI 调用点与斜杠命令一律不传参
   ⇒ `createNewSession` 的可选参数缺省 = 不登记 = 今天语义（工厂读 `null` → 全局默认，`chat-session.ts:540-541`）；
2. **不动 `resolveRoster` / `resolvePresetComposition` / `effectiveComposition` 的签名与语义**
   ⇒ 8 份 baseline + `system-prompt.fixture` 逐字节不变是**构造性结论**（同 P2/P3 的论证方式）；
3. **不动任何模型可见工具 schema、不动 `AgentConfig`（28 字段）、不动出厂 preset 面**
   ⇒ `verify:convergence` 双轨零漂移、`doc-sync` 五生成物零变化；
4. **不动契约文件**（形态甲不碰 `OPEN_SURFACE_CONTRACT_FILES` 任一文件）⇒ 开放面契约**仍 v39**；
5. **黄金标准哨兵**：`tests/composition-session-preset.test.ts`（P1c，7 例）、`tests/chat-session.test.ts`（45 例）、
   `tests/composer-dock-composition-chip.test.tsx` 若需改动 = 缺省语义被改坏（应**零改动**）。

---

## 4. 施工切分（按形态甲 + 单次装配 = 两笔，每笔独立全绿独立 commit）

| 笔 | 内容 | 关键产物 |
|---|---|---|
| **P4a** 入口 + 拒绝语义 | `app/chat/session-composition.ts` 新增 `createSessionWithPreset`（严校验 → 起卷 → 返回 id）；`ui/chat-session.ts` `createNewSession` 加可选 `{ presetId }`（发号后、调工厂前登记）+ 返回值改 `number \| null`；`chat-core.ts` 薄转发（可选）；新测试 `tests/composition-program-entry.test.ts` | 入口单点 + 破测记录 |
| **P4b** 收官写回 | 设计件 §4 P4 行 ✅ +（**新增 §8.4 P4 施工实测环境事实**：程序入口今天的四个候选面实测、RPC 无 transport、模型面加参的 baseline 代价、`createNewSession` 静默 return 陷阱、`tests/ab` 化石）+ `docs/plans/README.md` 计划索引 + `docs/composition/README.md`（用户可见：程序入口的语义与拒绝面）+ `AGENTS.md` §7 / `CLAUDE.md` 对应段（仅当形态与设计件字面有偏离时，**偏离必须显式写**） | 文档写回 |

- **若装配路线选两步复用**：仍两笔，但 P4a 不碰 `ui/chat-session.ts`（零冻结文件改动），多一条「白装配一次」的成本说明；
- **若选形态丙（新增 RPC）**：P4a 变成 Rust + 前端双侧 + `gen-rpc-contract-md.cjs`（**新分区必须登记 `SECTIONS` 表**，`scripts/gen-rpc-contract-md.cjs:34-57`）
  + `platform_boundary_test.rs` 基线（新增 `commands/*.rs` 模块时）+ commit 标注「强制层改动 + 宪法审查」——**量级 ×2 且不解外部程序诉求**；
- **若 §7 判断题 8 裁定「顺带删 `tests/ab`」**：独立一笔（第 0 笔），不与 P4a 混。

---

## 5. 测试与破测（新增从用户/程序操作序列新写；破测逐条验证能红）

| # | 断言 | 形状 |
|---|---|---|
| 1 | **程序入口起卷（序列 C 主判据）** | 进程内无 UI：`createSessionWithPreset(ctx, 'minimal')` ⇒ 返回新卷 id；该卷的工具面 = minimal 面（不含被禁行）、system prompt = minimal 面 |
| 2 | **与 UI 同 id 逐字节一致**（序列 C 断言原文） | 同一进程两条路径各起一卷（程序入口 `'minimal'` vs UI 路径 `createNewSession` + `selectSessionPreset(sid,'minimal')`），对拍 `tools.schemas()` JSON 与 `assembleSystemPrompt` 输出**逐字节相同** |
| 3 | **落卷**：出生即记录 | 起卷后 `agentSessionState.getRecordedPresetId(storeId, sid) === 'minimal'`；卷日志头行 `presetId === 'minimal'`（`seedVolumeLog` 语义）；关句柄再 `ensureSessionAgent` ⇒ 仍按 minimal 装配（不回落全局默认） |
| 4 | **拒绝路径零副作用** | 未知 id / `requires` 缺插件 / 坏 patch 三种：返回 `{ok:false, reason}` 且 **`sessions.length` 不变**（一个卷都没建）、登记表无新键、`preset-store.error` 有原因 |
| 5 | **缺省零漂移** | 不传参：行为与既有 `createNewSession` 逐字相同（无工作区拒绝、发号、切 board）；既有 `composition-session-preset.test.ts`（7 例）与 `chat-session.test.ts`（45 例）**零改动** |
| 6 | **无工作区可判成败** | `getProjectPath() = ''` ⇒ `{ok:false}`（**不再**静默 return 后再把旧活跃卷 id 当新卷返回） |
| 7 | **优先级链**：显式 > 卷级 > 全局 | 全局默认改 `standard`、卷级已记 `minimal`、显式传 `standard` ⇒ 生效 `standard` 且登记被改写为新值（显式参数落卷） |
| 8 | **鉴权面无联动** | 权限模式 / plan 模式下入口可用性不变；组合面不引入未注册工具行（起卷后工具名 ⊆ 该 preset 面） |

**破测（每条注入缺陷确认能红，结果写进 commit message）**：
① 入口不做严格校验（直接建卷）→ 4 红；② 登记挪到工厂调用**之后** → 1/2/3 红（新卷仍按全局默认装配）；
③ 不登记、只在卷头写 presetId → 3 红（关卷重开回落全局）；④ 尺子降级为 `selectionError` → 4 红（未知 id 容忍 ⇒ 建了卷）；
⑤ 无工作区沿用静默 return（入口读 store 取 id）→ 6 红。

**不进红绿**：本批**不新增** baseline 快照、**不跑 `record`**（零漂移是构造性的）；
性能只报告（`npm run bench:assembly`），单次装配理论上**只减不增**（相对两步复用少一次装配）。

---

## 6. 契约与文档

| 面 | 形态甲（建议） | 形态乙（ctx 服务） | 形态丙（RPC） |
|---|---|---|---|
| 开放面契约 | **不动（仍 v39）**——不碰 `OPEN_SURFACE_CONTRACT_FILES` 任一文件 | **新增 ctx 键 ⇒ v40** + `gen:catalogs:service`（开放面四步流程） | 同形态甲（`rpc-contract.ts` 不在该清单） |
| `docs/agents/frontend-rpc-contract.md` | 不动 | 不动 | **必须重生成**（`node scripts/gen-rpc-contract-md.cjs`）+ 新分区登记 `SECTIONS` |
| `docs/agents/model-tool-contract.md` | 不动（**不加模型可见参数**，见 §7 判断题 6） | 同 | 同 |
| service / event catalog | 不动（无新 ctx 键、无新事件） | 同 | 同 |
| `platform_boundary_test.rs` 基线 | 不动 | 不动 | 新增 `commands/*.rs` 模块时**必改**（+ 宪法审查标注） |
| 文档写回 | `docs/composition/README.md`（新增「程序入口」小节：语义 / 拒绝面 / 优先级链）+ 设计件 §4 P4 行 + 新 §8.4 + `docs/plans/README.md` + `AGENTS.md` §7 / `CLAUDE.md`（仅偏离处） | 同 | 同 + RPC 语义说明 |

> **若 §7 判断题 1 选丙（新增 RPC）**：`session_create` 类方法还须在 `rpc.rs:108-219` 的 `rpc_result_shape` 表登记返回形状
> （**贴错标签是字节级破坏**，`rpc.rs:95-101`），并同步 `rpc-contract.ts` 的 `RpcContract`。
> **一律同 commit**（`doc-sync` 门禁守护；生成物漏更 = 红）。

---

## 7. 请示：十道判断题（**请逐条裁定**）

| # | 判断 | 我的建议 | 影响面 |
|---|---|---|---|
| **1** | **入口宿主形态**：设计件字面写「会话创建 RPC / MCP 工具」，但实测两者都不存在（§1.2）且都不该新增（§1.3）。选哪条？**甲** = TS 组合层程序入口单点（`createSessionWithPreset`）；**乙** = 追加插件面 ctx 服务（`ctx.sessions.create({presetId})`）；**丙** = 新增 Tauri RPC `session_create` | ✅ **甲**。理由：①「会话创建」属能力契约层（README:26-27 + `platform_boundary_test.rs:3-6`），写成 Rust = 违宪；② RPC 无对外 transport（`bridge.ts:52`），外部程序够不到 ⇒ 丙**买不到设计件要的东西**；③ 乙是新 ctx 键 ⇒ `gen:catalogs:service` + 开放面契约 v40 + 手册多处文案，而**今天零插件调用者**；④ 甲零新 Rust、零契约变更、UI/未来 ACP/评测共用一个入口 | 决定 P4a 的全部形态与量级 |
| **2** | **单次装配 vs 两步复用**：单次装配需给冻结文件 `ui/chat-session.ts` 加一个可选参数（+ 返回值改 `number \| null`）；两步复用零触碰冻结文件但白装配一次 | ✅ **单次装配**——语义干净（拒绝不建卷、出生即记录一致）、零浪费、少一处「短暂按全局默认装配」的窗口。**代价 = 碰冻结文件 3-4 行**，且该文件在本轮并发线的射程内（改前查净、改后立提） | 是否触碰冻结文件 + 是否多一次装配（22.1ms 冷 / 5.1ms 热） |
| **3** | **参数形态**：只收 `presetId`（id），还是允许内联完整组合（patch 片段）？ | ✅ **只收 id**。内联违反 I1（组合必须有限可枚举，§1.4 边界 2 + §3.7）——门禁矩阵/字节契约/前缀缓存三项验证同时失效；要程序自带组合请走 P-1 的 authoring 通道落一份 preset 再按 id 起卷 | API 面积与不变式 I1 |
| **4** | **是否落卷**：程序指定的组合写进卷级记录（出生即身份），还是每次开卷都要带参？ | ✅ **落卷**。理由：① 卷是记录真源（P0 闭环 + P1a「记录不再被改写」）；② 不落 ⇒ 同一卷在不同进程/不同 `presetId` 参数下解析出不同面 = 第二真源；③ 落卷后卷头芯片（P5）与恢复期校验**零新增代码**即可显示 | 优先级链的落点 + P5 的读面 |
| **5** | **拒绝语义与尺子**：用严一档 `sessionSelectionError`（未知 id 也拒）还是容忍的 `selectionError`？拒绝后是否回退？ | ✅ **严一档**（与 P1c 同尺）+ **拒绝即不建卷、不回退**。理由：程序入口没有「可见提示」载体 ⇒ 容忍/回退对程序就是**静默**（违「错误不静默」）；容忍的 `selectionError` 仍留给「读旧卷」路径（两条尺子各自的正当性见 §1.7） | 失败面语义 |
| **6** | **模型可见工具参数**（设计件 P4 行里的「MCP 工具参数」）：是否给模型面加「按组合起卷」的能力？ | ❌ **本批不加**（建议）。理由：① 17 个域工具今天**没有任何一个**能建卷/开会话/指定组合（§1.2）；② 加参数/加动作 ⇒ `model-tool-contract.md` 重生成 **+ 两轨 `tool-schemas.full.json` 漂移 ⇒ `baseline-change-request` + `record` 审批**（§1.3 约束 3）；③ 让模型在对话中途改自己的组合面 = 破前缀缓存字节契约（组合面是装配期决定，非运行期旋钮）；④ 与 S4-1a「子 Agent 与父同组合面」的既有设计冲突（`agent/context.ts:209-229` 的 `child()` 白名单继承 `composition`；`agent_spawn` schema 无组合参数，`agent/tools/subagent.ts:52-86`）。**若用户要「模型自己起卷」这条，建议单独立项 + 走 baseline CR** | 是否触发 baseline 审批通道 |
| **7** | **外部协议接线**（设计件说的「外部 MCP 客户端」）：本批接不接 ACP / 要不要让兰台作 MCP server？ | ❌ **本批不接**（建议）。实测：兰台不是 MCP server（§1.2）；ACP server 协议齐但**零 boot 接线**（`createAcpServer` 只被测试调用、`createTauriAcpLineIO` 零调用者），接它要先定**进程模型与 IO 传输**（GUI webview 无 stdin/stdout）——**这是"传输"问题，不是"组合"问题**。建议：本批给 `session/new` 加 `preset` 参数**也不做**（无接线的参数 = 空栏化石，本仓明确纪律：第四栏不预造空栏、`diagnostics.overridden` 是标本），整条留独立批次 | 是否本批就能兑现「外部程序」 |
| **8** | **评测自举 + `tests/ab` 化石**：① 是否顺带把「评测自举」拆成独立批次？② §1.6 实测的 AB 台化石怎么处置？ | ✅ **① 拆独立批次**（它是测试基础设施，不是产品面：需要的底座是 `tests/helpers/composition-boot.ts` + convergence 装配面 + 本批的入口单点，量不小且不该与产品面同 commit）；✅ **② 建议顺带整删** `tests/ab/**` + `scripts/ab-test/**`（独立一笔：图谱退役遗留、引用已删符号、默认跑法整文件跳过 ⇒ 烂了不报警；两臂对照在图谱退役后已无差别） | 批次边界 + 是否连带清理化石 |
| **9** | **鉴权面**：程序指定组合是否与权限模式联动（默认 / auto / yolo）？是否在 plan 模式下禁用入口？ | ✅ **不联动**（沿设计件 §6 R7：能起会话者本就能跑 shell，程序指定组合**不授予**超出会话创建的能力）；plan 模式**不禁用**入口——它只决定组合面（工具可见性由组合与强制层闸各自把关，闸不因入口而变）。组合面只能在**已登记面内**裁剪/回开，不引入未注册能力（§2.5） | 是否多一条权限语义分支（多一条 = 多一套要维护的判据） |
| **10** | **e2e 覆盖层级**：本批测到哪一层？（进程内行为测试 / 真机 cdp e2e / 评测自举脚本） | ✅ **进程内行为测试**（§5 八条，含与 UI 同 id 逐字节一致）+ **真机 e2e 不做**。理由：本批**无新 UI 控件**（新入口的可见面 = P5 的卷头 chip），真机验收随 P5 一起交用户（沿 P1e 先例：芯片三态由用户真机验收）；cdp e2e 是环境型抖动源（AGENTS §10 纪律），本批没有值得它的断言；「跑一轮真模型」属评测自举批（判断题 8①） | 门禁耗时与验收方式 |

> **若第 1 题不选形态甲**：请同时裁定「契约升级到 v40」的落点（形态乙：`gen:catalogs:service` + 开放面契约四步流程；
> 形态丙：`frontend-rpc-contract.md` + `SECTIONS` 表 + 可能的 `platform_boundary_test` 基线 + commit 标注「强制层改动 + 宪法审查」）。

### 裁定记录（2026-09-16，用户原话「我大概看了一下，全部按推荐施工，开工吧」）

| # | 裁定 | 落地含义 |
|---|---|---|
| 1 | **形态甲** | 入口 = `app/chat/session-composition.ts` 的 `createSessionWithPreset`；**不新增 Rust 命令、不新增 ctx 键、不动开放面契约（仍 v39）** |
| 2 | **单次装配** | `ui/chat-session.ts` `createNewSession` 加可选 `{ presetId }`（发号后、调工厂前登记）+ 返回值改 `number \| null`——**冻结文件改动已获用户点头** |
| 3 | **只收 `presetId`（id）** | 不接受内联组合；程序自带组合的唯一通道 = 先落 preset 到用户目录再按 id 起卷 |
| 4 | **落卷** | 显式参数在创建瞬间写入卷级登记，成为该卷记录（单一真源） |
| 5 | **严一档 + 拒绝即不建卷** | 用 `sessionSelectionError`；不可解析/无工作区 = 拒绝 + 具名原因，**零副作用**，不静默回退 |
| 6 | **不加模型可见工具参数** | 不碰 `model-tool-contract.md` / convergence 快照 / 子 Agent 父子同面契约 |
| 7 | **本批不接外部协议** | ACP / 兰台作 MCP server 整条留独立批次；连 `session/new` 的 `preset` 参数也不预留（不造空栏化石） |
| 8 | **① 评测自举拆独立批次；② `tests/ab` 化石顺带整删** | ② 落为独立一笔（先于 P4a），不混进产品面 commit |
| 9 | **鉴权不联动** | 不新增权限语义分支；组合面只在已登记面内裁剪/回开 |
| 10 | **进程内行为测试** | 本批不加真机 cdp e2e；真机验收随 P5（卷头 chip）交用户 |

---

## 8. 红线

- **不动** `resolveRoster` / `resolvePresetComposition` / `effectiveComposition` 的签名与语义；**不动** `AgentConfig`（28 字段，`gate.mjs` 断言）；
  **不动**出厂 preset 面（两轨零漂移是构造性结论）；**不新增 baseline 快照、不跑 `record`**（本批不触发 `baseline-change-request`）。
- **不新增 Rust 命令**（平台边界，`platform_boundary_test.rs:3-6`）——除非用户裁定形态丙并接受「强制层改动 + 宪法审查」标注。
- **不改模型可见工具 schema**（§7 判断题 6 若裁定不加）——一改即两轨快照漂 ⇒ 走审批通道。
- **`app/chat/session-composition.ts` 的静态面纪律不许破**（文件头 28-43 行）：
  静态面只准依赖 chat-core 已静态依赖的三个模块；store / composition 解析面一律**调用点 `await import(...)`**——
  静态可达即成环（症状 `Cannot access 'BUILTIN_PRESETS' before initialization`，曾连坐 46 个测试文件）。
  守卫 `tests/composition-import-cycle.test.ts`（含叶模块断言）。
- **`ui/` 是冻结残余目录**：新文件落 `app/**`（守卫 `tests/eventbus-zero-and-ui-split.test.ts`）；
  改冻结文件 `ui/chat-session.ts` 需用户点头（§7 判断题 2）。
- **并发工作线**同改 `ui/chat-session.ts`（会话存盘换轨）、`contract-version.ts`、`docs/**`、`AGENTS.md`/`CLAUDE.md`：
  纪律 = 每笔只 `git add` 本线显式路径（**不 `git add -A`**）；门禁红了先判归属
  （`git stash push -u -- <本线路径>` → 跑该用例 → `git stash pop`，链在一条命令里）；改前 `git status -- <文件>` 查净、改后尽快提交。
- **测试纪律**：行为未变 → 测试零改动（黄金标准）；行为退役 → 同批整删；行为新增 → 从程序/用户操作序列新写；
  禁止「改造后放回原位」；新增用例必须做**破测验证**（§5 五条）并把结果写进 commit message。
- 本机纪律：凡 npm/vitest 命令先 `$env:NODE_ENV='test'`（否则 jsdom 假红 + `npm install` 剥 devDependencies）；
  性能判据一律 **min（p75 次之）**，绝对 ms 不进红绿。

---

## 9. 开工前置（已做，留痕）

- 门禁基线（本单开工前实测，HEAD `0eab879e`，工作区仅 `?? .dec/` 属并发线残留）：
  vitest **316 文件 3154 passed / 4 skipped** · `biome ci` **0/0（782 文件）** · `npm run build` ✓（30 产物）·
  `verify:convergence` **双轨 exit 0** · `doc-sync` ✓（开放面契约 **v39** 指纹一致）。
- 调研证据：本单 §1 的每条 file:line 均为本轮实读（含两次只读子代理交叉核对：会话创建链路 / 程序入口面）。
