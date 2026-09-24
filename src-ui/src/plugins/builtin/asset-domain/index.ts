// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createAssetTools } from './asset-tools';

/** asset 域插件（Agent 资产块，2026 资产协议）——show_asset / update_asset /
 *  list_block_kinds 三工具。无状态族：只依赖模块级 kind 注册表与 args meta。 */
export const assetDomainPlugin = {
  name: 'hologram/asset-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'asset-domain-tools',
      familyContributions('hologram/asset-domain', () => createAssetTools()),
    );
  },
};

export default assetDomainPlugin;
