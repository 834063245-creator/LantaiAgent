// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugins/builtin/paper-shell — 纸壳第一方插件（V3b 壳装配；S3 补齐命令通道；
// 增补四通道化）。
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
// 双走查形态（增补四，first-party-hot-reload-plan）：本目录同时是
//   A. 编译期 bundle 域（BUILTIN_PLUGINS 表项——出厂兜底行）；
//   B. 构建产物域（esbuild → dist-plugins/builtin/hologram/paper-shell/
//      entry.js + entry.css——磁盘通道装载 + manifest.displace 位移
//      bundle 行；设置面板「重新加载」热替换）。
// PaperPanel/InkLayer/StatusLine 的项目内依赖经 './host' 取宿主共享
// 真实例（host.aliased.ts 为构建期替换面）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约——
// 调用方负责所有权，见 services.ts 头注）；装载在四 service 之后
// （loadBuiltinPlugins 表序），ctx.panels 可解析。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { clearMeasureImplementation, registerMeasureImplementation, useDockStore } from './host';
import { measureImplementation } from './measure-implementation';
import { PaperPanel } from './PaperPanel';

/** 纸壳插件——面板贡献（即时生效语义）+ toggle 命令贡献（S3）。
 *  inject 声明是 cordis fiber 属性访问的前提（apply 内访问 ctx.panels
 *  必须先声明依赖——对齐 hello 插件的三通道写法）。 */
export const paperPlugin = {
  name: 'hologram/paper-shell',
  inject: ['panels', 'commands'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    /* 批 9c-4b（2026-09-26）：测量引擎（measure.ts + type-tokens.ts）随本包 ⇒ 装载期把
     * 实现登记进内核接缝 `paper/measure-seam.ts`（内核读点 = paper/ink.ts 墨迹走查 +
     * state/messages-store.ts 切卷清态）。登记口经 `./host` 取用（产物域 = faceDeps 真实例；
     * 直连内核路径会被 esbuild 内联成副本 ⇒ 登记落副本、实机炸，见账本 §0.6）。
     * 对称释放：fiber dispose ⇒ 弹出本层登记（引擎缺席 = 纸面高度全崩，故本产物 required）。 */
    ctx.effect(() => {
      registerMeasureImplementation(measureImplementation);
      return () => clearMeasureImplementation();
    }, 'paper-measure-impl');
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
          slash: '/paper',
          kbd: 'ctrl P',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('paper') },
        }),
      'paper-command',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default paperPlugin;
