# A-3 设计件 — capability 贡献面（ctx.capabilities 第八贡献通道）

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：所属线（组合架构 S0-S6）**全段竣工**——本件是历史留存，不作现状口径；组合层现状见 [`docs/composition/README.md`](../../../composition/README.md)，插件契约见 [`docs/plugins/README.md`](../../../plugins/README.md)，在办计划入口见 [`docs/plans/README.md`](../../../plans/README.md)。

> 状态：**待批准**（2026-08-24 预写；与 S1/S2 设计件同一流程——用户批准后实施，批准记录落此处）。
> 性质：P4 通道补齐第三件（agent-plugin-architecture-plan §5 A 表「blueprint capability 贡献面」，2026-08-23 拍板 #4）——会话级能力的插件装载，B⑤ 批（plan/通信/discovery/merge/board/compaction 六族迁移）的前置。A-1（prompts）/A-2（hooks）是宽松面直接实施；本件是**字节敏感面**（capability 表序 = 装配序 = 模型可见 schema 序，phase-1 effective 快照 + DeepSeek 前缀缓存守护），按拍板 #4 纪律单独出设计件过审后动工。
> 先例对标：A-1 prompt-service（贡献快照进组合解析域 + 变更代数失效——S4-4 甲模式）/ A-2 hook-service（形状零改写 + 单文件自持服务纪律）/ S2-1（fromRoster 穿线——本件零 runtime 改动的红利来源）/ S4-4 甲（贡献行进寻址域的组合均匀性论证）。

## 1. 问题陈述

会话级能力（工具 + hooks + ctx 服务 + Agent 接线的组合单元）唯一来源是编译期
`builtinCapabilities()` 表（15 项，2026-08-24 实查）。插件无法贡献 capability——
B⑤ 六族的迁移与外部插件的会话级扩展都被钉死在编译期。

baton13 §2.1 提出三个设计题，本件裁决：

| # | 设计题 | 本件裁决 |
|---|---|---|
| Q1 | 贡献序如何确定（表序 = 装配序 = 模型可见 schema 序，字节敏感） | **表尾追加、注册序**（§2.2） |
| Q2 | phase（context/agent）与 when() 两阶段语义如何覆盖 | **形状零改写——AgentCapability 原样贡献**（§2.3） |
| Q3 | 贡献 capability 是否进 roster 寻址域 | **进——capabilities 域快照收编**（§2.5） |

非目标（本件不做）：B⑤ 存量迁移本身（通道就位后另批机械推进，路线见 §2.8）；
capabilities 域 insert/锚定扩 schema（无既定需求，不做预防性扩展——A-2「hooks 不进
寻址域」同款纪律）；子 Agent 继承（§2.6）；hooks 域寻址（A-2 已裁，不翻案）。

## 2. 设计

### 2.1 通道形状：CapabilityContribution = AgentCapability（形状零改写）

```ts
// composition/capability-service.ts
export type CapabilityContribution = AgentCapability; // { key, phase, when?, install }
```

贡献形状即 `agent/blueprint.ts` 的 AgentCapability 本体——phase（'context'/'agent'）、
when() 门控、install(scope) 全部原样保留，与 A-1（PromptContribution = PromptSection）、
A-2（Hook/PreflightHook 形状零改写）同一先例：插件贡献与第一方 capability 在同一张
表上竞争，通道不做形状翻译。

- **key 即寻址 id**：capabilities 域「行 id = 现 key」是 S2 设计件 §2.1 既有裁定，
  贡献沿用——key 同时是 AgentBlueprint 唯一性约束与 roster 寻址面，一个字段两个
  语义都吃（与 tools 域「行 id ≠ 工具名」的差异：capability 无此分离需求）。
- **id 约定**：贡献 key 推荐 `'<插件名>/<能力名>'` npm scope 风格（hooks 通道同款
  约定——跨插件防撞名；TS 接口层不强制，唯一性由注册期拒绝兜底，见 §2.5）。

服务本体（prompt-service 单文件自持同款）：

