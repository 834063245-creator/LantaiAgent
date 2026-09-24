// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 目次带识别层（乙 · 用户拍板 F）守护 —— paper/toc-ink 纯层钉算法。
//
// 判据由实机 + 原型共同定档（prototype/toc-thumb-ab.html，规格书 §13）：
//   v2 的「每块首行一根 1.2px 细条 + 块级降级」在长卷里退化成等距点阵
//   （实机空行率 0.42–0.81 = 用户读作「滚动条」）；F = 桶聚合（形状/墨量/族色/错）
//   把空行率打到 0、墨覆盖 0.41→0.82。本文件把「桶该长什么样」钉住，
//   并留一条**差分断言**：同一份数据下，v2 规则（测试内就地复刻）达不到的覆盖，
//   新算法必须达到——谁把 v2 语义塞回模块，这条就红。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INK_FAIL, inkBarColorOf } from '../src/paper/ink';
import type { TocRange } from '../src/plugins/builtin/compose-dock/toc';
import {
  buildTocInkBuckets,
  TOC_INK_ALPHA_FLOOR,
  TOC_INK_BUCKET,
  type TocInkLine,
} from '../src/plugins/builtin/compose-dock/toc-ink';

/** 映射区（带高 528px）——夹具沿用 2026-09-14 的实机带（stripTop = 带体顶 +
 *  刻痕半高）；算法与刻位的绝对值无关，故本批（标题栏拆除、带体回屏顶）不改夹具数。 */
const RANGE: TocRange = { regionTop: 0, regionBottom: 4000, stripTop: 60, stripBottom: 588 };
const BAND = RANGE.stripBottom - RANGE.stripTop;

/** 夹具（按实机长卷的真实比例造）：40 块铺满整条带——块距 13.2px、块内行距
 *  1.1px（对应真机 30 世界px × ys≈0.005，即「行距远小于桶高」），块宽在
 *  560 / 120 间交替，第 8 块（宽块）报错。 */
const BLOCK_PITCH = 13.2;
const LINE_PITCH = BLOCK_PITCH / 12;
function volume(): TocInkLine[] {
  const out: TocInkLine[] = [];
  for (let i = 0; i < 40; i++) {
    const kind = i % 3 === 0 ? 'tool' : 'markdown';
    const err = i === 8;
    const w = i % 2 === 0 ? 560 : 120;
    for (let li = 0; li < 12; li++) {
      out.push({ rel: i * BLOCK_PITCH + li * LINE_PITCH, right: w, area: w, kind, err });
    }
  }
  return out;
}

/** v2 规则的就地复刻（差分断言用）：每块只画首行一根 1.2px 细条。 */
function v2Bars(lines: readonly TocInkLine[]): Array<{ top: number; h: number }> {
  const seen = new Set<number>();
  const bars: Array<{ top: number; h: number }> = [];
  for (const l of lines) {
    const blockKey = Math.floor(l.rel / BLOCK_PITCH);
    if (seen.has(blockKey)) continue;
    seen.add(blockKey);
    bars.push({ top: RANGE.stripTop + l.rel, h: 1.2 });
  }
  return bars;
}

