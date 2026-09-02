// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// search 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createSearchTools } from './host';

/** search 域插件——贡献 search_content 单工具。 */
export const searchDomainPlugin = {
  name: 'hologram/search-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'search-domain-tools', familyContributions('hologram/search-domain', createSearchTools));
  },
};

export default searchDomainPlugin;