```ts
export class CapabilitiesService extends Service {   // super(ctx, 'capabilities')
  register(def: CapabilityContribution): () => void; // → Disposer（调用方挂 ctx.effect）
  list(): CapabilityContribution[];                   // 注册序
}
export function activeCapabilityContributions(): CapabilityContribution[]; // 消费闭环读取面
export const capabilitiesServicePlugin = { name: 'hologram/capability-services', ... };
```

挂载序：BUILTIN_PLUGINS 表内 `hooksServicePlugin` 之后（第八 service；先于一切可能
贡献 capability 的第一方/外部插件装载——inject ['capabilities'] 依赖可解析）。

命名说明：ctx.capabilities 与 Tauri 的 `src-tauri/capabilities/`（窗口权限声明文件）
同名不同层——一个是 cordis 服务名（JS 装配层），一个是 Tauri 平台配置（Rust 壳层），
零交叠面；且与 roster capabilities 域同名是**有意的**（ctx.tools↔tools 域、
ctx.prompts↔prompt 域同构——服务名 = 解析域名）。

**运行时形状守卫（自查缺陷 A 的修法）**：外部插件是纯 JS（无 tsc 类型检查）——
畸形贡献（漏 install / phase 拼错 / key 空串）若不拦截，会潜伏到**会话装配期**
TypeError（每次建会话都炸、栈深难读、fail-late）。register() 在装载期守卫三个
承重字段：`key` 非空 string、`phase ∈ {'context','agent'}`、`install` 是 function
——loader 对插件对象的 isPluginShape 运行时守卫同款先例（既有贡献通道
tools/prompts/hooks 均无守卫，本通道因 install 失败面 = 会话装配失败而收紧，
是收紧不是放松）。

### 2.2 序：表尾追加、注册序（零漂移按构造）

```ts
// roster.ts factoryComposition()
capabilities: [...builtinCapabilities(), ...activeCapabilityContributions()]
```

- **builtin 表序原样不动**：builtinCapabilities() 是前缀，贡献按注册序追加表尾——
  无贡献环境 keys 与 builtinCapabilities() 全等，零漂移按构造（同 tools 域
  pluginToolRows、prompt 域 activePromptContributions 的快照语义：读取时点的通道
  装载态决定解析域，同装载态同输出）。
- **为何不是表头/锚定**：表头与任意插位都会挪动 builtin 前缀 → 零漂移不可构造；
  表尾追加 = tools 域「builtin-先/贡献-后」同序约定（A-2 装配折叠同款）。
- **为何不扩 insert**：capabilities 域 patch 现只有 disable；插位需求（把贡献锚到
  builtin 表中间）无既定需求——真需要时显式扩 schema（锚点语义同 prompt 域），
  本件不做预防性扩展。B⑤ 迁移的序保障不靠 insert，靠清单序（§2.8）。
- **贡献之间的序** = 注册序 = 插件装载序（第一方 = 清单序；外部 = 目录序）——
  与 tools/prompts 通道「通道序 = 组合序」同一纪律（S1 设计件 §2.1）。

### 2.3 两阶段语义与 when()：形状零改写的自然结果

AgentCapability 的 phase（context = Agent 构造前可写 ctx 服务 / agent = 构造后）与
when(scope)（缺省恒装，返回 false 跳过）都在对象本体上——贡献不需要任何包装层：

- **when 每装配现判**：装配期真值（subAgentPool 有无、graphData 开关等）在
  _assembleAgent 的 capability 循环里现场评估——①c 路线一「无缓存行」同一语义，
  但本通道连缓存问题都没有（无 factory 面，见 §2.6）。
- **install 的装配视图**：贡献 install 拿到与 builtin capability 完全同一的
  BlueprintScope（ctx/inputs/tools/hooks/preflightHooks/deps/agent）——深集成通道，
  信任模型见 §2.7。

### 2.4 装配消费：runtime 零改动（S2-1 穿线红利）

`_assembleAgent` 既有穿线 `AgentBlueprint.fromRoster(composition.capabilities)`
（runtime.ts L587）消费整张表——贡献经 factoryComposition() 快照进
composition.capabilities 后，随 capability 循环按表序装配（context 阶段 → Agent
构造 → agent 阶段），**runtime.ts 一行不改**。这是 S2-1「组合是值不是注册副作用」
设计的直接兑现：能力面进解析域，装配面自动跟随。

