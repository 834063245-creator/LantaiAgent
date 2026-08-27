// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider（平台化 Phase 1 · D3 默认实现，2026-08-27）——
// spawnSubAgentImpl 的注册表外壳：行为逐字节一致（impl 原样透传，零逻辑改动），
// 消费面改经 ctx.subagents 解析（拆旧清单 T7：Agent 直调旁路点拆除）。
// 外部后端（ACP / 远程）未来经同一注册表挂接，后注册胜覆盖默认。

import type { SubagentProvider } from '../composition/subagent-service';
import type { Context } from '../cordis';
import { spawnSubAgentImpl } from './subagent-spawn';

/** 默认 in-process 子代理 provider（id 'builtin/in-process'）。 */
export const inProcessSubagentProvider: SubagentProvider = {
  id: 'builtin/in-process',
  spawn(host, args) {
    return spawnSubAgentImpl(
      host,
      args.description,
      args.prompt,
      args.onProgress,
      args.mode,
      args.toolAllowlist,
      args.poolSignal,
      args.asyncMode,
      args.agentIdOverride,
      args.outputSchema,
    );
  },
};

/** in-process provider 贡献插件（loader 表序：subagentsServicePlugin 之后）。 */
export const inProcessSubagentPlugin = {
  name: 'hologram/subagent-in-process',
  inject: ['subagents'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.subagents.register(inProcessSubagentProvider), 'subagent-in-process');
  },
};
