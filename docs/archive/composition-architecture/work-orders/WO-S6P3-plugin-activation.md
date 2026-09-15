# WO-S6P3 — 插件激活生命周期（登记 ≠ 激活 · 引用计数 · 独占声明）

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：所属线（组合架构 S0-S6）**全段竣工**——本件是历史留存，不作现状口径；组合层现状见 [`docs/composition/README.md`](../../../composition/README.md)，插件契约见 [`docs/plugins/README.md`](../../../plugins/README.md)，在办计划入口见 [`docs/plans/README.md`](../../../plans/README.md)。

> **状态：✅ 执行完毕（2026-09-15，四笔：P3a `e508f093` / P3b `2259c3c3` / P3c `aa5b491d` /
> P3d 受治进程接线（本轮，见 §2.7 落地注）；每笔独立全绿：vitest + biome 0/0 + build +
> convergence 双轨 + doc-sync；破测 14 条逐条确认能红，结果写进各 commit message；
> 性能对表见 `reports/perf-after-S6P3.md`）。**
> 施工单（**八道判断题已于 2026-09-15 全部裁定，见 §7；可开工**）。上级设计件：`designs/S6-per-agent-composition.md`
> §3.5（激活与独占）+ §3.8（诊断第四栏）+ §4 批序 P3 行 + §7.8（profile 断言欠账）+ §8.2。
> 前置批次：P-1 / P0.5 / P0 / P1(a-e) / P2(a/b) 全部落地；**P3 前置性能门已过**
> （`bb306655`，台子 `src-ui/tests/bench/`，报告 `reports/perf-baseline-S6P2.md`，阈值已写回设计件 §3.7）。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > `AGENTS.md` > 本单。
>
> **本单先给结论、再给施工；末尾 §7 是八道需要用户裁定的判断题。**

---

## 1. 现状（已核实，逐条给证据）

### 1.1 「登记」与「激活」今天不可分

| 事实 | 位置 / 证据 |
|---|---|
| 插件 `apply()` = 注册贡献 + 起副作用**同一时点** | `plugins/types.ts:263` `LantaiPlugin.apply(ctx)`（唯一入口）；loader 在 `loader.ts:864` `root.plugin(target)` 一次性跑完 |
| `ctx.effect` 是**所有权/拆卸**原语，不是激活原语 | `cordis/fiber.ts:78`（effect = disposer 登记）；`INVARIANTS.md #12`（获取点就地 effect 登记）。它既无引用计数，也表达不了「注册时机 ≠ 启动时机」 |
| 全仓 `ctx.effect` 44 处逐一读过 | 第一方插件侧 40+ 处**全是注册/注销**（`ctx.tools.register` / `ctx.fs.register` / panel-def / prompt 段…），零处启动进程或连端口 |
| 30 个出厂产物**零** `mcpServers` 声明 | `src-ui/src/plugins/builtin/**` grep `mcpServers` = 0 命中；`builtin-roster.json` 亦无 |
| 出厂面唯一的「起进程」是**每次调用的一次性子进程**，不是常驻资源 | `builtin/office-domain/index.ts:8` 经 `process_cap office_exec` 受控 spawn（强制层拼装命令）——与 PTY/常驻 stdio/端口监听不是一类 |
| ⇒ **出厂面没有一个常驻资源型插件** | 这是本批「零漂移是构造性结论」的物理根据（§3） |

### 1.2 唯一真实资源面 = MCP 受治进程（且它不在组合上）

| 事实 | 位置 |
|---|---|
| 三档生命周期 + 窗口计数 + 装配期拉起 + 空闲回收 | `plugins/mcp-bridge.ts:258 ServerGovernor`（`lifecycle` :292 / `windowOpenCount` :235 / `requestFromAssembly` :401 / 空闲 :473） |
| `lifecycle: "eager"` **就是 apply 期起进程** | `mcp-bridge.ts:606-615`（`await governor.start()` 在装载期） |
| 现存「引用计数」= **开窗数**，与组合无关 | `mcp-bridge.ts:214 windowOpenCounts` |
| 插件级启用/禁用 = boot 期一把梭（下次启动生效），无按组合粒度 | `state/plugin-prefs.ts` + `loader.ts:278`（`isDisabled` 跳过装载） |

### 1.3 P3 要引入的三个概念，目前**一个都不存在**

全 `src/` grep：`exclusive` / `activation` / `refcount`（含「引用计数」）在生产代码零命中
（8 条命中全在 `cordis/fiber.ts` 注释、`dynamic-runner` 的 approval 语义、browser 工具文案——无关）。

