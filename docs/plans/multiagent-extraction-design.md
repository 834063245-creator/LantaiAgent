# 多 Agent 协作域归家设计（批 7：子代理运行时 + 通信族 + discovery）

> 状态：**施工单（2026-09-24 实测）· 待施工**；账本
> [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md) §6.3 是它的侦察记录。
> 承接批 6 的接缝（内核登记表 + 产物登记实现，见
> [`capability-impl-seam-design.md`](capability-impl-seam-design.md) §2），本批是它的**重型应用**：
> 多数实现是**内核构造的类**（`workspace.ts` new `SubAgentPool`、`runtime.ts` new `MessageBus` /
> `AgentLifecycleManager`），所以除了「工具族」外都要走**工厂登记**（内核查表造实例）。

## 1. 范围（账本登记项）

| 账本处 | 项 | 行数 |
|---|---|---|
| §2.3 | 多 Agent 通信族：`message-bus` 605 · `message-types` 137 · `message-store` 129 · `topology` 80 · `tools/communication` 159 · `tools/request` 94 | **1,204** |
| §2.3 | 子代理运行时：`coordinator` 420 · `lifecycle-manager` 217 · `tools/merge` 215 · `subagent-activity` 96 · `file-ownership` 73 · `tools/merge-gate` 55 · `isolation-queue` 13 | **1,089** |
| §1.1 | `agent-domain`（名册红账）：`tools/subagent` 265 | **265** |
| §1.2 | `subagent-in-process`（名册红账）：`subagent-spawn` 551 | **551** |
| — | `tools/discovery` 68（§4-5 的 DiscoveryBoard 工具面） | **68** |
| **合计** | | **≈3,177** |

## 2. 三条分类原则（本批的判据）

1. **机制留内核**：被 loop 契约 / runtime 装配 / 多个产物共享的面——`file-ownership`（compaction 包
   已桥 `extractFilePath`/`WRITE_TOOLS`）、`isolation-queue`（runtime/lifecycle/merge/spawn 四处共用的
   模块级队列）、`SubAgentStatus` 类型面。
2. **产品进包**：模型可见的工具族（`tools/subagent` · `tools/discovery` · `tools/communication` ·
   `tools/request` · `tools/merge`）、通信族实现（bus/store/topology/types）、运行时实现
   （coordinator/lifecycle-manager/subagent-spawn）。
3. **内核构造者走工厂登记**：`SubAgentPool`（workspace 构造）· `MessageBus` + `JsonMessageStore` +
   `AgentLifecycleManager`（runtime 构造）——内核不再 `new` 实现类，改 `requireX().create…(...)`；
   **service 语义**（缺实现装配期/调用点 fail-loud）。

## 3. 子批切分（每批独立可交付、门禁全绿再下一批）

### 7a `agent-domain` 实心化（265 行，闭合 §1.1 一条红账）

- 进包：`agent/tools/subagent.ts` → `plugins/builtin/agent-domain/subagent-tools.ts`；`index.ts` 改从
  包内取工厂（host 面**不再**二次出口——沿 fs/shell 的纪律）。
- 桥位：`defineTool` · `assertSupportedSchema` / `extractJsonObject` / `validateObjectJsonSchema`
  （schema-validate）· `getSubAgentActivity` / `STUCK_THRESHOLD_S`（subagent-activity）+ 类型
  `SubAgentPool` / `Tool` / `ToolExecutor` / `JsonSchema`。
- **硬点（4c 裁定① 同款）**：`agent/tool.ts:244` 有**值 re-export**
  `export { createSubAgentTool, type SubAgentSpawner } from './tools/subagent';`——内核聚合产物，
  必须退役（消费方：`blueprint.ts` 的 `createAgentKillTool`/`createSubAgentTool` 改查登记表；
  `composition/tool-rows.ts`、`runtime/types.ts`、`runtime/agent-builder.ts` 的 `SubAgentSpawner`
  类型上收内核契约或改指包内）。
- 爆破半径：**12 个测试文件**直连（`agent-spawn-sync` · `agent-status` · `async-spawn-fixes` ·
  `composition-activation` · `composition-session-count-profile` · `composition-tool-rows` ·
  `lifecycle-integration` · `lifecycle-unit` · `phase3-e2e-flow` · `schema-validate` ·
  `convergence/helpers/fixtures` · `convergence/specs/phase-1·phase-3`）；名册销账 1 条
  （空壳 9 → 8）；`plugin-home-ledger.test.ts` 的 `NOTES` 与计数同步。

