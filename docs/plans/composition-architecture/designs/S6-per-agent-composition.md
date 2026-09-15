# S6 设计件 — per-agent 组合（从「全局默认值」到「每 Agent 一份组合」）

> **状态：草案（Proposed）——待用户审批后开 P0。本件只立契约，未动一行代码。**
> 所属线：composition-architecture（S0-S4 已竣工；本件兑现其 §6 未决项「preset 的 UI 选择面 /
> 首事件泛化触发条件」，并把组合粒度从「工作区装配级」下移到「每 Agent」）。
> 立项依据：2026-09-14 组合层审计（F1-F6 断链修复批已落地）+ 用户同日四轮拍板——
> ①「要并存的差异到**插件集合层**」②「**UI 与程序双入口**都要」③「并存粒度**以上都要**
> （同工作区两卷 / 同屏两个 Agent / 跨工作区）」④「**preset 不上线**——它是用户自己设置的环境，
> 平台只需提供环境」（④ 直接改掉本件的 I1 措辞、划掉 §7.2 分发、并新增 **P-1 authoring 环境** 批）。
> 边界依据：`docs/adr/project-constitution.md`（四条约定）+ `docs/adr/composition-boundaries.md`
> （强制层 / 能力契约层二分）。规则文件：`CONVENTIONS.md` §1.10、`INVARIANTS.md` #12。

---

## 1. 问题陈述

### 1.1 现状一句话

**组合今天不是「每 Agent 的一份值」，而是「全局状态的一次函数求值」。**

证据链（2026-09-14 审计实测，均已复核）：

| 事实 | 位置 |
|---|---|
| 行源 = 模块级活动注册表快照 | `composition/services.ts:276`（`_activeTools?.list() ?? []`——九条通道同款） |
| 组合解析 = 全局状态的纯函数 | `composition/roster.ts:224` `factoryComposition()`（读模块级单点） |
| 选择 = 全局设置一个字段 | `settings.ts` 的 `composition.preset`（`syncPresetSelectionFromSettings` 消费） |
| seam 裁剪面 = 模块级单值 | `composition/seam-resolution.ts:45` `let current` + 6 个消费单点读模块态 |
| loopEvents 事件面 = 全局读 | `agent/events.ts:252` `seamDisabled('loopEvents')` |
| 卷结构**没有**组合身份 | `ui/chat-session.ts:545`（`StoredSession`）/ `:627`（`SessionSnapshotData`）——只有 `tokensUsed` / `compose` 之类，无 `presetId` |

### 1.2 由此产生的三个已证实缺口

1. **能力子集按卷不同：机制在，但入口不在。** 会话工厂已能按会话换源（`workspace.ts` 的
   `compositionOverride` 路径 + 会话作用域注册表），但选择的作用域是全局的，且没有卷级存储/UI/
   记录——**没有一个用户动作能触发这条路径**（审计 F4：该分支在默认配置下恒活跃，却对用户不可见）。
2. **实现/后端按卷不同：做不到。** seam provider 的选择是进程级的（`seam-resolution.ts:45`），
   同一个 fs 工具不可能 A 卷走本地实现、B 卷走沙箱实现。
3. **插件集合按卷不同：做不到。** 贡献通道与装载都是全局 boot 期的；插件的副作用（常驻进程/
   连接/PTY）也没有会话级生命周期。

### 1.3 谁在等这个能力（用户拍板的三个画面）

见 §2。归纳：**同屏并排两个不同组合的 Agent**，其中一个可能是只读审查卷、一个是施工卷，组合
可以由人也可能由程序（MCP 客户端 / 评测自举流程）指定。

### 1.4 明确不做（本件的边界）

1. **不抄 DSH 的 scope realm 全量。** DSH 的 preset 是「往 agent scope 挂一棵 cordis 子树」，因为它
   的注册表天然按 scope 分层；兰台的注册表是模块级单例，照抄等于重画组合层地基（9 通道 + 5 注册表
   + 装载/回滚/授权 + 门禁体系）。本件用**视图 + 引用计数**（§3.1 甲）拿到同样的用户价值，
   只在**资源型插件**上保留 realm/子进程逃生门。
2. **不开放无界组合空间。** 组合必须是**有限可枚举的 preset 集合**（§3.7 不变式 I1）——
   否则前缀缓存的字节契约无法验证，convergence 矩阵必然爆炸，排查成本不可控。
3. **不把模型/思考档位、审批/沙箱策略、agent loop 划进组合。** 这条与 DSH 一致（它把这三样明确
   排除在 preset 之外）。兰台现状：model/thinking 已有独立的 per-session 覆盖路径
   （`workspace.ts` 会话工厂 `sessProv`），loop 不在 `SEAM_DOMAINS` 里——**S6 保持这两条边界不动**。
4. **不做每会话子进程。** DSH 明确否掉过（「a transport project rather than a composition one」）：
   隔离绝对，代价是流式/审批/投影全要代理。

---

## 2. 目标形态（用户序列，逐条可验收）

**序列 A — 同工作区两个卷，能力子集不同。**
用户开卷 A（施工，standard）→ 卷头选「审查」→ 开卷 B → B 的模型可见工具面不含 shell/写工具，
A 的**完全不被动**；两卷并存时各自跑自己的工具面。
断言：B 的请求体 `tools` 缺写工具；A 的请求体逐字节不变；`preset/selected` 与卷落盘身份一致。

