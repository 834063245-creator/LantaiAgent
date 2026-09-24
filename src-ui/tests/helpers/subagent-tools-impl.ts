// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试腰：把 subagent 工具族实现按**生产生命周期**登记（批 7a）。
//
// 为什么要它：生产里实现由 `hologram/agent-domain` 插件在**装载期**登记，该 fiber 随根
// Context 常驻（main.ts → loadBuiltinPlugins）。而**工具通道腰**（`withFirstPartyToolChannel`）
// 与 convergence 裸 AgentRuntime 都不跑装载器 ⇒ blueprint 的两条 capability（merge-tool /
// spawn-tool）查不到实现 ⇒ 按 feature 语义静默不装（裸 runtime 的运行时工具面少
// agent_kill / agent_spawn 的**替换版**，快照会漂移）。本腰复现「装载器已跑过」的常驻态。
//
// 幂等：重复调用无害（登记表栈语义——后登记胜、回退到上一版）。

import { registerSubAgentTools } from '../../src/agent/subagent-tools-impl';
import { subAgentToolsImplementation } from '../../src/plugins/builtin/agent-domain/implementation';

let installed = false;

/** 常驻登记 subagent 工具族实现（= 生产装载器已装载 hologram/agent-domain）。 */
export function installSubAgentToolsForTest(): void {
  if (installed) return;
  installed = true;
  registerSubAgentTools(subAgentToolsImplementation);
}
