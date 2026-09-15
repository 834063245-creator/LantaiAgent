# WO-S6P2 — seam 选择：从模块态到装配期值注入

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：所属线（组合架构 S0-S6）**全段竣工**——本件是历史留存，不作现状口径；组合层现状见 [`docs/composition/README.md`](../../../composition/README.md)，插件契约见 [`docs/plugins/README.md`](../../../plugins/README.md)，在办计划入口见 [`docs/plans/README.md`](../../../plans/README.md)。

> 施工单（**已过目并执行完毕：2026-09-15 用户逐项裁定，见 §7 裁定列；P2a `a1e83c8f` / P2b `53924344`
> 两笔落地，§5 的门禁四连 + 破测全部通过；实测环境事实已写回设计件 §8.2**）。上级设计件：`designs/S6-per-agent-composition.md`
> §3.4 消费点表 + §4 批序 P2 行 + §8.1 环境事实。前置批次：P-1 / P0.5 / P0 / P1(a-e) 全部落地。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > `AGENTS.md` > 本单。
>
> **本单先给结论、再给施工；末尾 §7 是六道需要用户裁定的判断题。**

---

## 1. 现状（已核实，非引用文档）

**seam 裁剪面 = 模块级单值**，唯一灌入点 = `composition-store` 三个 setter：

| 事实 | 位置 |
|---|---|
| `let current: SeamDisabledMap` + `applySeamDisabled` / `seamDisabled` | `composition/seam-resolution.ts:45 / :49 / :58` |
| 灌入点 | `state/composition-store.ts:60/64/68`（setResolved / setError / resetToFactory） |

**六个消费单点**（全部读模块态，故裁剪面是全局的——一份卷选 minimal 波及所有卷）：

| # | 消费面 | 读点 | 谁在调 |
|---|---|---|---|
| 1 | `activeLlmAdapters()` | `composition/services.ts:297` | `provider/index.ts:61`（方言解析）← `createProvider` ← `provider/live.ts:69` |
| 2 | `activeFsProviders()` | `composition/fs-service.ts:85` | `agent/tools/coding.ts:33`（`fsExecute`）← fs-domain 插件工具族 |
| 3 | `activeShellProviders()` | `composition/shell-service.ts:79` | `agent/tools/coding.ts:53`（`shellExecute`）← shell-domain 插件工具族 |
| 4 | `activeSubagentProviders()` | `composition/subagent-service.ts:85` | `agent/agent.ts:1844`（`spawnSubAgent`，**Agent 上下文内**） |
| 5 | `activeSessionPersistenceProviders()` | `composition/session-persistence-service.ts:123` | `sessionExecute`(:129) ← `ui/chat-session.ts` 5 处 + `app/chat/session-log-store.ts` 4 处 + `app/chat/chat-core.ts` 1 处 |
| 6 | `seamDisabled('loopEvents')` | `agent/events.ts:252`（`emitLoopEvent`） | 每 Agent 独有总线（`agent.ts:1112`）；emit 来自 `default-loop.ts` 7 处 + `agent.ts:1851/1869/1877` |

## 2. 目标形态（值 = 裁剪面，携带 = owner 键控表）

**值取哪一层**：注入的**不是 provider 列表，而是该组合的 `SeamDisabledMap`**。原因是已立语义：
「注册表 = 实现真源，组合 = 裁剪真源」+「**晚注册可见**」（`seam-resolution.ts:8-15`，测试
`tests/seam-composition.test.ts:107-112` 钉住）。冻结列表会杀掉晚注册可见；冻结**禁用集**则两者兼得。

**携带路径（关键裁定）**：**不走 `ToolRowContext` 扩字段**，走**装配期登记 + 调用点按 owner 查表**。