**序列 B — 同屏并排两个 Agent（跨组合）。**
纸壳里左审查右施工，两个面板各自卷头显示自己的组合名；在 A 面板切换组合**只影响 A 的下一次装配**，
B 不动；A 切组合后，B 的注册表引用与工具实例不重建。
断言：两个 Agent 的 `ctx.get('composition').id` 不同；全屏只有 A 的（重新）装配发生。

**序列 C — 程序指定组合。**
外部 MCP 客户端 / 评测流程经会话创建入口传 `preset: "review"` 起卷 → 该卷工具面/提示词/事件面
全部按该组合解析；组合不可解析（行 id 不可寻址 / `requires` 缺插件）→ **拒绝创建**并给出原因
（错误不静默，沿 F1b 语义）。
断言：RPC/工具契约含组合参数；错误路径返回结构化原因；解析结果与 UI 选同一 id 时逐字节一致。

**序列 D — 实现按卷不同（P2 后）。**
同一个 `fs` 域工具，A 卷走 builtin 本地实现、B 卷走沙箱/远端实现；两卷并存互不串味。
断言：两卷对同一 `read_file_content` 调用落到不同 provider（provider 侧调用计数可分辨）。

**序列 E — 插件集合按卷不同（P3 后）。**
某插件的常驻服务只在选中它的卷上激活；该卷关闭/释放后服务停止；另一卷从未启动过它。
断言：激活计数随引用增减；无引用时 `dispose` 被调用；独占资源冲突时装配期 fail loud。

**序列 F — 用户在单二进制里配出第一个 preset（P-1，**这是整条线"活着"的前提**）。**
用户拿到 release 单 exe（不动源码、不装 npm）→ 从设置面板「组合」节点「打开组合目录」（目录不存在则
按需创建）→ 点「复制内置 standard 为模板」得到一份可跑的底稿 → 改两行（禁用某工具行）→ 面板上点
「重新扫描」→ 新 preset 出现在列表 → 选中 → 新卷即用该组合 → 再故意把行 id 写错 → 选中被拒 +
原因可见。
断言：全程不重启、不碰源码、不手建目录；坏文件的失败面可读（沿 F1/F1b）；重扫后 roster 与磁盘一致。
现状（施工前实测）：目录不自动创建（`plugin_assets.rs:129-144` 只算路径）、组合域**零 RPC**
（只有插件的 `plugin_dir`，`rpc.rs:752`）、`open_external` 具备开目录能力但未接
（`commands/oauth.rs:167-191`）、discovery 是 boot-once（`shell/boot.ts` 的 `presetDiscovery ??= …`）
且 preset 子树不在 watcher 范围（`composition_watcher.rs` 只盯根级文件）——**四条全缺**。

---

## 3. 设计

### 3.1 核心抉择：副作用隔离走哪条路

| 路线 | 做法 | 买到 | 代价 | 结论 |
|---|---|---|---|---|
| **甲 视图 + 引用计数** | 注册表保持全局；**每 Agent 的组合值**决定可见行集与 provider 选择；资源型插件懒激活 + 独占声明 + 引用计数 | §2 序列 A/B/C/D + E 的绝大部分 | 中（P1-P3，周计） | **主路线** |
| 乙 scope realm | 9 通道 + 5 注册表 scope 化，每 agent 挂子树 | 甲的全部 + 插件副作用的强隔离 | 大（月计 + 门禁重做 + 授权面） | **仅作逃生门**：声明了独占资源的插件可走 |
| 丙 每会话子进程 | 每卷一个 agent 进程 | 隔离绝对 | 流式/审批/投影全代理 | 不做 |

**甲路线的关键依据（本件的技术支点）**：兰台**已经**有 per-agent 组合值
（`agent/runtime/runtime.ts:683` `ctx.set('composition', composition)`——每个 Agent 一个 fresh ctx
带自己的组合）与 per-agent 注册表（`:668-670` 克隆一份自有 `ToolRegistry`）；**seam 裁剪已经跑通
「全局注册表 − 本组合的裁剪集 = 消费视图」这个模式**（`activeFsProviders()` 那族写法）。
所以甲不是新发明，是**把已有的两个机制从「装配级」推到「每 Agent 级」**，并把唯一的模块态残留
（`seam-resolution.ts:45`）换成「装配期解析 + 值注入」。

### 3.2 数据模型

**组合身份（新增）**

```ts
/** 组合身份 = preset id（内置/用户/程序指定同源）。 */
type CompositionId = string; // 'standard' | 'minimal' | 用户 preset id
```

**preset 数据模型扩展（`roster.patch.yml`，全部可选——不写 = 现语义，向后兼容）**

```yaml
tools:
  - id: plugin/hologram/web-domain/web_search
    disabled: true            # 现行语义：显式禁用（层内后写胜）
  - id: plugin/hologram/review-domain/readonly_audit
    disabled: false           # 现行语义保留：回开「默认关」的行（roster.ts:35 已立）
requires:                     # 新增：组合依赖的插件（装载器保证在册；缺 → 该 preset 标 broken + 原因可见）
  - hologram/review-domain
exclusive:                    # 新增：组合要独占的资源（冲突在装配期 fail loud，不在运行时静默）
  - fs:sandbox
```

**贡献面扩展（插件出货「默认关」的行）**

