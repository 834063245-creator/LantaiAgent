// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 开放面契约版本（平台化 Phase 3 · P3-C4，2026-08-27）——对齐 DSH
// SESSION_FORMAT_VERSION 机制：seam 接口面是三方（插件/动态插件/MCP 之上的
// provider 层）共同依赖的契约，变更必须显式升版 + 记录，不得静默改约。
//
// 机制三件（单一真源都在本文件 + 对拍文档）：
//   1. OPEN_SURFACE_CONTRACT_VERSION——契约当前版本（整数递增）；
//   2. OPEN_SURFACE_CONTRACT_FILES——契约面的物理载体清单（这些源文件里的
//      公开类型形状 / 注册契约 / 事件载荷 / manifest schema 就是「开放面」）；
//   3. 指纹对拍——docs/agents/open-surface-contract.md 记录当前版本与
//      文件清单的 sha256 指纹；guard 测试（tests/seam-contract-version.test.ts）
//      重算对拍：**文件变更未升版/未更新指纹 = 红**。
//
// 变更流程（guard 红时的修复路径）：
//   ① 改契约文件 → ② bump OPEN_SURFACE_CONTRACT_VERSION →
//   ③ docs/agents/open-surface-contract.md 变更记录加一行 →
//   ④ npm run gen:contract-fingerprint 更新指纹 → 同 commit。
//
// 指纹是粗粒度的（原文 sha256，注释改动也会变）——契约面宁可多升版，
// 不静默漂移；这是刻意取舍不是缺陷。

/** 开放面契约当前版本（变更即 +1，历史见 open-surface-contract.md 变更记录）。 */
export const OPEN_SURFACE_CONTRACT_VERSION = 38;

