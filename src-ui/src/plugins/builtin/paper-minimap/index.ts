// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/paper-minimap — 画布小地图第一方插件（2026-09-05 插件化）。
//
// 背景：小地图原为 PaperPanel 硬编码内部组件（违背「内核只长通道、上层形态
// = 第一方插件」原则——创作坞/目次带已是 ctx.overlays 贡献行）。本插件把
// MinimapView 迁为独立贡献：
//   - 注册到 right-edge 槽（与目次带同槽——都是自由定位浮层，互不冲突）；
//   - 消费 PaperRegionContext / PaperDockContext（覆盖层上下文——数据真源
//     仍在纸壳，P2-3 缓存原样下发，平移帧零重画纪律不破）；
//   - 数据推导（minimapContent/minimapGeo/inkCache）留 PaperPanel（画布
//     状态所有者的缓存面），插件只拿渲染形态。
//
// 双走查形态（增补四同款）：bundle 兜底 + 产物域（dist-plugins/builtin/
// hologram/paper-minimap/，manifest displace 位移 bundle 行）。组件项目内
// 依赖经 './host' 取宿主共享真实例。
//
// 注册纪律：disposer 经 ctx.effect 登记；装载在 overlayServicePlugin 之后
// （loadBuiltinPlugins 表序，inject 依赖可解析）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { MinimapView } from './MinimapView';

/** 小地图插件——right-edge 覆盖贡献。 */
export const paperMinimapPlugin = {
  name: 'hologram/paper-minimap',
  inject: ['overlays'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.overlays.register({
          id: 'paper-minimap',
          slot: 'right-edge',
          component: MinimapView,
        }),
      'paper-minimap',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default paperMinimapPlugin;
