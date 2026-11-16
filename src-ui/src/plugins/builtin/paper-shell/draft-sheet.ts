// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// draft-sheet — 待题纸的**纯函数面**（无 React、无 DOM）。
//
// 为什么单独成文件：落位/尺寸/状态词是「待题纸该怎么摆」的全部判据，组件只做渲染。
// 这样它可以被单测直接钉住，不必挂 React 树。
//
// 两处口径必须与流区一致（否则开卷时纸会「跳」到别的位置）：
//   ① 落位 = `nearestFreeRegion`（视口中心最近的空位——use-region-placement 同款）；
//   ② 宽度 = `STREAM_REGION.width`。
//
// ⚠ 2026-11-15 V2 改判：**纸高不再是常量**。V1 的 `DRAFT_BODY_H = 196` 是「三行题签」
// 那套的算术；V2 把创作坞整只搬进纸里，纸高随输入面长（输入多行、附件 rail、题签行
// 有无都会变）。故本文件只留「落点」与「宽度」，高度交给组件的实测回写
// （`anchorY` 是**纸的下缘**——纸以锚点为底线向上长，开卷后卷落在同一处）。
//
// 第三件（2026-11-16：「纸落下来，镜头跟着」）：落位本身只管**纸在世界的哪儿**，
// **不管用户此刻看不看得见**。落点 = 视口中心最近的**空位**，画布上卷一多，最近空位
// 就在视口之外——点「＋」之后纸落在屏外的某个空档，用户只看到画面纹丝不动，得自己
// 满画布找题签。故落位与聚焦必须**同拍**：`draftFocusPoint` 给出「纸盒竖直中线」那个
// 世界点，纸把它交给槽主人的 glideTo（`PaperDockContext` 的能力位）把镜头带过去。

import {
  EMPTY_REGION_CONTENT_H,
  getCanvasStore,
  nearestFreeRegion,
  REGION_FOOT_GAP,
  STREAM_REGION,
  type StreamRegionState,
  useCanvasViewStore,
  viewportCenterWorld,
} from './host';

/** 待题纸的最小能力位面（与 ChatCore 兼容；桩 core 只实现 panelId 也能测——
 *  能力位缺席 = 无读数、不炸纸面，与 FolioCompositionChip 同款纪律）。
 *
 *  V2：起卷/落位/覆盖这几件**整体搬去了 `ChatCore.openDraftVolume`**——发送那一刻
 *  一次落定（V1 把它们散在纸的组件里，是可选链静默失效的温床，见 draft-opening 头注）。
 *  本件因此只剩「我该画在哪个坐标系的哪一格」。 */
export interface DraftSheetCore {
  panelId: string;
  /* ── 多纸（2026-11-17）的两个能力位 ──────────────────────────────────
   * 纸之间换焦点要**同时**动两处：store 里的 focusedId（谁吃键盘 / 坞让不让位）
   * 与 input store 的 live 槽（谁拿到草稿）。前者是纸群的事，后者是输入的事——
   * 让纸自己去拼这两件事，就会在视图层长出第二条「换焦点」实现（第二批纸忘了其中
   * 一半的经典病灶）。故收成 core 的两个能力位，判据与写入都在 ChatCore 一处。
   * **缺席 = 只换 store 焦点**（测试/无核场景照常可用，纸面不炸）。 */
  /** 把焦点与输入交给某张纸（等同点它）。 */
  focusDraft?: (paperId: string) => void;
  /** 弃某张纸（不烧号、不落盘；同时把输入还给活跃卷）。 */
  dismissDraft?: (paperId: string) => void;
}

/** 落纸位置：与流区自动落位**同一把尺子**（视口中心最近的空位）。
 *  必须在 world 坐标里算——待题纸就在 world 单元里，开卷后卷落在同一处。 */
