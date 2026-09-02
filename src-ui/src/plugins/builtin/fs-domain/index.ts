// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createFsTools } from './host';

/** fs 域插件——贡献 11 工具（序 = createFsTools 声明序；② 批 2026-08-23）。 */
export const fsDomainPlugin = {
  name: 'hologram/fs-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'fs-domain-tools', familyContributions('hologram/fs-domain', createFsTools));
  },
};

export default fsDomainPlugin;
