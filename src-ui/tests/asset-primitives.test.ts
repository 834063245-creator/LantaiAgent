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
    ['board', 'board', { columns: [{ title: '待办', cards: [{ label: 'x' }] }] }, 'pp-board'],
    ['timeline', 'timeline', { items: [{ ts: 'v1', title: '发布' }] }, 'pp-timeline'],
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

  it('畸形 payload 不崩：空表格/空图/空指标/无字段媒体/空图/空表单/空 html/空看板/空时间轴', async () => {
    await withRenderers(() => {
      const cases: Array<[string, string, unknown, string]> = [
        ['table', 'grid', {}, 'pp-grid'],
        ['chart', 'chart', {}, 'pp-chart'],
        ['metric', 'metric', {}, 'pp-metric'],
        ['file', 'media', {}, 'pp-media'],
        ['deps_impact', 'graph', {}, 'pp-graph'],
        ['confirm', 'form', {}, 'pp-form'],
        ['html', 'html', {}, 'pp-html'],
        ['board', 'board', {}, 'pp-board'],
        ['timeline', 'timeline', {}, 'pp-timeline'],
      ];
      for (const [kind, pres, payload, cls] of cases) {
        const Comp = resolveAssetBlock(kind, pres);
        const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock(kind, pres, payload) }));
        expect(html).toContain(cls);
      }
    });
  });

  // chart 四种类型的几何与数值断言已迁 tests/chart-geometry.test.ts（D10，
  // 2026-09-16 整删此处旧的「类名存在」断言——它只验 toContain('pp-chart-pie')，
  // 而新类名 pp-chart-pie-svg 恰好含该子串，属假通过；且旧断言无法识破
  // 「饼图 0 宽空圈 / 散点伪随机 x」，作证力归零）。

  it('chart 支持对象形状 data（{labels, values}）——回归：此前对象形状静默空白', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'chart')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('chart', 'chart', {
            type: 'bar',
            data: { labels: ['feat', 'docs'], values: [148, 144] },
          }),
        }),
      );
      // 有柱（含高度）而不是空 SVG
      expect(html).toContain('pp-chart-bar');
      // 柱宽来自 token（D5-D8 重写后几何由 ASSET_TOKENS.chart 驱动，不硬编码
      // 具体数值——避免测试与 token 改动耦合；柱存在性由上一行断言）
      expect(html).toMatch(/width="\d+"/);
      expect(html).toMatch(/height="[1-9][\d.]*"/);
      // 标签渲染
      expect(html).toContain('feat');
      expect(html).toContain('docs');
      // "数据不可用"占位不应出现
      expect(html).not.toContain('pp-chart-empty');
    });
  });

  it('chart 无效数据渲染"数据不可用"占位，不静默空白', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'chart')!;
      // 空对象（无 data）
      const empty = renderToStaticMarkup(createElement(Comp, { block: assetBlock('chart', 'chart', {}) }));
      expect(empty).toContain('pp-chart-empty');
      // 形状不符（无 values 的对象）
      const bad = renderToStaticMarkup(
        createElement(Comp, { block: assetBlock('chart', 'chart', { type: 'bar', data: { x: 1 } }) }),
      );
      expect(bad).toContain('pp-chart-empty');
      // 空数组
      const emptyArr = renderToStaticMarkup(
        createElement(Comp, { block: assetBlock('chart', 'chart', { type: 'bar', data: [] }) }),
      );
      expect(emptyArr).toContain('pp-chart-empty');
    });
  });

  it('chart [{label,value}] 对象数组形状仍工作（既有契约）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chart', 'chart')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('chart', 'chart', { type: 'bar', data: [{ label: 'a', value: 3 }] }),
        }),
      );
      expect(html).toContain('pp-chart-bar');
      expect(html).toContain('a');
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

  it('form 渲染 options 与 confirmLabel（实时卡带活回调）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('confirm', 'form')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: {
            ...assetBlock('confirm', 'form', {
              title: '请确认',
              body: '正文',
              options: [{ label: 'A', description: 'desc' }],
              confirmLabel: '执行',
            }),
            asset: { assetId: 'as_1', presentation: 'form', title: 't', finalised: true, _confirm: () => {} },
          },
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

  it('graph 分层布局（A5 二期）：链式 DAG 按层排布、节点/边齐全、确定性', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('deps_impact', 'graph')!;
      const block = assetBlock('deps_impact', 'graph', {
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
          { id: 'd', label: 'D' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'a', to: 'd' },
        ],
      });
      const h1 = renderToStaticMarkup(createElement(Comp, { block }));
      const h2 = renderToStaticMarkup(createElement(Comp, { block }));
      expect(h1).toBe(h2);
      // 4 节点 3 边全渲染
      expect(h1.match(/pp-graph-node-box/g)?.length).toBe(4);
      expect(h1.match(/class="pp-graph-edge"/g)?.length).toBe(3);
      // 分层几何：A 第 0 层、B/D 第 1 层、C 第 2 层——translate x 断言层号
      // （x = 层号×160+40；同层 B/D x 相同、y 不同）
      expect(h1).toContain('translate(40, 26)'); // A：层 0 行 0
      expect(h1).toContain('translate(200, 26)'); // B：层 1 行 0（表序先于 D）
      expect(h1).toContain('translate(200, 78)'); // D：层 1 行 1
      expect(h1).toContain('translate(360, 26)'); // C：层 2 行 0
    });
  });

  it('graph 查询式/空数据：渲染「数据不可用」占位，不画空白 SVG（2026-09-06 项 b 回归）', async () => {
    await withRenderers(() => {
      const graph = resolveAssetBlock('deps_impact', 'graph')!;
      // 查询式 payload（只有 nodeId/depth，无直通数据）
      const query = renderToStaticMarkup(
        createElement(graph, { block: assetBlock('deps_impact', 'graph', { nodeId: 'core.ts', depth: 2 }) }),
      );
      expect(query).toContain('pp-graph-empty');
      expect(query).toContain('数据不可用');
      expect(query).not.toContain('<line');
      // 空 nodes 数组
      const empty = renderToStaticMarkup(
        createElement(graph, { block: assetBlock('deps_impact', 'graph', { nodes: [], edges: [] }) }),
      );
      expect(empty).toContain('pp-graph-empty');
      // tree 表现同款占位
      const tree = resolveAssetBlock('deps_impact', 'tree')!;
      const treeEmpty = renderToStaticMarkup(
        createElement(tree, { block: assetBlock('deps_impact', 'tree', { nodeId: 'x' }) }),
      );
      expect(treeEmpty).toContain('pp-graph-empty');
    });
  });

  it('board 渲染列/卡/tone 类名', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('board', 'board')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('board', 'board', {
            columns: [
              { title: '待办', cards: [{ label: '梳理需求', body: '周三前' }] },
              { title: '完成', cards: [{ label: '立项', tone: 'green' }] },
            ],
          }),
        }),
      );
      expect(html).toContain('待办');
      expect(html).toContain('梳理需求');
      expect(html).toContain('pp-board-card-green');
    });
  });

  it('timeline 渲染时标/标题/正文', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('timeline', 'timeline')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('timeline', 'timeline', {
            items: [
              { ts: 'v0.1', title: '立项', body: '首个可用版' },
              { ts: 'v0.2', title: '插件化' },
            ],
          }),
        }),
      );
      expect(html).toContain('v0.1');
      expect(html).toContain('立项');
      expect(html).toContain('首个可用版');
      expect(html).toContain('pp-timeline-node');
    });
  });

  it('form 实时卡（活回调）：选项可点 + 三钮在位；历史卡（无回调）：只读无操作钮', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('confirm', 'form')!;
      const payload = {
        title: '上线确认',
        body: '发布 v2？',
        options: [
          { label: '方案甲', description: '快' },
          { label: '方案乙', description: '稳' },
        ],
        confirmLabel: '发布',
      };
      // 实时卡：asset._confirm 活回调在 → 选项 button + 确认/修改/拒绝钮
      const live = renderToStaticMarkup(
        createElement(Comp, {
          block: {
            ...assetBlock('confirm', 'form', payload),
            asset: {
              assetId: 'as_1',
              presentation: 'form',
              title: 't',
              finalised: true,
              _confirm: () => {},
            },
          },
        }),
      );
      expect(live).toContain('发布');
      expect(live).toContain('方案甲');
      expect(live).toContain('拒绝');
      expect(live).toContain('<button');
      // 历史卡：无回调 → 只读信息面，无操作钮
      const hist = renderToStaticMarkup(createElement(Comp, { block: assetBlock('confirm', 'form', payload) }));
      expect(hist).toContain('上线确认');
      expect(hist).toContain('方案甲');
      expect(hist).not.toContain('拒绝');
      expect(hist).not.toContain('<button');
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
