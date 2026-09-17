// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// graph 几何（2026-09-17 盒定比例批）——与 chart 同治法：
//   宽 = 版心宽（用户单位 == CSS px ⇒ 文字不被 viewBox 缩放）；
//   节点框宽 = 标签实测宽（长标签截断 + 全名进 <title>）；图高只随行数变。
//
// 旧实现的可证伪事实（原型读数 prototype/asset-cards-ab.NOTES.md）：
//   节点框恒 72×28（rx=0），长标签 293.6px = **4.08 倍框宽**、实渲溢出 291.5px；
//   列宽恒 160、viewBox 随层数变，配 CSS width:100%/height:auto/max-height:360
//   ⇒ 图被 meet 缩放（2 层 3 行时 10px 字被放大到约 19px）。
// 本组断言在旧实现下全部为假。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { ASSET_DERIVED } from '../src/paper/type-tokens';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { fitGraphLabel, graphLabelPx, graphLayout } from '../src/plugins/builtin/renderers/components';

const BOX = 720;
const LONG = 'src/app/chat/session-composition.ts#createSessionWithPreset';

function layoutOf(labels: string[], pos: Array<[string, number, number]>, cols: number, rows: number) {
  const m = new Map(pos.map(([id, x, y]) => [id, { x, y }]));
  return graphLayout({ pos: m, cols, rows, labels, boxW: BOX });
}

describe('graph 盒定比例 — 宽由版心定、框由标签定', () => {
  it('viewBox 宽 == 卡片内容宽（用户单位 == CSS px ⇒ 文字不被缩放）', () => {
    const L = layoutOf(['a', 'b'], [['a', 0, 0]], 2, 1);
    expect(L.viewW).toBe(BOX);
  });

  it('图高只随行数变（与列数无关）', () => {
    const one = layoutOf(['a'], [['a', 0, 0]], 5, 1);
    const two = layoutOf(
      ['a', 'b'],
      [
        ['a', 0, 0],
        ['b', 0, 1],
      ],
      2,
      2,
    );
    expect(two.viewH).toBeGreaterThan(one.viewH);
    expect(one.viewH).toBe(ASSET_DERIVED.graphViewH(1));
    expect(two.viewH).toBe(ASSET_DERIVED.graphViewH(2));
  });

  it('列宽按版心反推：层数少 → 列更宽（不再固定 160 后居中缩放）', () => {
    const few = layoutOf(['a'], [['a', 0, 0]], 1, 1);
    const many = layoutOf(['a'], [['a', 0, 0]], 4, 1);
    expect(few.colW).toBeGreaterThan(many.colW);
    expect(few.colW).toBeGreaterThan(160);
    // 最后一列的中心仍在版心内
    const c = few.at(0, 0);
    expect(c.cx).toBeLessThanOrEqual(BOX);
    expect(c.cx).toBeGreaterThan(0);
  });

  it('长标签：框跟着标签长；被列宽夹住时截断到框内（省略号）', () => {
    const shortL = layoutOf(['fix'], [['a', 0, 0]], 1, 1);
    const longL = layoutOf([LONG], [['a', 0, 0]], 1, 1);
    expect(longL.boxW).toBeGreaterThan(shortL.boxW); // 框跟着标签长（宽松布局不截断）
    expect(fitGraphLabel(LONG, longL.boxW - 20).truncated).toBe(false);

    // 列宽把框夹住时（4 列 → 列宽 170 → 框 158）才截断，且截断后落在框内
    const cramped = layoutOf([LONG], [['a', 0, 0]], 4, 1);
    expect(cramped.boxW).toBeLessThan(longL.boxW);
    const fitted = fitGraphLabel(LONG, cramped.boxW - 20);
    expect(fitted.truncated).toBe(true);
    expect(fitted.text.endsWith('…')).toBe(true);
    // 框与文共用同一把尺 ⇒ 构造性不溢出
    expect(graphLabelPx(fitted.text)).toBeLessThanOrEqual(cramped.boxW - 20 + 1e-9);
  });

  it('短标签不截断（不无谓加省略号）', () => {
    expect(fitGraphLabel('fix', 100)).toEqual({ text: 'fix', truncated: false });
  });

  it('估宽把 CJK 按全角算（保守方向：估高不估低）', () => {
    expect(graphLabelPx('中')).toBeGreaterThan(graphLabelPx('a'));
    expect(graphLabelPx('中')).toBeCloseTo(10, 5); // 1em × 10px
  });

  it('极端窄卡片：框宽不小于下限，且不超出绘图区', () => {
    const L = graphLayout({ pos: new Map([['a', { x: 0, y: 0 }]]), cols: 1, rows: 1, labels: [LONG], boxW: 240 });
    expect(L.boxW).toBeGreaterThanOrEqual(72);
    expect(L.boxW).toBeLessThanOrEqual(240);
  });
});

describe('graph SSR 渲染面', () => {
  async function renderGraph(payload: unknown): Promise<string> {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const f2 = ctx.plugin(rendererServicePlugin);
    await f2;
    const f3 = ctx.plugin(builtinRenderersPlugin);
    await f3;
    try {
      const Comp = resolveAssetBlock('deps_impact', 'graph');
      if (!Comp) throw new Error('graph 表现组件未解析');
      const block: SourcedBlock = {
        ...createBlock('deps_impact', payload as never, { messageId: 'm1', part: null }),
        id: 'pb:m1:0',
        asset: { assetId: 'as_1', presentation: 'graph', title: 't', finalised: true },
      } as SourcedBlock;
      return renderToStaticMarkup(createElement(Comp, { block }));
    } finally {
      await f3.dispose();
      await f2.dispose();
      await f1.dispose();
    }
  }

  it('长标签进 SVG 时被截断，且全名在 <title> 里（截断不丢信息）', async () => {
    const html = await renderGraph({
      nodes: [
        { id: LONG, label: LONG },
        { id: 'b', label: 'b' },
      ],
      edges: [{ from: LONG, to: 'b' }],
    });
    expect(html).toContain('<title>');
    expect(html).toContain(LONG); // 全名仍可回读
    expect(html).toContain('…'); // 呈现层截断
    // viewBox 宽 == 版心宽（默认块宽 720）
    expect(html).toMatch(/viewBox="0 0 720 /);
  });
});
