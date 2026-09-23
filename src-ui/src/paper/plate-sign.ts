// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/plate-sign — **物类签**（图版签）语汇的宿主真源（2026-09-23 图版架批上移）。
//
// 来路：本表原在 `plugins/builtin/renderers/components.tsx`（B 图版签主干，
// 2026-09-17，随 pplate 题签行一起落地）。图版架批起消费面从一变为三：
//   ① 图版卡的题签行（渲染器——原消费面，改为取用本模块）；
//   ② 流内图版卡的**折叠行**（`paper/fold.ts` 的 foldLabel）——折叠行要出「签 + 题名」，
//      而 fold 在宿主层，**不能**反向 import 插件产物（宿主 → 插件是反向依赖）；
//   ③ **架上签条**（`plugins/builtin/compose-dock/AssetRack.tsx`）。
// 故上移宿主层做单一真源：两侧各自 import（相对 import = esbuild 内联，纯常量表
// 无实例身份，同 `paper-shell/dock-tether.ts` 取 `paper/measure` 的先例）。
//
// 语汇纪律（沿用原头注）：物类签是**机器语汇**（图版的种类名，与文类签那套
// user/markdown/tool 并列、同属边缘字号制度）；未登记的开放 kind 回落「录」
// ——签恒在，不空着（图版无题名时至少还有这枚签）。

/** 物类签表：kind → 汉字（一字）。冻结常量表（模块级归属第 4 类：初始化后只读）。 */
const PLATE_SIGNS: Record<string, string> = {
  table: '表',
  chart: '图',
  metric: '卡',
  board: '板',
  timeline: '序',
  citation: '引',
  chem: '式',
  media: '图',
  file: '件',
  deps_impact: '谱',
  html: '页',
  confirm: '问',
};

/** 取 kind 的物类签（未知 kind 回落「录」——开放 kind 也有签，不空着）。 */
export function plateSignOf(kind: string): string {
  return PLATE_SIGNS[kind] ?? '录';
}
