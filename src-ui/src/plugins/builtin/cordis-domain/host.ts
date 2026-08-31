// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// cordis-DomainPlugin 域插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// 薄重导出形态：插件对象真源在 bundle 域（coding-domain-plugins）——产物域
// 经宿主桥 mods.toolDomains 取同一对象（重载 = 同一插件的干净重注册）。
// 本文件在 tsc/vitest/bundle 域直连真源；esbuild 产物域重定向到 aliased。

export { cordisDomainPlugin } from '../../coding-domain-plugins';
