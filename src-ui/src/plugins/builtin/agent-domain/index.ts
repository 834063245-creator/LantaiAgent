// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createAgentStatusTool, createSubAgentTool } from './host';

/** agent 域插件——subAgentSpawner 缺帐时空集（原 if 分支语义）。 */
export const agentDomainPlugin = {
  name: 'hologram/agent-domain',
  inject: ['tools'],
  apply(ctx: Context) {
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