显式 blueprint 参数路径（createAgentFromContext 扩展面）不受影响——显式传参整体
换源是 S4-1a 既有语义（patch 对它同样不生效，非本件引入）。

### 2.5 寻址域与重名政策

**贡献 key 进 capabilities 域寻址**（S4-4 甲同款快照收编）：

- patch/preset 可 `capabilities: [{ id: '<贡献 key>', disabled: true }]`——不动插件
  开关就能裁剪单个会话级能力。组合均匀性论证与 S4-4 乙 mcpServers 行同款：行寻址
  让「插件粒度」与「能力粒度」两层裁剪正交。
- **与 A-2「hooks 不进寻址域」的差异论证**：hooks 域在四域行模型中不存在（凭空造
  域 = 预防性扩展，A-2 裁决）；capabilities 域是四域既有域（寻址面已存在——minimal
  preset 禁 graph-hooks 就是既有消费者）——贡献进既有域是自然延伸，不是造域。
- disable 贡献行 → 终步过滤 + diagnostics.disabled 收 key，零新语义。

**重名政策（fail-fast，本通道特有）**：register 时撞两类 id 即 throw——

1. 注册表现有 id（全部通道同款装载期拒绝）；
2. **builtinCapabilities() 任一 key**（本通道独有：寻址空间与 builtin 表共享）。

不预检的后果是 dup 潜伏到装配期 `AgentBlueprint.fromRoster` 构造器 throw（fail-late
——整个会话装配炸，错误不可见）。注册期双查把失败面收敛到装载期。

**继承性脚枪（自查缺陷 B，如实入账不修）**：patch/preset 禁用了某贡献 key，插件日后
卸载 → key 变未知 id → 整个用户层 patch 被 all-or-nothing 拒绝（组合回退出厂，错误
经 patch-loader 可见）。S4-4 甲对 plugin 工具行已引入同款语义——本件沿用（修 = 破坏
all-or-nothing 铁律，代价大于收益）；用户处置路径 = 删 patch 里失效的条目。

### 2.6 实例语义、生效时机、子 Agent

- **无 factory 面**：贡献是 AgentCapability 对象本体（install/when 是函数，无实例
  缓存判断可言）——install 每装配重调，install 内 new 的对象（TaskManager 类）每
  装配新鲜；install 外的实例状态性由插件自担（A-2 同款措辞）。
- **生效时机 = 下次 Agent 装配**：新会话经 resolveCurrentComposition 现解析（cache
  代数失效，§2.7）；在途会话保持创建时点的能力面不变（KV-cache 纪律，tools/prompts/
  hooks 三通道 §7 同款）。
- **子 Agent 不自动继承**：spawnSubAgent 手工装配（buildSubAgentTools + 手建
  registry）不经 blueprint/composition.capabilities——既有语义，graph-hooks 与 A-2
  hooks 同款不下放；未来要下放属后续扩展（改 spawnSubAgentImpl 装配处）。

### 2.7 贡献变更 = 组合输入变更（S4-4 甲第三挂点）

贡献进解析域 → register/dispose 即组合输入变更，与 tools/prompts 两通道同款三件套：

1. **变更信号**：`onCapabilityContributionsChanged`（register 实际生效/dispose 实际
   删除时触发——prompt-service 同款「实际删除才触发」纪律）；
2. **cache 代数失效**：preset-assembly 的 contributionsGeneration++（第三条订阅）；
3. **store 回写**：bootShell armContributionsWatcher 挂第三条 reapplyComposition
   （error 态跳过、factory 态重新快照——既有语义复用）。

无即时 React 信号面（capability 无常驻清单消费——同 hooks，服务 dispose 守卫式清空
_activeCapabilities 即可，vitest 同 worker 跨测试残留即静默串味的既有纪律）。

### 2.8 通道边界、信任模型与 B⑤ 迁移路线

