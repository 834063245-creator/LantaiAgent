// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dock-tether — 匣脚引线（2026-09-22）：**创作坞的版口钮 → 活卷的纸脚**的几何纯面。
//
// 病灶（用户，两轮）：① 「多会话卷的激活态一直没做好」——活卷那点信号全在纸上，而创作坞
// （浮在画布上的匣）与纸上任何一卷之间**没有任何可见联系**：坞自 2026-09-17 浮动化之后
// 两边各自在屏上走，「坞报的这个卷名指哪一张纸」只能靠读者自己连线。
// ② 一版落地后用户当场打回卷端落点：「你这个引线能挂在页尾吗……你挂在第一条用户输入
// 那不是乱了套了」——一版把卷端接在**卷首规线左端那枚版口钮**上，而那枚钮正好压在
// 标题块与**第一条来文**的接缝上：线读起来像在指第一条来文（**天头那枚钮是「哪一卷
// 活跃」的标记，不是「这一卷在哪儿」的位置标记**——两者不是一回事，一版把它们混为一谈）。
//
// 治法（二版定案）：
//   · **坞端** = 坞顶左端那枚**版口钮**（坞壳上那条 56×3 朱短横，全坞唯一暖色件）——
//     匣口即坞的「这一件」标记，锚在既有实体上，不新造；
//   · **卷端** = 活卷的**纸脚**（版心左缘 × 卷底边）——与枝边那条腿同族：**扎在纸自身的
//     材料缘上**（那里是受光/背光缘与裱边带交汇的纸边，不是任何一块字）。选纸脚而不是
//     天头，三条各记理由：① 纸脚是「这一卷写到哪儿」的那一端（卷轴锚线 = 最新块底边，
//     纸脚再低一个底距），读者与坞平常都挨着它；② 天头那枚钮已被「活跃标记」征用
//     （红在哪卷即活卷），再让它兼位置标记就会与第一条来文抢读；③ 卷首常年在屏外
//     （人在读尾），线会长期指向屏幕外的一方；纸脚则在读尾时就在坞上方几十像素。
//
// 本层只做**锚点派生**（零 DOM 零 store，同 selection.ts 纪律）；其余都在既有单一真源：
//   · 坞侧锚 = `composer-float.composerAnchorOf`（屏幕坐标；坞位与实测尺寸在槽主人手里）；
//   · 卷侧锚 = 本文件 `regionFootAnchorOf`（世界坐标 → 调用方 `worldToScreen` 落墨）；
//   · 笔 = `paper/provenance` 同一支笔（「版口引线批」补全的锚面外法向：两端锚面一个在
//     匣顶线、一个在卷底边，法向竖直）。
//
// 常显（结构不是瞬时手势，同枝边那条腿）+ **纯指示·不可点**——线不是控件。
//
// **归因更正（2026-09-24）**：本线落地时被做成可点（透明受墨带 → 点线飞到线的那一头
// ＝本卷纸脚），账上记为「同日拍板 可点溯源」；用户 2026-09-24 否认：「我从来也没有拍板过
// 引线本体要做成按钮」。受墨带 / role=button / tabIndex / 点击同批摘除，本文件随之不再
// 有消费面（无活卷 / 案头态 ⇒ 不画线；线只指示「这一匣对着这一卷」）。订正见
// `docs/plans/paper-shell/taste-ledger.md` 同日条。

import { folioHeadWidthFor } from '../../../paper/measure';
import { TETHER_SPLINE_MIN, type TetherPen } from './provenance';

/** 引线种子前缀（seed 取 `版口-<卷号>`）：**同卷恒同线**，重渲染/平移不闪——与
 *  `selSeedOf` 的定种子纪律同款；切卷即换种子，新线走 `pp-tether-in` 淡入。 */
export const DOCK_TETHER_SEED = 'dock-tether';

/** 引线的笔：两端**锚面外法向**是常量（按锚面定，不按相对方位现算）——坞的版口钮挂在
 *  **匣顶线**上 ⇒ 线朝上出笔；卷端落在**卷底边**上 ⇒ 线自下方到站。
 *  ＋臂长下限（`TETHER_SPLINE_MIN`）：两端近乎同高那一档沿法向净空趋零，没有下限笔道
 *  就贴着弦退化成一条直线（几何见 paper/provenance.ts「版口引线批」）。 */
export const DOCK_TETHER_PEN: TetherPen = {
  normals: { from: { x: 0, y: -1 }, to: { x: 0, y: 1 } },
  minArm: TETHER_SPLINE_MIN,
};

/** **卷侧锚点**（世界坐标）：活卷的**纸脚**——（版心左缘, 卷底边）。
 *
 *  - 版心左缘 = `regionLeft + (width − 版心宽) / 2`，版心宽走 `measure.folioHeadWidthFor`
 *    （**单一真源**：左右内距 16×2 与版心封顶 720 都在那一式里——调用点禁手写
 *    `width − 32`；本式与 `16 + (width − 32 − 版心宽) / 2` 恒等）。选版心左缘而不是
 *    纸的左缘：坞端那枚钮也在坞自己的版心左缘（坞身 880 版心 = 它的盒宽）——**版口对
 *    版口**，默认位（两厢都居中）下这条线近乎垂直。
 *  - 卷底边（纸脚）= `regionTop + regionHeight`——**纸的材料底缘**（受光/背光缘与裱边带
 *    交汇处），落点因此扎在纸上而不落在任何一块字上；它比卷轴锚线（最新块底边）低一个
 *    底距，正是「墨将落此处」下方那段留白。 */
export function regionFootAnchorOf(region: {
  anchorX: number;
  width: number;
  regionTop: number;
  regionHeight: number;
}): { x: number; y: number } {
  const regionLeft = region.anchorX - region.width / 2;
  return {
    x: regionLeft + (region.width - folioHeadWidthFor(region.width)) / 2,
    y: region.regionTop + region.regionHeight,
  };
}