```ts
interface ToolContribution {
  id: string;
  factory: ...;
  noCache?: boolean;
  defaultOff?: boolean;   // 新增：登记但默认不进任何组合；preset 用 disabled:false 回开
}
```

**组合产物（`ResolvedComposition` 之上加一层身份与激活账）**

```ts
interface AgentComposition extends ResolvedComposition {
  id: CompositionId;
  /** 本组合实际启用的「默认关」行 id（诊断面用：区分「未选中」与「被禁用」）。 */
  enabledBySelection: string[];
  /** 本组合声明的独占资源 → 声明者（冲突 fail loud 的依据）。 */
  exclusiveClaims: Record<string, CompositionId>;
}
```

### 3.3 穿线：选择的作用域与解析入口

**两层选择（全局默认 + 卷级）**：

- 全局默认：`settings.composition.preset` **保留**（新卷不带选择时用它）——语义不变，不迁移旧数据。
- 卷级选择：卷结构新增 `presetId`（`ui/chat-session.ts:545` 的 `StoredSession` + `:627` 的
  `SessionSnapshotData`）+ 恢复期读回。
- 程序指定：会话创建入口（RPC / MCP 工具）带 `preset` 参数，**优先级 = 显式参数 > 卷级 > 全局默认**。

**解析入口**：沿用 2026-09-14 修复批建立的 `composition/preset-assembly.ts`：

```ts
selectionError(id)        // 校验（行 id 可寻址 / requires 在册 / patch 可装载）——拒绝切换的依据
effectiveComposition(id)  // 生产唯一解析入口（捕获网，永不抛出，失败回退「只叠用户层」+ 原因可见）
```

**装配注入**：现有 `workspace.ts` 会话工厂的 `compositionOverride` 路径**保持不变**（它已经是正确的
形态：比较 → 建会话作用域注册表 → 传 `createAgent` 第二参）；S6 只是让**选择**能从卷/参数来，
并去掉「引用恒不等 → 恒重建」的浪费（P1 里把比较改成**组合身份比较**：`id` + 用户层 hash +
贡献代数，而不是对象引用）。

### 3.4 消费点改造：把模块态换成值

| 消费面 | 现状 | S6 |
|---|---|---|
| tools / prompts / capabilities | 已 per-agent（`runtime.ts:599/660` + 会话注册表） | 不变（P1 只补「默认关 + 回开」的行语义） |
| 5 个 seam provider 视图 | 模块态（`seam-resolution.ts:45` + 6 单点：`services.ts:290` / `fs-service.ts:85` / `shell-service.ts:79` / `subagent-service.ts:85` / `session-persistence-service.ts:104` / `events.ts:252`） | **装配期解析成值**（`activeFsProviders(comp)` 之类），经 rowCtx/闭包注入工具族；`emitLoopEvent` 由事件所属 agent 的组合决定（emit 调用点都在 agent 上下文内） |
| shell 行 | 全局，boot 期一次（重启生效） | 不变（壳行无 dispose 语义，S2 裁定继续有效）；组合的 shell 域条目对**已启动进程**仍不生效，如实声明 |
| 诊断面 | `diagnostics.disabled` 一个扁平列表 | 拆两栏：**未选中**（默认关且未被选择启用）/ **被禁用**（显式 disabled）+ **被跳过**（requires 缺 / exclusive 冲突） |

> 兼容纪律：没有任何组合上下文的旧路径（如无 agent 的工具直调）继续读**全局当前选择**——
> 缺省语义 = 今天的行为，零漂移。
>
> **落地修正（2026-09-15，P2 施工单 `work-orders/WO-S6P2-seam-value-injection.md`）**：
> ① 携带路径不是「经 rowCtx/闭包注入」，而是**owner 键控表 + 调用点按 `_owner_id` 查**
> （`composition/seam-scope.ts`）——实测证据：fs/shell 两族的工具实例经
> `plugins/builtin/contribution-helpers.ts` 的 `family ??= build(rowCtx.codingExec)` 锁存在
> **首次装配的 rowCtx** 上，往 `ToolRowContext` 扩字段对这两族**结构性无效**（用户裁定 A）。
> ② `emitLoopEvent` 不需要「由事件所属 agent 的组合决定」的显式传参：**每 Agent 一条总线**
> （`agent.ts` 的 `_loopEvents`），Agent 构造期 `setSeamView` 灌一次，10 个 emit 调用点零改动。
> ③ `llm` 单点经 `createProvider` 的 `options.seamView` 注入（三个「有组合上下文」的 provider
> 构建点：会话工厂 + 两条热切换路径）。
> ④ **`sessionPersistence` 本批不做**（用户裁定 D）：per-volume 后端选择的正确语义要求
> **读也按该卷组合**，而读盘时点组合尚未解析（卷内 `presetId` 恰在待读的那卷里 = 鸡生蛋）；
> 真做需另立「卷 → 组合」外部索引，属独立批次。该 seam 本轮仍读全局当前选择（如实声明）。

### 3.5 插件激活与独占（P3 的核心）

```
登记（全局，boot 期）           → 行/段/capability 进注册表，**不启动任何副作用**
选中（装配期，某组合 requires 或行被启用） → 激活：refcount++，首次激活时启动副作用
释放（该 Agent dispose / 切组合）          → refcount--，归零时停止副作用
独占冲突（两个组合声明同一 exclusive 资源且都在位） → 装配期 fail loud（拒绝后装配者，原因可见）
```

