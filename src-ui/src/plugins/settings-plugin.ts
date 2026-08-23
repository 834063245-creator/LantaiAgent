// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// settings 域第一方插件（S3）—— settings 面板域行化：面板 + 命令双贡献。
//
// 挂载通道（S3 设计件 §2.5）：从 panel-def 常量行 + 壳行 toggle-settings
// 动作迁为组合层贡献（对齐 paper/paper-plugin.ts 的 V3b 先例——「重构推到
// 哪个域，行化跟到哪个域」）。settings.ts 持久化与 agent-config-store 订阅
// 是 workspace 级关注点，留壳层不动（原范围裁决，设计件 §0）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约——
// 调用方负责所有权，见 composition/services.ts 头注）；装载在四 service
// 之后（loadBuiltinPlugins 表序），ctx.panels / ctx.commands 可解析。
// 快捷键 ctrl+, 的分发链不变：useGlobalKeys 字面量 runAction('toggle-settings')
// → app/actions.ts 别名翻译层 → 本插件的 settings/toggle 贡献（设计件 §2.3）。

import { SettingsPanel } from '../app/panels/SettingsPanel';
import type { Context } from '../cordis';
import { useDockStore } from '../state/dock-store';

/** settings 域插件 — 面板贡献（即时生效）+ toggle 命令贡献。 */
export const settingsPlugin = {
  name: 'hologram/settings-domain',
  inject: ['panels', 'commands'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'settings',
          // side:null 全屏覆盖 + 关即卸载（对齐旧 panel-def 常量行，逐字段等值迁移）
          side: null,
          title: '设置',
          icon: 'settings',
          unmountOnClose: true,
          component: SettingsPanel,
        }),
      'settings-panel',
    );
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'settings/toggle',
          label: '设置…',
          group: '设置',
          // shortcut 是 palette 显示值（kbd 提示）；键绑定仍在 useGlobalKeys 全局层
          shortcut: 'ctrl ,',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('settings') },
        }),
      'settings-command',
    );
  },
};
