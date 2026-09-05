// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// composition/asset-renderers — 资产块表现原语（WO-6/WO-8 + §2.9 补齐）的兼容薄壳。
//
// **P1 迁移（first-party-hot-reload-plan）**：资产渲染器组件本体（10 原语）已迁至
// `src-ui/src/plugins/builtin/renderers/components.tsx`（唯一真源），并随
// 「内置渲染器插件」（plugins/builtin/renderers/index.tsx）经 ctx.renderers
// 通道注册（BUILTIN_PLUGINS 表项，可热重载）。
//
// 本文件保留导出名（buildHtmlCardDocument / HTML_CARD_CAPABILITY /
// assetPresentationDefs）供既有引用方（测试 / 历史 import 面）零改动兼容：
//   - buildHtmlCardDocument / HTML_CARD_CAPABILITY：从新真源 re-export；
//   - assetPresentationDefs：**已退役**（renderer-service 不再构造期注册
//     资产行）——保留实现为从新真源取 10 组件组表（供需要者自建行）。
//
// 纪律（协议 §2.9）由新真源承载，此处只是转发壳，不重复实现。

export type { AssetRendererKind } from '../plugins/builtin/renderers/components';
export {
  assetRendererComponents,
  buildHtmlCardDocument,
  HTML_CARD_CAPABILITY,
} from '../plugins/builtin/renderers/components';

import type { ComponentType } from 'react';
import { assetRendererComponents } from '../plugins/builtin/renderers/components';
import type { BlockRendererContribution, BlockRendererProps } from './renderer-service';

/** 资产表现原语行表（WO-6 → P1 插件通道化后退役——保留给外部使用者自建行；
 *  runtime 不再主动调用，避免与渲染器插件行同 id 装载期冲突）。 */
export function assetPresentationDefs(): BlockRendererContribution[] {
  const components = assetRendererComponents();
  const kinds: Array<[string, ComponentType<BlockRendererProps>]> = [
    ['grid', components.grid],
    ['chart', components.chart],
    ['metric', components.metric],
    ['media', components.media],
    ['graph', components.graph],
    ['tree', components.tree],
    ['html', components.html],
    ['form', components.form],
    ['board', components.board],
    ['timeline', components.timeline],
  ];
  return kinds.map(([kind, component]) => ({ id: `builtin/${kind}`, kind: kind as never, component }));
}
