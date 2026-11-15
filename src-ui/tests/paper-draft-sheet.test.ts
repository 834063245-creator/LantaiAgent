// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸（新卷出生面，2026-11-14 立项；**2026-11-15 V2 改判：纸即输入面，发送即开卷**）
// ——纯函数面判据。
// 设计件：docs/plans/canvas-space/new-session-ux.md §3.1 / §6.8 / §8
//
// 这一组钉的是「纸还没成立」这件事的**可测后果**，不是样式：
//   ① 落位与流区自动落位同一把尺子（否则开卷时纸会跳位）；
//   ② 纸高不再是常量（V2 把创作坞搬进纸里 ⇒ 高度随内容长，写死就是错的）；
//   ③ 失败状态词：发送被拒 ⇒ 纸脚可见原因（错误不静默）。

import { beforeEach, describe, expect, it } from 'vitest';
import { identityView } from '../src/paper/canvas-math';
import { nearestFreeRegion, STREAM_REGION } from '../src/paper/space';
import * as draftSheetModule from '../src/plugins/builtin/paper-shell/draft-sheet';
import { draftBodyState, draftPlacement, draftScale } from '../src/plugins/builtin/paper-shell/draft-sheet';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

const PANEL = 'draft-panel';

describe('待题纸（V2 纯函数面）', () => {
  beforeEach(() => {
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  it('纸高不是常量（V2：输入面搬进纸里 ⇒ 高度随内容长，写死必错）', () => {
    // 钉住 V1 的尸体：DRAFT_BODY_H 是「三行题签」的算术，输入面进来后它没有意义。
    expect('DRAFT_BODY_H' in draftSheetModule).toBe(false);
  });

  it('落位与流区自动落位同一把尺子（空画布 = 视口中心）', () => {
    const core = { panelId: PANEL };
    const spot = draftPlacement(core);
    const v = useCanvasViewStore.getState();
    const expected = nearestFreeRegion([], v.canvasSize.w / 2, v.canvasSize.h / 2);
    expect(spot.anchorX).toBe(expected.anchorX);
    expect(spot.anchorY).toBe(expected.anchorY);
    expect(spot.width).toBe(STREAM_REGION.width);
  });

  it('落位避开已摊开的卷（最近空位，不是叠在上面）', () => {
    const canvas = getCanvasStore(PANEL).getState();
    canvas.ensureRegion('1', { anchorX: 800, anchorY: 450, width: STREAM_REGION.width });
    const spot = draftPlacement({ panelId: PANEL });
    // 已占区间 [800 ± 720] + 120 缓冲 ⇒ 新位必须落在区间外
    const halfOccupied = STREAM_REGION.width / 2 + STREAM_REGION.gap;
    expect(Math.abs(spot.anchorX - 800)).toBeGreaterThanOrEqual(halfOccupied);
  });

  it('发送被拒 = 状态词可见（错误不静默）；无原因 = ready', () => {
    expect(draftBodyState(null)).toBe('ready');
    expect(draftBodyState('组合不在册')).toBe('rejected');
  });

  it('玉徽缩比夹在 [0.72, 1]（窄纸不放大图标）', () => {
    expect(draftScale(STREAM_REGION.width)).toBe(1);
    expect(draftScale(STREAM_REGION.width * 2)).toBe(1);
    expect(draftScale(720)).toBeGreaterThanOrEqual(0.72);
  });
});
