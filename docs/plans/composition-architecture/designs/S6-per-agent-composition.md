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
  （证明「会话数不进矩阵」）。
- **性能门（P3 前置）**：先测再改——per-agent 组合的装配开销（注册表构建耗时 / 常驻内存 /
  两卷并存的增量），阈值由本批实测确定并写回本件；DSH 的量级参考是「每卷 ~0.17MB（minimal）~
  1.31MB（standard）、挂载 38ms/135ms」，兰台必须在同等口径下自测。

### 3.8 诊断面（与 P1 同批，不可后置）

引入选择集之后，**"某工具不见了"有三种原因**（未选中 / 被禁用 / requires 缺），必须可见可分。
现行只有 `diagnostics.disabled` 一个扁平列表（且混装了 seam id，审计 F2 附注），不足。
方案：组合诊断结构扩为四栏 + 设置面板「组合」节分栏渲染 + **卷头 hover 显示本卷组合与来源**
（全局默认 / 卷级 / 程序指定）。

---

## 4. 批次序列（每批独立 commit、独立全绿；批间无审批门，`record` 例外）

| 批 | 内容 | 验收断言 | 门禁 | 行为变更（commit message 必写） |
|---|---|---|---|---|
| **P-1（authoring 环境）** ✅ **已落地（2026-09-14，待 commit）** | **用户不动源码就能配出 preset**（用户 2026-09-14 纠正：preset 不是出厂物，是用户自己的环境——环境没建，后面全是空转）：① 组合目录 RPC（返回路径 + **按需 `create_dir_all`**）② 「打开组合目录」动作（服务端算路径 + 系统文件管理器；**不放宽** `open_external` 的 http(s) 限制）③ 「复制内置 preset 为模板」动作（DSH copy-only authoring 的等价物；**拒覆盖** + id 围栏 + 内置 id 拒绝）④ **免重启重扫**（`rescanPresets` + 面板动作）⑤ 面板显示组合目录路径与写法提示 | §2 序列 F：全新机器 → 建 preset → 出现在列表 → 选中生效 → 写错 → 原因可见，**全程不重启、不碰源码** | vitest + build + biome + convergence（双轨）；Rust 侧 `cargo test`（3 例：建目录/幂等不抹内容/任意根）+ RPC 契约文档重生成 | 新增 RPC `composition_dir`（契约升版）；设置面板新增作者动作；**重启才发现新 preset 的行为退役** |
| **P0.5** ✅ **已落地（2026-09-14，待 commit）** | minimal 快照重录（`office` 域漏录，2026-09-13 起漂移）+ `verify:convergence` 改**双轨**（CI 经同一 npm script 自动获得第二轨，不改 workflow 文件） | 两轨都 exit 0；「双 preset 零漂移」重新成立 | 走 `baseline-change-request`（已留痕：`src-ui/tests/convergence/baseline-change-request.md` 首条） | 门禁覆盖扩为 2 preset；convergence job 时长 ×2 |
| **P0** ✅ **已落地（2026-09-14）** | 卷结构落 `presetId`（`StoredSession` / `SessionSnapshotData` 两处 shape + 两处 save 路径 + 恢复期登记）+ 会话工厂**按卷内记录的组合重建**（`agentSessionState` 卷级登记，工厂读它）+ 恢复期校验与可见提示（不在册 / 行 id 不可解析 → 提示 + 回退用户层组合）；连带修复 `renameSessionFile` 改名不再抹掉 `tokens`/`compose` | 关卷重开：组合身份登记一致；旧存档无字段 = 无记录（不猜、不迁移）；坏组合可见且卷照常打开 | vitest + build + biome + convergence 双轨 | 卷文件多一个字段（旧卷 = 缺省）；新增"本卷组合不可用"提示；**改名不再丢数据** |
| 注（P0 范围调整） | **「卷头只读标签」移入 P5**（它属 UI 面，与 chip / 同屏并排同批做，且需要"哪个是当前卷"的展示位）；**「诊断四栏化数据面」移入 P1**（"未选中 vs 被禁用"要等选择集语义落地才有区分度）。P0 只做**落盘 + 登记 + 校验 + 提示**这条不可再省的闭环 | — | — | — |
| **P1** | 卷级选择（两层：全局默认 + 卷级）+ 选择集语义（`defaultOff` 行 + `disabled:false` 回开）+ 引用身份比较（去掉恒重建） | §2 序列 A/B；两卷工具面互不影响；A 切组合不重建 B | + 出厂 preset 快照 + profile 断言 | 组合按卷生效；同工作区两卷可不同 |
| **P2** | seam 选择从模块态 → 装配期值注入（6 消费单点 + `emitLoopEvent`） | §2 序列 D；旧无组合上下文路径零漂移 | + seam 域 per-composition 快照 | 同一工具可按卷走不同 provider |
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

---

## 8. 审批与复审记录

- **2026-09-14 用户拍板三项**（本件的立项输入）：差异到插件集合层 / UI 与程序双入口 / 全粒度并存。
- **2026-09-14 用户纠正一项**（改本件 I1 与 §7.2，并新增 P-1 批）：**preset 不上线、不是出厂物——
  它是用户自己设置的环境，平台只需提供环境**；连带暴露的真问题：单二进制下用户**配不出** preset
  （目录不建 / 无打开动作 / 无模板 / 加完要重启——§2 序列 F 的四条实测缺项）。P-1 因此成为本线首批发。
- 本件状态：**草案待批**。批准后：① 把 I1 写进 `CONVENTIONS.md`；② P0.5 的
  `baseline-change-request` 单独起草待批；③ 按 **P-1** 开工（authoring 环境），每批独立 commit + 门禁四连。
