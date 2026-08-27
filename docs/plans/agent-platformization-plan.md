# Agent 平台化（Lantai Platform）总计划 —— 一个文档解决所有问题

> 立项：2026-08-25
> 状态：**Phase 3 已竣工（2026-08-27 深夜，三 commit）**——Phase 1（三 commit）+ Phase 2（四 commit）见 §5 落地记录；Phase 3：① `1505272f` seam 裁剪域进组合解析域 ② `68f1d2e5` 服务/事件目录生成器 + doc-sync 门禁 ③ `21ff8324` 开放面契约版本化 + plugin_install 版本比较。Phase 0-2 宪法边界已入档 + 守卫测试复验绿；**Phase 4（运行时插件全链路）待开工**
> 性质：能力建设计划（capability plan），不是还债（debt plan）
> 上位：`agent-plugin-architecture-plan.md`（P1-P4 已竣工部分）+ `composition-architecture/README.md`（S0-S4 已竣工 + 内核线）+ `docs/adr/project-constitution.md`
> 参照系：DeepSeek Harness（`D:\useful\deepseek-harness`，下称 DSH）；"DSH 实证"均给文件路径供执行者直查。
> 拍板背景（2026-08-25 用户定调）：往平台靠——**第三方优先、运行时动态生成插件、该做的彻底落地，只有施工顺序没有优先级**。
> **推翻声明（2026-08-25）**：本计划**推翻** `agent-plugin-architecture-plan.md` D9 中"Rust 壳（权限沙箱·IPC·Tauri）永不插件化 / Rust 侧插件化标准形态 = 外部 MCP server"的绝对化表述，以及 `composition-architecture/README.md` 内核线第 6 条"Agent↔engine 耦合带永久特权"。理由：平台目标下，能力契约必须开放；强制层（权限/沙箱/IPC/审计）保留特权，能力实现不保留。被推翻的旧裁定在 §9 列出对应关系。

## 铁律：拆旧立新宪章（先于一切施工段，一条不可协商）

> 本计划本质是重构（拆旧立新）。LLM 的天性是保守兼容——读旧代码后本能往上堆、保留旧路径、造兼容层、留过渡期。本宪章反转该默认值：**在此项目中，拆旧立新是常态，保守兼容才需要理由。** 与根目录 AGENTS.md / CLAUDE.md 的破坏性操作授权同源，此处按平台化施工场景收紧。

### 铁律 1 —— 翻转不叠加
建新必拆旧。新实现落地的施工段，其旧实现必须**在同一施工段内删除**。任何"新的先跑、旧的留着"的双线状态不得跨过施工段验收。

### 铁律 2 —— 零兼容层
禁止为旧行为写兼容层、双读、双写、渐进迁移、兼容垫片、`deprecated 保留一个版本`。旧格式/旧接口/旧路径**不迁即拆**；拆不掉的（用户明确要求保留）单独列清单，且只减不增。

### 铁律 3 —— 拆旧清单是每段的第一交付物
每个施工段开工时先列**拆旧清单**（要删的旧文件/旧符号/旧 switch/旧路径 + grep 锚点），收工时该清单**清零**。验收判据必须含"旧引用 grep 归零"——旧模块/旧工具名/旧 factory switch/旧 providers 残留 = 红。

### 铁律 4 —— 测试陪葬
删行为时同步删除/改写为它服务的测试。**测试不许为旧行为陪葬，也不许假装没看见**——旧测试要么改到新路径、要么删除，不存在"旧测试保留验证旧行为"。

### 铁律 5 —— 单一权威源
任何一份状态/实现/契约只有一个家。迁移时旧权威删除、新权威接管。判定问题：「这个值/这条路径，有几处代码知道？」答案 >1 即违例。

### 铁律 6 —— 快照钉行为
涉及模型可见行为（工具面 / prompt / 装配序 / 事件）的迁移：先对拍「新路径 ≡ 旧路径」（快照/收敛），**对拍通过后才删旧**；删旧后快照成为唯一基准。

### 铁律 7 —— 一次只翻一条 seam
同一施工段内只翻转一条 seam/一条通道。禁止"多 seam 并行过渡"造成的状态爆炸。翻转完成（旧代码删净 + 门禁绿）才动下一条。

### 铁律 8 —— 区分"多实现"与"双线"
**禁止的是"同一能力的旧新两套实现同时在调用路径上"；不禁止"同一 seam 的多个 provider 并存"**——后者正是平台的目标（anthropic/openai adapter 并存是设计，不是烂摊子）。判定：同一功能被调用路径数 >1（且非显式多 provider seam）即违例。

### 铁律 9 —— 门禁红 = 没改完
对应验证门禁全绿才允许 commit；红着不许"先 commit 以后修"。行为变更（哪怕变对了）写进 commit message。

### 铁律 10 —— 不写 deprecated
不写 `deprecated` 标注、不写兼容分支、不写"旧行为回退"。旧的不合理就拆干净，拆干净比绕着走重要。

### 铁律 11 —— git 换历史，不绕行
移动文件用 `git mv` 保历史；「动静太大」不是不拆的理由。禁止用"最小 diff"借口把病灶留在仓库里。

### 铁律 12 —— LLM 默认值反转
默认拆旧，兼容才需要理由。任何「保留旧路径」的提议必须显式说明理由并经用户认可，否则一律按违例处理。

**执行机制（强制每个施工段）：**
1. **第一步**：列本段**拆旧清单**（旧文件/旧符号/旧 switch/旧路径 + grep 锚点，逐条可查）。
2. **最后一步**：拆旧清单**清零** + 旧引用 grep 归零 + 门禁全绿。
3. 清点不清零 = 施工段未完成，**不允许进入下一段**。

## 0. 这份文档解决什么（读法）

一份文档 = 平台边界（宪法）+ 全量开放面（seam 清单）+ 完整施工顺序（Phase 0-6）+ 每段验收判据 + 风险 + 明确不做。**不需要第二份计划来解释"平台是什么、拆什么、怎么验"。** 设计件只在对应施工段落地时另行产出，本文件的裁定是最高位，设计件不得反向推翻。

## 1. 现状（2026-08-25 实测）

**已有（底座是 DSH 同宗的 vendored cordis）：**

- **12 个 `ctx.*` 服务**：8 个文档化贡献通道（`panels` / `commands` / `tools` / `providers` / `renderers` / `prompts` / `hooks` / `capabilities`）+ `overlays`（画布形态槽位）+ `space`（画布 API）+ `lsp` + `codeRuntime`（代码执行服务）。
- **外部插件**：自包含 ESM + manifest（`name/version/entry/inject/permissions/tools/mcpServers`），经 webview 动态 import 装载（`src-ui/src/plugins/loader.ts`），失败隔离 + 装载期形状守卫。
- **MCP 机器桥**：`manifest.mcpServers` 声明式挂接外部 MCP server（stdio/http、lazy/startup-error），一 server = 一条工具行贡献（`src-ui/src/plugins/mcp-bridge.ts`）。
- **组合域**：roster 行 + patch 叠加 + preset realm（standard/minimal）+ 贡献行/段全量可寻址（S4-4 甲）。
- **出厂面全通道化**：14 工具域 / 13 prompt 段 / 15 capability 全量经第一方插件通道贡献（P4 B 批收官）。
- **patch 级热重载**：`composition_watcher` → `composition:changed` → `reloadCompositionPatch`（Rust 侧已有）。

**缺（本计划要补的）：**