export function draftPlacement(core: DraftSheetCore): StreamRegionState {
  const canvas = getCanvasStore(core.panelId).getState();
  const v = useCanvasViewStore.getState();
  const center = viewportCenterWorld(v.view, v.canvasSize.w, v.canvasSize.h);
  const occupied = Object.entries(canvas.spread).map(([sessionId, r]) => ({
    sessionId,
    anchorX: r.anchorX,
    width: r.width,
  }));
  return { ...nearestFreeRegion(occupied, center.x, center.y), width: STREAM_REGION.width };
}

/** 落纸后的聚焦点（世界坐标）——**纸盒的竖直中线**那个点。
 *
 *  为什么不取锚点：锚点不是纸的几何中心。锚点 = 「最新块底边」，纸/卷盒底 = 锚点 +
 *  `REGION_FOOT_GAP`（纸脚留白，见 DraftSheet 的 boxBottom），盒再往上长一个盒高——
 *  把锚点对到视口正中，纸会整块偏到正中以下（实测量：800 高视口里纸顶被切掉 90px，
 *  「落下来了但没落准」）。
 *
 *  盒高缺省 = `EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP`（零块卷的最小盒高，与
 *  DraftSheet 的 regionMinH 同一把尺子）；落纸那一刻纸通常就是这个高，组件量到实测高
 *  就传进来。**纯世界几何**：算出来的是「世界里的哪一点」，把这一点对到视口正中是
 *  glideTo 的职责（屏幕换算只在槽主人那一处，本函数不碰视口状态）。
 *  ⚠ 只给**落纸**用；开卷时的定位仍走 `requestFocus`（活跃卷 = 最新块底边，语义不同）。 */
export function draftFocusPoint(
  anchor: { anchorX: number; anchorY: number },
  boxH: number = EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP,
): { x: number; y: number } {
  const boxBottom = anchor.anchorY + REGION_FOOT_GAP;
  return { x: anchor.anchorX, y: boxBottom - boxH / 2 };
}

/** 这张纸**整块在视口里**吗（纸盒四缘都落在画布矩形内）。
 *
 *  用途 = 落纸时决定**要不要动镜头**：已经在眼前就一动不动——视角是用户的，
 *  「任何自动动作都把 pan 拉回某处」在这条产品线上炸过（2026-09-01 视角抢夺修复；
 *  尺寸变化、模型下拉这些无关动作都曾把画布抢回锚点）。落纸同理：只有「用户按下
 *  ＋却看不见纸」这一种情形才配动镜头。
 *  纯函数（视口从入参进来），判据与 `volumeInSight` 同源（都是「盒投到屏幕后落在
 *  画布矩形里」），只是这里用的是**纸盒**而不是卷锚。 */
export function draftBoxInSight(
  anchor: { anchorX: number; anchorY: number; width: number },
  view: { zoom: number; panX: number; panY: number },
  canvasSize: { w: number; h: number },
  boxH: number = EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP,
): boolean {
  const boxBottom = anchor.anchorY + REGION_FOOT_GAP;
  const boxTop = boxBottom - boxH;
  const x0 = (anchor.anchorX - anchor.width / 2) * view.zoom + view.panX;
  const x1 = (anchor.anchorX + anchor.width / 2) * view.zoom + view.panX;
  const y0 = boxTop * view.zoom + view.panY;
  const y1 = boxBottom * view.zoom + view.panY;
  return x0 >= 0 && x1 <= canvasSize.w && y0 >= 0 && y1 <= canvasSize.h;
}

/** 纸面状态词（数据面）：notice = 上一次发送（= 开卷）被拒的原因。
 *  V2 去掉了 'opening'：起卷与发送是同一拍，中途没有「开卷中」这个可停的态
 *  ——发送后立刻进落墨（Agent 跑起来），纸也已经撤了。 */
export type DraftBodyState = 'ready' | 'rejected';

export function draftBodyState(notice: string | null): DraftBodyState {
  return notice ? 'rejected' : 'ready';
}

/** 玉徽缩比：纸宽可取 [720, 2160] 而玉徽恒 26px——窄纸里略缩，免得显得过大
 *  （只影响观感，不进高度契约）。 */
export function draftScale(width: number): number {
  return Math.min(1, Math.max(0.72, width / STREAM_REGION.width));
}