describe('paper/toc-ink 桶聚合', () => {
  it('形状：桶内最宽行的右缘定宽，且定形行的 kind 定族色', () => {
    const lines: TocInkLine[] = [
      { rel: 1, right: 100, area: 100, kind: 'markdown', err: false },
      { rel: 2, right: 300, area: 300, kind: 'tool', err: false },
    ];
    const [b] = buildTocInkBuckets(lines, RANGE);
    expect(b.width).toBe(300); // 最宽行 = 剪影
    expect(b.kind).toBe('tool'); // 形状行定色（那根就是你眼睛看的那根）
    expect(b.top).toBe(RANGE.stripTop);
    expect(b.height).toBe(TOC_INK_BUCKET);
  });

  it('墨量：alpha 随桶内墨面积单调（宽块恒深于窄块）、最大桶 =1、下限 = floor', () => {
    const buckets = buildTocInkBuckets(volume(), RANGE);
    const wide = buckets.filter((b) => b.width === 560);
    const narrow = buckets.filter((b) => b.width === 120);
    expect(wide.length).toBeGreaterThan(0);
    expect(narrow.length).toBeGreaterThan(0);
    expect(Math.min(...wide.map((b) => b.alpha))).toBeGreaterThan(Math.max(...narrow.map((b) => b.alpha)));
    expect(Math.max(...buckets.map((b) => b.alpha))).toBe(1); // 最密桶恒 1（相对归一）
    expect(Math.min(...buckets.map((b) => b.alpha))).toBeGreaterThanOrEqual(TOC_INK_ALPHA_FLOOR);
  });

  it('错旗：桶内任一行报错 → 桶 err（且不影响墨量档——错靠 fail 短规，不靠深浅）', () => {
    const buckets = buildTocInkBuckets(volume(), RANGE);
    const errBuckets = buckets.filter((b) => b.err);
    expect(errBuckets.length).toBeGreaterThan(0);
    // 同宽的两类桶，alpha 只由面积决定（err 不参与深浅）
    const plain = buckets.find((b) => !b.err && b.width === 560);
    const errored = errBuckets.find((b) => b.width === 560);
    expect(plain).toBeDefined();
    expect(errored).toBeDefined();
    if (errored && plain) expect(errored.alpha).toBeCloseTo(plain.alpha, 6);
  });

  it('四通道判据（差分断言）：空行率 0 / 覆盖 ≥80% —— v2 的每块首行细条做不到', () => {
    const buckets = buildTocInkBuckets(volume(), RANGE);
    const covered = buckets.reduce((n, b) => n + b.height, 0);
    const rows = Math.floor(BAND / TOC_INK_BUCKET);
    // 新算法：桶条连续铺满（内容连续 → 空桶 0）
    expect(buckets.length).toBeGreaterThanOrEqual(rows * 0.9);
    expect(covered / BAND).toBeGreaterThanOrEqual(0.8);
    // v2 复刻：40 根 1.2px 细条 = 带高的 ~9%（这就是「点阵纹理/滚动条」的量化）
    const v2 = v2Bars(volume());
    expect(v2.reduce((n, b) => n + b.h, 0) / BAND).toBeLessThan(0.12);
  });

  it('几何界：所有桶落在 [stripTop, stripBottom] 内（不越界进书眉带/坞下装饰带），末桶夹紧', () => {
    const lines = volume();
    const buckets = buildTocInkBuckets(lines, RANGE);
    for (const b of buckets) {
      expect(b.top).toBeGreaterThanOrEqual(RANGE.stripTop);
      expect(b.top + b.height).toBeLessThanOrEqual(RANGE.stripBottom);
      expect(b.height).toBeLessThanOrEqual(TOC_INK_BUCKET);
      expect(b.height).toBeGreaterThan(0);
    }
    // 带外行（超出带底）不得产出桶——坞下装饰带无语义，不许着墨
    const outside: TocInkLine[] = [
      { rel: BAND + 12, right: 300, area: 300, kind: 'markdown', err: false },
      { rel: BAND + 40, right: 300, area: 300, kind: 'tool', err: true },
    ];
    expect(buildTocInkBuckets(outside, RANGE)).toHaveLength(0);
  });

  it('桶序：输入乱序也按竖向序出（绘制序 = 读数序）', () => {
    const lines = volume();
    const shuffled = [...lines.slice(20), ...lines.slice(0, 20)];
    const tops = buildTocInkBuckets(shuffled, RANGE).map((b) => b.top);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  });
});

/* ═══ 接线在册（组件确实走纯层；v2 的降级路径已拆）═══ */

const TOC_TSX = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'compose-dock', 'TocStrip.tsx'),
  'utf8',
);

describe('TocStrip 识别层接线', () => {
  it('走 buildTocInkBuckets + inkBarColorOf + INK_FAIL；DENSITY_BLOCKS 降级路径已拆', () => {
    expect(TOC_TSX).toContain('buildTocInkBuckets');
    expect(TOC_TSX).toContain('inkBarColorOf');
    expect(TOC_TSX).toContain('INK_FAIL');
    expect(TOC_TSX).not.toContain('DENSITY_BLOCKS');
  });

  it('错墨字面量镜像 tokens.css --fail；错不是族色（未知 kind 落墨阶，不落 fail）', () => {
    expect(INK_FAIL).toBe('#a9443f');
    expect(inkBarColorOf('nonexistent-kind')).not.toBe(INK_FAIL); // 错走语义状态，族色表不认它
    expect(inkBarColorOf('markdown')).toBe('rgba(38, 34, 28, 0.42)');
    expect(inkBarColorOf('tool')).toBe('rgba(58, 91, 122, 0.44)');
    expect(inkBarColorOf('user')).toBe('rgba(166, 58, 46, 0.58)');
  });
});