| 缺口 | 现状 | 本计划动作 |
|---|---|---|
| LLM adapter 未全量进 seam | 方言贡献道已在位（2026-08-26 commit `62860fb7` 兑现：`{id,kind,create}` 强类型、同 kind 后注册胜、未知 kind 响亮报错）；但 anthropic/openai 仍是 `resolveProviderDialect` 的内核回落分支 | 升格为 `ctx.llm`：服务更名 + 两枚第一方 adapter 贡献 + 删内核回落（D2 修订版） |
| 子代理单一实现 | `subagent-spawn.ts` 进程内唯一实现 | 拆成 `ctx.subagents` provider 注册表（D3） |
| 事件面只有 5 个工具事件 | `agent/events.ts`（guard/preflight/around/result/error） | 扩成全 loop 事件表（D4） |
| ~~`ctx.providers` 是空通道~~ **前提已失效** | 2026-08-26 已兑现为真实方言贡献道（有消费方有守护测试，非空通道） | **D5 作废（2026-08-27 用户拍板 A 路线）**——该通道即 `ctx.llm` 本体，升格吸收而非退役（见 §3 D2/D5 修订注记） |
| 外部插件装卸禁用重启生效 | `docs/plugins/README.md` §5 | 运行时热重载（D6） |
| 无运行时动态生成插件 | 只有磁盘 JS + MCP | `ctx.dynamicRunner`（D7） |
| **后端能力全部锁死** | fs/shell/subprocess/session/graph 全在 Rust 命令层，无 seam | **后端能力 seam 化（D11）**——Rust/engine 降为默认 provider |
| **agent loop 是特权黑盒** | `agent.ts` / `execution-state.ts` 不可替换 | **降为第一方默认实现（D13）**，事件/服务面开放 |
| 信任模型与"第三方优先"矛盾 | 完全信任模型只适合第一方/熟人 | 动态插件 approval+沙箱，静态插件沙箱化列为后续硬化（D12） |

## 2. 目标形态（平台边界图）

