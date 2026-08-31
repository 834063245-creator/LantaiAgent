// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// capability-segments 段贡献插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// 薄重导出形态：插件对象真源留 bundle 域；本文件在 tsc/vitest/bundle 域
// 直连真源；esbuild 产物域重定向到 aliased。

export { capabilitySegmentsPlugin } from '../../capability-segments-plugin';
