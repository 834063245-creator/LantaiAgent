# 开放面契约（Open Surface Contract）

> 平台化 Phase 3 · P3-C4（2026-08-27）。seam 接口面是三方（外部插件 / 动态
> 插件 / MCP 之上的 provider 层）共同依赖的契约——变更必须显式升版 + 记录，
> 不得静默改约。机制对齐 DSH `SESSION_FORMAT_VERSION`。
>
> **本文件由守护测试对拍**（`tests/seam-contract-version.test.ts` +
> `doc-sync` 门禁里的 `check:contract-fingerprint`）：契约文件清单的 sha256
> 指纹记录在下方标记行，**文件变更未升版/未更新指纹 = 红**。

当前版本：8

<!-- contract-fingerprint: 3ead40dfd7a7fea6330a306fa55c000e31fe87eeb49c3d36e72183f6f39c28ce -->

## 契约面载体（`src/composition/contract-version.ts` 单一真源）

| 文件 | 契约内容 |
|---|---|
| `src/composition/services.ts` | `ctx.llm`（`LlmAdapterContribution`）+ ContributionRegistry 内核 + panels/commands/tools 通道 def 形状 |
| `src/composition/fs-service.ts` | `ctx.fs`（`FsProvider` / `FsAction` 11 动作 / `FsCallOptions` dispatch 腰） |
| `src/composition/shell-service.ts` | `ctx.shell`（`ShellProvider` / `ShellAction` 四动作；subprocess 并入） |
| `src/composition/session-persistence-service.ts` | `ctx.sessionPersistence`（六动词 provider + `sessionExecute` 消费单点） |
| `src/composition/graph-service.ts` | `ctx.graph`（`GraphProvider.invoke` + `graphExecute` 消费单点） |
| `src/composition/subagent-service.ts` | `ctx.subagents`（`SubagentProvider` / `SubAgentSpawnArgs·Outcome`） |
| `src/composition/seam-resolution.ts` | seam 裁剪面（`SEAM_DOMAINS` 七域 / `SeamDisabledMap` / patch `seam/<域>` 域契约） |
| src/agent/events.ts | D4 事件面（AGENT_EVENT_MAP mode 表 / LoopEventPayload 载荷形状 / 监听契约） |
| src/agent/dynamic-runner/dynamic-runner-service.ts | ctx.dynamicRunner（D7——define/run/stop/undefine/inspect + 审批门 + 包不可变/回滚语义） |
| src/agent/dynamic-runner/sandbox.ts | 动态插件沙箱承诺（阴影求值面 / 守卫注册面白名单 / 三预算常量） |
| src/plugins/types.ts | 插件 manifest schema（name/version/inject/permissions/tools/mcpServers/displace） |
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

## 变更流程（guard 红 → 修复四步）

1. 改契约文件（接口形状 / 注册契约 / 事件载荷 / manifest schema）；
2. `src/composition/contract-version.ts` 的 `OPEN_SURFACE_CONTRACT_VERSION` +1；
3. 本文件「变更记录」加一行（版本 / 日期 / 变更内容 / 依据）；
4. `npm run gen:contract-fingerprint` 更新指纹标记行——四步同 commit。

指纹是**粗粒度**的（原文 sha256——注释改动也会变指纹）：契约面宁可多升版，
不静默漂移；这是刻意取舍不是缺陷。纯注释整理不涉及语义时，同样走四步
（变更记录里如实写「注释整理，无语义变更」即可）。
