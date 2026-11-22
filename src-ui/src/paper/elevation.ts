// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布海拔 — 物理层次模型（2026-11-22 立项：docs/plans/paper-shell/canvas-depth-plan.md）。
//
// 一句话：**画布上的每件东西先回答「它离桌面多高」**。高度是模型，影与 z 是它的两个投影：
//   · 影：高度 × 光向（画法在 paper-base.css 的 .pp-elev，读 --h 与场景写的 --light-*）；
//   · z ：带底 + 带内拿起次序（本文件给带底，组件按拿起次序加 index）。
//
// 三条纪律（判例会杀人，别绕）：
//   ① **流内排印件无高度**：印在纸上的墨不挂 .pp-elev、不拿 --h（§11「万物皆浮」判例）。
//   ② **坞不在此表接线**：2026-11-22 用户定「坞不要动」——它是纸上的墨（transparent + 坞顶硬线），
//      不是桌上的板；dock 带先占位，等形态翻案再接线。
//   ③ **带号是目标态，不是现制**：现制所有纸 z 1、钉块 z 2、窗光 3、目次 5、坞 6、顶浮件 30、小地图 60。
//      把这些一次改到本表（P3）之前，**不得**只改一半——纸升到 100 而窗光仍 3 的话，光就跑到纸下面了。
//
// 影的数值不在本文件：那是**画法**（一条 CSS 配方），本文件只给高度与 z。两者由
// tests/paper-elevation.test.ts 分别钉住（表单调 + CSS 契约）。

/** 一个高度带：同带的东西同高，带内按拿起次序排 z。 */
export interface ElevationBand {
  /** 带底 z（同带内第 index 件 = z + index；上限 = 下一带 z − 1） */
  z: number;
  /** 静置高度（显示 px，1x；影的输入） */
  height: number;
  /** 拿起高度（点/拖中） */
  lifted: number;
}

/**
 * 全画布的高度梯（目标态）。**声明顺序 = 层序**（desk 最低、overlay 最高），
 * 测试按此顺序断言带序递增。全局面板/模态仍走 tokens.css 的 280+ —— 那是纸壳外的另一张表。
 */
export const ELEVATION = {
  /** 桌面本体（.pp-desk） */
  desk: { z: 0, height: 0, lifted: 0 },
  /** 纸：流区纸、待题纸（带内 900 个位置，100 卷场景不溢出） */
  sheet: { z: 100, height: 3, lifted: 14 },
  /** 纸片件：钉住的块、纸条、签、卡（离开流、躺在纸上） */
  piece: { z: 1000, height: 5, lifted: 9 },
  /** 环境：云影 / 窗光 / 辉光（盖在纸上，不参与拿起） */
  environment: { z: 3000, height: 0, lifted: 0 },
  /** 纸面覆盖层：引线 / 朱线选区 / lift 遮罩（画在纸上，不参与拿起；在环境之上、架件之下） */
  paperOverlay: { z: 3050, height: 0, lifted: 0 },
  /** 架件：目次带、顶浮件、小地图（钉在架上，影子落纸上） */
  furniture: { z: 3100, height: 12, lifted: 12 },
  /** 坞：**占位**——2026-11-22「坞不要动」，本带暂不接线 */
  dock: { z: 3200, height: 20, lifted: 20 },
  /** 画布内面板 / 浮层（画布坐标里弹出的菜单、面板） */
  panel: { z: 3300, height: 32, lifted: 32 },
  /** 瞬时件：拖拽幽灵 / 下拉 / 斜杠面板（下一次交互就消失，不参与上下判读） */
  overlay: { z: 4000, height: 0, lifted: 0 },
} as const satisfies Record<string, ElevationBand>;

export type ElevationBandId = keyof typeof ELEVATION;

/** 层序（声明顺序即真源；测试与诊断读它，不另抄一份）。 */
export const BAND_ORDER = Object.keys(ELEVATION) as readonly ElevationBandId[];

/** 本带能用的 index 上限：下一带 z − 本带 z − 1（末带给 899 的余量）。 */
function capOf(band: ElevationBandId): number {
  const i = BAND_ORDER.indexOf(band);
  const next = i >= 0 ? ELEVATION[BAND_ORDER[i + 1]] : undefined;
  if (!next) return 899;
  return Math.max(0, next.z - ELEVATION[band].z - 1);
}

/** 带内第 index 件的 z（0 = 带底；越界夹回，绝不顶进下一带）。 */
export function zOf(band: ElevationBandId, index = 0): number {
  const base = ELEVATION[band].z;
  const cap = capOf(band);
  const safe = Number.isFinite(index) ? Math.max(0, Math.min(cap, Math.trunc(index))) : 0;
  return base + safe;
}

/** 静置 / 拿起的高度（拿起档不许低于静置——表坏了就夹回去，不让影倒挂）。 */
export function heightOf(band: ElevationBandId, lifted = false): number {
  const spec = ELEVATION[band];
  return lifted ? Math.max(spec.height, spec.lifted) : spec.height;
}
