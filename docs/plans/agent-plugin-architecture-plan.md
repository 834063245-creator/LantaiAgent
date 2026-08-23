# Agent 插件化：执行原语 + 工具面单一真源（DSH 对标）计划

> 立项：2026-08-19（岛层退休 + 总线归零立项当日）
> 状态（2026-08-23 更新）：**P1 ✅ · P2 ✅（C4-C8 全判据；方案 A 程文块）· P3 ✅（ctx.codeRuntime cordis 收口，
> convergence 零漂移）· P4 自研路线推进中（D9 拍板：不等 DSH，自己当第一用户——通道补齐 /
> 存量拆解 / P4a 调研三股交替；批次表见 §5 P4；**B① 已毕**——git/search 两族迁 ctx.tools
> 第一方插件通道，贡献 factory 放宽收 ToolRowContext，双 preset 零漂移；**A-1 已毕**——
> prompts 第六 service，段贡献经 ctx.prompts 追加进系统提示词；**B④ 已毕**——13 段全迁
> ctx.prompts 通道，纯插件面收官：builtinPromptSections() 退役、段表空壳删除、roster
> prompt 域寻址面 = 仅已插段（全寻址恢复属 S4-4 甲），双 preset 零漂移实测；**② 首三族
> 已毕**——fs/shell/agent-isolation 迁 ctx.tools（coding-domain-plugins 五族合并文件，
> 行表 12→9，双 preset 零漂移实测））。**五项拍板
> （2026-08-23 晚，用户逐项拍定）**：S4-4 机器桥复活
> 整批做（甲+乙）、①c 拍路线一（无缓存行）、B④ 收官 = 纯插件面（段表退役）、A-3 与 C11
> 两基建全部排进当前工程——「推迟不是减负」，唯一合法挂起 = 外部信号依赖型（C12 观望
> DSH）。**。战略底牌：形状与 DSH 契约兼容、零依赖；
> 战略决策（2026-08-19 定）：**生态跟随走「观望 DSH」路线**——P4 的前提是 DSH 官方把服务接口
> 当公开契约维护；在此之前只做自研（P1-P3 全部独立于 DSH 生态成立）。见 §4 D8。
> 性质：本计划是能力建设（capability plan），不是还债（debt plan）——每阶段独立可停，
> P1 半天即可单独兑现收益。
> 参照系：DeepSeek Harness 源码（D:\useful\deepseek-harness，下称 DSH）；所有「DSH 实证」
> 均给出文件路径供执行者直接查阅。

## 1. 背景与问题

HoloGram 的 Agent 工具面（ToolRegistry + defineTool/zod + blueprint capability 表 +
domains 折叠）在**声明层**已是 DSH 同级。差距集中在两处半：

1. **缺执行原语**（结构性）：模型一次只能发一个 JSON 工具调用，组合逻辑活在下一 token
   预测里——烧上下文、无循环、无 try/catch、无并发。agent 今天绕路的「写脚本→shell 跑
   node→读输出」三步，本质是一个未坍缩的原语。
2. **缺声明即文档**（半个）：工具 schema 与面向模型的说明分离，「加工具」要三处同步。
   项目里已有同纪律先例：`gen-rpc-contract-md.cjs` 从 RpcContract 生成文档。
3. **缺第三方插件边界**：一切能力都是编译期 import，外部无法挂载。

### cordis 与本计划的关系（重要澄清）

cordis 解决的是**开发者侧组装**（Service 注册/依赖注入/生命周期）；DSH 级插件性要的是
**模型侧运行时能力边界**。两者正交——但 DSH 源码给出了关键的正面证据：

> **DSH 的 CodeRuntime 本身就是 cordis Service**
> （`packages/code-runtime/code-runtime/src/index.ts`：`export abstract class CodeRuntime
> extends Service` + `declare module '@deepseek-ai/cordis' { interface Context { codeRuntime } }`）。
> workflow 工具同样是标准 cordis 插件（`packages/workflow/tool-workflow/src/index.ts`：
> `export const name/inject/Config`）。

即：cordis 化不是白做，它是插件化的**装配层**；本计划补的是它上面缺的两块——执行腰和
文档发电机。HoloGram vendored 的 cordis 与 DSH 同宗，模式可以直接平移。

