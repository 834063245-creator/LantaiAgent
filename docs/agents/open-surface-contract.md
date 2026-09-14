# 开放面契约（Open Surface Contract）

> 平台化 Phase 3 · P3-C4（2026-08-27）。seam 接口面是三方（外部插件 / 动态
> 插件 / MCP 之上的 provider 层）共同依赖的契约——变更必须显式升版 + 记录，
> 不得静默改约。机制对齐 DSH `SESSION_FORMAT_VERSION`。
>
> **本文件由守护测试对拍**（`tests/seam-contract-version.test.ts` +
> `doc-sync` 门禁里的 `check:contract-fingerprint`）：契约文件清单的 sha256
> 指纹记录在下方标记行，**文件变更未升版/未更新指纹 = 红**。

当前版本：30

<!-- contract-fingerprint: f8733188086da4574d9ac15947ec60995148213aa9e358fcd53907b6cf30c403 -->

## 契约面载体（`src/composition/contract-version.ts` 单一真源）

| 文件 | 契约内容 |
|---|---|
| `src/composition/contribution-channel.ts` | **贡献通道内核**（M1 收口：九通道 + 五 seam 的唯一注册表实现——`ContributionChannel` / `ContributionTiming` / `ContributionChannelOptions`。类名经宿主桥 `faceDeps` 与 `host.aliased.ts` 暴露给产物插件，形状即对外契约） |
| `src/composition/services.ts` | `ctx.llm`（`LlmAdapterContribution`）+ panels/commands/tools 通道 def 形状（M1 起注册表内核移出本文件） |
| `src/provider/types.ts` | `ctx.llm` seam 的**实现面形状真源**（`Provider` / `Chunk` / `Request`——v25 补登记：`LlmAdapterContribution.create` 返回的 Provider 形状即契约面，此前未入册） |
| `src/composition/fs-service.ts` | `ctx.fs`（`FsProvider` / `FsAction` 动作 / `FsCallOptions` dispatch 腰） |
| `src/composition/shell-service.ts` | `ctx.shell`（`ShellProvider` / `ShellAction` 四动作；subprocess 并入） |
| `src/composition/session-persistence-service.ts` | `ctx.sessionPersistence`（`SessionPersistenceProvider` 四动词 read_volume/list_volumes/save_volume/delete_volume + `sessionExecute` 消费单点 + Service.execute） |
| `src/composition/subagent-service.ts` | `ctx.subagents`（`SubagentProvider` / `SubAgentSpawnArgs·Outcome`） |
| `src/composition/seam-resolution.ts` | seam 裁剪面（`SEAM_DOMAINS` 六域 / `SeamDisabledMap` / patch `seam/<域>` 域契约） |
| src/agent/events.ts | D4 事件面（AGENT_EVENT_MAP mode 表 / LoopEventPayload 载荷形状 / 监听契约） |
| src/agent/dynamic-runner/dynamic-runner-service.ts | ctx.dynamicRunner（D7——define/run/stop/undefine/inspect + 审批门 + 包不可变/回滚语义） |
| src/agent/dynamic-runner/sandbox.ts | 动态插件沙箱承诺（阴影求值面 / 守卫注册面白名单 / 三预算常量） |
| src/plugins/types.ts | 插件 manifest schema（name/version/inject/permissions/tools/mcpServers（含 `readOnly`）/displace/dataDir/**app（入口二态：`entry` 资产 HTML 或 `url` 环回远端页）**） |
| src/agent/agent-loop/types.ts | AgentLoop/AgentLoopHost（D13 loop seam 契约） |
| src/agent/agent-loop/default-loop.ts | 默认 loop 实现（行为逐字节一致，D13） |
| src/agent/agent-loop/agent-loop-service.ts → `src/plugins/builtin/agent-loop-service/index.ts` | ctx.agentLoop 注册表（构造期登记 builtin/default，后注册胜；S5b 起本体在产物域，活动面留 `agent-loop-active.ts`——**清单真源以 `contract-version.ts` 为准，本行同步实况**） |

（`graph-service.ts` / `ctx.graph` seam 随图谱功能全量退役移除，2026-09-09。）

## 变更记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| 1 | 2026-08-27 | 初版：六 seam + 裁剪面 + 事件面 + manifest 契约入册（P3-C4） | agent-platformization-plan Phase 3 |
| 2 | 2026-08-27 | 新增动态插件运行时契约（D7：ctx.dynamicRunner define/run/stop/undefine/inspect + 沙箱三层防线——阴影求值面/守卫注册面/预算；P4-C2/C3） | agent-platformization-plan Phase 4 |
| 3 | 2026-08-28 | 新增 agent loop seam 契约（D13：AgentLoop/AgentLoopHost + 默认实现；loop 降为第一方默认实现，契约上可替换） | agent-platformization-plan Phase 5 |
| 4 | 2026-08-28 | executor legacy 直调参数拆除（StreamingToolExecutor 构造签名删 hooks/preflightHooks/planGate，guard/preflight/around 全量经 eventBus 监听面——唯一管道）；events.ts 注释同步（去 legacy 表述，无语义变更）；事件目录再生成（attach* 接线点无移动，同指） | 平台化 Phase 5 收尾 / 拆旧清单清零 |
| 5 | 2026-08-31 | agent loop 契约行为面：default-loop err 分支先补落已执行工具结果（append assistant/text + tool/call 审计 + tool/result 回传上下文）再抛 err——流内失败不再丢已执行副作用记录 | 33dae0f4（该提交漏走契约手续，本行代补） |
| 6 | 2026-08-31 | default-loop 每步两处 best-effort RPC（drain_bg_notifications / plan read_file_content）包 3s 超时兜底（typedRpcWithTimeout）——Rust 卡死/回包丢失时落回各自跳过分支，run() 不再死等无界 await（运行态挂起修复之一）；无契约形状变更 | 运行态挂起诊断 2026-08-31 |
| 7 | 2026-08-31 | manifest schema 新增可选 `displace: boolean`（位移式内置插件装载：产物声明 displace 且 bundle 同名行在册 → import 前 dispose bundle fiber 单活互换，失败/停用自动恢复兜底行；缺省 false 行为不变）——kind='feature' 全量通道化（first-party-hot-reload-plan 增补四） | first-party-hot-reload-plan §8 |
| 8 | 2026-09-02 | AURA SDK 语义记忆系统整体拆除——default-loop step0 临时提醒清除的保留特判退役（原特判仅服务 preRunHook 的 run 前预注入，载体已删，改每步无条件清除）；无契约形状变更 | AURA SDK 拆除（用户拍板） |
| 9 | 2026-09-04 | default-loop step0 计划提醒读取换 tool_call 信封（kernelReadFileRaw 寻址 builtin.fs.read_file_content，旧 RPC 分支随 P2-2 退役）；无契约形状变更 | kernel-plugin-runtime P2-2 |
| 10 | 2026-09-04 | default-loop 每步 drain_bg_notifications 换 tool_call 信封（kernelShellCall 寻址 builtin.shell.drain_bg_notifications，旧 RPC 分支随 P2-4 退役）；无契约形状变更 | kernel-plugin-runtime P2-4 |
| 11 | 2026-09-04 | default-loop 死 import 清理（删 kernelShellCall 未用导入；R1 biome 0/0 收口连带）；无契约形状变更 | R1 TS 权限策略层（permission-policy 单真源） |
| 12 | 2026-09-05 | default-loop 每步 drain_bg_notifications 换 process_cap 能力口直呼（kernelProcessCall，builtin.shell 信封随 shell 域收口退役）；无契约形状变更 | kernel-capability-c3-design.md R3-d（shell 域收口） |
| 13 | 2026-09-05 | 会话持久化 seam 动作面重设计（C 定案）：六动词（read/write/append/appendLog/mkdir/delete——旧 agent-store 磁盘 CRUD 形状）→ 四动词会话语义（read_volume/list_volumes/save_volume/delete_volume）；Service 增 execute 方法（模块级 sessionExecute 保留为产品代码消费单点） | session-persistence-seam-wiring-plan.md（D-1/D-5/D-6/D-8） |
| 14 | 2026-09-06 | manifest schema 新增可选 `dataDir: boolean`（插件数据地盘：声明 true 装载即分配专属数据目录 `<dataRoot>/<名>/`，宿主桥 fs 面 ensure/list/read/write/delete，卸载随 plugin_uninstall 整体挪 `.trash` 回收；缺省/false 行为不变） | app-shell-software-plugin-plan.md §5-S1 |
| 15 | 2026-09-06 | manifest.mcpServers 条目新增可选治理字段 `restart: 'off'\|'on-crash'` 与 `lifecycle: 'lazy'\|'eager'\|'with-window'`（app shell 件 C 受治进程治理：任一在场 = 该 server 进受治面——就绪 = initialize 握手完成带时限、崩溃退避重启、三档生命周期/空闲回收、未就绪调用立即报 service_not_ready；http 条目声明治理字段拒绝——无受治进程面；两字段皆缺席 = 旧形态现行为不变） | app-shell-software-plugin-plan.md §5-S2（决策 1/4/7/8） |
| 16 | 2026-09-06 | manifest schema 新增可选 `app` 字段（app shell 件 A 应用视图通道：`{ entry: './' 前缀相对 HTML, mode: 'floating'\|'dock'\|'fullscreen', title }`——声明 = 插件以软件形态住进兰台：装载只登记窗口定义（数据），开窗才实例化 iframe 视口；窗内向宿主要能力走 postMessage 白名单桥（默认最小集 fs 数据目录 + notify）；卸载收口 = 摘定义 + 关窗；缺省不声明 = 行为不变） | app-shell-software-plugin-plan.md §5-S3 |
| 17 | 2026-09-06 | manifest.tools 条目新增可选 `async: boolean`（app shell 件 D 后台唤醒回调 · 工具口：声明 true = 执行即返回卡片——宿主生成 taskId 注入 `args._task_id` 并登记发起者（executor 注入的 `_owner_id`），插件后台完成后经宿主桥 `deferred.complete(taskId, status)` 唤醒发起 Agent，唤醒体 minimal 定位键 {status, taskId, sessionId}、内容凭 taskId 调插件工具按需取；MCP 路对位 = server 完成通知 `lantai/deferred`（params.progressToken 回带调用期 token）由桥翻译成同一唤醒；缺省 false = 同步语义不变） | app-shell-software-plugin-plan.md §5-S4（决策 7/8） |
| 18 | 2026-09-06 | AgentLoopHost 契约移除 `pricing` 成员（模型价格表拆除：AgentEvent.pricing / Pricing 全链退役，Usage 事件不再带定价）；AgentLoop 契约形状变更（无新增字段） | provider-system-spec.md 追裁·模型价格表拆除（2026-09-06） |
| 19 | 2026-09-07 | default-loop step0 计划提醒读取删除剥行号补丁（kernelReadFile 缺省翻转为原文——fs(read) payload 行号 opt-in，工具缺陷报告 Bug 1；plan 文件读取路径行为不变，收到的即原文）；无契约形状变更 | 工具缺陷报告三连修复（2026-09-07） |
| 20 | 2026-09-07 | `LlmAdapterContribution` 新增可选 `label?: string`（ctx.llm 协议下拉/展示用人类可读标签——provider-refactor 方案乙 Phase 1A Protocol 开放为 string 后，AddProviderSheet 协议 select 与 PROTOCOL_LABELS 回落链查 adapter 贡献标签；缺省 = 显示 kind 本身）；契约形状变更（新增可选字段，向后兼容） | provider-refactor-handoff.md Phase 1A（方案乙） |
| 21 | 2026-09-07 | `src/plugins/types.ts` 导出 `McpServerDeclSchema`（用户级 ~/.lantai/mcp.json 装载复用同一 schema——单一真源，避免 user-mcp.ts 重抄校验；McpServerDecl 类型形状零变更）；无契约形状变更 | skills-mcp-production-plan Commit 5b |
| 22 | 2026-09-08 | 动态插件守卫 ctx 服务解析修复（sandbox.ts）：`makeGuardedCtx` 代解析由 `resolverCtx[prop]` 改 `resolverCtx.reflect.get(prop)`——生产消费单点 `activeDynamicRunner()` 是裸服务实例（this.ctx = runner fiber，有 runtime），旧解析被内核 inject 拦截沿 fiber 链找 impl 而 runner 无 inject 声明、组合层服务 impl 在兄弟 fiber，12 注册面恒抛 "cannot get property X without inject"；新解析走内核免 inject 读取通道直读根 store（strict 默认拒递半拆服务），run()/mount() 同源修复。守卫面形状零变更（effect + 12 register 语义不变）；无契约形状变更 | platform-bugs-cordis-dynamic-runner.md（2026-09-07 登记，2026-09-08 修复） |
| 23 | 2026-09-08 | AgentLoopHost 契约新增 `compactIfNeeded(signal)` 与 `compactRatioOf()` 成员（上下文压缩 2026-09 迭代：自动压缩主触发前移到 step 前 pre-flight，pre-flight 读 `compactRatioOf()` 判定、调 `compactIfNeeded()` 走自动尾部 token 预算 + 摘要成本硬校验；`compactNow` 保留为手动 /compact 路径）；契约形状变更（新增成员，替换 loop 可忽略新成员即回到旧默认 loop 语义） | 上下文压缩迭代 2026-09（DSH 对照：阈值 0.8 / 尾部 retainRatio / step 前同步） |
| 24 | 2026-09-09 | `ctx.graph` seam 全量退役：`graph-service.ts`（GraphService/activeGraphProviders/graphExecute）+ 载体清单移除，`SEAM_DOMAINS` 七域→六域（llm/subagents/fs/shell/sessionPersistence/loopEvents）——图谱功能全量退役（引擎回归纯 MCP），开放面不再有 graph 域契约 | 兰台图谱功能全量退役计划（plan-1788924433965-dmkj v2） |
| 25 | 2026-09-12 | **provider/model 语义分账（可观测面拆碑）**：`Provider` 接口新增 `model(): string`（真实模型 id；`name()` 保持提供方身份）——`ctx.llm` adapter 实现面形状变更（**必填**，三方 adapter 需补该方法，cookbook 已同步）；`TurnStartPayload` / `RequestStartPayload` 新增 `provider` 字段、`model` 语义纠正（此前两者的 `model` 装的是 `host.prov.name()` = 提供方名，日志读起来像「模型 = 提供方名」，实测把排障带偏）；同版补登记 `src/provider/types.ts` 进指纹清单（此前漏登，本次变更差点从指纹下溜过）。**同版补**：`createProvider` 在 adapter 创建边界硬校验必需成员（`PROVIDER_ADAPTER_SHAPE`）——运行时加载的插件 bundle 不受 TS 编译期保护，缺 `model()` 的旧 adapter 此前崩在回合中途抛 `TypeError: ... .model is not a function`，现改为点名 adapter id + 缺失成员 + 修法；**纯诊断改善，不做任何回退**（绝不 `?? name()` 顶替，那正是本版修掉的静默 bug 形态）——`provider/index.ts` 不在指纹清单，无需再次升版 | 2026-09-12 链路挂起排障事故（日志 model 字段误导）+ 用户拍板方案乙 |
| 26 | 2026-09-13 | `LoopStreamResult` 新增可选 `token: TokenRequestRecord`（token 计量：Agent 侧每请求一本账——分桶用量 / 请求压力 / 投影占用 / 上下文构成 / 逐轮）；默认 loop 的 `EventKind.Usage` sink 一并携带该字段投给 UI。**执行语义零变更**：第三方 loop 不返回该字段即 UI 计量面缺一条，不报错不降级执行 | token 计量系统（创作坞「墨量册」+ agent/token-meter，对齐 DSH token-meter 语义） |
| 27 | 2026-09-13 | **manifest.mcpServers 条目新增可选 `readOnly: boolean` + MCP 工具只读语义归真（行为变更）**：判定真源 = `agent/mcp/registry.resolveMcpToolReadOnly`（条目级声明 > 远端 `annotations.readOnlyHint === true` > **缺省 false**）——registry `mcpClientTool` 与 `plugins/mcp-bridge` 两处工具构造共用，杜绝各判各的。旧行为两处硬编码 `readOnly: () => true`（注释自称「写入型由调用方按需覆盖」，全仓零调用方覆盖）：写型 MCP 工具因此在 plan 模式被放行（`plan/plan-registry.ts` 首行只读短路）、并入只读并行组、被 plan 子 Agent 静态只读集照收。**用户可感知变更**：未声明只读且远端无 `readOnlyHint` 的 MCP 工具从「只读」变为「写」（plan 模式拦截 + 退出并行组）；确为只读的 server 由作者条目声明 `readOnly: true` 或远端注解显式担保 | office-cli-integration-plan.md §5（P0 平台前置——OfficeCLI 的 MCP 工具实测无 annotations，正是本洞的活样本） |
| 28 | 2026-09-13 | **manifest.app 入口二态（窗入口二态）**：`entry`（`./` 相对资产 HTML）与 `url`（**环回** http(s) 远端页；host 白名单 127.0.0.1/localhost/::1、禁凭据、禁非 http(s)）**互斥必给其一**；`url` 形态**禁 `fullscreen`**。窗口帧侧：`url` 形态 iframe 给 `allow-same-origin`（跨源文档保住自己 origin——它的同源 `EventSource`/`fetch` 才通），**且不绑宿主桥**（远端文档不是插件代码）；`entry` 形态 sandbox 与桥绑定**逐字节不变**。窗口定义新增 `kind: 'asset' \| 'remote'`（判定单一真源，渲染处不重推）。**向后兼容**：只声明 `entry` 的既有插件行为零变化；`app: {}`（两者皆无）从「缺 entry 报错」变为「二态 refine 报错」，仍是拒绝 | office-cli-integration-plan.md §4.3.1（活预览正式形态——`officecli watch` 活刷新页要环回 URL 窗口；实测该服务不回 CORS 头 ⇒ 沙箱 opaque origin 下活刷新必死，故须 allow-same-origin） |
| 30 | 2026-09-14 | **动态插件守卫注册面校准（`dynamic-runner/sandbox.ts`）**：`GUARDED_SERVICES` 漂移已久——仍列着 2026-09-09 全量退役的 `graph`（死条目：模型照它写 `ctx.graph.register` 必报「服务不可解析」），且缺 `overlays` / `hooks` / `agentLoop`；同文件 `validateDef` 还按服务特判 `needId='key'`，在 v29 统一行身份为 `id` 之后**动态插件注册 capability 整条路恒失败**（给正确 `id` 被守卫拒，给旧 `key` 被通道形状校验拒）。本版：白名单 = **九条贡献通道 + 五条 seam 全量 14 面**；`needId` 统一 `id`；`hooks` 的嵌套形状（`{ id, kind: 'enrich'\|'preflight', hook }`，函数成员在 `hook` 内且随 kind 而变——enrich 族 `shouldEnrich`+`enrich` / preflight 族 `shouldCheck`+`check`）由新增 `SHAPE_CHECKS` 承担装载期校验。**对外可感知**：动态插件从此能贡献 overlays / hooks / agentLoop；capability 必须用 `id`。同版补上该文件自注承诺却缺席的守护——白名单 ↔ 真装配对拍（列了平台没有的服务即红，`tests/dynamic-runner.test.ts` ⑩）| 出厂技能 `lantai-plugin-dev` 曾照抄错误清单，同批更正 |
| 29 | 2026-09-14 | **M1 插件化收口（贡献通道内核单层化）**：注册表内核从 `services.ts` 内的 `ContributionRegistry` 上收为 `contribution-channel.ts` 的 `ContributionChannel`——**类名变更是破坏性契约变更**（该名字经宿主桥 `faceDeps`/`host.aliased.ts` 暴露给产物插件）；五个手抄副本（`RendererRegistry` / `PromptRegistry` / `HookContributionRegistry` / `CapabilityContributionRegistry` / `OverlayRegistry`）随之退役，14 个 service 全部收敛到同一内核。**行为面逐字零变更**（id 寻址 / 重名装载期拒绝 / 幂等 disposer / 陈旧性守卫 / 组合序 = 注册序全部保持）；新增两件**声明式数据**：`timing`（四档生效时机 immediate/next-assembly/request/frame——历史上是隐式的「构造时传没传回调」，读时序只能读七份文件头）与 `subscribe`（统一订阅面，收编 OverlayRegistry 自成一格的 API）。**同版破坏性变更**：`AgentCapability.key` → `.id`（capabilities 是九条通道里唯一行身份不叫 id 的；`AgentBlueprint.keys()` 随之更名 `ids()`）——外部插件若贡献 capability 必须改字段名，旧名不留别名 | 插件化收口 M1（用户拍板「全做」：诊断见本会话——同一条通道语义六种接口/成员集互不相同） |

## 变更流程（guard 红 → 修复四步）

1. 改契约文件（接口形状 / 注册契约 / 事件载荷 / manifest schema）；
2. `src/composition/contract-version.ts` 的 `OPEN_SURFACE_CONTRACT_VERSION` +1；
3. 本文件「变更记录」加一行（版本 / 日期 / 变更内容 / 依据）；
4. `npm run gen:contract-fingerprint` 更新指纹标记行——四步同 commit。

指纹是**粗粒度**的（原文 sha256——注释改动也会变指纹）：契约面宁可多升版，
不静默漂移；这是刻意取舍不是缺陷。纯注释整理不涉及语义时，同样走四步
