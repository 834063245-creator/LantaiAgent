// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 「已经摊开的卡也要能引用」（2026-11-20 用户报）。
//
// 病灶：孤儿钉（源卷未摊开 / 源块已不在流内 / 源卷已删 / **从架阁摊上来的卡**）
// 在 PaperPanel 里一律 `ops={EMPTY_OPS}`——它们没有活消息，按消息建表的
// `opsByBlock` 根本到不了。而「入阁 / 引用」只认**资产身份**，与消息无关。
//
// 修法：判据抽成 `assetOpsOf`（活块与孤儿钉共用一份），孤儿钉那份在装配根算好后
// 经 `orphanOps` 下发。本测钉判据本身。

import { describe, expect, it, vi } from 'vitest';
import { createBlock } from '../src/paper/block-model';
import { assetOpsOf } from '../src/plugins/builtin/paper-shell/use-block-ops';

/** 一张资产卡（有 asset 元数据）。 */
function assetBlock(over: { cardId?: string; assetId?: string } = {}) {
  return createBlock(
    'table',
    { columns: ['a'], rows: [[1]] } as never,
    { messageId: '', part: null },
    {
      asset: {
        assetId: over.assetId ?? 'as_1',
        presentation: 'table',
        title: '示例',
        finalised: true,
        ...(over.cardId !== undefined ? { cardId: over.cardId } : {}),
      },
    },
  );
}

describe('资产动作行（入阁 / 引用）', () => {
  it('有 asset 且有回调 ⇒ 两件都在，顺序 = 入阁在前、引用在后', () => {
    const ops = assetOpsOf(assetBlock(), 3, { onShelve: vi.fn(), onQuote: vi.fn(), quoteReady: true });
    expect(ops.map((o) => o.key)).toEqual(['shelve', 'quote']);
    expect(ops.map((o) => o.label)).toEqual(['入阁', '引用']);
    expect(ops.every((o) => !o.disabled)).toBe(true);
  });

  it('没地方可落（无卷无纸）⇒ 「引用」置灰并给具名原因（不是消失）', () => {
    const ops = assetOpsOf(assetBlock(), 3, { onQuote: vi.fn(), quoteReady: false });
    const quote = ops.find((o) => o.key === 'quote')!;
    expect(quote.disabled).toBe(true);
    expect(quote.title).toContain('先展开一卷或落一张纸');
  });

  it('**架阁摊上来的卡**（只有 cardId）同样出「引用」——这正是用户报的那一批', () => {
    const ops = assetOpsOf(assetBlock({ cardId: 'card-1', assetId: 'card:card-1' }), -1, {
      onQuote: vi.fn(),
      quoteReady: true,
    });
    expect(ops.map((o) => o.key)).toEqual(['quote']);
  });

  it('没有资产身份的块（正文段 / 工具卡）不出这两件', () => {
    const plain = createBlock('markdown', { text: '正文' } as never, { messageId: '', part: null });
    expect(assetOpsOf(plain, 1, { onShelve: vi.fn(), onQuote: vi.fn(), quoteReady: true })).toEqual([]);
  });

  it('回调缺席 = 不出那一件（能力位语义：旧宿主/测试桩零改动）', () => {
    expect(assetOpsOf(assetBlock(), 1, { quoteReady: true }).map((o) => o.key)).toEqual([]);
    expect(assetOpsOf(assetBlock(), 1, { onQuote: vi.fn(), quoteReady: true }).map((o) => o.key)).toEqual(['quote']);
  });

  it('点击取的是 **resolve() 那一刻**的块（流式期间闭包里的可能是旧快照）', () => {
    const stale = assetBlock({ assetId: 'as_old' });
    const fresh = assetBlock({ assetId: 'as_new' });
    const onQuote = vi.fn();
    const ops = assetOpsOf(stale, 1, { onQuote, quoteReady: true }, () => fresh);
    ops.find((o) => o.key === 'quote')!.run();
    expect(onQuote).toHaveBeenCalledWith(fresh, 1);
  });

  it('孤儿钉缺省不传 resolve ⇒ 用入参那一枚（没有更版）', () => {
    const block = assetBlock();
    const onShelve = vi.fn();
    assetOpsOf(block, -1, { onShelve })
      .find((o) => o.key === 'shelve')!
      .run();
    expect(onShelve).toHaveBeenCalledWith(block, -1);
  });
});