> 证据（决定性的）：fs/shell 工具族经 `contribution-helpers.ts:32-47` 的
> `familyContributions` 贡献，族实例被 **`family ??= build(rowCtx.codingExec)` 锁存在首次装配的
> rowCtx 上**（`plugins/builtin/fs-domain/index.ts:15` / `shell-domain/index.ts:15`）。因此
> rowCtx 扩字段对这两族**结构性无效**（除非把两族改 noCache 每装配重建 11+4 个工具定义、或按
> 身份键控缓存——那要改插件通道契约，而并发工作线的 office 域同用该 helper）。
> 反过来，仓库里「按 owner 查表」是**成熟先例**：`agent/session-context.ts:39-57`
> （`registerOwnerContext(ownerId, …)` + `ownerContext(ownerId)`，键 = executor 注入的
> `_owner_id` = Agent bus id，构造期 `ctx.effect` 登记 ⇒ 拆卸即清），消费侧
> `coding.ts:428`（`withStickyCwd`）、`tools/domains.ts:495-498`、`agent/sticky-cwd.ts:17`、
> `agent/asset-store.ts:11`。

**新模块**（叶模块，零项目内依赖，仅 type-only 引 `seam-resolution`）：

```ts
// src-ui/src/composition/seam-scope.ts —— 装配期 seam 作用域（模块级可变态归属 CONVENTIONS §1.10 第 3 类）
export function registerSeamScope(key: string, view: SeamDisabledMap): () => void
export function seamScopeOf(key: string | undefined | null): SeamDisabledMap | undefined  // 未登记 = undefined
export function clearSeamScopesForTest(): void
```

**消费面签名**（`seam-resolution.ts`，契约载体）：`seamDisabled(domain, view?)` ——
**`view` 缺省 = 模块级 `current`（今天的行为）**，各 `active*(view?)` 同款。

### 逐单点方案

1. **fs / shell**（工具族）：`fsExecute` / `shellExecute` 内
   `const view = seamScopeOf(ownerOf(args))`；`ownerOf` = `args._owner_id ?? args._agent_id`（三行，
   与 `withStickyCwd` 同形）。`args` 由 executor 注入身份
   （`streaming-executor.ts:421`、`agent.ts:347`）；**无 meta 的直调（测试 / UI 路径）⇒ undefined ⇒ 全局**。
2. **subagents**：`agent.ts:1844` 直接 `activeSubagentProviders(this._composition?.seamDisabled)`
   ——Agent 自持组合（`:511 ctx.get('composition')`），零查表；子 Agent 经 ctx composition 继承同面。
3. **loopEvents**：`AgentEventBus` 增 `setSeamView(view)`，Agent 构造期（`:511` 之后）灌入；
   `emitLoopEvent` 读本总线视图、缺省全局。**emit 调用点与 `agent-loop/types.ts` 形状零改动**。
4. **llm**：`CreateProviderOptions` 增可选 `seamView`（`provider/live.ts:69` 已把 options 透传）；
   `workspace.ts` 两处构建点传当次组合（工作区默认 = 工作区组合；会话 = 卷级组合——须把
   `:813 effectiveComposition(...)` 提到 provider 构建（`:769-770`）**之前**，它是纯 cache 读、
   捕获网永不抛，前置无副作用）；设置面板（`ProviderPage.tsx:176/258`）与翻译/压缩旁路不传 = 全局缺省。
5. **sessionPersistence**：**见 §7 判断题 D（我建议本批不做）**。
6. **`composition-store` 的 `applySeamDisabled` 保留**，但语义从「唯一灌入点」降级为
   **「无组合上下文的兜底面 = 全局当前选择」**——注释（`seam-resolution.ts:12`）与
   `docs/composition/README.md` §seam 裁剪域须同步改写。

### 对 AgentConfig 冻结面的规避

**完全不进 `AgentConfig`**（`tests/convergence/gate.mjs:79-95` 断言字段数 `=== 28`）。值走
① `ctx.get('composition')`（既有 per-Agent 服务，`:511` 已在读）② owner 键控表（键 = bus id）。
`ToolRowContext` 也不必动。28 字段面零接触。

