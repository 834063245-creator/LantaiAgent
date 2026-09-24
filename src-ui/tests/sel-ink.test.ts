// SPDX-License-Identifier: MIT

// 划词朱线钉测（2026-09-02 视觉迭代）：行合并几何 + 手写路径确定性防回漂。
// 纸不动、只落墨——选区以手写朱笔下划线呈现（原生洗底在 .pp-region 内退役，
// 钉断言见 paper-visual-decisions.test.ts 同批增补）；此处锁 sel-ink.ts 纯函数契约：
//   - 同行碎片合并成线（跨行不并）、零尺寸碎片跳过
//   - 种子确定性：同选区恒同线（重排/重渲染不闪）、异文本异线
//   - 末行收笔挑钩（比末行 X 多出 11px 的尾巴——朱笔离纸）

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mergeSelectionLines, selInkPaths, selSeedOf } from '../src/plugins/builtin/paper-shell/sel-ink';

type R = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, right: number, bottom: number): R => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe('mergeSelectionLines', () => {
  it('同行的内联碎片合并成一条线（x 取并集）', () => {
    const lines = mergeSelectionLines([rect(100, 200, 180, 220), rect(200, 200, 300, 220)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].x0).toBe(100);
    expect(lines[0].x1).toBe(300);
  });

  it('跨行不并（垂直重叠不过半）', () => {
    const lines = mergeSelectionLines([rect(100, 200, 300, 220), rect(100, 222, 300, 242)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].y).toBeLessThan(lines[1].y);
  });

  it('零宽/零高碎片跳过；空输入空输出', () => {
    expect(mergeSelectionLines([rect(10, 10, 10, 20), rect(10, 10, 20, 10)])).toHaveLength(0);
    expect(mergeSelectionLines([])).toHaveLength(0);
  });

  it('基线落在行底上方（字脚位置）', () => {
    const lines = mergeSelectionLines([rect(0, 100, 400, 120)]);
    expect(lines[0].y).toBeGreaterThan(100);
    expect(lines[0].y).toBeLessThan(120);
  });
});

describe('selSeedOf / selInkPaths', () => {
  it('种子确定：同文本同种子，异文本异种子', () => {
    expect(selSeedOf('兰台划词')).toBe(selSeedOf('兰台划词'));
    expect(selSeedOf('兰台划词')).not.toBe(selSeedOf('兰台划词。'));
  });

  it('主笔与 echo 笔一一对应（浸墨双笔手法）', () => {
    const lines = mergeSelectionLines([rect(50, 50, 500, 70), rect(50, 72, 300, 92)]);
    const art = selInkPaths(lines, 42);
    expect(art.mains).toHaveLength(lines.length);
    expect(art.echoes).toHaveLength(lines.length);
    expect(art.mains[0].startsWith('M ')).toBe(true);
  });

  it('同种子恒同线（重排不闪）；异种子异线', () => {
    const lines = mergeSelectionLines([rect(50, 50, 600, 70)]);
    const a1 = selInkPaths(lines, 7);
    const a2 = selInkPaths(lines, 7);
    const b = selInkPaths(lines, 8);
    expect(a1).toEqual(a2);
    expect(a1.mains[0]).not.toBe(b.mains[0]);
  });

  it('末行收笔挑钩：末行主笔比行宽多出约 11px 尾巴（朱笔离纸），非末行不多出', () => {
    const lines = mergeSelectionLines([rect(50, 50, 500, 70), rect(50, 72, 400, 92)]);
    const art = selInkPaths(lines, 42);
    const endX = (d: string): number => {
      const nums = [...d.matchAll(/[MLQ] ([\d.]+) ([\d.]+)/g)];
      return Number(nums[nums.length - 1][1]);
    };
    expect(endX(art.mains[0])).toBeLessThanOrEqual(lines[0].x1);
    expect(endX(art.mains[1])).toBeGreaterThanOrEqual(lines[1].x1 + 10);
  });

  it('过窄行（<4px）不画线', () => {
    const lines = mergeSelectionLines([rect(50, 50, 53, 70)]);
    const art = selInkPaths(lines, 42);
    expect(art.mains).toHaveLength(0);
  });
});