**通道定位**：会话级能力的组合单元（工具 + hooks + ctx 服务 + Agent 接线）——
B⑤ 六族的迁移目标面。**普通工具加面走 ctx.tools**（capability install 里
scope.tools.register 落在全表尾部——converge-tools 之后，不进域折叠：DOMAIN_SPECS
是第一方收敛机制，外部插件本就不参与；文档如实声明，不当作缺陷修）。

**信任模型**：install 拿全量 BlueprintScope（ctx 可写服务、tools 注册表、hooks、
deps、Agent 实例）——深集成通道，等价 DSH 的 L3。护栏立场：

- 插件目录是全信任区（S4-4 乙 mcpServers 先例——安装插件本就是任意代码执行），
  通道不设运行时护栏；声明面（permissions.json 接插件声明）是 C11 两基建的事，
  落地后本通道补声明消费；
- C12 dsh-compat **不暴露本通道**（L3 深集成明确放弃——本通道是自研路线 D9「自己
  当第一用户」的独享面；L1/L2 工具类插件走 ctx.tools）。

**B⑤ 迁移路线预告**（本件只立通道不迁移；序保障靠清单序，不靠 insert）：

- 表尾非工具五件（graph-hooks / board-tracking-hook / plan-injector / pre-run-hook /
  auto-tune——converge-tools 之后、零工具注册面）可先行分批：迁后落贡献表尾，
  恰 = 原表位后缀，零漂移按构造（B④ 表尾后缀同款纪律）；
- 其余十件（plan-tools…converge-tools——工具注册面 + converge-tools 的注册面依赖
  「必须在全部工具注册之后」）**单批收官**：第一方 capability 插件清单序 = 迁移前
  表序，builtinCapabilities() 届时退役（B④ builtinPromptSections 退役同款终态）；
  中间分批不可行——工具注册族迁表尾会击穿 converge-tools 的表序依赖与
  blueprint.test 表序断言（连环改）。
- B⑤ 收官时的配套（届时另批，本件不做）：blueprint.test 表序断言换代（钉通道面）、
  gen:tool-contract 通道腰（withFirstPartyCapabilityChannel——无引导环境复现生产
  capability 面，withFirstPartyToolChannel 同款）、composition-wiring 的
  fromRoster ≡ standard 不变式改钉新真源。

## 3. 实施批（单批）与验收口径

**文件面**（A-2 六文件同量级 + 解析域三件）：

| 文件 | 改动 |
|---|---|
| `src/composition/capability-service.ts` | 新建（~140 行，hook-service 同款结构 + prompt-service 的变更信号模式） |
| `src/composition/roster.ts` | factoryComposition capabilities 快照 + 文件头注释 |
| `src/plugins/loader.ts` | BUILTIN_PLUGINS 挂 capabilitiesServicePlugin（hooksServicePlugin 之后） |
| `src/composition/preset-assembly.ts` | 第三条代数订阅 |
| `src/shell/boot.ts` | armContributionsWatcher 第三条监听 |
| `src-ui/tests/composition-capability-service.test.ts` | 新建（服务单测 + 集成） |
| `tests/composition-roster.test.ts` / `composition-wiring.test.ts` | 快照序/寻址断言扩展 |
| `docs/plugins/README.md` + `docs/plans/agent-plugin-architecture-plan.md` | 通道文档 + 状态行（A-2 同款） |

**验收口径**（全部同 commit）：

1. 服务单测：注册序/disposer 幂等/陈旧性守卫；撞注册表 id 与撞 builtin key 双路径
   装载期拒绝；无服务空集；dispose 守卫清空读取面（拆卸后新装配不残留）。
2. roster 集成：通道内 factoryComposition().capabilities = builtin keys + 贡献 keys
   （表尾注册序）；无通道环境 ≡ builtinCapabilities()（零漂移钉面）；patch disable
   贡献 key → 行消失 + diagnostics；贡献 dispose → 行消失 + 代数失效。
3. runtime 端到端：贡献 capability 的 context/agent 两阶段 install 按表尾序执行
   （builtin 之后）；when() 门控生效；patch 禁用后装配期不执行。
4. 门禁：convergence 双 preset 零漂移（无贡献环境按构造）；blueprint.test 表序断言
   零改动；tsc / biome / 全量 vitest 全绿；tool-contract 文档零变化（无贡献环境生成）。

