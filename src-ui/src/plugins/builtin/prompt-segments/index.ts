// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// prompt-segments 内置插件 · 产物入口（增补二/增补四，first-party-hot-reload-plan）。
// 薄重导出形态：插件对象真源留 bundle 域（段定义是 convergence 字节契约
// 面，不随产物内联）；产物域经宿主桥取同一对象走磁盘通道装载 +
// manifest.displace 位移 bundle 兜底行。

import { promptSegmentsPlugin } from './host';
export default promptSegmentsPlugin;
