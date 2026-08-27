// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 graph 分析 provider（平台化 Phase 2 · D11 默认实现，2026-08-27）——
// 现有 engine RPC 的薄包装：invoke 经 hologram_call 派发（tool = engine 分析
// 工具名），零逻辑改动（与 hologramDomainPlugin 旧 holoExec 逐字节等价）。

import type { GraphProvider } from '../composition/graph-service';
import type { Context } from '../cordis';
import { agentInvoke } from './tool';

/** 默认 Rust/engine 图分析 provider（id 'builtin/rust-graph'）。 */
export const builtinGraphProvider: GraphProvider = {
  id: 'builtin/rust-graph',
  async invoke(tool, args) {
    return agentInvoke('hologram_call', { tool, args });
  },
};

/** builtin graph provider 贡献插件（loader 表序：graphServicePlugin 之后）。 */
export const builtinGraphPlugin = {
  name: 'hologram/graph-builtin',
  inject: ['graph'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.graph.register(builtinGraphProvider), 'graph-builtin');
  },
};