### 生态赌注的诚实分析（2026-08-19 补，决定 P4 走向）

「往 cordis 靠拢就能吃到 DSH 插件生态」是**必要不充分**。DSH 插件的真实依赖面以
tool-workflow 为例：`dependencies` 仅 schemastery，但 `peerDependencies` 是 **8 个包**
（dsh-agent / dsh-invariants / dsh-llm / dsh-session / dsh-system-prompt / dsh-tools /
dsh-workflow / cordis）——cordis 只占八分之一。全仓 80+ 文件做 declaration merge，
DSH 实际是「cordis 地基 + 一整圈服务契约」（ctx.tools/session/llm/shell/fs/sandbox/…）。
**生态跟随的单位是服务契约，不是内核**（历史印证：koishi 插件生态同样长在 ctx.database
/ctx.router 上，不长在裸 cordis 上）。

但契约是分层的：L1 纯工具类（挂 ctx.tools）+ L2 工具+prompt section——插件生态的大头
恰好在这两层，且 HoloGram 的 Tool 接口形状与之同构。若 DSH 稳定接口，跟随成本集中在
「最小服务契约子集 + dsh-compat 装载层」，而非重实现平台。

**当前不做跟随的理由**：DSH 的 peer deps 全是 `workspace:^`（monorepo 内部协议），尚无
「接口是对外稳定契约」的官方承诺。此刻跟随=追跑无版本纪律的移动目标。观望信号见 D8。

## 2. DSH 实证速查（执行者先读这五个文件）

| # | DSH 文件 | 教的东西 | HoloGram 对应物 |
|---|---|---|---|
| 1 | `packages/code-runtime/code-runtime/src/index.ts` | CodeRuntime = cordis Service；「runtime 不知道工具/会话，消费者自己管」的接缝纪律；跨语言保留字/保留全局的**可移植契约** | 未来 `ctx.codeRuntime` 的接口形状 |
| 2 | `packages/code-runtime/code-runtime-worker-thread/src/protocol.ts` | 窄腰线协议：worker 只拿**函数名清单**（namespaces），函数本体留宿主；correlation-id 应答；**宿主视入站流量为敌意**（模型代码可伪造 parentPort 消息） | 沙箱协议规范（无论后端选哪个都适用） |
| 3 | 同包 `bootstrap.ts` | 输出预算（logs+完成值合并上限）、无损 JSON 才能过线、日志先行流式（中途被杀也不丢）、完成值 snapshot+detach 双份（调度与日志互不干扰） | 预算与日志纪律 |
| 4 | `packages/core/tools/src/code-mode.ts` | run_code 工具本体：程序经 `await tools.name(args)` 调注册表工具=**原生并发契约下的嵌套执行**；子分发全部落日志可重建，只有外层策展结果进模型历史；`CodeRunFailedError`→结构化 isError 结果（模型可自我修正） | 与 ToolRegistry/executor 的桥接设计 |
| 5 | `packages/workflow/tool-workflow/src/index.ts` | 编排=薄 cordis 插件：模型面 schema 与执行引擎分离（`ctx.workflowEngine` 可整体换硬），提示词指导注册为工具自己的 prompt section | 未来 workflow 工具的形态模板 |

另：`packages/typert` 是工具面跨进程类型协议（merge-extensible declaration maps）——
HoloGram 单进程内暂不需要，P4 插件边界时再评估。

## 3. 完成判据（按阶段分组，均可测）

### P1 工具面文档生成
| # | 判据 |
|---|---|
| C1 | `scripts/gen-tool-contract-md.cjs` 存在，从 `ToolRegistry` 装配产物生成模型可见工具面文档（含领域 action 枚举与参数说明） |
| C2 | 生成物纳入构建检查：catalog 变更而文档未再生成时 CI 红（对齐 gen-rpc-contract-md 纪律） |
| C3 | AGENTS/CLAUDE 中 agent 工具清单段改为指向生成物，消灭手写双源 |

