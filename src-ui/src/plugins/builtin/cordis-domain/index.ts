// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// cordis 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { CORDIS_TOOL_NAMES, createCordisTools } from './host';

/** cordis 域插件（平台化 Phase 4 · D7，2026-08-27）——动态插件 define/run/
 *  stop/undefine/inspect 六工具。装配期真值族：cordis_run 的审批通道
 *  = rowCtx.ui（askUser 语义）——noCache 每装配重收取 ui。 */
export const cordisDomainPlugin = {
  name: 'hologram/cordis-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'cordis-domain-tools',
      noCacheContributions('hologram/cordis-domain', (rowCtx) => createCordisTools({ ui: rowCtx.ui }), [
        ...CORDIS_TOOL_NAMES,
      ]),
    );
  },
};

export default cordisDomainPlugin;
