// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// settings 域第一方插件（S3）—— settings 面板域行化：面板 + 命令双贡献。
//
// 挂载通道（S3 设计件 §2.5）：从 panel-def 常量行 + 壳行 toggle-settings
// 动作迁为组合层贡献（对齐 paper-shell 插件先例——「重构推到哪个域，
// 行化跟到哪个域」）。settings.ts 持久化与 agent-config-store 订阅
// 是 workspace 级关注点，留壳层不动（原范围裁决，设计件 §0）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约——
// 调用方负责所有权，见 composition/services.ts 头注）；装载在四 service
// 之后（loadBuiltinPlugins 表序），ctx.panels / ctx.commands 可解析。
// 快捷键 ctrl+, 的分发链不变：useGlobalKeys 字面量 runAction('toggle-settings')
// → app/actions.ts 别名翻译层 → 本插件的 settings/toggle 贡献（设计件 §2.3）。
//
// 双走查形态（增补四，first-party-hot-reload-plan）：bundle 兜底行 +
// 产物域（dist-plugins/builtin/hologram/settings-domain/，manifest 声明
// displace 位移 bundle 行；设置面板「重新加载」热替换）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { useDockStore, useShellStore } from './host';
import { SettingsPanel } from './SettingsPanel';
import { SETTINGS_TABS } from './settings-tabs';
import { bootUpdateCheck } from './update-check';

/** settings 域插件 — 面板贡献（即时生效）+ toggle 命令贡献。 */
export const settingsPlugin = {
  name: 'hologram/settings-domain',
  inject: ['panels', 'commands', 'shellRows'],
  apply(ctx: Context) {
    /* §4-9（批 10 同窗）：壳行贡献——启动期自动检查更新（原内核 shell-update-check 行）。
     * 行 id 用 plugin/ 前缀（对齐工具行先例）；boot 期由 bootShell 在内置行之后按注册序执行。 */
    ctx.effect(
      () =>
        ctx.shellRows.register({
          id: 'plugin/hologram/settings-domain/shell-update-check',
          boot: () => bootUpdateCheck(),
        }),
      'shell-update-check',
    );
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'settings',
          // side:null 全屏覆盖 + 关即卸载（对齐旧 panel-def 常量行，逐字段等值迁移）
          side: null,
          title: '设置',
          icon: 'settings',
          unmountOnClose: true,
          // 关时先留一个出场窗（§15 退场对称）——出场样式在 settings-panel.css
          animateExit: true,
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
          slash: '/settings',
          // kbd 是 palette 显示值（kbd 提示）；键绑定仍在 useGlobalKeys 全局层
          kbd: 'ctrl ,',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('settings') },
        }),
      'settings-command',
    );
    /* 全局搜索的「设置」组（2026-11-28）：八个页签各**贡献一条命令**（无 slash ⇒ 不进斜杠
     * 面板，只进命令面板/全局搜索）。执行 = 打开设置面板 + 落到那一页——跨插件不给面板加
     * 参数（插件自包含契约），故经 shell-store 的一次性请求位（`requestSettingsTab`），
     * SettingsPanel 消费即清。页签 id 的合法性也在这里守住（面板按 SETTINGS_TABS 校验）。
     *
     * 为什么是贡献而不是让面板直接读表：面板（app 层）不许 import 插件目录（层次纪律），
     * 而页签表是本域的真源——经命令通道交出去，面板只认「组名 = 设置」这一条通用规矩。 */
    ctx.effect(() => {
      const offs = SETTINGS_TABS.map((tab) =>
        ctx.commands.register({
          id: `settings/tab/${tab.id}`,
          label: `设置 · ${tab.label}`,
          group: '设置',
          action: {
            type: 'local',
            handler: () => {
              useShellStore.getState().requestSettingsTab(tab.id);
              useDockStore.getState().openPanel('settings');
            },
          },
        }),
      );
      return () => {
        for (const off of offs) off();
      };
    }, 'settings-tab-commands');
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default settingsPlugin;