### P2 执行原语（code_execution 工具）
| # | 判据 |
|---|---|
| C4 | 新模型工具 `code_execution`（或并入既有 `shell` 域作 action）：入参=程序体+description，出参=logs+完成值，走 defineTool+zod |
| C5 | 程序内以 `await tools.<name>(args)` 调用**当前 registry 全部可见工具**（含领域工具）；子分发逐条落 session-log 可重建（`derivePayload` 同步——见风险 R2） |
| C6 | 协议纪律：宿主侧敌意校验（correlation-id 一次性、参数无损 JSON 校验）、输出预算可配、超限/中止/崩溃分类报错 |
| C7 | 并发语义显式：文档写明程序内调用的并发契约（对齐 registry 现行 readOnly 并行规则） |
| C8 | 回归测试：嵌套调用的会话日志重建、预算超限、程序异常三条路径各一条 |

### P3 cordis 收口
| # | 判据 |
|---|---|
| C9 | `codeRuntime` 成为 vendored cordis 的 Service（`ctx.codeRuntime`），P2 的执行后端退为它的一个实现；领域工具（fs/shell/graph/...）装配改经 ctx 查询 |
| C10 | blueprint capability 表增加一个 `code-execution` 项即完成装配，AgentConfig 字段面不变（Phase 6 冻结不破） |

### P4 插件边界（远期，判据到时再细化）
| # | 判据 |
|---|---|
| C11 | 路线 B：第三方插件 = manifest + 工具声明（zod schema 可序列化形态）+ capability 表项，运行时挂载无需重编译；权限声明接入 permissions.json 体系；声明形状与 DSH L1 契约同构——**两块硬基建已拍板排进当前工程（2026-08-23 #5）**；自举论证（用户拍板理由）：自家也是「一个用户」——完成后加 feature / 移植外部插件均不碰源码 |
| C12 | 路线 A：dsh-compat 装载层能加载一个真实 L1 工具类 DSH 插件（e2e），含 peer 版本协商与漂移检测 |
| C13 | ~~P4a 契约调研笔记存在且覆盖最小子集 + 依赖面分布（两条路线共用输入）~~ ✅ 已毕（2026-08-23，[`docs/research/p4a-dsh-contract-notes.md`](../research/p4a-dsh-contract-notes.md)：模型面三字段同构、JSON Schema 公共分母实锤、226 包 peer 全量分布、路线 A 启动信号改为「peer 出现非 workspace 版本」） |

## 4. 设计决策

- **D1 沙箱后端选 Web Worker 优先，不是 Node sidecar**。DSH 实证的关键洞察：worker 里
  **根本没有工具**——工具全是宿主侧的 proxy binding，程序只能经协议腰调用。HoloGram 的
  webview 里开 Web Worker，同样只暴露 `tools.*` 代理，能力面天然收窄到桥协议；攻击面
  是桥的实现质量，不是 worker 逃逸。诚实标注：这是**协议纪律沙箱**而非**基底沙箱**
  （同源 Web Worker 不是硬边界），与 DSH worker-thread 的安全定位实际等价（DSH 的
  worker 同样不是进程级隔离，靠的就是敌意校验+无损 JSON+预算）。
  sidecar Node / engine 嵌 deno_core 是后续硬化选项，接口不破即可换（C9 的意义）。
- **D2 单腰不加宽**。只加一个 `code_execution` 工具，schema 面增量=1（DeepSeek 前缀缓存
  友好）；不把几十个工具接口塞 system prompt（DSH 那样做是因为「代理即产品」；HoloGram
  是带代理的桌面应用，domains 折叠形态更适合——**别抄工具面预算**）。
- **D3 组合不进平台**。不造工作流引擎。若未来要 workflow，抄 DSH 形态：一个薄插件工具
  给 `agent()/parallel()/pipeline()` 几个钩子，编排语义由模型写的程序承担
  （`tool-workflow/src/index.ts` 即模板）。**平台笨、代理聪明**。
- **D4 声明即文档**：P1 复制 gen-rpc-contract-md 纪律到 ToolRegistry catalog；单一真源
  生成模型文档，杜绝 schema/提示词/文档三处漂移。