## 3. 默认路径零漂移（构造性论证，非事后观察）

1. 所有新参数**缺省 = 模块级 `current`**；`seamDisabled(domain)` 单参调用点逐字不变
   （旧路径、UI 直调、`tests/seam-composition.test.ts` 全 8 例均单参）。
2. 装配期登记只在**有组合产物**时发生（`agent.ts:511` 的 `?? null`）；null ⇒ 不登记 ⇒ 落全局。
3. **出厂两轨的 `seamDisabled` 构造性为空**：`factoryComposition()` 恒 `EMPTY_SEAM_DISABLED`
   （`roster.ts:250`），`minimal` 的 patch 只含 tools + capabilities、**无一个 `seam/*` 键**
   （`presets.ts:93-100`）⇒ 即使注入路径写错，两轨看到的禁用集都是空集
   ⇒ 8 份快照 + `system-prompt.fixture` 逐字节不变是**构造性结论**。
4. 哨兵：`tests/seam-composition.test.ts` 8 例若需改动 = 缺省语义被改坏（黄金标准 = 测试 diff 为零）。

## 4. 「seam 域 per-composition 快照」——**建议不做**（设计件 §4 门禁列的那条）

- 快照的信息量 = 组合差异；两轨 seam 禁用集**都是空** ⇒ 快照内容 = 两份空 map，零区分度，且随
  `SEAM_DOMAINS` 演进必腐烂（本仓对「零消费者/零信息」结构有明确纪律）。
- P2 的零漂移已由**既有 8 份基线快照**逐字节覆盖（它们冻结完整装配产物字节面）；
  新快照不增加任何证明力。**故不触发 `baseline-change-request`，`record` 不跑。**
- 信息量应落在有区分度的地方 = **新行为测试**（§5）。若用户仍要一条 convergence 快照，
  则该提交须走 `src-ui/tests/convergence/baseline-change-request.md` 留痕审批。

## 5. 测试计划（新增从用户操作序列写；破测逐条验证）

| 断言 | 形状 |
|---|---|
| **序列 D 端到端** | 两个 Agent 各自组合（A = 全局 standard；B = 注入 `seam/fs` 禁 `builtin/rust-fs` + 晚注册内存 provider）→ **同一次 `read_file` 落不同 provider**（provider 侧调用计数可分辨）；两卷并存互不串味 |
| 无组合上下文零漂移 | 单参 `activeFsProviders()` / `fsExecute` 无 meta ⇒ 读全局当前选择（哨兵，与 ③④ 同批） |
| loopEvents 分总线 | 总线 A 禁 `turn/start`、总线 B 不禁 ⇒ A 不广播、B 照常 |
| 生命周期 | Agent dispose 后 scope 键消失（`ctx.effect` 对称释放，无泄漏） |
| llm 按卷 | 会话 provider 带卷级 view ⇒ 方言解析被裁剪；设置面板路径不带 ⇒ 全局 |

**破测验证**（P1 先例，每条注入缺陷确认能红）：① owner 查表恒返回全局 → 序列 D 红；
② 删 `ctx.effect` 登记 → 泄漏断言红；③ `emitLoopEvent` 忽略本总线视图 → loopEvents 红；
④ 缺省参数改成「空视图」而非「全局」→ 哨兵红。

## 6. 契约与文档（**注意版本号已漂移**）

- **现版本 = 35，不是接手文档写的 31**：并发工作线（会话存盘换轨）已占 v32/v33/v34/v35
  （`contract-version.ts:42-56`）。P2 的实际号须在提交时点重读——预计 **v36**。
- 四步（缺一 `tests/seam-contract-version.test.ts` 红）：① 改契约文件 → ② bump
  `OPEN_SURFACE_CONTRACT_VERSION` → ③ `docs/agents/open-surface-contract.md` 变更记录加一行
  → ④ `npm run gen:contract-fingerprint` → 同 commit。
