// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// browser-desktop 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。
// 整组缓存行：一行贡献承载整族（53 工具）；不收 rowCtx（无装配期依赖）。

import type { Context } from '../../../cordis';
import { createBrowserTools, createDesktopTools } from './browser';

/** browser-desktop 域插件（①b 迁入）——一行贡献承载整族
 *  （createBrowserTools + createDesktopTools，53 工具）。
 *  整族一行寻址（minimal preset 禁整族的原语义）恰是 preset 的使用形态。 */
export const browserDesktopDomainPlugin = {
  name: 'hologram/browser-desktop-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.tools.register({
        id: 'hologram/browser-desktop-domain/tools',
        factory: async () => {
          return [...createBrowserTools(), ...createDesktopTools()];
        },
      });
      return () => dispose();
    }, 'browser-desktop-domain-tools');
  },
};

export default browserDesktopDomainPlugin;
