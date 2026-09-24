// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// chart interactive 交互图表（scientific-rendering-plan #16，2026-09）判据：
//   1. kind 注册：chart kind 的 presentations 白名单含 'interactive'（默认仍
//      'chart'——静态 SVG 与历史块零影响，协议 §5.3 双维度正交）。
//   2. render：presentation='interactive' 解析到 InteractiveChartBody——ECharts
//      canvas 固定盒（SSR/测试无 canvas → 空盒占位）；空数据「数据不可用」
//      占位同静态版；type 行带「交互」后缀。
//   3. measure：interactive 表现高 = chart pad + type 行 + 固定盒高（token
//      interactiveBoxH 260）——canvas 自绘图例/轴在盒内不占盒外行，盒高恒定。
//   4. ECharts option 构造（buildEchartsOption 导出面）：bar/line 单系列 +
//      category x 轴；pie 转 {name,value}；scatter 转 [x,y] 点列；长数据
//      （>40）加 dataZoom——纯函数可测（不碰 DOM）。
// 协议：docs/plans/scientific-rendering-plan.md §5.3 + §5.6 #16 + §0.1 对拍表 #16。

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
import {
  clearPaperMeasureCache,
  measureBlockHeight,
  measureSignature,
  needsObservedHeight,
} from '../src/paper/measure';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { buildEchartsOption } from '../src/plugins/builtin/renderers/components';

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
    asset: { assetId: 'as_1', presentation, title: 'chart', finalised: true },
  };
}

/** 柱状图样例（数组形状 {label,value}） */
const barPayload = {
  type: 'bar',
  data: [
    { label: 'CN', value: 128 },
    { label: 'US', value: 96 },
    { label: 'JP', value: 64 },
  ],
};

/* ═══ kind 注册 / presentation 白名单 ═══ */

describe('chart kind — interactive presentation 白名单', () => {
  let assetKinds: import('../src/agent/asset-kinds').AssetKindRegistry;

  beforeEach(async () => {
    const ak = await import('../src/agent/asset-kinds');
    assetKinds = ak.assetKinds;
  });

  it('chart presentations 含 chart 与 interactive，默认仍 chart', () => {
    const def = assetKinds.get('chart');
    expect(def).toBeDefined();
    expect(def?.presentations).toEqual(['chart', 'interactive']);
    expect(def?.defaultPresentation).toBe('chart'); // 静态 SVG 默认，历史块零影响
  });

  it('show_asset 带 presentation=interactive 可生成', async () => {
    const sa = await import('../src/plugins/builtin/asset-domain/asset-tools');
    const clearTables = (await import('../src/agent/asset-store')).clearAssetTablesForTests;
    clearTables();
    const tool = sa.createAssetTools().find((t) => t.name() === 'show_asset')!;
    const out = await tool.execute({
      _owner_id: 'o',
      kind: 'chart',
      title: 'regions',
      payload: barPayload,
      presentation: 'interactive',
    });
    const parsed = JSON.parse(out) as { presentation: string };
    expect(parsed.presentation).toBe('interactive');
  });
});

/* ═══ ECharts option 构造（纯函数） ═══ */

