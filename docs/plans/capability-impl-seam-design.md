# capability 实现接缝设计（批 6：plan / goal / compaction / state-hooks 归家）

> 状态：**已拍板（2026-09-24，用户选 A）· 待施工**；本件是批 6 的施工单，账本
> [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md) §6.2 是它的侦察记录。
> 落地顺序 = 6a plan-mode → 6b goal-mode → 6c state-hooks → 6d compaction；每批门禁全绿再下一批。

## 1. 为什么不能照搬批 4c 的「按域拆 + git mv」

批 4c 的五个工具域（fs/shell/git/ask/agent-isolation）能整段搬走，是因为它们只有**一个**
宿主依赖面：`ctx.tools` 通道。批 6 四项不是这个形态——实现被**内核构造**或**内核直接调用**：

| 项 | 内核侧耦合（实测证据） |
|---|---|
| plan | `agent/runtime/runtime.ts:555` `new PlanStateManager()`、`:612` `ctx.set('planState', …)` 回落；`agent/agent.ts:709` `_planGate → planGateCheck`、`:703-704` `_planState/_planInjector` 字段；`agent/blueprint.ts:184-193` / `:366-378` 两条 capability 直接 `new PlanModeInjector()` + `createEnter/ExitPlanModeTool()`；`agent/subagent-spawn.ts:154` `planRegistry(...)`；`agent/agent-loop/{types.ts:63,default-loop.ts:89-107}` 读 `planState/planInjector` |
| goal | `workspace.ts:19` + `app/chat/chat-core.ts:19` `new GoalManager(...)`；`agent/agent.ts:69` 值导入 `runGoalImpl/resumeGoalImpl/GoalLoopHost`；`state/goal-store.ts` / `state/panel-store.ts` 类型；`runtime/types.ts:14` / `context.ts:25` 类型 |
| compaction | `agent/agent.ts:41,56,57` 值导入 `agent-compaction` / `compaction-model` / `compaction-summarize`；`runtime/agent-builder.ts:21` `createCompactionTools`；`agent-loop/types.ts:18` 类型；`ui/chat-stream.ts:9` 值导入 `COMPACTION_NOTICE_MARK`（跨层常量） |
| state-hooks | `agent/hooks.ts` 的 **HookRegistry 类是机制**（`agent.ts` / `context.ts` / `events.ts` / `runtime.ts` / `subagent-spawn.ts` / `agent-loop/types.ts` / `composition/hook-service.ts` 七处消费）；`state-inject.ts` + `cache-store.ts` 被 `workspace.ts:17,30`、`blueprint.ts:56`、`runtime.ts:43` 消费；出厂 hook 由 `blueprint.ts:358-365` 的 capability 注册 |

再加一条硬约束：**capability 表序 = 注册序 = 字节敏感面**（`composition/capability-service.ts:29-30`
「贡献序 = 注册序」，`:128`「capability 表序 = 字节敏感面」；`CLAUDE.md`：层序是字节契约）。
plan 的两条 capability 就在 `firstPartyCapabilities()` 的固定位置上，**换个来源注册 = 换位置**
⇒ convergence 快照漂移 ⇒ 要走 `baseline-change-request` 审批。所以「把 capability 定义搬进产物包」
这条最直觉的路，代价是审批 + 前缀缓存重算，不做。

## 2. 接缝形状（路线 A）

**内核登记表 + 产物登记实现**，照既有 `composition/*-service.ts` 的 seam 范式：

```
内核（登记表 + 消费点，位置不动）          产物包（实现 + 登记）
─────────────────────────────────      ──────────────────────────
agent/plan/plan-impl.ts                 plugins/builtin/plan-mode/
  registerPlanImplementation(impl)        plan-tools.ts     （工厂）
  activePlanImplementation()              plan-injection.ts （提醒注入器）
  clearPlanImplementationForTest()        plan-prompts.ts   （文案真源）
        ▲                                 index.ts → ctx.effect(() =>
        │  faceDeps 桥（产物域）                          register(impl), 'plan-mode')
        └───────────────────────────────────────────────┘
agent/blueprint.ts 的两条 capability **原位置、原 id、原 phase**，
只把 install 体从「直接 new/调用」换成「查登记表」。
```

