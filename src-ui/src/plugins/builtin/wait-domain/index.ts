// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createWaitTool } from './wait';

/** wait 域插件——常驻 wait（依赖当次装配的 subAgentPool）。 */
export const waitDomainPlugin = {
  name: 'hologram/wait-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'wait-domain-tools',
      noCacheContributions('hologram/wait-domain', (rowCtx) => [createWaitTool(rowCtx.subAgentPool)], ['wait']),
    );
  },
};

export default waitDomainPlugin;