### 1.4 装配点与释放点齐备（不需要新生命周期机制）

| 事实 | 位置 |
|---|---|
| 每 Agent 一次装配（per-agent 组合产物在此落地） | `agent/runtime/runtime.ts:617 _assembleAgent`（`composition` 解析产物入参） |
| 释放 = `ctx.dispose()` 逆序释放全部 effect | `runtime.ts:857 _disposeAgent`（:876 `handle._getContext()?.dispose()`） |
| **装配期登记 + ctx.effect 对称清理**已有先例（P2 的 seam-scope） | `agent/agent.ts:556 ctx.effect(() => registerSeamScope(...), 'seam-scope')` |

⇒ 激活账的 **retain 在装配期、release 挂 `ctx.effect`** 即可拿到「Agent dispose / 切组合即归零」，
不新造拆除路径（`INVARIANTS #12` 语义原样）。

### 1.5 两条**结构性**约束（会直接咬到本批）

1. **`resolveRoster` 是纯函数，不能承载激活事实。** `roster.ts:347 resolveRoster(factory, layers)`
   同输入同输出（P1/P2 的零漂移全靠这条做**构造性**论证）。而「某插件在不在册 / 两个组合抢同一独占资源 /
   某插件激活 start 抛错」**都不是** `(factory, layers)` 的函数 ⇒
   **第四栏 `skipped` 与 requires/exclusive 校验不能塞进 `resolveRoster`**（塞进去 = 纯度破，此后每次改动都得靠快照对拍自证）。
2. **`tests/first-party-manifest.test.ts:38` 断言 `43 = 13 service + 30 feature`。**
   新增一个内核插件会牵动计数 + `AGENTS.md`/`CLAUDE.md` 多处文案
   ⇒ **建议激活服务挂进既有 `hologram/composition-services`**（它本就是「组合层 service 本体」，见 `services.ts:323`），
   不新增插件条目、不动 `BUILTIN_PLUGINS` 表、不计数字面量。
   但**新 ctx 键会牵动生成物**：`gen:catalogs:service` 扫 `declare module '../cordis/context'`（`gen-service-catalog.ts:9/92`）
   ⇒ 必须重生成 service catalog 并同 commit（`npm run doc-sync` 守护）。

### 1.6 `requires` 今天只能靠「行 id 写错」间接失败

`roster.ts:284 applyDisable`：未知行 id → `CompositionPatchError`（all-or-nothing，整层拒）→
用户看到的是 **`未知行 id: "plugin/hologram/review-domain/readonly_audit"`**，
而不是 **「组合 review 需要插件 hologram/review-domain，它没装/被禁用了」**。
两种尺子已在仓库里立好：`selectionError`（`preset-assembly.ts:182`，对未知 id **容忍**——旧卷兜底语义）
vs `sessionSelectionError`（`:213`，**严一档**：不在册也拒，因为「写一条新记录」与「读一条旧记录」不同）。

### 1.7 性能基线（P3 的对照基准，min 口径）

热路径挂载 **4.3ms** · 冷装配 **31.5ms** · 每卷常驻 **0.80MB** · 三卷 1.57MB · 裸查表 **87ns**
（= fs 派发全链 11.6µs 的 0.75%）。阈值：热 **<+15%** / 冷 **<+20%** / 每卷 **<+10%** /
三卷 **≤1.75MB** / 裸查表 **<1µs** / 派发全链 **<+10%**。**判据一律 min（p75 次之），绝对 ms 不进红绿。**

---

## 2. 目标形态

### 2.1 激活账（本批核心）——新叶模块 `composition/activation.ts`

```ts
/** 插件在 apply 里**只登记**，不启动（P3 前语义 = 登记即启动）。 */
declare(plugin: string, spec: ActivationSpec): () => void;
/** 装配期记账：首次 retain → start()；重复 retain → refcount++。 */
retain(plugin: string, holder: string): ActivationHandle | null;   // null = 该插件无声明（no-op）
/** 归零 → stop()；幂等。 */
release(handle: ActivationHandle): void;
/** 该组合要激活谁 / 谁被跳过（纯读，供装配面与诊断面共用）。 */
planFor(comp: ResolvedComposition): ActivationPlan;

interface ActivationSpec { resources?: string[]; exclusive?: string[]; start(): void | Promise<void>; stop?(): void | Promise<void>; }
interface ActivationPlan { activates: Array<{ plugin: string; exclusive: string[] }>;
                           skipped: Array<{ id: string; reason: string }>;
                           conflicts: Array<{ resource: string; holders: string[] }>; }
```

