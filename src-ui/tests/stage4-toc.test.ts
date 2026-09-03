// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-4 §4.4 目次带纯几何 v2（minimap 换血）：线性映射 / 滑块数学
// （grab offset scrub、点外即跳、fit 全高）/ 语义标记派生 / 未读区 /
// 视口指示 / 阶段导航锚（stream-rhythm 刀4：消费工作单元）。

import { describe, expect, it } from 'vitest';
import {
  buildStageAnchors,
  computeSlider,
  deriveMarks,
  grabOffsetAt,
  jumpViewTopAt,
  nearestAnchorAt,
  type StageUnitInput,
  scrubViewTop,
  stripToWorld,
  type TocMarkInput,
  type TocRange,
  tocMapper,
  unreadBand,
  viewportMarker,
} from '../src/paper/toc';

const RANGE: TocRange = {
  regionTop: -1000,
  regionBottom: 0,
  stripTop: 80,
  stripBottom: 480,
};
// 尺度：1000 世界 → 400 带像素，scale = 0.4

describe('paper/toc 线性映射', () => {
  it('tocMapper：新块（y 大）靠下，旧块靠上', () => {
    const map = tocMapper(RANGE);
    expect(map(0)).toBe(480); // 最新块底 → 带底
    expect(map(-1000)).toBe(80); // 最旧块顶 → 带顶
    expect(map(-500)).toBe(280); // 中点
  });

  it('stripToWorld：tocMapper 的逆（往返恒等）', () => {
    const inv = stripToWorld(RANGE);
    expect(inv(80)).toBe(-1000);
    expect(inv(480)).toBe(0);
    expect(inv(280)).toBe(-500);
    const map = tocMapper(RANGE);
    expect(inv(map(-734.5))).toBeCloseTo(-734.5, 6);
  });

  it('零跨度流区不炸（映射钳制）', () => {
    const map = tocMapper({ ...RANGE, regionTop: 0, regionBottom: 0 });
    expect(map(0)).toBe(80);
  });
});

describe('paper/toc computeSlider（VSCode 语义滑块）', () => {
  it('内容超视口：按比例定位定高，可拖', () => {
    // 视口 400 世界 → 滑块 160px；视口顶 -600 → top 240
    const s = computeSlider(RANGE, -600, -200);
    expect(s.draggable).toBe(true);
    expect(s.height).toBeCloseTo(160, 6);
    expect(s.top).toBeCloseTo(240, 6);
  });

  it('内容不满一屏：全高滑块（fit），不可拖', () => {
    const s = computeSlider(RANGE, -1200, 0);
    expect(s.draggable).toBe(false);
    expect(s.top).toBe(80);
    expect(s.height).toBe(400);
  });

  it('视口越出内容上界：滑块 clamp 在带顶', () => {
    const s = computeSlider(RANGE, -1500, -1100);
    expect(s.top).toBe(80);
    expect(s.height).toBeCloseTo(160, 6);
  });

  it('视口越出内容下界：滑块 clamp 在带底', () => {
    const s = computeSlider(RANGE, -100, 300);
    expect(s.top).toBe(320); // 480 - 160
  });
});

describe('paper/toc jumpViewTopAt（点带外即跳：点击点对视口中心）', () => {
  it('点击点的世界 y 成为视口中心', () => {
    // stripY=280 → world -500 → 视口顶 = -500 - 400/2 = -700
    expect(jumpViewTopAt(280, RANGE, 400)).toBe(-700);
  });

  it('落点 clamp 在内容域（拖不过头）', () => {
    // 顶部点击：world -1000 → -1200 → clamp 到 regionTop
    expect(jumpViewTopAt(80, RANGE, 400)).toBe(-1000);
    // 底部点击：world 0 → -200，超上限（regionBottom - viewH = -400）→ clamp
    expect(jumpViewTopAt(480, RANGE, 400)).toBe(-400);
  });
});

