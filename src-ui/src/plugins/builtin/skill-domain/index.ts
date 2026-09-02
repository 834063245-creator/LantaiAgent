// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// skill 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createSkillTool } from './host';

/** skill 域插件——skillRegistry 缺帐时空集（原 if 分支语义）。 */
export const skillDomainPlugin = {
  name: 'hologram/skill-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'skill-domain-tools',
      noCacheContributions(
        'hologram/skill-domain',
        (rowCtx) => (rowCtx.skillRegistry ? [createSkillTool(rowCtx.skillRegistry)] : []),
        ['Skill'],
      ),
    );
  },
};

export default skillDomainPlugin;
