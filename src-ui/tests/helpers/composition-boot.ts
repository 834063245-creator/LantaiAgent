// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试装配复现（平台化 Phase 1/2，2026-08-27）：生产 loadBuiltinPlugins 的通道
// 最小集——四 service + llm-adapters + subagents（service + in-process provider）
// + fs（service + builtin）+ shell（service + builtin）+ sessionPersistence
// （service + builtin）+ graph（service + builtin）。幂等：每个测试文件的模块
// 图内只 boot 一次（vitest 按 file 隔离模块图）；返回根 Context 供覆盖语义
// 测试在同一注册表上注册 probe。
//
// 裸路径（不调本函数）的显式降级语义由 provider-dialect / subagent-seam /
// fs-seam / shell-seam / sessions-seam / graph-seam 钉住。

import { builtinFsPlugin } from '../../src/agent/fs-provider';
import { builtinGraphPlugin } from '../../src/agent/graph-provider';
import { builtinSessionsPlugin } from '../../src/agent/sessions-provider';
import { builtinShellPlugin } from '../../src/agent/shell-provider';
import { inProcessSubagentPlugin } from '../../src/agent/subagent-provider';
import { fsServicePlugin } from '../../src/composition/fs-service';
import { graphServicePlugin } from '../../src/composition/graph-service';
import { compositionServicesPlugin } from '../../src/composition/services';
import { sessionPersistenceServicePlugin } from '../../src/composition/session-persistence-service';
import { shellServicePlugin } from '../../src/composition/shell-service';
import { subagentsServicePlugin } from '../../src/composition/subagent-service';
import { Context } from '../../src/cordis';
import { llmAdaptersPlugin } from '../../src/plugins/llm-adapters-plugin';

let bootRoot: Context | null = null;

/** 幂等装配复现：需要 createProvider / spawnSubAgent / fs·shell 消费面 / 会话
 *  持久化 / 图分析走注册表的测试在用到前 await 本函数（可在模块顶层，也可在
 *  用例体内——后者用于保住裸路径用例的零装配前提）。返回根 Context。 */
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
  await root.plugin(graphServicePlugin);
  await root.plugin(builtinGraphPlugin);
  bootRoot = root;
  return root;
}
