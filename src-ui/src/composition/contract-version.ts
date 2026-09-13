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
export const OPEN_SURFACE_CONTRACT_VERSION = 28;

/** 契约面载体文件（相对 src-ui/；fingerprint 生成器与 guard 消费同一份）。
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
  // 六个 seam 注册表（provider 接口 + 动作枚举 + 消费单点签名）
  'src/composition/services.ts', // ctx.llm + ContributionRegistry 内核 + 四通道 def
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
  // 插件 manifest 契约（loader 装载面）
  'src/plugins/types.ts',
];