- **绑定 ctx**：`_assembleAgent` 里 `retain` 之后立刻 `ctx.effect(() => () => release(h), 'activation:<plugin>')`
  ⇒ 释放复用既有所有权链（`agent.ts:556` 同款）。
- **服务面**：`ctx.activation`（`declare module '../cordis/context'` 增广），实例在
  `compositionServicesPlugin.apply` 内创建（**不新增插件条目**，见 §1.5 约束 2）。
- **叶性**：`activation.ts` 零项目内运行时 import（type-only 允许）——照 `composition/seam-scope.ts` 先例
  加进 `tests/composition-import-cycle.test.ts` 的叶性守卫（成环症状见设计件 §8.1 事实 1，曾连坐 46 个测试文件）。

### 2.2 谁被激活（两个来源取并集）

1. **显式**：组合层声明的 `requires: [插件名]`（§2.5）；
2. **隐含**：该组合**存活行**的属主插件——行 id `plugin/<贡献 id>`，贡献 id 前缀 = 插件名，
   用「在册插件名集」做**最长前缀匹配**。
   **诚实边界（写进文档）**：只贡献面板/命令（无行、无 capability）的插件，隐含面追不到它——
   只能靠 `requires` 显式声明；**不为它建第二条索引**（第二真源）。

### 2.3 manifest 声明 + kill switch

```jsonc
// manifest.json（plugins/types.ts 加可选块）
"activation": { "lazy": true, "resources": ["stdio"], "exclusive": ["port:9310"] }
```

- **kill switch（设计件 §5）**：`activation` 整块缺席 = **本批全部新行为不发生**——
  apply 即活跃（P3 前语义逐字节不变），不需要 revert 代码。
- **装载期校验（fail loud，沿 `validateManifest` 的「错误不静默」）**：
  ① `lazy: true` 且 `mcpServers` 里有 `lifecycle: "eager"` → **拒载**（apply 期起进程正是本批要封的口）；
  ② `lazy: true` 但 apply 未调 `ctx.activation.declare` 且无 `mcpServers` → error 记录
  （「声明了开关却没接线」= 手误，不静默放过）。

### 2.4 独占分类表（闭集）

| 资源 type | 含义 | 独占？ |
|---|---|---|
| `pty` | 终端会话 | ✅ 不可共享 |
| `stdio` | 常驻子进程 | ✅ |
| `port:<n>` | 固定端口监听 | ✅ |
| `listener:<name>` | 全局监听（IPC / 事件源） | ✅ |
| `window` | 插件窗 | ❌ 可共享（沿用 `windowOpenCounts` 计数语义） |

「不可共享」**不等于**走 realm（乙路线）：`exclusive` 只表达「同一时刻只允许一个组合持有」，
冲突在**装配期 fail loud**（拒绝后装配者、原因含两个组合 id）；realm 逃生门按设计件 §7.4
**单独立项，本批不碰**（两条正交）。

### 2.5 `requires` 的失败面（两段式）

| 时点 | 行为 | 依据 |
|---|---|---|
| 选择期（`selectPreset` / `sessionSelectionError`） | **拒**（严一档，与 P1c 同尺）：缺插件的组合执行面必然残缺 | `preset-assembly.ts:213` 既有尺子 |
| 解析期（`effectiveComposition` 捕获网） | **不抛**：回退「只叠用户层」+ 原因可见（`preset-store.error`） | F1 语义（`preset-assembly.ts:241`）零改动 |
| 装配期 | `requires` 在册但 `start()` 抛错 → 该插件的行**被跳过** + 第四栏有记录 | 「错误不静默」+ 本章 §2.6 |

### 2.6 诊断第四栏（`skipped`）

- 形状：`skipped: Array<{ id: string; reason: string }>` —— **带原因**。
  前三栏（`unselected` / `disabled` / `seamCapped`）之所以是纯 id 列表，是因为各自**单因**、
  且处置动作互不相同；第四栏把「requires 缺 / exclusive 冲突 / 激活失败」三因收在一栏
  （处置动作相同：去设置›插件处理），纯 id 会让「原因可见」落空。
- **落点**：**不进** `ResolvedComposition.diagnostics`（那是纯解析产物，见 §1.5 约束 1），
  落 `ActivationPlan.skipped`，由 `composition-store` / 设置面板经**同一读面**呈现
  （与 P1e `sessionCompositionInfo` 同款分工）。

