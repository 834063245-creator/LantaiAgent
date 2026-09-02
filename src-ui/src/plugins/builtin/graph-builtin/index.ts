// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 graph 分析 provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/graph-provider.ts
// 整体迁入；运行时依赖 agentInvoke 经宿主桥取用。

import type { GraphProvider } from '../../../composition/graph-service';
import type { Context } from '../../../cordis';
import { agentInvoke } from './host';

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

export default builtinGraphPlugin;