- **副作用启动点收口**：新增 `ctx.activation`（或复用 `ctx.effect` 语义）——插件在 `apply()` 里
  **只登记**，把「启动」写成激活回调；守卫测试钉「资源型插件不得在 apply 期直接起进程/连端口」。
- **声明式**：manifest 增 `activation: { lazy: true, exclusive: ['fs:sandbox'], resources: [...] }`。
- **逃生门**：`exclusive` 里声明「不可共享」的资源类型（如 PTY 会话、stdio 子进程）时，
  允许该插件走 realm / 子进程隔离（乙路线），实现留 P3 之后单独立项。

### 3.6 记录与重建（P0）

- 卷结构加 `presetId`；`preset/selected` 事件**保留**（它是"空白期改选"的日志事实）。
- 恢复期：`presetId` 缺省 → 全局默认（旧卷兼容，沿 `chat-session.ts` 既有「旧存档无字段 = 从空开始」
  的先例）；`presetId` 存在但不可解析 → **回退全局默认 + 可见提示**（不静默、不阻断开卷）。
- **不泛化 `session/init`**：S4 §6 立的泛化触发条件是「第二个**创建时点事实**」；S6 引入的卷级选择
  仍是同一个事实（preset id），**不触发**——泛化留待工作区绑定正式化那条线。
- 卷头只读标签：显示该卷的组合名（DSH「控制在此不承诺」同款——运行中的卷不给切换控件，
  切换只对新装配生效）。

### 3.7 门禁与 baseline 策略

**不变式 I1（硬约束，写进 `CONVENTIONS.md`）**：**门禁矩阵的维度 = 出厂 preset 集合**
（`standard` / `minimal`），**不是用户 preset**。

- 出厂 preset 是字节契约的锚：每个出厂 preset 必须有 `baseline/preset-<id>/` 快照，缺快照 = 门禁红
  （**这条是 P0.5 的目的**）。
- **用户 preset 空间无限，按定义进不了门禁**（用户 2026-09-14 纠正：preset 是用户自己配的**环境**，
  不是出厂物）。用户 preset 的护栏 = **运行时校验 + 诊断面**：`selectionError()` 选择前校验
  （行 id 可寻址 / `requires` 在册 / patch 可装载）、不可解析**拒绝切换**并显示原因、解析失败回退
  「只叠用户层」组合（2026-09-14 修复批已落地）。
- 因此禁止把「任意维度自由组合」写进出厂面（如 per-域开关矩阵塞进内置 preset）：出厂面必须是
  **有限可枚举**的——门禁、字节契约、前缀缓存的验证都挂在这个有限集上。
- 新增/修改 preset 的模型可见面 → 走 `baseline-change-request` 审批，`record` 只在审批提交里跑。
- P1/P2 之后补一条 **profile 断言**：同一 preset 在不同会话数（1/2/5）下的有效快照逐字节一致
  （证明「会话数不进矩阵」）。**状态：未做**（P2 未顺带；须补一条测试，台账见 §7）。
- **性能门（P3 前置）**：先测再改——per-agent 组合的装配开销（注册表构建耗时 / 常驻内存 /
  两卷并存的增量），阈值由本批实测确定并写回本件；DSH 的量级参考是「每卷 ~0.17MB（minimal）~
  1.31MB（standard）、挂载 38ms/135ms」，兰台必须在同等口径下自测。
  **✅ 已测（2026-09-15，P2 后基线；台子 = `src-ui/tests/bench/`，报告 =
  [`reports/perf-baseline-S6P2.md`](../reports/perf-baseline-S6P2.md)）**：
  - 开一卷（热路径挂载，含 prompt 组装）**≈4.3ms**（其中 prompt ≈1.8–2.1ms）；冷装配
    （新通道 apply：建族 + 全量 schema 生成）**≈31.5ms**，冷/热 **≈5.1×**。
  - **每卷常驻内存 ≈0.80MB**（standard 0.79 / minimal 0.80；逐卷边际线性，三卷合计 1.57MB）。
    **与 DSH 的口径差异如实记录**：DSH 有 minimal/standard 分化（0.17 vs 1.31MB），兰台两个
    preset 同量级——因为兰台工具实例**跨卷共享**（行级 `instanceCache` + 内层族缓存），每卷只
    新增 Agent 实例 + 注册表骨架 + 会话日志；⇒ **每卷内存成本与组合大小基本无关**。
  - 调用期（P2 新增的 owner 查表）：裸查表 **87ns**，占 fs 派发全链 11.6µs 的 **0.75%**。
  - **方法纪律（本次实测的硬结论）**：判据一律用 **min**（p75 次之）、**不用 mean**——
    本机 DSH 宿主进程常驻一核，mean 的 rme 实测到 **67%**，而 min 两轮漂移 **<5%**；
    绝对 ms 阈值**不进红绿**。
  - **P3 回归阈值**（同机同口径，min 判据）：热路径挂载 <+15% · 冷装配 <+20% ·
    每卷常驻 <+10%（≤0.88MB）· 三卷合计 ≤1.75MB · 次卷边际 ≤1.5×首卷 · 裸查表 <1µs ·
    fs 派发全链 <+10%。
  - **结构性回归另立红绿**：`src-ui/tests/composition-assembly-cost.test.ts`（7 例，与机器
    负载无关）钉住「行工厂每装配恰一次/行」「内层族缓存」「行级实例缓存」「`noCache` 每装配
    重创」「新 apply 必重建」「组合解析与 seam 查表零拷贝」。**三层缓存是独立的**（贡献
    factory 内层族缓存 → 行级 `instanceCache` → `noCache` 绕过）——测内层必须绕过行级，
    否则改坏了也照绿（2026-09-15 破测实证）。

