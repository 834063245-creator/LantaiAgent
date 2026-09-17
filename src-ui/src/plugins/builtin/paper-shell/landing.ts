// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// landing — 「落位 / 回锚」的 pan 算式（插件域纯函数；2026-09-17 回锚认卷批）。
//
// **为什么算式落在插件域而不是 paper/canvas-math**：`canvas-math` 属**壳域**
// （产物域经宿主桥 `mods.faceDeps` 取它），改它必须重建 exe；本批要能「只换产物
// 热更」（同日交付路径的两个坑见 docs/landmine-map.md 第九批 H1/H2）。壳域那份旧
// `viewForAnchor(w,h)`（只收视口宽高、只会按世界原点落锚）已随本批**作为死抽象删除**：
// 落位语义此后只在**这里**一处实现，`tests/paper-landing.test.ts` 按字面期望钉住它。
//
// 语义（D-R1-3 流锚甲）：屏幕锚位 = 视口水平居中 + 下缘上方 margin；
// `pan = 屏幕锚位 − 锚点 × zoom`。
//
// ⚠ **锚点必须是卷锚**（活跃卷的 `RegionAnchor` = 该卷最新块底边，流向上长）：
// 拿世界原点当锚 = 用户 2026-09-17 报的「点开工作区 / 按回锚就空白，啥也不渲染」
// ——卷锚随内容往上漂（用户三卷实测 ≈ -28,700），按原点落锚就把视口停在卷外
// 28,700px 的空白桌面上（CDP 实测：Home 之后视口世界区间 [-2045, 151]，块数 0）。
export function panForAnchor(
  viewport: { w: number; h: number },
  zoom: number,
  anchor: { x: number; y: number },
  screenBottomMargin: number,
): { panX: number; panY: number } {
  return {
    panX: viewport.w / 2 - anchor.x * zoom,
    panY: viewport.h - screenBottomMargin - anchor.y * zoom,
  };
}
