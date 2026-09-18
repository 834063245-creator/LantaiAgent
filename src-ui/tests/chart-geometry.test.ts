// SPDX-License-Identifier: MIT

// chart-geometry — chart 静态图几何与契约（D4-D10，2026-09-16）
//
// 立此文件的原因（作证力纪律）：chart-body 此前的测试只断言**类名存在**
// （toContain('pp-chart-pie')）——饼图渲染成 0 宽空圈、散点 x 是按索引取模的
// 伪随机数、config 被完全忽略，测试照样全绿（考官=考生）。本文件改为断言
// **几何与数值**：扇区角度、坐标映射、文本内容、测高一致性。
//
// 每个 describe 都对应一条可被旧实现证伪的性质（见各 it 注释）。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assetKinds, requirePresentation, validatePayload } from '../src/agent/asset-kinds';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { ASSET_DERIVED, ASSET_TOKENS } from '../src/paper/type-tokens';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { chartLayout, chartSvgHeight, pieSlices } from '../src/plugins/builtin/renderers/components';

type Ctx = Awaited<ReturnType<typeof makeCtx>>;

async function makeCtx() {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  return { ctx, f1, f2, f3 };
}

async function withRenderers(fn: (c: Ctx) => void | Promise<void>): Promise<void> {
  const c = await makeCtx();
  try {
    await fn(c);
  } finally {
    await c.f3.dispose();
    await c.f2.dispose();
    await c.f1.dispose();
  }
}

function assetBlock(payload: unknown, presentation = 'chart'): SourcedBlock {
  return {
    ...createBlock('chart', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation, title: 't', finalised: true },
  };
}

async function renderChart(payload: unknown): Promise<string> {
  let html = '';
  await withRenderers(() => {
    const Comp = resolveAssetBlock('chart', 'chart');
    if (!Comp) throw new Error('chart 表现组件未解析');
    html = renderToStaticMarkup(createElement(Comp, { block: assetBlock(payload) }));
  });
  return html;
}

/** 通用资产渲染助手（grid 信息面批新增）：chart 专用 renderChart 之外的 kind 用它。 */
async function renderAsset(kind: string, presentation: string, payload: unknown): Promise<string> {
  let html = '';
  await withRenderers(() => {
    const Comp = resolveAssetBlock(kind, presentation);
    if (!Comp) throw new Error(`${kind}/${presentation} 表现组件未解析`);
    const block: SourcedBlock = {
      ...createBlock(kind as never, payload as never, { messageId: 'm1', part: null }),
      id: 'pb:m1:0',
      asset: { assetId: 'as_1', presentation, title: 't', finalised: true },
    };
    html = renderToStaticMarkup(createElement(Comp, { block }));
  });
  return html;
}

/* ═══ 1. 饼图真扇区（D5）═══
 * 旧实现：.pp-chart-pie-seg 是 display:block 空 span（flex 中宽 0），
 * 且每片各自画完整 conic-gradient → 渲染成空圈，几何上不是饼图。
 * 新实现：SVG path 弧。以下断言对旧实现必然失败。 */