- **D5 子分发可重建**：P2 的嵌套工具调用必须落 session-log（对照 DSH 的 CodeDispatchLog
  「子分发全记录、外层结果才进历史」）。这直接触及 session 变异三入口纪律与
  `session-log.ts derivePayload`——执行时按 Phase 5 立规同步，不可绕。
- **D6 与总线归零的关系**：本计划不依赖 eventbus-zero 完成，但**P3 的 ctx 查询装配**
  最好在 ui/ 拆分尘埃落定后做（避免两场大迁移叠 diff）。P1/P2 无此约束，随时可做。
- **D7 蓝图序即字节契约**：code_execution capability 插入位置显式选定（Phase 6 铁律），
  生效快照与缓存依赖表序，不追加到表尾了事。
- **D8 生态观望，不预支跟随（2026-08-19 拍板；D9 起修正）**：P1-P3 是纯自研收益（执行腰 + 文档
  发电机 + cordis 收口），**无论 DSH 生态走向如何都成立**。观望信号三条件（semver /
  官方插件文档 / 接口稳定性承诺）保留，但其管辖范围收窄为「是否写 compat 装载层」
  ——见 D9。
- **D9 自研插件边界，自己当第一用户（2026-08-23 拍板，修正 D8 的跟随默认）**：用户定调
  「以后不管是重构还是新功能，所有能拆出来的全部插件化，特权区尽可能小；最终方便
  自己开发，第三方开放是顺手的事」——触发条件从「DSH 信号」改为「用户想要」，
  **现已触发**。战略含义：①兰台自建 DSH 式服务契约集（五 service + 待建通道），
  第一用户是自己的域功能开发（多窗口并行 / 可禁用域 / 贡献面即契约）；②**形状与
  DSH 契约兼容、零依赖**原则保留——将来 DSH 信号点亮只需补 compat 层即可吃其生态；
  ③存量拆解与通道建设交替推进（拆到哪疼了通道就知道该长什么样），不存在大工程
  开工时刻。特权区（永不插件化）清单同步定案：cordis 内核 / 五 service 壳 / RPC
  边界 / agent 流式循环核心 / Workspace 原语（fiber·epoch·scoped store）/ Rust 壳
  （权限沙箱·IPC·Tauri）——**只减不增**。Rust 侧插件化的标准形态 = 外部 MCP
  server（新能力优先做成进程外 MCP，不是往 src-tauri 加命令）。

## 5. 阶段

### P1 工具面文档生成 — ✅ 已毕（2026-08-22）

落地记录：`scripts/gen-tool-contract-md.cjs` + `docs/agents/model-tool-contract.md`；C2
判据如实偏差（ci.yml 冻结 → vitest 守护测试 + `check:tool-contract`）；AGENTS/CLAUDE
手写清单段已指向生成物（见 plans/README.md P1 行）。下列原始施工序仅存档：

1. `ToolRegistry` 增加 catalog 导出（或复用 domains 装配现场）
2. `scripts/gen-tool-contract-md.cjs`：zod→JSON Schema→markdown 表（参照 rpc 版脚本）
3. CI 漂移检查 + AGENTS/CLAUDE 文档段替换
4. 门禁：build + vitest + 生成物 diff 检查

### P2 执行原语 — ✅ 已毕（2026-08-22/23）

落地记录：R5 spike 全绿（`docs/research/_r5-web-worker-csp-spike.md`）→ 用户拍板方案 A
（程文块）→ C4-C8 全判据达成（交付物 `agent/code-run/` 四件 + blueprint capability +
session-log 审计对 + 纸壳程文块；baseline 变更
`baseline-change-request-code-execution.md` 随 commit 生效；测试 22+ 用例全绿）。
下列原始施工序仅存档：

0. ~~产品拍板项~~ ✅（2026-08-22 拍板方案 A：新增 code 块 kind + ctx.renderers 专属渲染器）
1. 协议层：correlation-id 腰线（照抄 protocol.ts 语义：一次性应答、敌意校验、无损 JSON、
   输出预算、日志先行）
2. Worker 侧：Web Worker bootstrap——类型剥离（HoloGram 无 ts 转译链，直接收 JS 程序体，
   限定 erasable 子集可后置）、`tools.*` proxy materialize、console 捕获
