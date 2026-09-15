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
import { assetKinds, validatePayload } from '../src/agent/asset-kinds';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { pieSlices } from '../src/plugins/builtin/renderers/components';

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
    const heights = [...html.matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1]));
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
