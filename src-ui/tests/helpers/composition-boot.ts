// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试装配复现（平台化 Phase 1/2，2026-08-27；Phase 4/5 扩）：
// 生产 loadBuiltinPlugins 的通道最小集——四 service + llm-adapters +
// subagents（service + in-process provider）+ fs（service + builtin）+
// shell（service + builtin）+ sessionPersistence（service + builtin）+
// dynamicRunner（P4 D7）+ agentLoop（P5 D13）。
// （graph service + builtin provider 随图谱功能全量退役移除，2026-09-09。）
// 幂等：每个测试文件的模块图内只 boot 一次（vitest 按 file 隔离模块图）；
// 返回根 Context 供覆盖语义测试在同一注册表上注册 probe。
//
// 裸路径（不调本函数）的显式降级语义由 provider-dialect / subagent-seam /
// fs-seam / shell-seam / sessions-seam 钉住。

import { dynamicRunnerPlugin } from '../../src/agent/dynamic-runner/dynamic-runner-service';
import { fsServicePlugin } from '../../src/composition/fs-service';
import { compositionServicesPlugin } from '../../src/composition/services';
import { sessionPersistenceServicePlugin } from '../../src/composition/session-persistence-service';
import { shellServicePlugin } from '../../src/composition/shell-service';
import { subagentsServicePlugin } from '../../src/composition/subagent-service';
import { Context } from '../../src/cordis';
import { agentLoopServicePlugin } from '../../src/plugins/builtin/agent-loop-service';
// 批 6b：goal 循环实现归产物包（内核 Agent.runGoal/resumeGoal 查登记表取用）
import { compactionPlugin } from '../../src/plugins/builtin/compaction';
import { builtinFsPlugin } from '../../src/plugins/builtin/fs-builtin';
import { goalModePlugin } from '../../src/plugins/builtin/goal-mode';
import { llmAdaptersPlugin } from '../../src/plugins/builtin/llm-adapters';
// 批 6a：plan 模式实现归产物包（内核 blueprint 的两条 capability 查登记表取用）
// ⇒ 「生产最小集」必须含它，否则装配出的工具面少 enter/exit_plan_mode。
import { planModePlugin } from '../../src/plugins/builtin/plan-mode';
import { builtinSessionsPlugin } from '../../src/plugins/builtin/sessions-builtin';
import { builtinShellPlugin } from '../../src/plugins/builtin/shell-builtin';
import { inProcessSubagentPlugin } from '../../src/plugins/builtin/subagent-in-process';

let bootRoot: Context | null = null;

/** 幂等装配复现：需要 createProvider / spawnSubAgent / fs·shell 消费面 / 会话
 *  持久化 / 动态插件运行时 / agent loop 走注册表的测试在用到前
 *  await 本函数（可在模块顶层，也可在用例体内——后者用于保住裸路径用例的
 *  零装配前提）。返回根 Context。 */
export async function ensureProductionChannelsBooted(): Promise<Context> {
  if (bootRoot) return bootRoot;
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await root.plugin(llmAdaptersPlugin);
  await root.plugin(subagentsServicePlugin);
  await root.plugin(inProcessSubagentPlugin);
  await root.plugin(fsServicePlugin);
  await root.plugin(builtinFsPlugin);
  await root.plugin(shellServicePlugin);
  await root.plugin(builtinShellPlugin);
  await root.plugin(sessionPersistenceServicePlugin);
  await root.plugin(builtinSessionsPlugin);
  await root.plugin(dynamicRunnerPlugin);
  await root.plugin(agentLoopServicePlugin);
  await root.plugin(planModePlugin);
  await root.plugin(goalModePlugin);
  await root.plugin(compactionPlugin);
  bootRoot = root;
  return root;
}
