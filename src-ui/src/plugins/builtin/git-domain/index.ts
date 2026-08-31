// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git-DomainPlugin 域内置插件 · 产物入口（增补二/增补四，first-party-hot-reload-plan）。
//
// 薄重导出形态：kind=feature 全量通道化的结构收编——插件对象真源留
// bundle 域（coding-domain-plugins.ts，工具工厂经 rowCtx 注入装配期真值，
// 无产物内联副本），产物域经宿主桥取同一对象走磁盘通道装载 +
// manifest.displace 位移 bundle 兜底行（语义 = 同一插件的干净重注册，
// 工具面重载影响下次装配）。

import { gitDomainPlugin } from './host';
export default gitDomainPlugin;
