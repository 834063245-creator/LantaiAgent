// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent 域工具插件 · 真源产物（S3，plugin-bundle-retirement；批 7a 实心化 2026-09-24）。
//
// 两条注册面：
//   ① 工具**行**（family）——rowCtx 提供 spawner/pool，缺帐即空集；
//   ② apply 期把三个工厂登记进内核登记表（`agent/subagent-tools-impl.ts`）——内核
//      blueprint 的两条 capability（merge-tool / spawn-tool）查表取用（feature 语义：
//      未登记即静默不装）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { registerSubAgentTools } from './host';
import { subAgentToolsImplementation } from './implementation';
import { createAgentStatusTool, createSubAgentTool } from './subagent-tools';

/** agent 域插件——subAgentSpawner 缺帐时空集（原 if 分支语义）。 */
export const agentDomainPlugin = {
  name: 'hologram/agent-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => registerSubAgentTools(subAgentToolsImplementation), 'agent-domain');
    registerFamily(
      ctx,
      'agent-domain-tools',
      noCacheContributions(
        'hologram/agent-domain',
        (rowCtx) =>
          rowCtx.subAgentSpawner
            ? [
                createSubAgentTool(rowCtx.subAgentSpawner, rowCtx.subAgentPool),
                createAgentStatusTool(rowCtx.subAgentPool),
              ]
            : [],
        ['agent_spawn', 'agent_status'],
      ),
    );
  },
};

export default agentDomainPlugin;