3. 宿主侧：桥接 registry（嵌套执行走现行 executor 并发契约 + dispatch log）
4. `code_execution` defineTool + blueprint capability + domains 归属（建议 shell 域新
   action 或独立 code 域，执行时定）
5. session-log `derivePayload` 同步 + 三条回归测试（C8）
6. 权限：程序内工具调用过现行 gate（plan 模式白名单同样生效于嵌套调用）
7. 门禁：全量 + verify:convergence（动了 agent/** 必过）

### P3 cordis 收口 — ✅ 已毕（2026-08-23）

落地记录：`CodeRuntimeService extends Service`（`ctx.codeRuntime`，agent/code-run/
runtime-service.ts；codeRuntimePlugin 挂根 Context，BUILTIN_PLUGINS 四 service 之后）；
绑定面归一 CodeBindingSpec（invoke 闭包持有 executor 等价体 + 审计）；工具经
runViaRuntime 门面消费，无服务时惰性游离实例。convergence 零漂移（C10 语义：装配面
= 既有 capability，AgentConfig 冻结未破）。原始施工序存档：

1. `CodeRuntimeService extends Service`（vendored cordis），P2 实现挂到 `ctx.codeRuntime`
2. 领域工具装配改 ctx 查询；blueprint 加 capability 项
3. 文档回写：CONVENTIONS/AGENTS/ARCHITECTURE 插件化叙事

### P4 插件化全集（**自研为主**，D9 拍板 2026-08-23 起）

战略换轨（D8→D9）：不再等 DSH 信号才启动——自研插件边界自己当第一用户，DSH 信号
只决定将来要不要写 compat 装载层。本阶段由三股交替推进的活组成：

**A. 通道补齐（基础设施集，按疼的顺序）**：

| 缺口 | 量级 | 说明 |
|---|---|---|
| ~~prompt-sections 贡献通道~~ | ✅ 已毕（2026-08-23 A-1） | 第六通道 `ctx.prompts`（`composition/prompt-service.ts`，renderer-service 先例）：PromptContribution 形状即 PromptSection（id + applicable? + render）；合流点 = assembleSystemPrompt 末端追加（无贡献 = 空集 = 零漂移按构造，双 preset 实测）；生效 = 下次装配；服务 dispose 守卫式清空读取面（prompt 是字节敏感面，比四 service 的既有宽松面收紧）。B④ 迁存量段落时经此通道 |
| hooks/preflight 暴露面 | ~1-2 天 | 插件参与工具管道（富化/门禁） |
| blueprint capability 贡献面 | **排进当前工程**（2026-08-23 拍板 #4） | 会话级能力的插件装载；设计件穿插机械批推进，产出过用户审批 |
| 工具声明可序列化（zod↔manifest） | ~2 天，**已拍板排进工程**（2026-08-23 #5） | 第三方工具免编译挂载前提；自家工具清单数据化同样受益 |
| permissions.json 接插件声明 | ~2 天，**已拍板排进工程**（2026-08-23 #5） | 对外开放前的一票否决项 |

**B. 存量拆解（批次表；障碍勘定 2026-08-23 baton7 §1 逐族实证，「无障碍纯搬运」的乐观表述已修正）**：

> 勘定依据（四条机制约束，改代码前先对照）：
> ① **组合解析域边界**——roster/preset 只寻址 builtin 行（agent-builder 注释明示
> 「组合解析域目前只含 builtin 行——patch/preset 寻址插件行属 S4-4 机器桥批扩展」）；
> 行迁入插件通道即脱离 preset 禁用面——被 preset/patch 寻址的族搬运前需先扩通道。
> ② **实例缓存锁存**——pluginToolRows 的贡献实例缓存跨装配复用首装配实例；
> 依赖装配期真值的族（每装配换 ui 回调 / subAgentPool / 可选 registry）直接搬 =
> 跨装配串扰（INVARIANTS #1 同族雷）。B① 落地的缓解：贡献 factory 已放宽可选收
> ToolRowContext（services.ts），但收 ctx 的贡献仍自担跨装配语义等价责任。
> **2026-08-23 拍板 #2：①c 族走路线一「无缓存行」**——依赖装配期真值的贡献
> 不做实例缓存，每装配重创实例（不做代理间接层）；「收 ctx 的贡献自担等价
> 责任」的坑就此绕开。
> ③ **域收敛依赖注册面**——buildDomainTool 按注册表现存旧工具过滤 action
> （缺席 = 该 action 静默从域工具消失）；无引导环境（convergence 夹具 /
> gen-tool-contract）须经 composition/first-party-tools.ts 的
> withFirstPartyToolChannel 复现生产装配，否则快照/文档丢失该族。
> ④ **拼装序约束（prompt 域特有，B④ 试点勘定 2026-08-23）**——贡献恒在解析
> 产物末尾（A-1 已定型语义）；段迁入通道后其拼装位 = 贡献末位。零漂移迁移
> 因此仅限出厂段表**表尾后缀**：迁中段段（如 behavior-rules）会把该段挪到
> 输出尾部 = 拼装序变化 = 击穿 system-prompt.fixture 与前缀缓存。B④ 按
> 表尾逆序推进（试点/续批迁表尾 3 段，收官批一次性迁完剩余 10 段——末态
> 全量经通道后单批零漂移按构造成立，中间表尾序由头插保序；收官落地见
> B 表 ④ 行）。

| 批 | 内容 | 障碍 |
|---|---|---|
| ①a | git / search | ~~无~~ **已毕**（P4 B①，2026-08-23：只依赖无状态 codingExec，factory 收 ToolRowContext + 实例缓存语义等价；plugins/git-search-plugin.ts + first-party-tools.ts 通道腰；convergence 双 preset 零漂移实测） |
| ①b | web | 需通道 ①：minimal preset 寻址 `builtin/web` 禁用它——行搬走后脱离组合解析域，preset 禁用静默失效；需 S4-4「插件行纳入组合解析域」先行（**2026-08-23 拍板 #1：S4-4 复活整批做——甲寻址域扩展 + 乙进程桥同批，~2-3 天；迁移批排甲之后**） |
| ①c | wait / ask | 需通道 ②：依赖装配期真值（wait 的 subAgentPool 按装配变化、ask 的 ui 回调每次装配换）——实例缓存会锁存首装配真值；**2026-08-23 拍板 #2：路线一无缓存行——每装配重创实例** |
| ② | 工具大域 | 分族：**fs / shell / agent-isolation 已毕**（P4 ②，2026-08-23：同 ①a——无状态 codingExec，通道现成；plugins/coding-domain-plugins.ts 五族合并文件 + first-party-tools.ts 清单扩展，行表 12→9，convergence 双 preset 零漂移实测；行 id builtin/fs・shell・agent-isolation 退役，寻址它们报「未知行 id」——S4-4 甲恢复）；browser-desktop 同 ①b（minimal 寻址 `builtin/browser-desktop`）；memory / skill / task / agent 同 ①c（可选 registry / taskManager / spawner 按装配给值——①c 路线一已拍板） |
| ③ | hologram 族（graph/ops/lsp） | 同 ①c 变体：graphData 是装配期开关（缺帐行产出空集）——实例缓存会把首装配的 graphData 有无锁死；且 loadHologramSchemas 动态面需每装配刷新。异步 factory 已支持但缓存语义需另行设计 |
| ④ | prompt 段落（persona/规则/记忆/运行环境） | **已毕——收官（2026-08-23）**：13 段全量经 ctx.prompts 第一方插件通道贡献（试点 memory/claude-md → 续批 graph-snapshot → 收官批一次性迁完剩余 10 段）；`plugins/prompt-segments-plugin.ts` 装载 `firstPartyPromptSections()`（序 = 迁移前出厂表序，单批零漂移按构造、双 preset 实测）。收官落地三件：①`builtinPromptSections()` 退役、段表空壳删除、`assembleSystemPrompt` 缺省 = 空表（出厂面 = 解析产物 + 通道贡献）；②roster prompt 域寻址面 = 仅已插入段——寻址第一方段 id（disable/text/锚）报「未知段 id」整体拒绝，insert id 与第一方段同名不拒（两条临时语义，S4-4 甲恢复全寻址后消灭）；③注册面依赖面扩大——无通道环境缺省拼装 = 空提示词，convergence 夹具经 withFirstPartyPromptChannel 复现生产装配面（obstacle ③）。动态插值段无 ①c 缓存障碍（prompt 通道无实例缓存，render 每装配重调直收 PromptSectionContext）；roster 的 text 覆盖丢失动态插值语义由通道继承（贡献段脱离寻址域，S4-4 扩展点） |
| ⑤ | 会话级能力（plan/通信/discovery/merge/board/compaction） | 需通道 A-3——**已拍板排进当前工程**（2026-08-23 #4），设计件穿插机械批推进 |
| ⑥ | 管道参与（graph hooks/board tracking/preflight） | 需通道 A-2 |

拆解纪律：第一方插件仍编译期打包（VSCode 内置扩展同款）；收益是解耦/可禁用/
多窗口并行/契约固化，不是物理分包。特权区清单见 D9，只减不增，可用 git 度量。

**C. P4a 契约调研（不写码，半天）**：把 DSH 那圈服务契约清单化——最小子集
（ctx.tools 的 ToolDefinition 形状 + ctx.systemPrompt 的 section 注册表）、L1/L2
插件的真实依赖面分布、peer deps 版本策略。产出一页 dsh-contract-notes 进本仓库，
后续无论走哪条路都用得上。

**DSH 信号点亮后（可选追加）**：在自有 cordis 容器实现最小服务契约子集 +
dsh-compat 装载层（npm 包加载 + peer 版本协商 + 契约漂移检测），吃 L1/L2 工具类
插件生态；L3 深集成插件明确放弃（=重实现半个 DSH，不现实）。

**并行开放路径**：MCP 客户端——兰台引擎已是 MCP server；反向消费外部 MCP 工具
并入 registry 是比任何自造插件格式更标准的开放路径（也是 Rust 侧插件化的标准
形态：新能力优先做成进程外 MCP，不是往 src-tauri 加命令），与自研/compat 均可
并存，且不受 DSH 态度影响。

## 6. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Web Worker 非硬隔离，桥协议漏洞=越权 | D1 的敌意校验纪律（correlation-id 一次性+参数白名单化）；敏感工具（fs write/shell）本就过 permissions gate，嵌套调用不豁免 |
| R2 | 嵌套执行的 session-log 语义（derivePayload 冻结面） | P2 第 5 步强制；先读 agent-core-convergence Phase 5 立规，变更走 baseline change request |
| R3 | schema 面变动破前缀缓存 | D2/D7：增量=1 工具；capability 表序显式插入；上线前后对拍 effective 快照 |
| R4 | 模型滥用 code_execution 绕过工具粒度审计 | 子分发全记录（D5）——审计粒度不变，只是换了调用者 |
| R5 | webview Worker 的 CSP/eval 限制（Tauri 配置） | ✅ 已验证不成立（2026-08-22 spike：无 CSP，blob module worker + worker 内 eval/Function/import(blob:) 全通；笔记 `docs/research/_r5-web-worker-csp-spike.md`）。未来加 CSP 时需预留 `worker-src blob:` + `script-src blob: 'unsafe-eval'`（或改走 import(blob:) 免 eval） |
| R6 | 并发契约不清晰（程序内 Promise.all 撞写工具） | C7：文档显式声明；readOnly 并行规则沿用，写工具串行 |

## 7. 明确不做（Non-goals）

- 不摊平工具面到 DSH 规模（前缀缓存 + 桌面应用定位，domains 折叠是更优形态）
- 不造工作流引擎/DSL（D3）
- 不在本计划内动 cordis 内核本体
- 不做 Python 后端（DSH 的可移植契约值得学，但 HoloGram 单语言足够）
- typert 式跨进程类型协议（P4 前无需求）

## 8. 与既有计划的关系

- 前置完成：ui-react-island-retirement（Done）+ eventbus-zero-and-ui-split（Done，
  2026-08-19 竣工归档）——P3 前置已满足；P1/P2 无依赖（2026-08-22 校准）
- 本计划不动 ui/events.ts、不迁文件、不碰冻结四文件——与总线归零计划零冲突