```
┌────────────────────────── 强制层 / 基础设施（特权，永不插件化）──────────────────────┐
│  cordis kernel + 根引导 │ Loader + 组合引擎本体 │ slot/注册表机制（12+ 个 ctx 服务的注册机制）│
│  React root + 壳容器 │ RPC 平台面（rpc.rs 冻结契约 + 权限咽喉 + agentInvoke）│          │
│  沙箱内核（os_sandbox / sandbox 强制原语）│ 审计 │ Workspace 原语（fiber·epoch·scoped store）│
└──────────────────────────────┬──────────────────────────────────────────────────────┘
                               │ 线外一切皆行 / 皆 seam
┌──────────────────────────────▼──────────────────────────────────────────────────────┐
│  能力契约层（swappable seam，默认 provider = Rust/engine 包装）                       │
│  ctx.llm（新）│ ctx.subagents（新）│ ctx.fs（新）│ ctx.shell（新）│ ctx.subprocess（新）│
│  ctx.sessionPersistence（新）│ ctx.graph / analysis（新）│ ctx.sandboxPolicy（策略面）│
│  全 loop 事件表（新）                                                               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  贡献面（已在位）                                                                    │
│  ctx.tools │ ctx.prompts │ ctx.capabilities │ ctx.hooks │ ctx.renderers             │
│  ctx.panels │ ctx.commands │ ctx.overlays │ ctx.space │ ctx.lsp │ ctx.codeRuntime    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  运行时插件（新，D7）│ 外部 MCP server │ 外部 ESM 插件（已在位）                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**试金石（重推后）：独占进程级单例资源 / 有顺序契约 / 是强制层（权限·沙箱·审计·IPC）→ 特权；功能面 / 可换实现 / 可叠加 → 行或 provider。** Rust/engine 的**能力实现**不是特权——它们只是默认 provider。

## 3. 关键裁定（决定表——本文档拍板，不再留问题）

| # | 裁定 | 内容 |
|---|---|---|
| **D1** | 平台边界（推翻 D9 绝对化） | **强制层特权，能力契约全开。** 特权 = cordis 内核 / 组合引擎 / 注册表机制 / React root+壳 / RPC 平台面（含权限咽喉）/ 沙箱内核 / 审计 / Workspace 原语。**线外 = 所有能力**：llm、subagents、fs、shell、subprocess、session persistence、graph/analysis、sandbox 策略面，全部成为前端组合层 seam；Rust/engine 是默认 provider 后端，不再是"不可替换的能力"。 |
| **D2** | LLM adapter seam | 原文：`createProvider` 的 factory switch → `ctx.llm` 注册表。`anthropic.ts` / `openai.ts` 迁成两个 adapter 插件（第一方先例，settings-plugin 样式）。设置/模型目录驱动选择。**【修订 2026-08-27，用户拍板 A】**commit `62860fb7`（2026-08-26）已把空壳兑现为强类型方言贡献道（同 kind 后注册胜、dispose 分层恢复、未知 kind `PROVIDER_DIALECT` 响亮报错），本裁定吸收其为 `ctx.llm` 本体：`ProvidersService`/`ctx.providers` 更名 `LlmService`/`ctx.llm`（沿用既有四 service 结构落 `composition/services.ts`，不另立文件），anthropic/openai 从内核回落分支迁为两条第一方 adapter 贡献并删除回落分支；`createProvider(settings)` 保留为消费单一入口（内部查 `ctx.llm`，消费方不经此函数外均直查注册表）。 |
| **D3** | 子代理 provider seam | `spawnSubAgentImpl` → `ctx.subagents` provider 注册表。进程内实现 = 默认 provider；consumer = tool-subagent。未来 ACP/外部后端可挂。 |
| **D4** | 事件面扩展 | 5 工具事件扩成全 loop 事件表（turn/step/request/tool 生命周期 + 能力事件域），每个事件声明 mode（emit/waterfall/serial/parallel）+ 目录生成 + 完整性 guard。**loop 本体不是特权**（见 D13）——事件是监听面，loop 是默认实现。 |
| **D5** | `ctx.providers` 退役 | **【作废 2026-08-27，用户拍板 A 路线】**原裁定的事实前提（"空通道无消费者"）被 commit `62860fb7`（2026-08-26 方言贡献道收口）推翻：该通道现为唯一 LLM adapter 贡献面且行为已提交规范 ADR。按项目纪律「规则与代码冲突以代码为准」，处置改为**升格吸收**（D2 修订版：更名 `ctx.llm` 进平台边界图）而非退役；"泛化通道不复用、每个 seam 类型化专用"的精神保留——`ctx.llm` 就是类型化专用表，不恢复任何泛化 provider 语义。原裁定文字仅供历史追溯：~~空通道无消费者 → 删除 ProvidersService + 文档行 + 引用~~。 |
| **D6** | 外部插件热重载 | install / uninstall / disable 从"重启生效"改为**运行时生效**：写 `plugins.json` → 对已装载插件做 fiber dispose / 装载 / 贡献变更广播（复用 patch 热重载机制）。 |
| **D7** | 运行时动态生成插件 | 建 `ctx.dynamicRunner`（DSH `cordis-host-runner` 同构）：运行时 define → run → stop → undefine cordis 插件包；**动态插件可提供任意 seam**（工具/面板/llm adapter/fs provider/…），不只是工具行。宿主半进 vm 沙箱（对齐 `code-runtime` worker 的敌意校验纪律）；模型工具面 = `cordis_*` 族（形状对齐 DSH `tool-cordis`）。 |
| **D8** | 特权区只减不增 | 本计划从特权区**减出**：LLM、子代理、工具管道监听面、fs/shell/subprocess/session/graph 能力实现、agent loop（降为默认实现）。**不新增任何特权代码**。减出清单可用 git 度量（对应代码从特权区迁出 = 减一行特权）。 |
| **D9** | 平台税随段落 | 版本化 / 目录生成 / 完整性 guard / 文档**随每个 Phase 落**，不是最后统一补（对齐 DSH 的 gen-* + verify-* 纪律与"随改随生成"）。 |
| **D10** | C12 dsh-compat 挂起 | `agent-plugin-architecture-plan` C12（dsh-compat 装载层）保持外部信号挂起（等 DSH peer 非 workspace 版本），**不在本计划关键路径**。本计划自研为主，形状与 DSH 契约兼容、零依赖原则保留。 |
| **D11** | 后端能力 seam（新） | `ctx.fs` / `ctx.shell` / `ctx.subprocess` / `ctx.sessionPersistence` / `ctx.graph`（analysis）成为前端组合层 seam。**默认 provider = 现有 Rust/engine RPC 的薄包装**，行为与现状逐字节一致；替代 provider 可以是 JS 插件、MCP、远程后端。强制层（权限咽喉 / 沙箱内核 / 审计）不被 provider 绕过——它在工具管道与 RPC 平台面，不在 provider 里。**【修订 2026-08-27，施工⑤ · Agent 自主裁定】**`ctx.subprocess` 并入 `ctx.shell`：现有形态中 spawn/stdio/进程树即 shell 的 `exec_command` 后台任务族（runInBackground + bash_output/wait/kill），独立 subprocess 通道无第二消费者，按「无消费者不开通道」纪律不开空通道；后续真出现独立子进程消费面（如远程执行后端）再按需开道。 |
| **D12** | 信任模型修订（新） | v1 维持：静态插件完全信任（现状如实入档）。**动态插件 = approval + vm 沙箱**（D7 落地件）。静态插件沙箱化 / 签名 / 隔离列为**后续硬化项**（Non-goals），但平台契约文档必须把"完全信任"写为 v1 已知债——第三方优先下这是明牌，不是秘密。 |
| **D13** | agent loop 降为默认实现（新） | `agent.ts` / `execution-state.ts` 的流式循环从"永久特权"降为**第一方默认实现 `ctx.agentLoop`**（对齐 DSH：`ctx.agentLoop` 是 bundle，扩展方依赖事件/服务，不依赖 loop 包）。第三方通常不替换 loop，但契约上可替换；Phase 5 完成抽取。 |

## 4. 开放面全量清单（seam 清单）

| seam / 通道 | 类型 | 现状 | 本计划动作 | 默认实现 | 消费方 |
|---|---|---|---|---|---|
| `ctx.tools` | 贡献通道 | ✅ 14 域 + 外部插件 + MCP | 无（已在位） | — | Agent 装配 / tool-contract |
| `ctx.prompts` | 贡献通道 | ✅ 13 段全通道化 | 无 | — | assembleSystemPrompt |
| `ctx.capabilities` | 贡献通道 | ✅ 15 项全通道化 | 无 | — | AgentBlueprint.fromRoster |
| `ctx.hooks` | 贡献通道 | ✅ enrich/preflight | 无 | — | 工具管道 |
| `ctx.renderers` | 贡献通道 | ✅ 7 内置 + 覆盖 + `*` 兜底 | 无 | — | paper 块渲染 |
| `ctx.panels` / `ctx.commands` | 贡献通道 | ✅ | 无 | — | 壳 UI |
| `ctx.overlays` / `ctx.space` | 贡献通道 / API | ✅ | 无 | — | 画布 |
| `ctx.lsp` | 服务 | ✅ | 无 | — | lsp 工具 |
| `ctx.codeRuntime` | 服务 | ✅ | 无 | — | code_execution |
| **`ctx.llm`** | **swappable seam（升格中）** | ⚠️ 方言贡献道已在位（`62860fb7`），缺 adapter 迁移 + 命名归一 | **D2 修订版**：`ProvidersService`→`LlmService` + 两 adapter 第一方贡献 + 内核回落删除 | anthropic / openai adapter（第一方贡献） | 流式执行 / 摘要 / 翻译 / 标题 |
| **`ctx.subagents`** | **swappable seam（新）** | ✅ 施工②落地：`composition/subagent-service.ts` + in-process 默认 provider，消费面 = `Agent.spawnSubAgent` 单点 | **D3**（已落地 2026-08-27） | in-process（`builtin/in-process`，逐字节透传 spawnSubAgentImpl） | tool-subagent / blueprint spawn 绑定 |
| **`ctx.fs`** | **swappable seam（新）** | ✅ 施工④落地：`fs-service.ts` + `builtin/rust-fs`（动作→命令恒等映射经 dispatch 腰），tool-fs 消费面 `fsExecute` 单点改查 | **D11**（fs 已落地 2026-08-27；编辑器等非工具消费面 = P5 全量挂 seam） | `builtin/rust-fs`（逐字节透传） | tool-fs（coding.ts fs 域 11 动作） |
| **`ctx.shell`** | **swappable seam（新）** | ✅ 施工⑤落地：`shell-service.ts` + `builtin/rust-shell`（run/output/kill/wait → exec_command/bash_* 恒等映射），shell 域四工具消费面 `shellExecute` 改查 | **D11**（已落地 2026-08-27） | `builtin/rust-shell`（逐字节透传） | tool-shell（coding.ts shell 域） |
| **`ctx.subprocess`** | ~~swappable seam~~ | **并入 `ctx.shell`（2026-08-27 施工⑤修订）**——spawn/stdio/进程树即 shell 后台任务族，无第二消费者不开空通道 | **D11 修订注记** | （=ctx.shell 默认 provider） | （=ctx.shell 消费面） |
| **`ctx.sessionPersistence`** | **swappable seam（新）** | ✅ 施工⑥落地：`session-persistence-service.ts` + `builtin/rust-sessions`（六动词→文件/追加命令恒等映射），agent-store 消费面 `sessionExecute` 改查（状态/NDJSON/索引/事件日志/删档全覆盖） | **D11**（已落地 2026-08-27） | `builtin/rust-sessions`（typedRpc 直连恒等透传） | agent-store（单一权威源） |
| **`ctx.graph`** | **swappable seam（new）** | ✅ 施工⑦落地：`graph-service.ts` + `builtin/rust-graph`（invoke 经 hologram_call 恒等派发），hologram 域 holoExec 改查 | **D11**（已落地 2026-08-27；dataflow_save/query 落盘 RPC 保持直连——非分析查询） | `builtin/rust-graph`（engine RPC 包装） | hologram 域 holoExec |
| **全 loop 事件表** | **监听面（新）** | ✅ 施工③落地：13 事件表（5 工具 + turn/step/request 六事件 + subagent 能力域首批），Agent.onLoopEvent 监听面 + 七发射点；第一方重表达 = P5 | **D4**（已落地 2026-08-27） | — | 全部第一方功能重表达（P5） |
| **`ctx.dynamicRunner`** | **运行时定义 seam（新）** | ❌ | **D7** | vm 沙箱宿主 | `cordis_*` 模型工具 |
| **MCP 能力面** | 进程外能力 | ✅ 机器桥 | 扩展（D1） | — | ctx.tools 消费 |

## 5. 施工顺序（从头推到尾）

> 顺序即依赖：后一段必须等前一段落地才能动。每段验收 = 门禁全绿 + 出厂面归零 + 文档同步。**只有施工顺序，没有优先级。**

### Phase 0 —— 平台宪法定稿

> **落地记录（2026-08-25，commit 随本段）**：① `composition-architecture/README.md` 内核线改为强制层/能力契约层二分（删"Agent↔engine 耦合带永久特权"）；② `agent-plugin-architecture-plan.md` D9 特权区清单修订 + 作废"MCP-only"绝对化；③ 宪法增补第五条「平台边界」（强制层特权、能力契约全开、强制层外零增长、新能力走开放面）；④ 守卫测试 `src-tauri/tests/platform_boundary_test.rs`（命令模块基线 17 项冻结，`cargo test --test platform_boundary_test` 绿）；⑤ `docs/plugins/README.md` 信任模型如实入档为 v1 已知债（动态插件 approval+沙箱，静态沙箱化=后续硬化）。全部遵守「拆旧立新宪章」：旧的内核线/旧 D9 表述就地改写，不保留双源。

**做什么：** 把 D1-D13 落进权威文档，让"边界"变成代码里可检查的约定。

1. 重写 `docs/plans/composition-architecture/README.md` 的**内核线**：强制层 / 能力契约层二分；删"Agent↔engine 耦合带永久特权"；增补"能力实现不是特权，Rust/engine = 默认 provider"（D1/D11）。
2. 修订 `agent-plugin-architecture-plan.md` D9 特权区清单：减出 LLM / 子代理 / 工具管道监听面 / 后端能力实现 / agent loop（D8/D11/D13）；明确推翻"Rust 侧插件化标准形态 = 外部 MCP server"的绝对化。
3. `docs/adr/project-constitution.md` 增补**平台边界**最高约定（或另立 `docs/adr/platform-boundary.md` 并挂进宪法，执行时定）：强制层 / 能力契约层二分 + 试金石 + 新能力加面规则（优先开放面，强制层改动需宪法审查）。
4. 门禁：一条守卫测试（或静态扫描）钉住"**强制层外**不得新增 Rust 命令"——把 D1 从"零增长"改为"强制层外零增长"（强制层内改动需显式标注 + 审查）。
5. 信任模型如实入档（D12）：`docs/plugins/README.md` 的完全信任段改为 v1 已知债 + 动态插件 approval/沙箱说明。

**验收判据：**
- 四份文档（composition README / agent-plugin plan / 宪法 / plugins README）同向，无互相矛盾的定义。
- 存在可运行的度量（强制层外命令数守卫 / 特权区文件清单 diff），让"特权区只减不增"变红可见。

**谁判断：** 用户拍板（宪法改动）。这是本计划唯一需要用户先拍板的一段——拍完 D1-D13 即冻结，后续施工段全部 agent 可自主推进。

### Phase 1 —— 前端 swappable seam 开放（契约先行）

> **落地记录（2026-08-27 夜，三 commit 铁律 7 分段）**：开工时用户拍板 A 路线修订 D2/D5（方言贡献道先例吸收）。① `98a6f30d` ctx.llm：更名 + llm-adapters-plugin 贡献 + 内核回落拆除（P1-C1/C2/C5 达成，T1-T6 清零）；② `605d6e8a` ctx.subagents：service + in-process 默认 provider + spawnSubAgent 消费单点改查（P1-C3 达成，T7 清零）；③ D4 事件面：13 事件表 + Agent.onLoopEvent + 七发射点 + `docs/agents/event-feature-map.md`（P1-C4 达成；baseline-change-request 评估零基线文件变更，用户批准留痕于 `docs/archive/agent-core-convergence/baseline-change-request.md`）。门禁四连全绿（vitest 1806 passed / build / biome 0/0 / convergence standard 零漂移）。**谁判断：Agent 自主（用户仅拍板 D2/D5 修订与 D4 基线评估）——本段按计划主体自主推进。**

**做什么：**

1. **`ctx.llm`（D2，修订版）**：方言贡献道升格落位——`composition/services.ts` 内 `ProvidersService`→`LlmService`、Context 键 `ctx.providers`→`ctx.llm`、读取面 `activeProviderContributions()`→`activeLlmAdapters()`（沿用四 service 同文件结构，不另立 llm-service.ts）；新建第一方 `plugins/llm-adapters-plugin.ts` 把 anthropic/openai 经 `ctx.llm.register` 贡献为两条 adapter（生产经 loadBuiltinPlugins 表尾装载，测试沿用「装配复现助手」先例）；`provider/index.ts` 删内核回落 if 分支，只余「贡献扫描（后注册胜）→ 未命中 `PROVIDER_DIALECT` 响亮报错」。消费方（流式 createLiveProvider / 摘要 compaction）以 `createProvider(settings)` 为单一入口不动。
2. **`ctx.subagents`（D3）**：新建 `src-ui/src/composition/subagent-service.ts`；`spawnSubAgentImpl` 抽成默认 in-process provider；tool-subagent 成为 consumer。
3. **事件面扩展（D4）**：`agent/events.ts` 5 事件扩为全 loop 事件表（turn/step/request/tool + 能力域），每个事件声明 mode + 单一真源 + T0 门禁；落 feature→mechanism map，第一方功能逐个重表达为监听器。
4. ~~`ctx.providers` 退役（D5）~~ **作废（2026-08-27 用户拍板 A 路线，见 §3 D5 注记）**：退役对象已被 8-26 兑现并升格吸收——本条改执行旧名归零（拆旧清单 T2/T3/T4）。
5. **第一方迁移**：LLM adapter 两枚、子代理默认 provider 挂上注册表；出厂面零硬编码（`createProvider` 的 switch 消灭）。

**动哪些文件：** `src-ui/src/composition/services.ts`（LlmService 更名落位）、`src-ui/src/provider/index.ts`（回落分支拆除）、新 `src-ui/src/plugins/llm-adapters-plugin.ts`、`src-ui/src/composition/subagent-service.ts`（新）、`src-ui/src/agent/subagent-spawn.ts` + tool-subagent 消费面、`src-ui/src/agent/events.ts`、相关测试（composition-services / provider-dialect / provider-live / composition-consumption-wiring 等）、文档同步（provider-system-spec / ARCHITECTURE §4.8 / plugins README / AGENTS / CLAUDE）。

**拆旧清单（本段第一步交付物，收工清零——铁律 3）：**

| # | 旧物 | grep 锚点 | 归宿 |
|---|---|---|---|
| T1 | `resolveProviderDialect` 内核回落分支（kind==='anthropic'\|\|'openai' 直调工厂） | `src-ui/src/provider/index.ts` | 删——两协议迁 adapter 贡献后未命中即响亮报错 |
| T2 | `ProvidersService` 类名 + Context 键 `providers` | grep `ProvidersService` / `ctx.providers` / `root.providers` | 更名 `LlmService` / `ctx.llm` |
| T3 | 读取面旧名 `ProviderContribution` / `activeProviderContributions` / `_activeProviders` / `setActiveProviders` / registry 标签 'providers' | grep 同名符号 | 更名 `LlmAdapterContribution` / `activeLlmAdapters()` / `_activeLlm` 等 |
| T4 | 文档旧名：AGENTS·CLAUDE「六 service…provider」表述、ARCHITECTURE §4.8 方言贡献道行、`docs/design/provider-system-spec.md` 追加裁决节、plugins README | grep `ProvidersService` 于 docs/*.md | 同步更名 |
| T5 | 过时注释/断言：`tests/composition-consumption-wiring.test.ts` 头注「providers 留注册表现状（不接线）」已与 8-26 收口后的现实矛盾 | 该文件头注 | 改写到新语义 |
| T6 | 测试旧名引用：composition-services.test.ts / provider-dialect.test.ts 的类型导入与注册调用 | grep | 改写到新名 |
| T7 | `Agent.spawnSubAgent` 直调 `spawnSubAgentImpl`（seam 旁路点） | grep `spawnSubAgentImpl` 于 `src/agent/agent.ts`（消费侧） | 消费改经 `ctx.subagents` 注册表；impl 本体保留为默认 provider 内核（施工②） |
| T8 | fs 工具直派生命令（`exec('read_file_content'…)` 等 11 处——seam 旁路点） | grep `exec\('read_file_content'\|'write_file_content'\|'edit_file'\|'list_directory'\|'glob'\|'create_directory'\|'move_file'\|'rename_file_or_dir'\|'delete_file_or_dir'\|'read_constraints'\|'write_constraints'` 于 coding.ts | 消费面改 `fsExecute(action…)` 经 `ctx.fs` 注册表；命令名映射移入 `builtin/rust-fs`（施工④） |
| T9 | shell 工具直派生命令（`exec('exec_command'…)` 等 4 处——seam 旁路点） | grep `exec\('exec_command'\|'bash_output'\|'bash_kill'\|'bash_wait'` 于 coding.ts | 消费面改 `shellExecute(action…)` 经 `ctx.shell` 注册表；命令名映射移入 `builtin/rust-shell`（施工⑤） |
| T10 | agent-store 直连 typedRpc（read/write/append/appendLog/mkdir/delete 六动词 9 处——seam 旁路点） | grep `typedRpc\('read_file_content'\|'write_file_content'\|'agent_session_append'\|'log_append'\|'create_directory'\|'delete_file_or_dir'` 于 agent-store.ts | 消费面改 `sessionExecute(action…)` 经 `ctx.sessionPersistence` 注册表；命令名映射移入 `builtin/rust-sessions`（施工⑥） |
| T11 | hologram 域 holoExec 直连 `agentInvoke('hologram_call')`（seam 旁路点） | grep `hologram_call` 于 coding-domain-plugins.ts | 消费面改 `graphExecute(tool…)` 经 `ctx.graph` 注册表；hologram_call 派发移入 `builtin/rust-graph`（施工⑦） |

> settings 层 `s.providers`（配置行模型）与本 seam 无涉，一律不动。

**施工记录（滚动更新，每条 seam 翻转一账——铁律 7）：**
- **施工①（2026-08-27 夜）**：LLM 通道升格落地——`LlmService`/`ctx.llm` 更名（T2/T3）、`plugins/llm-adapters-plugin.ts` 两条第一方 adapter 贡献 `builtin/anthropic` + `builtin/openai`（ctx.effect 登记，loader 表序第二行）、`resolveProviderDialect` 内核回落 if 分支拆除（T1），裸路径未命中 = `PROVIDER_DIALECT` 响亮报错（P1-C2）；测试装配复现 shim ×3（provider-live / provider-factory / summary-model-selection）+ provider-dialect 重写（裸路径降级 / 生产路径 / 后注册胜 / 全撤回落内置）；文档同步 T4/T5。T1-T6 全清零。门禁：vitest 1797 passed / build ✓ / biome ci 0/0（463 文件）/ convergence exit 0。commit `98a6f30d`。
- **施工②（2026-08-27 夜）**：`ctx.subagents` seam 落地——`composition/subagent-service.ts`（SubagentsService / SubagentProvider / SubAgentSpawnArgs·Outcome，复用 ContributionRegistry 单一内核）+ `agent/subagent-provider.ts`（`builtin/in-process` 逐字节透传 spawnSubAgentImpl + inProcessSubagentPlugin）+ loader 表序第三/四行 + `Agent.spawnSubAgent` 消费面改查注册表（后注册胜；无注册响亮 `SUBAGENT_PROVIDER` 报错）。拆旧清单 T7 清零（agent.ts 直调 spawnSubAgentImpl 消灭）。测试：新 `subagent-seam.test.ts` 四守护（裸路径降级 / 在册默认 / 后注册胜覆盖回落 / 消费路由）+ 幂等装配复现 helper（`tests/helpers/composition-boot.ts`）收编三处 llm shim + 两个真实 spawn 套件接入（parallel-subagent-bugs / subagent-activity-wiring）。
- **施工④（2026-08-27 夜，Phase 2 开工）**：`ctx.fs` seam 落地（D11 第 1/4 段）——`composition/fs-service.ts`（FsService / FsProvider / FsAction 11 动作 / FsCallOptions.dispatch 腰注入）+ `agent/fs-provider.ts`（`builtin/rust-fs` 动作→命令恒等映射）+ loader 表序第五/六行 + `coding.ts` fs 域 11 个 execute 体改查注册表（`fsExecute` 消费单点导出；无注册响亮 `FS_PROVIDER` 报错）。拆旧清单 T8 清零。测试：新 `fs-seam.test.ts` 五守护（裸路径降级 / 派发恒等路由 / rename 键映射 / 内存 provider 替换零消费面改动 + 不触 Rust 腰 / **P2-C3 gate 不旁路**——plan 激活拦截时 provider 与 dispatch 均未触）；P2-C2 由 ④ 用例 + 既有 6 文件 shim 接入满足（helper +2 通道；define-tool / tool-param-contract / coding-domain-plugins 各补装配复现）。非工具消费面（Monaco file-viewer / runLoop 计划文件读取等）保持 typedRpc 直连不动——P5 全量挂 seam 时统一（拆旧清单外注记）。
- **施工⑤（2026-08-27 夜，Phase 2 2/4）**：`ctx.shell` seam 落地 + **D11 修订：ctx.subprocess 并入 ctx.shell**（spawn/stdio/进程树 = exec_command 后台任务族；独立通道无第二消费者，按「无消费者不开通道」纪律不开空通道——Agent 自主裁定留痕于 D11 修订注记）。`composition/shell-service.ts`（ShellService / ShellProvider / ShellAction run·output·kill·wait）+ `agent/shell-provider.ts`（`builtin/rust-shell` 恒等映射）+ loader 表序第七/八行 + `coding.ts` shell 域四工具改查（`shellExecute` 消费单点；无注册响亮 `SHELL_PROVIDER` 报错）。拆旧清单 T9 清零。测试：新 `shell-seam.test.ts` 四守护（裸路径降级 / 派发恒等 / 内存 provider 替换零消费面改动 / **P2-C3** plan 拦截 provider·dispatch 双未触）；装配复现 helper +2 通道；coding-domain-plugins 补 shell 通道。
- **施工⑥（2026-08-27 夜，Phase 2 3/4）**：`ctx.sessionPersistence` seam 落地——`composition/session-persistence-service.ts`（SessionPersistenceService / 六动词 read·write·append·appendLog·mkdir·delete；appendLog = 会话事件日志 log_append，实测 agent-store 消费面盘点时发现的第六动词）+ `agent/sessions-provider.ts`（`builtin/rust-sessions` 恒等映射，typedRpc 直连——基础设施层无 meta 无腰，方法名类型收窄到 RpcContract 键）+ `agent-store.ts` 消费面全量改查（9 处直连消灭；拆旧清单 T10 清零）。范围注记：chat-session.ts 卷落盘写链保持 typedRpc（冻结文件 + 非管道消费面，P5 统一）。测试：新 `sessions-seam.test.ts` 三守护（裸路径降级 / 映射表恒等钉 / AgentStore 全 CRUD 经 fake provider 路由的零消费面改动——P2-C2 同型）。
- **施工⑦（2026-08-27 夜，Phase 2 4/4）**：`ctx.graph` seam 落地——`composition/graph-service.ts`（GraphService / GraphProvider.invoke）+ `agent/graph-provider.ts`（`builtin/rust-graph` 经 hologram_call 派发，与旧 holoExec 逐字节等价）+ `coding-domain-plugins.ts` holoExec 改查（拆旧清单 T11 清零）。范围注记：dataflow_save/query 为 .lantai/dataflow 落盘 RPC 非分析查询，保持直连。测试：新 `graph-seam.test.ts` 四守护（裸路径降级 / builtin 派发恒等 / fake 替换零消费面改动 / provider 独立可用形状）。

**验收判据（判据号 P1-Cn）：**
- P1-C1：`createProvider` 无 switch；anthropic/openai 各是 `ctx.llm` 的一条 adapter。
- P1-C2：不装 adapter 时装配仍可启动（降级显式，非静默）。
- P1-C3：子代理经 `ctx.subagents` 注册表派发；默认 provider 行为与现状逐字节一致（快照/测试钉住）。
- P1-C4：事件表覆盖 turn/step/request/tool 全生命周期，mode 门禁全绿；feature→mechanism map 落档。
- P1-C5：旧名归零（判据精确化）——`ProvidersService` / `ctx.providers` / `activeProviderContributions` / `ProviderContribution` 在 **src-ui 源码与活文档引用归零**；唯一例外 = 更名记录本体（计划 §3 D2/D5 修订行、spec 追加裁决第 5 条的旧→新映射、spec §历史段一处 dated 历史名标注）——这些是有意保留的 dated 历史，不是活引用。ARCHITECTURE §4.8 / provider-system-spec / docs/plugins README / AGENTS·CLAUDE 手册同步更名完成。settings 层 `providers: ProviderSettings[]` 配置字段是另一概念（用户配置行模型），不在清除范围。
- P1-C6：门禁 = `cd src-ui && npm run build && npx vitest run && npx biome ci .` + `npm run verify:convergence`（动 agent/** 必过，standard 零漂移）。

**谁判断：** Agent 自主（D1-D13 已冻结）。

### Phase 2 —— 后端能力 seam（默认 provider 包装 Rust/engine）

> **落地记录（2026-08-27 深夜，四 commit 铁律 7 分段）**：④ `4c7b6467` ctx.fs（11 动作，tool-fs 消费面改查，P2-C1/C2/C3 达成，T8 清零）；⑤ `4bcd0c05` ctx.shell（四动作 + **D11 修订：ctx.subprocess 并入 ctx.shell**——spawn/stdio/进程树即后台任务族，无第二消费者不开空通道，Agent 自主裁定留痕于 D11 注记，T9 清零）；⑥⑦ `daae88c3` ctx.sessionPersistence（六动词，agent-store 单一权威源改查，T10 清零）+ ctx.graph（holoExec 改查，T11 清零）。**P2-C4 汇总**：src-tauri cargo test 全量——bin 417 passed + 集成 15/15 全绿；唯一失败 `cdp::e2e::e2e_multi_account_profiles_and_cookies` = 基线在册环境型用例（需真实浏览器 profile；`git diff --stat` 证明 src-tauri 及全部 Rust crate 在施工窗口零改动，归属既有环境欠账非本计划回归）。强制层不旁路由 fs/shell seam 的 P2-C3 守卫测试钉死（plan 激活拦截时 provider 与 dispatch 双未触）。**谁判断：Agent 自主（D1-D13 冻结 + 施工⑤ subprocess 合并为授权范围内裁定，留痕于 D11 注记）。**

**做什么：**

1. **`ctx.fs`（D11）**：新建 `src-ui/src/composition/fs-service.ts`——`FsProvider` 接口（read/write/edit/stat/glob/grep…，形状对齐现有 tool-fs 消费面）；默认 provider = 现有 Rust fs 命令的薄包装；tool-fs 改经注册表查询。替代 provider 可为 JS / MCP / 远程。
2. **`ctx.shell` + `ctx.subprocess`（D11）**：同上——`ShellProvider`（bash/pwsh 执行）、`SubprocessProvider`（spawn/stdio/进程树）；默认 provider = 现有 Rust shell/subprocess 命令包装；bash-sandbox 等策略包装在 provider 外层或作为独立 provider。
3. **`ctx.sessionPersistence`（D11）**：`SessionPersistenceProvider`（load/save/archive）；默认 provider = 现有 session 持久化包装。
4. **`ctx.graph`（D11）**：`GraphProvider`（analysis 查询：symbols/neighbors/impact/preflight/cycles/…）；默认 provider = engine RPC 包装；graph 工具改经注册表查询。
5. **强制层不旁路**：所有 provider 调用仍过现有权限咽喉 / 工具管道 gate（审计 + plan gate + permissions）；测试钉住"换 provider 不豁免 gate"。
6. **替换性测试**：至少一条 seam 做一个 fake provider 替换（如 fs provider 换成内存实现），验证消费方零改动。

**动哪些文件：** `src-ui/src/composition/`（新增 fs/shell/subprocess/sessionPersistence/graph service）、`src-ui/src/agent/tools/domains.ts`（消费侧改查）、`src-ui/src/agent/tool-fs/tool-shell/...`、`docs/plugins/README.md`。

**验收判据：**
- P2-C1：每个新 seam 有默认 provider（行为与现状逐字节一致，快照/测试钉住）。
- P2-C2：至少一条 seam 的 fake provider 替换测试通过（消费方零改动）。
- P2-C3：换 provider 不豁免权限/审计/plan gate（守卫测试）。
- P2-C4：门禁同 P1-C6 + `cd src-tauri && cargo test`。

**谁判断：** Agent 自主。

### Phase 3 —— 组合域统一 + 目录生成

> **落地记录（2026-08-27 深夜，三 commit 铁律 7 分段）**：① `1505272f` seam 裁剪域进组合解析域（P3-C1 达成：七条 `seam/<域>` 域寻址 + 消费视图 = 注册表 − 禁用集 + loopEvents 事件面开关；拆旧清单外 T-01/02 前置完成）；② `68f1d2e5` 服务/事件目录生成器 + doc-sync 门禁（P3-C3 达成：gen-service-catalog 17 服务机械推导 / gen-event-catalog 调用点扫描 / doc-sync 三生成物对拍；拆旧 T-P3-1/T-P3-2 清零；顺手修 provider/catalog.ts import.meta.glob 潜伏破坏——8-27 glob 化后 tsx 环境硬炸，check:tool-contract 恢复可用）；③ 契约版本化 + plugin_install 版本比较（P3-C4 达成：OPEN_SURFACE_CONTRACT_VERSION v1 + 指纹对拍守护 + 变更记录；install semver 比较——升级换装/降级拒绝/force 逃生，T-P3-3 清零）。P3-C2 达成：standard/minimal 双 preset 快照零漂移（verify:convergence exit 0，两次全量）。门禁全绿：build / vitest 1840 passed / biome 0/0 / convergence / doc-sync；src-tauri bin 422 passed + 集成 14/14 + platform_boundary 绿——唯一失败 `cdp::e2e_multi_account_profiles_and_cookies` 与 Phase 2 在册基线同一（环境型用例，src-tauri/src/cdp 施工窗口零改动，非本计划回归）。**谁判断：Agent 自主。**

**施工设计（2026-08-27，开工时定案）**：① seam 贡献进组合解析域——新增 `composition/seam-resolution.ts` 叶模块（各 seam 域禁用集的运行时单一读面，零依赖）+ `factoryComposition()` 收编七条 seam 寻址域（`seam/llm`、`seam/subagents`、`seam/fs`、`seam/shell`、`seam/sessionPersistence`、`seam/graph`、`seam/loopEvents`——`seam/` 前缀与既有四域键隔离，`shell` 键已被壳行域占用）+ patch schema 同名域（disable 条目，last-write-wins）+ `ResolvedComposition.seamDisabled` 消费裁剪面。**语义裁定**：注册表 = 实现真源（谁存在），组合 = 裁剪真源（谁生效）；消费视图 = 活动注册表 − 禁用集（晚注册的 provider 可见，除非显式禁用——免除快照陈旧类）；过滤收在 `active*Providers()`/`activeLlmAdapters()` 与 `emitLoopEvent` 消费单点，调用方零改动。生效语义 = 调用期全局裁剪（与 Phase 2 调用期扫描一致）；会话级 compositionOverride 的 seam 面不穿线（AgentConfig 冻结，P5 全量挂 seam 时再评估）。`seam/loopEvents` 域 = D4 事件面开关（行源 = LOOP_EVENT_NAMES；仅 emit 观测域可开关，tool/guard|preflight|around 是强制层语义不开放禁用——禁 guard = 绕 planGate）。② 目录生成（D9 随段落）：`gen-service-catalog`（ctx.* 全量：key/service/kind/owner/默认实现/消费面——kind 由源码机械推导规则出，缺标注即生成器报错）+ `gen-event-catalog`（event → mode/载荷/发射点/监听点——自 AGENT_EVENT_MAP + 调用点扫描生成）+ `doc-sync` 门禁（tool-contract + 两目录的 --check 对拍）。③ 契约版本化：开放面契约版本常量 + 变更记录 + seam 契约文件指纹对拍测试（变更未更新版本 = 红）+ `plugin_install` 版本比较兑现（降级拒绝 + force 逃生）。

**拆旧清单（本段第一步交付物，收工清零——铁律 3）：**

| # | 旧物 | grep 锚点 | 归宿 |
|---|---|---|---|
| T-P3-1 | `docs/agents/event-feature-map.md` 手写「事件目录」表（14 行手抄——与 AGENT_EVENT_MAP/发射点双源漂移面） | `docs/agents/event-feature-map.md` §事件目录 | 施工②：删手写表 → `docs/agents/event-catalog.md` 生成物（gen-event-catalog 生成 + 对拍守护），feature→mechanism 叙事保留 |
| T-P3-2 | `docs/agents/event-feature-map.md`「P3 扩 gen-event-catalog 生成器后改生成物对拍」挂起注记 | 同文件「P3 扩」字样 | 施工②兑现后删除 |
| T-P3-3 | `plugin_install.rs`「第一版不做版本比较（未决项）」 | `第一版不做版本比较` | 施工③：同名重装 semver 比较（降级拒绝 + force 逃生），未决项注记删除 |

**验收判据（判据号 P3-Cn）：**
- P3-C1：全部 seam 贡献行可被 patch/preset 寻址禁用/替换。
- P3-C2：standard/minimal 双 preset 快照零漂移（含新 seam 面）。
- P3-C3：服务/事件目录生成 + 漂移检查入 doc-sync；目录与源码无手工双源。
- P3-C4：契约版本机制有测试钉住（变更未更新版本 = 红）。

**谁判断：** Agent 自主。

### Phase 4 —— 运行时插件全链路（热重载 + 动态生成 + 信任模型落实）

**做什么：**

1. **外部插件热重载（D6）**：`plugin_install` / `plugin_uninstall` / `plugin_set_enabled` 写 `plugins.json` 后立即生效；卸载/禁用 = fiber dispose（贡献链式注销 + MCP 进程 kill）；安装/启用 = 增量装载。复用 `composition:changed` 广播 + 贡献变更监听。
2. **`ctx.dynamicRunner`（D7）**：新建 `dynamic-runner-service.ts`——运行时定义注册表 + 宿主半执行器；define/run/stop/undefine/inspect；vm 沙箱（对齐 code-runtime 的敌意校验：无损 JSON、输出预算、一次性应答、correlation-id）；**动态插件可提供任意 seam**（tools/panels/llm adapter/fs provider/…）。
3. **模型工具面**：`cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_*`（形状对齐 DSH `tool-cordis`）；进 `DOMAIN_SPECS` + 工具目录。
4. **信任模型落实（D12）**：动态插件 = approval（复用 `ctx.approval` 语义）+ vm 沙箱；静态插件完全信任如实入档为 v1 已知债；`docs/plugins/README.md` 重写安全叙事（授予门禁 / 声明面 / 逐调用强制 / 动态插件沙箱 / 静态插件已知债）。
5. **进程外能力面收口（D1）**：MCP 是能力加面的**路径之一**（不是唯一）；补一个真实例子：把现有第一方能力（如 dataflow 查询）以外部 MCP server 形态挂接，验证端到端。

**动哪些文件：** `src-tauri/src/commands/plugin_install.rs`（或新生命周期入口）、`src-ui/src/plugins/loader.ts`、新增 `dynamic-runner-service.ts` + `tool-cordis` 族 + `cordis_*` DOMAIN_SPECS、`docs/plugins/README.md`、CONVENTIONS。

**验收判据：**
- P4-C1：装/卸/禁用/启用一个外部插件在运行中生效（无需重启），贡献面与进程随 fiber dispose 干净回收。
- P4-C2：动态定义一条插件（含一个 seam provider，如自定义 llm adapter 或 fs provider）→ 激活 → 模型可见 → stop → 贡献消失；全程 session-log 可重建。
- P4-C3：动态插件宿主半在 vm 沙箱内运行；敌意校验测试（伪造消息/超预算/畸形 JSON）全绿；未 approval 的动态插件不能运行。
- P4-C4：`cordis_*` 工具面入目录文档 + 门禁；convergence 双 preset 零漂移。
- P4-C5：存在一条"外部 MCP 承载新能力"的端到端例子（真实跑通）。
- P4-C6：门禁同 P1-C6 + `cd src-tauri && cargo test`。

**谁判断：** Agent 自主。范围拍板点（如 cordis 工具命名/是否含 client 半）如与 DSH 形状冲突，按 D7 裁定对齐 DSH，不再另行询问。

### Phase 5 —— 存量迁移与出厂面清零（含 agent loop 降为默认实现）

**做什么：**

1. **第一方全量挂 seam**：14 工具域 / 13 prompt 段 / 15 capability / 2 LLM adapter / 1 子代理默认 provider / fs/shell/subprocess/session/graph 默认 provider / 全第一方事件监听器，全部经通道/注册表贡献，出厂面零硬编码。
2. **`ctx.agentLoop`（D13）**：把 `agent.ts` / `execution-state.ts` 的流式循环抽成第一方默认实现（对齐 DSH `agent-loop` 包的角色）；`Agent` 接口不变，装配经 `ctx.agentLoop` 查询；扩展方只依赖事件/服务，不依赖 loop 包。这是全计划最大的单一重构，按"行为逐字节一致 + 快照钉住"推进。
3. **"零硬编码门禁"**：守卫测试钉住"任何内置实现必须是某 seam 的默认 provider / 某通道的贡献，可被配置替换"。
4. **强制层外零增长守卫**（Phase 0 已建）：`commands/*` 命令数 + RPC 方法数在**强制层外**不得增长；强制层内改动需显式标注 + 宪法审查（D1 可度量闭环）。
5. **清理**：Phase 1-4 遗留的过渡（factory switch 残留、providers 引用残留、旧事件 bus、硬编码 provider 路径）全删。

**动哪些文件：** 全量第一方插件文件 + `agent/`（loop 抽取）+ 守卫测试 + 各 seam 默认 provider 注册点。

**验收判据：**
- P5-C1：出厂面零硬编码守卫全绿（存在可替换路径证明）。
- P5-C2：`ctx.agentLoop` 装配成立；默认 loop 行为与现状逐字节一致（快照/测试）；扩展方无 import loop 内部实现（grep 归零）。
- P5-C3：强制层外 `commands/*` 命令数 = Phase 0 基线（零增长）；强制层内改动全部有宪法审查记录。
- P5-C4：全量测试 + convergence + doc-sync 全绿；无残留引用（grep 归零）。

**谁判断：** Agent 自主 + 用户终审（loop 抽取是产品核心行为变更，commit message 写明）。

### Phase 6 —— 平台税收口

**做什么：**

1. **文档**：`docs/plugins/README.md` 扩为平台契约（全部贡献通道 + seam provider + dynamicRunner + MCP 能力面 + 契约版本 + 信任模型 v1 已知债）；新增 cookbook（LLM adapter / 子代理 provider / fs 后端 / shell 后端 / session 后端 / 动态插件 / MCP server，对齐 DSH `docs/cookbook/adding-an-llm-adapter.md` 样式）。
2. **测试基建**：seam 完整性 guard、cross-seam 集成（换 adapter / 换 provider 的替换性测试）、快照扩展、convergence 扩展到新面。
3. **版本兼容**：开放面契约版本 + 变更审批流程（对齐 baseline-change-request）。
4. **三方发布路径**：`plugin_install` 的 registry 发布指南（`docs/user/develop/*` 对齐）——"第三方优先"的落地收口。

**动哪些文件：** `docs/plugins/README.md`、`docs/cookbook/*`、`docs/user/develop/*`、测试基建。

**验收判据：**
- P6-C1：平台契约文档与代码现状逐字对齐（doc-sync 门禁）。
- P6-C2：替换性测试覆盖至少三条真实 seam 的换实现路径（llm adapter、subagent provider、fs provider）。
- P6-C3：三方可按文档从零装一个真实插件（hello 级 + 一个带后端能力的例子）。
- P6-C4：信任模型 v1 已知债在文档中明示，动态插件 approval/沙箱有测试钉住。

**谁判断：** Agent 自主 + 用户终审（对外契约措辞）。

## 6. 验收总门禁（每 Phase 统一）

```bash
cd src-ui && npm run build && npx vitest run && npx biome ci .   # 前端
cd src-ui && npm run verify:convergence                          # 组合层（standard 零漂移）
cd src-tauri && cargo test                                       # 触 Rust 时
pnpm run doc-sync（对应层）                                       # 目录/文档漂移
```

**铁律（沿用项目宪法 + 本计划「拆旧立新宪章」）：动刀前受影响测试先跑基线；删行为同步删其测试；门禁红 = 没改完；用户可感知行为变更写进 commit message。每段施工先列拆旧清单、收工清零——清点不清零 = 施工段未完成，不允许进入下一段。**

## 7. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 事件面扩展撞 `session-log` 冻结面（model-visible ⟺ logged） | 每个新事件落 session 事件 / 或显式声明非模型可见；沿用 Phase 5 立规与 baseline-change-request |
| R2 | `ctx.llm` / seam 化改流式路径破前缀缓存 / 并发语义 | provider 选择在装配/会话边界冻结（KV-cache 纪律同 tools）；对拍 effective 快照 |
| R3 | 后端能力 seam（D11）被误当作"绕过权限"的旁路 | 强制层在工具管道/RPC 平台面，不在 provider 里；P2-C3 守卫测试钉死"换 provider 不豁免 gate"；插件仍是完全信任模型（D12） |
| R4 | 动态插件（D7）的 vm 沙箱不是硬边界 | 对齐 code-runtime 的敌意校验（无损 JSON + 预算 + correlation-id）；approval 前置；动态插件走权限三层门禁；进程外硬隔离是后续硬化项（Non-goals 列明） |
| R5 | 热重载（D6）卸载在途会话引用 | 在途会话持有创建时点快照（KV-cache 纪律）——卸载只影响后续装配；卸载时 fiber dispose 保证贡献链式回收 |
| R6 | 事件面 / loop 抽取（D13）重表达第一方功能 = 行为漂移 | 每迁移一件 = 一条快照/测试钉住（沿用 B④/B⑤ 零漂移迁移纪律）；feature→mechanism map 落档；loop 抽取按"逐字节一致"推进 |
| R7 | 平台税（D9）被"功能先行"挤掉 | 目录生成/契约版本**随段落地**（P1 就有 P1 的生成器），不是收尾补 |

## 8. 明确不做（Non-goals）

- **不把强制层插件化**：权限咽喉 / 沙箱内核 / 审计 / IPC / Tauri 本身不做 provider 化（D1）。进程外硬隔离、签名、静态插件沙箱化属**后续硬化项**（D12），不在本计划。
- **不做 dsh-compat 装载层**（D10）：C12 保持外部信号挂起。
- **不摊平工具面到 DSH 规模**：domains 折叠形态保留（前缀缓存 + 桌面应用定位，沿用 agent-plugin 计划 Non-goal）。
- **不造工作流引擎/DSL**（沿用 D3）：编排由模型写的程序承担（code_execution 已具）。
- **不动 cordis 内核本体**。
- **不做 typert 式跨进程类型协议**（无需求）。
- **不引入第二套插件格式**：外部插件 / MCP / 动态插件共用现有 manifest + cordis 装载路径，不加旁路。

## 9. 与既有计划的关系（含推翻清单）

- **supersede**：`agent-plugin-architecture-plan.md` P4 的"通道补齐 + 存量拆解"已竣工部分（本计划以其为已完成前置）。
- **推翻**：
  - D9 的"Rust 壳（权限沙箱·IPC·Tauri）永不插件化" → 保留的是**强制层**（权限咽喉/沙箱内核/审计/IPC/Tauri 基础设施），打开的是**能力实现**（fs/shell/subprocess/session/graph/llm/subagents）。Rust/engine = 默认 provider，不是不可替换能力。
  - D9 的"Rust 侧插件化标准形态 = 外部 MCP server" → MCP 是能力加面路径之一，不是唯一；前端 seam + 动态插件同样可加能力。
  - 内核线第 6 条"Agent↔engine 耦合带：图数据管线、graph hooks、执行腰——产品核心，永久特权" → 拆为：强制层（执行腰的 gate/审计）保留特权；图数据管线/分析能力开为 `ctx.graph` seam；agent loop 降为第一方默认实现（D13）。
- **保留**：C12 dsh-compat（挂起，外部信号）；MCP 双向开放路径（本计划 Phase 4 收口为"能力加面路径之一"）；preset/patch/roster 组合域；`ctx.codeRuntime` 执行腰（作为强制层默认实现，非 provider 化）。
- **承接**：`composition-architecture/README.md` 内核线（Phase 0 修订）；`docs/plugins/README.md`（Phase 6 扩为平台契约）。
- **里程碑时间轴**：Phase 0 待用户拍板宪法后开工；Phase 1-6 依次推进，每段竣工即更新本文件状态行 + `docs/plans/HISTORY.md`。