/** 契约面载体文件（相对 src-ui/；fingerprint 生成器与 guard 消费同一份）。
 *  v38（2026-09-15）S6 P3a 插件**激活声明**（登记 ≠ 激活）：manifest 新增可选块
 *  `activation: { lazy?, resources?, exclusive? }`（plugins/types.ts）——`lazy:true`
 *  的插件把副作用启动从 apply 期挪到**组合装配期**（引用计数：首次 start /
 *  归零 stop，见 composition/activation.ts）；`lazy:true` 与
 *  `mcpServers[].lifecycle="eager"` 互斥（manifest 级 refine，装载期拒载）。
 *  **对外可感知**：插件可声明资源型副作用并拿到按组合的生命周期；**缺省 =
 *  无 `activation` 块 ⇒ P3 前语义（登记即激活）逐字节不变**（kill switch，
 *  设计件 §5）。同版新增第五个组合层 service `ctx.activation`
 *  （composition/activation-service.ts）——插件面（apply 期 declare）与装配面
 *  （retain/release）的契约载体。**本版起契约面口径统一**：用户 preset 的写法
 *  契约 `composition/roster.ts` 与新服务文件一并登记（用户 2026-09-15 裁定 F：
 *  此前靠「文件不在清单里」逃过指纹）| S6-per-agent-composition.md P3a
 *  （施工单 WO-S6P3-plugin-activation.md §2.1/§2.3/§7-A/§7-F）
 *  v37（2026-09-15）S6 P2b llm seam **装配期值注入**：`activeLlmAdapters(view?)`
 *  收可选 view；`createProvider(settings, options)` 的 `CreateProviderOptions` 新增
 *  可选 `seamView`——方言解析（`resolveProviderDialect`）按它裁剪 `seam/llm`。
 *  **对外可感知**：同一份 settings，两卷可落不同 adapter（每卷 provider 由
 *  workspace 会话工厂 / 热切换按该卷组合构建）；**缺省 = 全局当前选择** ⇒
 *  无组合上下文的构建点（设置面板连通性测试 / 翻译压缩旁路 / 第三方自测）行为
 *  逐字不变。工作区默认 provider 有意不传（其组合上下文 = 工作区装配组合，
 *  已由 composition-store 灌成全局当前选择）| S6-per-agent-composition.md P2b
 *  （施工单 WO-S6P2 §2 消费点 4 + §7-F 两笔切分的第二笔）
 *  v36（2026-09-15）S6 P2a seam 裁剪面**装配期值注入**：`seamDisabled(domain, view?)`
 *  新增可选 view —— **缺省 = 全局当前选择**（无组合上下文的旧路径逐字保持 P2 前
 *  语义）；`activeFsProviders` / `activeShellProviders` / `activeSubagentProviders`
 *  同款收可选 view；`AgentEventBus` 新增 `setSeamView()`（每 Agent 一条总线，
 *  emitLoopEvent 读本总线视图——emit 调用点零改动）。**对外可感知**：seam provider
 *  的可见面从此可按 Agent 的不同（两份裁剪面并存互不串味）；未传 view 的旧调用面
 *  （UI 直调 / 无 agent 工具路径 / 第三方 provider 自测）行为逐字不变 ⇒ convergence
 *  双轨快照零漂移（出厂 standard/minimal 的 seamDisabled 构造性为空）。新增携带层
 *  `composition/seam-scope.ts` 是**键控叶模块**，不入本清单（非三方面；叶性由
 *  tests/composition-import-cycle.test.ts 钉住） | S6-per-agent-composition.md P2a
 *  （施工单 WO-S6P2 §2/§7-A 用户裁定：携带路径取 owner 键控表而非 rowCtx 扩字段
 *  ——fs/shell 族实例经 familyContributions 锁存首次装配 rowCtx，扩字段结构性无效）
 *  v35（2026-09-15）	ool/call 前移到分发时落（触发点 B 收官，用户已批准
 *  phase-5 基线变更）：默认 loop 注入的检查点钩子现在**先 append 	ool/call、
 *  再 lushPersistence()**，让「模型宣布了什么」在副作用发生前就落盘；default-loop
 *  两处流收尾的重复追加删除（单一写入点）。**契约形状零变更**（AgentLoopHost 未动）；
 *  模型可见面零变化（	ool/call 无消息投影）；事件**序列**变化 ⇒ phase-5 事件序列
 *  基线两轨重录（CR 见 docs/archive/agent-core-convergence/baseline-change-request.md）。
 *  v34（2026-09-15）工具副作用前检查点（换轨触发点 B 的兰台形）：默认 loop
 *  构造 StreamingToolExecutor 时注入第 7 参钩子 = host.sessionLog.flushPersistence()
 *  ——args 解析完成、闸/预检之前 await 一次「会话事实落盘屏障」，失败 fail-open 且
 *  executor 内 warn 可见。**契约形状零变更**（AgentLoopHost 成员未动；新参数在
 *  执行器构造上，第三方 loop 自管工具执行不受影响）；同版 SessionLog 增
 *  setPersistenceSink / lushPersistence 两个方法（日志自己回答「我落盘了吗」，
 *  避免 agent 层 import app 层——分层纪律）。**仍未做**：把 	ool/call 审计事件
 *  提前到分发时落（那会改事件顺序 ⇒ phase-5 基线漂移 ⇒ 需 baseline-change-request）。
 *  v33（2026-09-15）会话持久化 seam 权威翻转（Phase 3b）：delete_volume 退役
 *  （墓碑重写 deleted:true 是「快照即存储」时代的占位手段——权威翻转后
 *  「文件不在 = 卷不存在」），新增 delete_log（真删日志 + 投影缓存）。
 *  **对外可感知**：第三方会话后端 provider 应实现 delete_log 并退役 delete_volume；
 *  同版消费面：.ndjson 成为卷本体（list/scan/剪枝/删除 全按日志认卷），
 *  .json 降级为带 {seq, ver} 的 UI 投影缓存（陈旧即重建，不再当权威读）。
 *  v32（2026-09-15）会话持久化 seam 动作面扩展（DSH 参照换轨 Phase 1）：
 *  `SESSION_PERSIST_ACTIONS` 由四动作（read/list/save/delete_volume）扩为八动作
 *  ——新增事件日志四动作 `read_log` / `write_log` / `append_events`（durable：
 *  append + fsync，返回即已落盘）/ `truncate_log`（断尾修复）。**对外可感知**：
 *  第三方会话后端 provider 需实现四新动作才算完整实现（文本持久化的后端最简单
 *  的实现 = 四动作转发到同一份文件读写；不改后端也能跑——事件日志面缺席即
 *  「旧行为逐字不变」）。同版消费面：`app/chat/session-log-store.ts`（写后队列 +
 *  最小加载器）+ `shell/rows/persistence.ts` 的检查点从「落全量快照」改为
 *  「排空日志队列」。
 *  v31（2026-09-15）S6 P1b 选择集语义：`ToolContribution` 新增可选
 *  `defaultOff?: boolean`——插件可出货「**登记但默认不进任何组合**」的行
 *  （重装备/实验性），组合解析把它初始置 disabled，用户在自己的 preset 里写
 *  `disabled: false` 回开（roster 侧既有语义，零新语法）。**对外可感知**：
 *  第三方插件从此能出货默认关的行面；不声明 = 行为逐字不变（出厂面零声明
 *  ⇒ convergence 双轨快照零漂移，本版实测）。同版诊断面按**原因**分栏
 *  （未选中 / 被禁用 / seam 裁剪——`CompositionDiagnostics` 新增
 *  `unselected` / `seamCapped`，seam id 不再混进 `disabled`；该类型在
 *  roster.ts，不属契约面载体，随本版一并记录）。
 *  v30（2026-09-14）动态插件守卫注册面校准（`dynamic-runner/sandbox.ts`）：
 *  `GUARDED_SERVICES` 此前漂移已久——仍列着 2026-09-09 全量退役的 `graph`
 *  （死条目：模型照它写 `ctx.graph.register` 必报「服务不可解析」），且缺
 *  `overlays` / `hooks` / `agentLoop`；同文件 `validateDef` 还按服务特判
 *  `needId='key'`，在 v29 把行身份统一成 `id` 之后，**动态插件注册 capability
 *  整条路恒失败**（给正确 id 被守卫拒，给旧 key 被通道形状校验拒）。
 *  本版：白名单 = 九条贡献通道 + 五条 seam 全量 14 面；`needId` 统一 `id`；
 *  `hooks` 的嵌套形状（`{ id, kind, hook }`，函数成员在 hook 内且随 kind 变）
 *  由新增的 `SHAPE_CHECKS` 承担装载期校验。**对外可感知**：动态插件从此能贡献
 *  overlays / hooks / agentLoop，capability 必须用 `id`。同版补上文件自注承诺
 *  却缺席的守护——白名单 ↔ 真装配对拍（tests/dynamic-runner.test.ts ⑩）。
 *  v29（2026-09-14）M1 插件化收口（通道内核单层化）：注册表内核从
 *  `services.ts` 的 `ContributionRegistry` 上收为 `contribution-channel.ts` 的
 *  `ContributionChannel`——**类名变更 = 破坏性契约变更**（该名字经宿主桥
 *  faceDeps 与 `host.aliased.ts` 暴露给产物插件；五个手抄副本
 *  Renderer/Prompt/HookContribution/CapabilityContribution/Overlay 随之退役）。
 *  行为面零变更（id 寻址/重名拒绝/幂等 disposer/陈旧性守卫/贡献序逐字保持），
 *  新增两件声明式数据：`timing`（四档生效时机，历史上是隐式的「传没传回调」）
 *  与 `subscribe`（统一订阅面，收编 OverlayRegistry 的自成一格 API）。
 *  **同版破坏性变更**：`AgentCapability.key` 更名为 `.id`（capabilities 是九条
 *  通道里唯一行身份不叫 id 的，M1 统一为 id；`AgentBlueprint.keys()` 随之更名
 *  `ids()`）——外部插件若贡献 capability 必须改字段名，旧名不保留别名。
 *  v28（2026-09-13）：`manifest.app` 入口二态——`entry`（资产 HTML）与 `url`
 *  （**环回** http(s) 远端页，白名单 127.0.0.1/localhost/::1、禁凭据）互斥必给其一；
 *  url 形态禁 `fullscreen`。远端形态的窗口帧给 `allow-same-origin`（跨源文档保住
 *  自己 origin，同源 SSE/fetch 才通）且**不绑宿主桥**。契约形状变更（entry 由必填
 *  转为「二态之一」），向后兼容：只声明 entry 的既有插件行为零变化。
 *  v27（2026-09-13）：`manifest.mcpServers[]` 新增可选 `readOnly`（MCP 工具只读
 *  语义归真——P0，见 office-cli-integration-plan.md §5）：判定真源落在
 *  `agent/mcp/registry.resolveMcpToolReadOnly`（条目声明 > 远端 annotations.
 *  readOnlyHint > 缺省 false）。types.ts 是 manifest schema 载体，故本版升号。
 *  v26（2026-09-13）：`LoopStreamResult` 新增可选 `token`（token 计量记录）——
 *  默认 loop 把它随 Usage 事件投给 UI；第三方 loop 不提供即 UI 计量面缺一条，
 *  执行语义零变更。同版 default-loop 的 Usage sink 增携带该字段。
 *  v25（2026-09-12）：补登记 `provider/types.ts`——`ctx.llm` 的
 *  `LlmAdapterContribution.create` 返回的 `Provider` 形状就是该 seam 的契约面，
 *  此前未入册（本版给 Provider 加 `model()` 时差点从指纹下溜过去）；
 *  同版 events.ts 载荷 provider/model 分账。
 *  v24（2026-09-09）：graph-service.ts（ctx.graph seam）随图谱功能全量退役移除。 */