describe('chart 饼图几何 — 真扇区（旧实现必然证伪）', () => {
  it('扇区角度之和 = 360°（完整圆）', () => {
    const slices = pieSlices([128, 96, 64]);
    expect(slices).toHaveLength(3);
    const total = slices[slices.length - 1].end - slices[0].start;
    expect(Math.abs(total - 360)).toBeLessThan(0.001);
  });

  it('扇区角度与数值成正比', () => {
    const slices = pieSlices([100, 50, 50]); // 总 200 → 180°/90°/90°
    expect(Math.abs(slices[0].end - slices[0].start - 180)).toBeLessThan(0.001);
    expect(Math.abs(slices[1].end - slices[1].start - 90)).toBeLessThan(0.001);
    expect(Math.abs(slices[2].end - slices[2].start - 90)).toBeLessThan(0.001);
    expect(slices[0].ratio).toBeCloseTo(0.5);
  });

  it('无零宽扇区（旧实现每片都是 0 宽 span）', () => {
    for (const s of pieSlices([1, 1, 1, 1])) {
      expect(s.end - s.start).toBeGreaterThan(0);
    }
  });

  it('扇区路径是真实的 arc 命令（M/L/A/Z 结构）', () => {
    const slices = pieSlices([1, 2]);
    for (const s of slices) {
      expect(s.d).toMatch(/^M /);
      expect(s.d).toContain(' A '); // 弧命令——旧实现根本没有 path
      expect(s.d).toMatch(/Z$/);
    }
  });

  it('单片占满 100% 时仍是闭合满圆（起终点重合的退化情形）', () => {
    const slices = pieSlices([42]);
    expect(slices).toHaveLength(1);
    expect(slices[0].ratio).toBeCloseTo(1);
    // 两段半圆逼近，避免起终点重合画出空路径
    expect(slices[0].d.match(/ A /g)).toHaveLength(2);
  });

  it('渲染出 SVG path 扇区（DOM 层）', async () => {
    const html = await renderChart({ type: 'pie', data: { labels: ['a', 'b'], values: [1, 1] } });
    expect(html).toContain('pp-chart-slice');
    expect(html).toContain('<path');
    expect(html).toContain('data-ratio');
    // 每个扇区都带真实角度区间
    expect(html).toMatch(/data-start="[-\d.]+"/);
    expect(html).toMatch(/data-end="[-\d.]+"/);
  });
});

/* ═══ 2. 散点真实 x（D6）═══
 * 旧实现：cx = 10 + ((i*37) % 380) —— 按索引取模的伪随机数，与数据无关。
 * 新实现：x 随索引单调递增（映射到 viewBox 宽度）。 */