- 受影响载体：`seam-resolution.ts` / `services.ts` / `fs-service.ts` / `shell-service.ts` /
  `subagent-service.ts` / `agent/events.ts`。**不动** `agent-loop/types.ts`、`default-loop.ts`、
  `provider/types.ts`（形状零变更）。
- 新增 `composition/seam-scope.ts` **不入契约载体清单**（叶模块、非三方面）；但**必须进
  `tests/composition-import-cycle.test.ts` 的静态面白名单**（§8.1 事实 1：它一旦长大成环，症状是
  整仓连坐，而运行时探针时红时绿不可作守卫）。
- `doc-sync`：已核 `scripts/**` 无任何生成器消费 seam ⇒ 只需契约指纹对拍（无目录重生成）。
- 文档写回：`docs/composition/README.md` §seam 裁剪域（现文语义 = 全局一份，P2 后不成立）、
  `AGENTS.md` §7 与 `CLAUDE.md` 对应段（**注意两处都写「AgentConfig 冻结 31 字段」，实测 28**——
  顺带更正这条既有漂移）、设计件 §3.4/§4/§8 + 新增 §8.2 施工实测。

## 7. 判断题与用户裁定（2026-09-15）

| # | 判断 | 裁定 |
|---|---|---|
| **A** | 值注入携带路径：`ToolRowContext` 扩字段，还是 owner 键控表？ | ✅ **owner 键控表**——偏离设计件字面（「经 rowCtx/闭包注入」）已获准，理由见 §2 证据：`familyContributions` 首装配锁存 ⇒ rowCtx 对 fs/shell 结构性无效；仓库已有 owner 键控先例 |
| **B** | 默认路径零漂移怎么证？ | ✅ **不新增 convergence 快照、不触发 baseline-change-request**（§4）；证法 = §3 构造性论证 + §5 哨兵测试 |
| **C** | 新增 `seam-scope.ts` 叶模块 vs 塞进 `session-context.ts` 的 `OwnerContext` | ✅ 新增独立叶模块（概念归 composition；键空间后续还要容纳「非 owner」的键） |
| **D** | **`sessionPersistence` 单点本批做不做** | ✅ **本批不做**：per-volume 后端选择的正确语义要求读也按该卷组合，而读盘时点组合尚未解析（卷内 `presetId` 恰在待读的卷里 = 鸡生蛋）；真做需「卷 → 组合」外部索引 = 独立批次。半吊子（写卷级 / 读全局）比全局更糟 ⇒ 该 seam 本轮保持全局裁剪面，**`session-persistence-service.ts` 本批一字不动**（亦避开并发工作线正在改动的文件） |
| **E** | `ResolvedComposition.seams`（零生产读者化石）用起来还是删掉？ | ✅ **本批不碰**（维持现状；P2 方案天然不需要它——裁剪面用 `seamDisabled`、视图用注册表实时清单） |
| **F** | 批次切分 | ✅ **P2a / P2b 两笔**：P2a = seam-scope + agent 登记 + subagents/loopEvents/fs+shell + 契约 bump + 测试；P2b = llm seam + 文档写回 |

## 8. 红线

- 不动 `AgentConfig`（28 字段，gate 断言）、不动 `agent-loop/types.ts` 形状、不动出厂 preset 面。
- 不以 `record` 覆盖任何漂移；baseline 变更只走 change-request。
- 新模块若引入 `state/*-store` 或 `composition/preset-assembly` 的静态边 = 成环，返工。
- 并发工作线（office 域 / 会话存盘换轨）同改文件：`contract-version.ts`、
  `session-persistence-service.ts`、`docs/**`。每笔只 `git add` 本线路径；门禁红了先判归属
  （`git stash push -u -- <本线路径>` → 跑用例 → `git stash pop`）。