export const OPEN_SURFACE_CONTRACT_FILES: readonly string[] = [
  // 贡献通道内核（M1 收口：九通道 + 五 seam 的唯一注册表实现——ContributionChannel
  // 本身是插件面（经宿主桥 faceDeps 暴露），形状变更即对外契约变更）
  'src/composition/contribution-channel.ts',
  // 六个 seam 注册表（provider 接口 + 动作枚举 + 消费单点签名）
  'src/composition/services.ts', // ctx.llm + 四通道 def（M1 起内核移出本文件）
  'src/provider/types.ts', // ctx.llm seam 的实现面形状真源（Provider/Chunk/Request——v25 补登记）
  'src/composition/fs-service.ts', // ctx.fs
  'src/composition/shell-service.ts', // ctx.shell（subprocess 并入）
  'src/composition/session-persistence-service.ts', // ctx.sessionPersistence
  'src/composition/subagent-service.ts', // ctx.subagents
  // seam 裁剪面（组合域寻址契约）
  'src/composition/seam-resolution.ts',
  // 事件面（D4 表 + 载荷形状）
  'src/agent/events.ts',
  // 动态插件运行时（D7——define/run/stop/undefine/inspect + 沙箱承诺）
  'src/agent/dynamic-runner/dynamic-runner-service.ts',
  'src/agent/dynamic-runner/sandbox.ts',
  // agent loop seam（D13——AgentLoop/AgentLoopHost 契约 + 默认实现 + 活动面）
  'src/agent/agent-loop/types.ts',
  'src/agent/agent-loop/default-loop.ts',
  'src/agent/agent-loop/agent-loop-active.ts',
  // 插件 manifest 契约（loader 装载面；v38 起含 activation 块）
  'src/plugins/types.ts',
  // 用户 preset 写法契约（v38 补登记——用户裁定 F：patch schema 此前靠
  // 「文件不在清单里」逃过指纹；内容 = CompositionPatchSchema 的四行域 + 七
  // seam 裁剪域键，用户手写在 ~/.lantai/composition/presets/<id>/roster.patch.yml）
  'src/composition/roster.ts',
  // 激活账（v38 新增第五个组合层 service；插件面 = apply 期 declare(spec) 的
  // ActivationSpec 形状，装配面 = retainForComposition/releaseAll）
  'src/composition/activation.ts',
  'src/composition/activation-service.ts',
];