## 4. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | install 全量 scope = 深集成面（ctx 可写服务，能力远超 tools/prompts/hooks 三通道） | 全信任区信任模型声明（§2.8）+ C11 后补声明面 + compat 路线不暴露；文档明示「普通工具走 ctx.tools」 |
| R2 | 表序字节敏感（前缀缓存/phase-1 快照） | 零漂移按构造（builtin 前缀不动，§2.2）+ blueprint.test 表序断言零改动 + convergence 双 preset 实测 + 无贡献环境 ≡ builtin 的钉面测试 |
| R3 | 撞 key fail-late（装配期 fromRoster throw 炸整个会话） | 注册期双查（注册表 + builtin 表，§2.5） |
| R4 | vitest 同 worker 跨测试残留（_activeCapabilities 串味） | dispose 守卫式清空（prompt/hook service 同款纪律） |
| R5 | 贡献序依赖装载序（非确定感知） | 与 tools/prompts 通道现状同一语义（装载序确定 = 清单序/目录序，快照语义同装载态同输出）；文档声明 |
| R6 | B⑤ 迁移时中间态击穿表序 | §2.8 路线预告钉死：非工具五件先行 + 其余十件单批收官；本件不迁移，无此风险 |
| R7 | ctx.capabilities 与 Tauri capabilities 同名混淆 | §2.1 命名说明（不同层零交叠；与 roster 域同名是有意同构） |
| R8 | 外部插件（纯 JS 无 tsc）畸形贡献 fail-late——潜伏到会话装配期 TypeError | register() 运行时形状守卫（key/phase/install 三承重字段，装载期拒绝——§2.1 自查缺陷 A 修法） |
| R9 | patch 禁用贡献 key 后插件卸载 → 未知 id → 用户层 patch 整体被拒 | S4-4 甲继承语义，如实声明不修（修 = 破坏 all-or-nothing）；处置 = 删失效条目（§2.5 缺陷 B） |

---

> **批准记录（2026-08-24）**：用户声明失去设计件级别审批能力（原话「我的人脑现在
> 处理不了这种级别的设计件，我需要你自查，我已经失去了审批能力了」），拍板 #4 的
> 「设计件过用户审批」门禁改为 **agent 自查 + 简报** 模式。自查已执行（本件 §2.1/§2.5/
> 风险表 R8/R9 即自查产物；承重断言六条对照代码库逐条验证通过：runtime 零改动
> runtime.ts:587 / 零漂移构造性（无通道 = 空集）/ blueprint.test 表序断言零改动 /
> ctx.capabilities 服务名空闲 / B⑤ 单批论证强化（converge-tools 与
> code-execution-tool 双双 install 期快照 visibleTools()）/ 无环依赖）。裁决维持
> 原设计 + 两处修订。据此按 §3 单批实施。

> **B⑤ 收官修订（2026-08-24，通道消费面兑现）**：本件 §2.8 预告的迁移已单批落地
> （十五项全量经 capabilitySegmentsPlugin 贡献，序 = 迁移前出厂表序）。两处随迁
> 修订：① §2.5「撞 builtinCapabilities() key 拒绝」随出厂表退役而退役——第一方
> 十五项本身经通道注册（生产装载序 = capabilitiesServicePlugin → 第一方插件 →
> 外部插件），撞第一方 key 由注册表重名拒绝承担（B④ prompt-service 同款终态；
> 无第一方通道的环境里第一方 key 可注册，撞名防线在装载序上）；② §2.2 的
> 「builtin 前缀不动，无贡献环境 keys ≡ builtinCapabilities()」语义翻页为
> 「capabilities 域唯一行源 = 通道贡献（第一方经通道注册），无通道环境 = 空表」
> ——B④ prompt 域同款注册面依赖。§2.8 预告的三件配套（blueprint.test 表序断言
> 换代钉通道面 / gen:tool-contract 通道腰 / composition-wiring 不变式改钉新真源）
> 均已落地，convergence 双 preset 零漂移 + tool-contract 文档字节零变化实测。
