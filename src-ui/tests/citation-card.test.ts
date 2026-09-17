// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// citation 学术引用卡（scientific-rendering-plan 4B，2026-09）判据：
//   1. kind 注册：citation 进 assetKinds 注册表，show_asset 可生成、list_block_kinds
//      带出 schema；payload 字段集 = BibTeX 元数据（title/authors/year/venue/doi/
//      pmid/arxiv/url/bibtex）。
//   2. render：citation-card 表现原语（标题/作者/venue·年/标识行/BibTeX 折叠）；
//      空数据占位；历史卡无交互钮（引用是既成事实，只读态与活卡同构）。
//   3. measure：citation 体高静态镜像（行高 × 折行行数；BibTeX 默认折叠只计
//      summary 行——展开后 RO 实测兜底）；空数据占位高。
// 协议：docs/plans/scientific-rendering-plan.md §4B + docs/archive/agent-asset-blocks.md
// §2.10（kind 注册一行 = 一种资产）。

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
import { ASSET_DERIVED } from '../src/paper/type-tokens';
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
    asset: { assetId: 'as_1', presentation, title: 'cite', finalised: true },
  };
}

/** 完整引用样例（BibTeX 字段全集） */
const fullPayload = {
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
  year: 2017,
  venue: 'NeurIPS',
  doi: '10.48550/arXiv.1706.03762',
  arxiv: '1706.03762',
  bibtex:
    '@article{vaswani2017attention,\n  title={Attention Is All You Need},\n  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},\n  year={2017}\n}',
};

/* ═══ kind 注册 / 工具通道 ═══ */

describe('citation kind — 注册与工具通道', () => {
  let assetKinds: import('../src/agent/asset-kinds').AssetKindRegistry;
  let createAssetTools: Awaited<ReturnType<typeof import('../src/agent/tools/show-asset')>>['createAssetTools'];
  let getAsset: Awaited<ReturnType<typeof import('../src/agent/asset-store')>>['getAsset'];
  let clearAssetTablesForTests: Awaited<
    ReturnType<typeof import('../src/agent/asset-store')>
  >['clearAssetTablesForTests'];

  beforeEach(async () => {
    const ak = await import('../src/agent/asset-kinds');
    assetKinds = ak.assetKinds;
    const sa = await import('../src/agent/tools/show-asset');
    createAssetTools = sa.createAssetTools;
    const st = await import('../src/agent/asset-store');
    getAsset = st.getAsset;
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    clearAssetTablesForTests();
  });

  it('citation 已注册：atomic、默认表现 citation、presentation 白名单恰一项', () => {
    const def = assetKinds.get('citation');
    expect(def).toBeDefined();
    expect(def?.streamable).toBe('atomic');
    expect(def?.presentations).toEqual(['citation']);
    expect(def?.defaultPresentation).toBe('citation');
  });

  it('show_asset(kind=citation)：资产表落账，presentation 回落默认', async () => {
    const tool = createAssetTools().find((t) => t.name() === 'show_asset')!;
    const out = await tool.execute({ _owner_id: 'o', kind: 'citation', title: 'attention', payload: fullPayload });
    const parsed = JSON.parse(out) as { assetId: string; kind: string; presentation: string; payload: unknown };
    expect(parsed.kind).toBe('citation');
    expect(parsed.presentation).toBe('citation');
    expect(parsed.payload).toEqual(fullPayload);
    const rec = getAsset('o', parsed.assetId);
    expect(rec?.kind).toBe('citation');
    expect(rec?.title).toBe('attention');
  });

  it('list_block_kinds 带出 citation 及其 schema 字段', async () => {
    const tool = createAssetTools().find((t) => t.name() === 'list_block_kinds')!;
    const out = (await tool.execute({})) as string;
    expect(out).toContain('citation [atomic]');
    expect(out).toContain('BibTeX/DOI/PMID/arXiv');
    expect(out).toContain('doi');
    expect(out).toContain('bibtex');
  });
});

/* ═══ render：citation-card 表现原语 ═══ */