describe('paper/toc scrubViewTop（grab offset 拖拽）', () => {
  const slider = computeSlider(RANGE, -600, -200); // top 240, height 160

  it('grabOffsetAt：指针相对滑块顶，clamp 在滑块内', () => {
    expect(grabOffsetAt(300, slider)).toBe(60);
    expect(grabOffsetAt(100, slider)).toBe(0);
    expect(grabOffsetAt(500, slider)).toBe(160);
  });

  it('拖拽往返恒等：同一指针位置还原同一视口顶', () => {
    const offset = grabOffsetAt(300, slider);
    expect(scrubViewTop(300, offset, RANGE, 400)).toBe(-600);
  });

  it('拖到带顶/带底：视口顶 clamp 在内容域两端', () => {
    expect(scrubViewTop(80, 0, RANGE, 400)).toBe(-1000);
    expect(scrubViewTop(480, 160, RANGE, 400)).toBe(-400); // regionBottom - viewH
  });

  it('内容不满一屏：拖拽失效（恒回内容顶）', () => {
    expect(scrubViewTop(300, 60, RANGE, 1200)).toBe(-1000);
  });
});

describe('paper/toc deriveMarks（语义刻痕）', () => {
  const inputs: TocMarkInput[] = [
    { id: 'u1', kind: 'user', worldY: -900, worldH: 60, preview: '第一条来文' },
    { id: 'a1', kind: 'markdown', worldY: -700, worldH: 120, preview: '正文不上刻痕' },
    { id: 't1', kind: 'tool', status: 'done', worldY: -560, worldH: 40 },
    { id: 't2', kind: 'tool', status: 'error', worldY: -500, worldH: 40 },
    { id: 'g1', kind: 'toolgroup', status: 'error', worldY: -440, worldH: 30 },
    { id: 'g2', kind: 'subagent', status: 'done', worldY: -390, worldH: 30 },
    { id: 'p1', kind: 'plan', worldY: -340, worldH: 80 },
    { id: 'te1', kind: 'turn-error', level: 'error', worldY: -240, worldH: 20 },
    { id: 'n1', kind: 'notice', level: 'info', worldY: -200, worldH: 20 },
    { id: 'n2', kind: 'notice', level: 'error', worldY: -160, worldH: 20 },
    { id: 'r1', kind: 'reasoning', worldY: -120, worldH: 100 },
  ];
  const marks = deriveMarks(inputs, RANGE);
  const byId = new Map(marks.map((m) => [m.blockId, m]));

  it('判定表：user/tool/plan/error 各归其位，正文类不上刻痕', () => {
    expect(byId.get('u1')?.kind).toBe('user');
    expect(byId.get('t1')?.kind).toBe('tool');
    expect(byId.get('t2')?.kind).toBe('error');
    expect(byId.get('g1')?.kind).toBe('error'); // 组子项聚合
    expect(byId.get('g2')?.kind).toBe('tool');
    expect(byId.get('p1')?.kind).toBe('plan');
    expect(byId.get('te1')?.kind).toBe('error'); // 回合错误墓碑
    expect(byId.get('n2')?.kind).toBe('error'); // notice 仅 error 级
    expect(byId.has('a1')).toBe(false);
    expect(byId.has('n1')).toBe(false);
    expect(byId.has('r1')).toBe(false);
  });

  it('stripY 取块顶，worldY 取块中心（跳转落点居中）', () => {
    expect(byId.get('u1')?.stripY).toBeCloseTo(120, 6); // map(-900)
    expect(byId.get('u1')?.worldY).toBe(-870);
  });
});

