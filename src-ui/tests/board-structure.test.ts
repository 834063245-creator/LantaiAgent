// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// board 题签与列**不得同级**（2026-11-20 真机塌陷回归）。
//
// 事故：2026-09-17「题签行铺到 board」把 <PlateHead> 塞进 `.pp-board`，而 `.pp-board`
// 当时是 display:flex 的行容器 ⇒ 题签成了第 1 个 flex 子项：列 2..n 各分一份宽，
// 列 1 被压到题签下方一条 ~15px 窄条（标题按纵向 IFC 单字一行），max-content 撑到
// 版心外，整块高还要按列数叠——真机 4 列 = 4×内容高，卡片全被推到块外（用户读作
// 「看板渲染崩了」）。所有已有测试只查类名在场，结构塌陷无感 ⇒ 本文件钉结构。
//
// 判据（可证伪旧实现）：题签行必须是 .pp-board 的**直接子节点之一**且不参与列行；
// 列必须挂在独立的 .pp-board-cols 行容器下。旧实现两列都在 .pp-board 直下 ⇒ 红。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 测高用例要走真 measure：它依赖 Canvas 2D（jsdom / node 都没有）⇒ 照
// paper-asset-overflow.test.ts 的既有范式 mock pretext（mock 文本恒 36 高 / 2 行）。
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn(() => ({})),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { paperRenderersPlugin } from '../src/plugins/builtin/paper-renderers';
import { measureBlockHeight } from '../src/plugins/builtin/paper-shell/measure';
import { ASSET_DERIVED } from '../src/plugins/builtin/paper-shell/type-tokens';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { readPanelCss } from './helpers/panel-css';

function assetBlock(kind: string, presentation: string, payload: unknown, w = 720): SourcedBlock {
  return {
    ...createBlock(kind, payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    w,
    asset: { assetId: 'as_1', presentation, title: 't', finalised: true },
  };
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  const f4 = ctx.plugin(paperRenderersPlugin);
  await f4;
  await fn();
  await f4.dispose();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

const COLUMNS = [
  { title: '旧系统去向', cards: [{ label: '角色编排', body: '旧 1561 行 → 分发器' }] },
  { title: '已建成', cards: [{ label: 'quality_gate', tone: 'green', body: '规则全在' }] },
  { title: '没建', cards: [{ label: 'GUI 6 页面', tone: 'danger' }] },
];

describe('board 结构：题签行与列行走两条道（列不得与题签同级）', () => {
  it('渲染：题签行是 .pp-board 直下，列挂在 .pp-board-cols 之下', async () => {
    await withRenderers(() => {
      const Comp = resolveAssetBlock('board', 'board')!;
      const html = renderToStaticMarkup(
        createElement(Comp, {
          block: assetBlock('board', 'board', { columns: COLUMNS, caption: '旧系统模块去向' }),
        }),
      );
      // 骨架构型（去空白后逐字比对——旧实现的 <div class="pp-board"><div class="pp-plate"> 直接红）
      const skeleton = html.replace(/<!--[^>]*-->/g, '').replace(/>\s+</g, '><');
      expect(skeleton).toContain('<div class="pp-board"><div class="pp-plate">');
      expect(skeleton).toContain('<div class="pp-board-cols">');
      // 列行是独立容器：所有列都在 .pp-board-cols 里，题签行不在列容器内
      const colsOpen = skeleton.indexOf('<div class="pp-board-cols">');
      const firstCol = skeleton.indexOf('<div class="pp-board-col">');
      const plate = skeleton.indexOf('<div class="pp-plate">');
      expect(colsOpen).toBeGreaterThan(-1);
      expect(firstCol).toBeGreaterThan(colsOpen); // 列在行容器之后
      expect(plate).toBeLessThan(colsOpen); // 题签行在列行之前（不参与列行）
      expect(skeleton).not.toContain(
        'pp-board-cols"><div class="pp-board-col"><div class="pp-board-col-title">旧系统去向</div></div>',
      );
      // 三列都在行容器里（不得有一列被挤到题签同级的行里）
      const colsSegment = skeleton.slice(colsOpen);
      expect((colsSegment.match(/class="pp-board-col"/g) ?? []).length).toBe(COLUMNS.length);
    });
  });

  it('CSS：.pp-board 不再是 flex 行（题签不会被当成 flex 子项压窄），横向滚动归 .pp-board-cols', () => {
    const css = readPanelCss();
    const boardAt = css.indexOf('.pp-board {');
    expect(boardAt).toBeGreaterThan(-1);
    const boardRule = css.slice(boardAt, css.indexOf('}', boardAt));
    expect(boardRule).not.toContain('display: flex'); // 旧实现这里就是 flex ⇒ 红
    expect(boardRule).not.toContain('gap:');
    const colsAt = css.indexOf('.pp-board-cols {');
    expect(colsAt).toBeGreaterThan(-1);
    const colsRule = css.slice(colsAt, css.indexOf('}', colsAt));
    expect(colsRule).toContain('display: flex');
    expect(colsRule).toContain('gap: var(--pp-asset-board-colGap)');
    expect(colsRule).toContain('overflow-x: auto');
  });

  it('测高：题签行只计一次，列高 = 列内卡片订单累加（不随列数叠）', () => {
    // 体高公式 = PAD + 题签行 + 最高列。旧实现的塌陷形态里题签行与列同处一条 flex 行
    // ⇒ 列被压成窄条（每列每行一字）、块高按「列数 × 纵向字数」叠。鉴别两条：
    //   ① 同一列加 3 张卡，体高只该涨「3 张卡」的钱（不是整块翻倍）；
    //   ② 列数从 1 加到 3（各列内容相同）时体高一动不动——公式取最大列，不累加。
    const card = (i: number) => ({ label: `卡${i}`, body: `内容${i}` });
    const oneCol = { columns: [{ title: '旧系统去向', cards: [card(1)] }] };
    const oneColWide = { columns: [{ title: '旧系统去向', cards: [card(1), card(2), card(3), card(4)] }] };
    const threeCols = {
      columns: [
        { title: '旧系统去向', cards: [card(1)] },
        { title: '已建成', cards: [card(2)] },
        { title: '没建', cards: [card(3)] },
      ],
    };
    const fixed = ASSET_DERIVED.boardPadV + ASSET_DERIVED.plateHeadH;
    const h1 = measureBlockHeight(assetBlock('board', 'board', oneCol));
    const h4 = measureBlockHeight(assetBlock('board', 'board', oneColWide));
    const h3 = measureBlockHeight(assetBlock('board', 'board', threeCols));
    expect(h1).toBeGreaterThan(fixed); // 题签行 + 列高都在
    expect(h4, '多 3 张卡只涨 3 张卡的钱').toBeGreaterThan(h1);
    expect(h4).toBeLessThan(h1 + 3 * (h1 - fixed)); // 不按「整块翻倍」的方式叠
    // 三列内容与单列首列等价 ⇒ 体高与单列同值（取最大列，不累加）
    expect(h3).toBeCloseTo(h1, 5);
  });
});