### 3.8 诊断面（与 P1 同批，不可后置）

引入选择集之后，**"某工具不见了"有三种原因**（未选中 / 被禁用 / requires 缺），必须可见可分。
现行只有 `diagnostics.disabled` 一个扁平列表（且混装了 seam id，审计 F2 附注），不足。
方案：组合诊断结构扩为四栏 + 设置面板「组合」节分栏渲染 + **卷头 hover 显示本卷组合与来源**
（全局默认 / 卷级 / 程序指定）。

> **落地修正（2026-09-15，P1b 实测）**：P1 只落**三栏**——`unselected`（未选中：
> `defaultOff` 且未被任何层 `disabled:false` 回开）/ `disabled`（被禁用：显式 `disabled:true`）/
> `seamCapped`（seam 裁剪：从 `disabled` 搬出，此前混装）。第四栏 `skipped`（`requires` 缺 /
> `exclusive` 冲突）**不在 P1 预造空栏**：`requires` 是 P3 才引入的字段，空栏即化石（本仓有
> 明确纪律，`diagnostics.overridden/.inserted` 就是标本）。「卷头 hover 显示来源」随卷头 UI 落 P5；
> P1e 的**创作坞芯片**已用同一读面（`sessionCompositionInfo`）显示来源与不可用原因。

---

## 4. 批次序列（每批独立 commit、独立全绿；批间无审批门，`record` 例外）

