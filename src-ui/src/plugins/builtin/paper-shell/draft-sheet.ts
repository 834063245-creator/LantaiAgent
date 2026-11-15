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

import {
  getCanvasStore,
  nearestFreeRegion,
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