三条不变量（本设计的全部价值所在）：

1. **表序零漂移**：capability 条目仍由同一个清单、同一序注册 ⇒ `factoryComposition().capabilities`
   与工具注册序逐字不变 ⇒ **不需要 baseline-change-request**（convergence 双轨自证）。
2. **宿主→插件零反向依赖**：内核只认登记表（本文件 + 契约类型），不 import 产物包；产物包只经
   `./host`（dev/test）与 `faceDeps`（产物域）取内核面。
3. **禁用语义显式**：登记表为空时按 `feature`/`service` 分类分叉（下表）。

| 项 | 分类 | 登记表为空时 | 依据 |
|---|---|---|---|
| plan-mode | `feature`（可禁用） | capability 静默不装（工具面少 `enter/exit_plan_mode`，与用户禁用该插件同义） | 用户拍板（2026-09-24）：plan 是可选工作流 |
| goal-mode | `feature`（可禁用） | 同上（goal 工具与 goal 面板入口随之消失） | 用户拍板：goal 同为可选工作流 |
| state-hooks | `service`（不可禁用） | **fail-loud**：装配期缺实现即抛/启动审计 fail（hook 管道是内核语义） | 用户拍板：不可禁用 |
| compaction | `service`（不可禁用） | **fail-loud**：Agent 每轮压缩是会话正确性前提 | 用户拍板：不可禁用 |

## 3. 逐项拆分表（搬什么 / 留什么 / 桥什么）

### 6a plan-mode（=302 行进包，270 行留内核）

| 动作 | 文件 | 行数 |
|---|---|---|
| 进包 `plugins/builtin/plan-mode/` | `agent/plan/plan-tools.ts`（去掉 3 个共享类型）· `plan-injection.ts` · `plan-prompts.ts` | 184+57+61 |
| 留内核（机制） | `agent/plan/plan-state.ts`（runtime 构造的状态机）· `agent/plan/plan-registry.ts`（**强制层**门禁 + 子 Agent 只读克隆） | 121+149 |
| 上收内核契约 | 新 `agent/plan/plan-contract.ts`：`PlanApprovalResponse` / `PlanOptionOutcome` / `PlanReviewRequest`（现被 `ui/message-model.ts`、`paper/block-model.ts`、`app/paper/builtin-renderers.tsx` 直接引用）+ `PlanModeImplementation` / `PlanReminderInjector` 接口 | — |
| 新登记表 | `agent/plan/plan-impl.ts`（键控自清理注册表，CONVENTIONS §1.10 第 3 类模块态） | — |
| 桥位 | `registerPlanImplementation` + 契约类型 + `PlanStateManager`/`EventSink`/`Tool` 类型 | — |

### 6b goal-mode（= 553 行待拆）

`goal-loop.ts`（317，Agent 类方法体）与 `goal-manager.ts`（236）先按「算法 vs 状态容器」切一刀：
状态容器（`GoalManager` 的 records/持久化）**留内核**（`workspace.ts` / `chat-core.ts` 构造），
算法（goal 循环 + 工具面）进包；`agent.ts` 的 `runGoalImpl/resumeGoalImpl` 调用改走登记表。

### 6c state-hooks（= 332 行进包）

**2026-09-24 实测切分**（施工时直接用）：`agent/hooks.ts` **301 行**里只有后半是产品件——
1–136 行 = `Hook` / `PreflightHook` 接口 + `HookRegistry` / `PreflightHookRegistry` 两类（**机制留内核**，
七处内核消费）；137–301 行 = 三个出厂 hook 工厂（`createStateReadHook` 137–165 ·
`createStatePreflightHook` 166–189 · `createBuildResultHook` 190–241）+ `parseBuildOutput` 242–301
（≈165 行）**进包**，加上 `hooks/board-tracking-hook.ts` 31 行 = **≈196 行进包 / 136 行留内核**。

