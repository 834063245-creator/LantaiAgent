// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// web 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。
// 原 coding-domain-plugins.ts webDomainPlugin 整体迁入。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createWebTools } from './web-tools';

/** web 域插件（①b 迁入，2026-08-23）——贡献 web_search + web_fetch 双工具。 */
export const webDomainPlugin = {
  name: 'hologram/web-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'web-domain-tools', familyContributions('hologram/web-domain', createWebTools));
  },
};

export default webDomainPlugin;