| 批 | 内容 | 验收断言 | 门禁 | 行为变更（commit message 必写） |
|---|---|---|---|---|
| **P-1（authoring 环境）** ✅ **已落地（2026-09-14，待 commit）** | **用户不动源码就能配出 preset**（用户 2026-09-14 纠正：preset 不是出厂物，是用户自己的环境——环境没建，后面全是空转）：① 组合目录 RPC（返回路径 + **按需 `create_dir_all`**）② 「打开组合目录」动作（服务端算路径 + 系统文件管理器；**不放宽** `open_external` 的 http(s) 限制）③ 「复制内置 preset 为模板」动作（DSH copy-only authoring 的等价物；**拒覆盖** + id 围栏 + 内置 id 拒绝）④ **免重启重扫**（`rescanPresets` + 面板动作）⑤ 面板显示组合目录路径与写法提示 | §2 序列 F：全新机器 → 建 preset → 出现在列表 → 选中生效 → 写错 → 原因可见，**全程不重启、不碰源码** | vitest + build + biome + convergence（双轨）；Rust 侧 `cargo test`（3 例：建目录/幂等不抹内容/任意根）+ RPC 契约文档重生成 | 新增 RPC `composition_dir`（契约升版）；设置面板新增作者动作；**重启才发现新 preset 的行为退役** |
| **P0.5** ✅ **已落地（2026-09-14，待 commit）** | minimal 快照重录（`office` 域漏录，2026-09-13 起漂移）+ `verify:convergence` 改**双轨**（CI 经同一 npm script 自动获得第二轨，不改 workflow 文件） | 两轨都 exit 0；「双 preset 零漂移」重新成立 | 走 `baseline-change-request`（已留痕：`src-ui/tests/convergence/baseline-change-request.md` 首条） | 门禁覆盖扩为 2 preset；convergence job 时长 ×2 |
| **P0** ✅ **已落地（2026-09-14）** | 卷结构落 `presetId`（`StoredSession` / `SessionSnapshotData` 两处 shape + 两处 save 路径 + 恢复期登记）+ 会话工厂**按卷内记录的组合重建**（`agentSessionState` 卷级登记，工厂读它）+ 恢复期校验与可见提示（不在册 / 行 id 不可解析 → 提示 + 回退用户层组合）；连带修复 `renameSessionFile` 改名不再抹掉 `tokens`/`compose` | 关卷重开：组合身份登记一致；旧存档无字段 = 无记录（不猜、不迁移）；坏组合可见且卷照常打开 | vitest + build + biome + convergence 双轨 | 卷文件多一个字段（旧卷 = 缺省）；新增"本卷组合不可用"提示；**改名不再丢数据** |
| 注（P0 范围调整） | **「卷头只读标签」移入 P5**（它属 UI 面，与 chip / 同屏并排同批做，且需要"哪个是当前卷"的展示位）；**「诊断四栏化数据面」移入 P1**（"未选中 vs 被禁用"要等选择集语义落地才有区分度）。P0 只做**落盘 + 登记 + 校验 + 提示**这条不可再省的闭环 | — | — | — |
| **P1** ✅ **已落地（2026-09-15，五笔：P1a `6e3b3fb2` / P1b `6abbcc30` / P1c `9196f5da` / P1d `cca04a58` / P1e `fd30742c`；另基线修复 `8c7abf92`）** | 卷级选择全链路（用户 2026-09-15 拍板「我觉得OK，开工」，按施工单四批 + UI 一笔落地）：**P1a** 卷内组合记录不再被落盘改写（工厂把记录回述给 Agent 镜像——旧行为：重开旧卷后本卷再落一次盘就把 `presetId` 改写成全局默认，记录静默蒸发）；**P1b** 选择集语义（`ToolContribution.defaultOff` + `disabled:false` 回开，**开放面契约 v31**）+ 诊断三栏；**P1c** 卷级选择写路径（`selectSessionPreset`：校验 → 空白闸 → 拆句柄 → 登记 → 空白卷即时重建；`sessionSelectionError` 比 `selectionError` 严一档：未知 id 也拒）；**P1d** 会话工厂判据从对象引用换轨为**组合身份**（层内容 + 贡献代数，输入派生——消掉「每卷白建注册表」的 F4 浪费，且含代数 ⇒ 不复用陈旧注册表）；**P1e** 创作坞组合芯片（两态：无主态 = 新卷出生默认 / 空白卷 = 卷级 / 跑过一轮 = 只读标签） | §2 序列 A/B：空白卷可拨且立刻生效（有句柄则当场重建）、跑过一轮被拒（控件锁 + 写路径二道闸同一把尺子）、两卷工具面互不影响（身份不同 ⇒ 各建注册表；身份相同 ⇒ 复用）、卷级选择不写全局真源 | vitest + biome 0/0 + build（30 产物）+ doc-sync + **convergence 双轨零漂移**（P1 不动出厂 preset 面 = 构造性证据） | 组合按卷生效（同工作区两卷可不同）；设置行左端新增组合芯片、行内序由「模型→spacer→权限→思考→墨量」变为「模型→组合→spacer→…」（**故意规格变更**，row-order 契约随之显式改写）；诊断面由一栏拆三栏（「禁用行」不再混装 seam id）；卷文件 `presetId` 在重开后不再被改写；新建卷装配少一次注册表构建 |
| **P2** ✅ **已落地（2026-09-15，两笔：P2a `a1e83c8f` / P2b `53924344`；施工单 `work-orders/WO-S6P2-seam-value-injection.md`，用户逐项裁定 A/B/C/D/E/F 见 §7 与 §8）** | seam 选择从模块态 → 装配期值注入：**P2a** 新增键控叶模块 `composition/seam-scope.ts`（装配期登记裁剪面，键 = Agent bus id）+ `seamDisabled(domain, view?)` 可选 view + fs/shell/subagents 三消费点 + `AgentEventBus.setSeamView`（每 Agent 一条总线）；**P2b** llm 单点（`activeLlmAdapters(view?)` + `CreateProviderOptions.seamView` + 三个 provider 构建点）。**契约 v36（P2a）/ v37（P2b）**——四步流程各走一遍 | §2 序列 D（⑨ 同一工具实例两卷两 provider 且互不串味）；旧无组合上下文路径零漂移（⑫ 哨兵 + ①-⑧ 零改动） | **不新增 seam 域 per-composition 快照、不触发 baseline-change-request**（用户裁定 B：两轨的 `seamDisabled` 构造性为空 ⇒ 新快照零信息量，零漂移由既有 8 份快照逐字节覆盖；信息量落在行为测试） | 同一工具可按卷走不同 provider；`seam/sessionPersistence` 例外仍全局（如实声明） |
| **P3（成本悬崖）** | 插件激活/引用计数/独占声明/`requires`/fail loud + 诊断「被跳过」栏 | §2 序列 E；无引用即释放；冲突装配期拒绝 | + 激活生命周期测试 + 性能门 | 插件副作用改为按需激活；新增 manifest 字段 |
| **P4** | 程序入口：会话创建 RPC 带 `preset` / MCP 工具参数 / 评测自举 | §2 序列 C；与 UI 同 id 解析逐字节一致 | + RPC 契约重生成 + e2e | 新增 RPC 参数（契约版本升版） |
| **P5** | UI 面：卷头 chip（含 blank-only 锁）+ 同屏并排两 Agent | §2 序列 B 的 UI 层；锁生效（跑过一轮的卷拒绝切换） | + UI e2e + golden | 用户可见的新控件与新锁 |

**依赖**：**P-1 → P0** → P1 → P2 → P3 → P4/P5（P4/P5 可并行）；P0.5 与 P-1/P0 无依赖，但必须在 P1
之前落地（没有可信的 minimal 轨，出厂 preset 的快照这条腿是瘸的）。**P-1 虽然最小，但它是这条线
"活着"的前提**：用户配不出 preset，后面的 per-agent 组合就是没人加油的发动机。

---

## 5. 回滚

- 每批独立 commit；P0-P2 回滚 = revert 单批（无存储格式破坏：`presetId` 是**可选新增字段**，
  旧卷缺省即今天的语义）。
- **P3 的 kill switch**：manifest 的 `activation` 缺省关闭时，退回「登记即激活」的 S6 前语义——
  即 P3 的全部行为可由配置一次性退回（不靠 revert 代码）。
- **不变式破坏即停**：任何一批让「standard preset 的模型可见面」发生非预期字节变化 → 停批，
  走 baseline-change-request，不许直接 record。

---