### 7b 通信族进包 + bus/store 工厂登记（1,204 行，闭合 §2.3 一条）

- 进包：`multiagent-comm/`（`message-bus` · `message-types` · `message-store` · `topology` ·
  `communication-tools` · `request-tools`）。
- 上收内核契约：`AgentMessage`（**UI 直读**：`ui/agent-panel-store.ts`）· `TopologyPolicy` ·
  `MessageBus` 接口（`blueprint` / `context` / `agent` / `agent-loop/types` / request/communication
  工具面都只读类型）· `MessageBusImplementation`（工厂面：`createBus(...)`）。
- 内核构造者改造：`runtime.ts` 的 `new MessageBus(...)` / `new JsonMessageStore(...)` 改查表；
  service 语义 fail-loud。
- 爆破半径：**13 个直连 MessageBus 的测试**（`message-bus.test.ts` 最大）· `ui/agent-panel-store` 类型改指。

### 7c 子代理运行时进包（`subagent-in-process` 实心化，1,640 行，闭合 §1.2 + §2.3 两条）

- 进包：`coordinator` · `lifecycle-manager` · `subagent-spawn` · `subagent-activity` ·
  `tools/merge` · `tools/merge-gate`。
- 内核构造者改造：`workspace.ts` 的 `new SubAgentPool(...)` 改查工厂；`runtime.ts` 的
  `new AgentLifecycleManager(...)` 同改。
- **硬点**：`agent.ts:121` 的值 re-export（`export { buildSubAgentTools, wrapTool } from './subagent-spawn'`）
  退役；`subagent-spawn.ts` 现经 `faceDeps` 桥 `spawnSubAgentImpl`（subagent-in-process/host.ts）——
  翻面成「包内真源 + 内核只查登记表」。
- 爆破半径：**21 个直连 coordinator 的测试** + `wait-domain` 的 `SubAgentStatus` 桥 + `tools/subagent`
  （7a 已进包 ⇒ 本批顺理成章）。

### 7d 收尾：file-ownership / isolation-queue 判内核共享 + 账目清账

- 两者**留内核**（判据见 §2 第 1 条），在账本 §2.3 写明认领，避免下批重复侦察；
  compaction 包的 host 面**不需改**（它桥的正是内核面）。
- 全批收尾：`plugin-home:report` 红区应降到 **9 产物 / 23 文件**；名册销账 2 条
  （`agent-domain` · `subagent-in-process`）。

## 4. 每批验收（与批 6 同规格）

`vitest` 全量 · `build`（含 `build:builtin-plugins`，产物自包含）· `biome ci` 0/0 ·
`verify:convergence` 双轨（**基线零改动是硬指标**——本批不动工具表序：7a/7b 的工具族仍经各自
capability 原位注册，7c 的 spawn 工具面同理）· `doc-sync` + `doc-check` · faceDeps 指纹重生成 ·
真机 exe 重建 + CDP（新产物 entry.js 在场 + 键数对拍）。

## 5. 已知风险与对策

| 风险 | 对策 |
|---|---|
| `agent/tool.ts` / `agent.ts` 的**值 re-export**（两处） | 4c 裁定① 先例：退役聚合出口，消费方改指包内或登记表；测试腰 `tests/helpers/*` 兜住测试面 |
| 34 个直连测试（coordinator 21 + MessageBus 13） | 逐批改指包内（`git mv` 保历史 + import 重写脚本，同批 4c-3 手法） |
| `SubAgentPool` / `MessageBus` 由内核构造 | 工厂登记（`create…`）+ service 语义 fail-loud；`tests/helpers/*-impl.ts` 常驻腰按文件接（**勿入 setup.ts**——批 6d-2 实测教训） |
| `wait-domain` 桥 `SubAgentStatus`（已归家产物） | 7c 时把该桥改指新包（或将 `SubAgentStatus` 上收契约） |
| 工具表序（字节契约） | 工具族仍走**原 capability 条目**（只换成查表），不动注册序；convergence 双轨每批自证 |