describe('composition/renderer-service — citation-card', () => {
  it('kind=citation 解析到 citation 表现组件（默认表现）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('citation', undefined);
      expect(Comp).toBeTypeOf('function');
    });
  });

  it('全字段引用：标题/作者/venue·年/标识行/BibTeX 折叠全在位', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('citation', 'citation')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('citation', fullPayload, 'citation') }),
      );
      expect(html).toContain('pp-citation');
      expect(html).toContain('Attention Is All You Need');
      expect(html).toContain('Ashish Vaswani');
      expect(html).toContain('NeurIPS · 2017');
      expect(html).toContain('DOI');
      expect(html).toContain('10.48550/arXiv.1706.03762');
      expect(html).toContain('arXiv');
      expect(html).toContain('1706.03762');
      // BibTeX 以 <details> 原生折叠（summary 恒可见，原文收在 pre 里）
      expect(html).toContain('<details');
      expect(html).toContain('BibTeX');
      expect(html).toContain('@article');
      expect(html).toContain('pp-citation-bibtex');
    });
  });

  it('作者支持字符串形态（非数组）与 venue-only / year-only 排版', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('citation', 'citation')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, {
          block: assetBlock('citation', { title: 't', authors: '张三、李四', year: 2020 }, 'citation'),
        }),
      );
      expect(html).toContain('张三、李四');
      expect(html).toContain('2020');
    });
  });

  it('空 payload：渲染「数据不可用」占位，不画空卡', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('citation', 'citation')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('citation', {}, 'citation') }));
      expect(html).toContain('pp-citation-empty');
      expect(html).toContain('数据不可用');
    });
  });

  it('历史卡（无回调）只读：无 <button>、无交互钮（引用 = 既成事实）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('citation', 'citation')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('citation', fullPayload, 'citation') }),
      );
      expect(html).not.toContain('<button');
      expect(html).not.toContain('_confirm');
    });
  });
});

/* ═══ measure：citation 体高 ═══ */

describe('paper/measure — citation 块测高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('全字段引用：pad + 标题 + 作者 + venue·年 + 标识行 + BibTeX summary（默认折叠）', () => {
    const h = measureBlockHeight(assetBlock('citation', fullPayload, 'citation'));
    // layout mock 恒 36 → 每行高 = ceil(36 / lineHeight) × lineHeight
    const title = Math.ceil(36 / 21) * 21;
    const author = 3 + Math.ceil(36 / 19) * 19;
    const venue = 3 + Math.ceil(36 / 17) * 17;
    const ids = 6 + Math.ceil(36 / 17) * 17; // 2 标识 × 14 列距从可宽扣除（≤80 回落 80，mock 36 不变）
    const bib = 8 + 5 + 18; // marginTop + border-top/padding-top + summary 行
    expect(h).toBeCloseTo(4 + ASSET_DERIVED.plateHeadH + title + author + venue + ids + bib, 1);
  });

  it('空 payload：占位单行（pad + 30）', () => {
    expect(measureBlockHeight(assetBlock('citation', {}, 'citation'))).toBe(4 + ASSET_DERIVED.plateHeadH + 30);
  });

  it('citation 属资产族 → needsObservedHeight 恒 true（挂载后 RO 实测兜底）', () => {
    expect(needsObservedHeight('citation', true)).toBe(true);
    expect(needsObservedHeight('citation', false)).toBe(true);
  });

  it('presentation 缺失回落默认表现（与 resolveAssetBlock 同判据）', () => {
    // assetBlock('citation', ...) presentation='' 不在白名单 → defaultPresentation
    const h = measureBlockHeight(assetBlock('citation', fullPayload));
    const h2 = measureBlockHeight(assetBlock('citation', fullPayload, 'citation'));
    expect(h).toBe(h2);
  });

  it('畸形 payload 不崩：title 非字符串按空处理（唯一字段丢 → 占位；另有标识 → 保标识行）', () => {
    // title: 42（非 string）→ 按无标题；无其它字段 → 空卡占位
    expect(measureBlockHeight(assetBlock('citation', { title: 42 }, 'citation'))).toBe(
      4 + ASSET_DERIVED.plateHeadH + 30,
    );
    // 畸形标题 + 合法 doi：标题丢但标识行保留（错误不静默——信息面不整块消失）
    const h = measureBlockHeight(assetBlock('citation', { title: 42, doi: 'x' }, 'citation'));
    expect(h).toBe(4 + ASSET_DERIVED.plateHeadH + 6 + Math.ceil(36 / 17) * 17); // ids marginTop + 标识行（mock 36）
  });
});

describe('measure 缓存签名 — citation 表现名入签', () => {
  beforeEach(() => {
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });
  it('citation 签名走 open 分支（kind + presentation 入签）', () => {
    const a = measureSignature(assetBlock('citation', fullPayload, 'citation'));
    expect(a).toContain('open|citation|citation');
    // presentation 是签名一部分（换皮肤 = 高度信号）
    const b = measureSignature(assetBlock('citation', fullPayload, ''));
    expect(b).not.toBe(a);
  });
});