## 6. 风险表

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | 门禁矩阵膨胀（每 preset × 每 phase） | 高 | 中 | 不变式 I1 + 会话数不进矩阵 + profile 断言 |
| R2 | 前缀缓存跨组合串味（两卷并发各自字节面） | 中 | 高 | 每卷独立注册表已成立；P1 补并发两卷的请求体逐字节断言 |
| R3 | 插件生命周期泄漏（激活不释放 / 释放早了） | 中 | 高 | P3 的引用计数测试 + fail loud + `ctx.effect` 归零断言 |
| R4 | 诊断复杂度（三种"不见了"） | 高 | 中 | §3.8 与 P1 同批，不允许后置 |
| R5 | 与「会话物理归属工作区」线的交互（`workspace-session-ownership-rework` P5 未收） | 中 | 中 | P0 前对齐该线状态；跨工作区粒度（§2 序列 B）落在它之后 |
| R6 | 性能回退（per-agent 注册表重建面扩大） | 中 | 中 | P3 前置性能门（§3.7）；P1 顺手消除 F4 的恒重建 |
| R7 | 组合语义漂移成"第二套权限系统" | 低 | 高 | §1.4 边界写死：模型/审批/loop 不归组合；程序指定组合**不授予**超出会话创建的能力（沿 DSH 论证：能起会话者本就能跑 shell） |

---

## 7. 未决项（施工中定，或用户拍板）

1. **用户 preset 数量/复杂度上限**：不做硬上限（用户环境，空间本就无限），但**出厂面**必须有限
   （I1）。引导策略：面板提示"每份 preset 是一份完整组合"，数量由用户自担；不做配额。
2. ~~**preset 分发**~~ **不做（2026-09-14 用户纠正）**：preset **不是出厂物、不是分发单位**——
   它是用户自己配的环境，平台只负责"提供环境"（P-1）。分发的单位是**插件**；将来若要"分享
   一个 preset"，路径是**复制目录**（DSH 的 copy-only authoring 同款），不是新打包通道。
   推论：manifest **不加** preset 字段；`docs/plugins/README.md` 的 preset 节应改述为"环境"。
3. **独占资源的分类表**：哪些资源进 `exclusive`（PTY / stdio 子进程 / 端口 / 全局监听），
   以及"不可共享"是否强制走 realm。
4. **realm 逃生门的触发标准**：什么条件下允许插件要求 scope 隔离（P3 之后单独立项）。
5. **程序指定组合的鉴权**：是否需要与权限模式联动（当前论证：不联动，理由见 R7）。
6. **同屏并排的布局语义**：两个 Agent 面板是否共享工作区（→ 同一注册表 deps）还是各自独立（→ 两套 deps）。
7. **P-1 的模板来源**（施工中定）：③ 的"复制为模板"取内置 `standard`（零 patch 底稿 + 注释齐全）
   还是 `minimal`（带真实禁用样例）；倾向**两者都给**（standard = 空白底稿 / minimal = 现成范例）。
   **已落地**：P-1 两模板都给（`preset-authoring.ts` 的 `TemplateSource = 'standard' | 'minimal'`）。
8. **profile 断言（§3.7 欠账，P2 未顺带）**：同一 preset 在会话数 1/2/5 下的有效快照逐字节一致
   ——证明「会话数不进门禁矩阵」。属 P3 起手可顺手补的一条测试（口径：同一 preset、N 卷并存、
   对拍 `tool-schemas.effective` 字节）。

---

## 8. 审批与复审记录

- **2026-09-14 用户拍板三项**（本件的立项输入）：差异到插件集合层 / UI 与程序双入口 / 全粒度并存。
- **2026-09-14 用户纠正一项**（改本件 I1 与 §7.2，并新增 P-1 批）：**preset 不上线、不是出厂物——
  它是用户自己设置的环境，平台只需提供环境**；连带暴露的真问题：单二进制下用户**配不出** preset
  （目录不建 / 无打开动作 / 无模板 / 加完要重启——§2 序列 F 的四条实测缺项）。P-1 因此成为本线首批发。
- 本件状态：**已批准并执行中**（P-1 / P0.5 / P0 / **P1 全部落地**；下一批 = P2）。原「批准后三步」已兑现：
  ① I1 已进 `CONVENTIONS.md`；② P0.5 的 `baseline-change-request` 已留痕（`37418b74`）；
  ③ P-1 起每批独立 commit + 门禁四连。
- **2026-09-15 用户批准 P1 施工单**（原话「我觉得OK，开工」）：同意「P1a→P1d 四笔 + UI 一笔」的切分、
  **诊断先落三栏**（`skipped` 留 P3，不预造空栏）、chip 落**创作坞设置行左端**（甲案：模型 | 组合，
  与「开口即开卷」同构），身份比较取**输入派生**（含贡献代数）而非产物内容派生。
- **2026-09-15 用户逐项裁定 P2 施工单六道判断题**（`work-orders/WO-S6P2-seam-value-injection.md` §7）：
  **A = owner 键控表**（准偏离设计件字面「经 rowCtx/闭包注入」，理由见 §3.4 落地修正①）；
  **B = 不新增 convergence 快照、不触发 baseline-change-request**（零漂移走构造性论证 + 行为哨兵）；
  **C = 新增独立叶模块 `composition/seam-scope.ts`**（不塞进 `agent/session-context.ts` 的 `OwnerContext`）；
  **D = `sessionPersistence` 单点本批不做**（半吊子「写卷级/读全局」比全局更糟，需另立外部索引）；
  **E = `ResolvedComposition.seams`（零生产读者化石）本批不碰**（维持现状）；
  **F = 切两笔 P2a/P2b**（每笔独立全绿独立 commit）。

