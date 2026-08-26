// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/compose-dock-plugin — 创作坞 + 目次带第一方插件（Stage-4）。
//
// 原则二/三（插件化分层）：创作坞/目次带 = 上层形态 = 贡献行，经 ctx.overlays
// 注册（Stage-4 打孔：流区附着渲染通道），由 PaperPanel 渲染在对应槽位——
// 核心只长「通道」，不写具体形态。消费 ctx.space（space-status 命令读画布
// 状态 = 消费对拍证据）+ 会话状态 API（ComposerDock 内部经 compose-store）。
//
// 注册纪律：disposer 经 ctx.effect 登记；装载在 overlayServicePlugin +
// spaceServicePlugin 之后（loadBuiltinPlugins 表序，inject 依赖可解析）。

import { ComposerDock } from '../app/panels/ComposerDock';
import { TocStrip } from '../app/panels/TocStrip';
import type { Context } from '../cordis';

/** 创作坞插件——composer 槽 + right-edge 槽双覆盖贡献 + 空间消费命令。 */
export const composeDockPlugin = {
  name: 'hologram/compose-dock',
  inject: ['overlays', 'commands', 'space'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.overlays.register({
          id: 'compose-dock',
          slot: 'composer',
          component: ComposerDock,
        }),
      'compose-dock',
    );
    ctx.effect(
      () =>
        ctx.overlays.register({
          id: 'toc-strip',
          slot: 'right-edge',
          component: TocStrip,
        }),
      'toc-strip',
    );

    // 消费 ctx.space 的证据（stage-4 §4.5「贡献行 + 消费对拍」）：
    // 命令读画布当前状态，经插件宿主桥 notify 反馈到状态栏。
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'compose/space-status',
          label: '创作坞：画布状态',
          group: '画布',
          shortcut: '/dock',
          action: {
            type: 'local',
            handler: () => {
              const state = ctx.space.getState();
              const msg = `创作坞 · 活跃 ${state.activeSessionId ?? '—'} · ${state.regions.length} 个流区`;
              const host = (globalThis as { __lantai_plugin_host__?: { notify?: (text: string) => void } })
                .__lantai_plugin_host__;
              if (host?.notify) host.notify(msg);
              else console.info('[compose-dock] 画布状态:', msg);
            },
          },
        }),
      'compose-space-command',
    );
  },
};
