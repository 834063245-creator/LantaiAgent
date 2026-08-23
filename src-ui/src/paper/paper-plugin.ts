// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// paper/paper-plugin — 纸壳第一方插件（V3b 壳装配；S3 补齐命令通道）。
//
// 挂载通道（paper-shell V3b：「纸壳视图经组合层挂载」）：纸面板从
// panel-def.ts 常量行迁为 PanelsService 贡献（composition/services.ts）——
// 面板/命令贡献走组合层通道，不自建旁路（paper-shell 计划「与组合层
// 计划的排程」第 3 条纪律）。这是 S3「第一方行化」在纸域的第一行：
// 重构推到哪个域，行化跟到哪个域。
//
// S3（2026-08-22）：补齐当年漏的半步——toggle-paper 动作从壳行 actions 迁
// 入 paper/toggle 命令贡献（与面板贡献同插件收口；快捷键链路经
// app/actions.ts 别名翻译层，useGlobalKeys 字面量不变）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约——
// 调用方负责所有权，见 services.ts 头注）；装载在四 service 之后
// （loadBuiltinPlugins 表序），ctx.panels 可解析。

import { PaperPanel } from '../app/panels/PaperPanel';
import type { Context } from '../cordis';
import { useDockStore } from '../state/dock-store';

/** 纸壳插件——面板贡献（即时生效语义）+ toggle 命令贡献（S3）。
 *  inject 声明是 cordis fiber 属性访问的前提（apply 内访问 ctx.panels
 *  必须先声明依赖——对齐 hello 插件的三通道写法）。 */
export const paperPlugin = {
  name: 'hologram/paper-shell',
  inject: ['panels', 'commands'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'paper',
          // side:null 全屏覆盖（走查弹用户拍板「可以遮主视图」沿用）；
          // unmountOnClose——关即卸载，重开重订真实会话。
          side: null,
          title: '纸',
          icon: 'file',
          unmountOnClose: true,
          component: PaperPanel,
        }),
      'paper-panel',
    );
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'paper/toggle',
          label: '纸视图（开/回案卷首页）',
          group: '面板',
          shortcut: 'ctrl P',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('paper') },
        }),
      'paper-command',
    );
  },
};
