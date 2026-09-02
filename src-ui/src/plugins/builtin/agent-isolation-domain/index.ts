// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-isolation 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createAgentIsolationTools } from './host';

/** agent-isolation 域插件——贡献 worktree 隔离 5 工具（② 批）。 */
export const agentIsolationDomainPlugin = {
  name: 'hologram/agent-isolation-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'agent-isolation-domain-tools',
      familyContributions('hologram/agent-isolation-domain', createAgentIsolationTools),
    );
  },
};

export default agentIsolationDomainPlugin;