### 2.7 与 MCP 治理器的接线（零漂移纪律）

- **只有声明了 `activation` 的条目**走「refcount 归零即停」；未声明者保持既有 `lifecycle`
  三档 + 空闲回收语义**逐字节不变**（外部插件存量零漂移，构造性）。
- 声明 `activation` 的条目：`start` = `governor.start()`、`stop` = `governor.stop()`（由 loader 从 manifest 派生），
  `exclusive` 含 `stdio` 时其端口/进程约束进冲突检测。

> **落地注（2026-09-15，P3d 收口）**：接线形态与上文略有出入，如实记录——
> **只覆盖 lazy 档**（含缺省）：`registerMcpServerTools` 回报 `GovernedActivationFace`
> （`startLazy`/`stopLazy`），loader 在 `manifest.activation` 在场且插件未自登记时
> 把它交给 `ctx.activation.declare`。另两档**不经手**：`eager` 归装载期（装载即拉起、
> 卸载才停——生命周期不是组合），`with-window` 归窗口（开窗拉起、关窗即杀——组合
> 无权替它决定）。⇒ 净效果 = 声明 activation 的插件其 lazy 档受治进程「所有持有它的
> 卷都关了 ⇒ 进程停」，不再等空闲回收；**未声明 activation 的插件逐字节不变**（既无
> 声明也无 lazy 受治条目 ⇒ 不接线）。测试 `tests/mcp-activation-refcount.test.ts`（5 例）
> 钉住四态（装载零 spawn / 装配首次 spawn / 多卷复用 / 归零停）+ with-window 与 eager
> 不经手 + 拉起失败进第四栏。

---

## 3. 默认路径零漂移（构造性论证，非事后观察）

1. **出厂 43 插件零 `activation` 声明**（§1.1 实测）⇒ 激活集合恒空 ⇒ `retain`/`release`/`planFor` 恒 no-op；
2. standard / minimal 两个出厂 patch **没有** `requires`/`exclusive` 键 ⇒ 新解析面零输入；
3. `resolveRoster` **签名与实现一字不动**（第四栏不进它）⇒ 8 份快照 + `system-prompt.fixture`
   逐字节不变是**构造性结论**，不靠对拍自证；
4. 现有 MCP 测试（`tests/mcp-bridge.test.ts` 9 例 / `tests/plugin-loader.test.ts` 32 例）
   语义零改动 = 黄金标准（测试 diff 为零）；
5. **哨兵**：`tests/composition-roster.test.ts`、`tests/composition-default-off.test.ts`、
   `tests/seam-composition.test.ts` 若需改动 = 缺省语义被改坏（应零改动）。

---

## 4. 施工切分（三笔，每笔独立全绿独立 commit）

| 笔 | 内容 | 关键产物 |
|---|---|---|
| **P3a** 激活账地基 | `composition/activation.ts` + `ctx.activation`（挂 composition-services）+ `_assembleAgent` retain/release + manifest `activation` schema 与装载期校验（eager 拒载 / 声明-接线对齐）+ 叶性守卫 | 契约 **v38**（提交时重读）、service-catalog 重生成 |
| **P3b** requires / exclusive / 四栏 | `CompositionPatchSchema` 加两键 + 属主最长前缀推导 + `planFor` 校验 + exclusive 冲突 fail loud + `skipped` 栏 + 设置面板第四栏呈现 | `docs/composition/README.md` |
| **P3c** 收官 | §7.8 profile 断言 + 性能门对表（bench + 计数台新增两条）+ 设计件 §3.5/§3.8/§4/§8.3 与手册写回 | `reports/perf-after-S6P3.md` |

---

## 5. 测试与破测（新增从用户操作序列写；破测逐条验证能红）