describe('paper/toc unreadBand（未读区）', () => {
  it('上次读位落后内容底 → 淡朱区间', () => {
    const band = unreadBand(-400, RANGE);
    expect(band?.top).toBeCloseTo(320, 6); // map(-400)
    expect(band?.height).toBeCloseTo(160, 6); // map(0) - map(-400)
  });

  it('读位在内容顶之前 → 整段都是未读', () => {
    const band = unreadBand(-1500, RANGE);
    expect(band?.top).toBe(80);
    expect(band?.height).toBe(400);
  });

  it('已读到内容底 → null', () => {
    expect(unreadBand(0, RANGE)).toBeNull();
    expect(unreadBand(50, RANGE)).toBeNull();
  });
});

describe('paper/toc buildStageAnchors（阶段导航锚，stream-rhythm 刀4：消费工作单元）', () => {
  const units: StageUnitInput[] = [
    { unitId: 'u:u1', kind: 'user', blockId: 'u1', worldY: -900, worldH: 60, preview: '第一条来文' },
    { unitId: 'u:a1', kind: 'work', blockId: 'a1', worldY: -700, worldH: 120, preview: '工作单元不上锚' },
    { unitId: 'u:u2', kind: 'user', blockId: 'u2', worldY: -200, worldH: 60, preview: '第二条来文' },
  ];

  it('只取 user 单元，按序编号（stageIndex）+ 块中心映射', () => {
    const anchors = buildStageAnchors(units, RANGE);
    expect(anchors.map((a) => a.blockId)).toEqual(['u1', 'u2']);
    expect(anchors.map((a) => a.stageIndex)).toEqual([1, 2]);
    expect(anchors.map((a) => a.unitId)).toEqual(['u:u1', 'u:u2']);
    // u1 中心 worldY=-870 → (-870+1000)/1000*400+80 = 132
    expect(anchors[0]!.stripY).toBeCloseTo(132, 2);
    // u2 中心 worldY=-170 → 412
    expect(anchors[1]!.stripY).toBeCloseTo(412, 2);
    expect(anchors[1]!.preview).toBe('第二条来文');
  });

  it('无 user 单元 → 空锚点；空预览回退阶段序', () => {
    const none = buildStageAnchors(
      [{ unitId: 'u:a1', kind: 'work', blockId: 'a1', worldY: -100, worldH: 10, preview: 'x' }],
      RANGE,
    );
    expect(none).toEqual([]);
    const empty = buildStageAnchors([{ unitId: 'u:u9', kind: 'user', blockId: 'u9', worldY: -100, worldH: 10 }], RANGE);
    expect(empty[0]!.preview).toBe('阶段 1');
  });
});

describe('paper/toc nearestAnchorAt（hover 反查，泛型锚面）', () => {
  const anchors = buildStageAnchors(
    [
      { unitId: 'u:u1', kind: 'user', blockId: 'u1', worldY: -900, worldH: 60, preview: '一' },
      { unitId: 'u:u2', kind: 'user', blockId: 'u2', worldY: -200, worldH: 60, preview: '二' },
    ],
    RANGE,
  );

  it('取最近的阶段锚点', () => {
    expect(nearestAnchorAt(100, anchors)?.blockId).toBe('u1');
    expect(nearestAnchorAt(300, anchors)?.blockId).toBe('u2');
    expect(nearestAnchorAt(500, anchors)?.blockId).toBe('u2'); // 超出取最末
  });

  it('空锚点 → null', () => {
    expect(nearestAnchorAt(100, [])).toBeNull();
  });
});

describe('paper/toc viewportMarker（位置指示）', () => {
  it('视口区间与流区内容求交 → 带上的区间', () => {
    const marker = viewportMarker(-600, -200, RANGE);
    expect(marker).not.toBeNull();
    // -600 → 240, -200 → 400
    expect(marker!.top).toBeCloseTo(240, 2);
    expect(marker!.bottom).toBeCloseTo(400, 2);
  });

  it('视口在流区内容之外 → null（不显示指示）', () => {
    expect(viewportMarker(100, 500, RANGE)).toBeNull();
    expect(viewportMarker(-2000, -1500, RANGE)).toBeNull();
  });
});