describe('buildEchartsOption — 数据形状 → ECharts option', () => {
  it('bar：单系列 + category x 轴（labels 取用）', () => {
    const opt = buildEchartsOption('bar', barPayload.data, undefined) as {
      xAxis: { type: string; data: string[] };
      series: Array<{ type: string; data: number[] }>;
    };
    expect(opt.xAxis.type).toBe('category');
    expect(opt.xAxis.data).toEqual(['CN', 'US', 'JP']);
    expect(opt.series[0].type).toBe('bar');
    expect(opt.series[0].data).toEqual([128, 96, 64]);
  });

  it('pie：转 {name, value} 配对', () => {
    const opt = buildEchartsOption('pie', barPayload.data, undefined) as {
      series: Array<{ type: string; data: Array<{ name: string; value: number }> }>;
    };
    expect(opt.series[0].type).toBe('pie');
    expect(opt.series[0].data[0]).toEqual({ name: 'CN', value: 128 });
  });

  it('scatter：转 [x,y] 点列', () => {
    const opt = buildEchartsOption('scatter', barPayload.data, undefined) as {
      series: Array<{ type: string; data: number[][] }>;
    };
    expect(opt.series[0].type).toBe('scatter');
    expect(opt.series[0].data[0]).toEqual(['CN', 128]);
  });

  it('对象形状 {labels, values} 也归一', () => {
    const opt = buildEchartsOption('line', { labels: ['a', 'b'], values: [1, 2] }, undefined) as {
      xAxis: { data: string[] };
      series: Array<{ type: string; data: number[] }>;
    };
    expect(opt.xAxis.data).toEqual(['a', 'b']);
    expect(opt.series[0].type).toBe('line');
    expect(opt.series[0].data).toEqual([1, 2]);
  });

  it('长数据（>40）自动加 dataZoom（滚动/缩放交互）', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ label: `p${i}`, value: i }));
    const opt = buildEchartsOption('line', many, undefined) as { dataZoom?: unknown[] };
    expect(Array.isArray(opt.dataZoom)).toBe(true);
    expect((opt.dataZoom as unknown[]).length).toBe(2); // inside + slider
  });

  it('短数据不加 dataZoom', () => {
    const opt = buildEchartsOption('line', barPayload.data, undefined) as { dataZoom?: unknown };
    expect(opt.dataZoom).toBeUndefined();
  });

  it('config.title 透传标题', () => {
    const opt = buildEchartsOption('bar', barPayload.data, { title: '论文量' }) as { title: { text: string } };
    expect(opt.title).toEqual({ text: '论文量' });
  });
});

/* ═══ render：InteractiveChartBody ═══ */

describe('composition/renderer-service — chart interactive 表现', () => {
  it('presentation=interactive 解析到表现组件', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'interactive');
      expect(Comp).toBeTypeOf('function');
    });
  });

  it('渲染：type 行带「交互」后缀 + ECharts 固定盒容器（SSR 无 effect → 空盒）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'interactive')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('chart', barPayload, 'interactive') }),
      );
      expect(html).toContain('pp-chart-interactive');
      expect(html).toContain('bar · 交互');
      expect(html).toContain('pp-chart-interactive-box');
    });
  });

  it('presentation 缺省回落默认 chart（静态表现，非 interactive）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', undefined);
      expect(Comp).toBeTypeOf('function');
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chart', barPayload, '') }));
      expect(html).toContain('pp-chart');
      expect(html).not.toContain('pp-chart-interactive');
      expect(html).not.toContain('交互');
    });
  });

  it('空数据：与静态版同款「数据不可用」占位（无盒无初始化）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'interactive')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chart', {}, 'interactive') }));
      expect(html).toContain('数据不可用');
      expect(html).not.toContain('pp-chart-interactive-box');
    });
  });

  it('历史 chart 块（presentation=chart 存证）渲染静态版，不触发 ECharts', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'chart')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chart', barPayload, 'chart') }));
      expect(html).toContain('pp-chart-svg');
      expect(html).not.toContain('交互');
    });
  });
});

/* ═══ measure：interactive 块测高 ═══ */

describe('paper/measure — chart interactive 块测高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('interactive：pad + type 行 + 固定盒 260（图例/轴在盒内不占盒外行）', () => {
    const h = measureBlockHeight(assetBlock('chart', barPayload, 'interactive'));
    const typeH = 9 * 1.8 + 4; // chartTypeSize 9 × 1.8 + typeMarginB 4
    expect(h).toBeCloseTo(8 + typeH + 260, 1); // chartPadV 4×2=8 + type 行 + 盒 260
  });

  it('presentation 缺失回落默认 chart（静态镜像，与静态 chartBodyH 一致）', () => {
    const hDefault = measureBlockHeight(assetBlock('chart', barPayload, ''));
    const hStatic = measureBlockHeight(assetBlock('chart', barPayload, 'chart'));
    expect(hDefault).toBe(hStatic);
    // 静态版 ≠ interactive 版（不同表现不同高）
    const hInteractive = measureBlockHeight(assetBlock('chart', barPayload, 'interactive'));
    expect(hInteractive).not.toBe(hStatic);
  });

  it('chart kind 属资产族 → needsObservedHeight 恒 true（挂载后 RO 实测兜底）', () => {
    expect(needsObservedHeight('chart', true)).toBe(true);
  });

  it('interactive 签名走 open 分支（kind + presentation 入签）', () => {
    const a = measureSignature(assetBlock('chart', barPayload, 'interactive'));
    expect(a).toContain('open|chart|interactive');
    const b = measureSignature(assetBlock('chart', barPayload, 'chart'));
    expect(b).not.toBe(a);
  });
});