| # | 断言 | 形状 |
|---|---|---|
| 1 | **序列 E 端到端** | 一个声明 `activation.lazy` + 受治 MCP 条目的插件：装载期 spawn 计数 **0** → 开含它的卷 refcount=1 且 spawn=1 → 第二卷 =2（不重启）→ 两卷全关 stop=1 → 另一卷从未启动过它 |
| 2 | **kill switch 负向对照** | 同一插件去掉 `activation` 声明 ⇒ 装载期即 spawn（P3 前语义）+ 装配期零新增调用 |
| 3 | **exclusive 冲突** | 两个组合各声明 `port:9310` 且都在位 → 后装配者被拒 + 原因含两个组合 id；先装配者不受影响 |
| 4 | **requires 缺插件** | 选择期拒（`sessionSelectionError` 返回具名原因）；解析期回退用户层 + error 可见（不抛） |
| 5 | **第四栏有生产者** | 激活 `start()` 抛错 → 该插件行被跳过 + `skipped` 含 `{id, reason}`；前三栏不变 |
| 6 | **对称释放** | Agent dispose / 切组合 → refcount 归零 → `stop` 恰一次；重复 release 幂等 |
| 7 | **装载期校验** | `activation.lazy:true` + `mcpServers[].lifecycle:"eager"` → 插件 error 记录（拒载）+ 原因可见 |
| 8 | **零漂移哨兵** | 无 `activation` 声明时 retain/release 恒 no-op（计数探针）；现有 MCP/loader 用例零改动 |
| 9 | **§7.8 profile 断言**（欠账） | 同一 preset 在 N=1/2/5 卷下：逐卷 tool-schemas 序列化**逐字节一致** + 激活账读数恰为 N（证明「会话数不进激活集合，也不进门禁矩阵」）。**不新增 baseline 快照**（同测试内对拍，零审批成本） |

**破测（每条注入缺陷确认能红，结果写进 commit message——P1/P2 先例）**：
① retain 不接线 → 1 红；② release 不挂 `ctx.effect` → 6 红（泄漏）；③ exclusive 冲突检测摘掉 → 3 红；
④ `skipped` 恒空 → 5 红；⑤ 装载期 eager 校验摘掉 → 7 红；⑥ `lazy` 缺省改 `true` → 8 红（零漂移哨兵）。

**计数台新增两条**（结构性、进红绿，`tests/composition-assembly-cost.test.ts`）：
⑦ 每装配每插件**恰一次** retain（无声明插件零次）；⑧ 激活账 `Map` 查表零拷贝（与 `seamScopeOf` 同款断言）。

---

## 6. 契约与文档

- **`plugins/types.ts` 在 `OPEN_SURFACE_CONTRACT_FILES` 里**（`contract-version.ts:149`）⇒ 加 `activation` **必升版**。
  四步（缺一 `tests/seam-contract-version.test.ts` 红）：① 改契约文件 → ② bump `OPEN_SURFACE_CONTRACT_VERSION`
  → ③ `docs/agents/open-surface-contract.md`「当前版本」+ 变更记录一行 → ④ `npm run gen:contract-fingerprint` → **同 commit**。
  **号一律在提交时点重读**（现 37；并发工作线会继续占号），预计 **v38**。
- `composition/roster.ts` 的 `CompositionPatchSchema` 加 `requires`/`exclusive`：该文件**不在**契约清单里，
  但它承载**用户 preset 的写法契约**（§7 判断题 6：是否补登记进指纹面）。
- **新 ctx 键 `activation` ⇒ `npm run gen:catalogs:service` 重生成** service-catalog（`doc-sync` 守护）。
- 文档写回：`docs/plugins/README.md`（manifest 新字段 + 激活/独占语义 + §0 平台契约总览）、
  `docs/composition/README.md`（组合 → 激活/独占面）、设置面板文案、
  设计件 §3.5 / §3.8 / §4 P3 行 / 新增 §8.3 施工实测、`AGENTS.md` §7 + `CLAUDE.md` 对应段。
- 生成物：**无** event-catalog 影响（本批不发新事件）；不动 `host-surface.baseline.json`（宿主桥不加面）。

---

## 7. 请示：八道判断题（**2026-09-15 用户逐条裁定：全部按建议**）

