// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createAskUserTools } from './host';

/** ask 域插件——常驻 ask_user（ui 回调每次装配换新；缺帐时工具仍注册、
 *  execute 返回「UI 未接线」错误——原行语义保留）。 */
export const askDomainPlugin = {
  name: 'hologram/ask-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'ask-domain-tools',
      noCacheContributions('hologram/ask-domain', (rowCtx) => createAskUserTools(rowCtx.ui), ['ask_user']),
    );
  },
};

export default askDomainPlugin;
