// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-primitives — Agent 资产块 WO-6 判据：
//   首发表现原语（grid/chart/metric/media/graph/tree/html/form）各自渲染不崩；
//   kind → presentation 白名单回落正确；未知 kind 仍走 JSON 兜底。
// 协议：docs/plans/agent-asset-blocks.md §2.9/§2.11/§3（WO-6）。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { buildHtmlCardDocument } from '../src/plugins/builtin/renderers/components';

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  // P1：资产表现原语由内置渲染器插件注册（service 不再构造期注册资产 8 行）
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await fn();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function assetBlock(kind: string, presentation: string, payload: unknown): SourcedBlock {
  return {
    ...createBlock(kind, payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation, title: 't', finalised: true },
  };
}

describe('composition/renderer-service — 首发表现原语（WO-6）', () => {
  const cases: Array<[string, string, unknown, string]> = [
    ['table', 'grid', { columns: ['a'], rows: [['1']] }, 'pp-grid'],
    ['chart', 'chart', { type: 'bar', data: [1, 2] }, 'pp-chart'],
    ['metric', 'metric', { items: [{ label: 'x', value: 1 }] }, 'pp-metric'],
    ['file', 'media', { filePath: 'C:/a.png', ext: 'png' }, 'pp-media'],
    ['deps_impact', 'graph', { nodes: [{ id: 'a' }], edges: [] }, 'pp-graph'],
    ['deps_impact', 'tree', { nodes: [{ id: 'a' }], edges: [] }, 'pp-graph'],
    ['confirm', 'form', { title: '确认', options: [] }, 'pp-form'],
    ['html', 'html', { code: '<b>hi</b>' }, 'pp-html'],
  ];

  it.each(cases)('kind=%s presentation=%s 渲染 %s 不崩', async (kind, pres, payload, cls) => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock(kind, pres);
      expect(Comp, `${kind}/${pres} 应有表现组件`).toBeTypeOf('function');
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock(kind, pres, payload) }));
      expect(html).toContain(cls);
    });
  });

  it('presentation 脏数据回落到 kind 默认表现', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('deps_impact', 'bogus');
      expect(Comp).toBeTypeOf('function');
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('deps_impact', 'bogus', { nodes: [{ id: 'a' }], edges: [] }) }),
      );
      expect(html).toContain('pp-graph');
    });
  });

  it('未知 kind 仍走 JSON 兜底，不接表现原语', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('not_registered', 'chart');
      expect(Comp).toBeTypeOf('function');
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('not_registered', 'chart', { x: 1 }) }),
      );
      expect(html).toContain('pp-json');
    });
  });

  it('presentation 缺省时用 kind 默认表现', async () => {
    await withRenderers(() => {
      const deps = resolveAssetBlock('deps_impact', undefined);
      expect(
        renderToStaticMarkup(
          createElement(deps!, { block: assetBlock('deps_impact', '', { nodes: [{ id: 'a' }], edges: [] }) }),
        ),
      ).toContain('pp-graph');
      const metric = resolveAssetBlock('metric', undefined);
      expect(
        renderToStaticMarkup(createElement(metric!, { block: assetBlock('metric', '', { items: [] }) })),
      ).toContain('pp-metric');
    });
  });

  it('畸形 payload 不崩：空表格/空图/空指标/无字段媒体/空图/空表单/空 html', async () => {
    await withRenderers(() => {
      const cases: Array<[string, string, unknown, string]> = [
        ['table', 'grid', {}, 'pp-grid'],
        ['chart', 'chart', {}, 'pp-chart'],
        ['metric', 'metric', {}, 'pp-metric'],
        ['file', 'media', {}, 'pp-media'],
        ['deps_impact', 'graph', {}, 'pp-graph'],
        ['confirm', 'form', {}, 'pp-form'],
        ['html', 'html', {}, 'pp-html'],
      ];
      for (const [kind, pres, payload, cls] of cases) {
        const Comp = resolveAssetBlock(kind, pres);
        const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock(kind, pres, payload) }));
        expect(html).toContain(cls);
      }
    });
  });

  it('chart 四种类型分别渲染对应标记', async () => {
    await withRenderers(() => {
      const bar = resolveAssetBlock('chart', 'chart')!;
      expect(
        renderToStaticMarkup(createElement(bar, { block: assetBlock('chart', 'chart', { type: 'bar', data: [1] }) })),
      ).toContain('pp-chart-bar');
      const line = resolveAssetBlock('chart', 'chart')!;
      expect(
        renderToStaticMarkup(createElement(line, { block: assetBlock('chart', 'chart', { type: 'line', data: [1] }) })),
      ).toContain('pp-chart-line');
      const scatter = resolveAssetBlock('chart', 'chart')!;
      expect(
        renderToStaticMarkup(
          createElement(scatter, { block: assetBlock('chart', 'chart', { type: 'scatter', data: [1] }) }),
        ),
      ).toContain('pp-chart-dot');
      const pie = resolveAssetBlock('chart', 'chart')!;
      expect(
        renderToStaticMarkup(createElement(pie, { block: assetBlock('chart', 'chart', { type: 'pie', data: [1] }) })),
      ).toContain('pp-chart-pie');
    });
  });

  it('metric tone 类名生效', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('metric', 'metric')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('metric', 'metric', { items: [{ label: 'x', value: 1, tone: 'danger' }] }),
        }),
      );
      expect(html).toContain('pp-metric-tone-danger');
    });
  });

  it('form 渲染 options 与 confirmLabel', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('confirm', 'form')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('confirm', 'form', {
            title: '请确认',
            body: '正文',
            options: [{ label: 'A', description: 'desc' }],
            confirmLabel: '执行',
          }),
        }),
      );
      expect(html).toContain('请确认');
      expect(html).toContain('A');
      expect(html).toContain('执行');
    });
  });

  it('graph 树布局确定性：同一输入两次渲染完全一致', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('deps_impact', 'graph')!;
      const block = assetBlock('deps_impact', 'graph', {
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
        ],
      });
      const h1 = renderToStaticMarkup(createElement(Comp, { block }));
      const h2 = renderToStaticMarkup(createElement(Comp, { block }));
      expect(h1).toBe(h2);
      expect(h1).toContain('pp-graph-edge');
    });
  });

  it('html 沙箱 iframe 带 sandbox 与 srcDoc', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('html', 'html')!;
      const html = renderToStaticMarkup(
        createElement(Comp, { block: assetBlock('html', 'html', { code: '<b>hi</b>' }) }),
      );
      expect(html).toContain('sandbox="allow-scripts"');
      expect(html).toContain('srcDoc="&lt;!DOCTYPE html&gt;');
    });
  });
});

describe('html 沙箱文档（WO-8）', () => {
  it('buildHtmlCardDocument 含禁网/禁表单 CSP 与高度上报脚本', () => {
    const html = buildHtmlCardDocument('<b>hi</b>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain('lantai.card-resize');
    expect(html).toContain('<b>hi</b>');
  });

  it('超过 512KB 的 code 被截断（防滥用）', () => {
    const html = buildHtmlCardDocument('x'.repeat(600 * 1024));
    expect(html.length).toBeLessThan(600 * 1024);
  });
});