### 8.2 P2 施工中实测的环境事实（下一批动手前必读）

1. **契约版本已漂到 v37**（接手文档里的「现 31 / P2 升 v32」全部过期）：并发工作线（会话存盘换轨
   Phase 1/2/3a/3b + 触发点 B）占了 v32-v35，P2 的 P2a/P2b 又各占一版（v36/v37）。**纪律：升版号
   一律在提交时点重读 `contract-version.ts`**——按文档里的号写会直接红在
   `tests/seam-contract-version.test.ts`。另外该线正在改 `session-persistence-service.ts`（动作面
   扩为八动作）、`contract-version.ts`、`AGENTS.md`/`CLAUDE.md`——本批据此**整片绕开**
   `session-persistence-service.ts`（连裁定 D 也落在同一侧），`AGENTS.md`/`CLAUDE.md` 只在收官
   写回提交里动。
2. **两处「源码窗口守卫」会咬人**（`tests/provider-hotswap.test.ts` 与
   `tests/composition-preset-assembly.test.ts`）：它们按 `src.slice(i, i + N)` 的**固定字符窗口**
   断言 `workspace.ts` 的工厂正文，实测锚点到窗口边界只剩 **370 字符**余量、另有断言要求正文里
   出现 `model: eff.model, thinking: eff.thinking` 的**逐字**子串。P2b 的 llm 注入因此做成
   模块级单一派生点 `sessionSeamViewFor(storeId, sessionId)`（而不是在工厂内联展开）——既降重复，
   又把新增字符控制在窗口余量内（终态 3348/3600）。**改 `workspace.ts` 工厂体前先量这两个窗口**。
3. **`createLiveProvider` 的参数位**：第 2 参是 `CreateProviderOptions`（→ 透传给 `createProvider`），
   第 3 参才是 `LiveProviderOverrides`（model/thinking）。放错位 **vitest 全绿、只有 `npm run build`
   的 tsc 会拦**（单测不类型检查）——`npm run build` 在本批不是形式主义。
4. **`familyContributions` 的实例缓存是「首装配锁存」**（`family ??= build(rowCtx.codingExec)`，
   apply 作用域闭包）：任何想「换掉已装配族行为」的尝试都不能走 rowCtx 扩字段（见 §3.4 落地修正①）。
   该缓存同时意味着 fs/shell 工具实例**跨卷共享**——本批的 ⑨ 用例正是拿这个现实做的验收。
   **补充（2026-09-15 性能门实测）：工具实例的复用是三层独立的缓存**——① 贡献 factory 内层
   族缓存（`contribution-helpers`）→ ② 行级 `instanceCache`（`plugin-tool-rows`，键 = 贡献 id，
   贡献 dispose 即清）→ ③ `noCache` 行绕过前两层每装配重创。**测内层必须绕过②**，否则改坏了
   也照绿（破测实证）。
5. **本机时间测量的噪声源是 DSH 宿主进程自身**（`dsh web` 常驻 1.5GB / 1700s+ CPU，占一个核）：
   同一份代码连跑两轮，`mean` 漂移 2–3×（rme 实测到 67%），`min` 漂移 <5%。
   ⇒ 性能判据一律 **min（p75 次之）**，绝对 ms 门槛不进红绿；结构性回归交给确定性计数台。

### 8.1 P1 施工中实测的环境事实（下一批动手前必读）

1. **导入成环（本批连踩两次，已钉守卫）**：`state/composition-store` 与 `state/preset-store`
   都在**模块体**里求值（`factoryComposition()` / `builtinPresets()`），而链子经
   `composition/roster → shell-rows → src/shell/rows/* → rows/chat → app/chat/chat-core` 回到宿主。
   凡 `chat-core` 侧**静态**可达 store 或 `composition/preset-assembly` 即闭合环，症状
   `Cannot access 'BUILTIN_PRESETS' / '__vite_ssr_import_N__' before initialization`（同族错误
   2026-09-14 在卷持久化层炸过一次，连坐 46 个测试文件）。
   处置：`app/chat/session-composition.ts` 静态面**只准**依赖 chat-core 已静态依赖的三个模块，
   store / composition 解析面一律调用点 `await import(...)`；守卫
   `tests/composition-import-cycle.test.ts` 钉静态白名单（运行时探针因求值顺序**时红时绿**，
   不可作守卫——实测记录见该文件头注）。
2. **`ui/` 是冻结残余目录**（终态 manifest 逐项点数，守卫 `tests/eventbus-zero-and-ui-split.test.ts`）：
   新编排件落 `app/**`——P1c 的模块因此落 `app/chat/`。
3. **`removeAgent` 会一并清掉卷级组合登记**（`agent-session-state.ts`）：写路径顺序必须
   「先拆句柄、后登记」，反过来键控登记即被删（P1c 测试钉住该顺序，破测验证过）。
4. **`selectionError` 对未知 id 是容忍的**（解析侧回退用户层，那是旧卷兜底的正确语义）；
   「写下一条新记录」是另一回事——`sessionSelectionError` 严一档：不在册也拒
   （记一条不存在的 id = 该卷永远解析不出组合）。
