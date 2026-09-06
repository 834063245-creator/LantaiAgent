// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// grid 大表虚拟滚动（scientific-rendering-plan #11，2026-09）判据：
//   1. 小表（≤1000 行）零变化：全量平铺 .pp-grid-table（既有 DOM/语义/镜像
//      不动——性能阈值内的普通表不受虚拟化影响）。
//   2. 大表（>1000 行）转虚拟滚动：.pp-grid-virtual div 网格——表头固定行 +
//      可视区（virtualViewportH 240）+ 虚拟行窗口（只渲染可视 ± overscan，
//      行高固定 virtualRowH 29）。
//   3. 组件阈值与 measure 阈值对拍（镜像一致性：改一边另一边测试红）。
//   4. measure 大表镜像：pad + caption + 表头行 + 固定可视区（不再全高延伸）。
// 协议：docs/plans/scientific-rendering-plan.md §5.6 #11 + §0.1 对拍表 #11。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同款范式）
const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import { clearPaperMeasureCache, measureBlockHeight, measureSignature } from '../src/paper/measure';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await fn();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function assetBlock(kind: string, payload: unknown, presentation = '', w = 720): SourcedBlock {
  return {
    ...createBlock(kind, payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    w,
    asset: { assetId: 'as_1', presentation, title: 'grid', finalised: true },
  };
}

function bigRows(n: number): unknown[][] {
  return Array.from({ length: n }, (_, i) => [`r${i}`, i * 2, `v${i}`]);
}

/* ═══ render：小表零变化 / 大表虚拟化 ═══ */

describe('composition/renderer-service — grid 虚拟滚动', () => {
  it('小表（1000 行边界内）仍全量平铺 .pp-grid-table（零变化）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('table', 'grid')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, {
          block: assetBlock('table', { columns: ['a', 'b', 'c'], rows: bigRows(999) }, 'grid'),
        }),
      );
      expect(html).toContain('pp-grid-table');
      expect(html).toContain('<tbody>');
      // 999 行全渲染（HTML table 语义）：thead 1 行 + tbody 999 行
      expect((html.match(/<tr>/g) ?? []).length).toBe(1000);
      expect(html).not.toContain('pp-grid-virtual');
    });
  });

  it('大表（>1000 行）转虚拟滚动：table 结构——thead 固定 + tbody 滚动 + 总高（不铺全量）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('table', 'grid')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, {
          block: assetBlock('table', { columns: ['a', 'b', 'c'], rows: bigRows(5000) }, 'grid'),
        }),
      );
      expect(html).toContain('pp-grid-virtual');
      expect(html).toContain('pp-grid-virtual-scroll'); // tbody 滚动容器
      expect(html).toContain('pp-grid-virtual-tbody');
      expect(html).not.toContain('pp-grid-table"'); // 普通小表款不出现（精确 class 匹配）
      // 表头列仍在（thead th 透传 columns）
      expect(html).toContain('<thead>');
      expect(html).toContain('<th>a</th>');
    });
  });

  it('虚拟滚动总高容器正确（5000 行 × 29 行高 = 145000px）；行窗口由挂载后 effect 填充（SSR 无 scrollElement 尺寸 → 空窗口）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('table', 'grid')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, {
          block: assetBlock('table', { rows: bigRows(5000) }, 'grid'),
        }),
      );
      // 总高占位行 = count × 固定行高（虚拟滚动核心：滚动条高度正确）
      expect(html).toContain('pp-grid-virtual-total');
      expect(html).toContain('height:145000px');
      // SSR 无布局 → 无虚拟行（useVirtualizer 需 scrollElement 尺寸才出窗口）——
      // 客户端挂载后 effect 填充可视行（真机验收项覆盖）
      expect(html).toContain('pp-grid-virtual-scroll');
    });
  });

  it('空/畸形 rows 不崩：非数组按空数组 → 空表', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('table', 'grid')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('table', {}, 'grid') }));
      expect(html).toContain('pp-grid');
    });
  });
});

/* ═══ measure：大表虚拟镜像 ═══ */

describe('paper/measure — grid 大表虚拟镜像', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('大表（5000 行）：pad + caption + 表头行 + 固定可视区（240，不再全高延伸）', () => {
    const h = measureBlockHeight(
      assetBlock('table', { columns: ['a', 'b', 'c'], caption: '大表', rows: bigRows(5000) }, 'grid'),
    );
    const caption = 13 * 1.8 + 6; // captionSize 13 × 1.8 + captionMarginB 6
    const headRow = 8 + 19.8 + 1; // cellPadV×2 + rowSize×1.8 + headBorder
    expect(h).toBeCloseTo(4 + caption + headRow + 240, 1); // gridPadV 2×2=4
  });

  it('全量平铺模式（1000 行内）高度仍随行数延伸（旧镜像不变）', () => {
    const rows = bigRows(100);
    const hSmall = measureBlockHeight(assetBlock('table', { columns: ['a', 'b', 'c'], rows }, 'grid'));
    const hBig = measureBlockHeight(assetBlock('table', { columns: ['a', 'b', 'c'], rows: bigRows(900) }, 'grid'));
    expect(hBig).toBeGreaterThan(hSmall); // 更多行 → 更高（全量延伸语义）
  });

  it('虚拟大表 vs 全量小表：大表封顶于可视区，不高到几千行', () => {
    const hVirtual = measureBlockHeight(assetBlock('table', { columns: ['a', 'b', 'c'], rows: bigRows(5000) }, 'grid'));
    // 5000 行全量延伸会是巨大值；虚拟化封顶 ~300px 级
    expect(hVirtual).toBeLessThan(400);
  });

  it('grid 属资产族 → needsObservedHeight 恒 true（RO 实测兜底）', async () => {
    const { needsObservedHeight } = await import('../src/paper/measure');
    expect(needsObservedHeight('table', true)).toBe(true);
  });

  it('签名含 grid 表现与 payload 尺寸无关（签名不含 rows——RO 实测驱动）', () => {
    const a = measureSignature(assetBlock('table', { columns: ['a'], rows: bigRows(2000) }, 'grid'));
    expect(a).toContain('open|table|grid');
  });
});