| # | 判断 | 建议 | 裁定（2026-09-15） |
|---|---|---|---|
| **A** | 激活逻辑归谁：新增 `ctx.activation`，还是复用 `ctx.effect`（register 只登记、启动写成激活回调）？kill switch 是否 = `activation` 缺省关闭即退回 P3 前语义？ | ✅ **新增 `ctx.activation`，挂进既有 `hologram/composition-services`（不新增插件条目）；kill switch = `activation` 整块缺席** | ✅ **照建议**：新增 `ctx.activation`，挂既有组合层 service（不动 `43 = 13 + 30` 计数与手册文案）；声明走 manifest、机制走插件代码，两侧互为前提（§2.3 双向校验） |
| **B** | exclusive 分类表：哪些进 exclusive？「不可共享」是否强制走 realm？ | ✅ **`pty`/`stdio`/`port:<n>`/`listener:<name>` 独占；`window` 可共享；exclusive 与 realm 正交**（不强制走乙路线） | ✅ **照建议**：闭集表落 §2.4；realm 逃生门仍留设计件 §7.4 单独立项 |
| **C** | requires 缺插件的失败面：装配期拒（沿 `sessionSelectionError` 严一档），还是标记 broken + 诊断「被跳过」栏可读？ | ✅ **两段式**：选择期**拒**（严一档）+ 解析期捕获网回退（不抛）+ 第四栏的生产者是**激活失败**而非「requires 缺」 | ✅ **照建议**：选择期拒 + 解析期回退；第四栏 `skipped` 的生产者 = 激活 `start()` 抛错 / exclusive 冲突（requires 缺走拒绝与 error 面，**不**进 skipped） |
| **D** | 第四栏措辞与呈现：三因合并一栏，还是拆两栏？ | ✅ **一栏 `skipped`，条目带 `{id, reason}`** | ✅ **照建议**：一栏带原因（前三栏单因且处置动作不同，故仍分栏） |
| **E** | 是否顺带补 §7.8 的 profile 断言（同 preset 在会话数 1/2/5 下有效快照逐字节一致）？ | ✅ **顺带补**（P3c） | ✅ **照建议**：P3c 补，同测试内对拍、**不新增 baseline 快照**（零审批成本） |
| **F** | 契约影响面：`plugins/types.ts` 必升版（预计 v38）；是否**同时**把 `composition/roster.ts` 补登记进 `OPEN_SURFACE_CONTRACT_FILES`？ | 必升版 ✅；roster.ts 补登记待裁定（倾向补） | ✅ **升 v38 + 把 `composition/roster.ts` 补登记进契约清单**（用户 preset 的写法契约此前靠「不在册」逃过指纹；同理会新增的 `composition/activation-service.ts` 一并登记——新 ctx 服务面同样是插件面契约） |
| **G** | 性能阈值是否随 P3 实收紧？ | ✅ **不收紧**（保持 热 <+15% / 冷 <+20% / 每卷 <+10% / 三卷 ≤1.75MB / 裸查表 <1µs） | ✅ **照建议**：阈值不动，实测写回 P3c 报告 |
| **H** | 批次切分 | ✅ **三笔 P3a / P3b / P3c**（§4） | ✅ **照建议**：三笔，每笔独立全绿独立 commit |

> **裁定附带的一条纪律（F 的推论）**：新增的 ctx 服务文件（`composition/activation-service.ts`）
> 与 `composition/roster.ts` 同批进 `OPEN_SURFACE_CONTRACT_FILES` —— 契约面口径统一为
> 「插件/用户可寻址的形状 = 开放面」，不再靠「文件不在清单里」逃过对拍。

---

## 8. 红线

- **不动** `resolveRoster` 的签名与纯度（§1.5 约束 1）；**不动** `AgentConfig`（28 字段，`gate.mjs` 断言）；
  **不动**出厂 preset 面（两轨零漂移是构造性结论）；**不新增 baseline 快照、不跑 `record`**（本批不触发 `baseline-change-request`）。
- `composition/activation.ts` 必须是**叶模块**（零项目内运行时 import，type-only 允许）——成环症状见设计件 §8.1 事实 1
  （`Cannot access 'BUILTIN_PRESETS' before initialization`，曾连坐 46 个测试文件）；叶性守卫照 `seam-scope.ts` 先例加一条。
- **并发工作线**（office 域 + 会话存盘换轨）同改文件：`contract-version.ts`、`session-persistence-service.ts`、`docs/**`、
  `AGENTS.md`/`CLAUDE.md`。纪律：每笔只 `git add` 本线显式路径（**不 `git add -A`**）；门禁红了先判归属
  （`git stash push -u -- <本线路径>` → 跑该用例 → `git stash pop`，链在一条命令里）；整片绕开它正在改的文件。
- **性能纪律**：判据一律 **min（p75 次之）**，绝对 ms 阈值不进红绿；测前确认无并发构建在跑；
  `npm run bench:assembly` 只报告。
- **测试纪律**：行为未变 → 测试零改动（黄金标准）；行为退役 → 同批整删；行为新增 → 从用户操作序列新写；
  禁止「改造后放回原位」；新增用例必须做**破测验证**并把结果写进 commit message。
- 本机纪律：凡 npm/vitest 命令先 `$env:NODE_ENV='test'`（否则 jsdom 假红 + `npm install` 剥 devDependencies）。
