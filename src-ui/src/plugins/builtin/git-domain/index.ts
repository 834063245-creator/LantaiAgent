// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createGitTools } from './git-tools';

/** git 域插件——贡献 13 工具（序 = createGitTools 声明序）。 */
export const gitDomainPlugin = {
  name: 'hologram/git-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'git-domain-tools', familyContributions('hologram/git-domain', createGitTools));
  },
};

export default gitDomainPlugin;
