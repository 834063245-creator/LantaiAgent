// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider（平台化 Phase 1 · D3 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/subagent-provider.ts
// 整体迁入；运行时依赖 spawnSubAgentImpl 经宿主桥取用。

import type { SubagentProvider } from '../../../composition/subagent-service';
import type { Context } from '../../../cordis';
import { spawnSubAgentImpl } from './host';

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

export default inProcessSubagentPlugin;
