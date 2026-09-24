// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createShellTools } from './shell-tools';

/** shell 域插件——贡献 4 工具（run_shell → bash_output/kill/wait；② 批）。 */
export const shellDomainPlugin = {
  name: 'hologram/shell-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'shell-domain-tools', familyContributions('hologram/shell-domain', createShellTools));
  },
};

export default shellDomainPlugin;