接缝同 6a/6b：内核侧新 `agent/state-hooks-impl.ts` 登记表（`createStateReadHook` /
`createStatePreflightHook` / `createBuildResultHook` / `createBoardTrackingHook` 四个工厂），
`blueprint.ts` 的 `state-hooks`（:348-357）与 `board-tracking-hook`（:362-366）两条 capability
**原位不动**、只把 install 体换成查表。分类 = **service**（用户拍板）：未登记时 **fail-loud**
（装配期抛「state-hooks 产物未装载」——hook 管道是内核语义，缺了就是装歪，不许静默降级）。

`state-inject.ts`（231）+ `cache-store.ts`（107）**判内核共享面留内核**（消费者 `workspace.ts:17,30` /
`runtime.ts:43` / `blueprint.ts:56` 都在内核；随批 9 workspace 拆分再动）。

### 6d compaction（= 2,022 行待拆）

先把 `agent-compaction.ts` 里 `as unknown as CompactionHost` 的宿主面写实（现在靠类型断言），
再按「策略 vs 记账」切：`compaction-model.ts`（阈值/自动调优/工具面）+ `compaction-summarize.ts`
（摘要提示与预算）进包，`CompactionTracker` 记账留内核（loop 契约 `agent-loop/types.ts:18` 引用）。
`ui/chat-stream.ts:9` 的 `COMPACTION_NOTICE_MARK` 上收内核契约（跨层常量不许逆向）。

## 4. 爆破半径（施工前必须逐条验过）

1. **convergence 基线含 plan 工具面**：`tests/convergence/baseline{,-minimal}/phase-1/tool-schemas.effective.json`
   里就有 `enter_plan_mode` / `exit_plan_mode` ⇒ 装配路径必须真的登记到实现（见下条），否则基线红。
2. **测试装配路径**：`tests/helpers/composition-boot.ts::ensureProductionChannelsBooted()` 只装
   「四 service + llm-adapters + 三清单」——api 改这里加 plan-mode（它是「生产最小集」的定义处）；
   直连 `firstPartyCapabilities()` 的测试（`blueprint.test.ts` / `composition-capability-service.test.ts` /
   `composition-roster.test.ts` / `composition-wiring.test.ts` / `composition-preset-assembly.test.ts`
   断言 `enter_plan_mode` 在册）需要同一份最小集，或在该测试内登记实现。
3. **文件路径守卫**：`tests/paper-interaction-handoff.test.ts:108-151` 按**路径**读 `agent/plan/plan-tools.ts`
   ——搬文件必须同步改指（同批 4c-3 的 `coding-domain-plugins` 处理方式）。
4. **直接导入测试**：`tests/plan-outcome.test.ts`（`createExitPlanModeTool` + `PlanReviewRequest`）、
   `tests/plan-gate.test.ts` / `tool-pipeline-events.test.ts`（走 plan-registry，留内核不动）。
5. **产物面**：新增出厂产物 ⇒ `builtin-roster.json` 加条目 + `first-party-manifest.ts` 加 `feature` 条目 +
   `factory-products.ts` 加行（它不经任何通道，靠 apply 期登记）；`host-surface.baseline.json` 重生成；
   重建一次 exe 并按 `plugin-home:report` 复核（新产物不应判空壳：自有实现 302 行）。

## 5. 验收（每子批）

`vitest`（全量，重点：blueprint / composition-* / plan-* / paper-interaction-handoff / convergence 双轨）·
`build`（含 `build:builtin-plugins`，新产物自包含）· `biome ci` 0/0 · `verify:convergence` 双轨
（**基线零改动是硬指标**——表序零漂移的证明）· `doc-sync` + `doc-check` · 真机 exe 重建 + CDP 复核
（新产物 entry.js 在场、faceDeps 键数对拍、无新 404）。