describe('chart 散点几何 — x 是真实序列位置（旧实现必然证伪）', () => {
  it('x 坐标严格递增（旧实现在 >10 点时必然回绕）', async () => {
    const values = Array.from({ length: 12 }, (_, i) => i + 1);
    const html = await renderChart({ type: 'scatter', data: values });
    const xs = [...html.matchAll(/data-x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(12);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
  });

  it('y 坐标随数值增大而变小（SVG y 轴向下）', async () => {
    const html = await renderChart({ type: 'scatter', data: [1, 10, 100] });
    const ys = [...html.matchAll(/data-y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBe(3);
    expect(ys[1]).toBeLessThan(ys[0]);
    expect(ys[2]).toBeLessThan(ys[1]);
  });
});

/* ═══ 3. 柱/线数值与轴（D7）═══ */

describe('chart 柱线几何 — 数值标注与轴（旧实现无轴无数值）', () => {
  it('柱高与数值成正比', async () => {
    const html = await renderChart({ type: 'bar', data: [10, 20] });
    // 只取柱体矩形的 height（2026-09-17 起 SVG 元素自身也带盒尺寸属性——几何自描述）
    const heights = [...html.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(heights.length).toBe(2);
    // 20 的柱高约为 10 的两倍
    expect(heights[1] / heights[0]).toBeCloseTo(2, 1);
  });

  it('画出坐标轴（基线 + 纵轴）', async () => {
    const html = await renderChart({ type: 'bar', data: [1, 2] });
    const axisCount = (html.match(/pp-chart-axis/g) ?? []).length;
    expect(axisCount).toBeGreaterThanOrEqual(2);
  });

  it('柱顶显示数值标注', async () => {
    const html = await renderChart({ type: 'bar', data: { labels: ['a', 'b'], values: [128, 96] } });
    expect(html).toContain('pp-chart-value');
    expect(html).toContain('>128<');
    expect(html).toContain('>96<');
  });

  it('数值项超过阈值（>20）时省略标注，防重叠', async () => {
    const values = Array.from({ length: 25 }, (_, i) => i + 1);
    const html = await renderChart({ type: 'bar', data: values });
    expect(html).not.toContain('pp-chart-value');
  });
});

/* ═══ 4. 标签进 SVG（D8）——与柱体同一坐标系 ═══ */

describe('chart 标签 — 移入 SVG 与柱体同坐标系（旧实现是 CSS flex 两套算法）', () => {
  it('分类标签渲染为 SVG text（带 text-anchor）', async () => {
    const html = await renderChart({ type: 'bar', data: { labels: ['feat', 'fix'], values: [1, 2] } });
    expect(html).toContain('pp-chart-cat');
    expect(html).toContain('>feat<');
    expect(html).toContain('>fix<');
    expect(html).toMatch(/text-anchor="middle"/);
  });

  it('标签 text 与柱体同在 SVG 内（不再走盒外 flex 行）', async () => {
    const html = await renderChart({ type: 'bar', data: { labels: ['a'], values: [1] } });
    const svgEnd = html.indexOf('</svg>');
    const labelIdx = html.indexOf('pp-chart-cat');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeLessThan(svgEnd); // 标签在 SVG 内
  });

  it('无标签数据（纯数值数组）不渲染分类 text', async () => {
    const html = await renderChart({ type: 'bar', data: [1, 2] });
    expect(html).not.toContain('pp-chart-cat');
  });
});

/* ═══ 5. 静态版 config（D4）═══
 * 旧实现：ChartBody 完全忽略 config —— title/xName/yName 在默认表现下全部丢失。 */

describe('chart 静态版 config — 写了的必须生效（旧实现完全忽略）', () => {
  it('config.title 渲染到 DOM', async () => {
    const html = await renderChart({ type: 'bar', data: [1], config: { title: '论文量' } });
    expect(html).toContain('pp-chart-title');
    expect(html).toContain('论文量');
  });

  it('config.xName / yName 渲染轴名', async () => {
    const html = await renderChart({ type: 'bar', data: [1], config: { xName: '月份', yName: '次数' } });
    expect(html).toContain('pp-chart-axis-names');
    expect(html).toContain('月份');
    expect(html).toContain('次数');
  });

  it('无 config 时不渲染标题与轴名（不产生空壳）', async () => {
    const html = await renderChart({ type: 'bar', data: [1] });
    expect(html).not.toContain('pp-chart-title');
    expect(html).not.toContain('pp-chart-axis-names');
  });
});

/* ═══ 6. 数据形状归一（D3）═══ */

describe('chart 数据归一 — 三种合法形状', () => {
  it('{labels, values} 对象形状渲染出标签与数值', async () => {
    const html = await renderChart({ type: 'bar', data: { labels: ['a', 'b'], values: [1, 2] } });
    expect(html).toContain('>a<');
    expect(html).toContain('>b<');
  });

  it('[{label, value}] 数组形状渲染出标签与数值', async () => {
    const html = await renderChart({ type: 'bar', data: [{ label: 'x', value: 7 }] });
    expect(html).toContain('>x<');
    expect(html).toContain('>7<');
  });

  it('纯数值数组 [1,2,3] 渲染成功（无标签）', async () => {
    const html = await renderChart({ type: 'bar', data: [1, 2, 3] });
    expect(html).toContain('pp-chart-bar');
    expect(html).not.toContain('pp-chart-empty');
  });

  it('长度不等 → 数据不可用占位（不静默截断）', async () => {
    const html = await renderChart({ type: 'bar', data: { labels: ['a'], values: [1, 2] } });
    expect(html).toContain('pp-chart-empty');
  });

  it('非法形状（categories/series）→ 数据不可用占位', async () => {
    const html = await renderChart({ type: 'bar', data: { categories: ['a'], series: [1] } });
    expect(html).toContain('pp-chart-empty');
  });
});

/* ═══ 8. 测高与渲染一致（D9）═══
 * 旧实现的两宗罪：① 只认数组形状 → 对象形状算错块高；② 未计 config.title/轴名。
 * 判据：块高必须随「渲染层真实会多画的行」变化——同数据加 config → 高度必须增加。 */

describe('chart 测高镜像 — 与渲染同判据（D9）', () => {
  // 走真实入口 measureBlockHeight（导出名）；块形状按 SourcedBlock 最小面构造
  const mk = async (payload: unknown): Promise<number> => {
    const { measureBlockHeight } = await import('../src/paper/measure');
    const block = {
      ...createBlock('chart', payload as never, { messageId: 'm1', part: null }),
      id: 'pb:m1:0',
      w: 600,
      asset: { assetId: 'a', presentation: 'chart', title: 't', finalised: true },
    } as never;
    return measureBlockHeight(block, false);
  };

  it('两种数据形状都算出正高度（旧实现对象形状当无标签 → 块高偏小）', async () => {
    const obj = await mk({ type: 'bar', data: { labels: ['feat', 'docs'], values: [1, 2] } });
    const plain = await mk({ type: 'bar', data: [1, 2] });
    expect(obj).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
    // 带长标签的对象形状不得比纯数值数组更矮（旧实现会误判为无标签）
    expect(obj).toBeGreaterThanOrEqual(plain);
  });

  it('config.title 使块高增加（渲染层多画一行，测高必须跟随）', async () => {
    const plain = await mk({ type: 'bar', data: [1, 2] });
    const withTitle = await mk({ type: 'bar', data: [1, 2], config: { title: '论文量' } });
    expect(withTitle).toBeGreaterThan(plain);
  });

  it('config 轴名使块高增加', async () => {
    const plain = await mk({ type: 'bar', data: [1, 2] });
    const withAxis = await mk({ type: 'bar', data: [1, 2], config: { xName: '月份', yName: '次数' } });
    expect(withAxis).toBeGreaterThan(plain);
  });
});

describe('chart 契约校验 — 写入门禁（此前 payload 无校验）', () => {
  it('合法形状通过校验', () => {
    const def = assetKinds.get('chart');
    expect(def).toBeDefined();
    for (const ok of [
      { type: 'bar', data: { labels: ['a'], values: [1] } },
      { type: 'bar', data: [{ label: 'a', value: 1 }] },
      { type: 'bar', data: [1, 2, 3] },
    ]) {
      expect(validatePayload(def!, ok)).toBeNull();
    }
  });

  it('上轮踩过的 {categories, series} 被拒（并提示正确形状）', () => {
    const def = assetKinds.get('chart')!;
    const err = validatePayload(def, { type: 'bar', data: { categories: ['a'], series: [1] } });
    expect(err).toBeTruthy();
    expect(err).toContain('正确形状示例'); // 错误即导航
  });

  it('labels/values 不等长被拒（受限子集表达不了，走运行时补校验）', () => {
    const def = assetKinds.get('chart')!;
    const err = validatePayload(def, { type: 'bar', data: { labels: ['a'], values: [1, 2] } });
    expect(err).toBeTruthy();
    expect(err).toContain('必须等长');
  });

  it('缺 type / type 非法被拒', () => {
    const def = assetKinds.get('chart')!;
    expect(validatePayload(def, { data: [1] })).toContain('type');
    expect(validatePayload(def, { type: 'donut', data: [1] })).toBeTruthy();
  });

  it('其余 kind 未被误伤（回归：metric 的联合类型 value）', () => {
    // metric.value 用 type:['string','number'] —— 校验器须支持联合类型
    const metric = assetKinds.get('metric')!;
    expect(validatePayload(metric, { items: [{ label: 'x', value: 1 }] })).toBeNull();
    expect(validatePayload(metric, { items: [{ label: 'x', value: '1' }] })).toBeNull();
    const table = assetKinds.get('table')!;
    expect(validatePayload(table, { columns: ['a'], rows: [['1']] })).toBeNull();
  });

  it('全部内置 kind 的样本 payload 都通过（防误伤面）', () => {
    const samples: Record<string, unknown> = {
      table: { columns: ['a'], rows: [['1']] },
      chart: { type: 'bar', data: [1] },
      metric: { items: [{ label: 'x', value: 1 }] },
      file: { filePath: 'C:/a.png', ext: 'png' },
      deps_impact: { nodes: [{ id: 'a' }], edges: [] },
      html: { code: '<b>hi</b>' },
      confirm: { title: 't', options: [] },
      board: { columns: [{ title: 't', cards: [{ label: 'x' }] }] },
      timeline: { items: [{ ts: 'v1', title: 't' }] },
      chem: { name: 'x' },
      citation: { title: 'x' },
    };
    for (const [id, payload] of Object.entries(samples)) {
      const def = assetKinds.get(id);
      if (!def) continue; // 未注册的 kind 跳过（插件面可增删）
      expect(validatePayload(def, payload), `${id} 不应被误拒`).toBeNull();
    }
  });
});

// ── 盒定比例（2026-09-17 P1「图版语汇」批）──
//
// 旧模型的可证伪事实（实测读数：prototype/asset-cards-ab.NOTES.md +
// docs/plans/tool-image-context-plan.md §6）：viewBox 宽 = 30 + 柱数×40 + 10、
// 高恒 180，CSS width:100% / height:auto / max-height:240 ⇒ 3 根柱被 meet 缩成
// 约 213×240 居中、两侧各空 253px；20 根柱时 8px 字被缩到 6.5px（同一 kind 只换
// 条数，字号差 39%）。本组断言在旧实现下全部为假。

describe('chart 盒定比例 — 宽高由版心定，不由数据条数定', () => {
  const BOX = 720;

  it('viewBox 宽 == 卡片内容宽（用户单位 == CSS px ⇒ 文字不被缩放）', () => {
    for (const n of [3, 8, 20]) {
      expect(chartLayout({ type: 'bar', count: n, boxW: BOX }).viewW).toBe(BOX);
    }
    expect(chartLayout({ type: 'scatter', count: 5, boxW: BOX }).viewW).toBe(BOX);
  });

  it('高度按类目数分三档（与坐标系宽度解耦），且与 token 档位同值', () => {
    const [t1, t2] = ASSET_TOKENS.chart.countTiers;
    const [h1, h2, h3] = ASSET_TOKENS.chart.svgHByCount;
    expect(chartSvgHeight('bar', t1)).toBe(h1);
    expect(chartSvgHeight('bar', t1 + 1)).toBe(h2);
    expect(chartSvgHeight('bar', t2)).toBe(h2);
    expect(chartSvgHeight('bar', t2 + 1)).toBe(h3);
    expect(chartSvgHeight('pie', 20)).toBe(ASSET_TOKENS.chart.pieH);
    // measure 侧派生与渲染器同源（两侧同值 ⇒ 测高不再漂）
    for (const [t, n] of [
      ['bar', 3],
      ['bar', 20],
      ['line', 7],
      ['pie', 6],
    ] as const) {
      expect(ASSET_DERIVED.chartSvgH(t, n)).toBe(chartSvgHeight(t, n));
    }
  });

  it('条数少 → 柱更宽（而不是图更小），且铺满绘图区', () => {
    const few = chartLayout({ type: 'bar', count: 3, boxW: BOX });
    const many = chartLayout({ type: 'bar', count: 20, boxW: BOX });
    expect(few.barW).toBeGreaterThan(many.barW);
    expect(few.barW).toBeGreaterThan(22); // 旧实现的固定柱宽
    const firstLeft = few.leftPad + (few.barSlot - few.barW) / 2;
    const lastRight = few.leftPad + 2 * few.barSlot + (few.barSlot - few.barW) / 2 + few.barW;
    expect(lastRight - firstLeft).toBeGreaterThan(few.plotW * 0.8);
  });

  it('柱宽夹在「不重叠」与「不空档」之间：极端类目数下也不互相压叠', () => {
    const dense = chartLayout({ type: 'bar', count: 200, boxW: BOX });
    expect(dense.barW).toBeGreaterThan(0);
    expect(dense.barW).toBeLessThanOrEqual(dense.barSlot - 2 + 1e-9);
    const single = chartLayout({ type: 'bar', count: 1, boxW: BOX });
    expect(single.barW).toBeLessThanOrEqual(single.barSlot);
  });

  it('镜像对拍：渲染侧内距 == token 真源（防两侧漂移）', () => {
    const L = chartLayout({ type: 'bar', count: 1, boxW: BOX });
    expect(L.leftPad).toBe(ASSET_TOKENS.chart.leftPad);
    expect(L.rightPad).toBe(ASSET_TOKENS.chart.rightPad);
    expect(L.topPad).toBe(ASSET_TOKENS.chart.topPad);
    expect(L.bottomPad).toBe(ASSET_TOKENS.chart.bottomPad);
    expect(L.baseY).toBe(chartSvgHeight('bar', 1) - ASSET_TOKENS.chart.bottomPad);
  });
});

// ── 信息面：unit / source（2026-09-17「让卡片说人话」批第一刀）──
//
// 此前 schema 只有 type/data/config ⇒ 图上只有一个裸数字（251 是次数还是毫秒？）。
// 两个字段共用既有类型行（零测高改动），旧 payload 不带它们时 wire/markup 逐字不变。

describe('chart 信息面 — 单位与口径', () => {
  it('unit / source 渲染在类型行里（读者不用猜数字是什么）', async () => {
    const html = await renderChart({
      type: 'bar',
      data: [1, 2],
      unit: '次',
      source: 'git log 近 30 天',
    });
    expect(html).toContain('pp-chart-unit');
    expect(html).toContain('单位 次');
    expect(html).toContain('pp-chart-source');
    expect(html).toContain('来源 git log 近 30 天');
  });

  it('不带这两字段 → 类型行 markup 与旧版一致（零漂移）', async () => {
    const html = await renderChart({ type: 'bar', data: [1, 2] });
    expect(html).toContain('<div class="pp-chart-type">bar</div>');
    expect(html).not.toContain('pp-chart-unit');
  });

  it('schema 接受两字段（可选），非法类型仍被拒（不静默）', () => {
    const def = assetKinds.get('chart')!;
    expect(validatePayload(def, { type: 'bar', data: [1], unit: '次', source: 'x' })).toBeNull();
    expect(validatePayload(def, { type: 'bar', data: [1], unit: 5 })).toContain('unit');
    expect(validatePayload(def, { type: 'bar', data: [1], source: ['a'] })).toContain('source');
  });
});

// ── 信息面第二刀：metric 的 compare（2026-09-17）──
//
// 单值没有比较对象就只能当装饰（「上期 88」「目标 100」「阈值 5」）。
// 渲染在数值同行右侧 ⇒ 零测高；旧 payload 不带它时 markup 逐字不变。

describe('metric 信息面 — 比较对象', () => {
  async function renderMetric(payload: unknown): Promise<string> {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const f2 = ctx.plugin(rendererServicePlugin);
    await f2;
    const f3 = ctx.plugin(builtinRenderersPlugin);
    await f3;
    try {
      const Comp = resolveAssetBlock('metric', 'metric');
      if (!Comp) throw new Error('metric 表现组件未解析');
      const block: SourcedBlock = {
        ...createBlock('metric', payload as never, { messageId: 'm1', part: null }),
        id: 'pb:m1:0',
        asset: { assetId: 'as_1', presentation: 'metric', title: 't', finalised: true },
      } as SourcedBlock;
      return renderToStaticMarkup(createElement(Comp, { block }));
    } finally {
      await f3.dispose();
      await f2.dispose();
      await f1.dispose();
    }
  }

  it('compare 渲染在数值同行（读者知道这个数是好是坏）', async () => {
    const html = await renderMetric({ items: [{ label: '覆盖率', value: 82, unit: '%', compare: '目标 90' }] });
    expect(html).toContain('pp-metric-compare');
    expect(html).toContain('目标 90');
  });

  it('不带 compare → markup 里没有该元素（零漂移）', async () => {
    const html = await renderMetric({ items: [{ label: '覆盖率', value: 82, unit: '%' }] });
    expect(html).not.toContain('pp-metric-compare');
  });

  it('schema 接受 compare（可选），非法类型仍被拒', () => {
    const def = assetKinds.get('metric')!;
    expect(validatePayload(def, { items: [{ label: 'x', value: 1, compare: '上期 88' }] })).toBeNull();
    expect(validatePayload(def, { items: [{ label: 'x', value: 1, compare: 88 }] })).toContain('compare');
  });
});

// ── 信息面第三刀：grid 的 emphasis（2026-09-17）──
//
// 「几百行就是一面墙」：模型知道哪几行是重点，读者不知道。emphasis.rows 让结论行
// 自己浮出来；纯样式（不加行、不改行高）⇒ 测高零改动。

describe('grid 信息面 — 重点行', () => {
  it('被标记的行带 pp-grid-row-emphasis（其余行不带）', async () => {
    const html = await renderAsset('table', 'grid', {
      columns: ['a', 'b'],
      rows: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      emphasis: { rows: [1] },
    });
    expect((html.match(/pp-grid-row-emphasis/g) ?? []).length).toBe(1);
    // 第 2 行（下标 1）带类，第 1/3 行不带：定位到带类的那个 <tr>
    expect(html).toMatch(/<tr class="pp-grid-row-emphasis">/);
  });

  it('不带 emphasis → 一个重点行都没有（零漂移）', async () => {
    const html = await renderAsset('table', 'grid', { columns: ['a'], rows: [[1]] });
    expect(html).not.toContain('pp-grid-row-emphasis');
  });

  it('畸形 emphasis（非对象/非数组/含非整数）→ 空集，不炸也不误标', async () => {
    for (const bad of [{ emphasis: 'x' }, { emphasis: { rows: 'x' } }, { emphasis: { rows: [-1, 1.5, 'a'] } }]) {
      const html = await renderAsset('table', 'grid', { columns: ['a'], rows: [[1], [2]], ...bad });
      expect(html).not.toContain('pp-grid-row-emphasis');
    }
    const ok = await renderAsset('table', 'grid', { columns: ['a'], rows: [[1], [2]], emphasis: { rows: [1] } });
    expect(ok).toContain('pp-grid-row-emphasis');
  });

  it('schema 接受 emphasis（可选），坏形状被拒', () => {
    const def = assetKinds.get('table')!;
    expect(validatePayload(def, { columns: ['a'], rows: [[1]], emphasis: { rows: [0] } })).toBeNull();
    expect(validatePayload(def, { columns: ['a'], rows: [[1]], emphasis: { rows: ['x'] } })).toContain('emphasis');
  });
});

describe('题签行铺到 board / timeline（2026-09-17）', () => {
  it('看板：题签行在场，签为「板」，题名可空', async () => {
    const withTitle = await renderAsset('board', 'board', {
      caption: '发布流程',
      columns: [{ title: '待办', cards: [{ label: 'a' }] }],
    });
    expect(withTitle).toContain('pp-plate');
    expect(withTitle).toContain('>板<');
    expect(withTitle).toContain('发布流程');
    const noTitle = await renderAsset('board', 'board', { columns: [{ title: '待办', cards: [] }] });
    expect(noTitle).toContain('>板<'); // 题签恒在
  });

  it('时间轴：题签行在场，签为「序」', async () => {
    const html = await renderAsset('timeline', 'timeline', {
      caption: '版本演进',
      items: [{ ts: 'v1', title: 't' }],
    });
    expect(html).toContain('pp-plate');
    expect(html).toContain('>序<');
    expect(html).toContain('版本演进');
  });

  it('两 kind 的 caption 为可选（schema 接受缺省与字符串，拒非字符串）', () => {
    const board = assetKinds.get('board')!;
    expect(validatePayload(board, { columns: [{ title: 'a', cards: [] }] })).toBeNull();
    expect(validatePayload(board, { columns: [], caption: 'x' })).toBeNull();
    expect(validatePayload(board, { columns: [], caption: 5 })).toContain('caption');
    const tl = assetKinds.get('timeline')!;
    expect(validatePayload(tl, { items: [], caption: 'x' })).toBeNull();
    expect(validatePayload(tl, { items: [], caption: [] })).toContain('caption');
  });
});

describe('题签行铺满十二原语（2026-09-17 收尾）', () => {
  it('citation / chem / media / html 都出题签（引 / 式 / 图 / 页）', async () => {
    const cases: Array<[string, string, unknown, string]> = [
      ['citation', 'citation', { title: '论文', doi: '10.1/x' }, '引'],
      ['chem', 'chem', { name: '乙醇', formula: 'C2H6O' }, '式'],
      ['file', 'media', { filePath: 'C:/a/b.png', ext: 'png' }, '图'],
      ['html', 'html', { code: '<b>hi</b>' }, '页'],
    ];
    for (const [kind, pres, payload, sign] of cases) {
      const html = await renderAsset(kind, pres, payload);
      expect(html, `${kind} 应出题签行`).toContain('pp-plate');
      expect(html, `${kind} 的签应为「${sign}」`).toContain(`>${sign}<`);
    }
  });
});

// ── 白名单 ↔ 注册面对拍 + 两张真机事故的回归（2026-09-18 取证）──
//
// 事故一：deps_impact 白名单声明 `presentation:"table"`，而注册面**没有** 'table' 原语
//   ⇒ 模型按白名单选值是「合法」的、渲染侧静默落 '*' JsonBody ⇒ 用户看到一张 JSON 卡。
// 事故二：append 型 kind 允许 stream:true + 字符串载荷（跳过结构校验），终值仍是字符串
//   ⇒ GridBody 读 p.rows 得 undefined ⇒ 旧实现渲染成**空表框**（信息全丢）。

describe('资产表现白名单 ↔ 注册面对拍（防「合法却无实现」）', () => {
  it('每个 kind 的每个白名单表现，都能解析到真实渲染器（不是 JSON 兜底）', async () => {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const f2 = ctx.plugin(rendererServicePlugin);
    await f2;
    const f3 = ctx.plugin(builtinRenderersPlugin);
    await f3;
    try {
      const bad: string[] = [];
      for (const def of assetKinds.list()) {
        for (const pres of def.presentations) {
          const Comp = resolveAssetBlock(def.id, pres);
          // JsonBody 是 '*' 兜底（JSON 卡）——白名单里的表现落到它就是声明与注册面脱钩
          if (!Comp || Comp.name === 'JsonBody') bad.push(`${def.id}/${pres} → ${Comp?.name ?? 'undefined'}`);
        }
      }
      expect(bad, `白名单声明了无实现的表现在（会静默落 JSON 兜底）：\n${bad.join('\n')}`).toEqual([]);
    } finally {
      await f3.dispose();
      await f2.dispose();
      await f1.dispose();
    }
  });

  it('deps_impact 的 table 已从白名单收口（模型会收到带窗报错，而不是无声 JSON）', () => {
    const def = assetKinds.get('deps_impact')!;
    expect(def.presentations).toEqual(['graph', 'tree']);
    expect(validatePayload(def, { nodes: [{ id: 'a' }], edges: [] })).toBeNull();
    // 越界表现是**报错带窗**（错误即导航：报该 kind 的白名单），不是静默回落
    expect(() => requirePresentation(def, 'table')).toThrow(/table/);
    expect(requirePresentation(def, 'graph')).toBe('graph');
  });

  it('表格载荷是字符串（流式残留）→ 可见占位，不再渲染空框（信息不静默丢）', async () => {
    const html = await renderAsset('table', 'grid', '1｜内核重构｜完成\n2｜插件化｜完成');
    expect(html).toContain('pp-grid-empty');
    expect(html).toContain('数据不可用');
  });
});
