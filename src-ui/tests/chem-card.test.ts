// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// chem 化学式/反应卡（scientific-rendering-plan #10，2026-09）判据：
//   1. kind 注册：chem 进 assetKinds 注册表，show_asset 可生成、list_block_kinds
//      带出 schema；payload 字段集 = name/formula/smiles（三字段，可空）。
//   2. render：chem-body 表现原语（展示名宋体 + SMILES 结构固定盒 + formula
//      mono 行）；空数据占位；无交互钮（化学式 = 既成事实，只读态与活卡同构）；
//      smiles 解析失败错误可见不崩（错误行 + formula 兜底仍在）。
//   3. measure：chem 体高静态镜像——name 行 + 结构固定盒（boxH 含 border）+
//      formula 行；smiles-drawer SVG 只写 viewBox 不写尺寸 → 盒高恒定与分子
//      无关（非媒体图那类动态高）；空数据占位高。
//   4. smiles-drawer 真解析（Node 域不碰 DOM）：parse 成功回调能收到解析树
//      （渲染端 effect 挂载后 draw 到 svg——真实结构图交真机验收）。
// 协议：docs/plans/scientific-rendering-plan.md §5.6 #10 + §0.1 对拍表 #10 +
// docs/archive/agent-asset-blocks.md §2.10（kind 注册一行 = 一种资产）。

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
    asset: { assetId: 'as_1', presentation, title: 'chem', finalised: true },
  };
}

/** 完整化学样例（name+formula+smiles 三字段；阿司匹林） */
const fullPayload = {
  name: '阿司匹林（乙酰水杨酸）',
  formula: 'C9H8O4',
  smiles: 'CC(=O)Oc1ccccc1C(=O)O',
};

/** 反应式样例（SMILES 反应 A>>B，smiles-drawer ReactionParser 语义） */
const reactionPayload = {
  name: '酯化反应',
  smiles: 'CC(=O)O.CO>>CC(=O)OC',
};

/* ═══ kind 注册 / 工具通道 ═══ */

describe('chem kind — 注册与工具通道', () => {
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

  it('chem 已注册：atomic、默认表现 chem、presentation 白名单恰一项', () => {
    const def = assetKinds.get('chem');
    expect(def).toBeDefined();
    expect(def?.streamable).toBe('atomic');
    expect(def?.presentations).toEqual(['chem']);
    expect(def?.defaultPresentation).toBe('chem');
  });

  it('show_asset(kind=chem)：资产表落账，presentation 回落默认', async () => {
    const tool = createAssetTools().find((t) => t.name() === 'show_asset')!;
    const out = await tool.execute({ _owner_id: 'o', kind: 'chem', title: 'aspirin', payload: fullPayload });
    const parsed = JSON.parse(out) as { assetId: string; kind: string; presentation: string; payload: unknown };
    expect(parsed.kind).toBe('chem');
    expect(parsed.presentation).toBe('chem');
    expect(parsed.payload).toEqual(fullPayload);
    const rec = getAsset('o', parsed.assetId);
    expect(rec?.kind).toBe('chem');
    expect(rec?.title).toBe('aspirin');
  });

  it('list_block_kinds 带出 chem 及其 schema 字段', async () => {
    const tool = createAssetTools().find((t) => t.name() === 'list_block_kinds')!;
    const out = (await tool.execute({})) as string;
    expect(out).toContain('chem [atomic]');
    expect(out).toContain('SMILES');
    expect(out).toContain('formula');
    expect(out).toContain('smiles');
  });
});

/* ═══ render：chem-body 表现原语 ═══ */

describe('composition/renderer-service — chem-body', () => {
  it('kind=chem 解析到 chem 表现组件（默认表现）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chem', undefined);
      expect(Comp).toBeTypeOf('function');
    });
  });

  it('全字段化学卡：name/formula 在壳内、结构区为固定盒 svg 容器（绘制走 effect，SSR 空盒）', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chem', 'chem')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chem', fullPayload, 'chem') }));
      expect(html).toContain('pp-chem');
      expect(html).toContain('阿司匹林（乙酰水杨酸）');
      expect(html).toContain('C9H8O4');
      // 结构区：pp-chem-box 固定盒内一个空 svg（无 effect → 未绘制；挂载后 draw）
      expect(html).toContain('pp-chem-box');
      expect(html).toContain('<svg');
      // 无交互钮（化学式 = 既成事实，只读态与活卡同构）
      expect(html).not.toContain('<button');
    });
  });

  it('反应式 SMILES（A>>B）走同一渲染壳：盒 + 无 formula 时不出现 meta 区', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chem', 'chem')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chem', reactionPayload, 'chem') }));
      expect(html).toContain('酯化反应');
      expect(html).toContain('pp-chem-box');
      expect(html).not.toContain('pp-chem-formula');
    });
  });

  it('formula-only（无 smiles）：无结构盒，纯文本分子式呈现', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chem', 'chem')!;
      const html = renderToStaticMarkup(
        createElement(Comp!, { block: assetBlock('chem', { formula: 'H2O' }, 'chem') }),
      );
      expect(html).toContain('pp-chem');
      expect(html).toContain('H2O');
      expect(html).not.toContain('pp-chem-box');
    });
  });

  it('空 payload：渲染「数据不可用」占位，不画空卡', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('chem', 'chem')!;
      const html = renderToStaticMarkup(createElement(Comp!, { block: assetBlock('chem', {}, 'chem') }));
      expect(html).toContain('pp-chem-empty');
      expect(html).toContain('数据不可用');
    });
  });
});

