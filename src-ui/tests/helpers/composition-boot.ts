// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试装配复现（平台化 Phase 1，2026-08-27）：生产 loadBuiltinPlugins 的通道
// 最小集——四 service + llm-adapters + subagents service + in-process subagent
// provider。幂等：每个测试文件的模块图内只 boot 一次（vitest 按 file 隔离模块
// 图）；返回根 Context 供覆盖语义测试在同一注册表上注册 probe。
//
// 裸路径（不调本函数）的显式降级语义由 provider-dialect / subagent-seam 钉住。

import { inProcessSubagentPlugin } from '../../src/agent/subagent-provider';
import { compositionServicesPlugin } from '../../src/composition/services';
import { subagentsServicePlugin } from '../../src/composition/subagent-service';
import { Context } from '../../src/cordis';
import { llmAdaptersPlugin } from '../../src/plugins/llm-adapters-plugin';

let bootRoot: Context | null = null;

/** 幂等装配复现：需要 createProvider / spawnSubAgent 走注册表的测试在用到前
 *  await 本函数（可在模块顶层，也可在用例体内——后者用于保住裸路径用例的
 *  零装配前提）。返回根 Context。 */
export async function ensureProductionChannelsBooted(): Promise<Context> {
  if (bootRoot) return bootRoot;
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await root.plugin(llmAdaptersPlugin);
  await root.plugin(subagentsServicePlugin);
  await root.plugin(inProcessSubagentPlugin);
  bootRoot = root;
  return root;
}
