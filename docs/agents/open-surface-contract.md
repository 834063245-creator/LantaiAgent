# 开放面契约（Open Surface Contract）

> 平台化 Phase 3 · P3-C4（2026-08-27）。seam 接口面是三方（外部插件 / 动态
> 插件 / MCP 之上的 provider 层）共同依赖的契约——变更必须显式升版 + 记录，
> 不得静默改约。机制对齐 DSH `SESSION_FORMAT_VERSION`。
>
> **本文件由守护测试对拍**（`tests/seam-contract-version.test.ts` +
> `doc-sync` 门禁里的 `check:contract-fingerprint`）：契约文件清单的 sha256
> 指纹记录在下方标记行，**文件变更未升版/未更新指纹 = 红**。

当前版本：19

<!-- contract-fingerprint: e3774f8827c279f542deb1f648cabd5f06e81bcdd49200c2417a7967730ca208 -->

## 契约面载体（`src/composition/contract-version.ts` 单一真源）

| 文件 | 契约内容 |
|---|---|
| `src/composition/services.ts` | `ctx.llm`（`LlmAdapterContribution`）+ ContributionRegistry 内核 + panels/commands/tools 通道 def 形状 |
| `src/composition/fs-service.ts` | `ctx.fs`（`FsProvider` / `FsAction` 11 动作 / `FsCallOptions` dispatch 腰） |
| `src/composition/shell-service.ts` | `ctx.shell`（`ShellProvider` / `ShellAction` 四动作；subprocess 并入） |
| `src/composition/session-persistence-service.ts` | `ctx.sessionPersistence`（`SessionPersistenceProvider` 四动词 read_volume/list_volumes/save_volume/delete_volume + `sessionExecute` 消费单点 + Service.execute） |
| `src/composition/graph-service.ts` | `ctx.graph`（`GraphProvider.invoke` + `graphExecute` 消费单点） |
| `src/composition/subagent-service.ts` | `ctx.subagents`（`SubagentProvider` / `SubAgentSpawnArgs·Outcome`） |
| `src/composition/seam-resolution.ts` | seam 裁剪面（`SEAM_DOMAINS` 七域 / `SeamDisabledMap` / patch `seam/<域>` 域契约） |
| src/agent/events.ts | D4 事件面（AGENT_EVENT_MAP mode 表 / LoopEventPayload 载荷形状 / 监听契约） |
| src/agent/dynamic-runner/dynamic-runner-service.ts | ctx.dynamicRunner（D7——define/run/stop/undefine/inspect + 审批门 + 包不可变/回滚语义） |
| src/agent/dynamic-runner/sandbox.ts | 动态插件沙箱承诺（阴影求值面 / 守卫注册面白名单 / 三预算常量） |
| src/plugins/types.ts | 插件 manifest schema（name/version/inject/permissions/tools/mcpServers/displace/dataDir/app） |
| src/agent/agent-loop/types.ts | AgentLoop/AgentLoopHost（D13 loop seam 契约） |
| src/agent/agent-loop/default-loop.ts | 默认 loop 实现（行为逐字节一致，D13） |
| src/agent/agent-loop/agent-loop-service.ts | ctx.agentLoop 注册表（构造期登记 builtin/default，后注册胜） |

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

## 变更流程（guard 红 → 修复四步）

1. 改契约文件（接口形状 / 注册契约 / 事件载荷 / manifest schema）；
2. `src/composition/contract-version.ts` 的 `OPEN_SURFACE_CONTRACT_VERSION` +1；
3. 本文件「变更记录」加一行（版本 / 日期 / 变更内容 / 依据）；
4. `npm run gen:contract-fingerprint` 更新指纹标记行——四步同 commit。

指纹是**粗粒度**的（原文 sha256——注释改动也会变指纹）：契约面宁可多升版，
不静默漂移；这是刻意取舍不是缺陷。纯注释整理不涉及语义时，同样走四步