/* ═══ smiles-drawer 真解析（Node 域）═══ */

describe('smiles-drawer 依赖面 — 解析在 Node 域可用', () => {
  it('普通分子式与反应式都能解析出树（渲染端 effect 才 draw）', async () => {
    const sd = (await import('smiles-drawer')).default;
    const parseMol = (s: string) =>
      new Promise<unknown>((res, rej) => {
        sd.parse(
          s,
          (tree) => res(tree),
          (e: Error) => rej(e),
        );
      });
    const t1 = await parseMol(fullPayload.smiles);
    expect(t1).toBeTruthy();
    const parseRx = (s: string) =>
      new Promise<unknown>((res, rej) => {
        sd.parseReaction(
          s,
          (r) => res(r),
          (e: Error) => rej(e),
        );
      });
    const t2 = await parseRx(reactionPayload.smiles);
    expect(t2).toBeTruthy();
  });

  it('畸形 SMILES parse 走错误回调（渲染端错误行可见不崩）', async () => {
    const sd = (await import('smiles-drawer')).default;
    await expect(
      new Promise((_res, rej) => {
        sd.parse(
          'CC(=O)Oc1ccccc1C(=O',
          () => {
            rej(new Error('畸形 SMILES 竟解析成功'));
          },
          (e: Error) => rej(e),
        );
      }),
    ).rejects.toBeTruthy();
  });
});

/* ═══ measure：chem 块测高 ═══ */

describe('paper/measure — chem 块测高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('全字段化学卡：pad + name 行（实测折行，mock 36→2 行高 40 + 下距）+ 结构固定盒（含下距）+ formula 行（实测，mock 36→2 行高 34）', () => {
    const h = measureBlockHeight(assetBlock('chem', fullPayload, 'chem'));
    const name = Math.ceil(36 / 20) * 20 + 6; // mock layout 36 / nameLine 20 → 2 行 40 + nameMarginB 6
    const box = 180 + 6; // boxH 180（含 border）+ boxMarginB 6
    const meta = Math.ceil(36 / 17) * 17; // mock 36 / metaLine 17 → 2 行 34
    expect(h).toBeCloseTo(4 + ASSET_DERIVED.plateHeadH + name + box + meta, 1); // chemPadV 2×2
  });

  it('smiles-only：pad + 结构固定盒（末元素无下距）', () => {
    const h = measureBlockHeight(assetBlock('chem', { smiles: 'CCO' }, 'chem'));
    expect(h).toBeCloseTo(4 + ASSET_DERIVED.plateHeadH + 180, 1);
  });

  it('formula-only：pad + formula 行（实测，mock 36→2 行高 34）', () => {
    const h = measureBlockHeight(assetBlock('chem', { formula: 'H2O' }, 'chem'));
    expect(h).toBeCloseTo(4 + ASSET_DERIVED.plateHeadH + Math.ceil(36 / 17) * 17, 1);
  });

  it('name-only：pad + name 行（实测折行，mock 36→2 行高 40；末元素无下距）', () => {
    const h = measureBlockHeight(assetBlock('chem', { name: '乙醇' }, 'chem'));
    expect(h).toBeCloseTo(4 + ASSET_DERIVED.plateHeadH + Math.ceil(36 / 20) * 20, 1);
  });

  it('空 payload：占位单行（pad + 30）', () => {
    expect(measureBlockHeight(assetBlock('chem', {}, 'chem'))).toBe(4 + ASSET_DERIVED.plateHeadH + 30);
  });

  it('chem 属资产族 → needsObservedHeight 恒 true（挂载后 RO 实测兜底）', () => {
    expect(needsObservedHeight('chem', true)).toBe(true);
    expect(needsObservedHeight('chem', false)).toBe(true);
  });

  it('presentation 缺失回落默认表现（与 resolveAssetBlock 同判据）', () => {
    const h = measureBlockHeight(assetBlock('chem', fullPayload));
    const h2 = measureBlockHeight(assetBlock('chem', fullPayload, 'chem'));
    expect(h).toBe(h2);
  });

  it('畸形 payload 不崩：name 非字符串按空处理（唯一字段丢 → 占位）', () => {
    expect(measureBlockHeight(assetBlock('chem', { name: 42 }, 'chem'))).toBe(4 + ASSET_DERIVED.plateHeadH + 30);
    // 畸形 name + 合法 formula：name 丢但 formula 行保留（错误不静默——信息面不整块消失）
    expect(measureBlockHeight(assetBlock('chem', { name: 42, formula: 'H2O' }, 'chem'))).toBe(
      ASSET_DERIVED.plateHeadH + 4 + Math.ceil(36 / 17) * 17,
    );
  });
});

describe('measure 缓存签名 — chem 表现名入签', () => {
  beforeEach(() => {
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });
  it('chem 签名走 open 分支（kind + presentation 入签）', () => {
    const a = measureSignature(assetBlock('chem', fullPayload, 'chem'));
    expect(a).toContain('open|chem|chem');
    // presentation 是签名一部分（换皮肤 = 高度信号）
    const b = measureSignature(assetBlock('chem', fullPayload, ''));
    expect(b).not.toBe(a);
  });
});
