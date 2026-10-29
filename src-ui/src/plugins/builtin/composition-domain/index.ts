// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition 域插件 · 真源产物（创作者模式最小闭环，2026-10）。
//
// 贡献一条工具行 `composition`（list/read/validate/write），**defaultOff**：
// 标准/精简组合里模型看不到也调不到（最小权限——与 DSH 只把 plugin_manager
// 交给 cordis 创建者 preset 同构）；只有 `creator` preset 用 disabled:false 回开。
//
// 为什么不是内核常驻工具行：改组合 = 改模型自己看到的工具与提示面，
// 必须是一档**显式选择的模式**（用户拨到「创造者」才给它这双手）。
//
// 装载序：名册 buildOrder 表尾追加（前缀缓存/贡献注册序字节契约——新增一律加尾）。

import type { Context } from '../../../cordis';
import { createCompositionTool } from './composition';

/** 行 id（`plugin/` 前缀由 plugin-tool-rows 折算；preset 里写全名）。 */
export const COMPOSITION_TOOL_ROW = 'plugin/hologram/composition-domain/composition';

export const compositionDomainPlugin = {
  name: 'hologram/composition-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.tools.register({
        id: 'hologram/composition-domain/composition',
        // 默认关（S6 P1 语义）：登记但默认不进任何组合——creator preset 回开。
        defaultOff: true,
        factory: () => createCompositionTool(),
      });
      return () => dispose();
    }, 'composition-domain-tools');
  },
};

export { createCompositionTool } from './composition';
export default compositionDomainPlugin;
