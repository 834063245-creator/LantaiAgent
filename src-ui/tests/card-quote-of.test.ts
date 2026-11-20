// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 一块卡 → 一枚夹签（docs/plans/card-quote-plan.md §3.1/§3.4）。
//
// 关键分路：**架阁摊上来的卡**记成 shelf 来源（payload 在卡片库里），卷内卡记成
// session 来源（payload 在会话资产表）。记错来源不会当场报错——发送期会静默降级成
// 「未落快照」，用户读到的是「引用了却什么都没给模型」。

import { describe, expect, it } from 'vitest';
import { createBlock } from '../src/paper/block-model';
import { quoteCardOf } from '../src/plugins/builtin/paper-shell/card-quote-of';

const AT = new Date(2026, 10, 20, 11, 5, 0);

function block(over: { cardId?: string; assetId?: string; title?: string } = {}) {
  return createBlock(
    'table',
    { columns: ['a'], rows: [[1]] } as never,
    { messageId: '', part: null },
    {
      asset: {
        assetId: over.assetId ?? 'as_1',
        presentation: 'table',
        ...(over.title !== undefined ? { title: over.title } : {}),
        finalised: true,
        ...(over.cardId !== undefined ? { cardId: over.cardId } : {}),
      },
    },
  );
}

describe('块 → 夹签', () => {
  it('卷内卡：origin=session，地址 = assetId + 来源卷', () => {
    const card = quoteCardOf(block({ assetId: 'as_9', title: '示例' }), 7, AT)!;
    expect(card).toMatchObject({
      origin: 'session',
      assetId: 'as_9',
      sourceSessionId: '7',
      kind: 'table',
      title: '示例',
    });
    expect(card.cardId).toBeUndefined();
    expect(card.at).toBe(AT.toISOString());
    expect(card.bytes).toBeGreaterThan(0);
  });

  it('**架阁摊上来的卡**：origin=shelf，地址 = cardId（不是 assetId）', () => {
    const card = quoteCardOf(block({ cardId: 'card-1', assetId: 'card:card-1' }), -1, AT)!;
    expect(card.origin).toBe('shelf');
    expect(card.cardId).toBe('card-1');
    // shelf 来源不许带会话资产地址——那会让发送面去会话表里找一个不存在的资产
    expect(card.assetId).toBeUndefined();
    expect(card.sourceSessionId).toBeUndefined();
  });

  it('没有资产身份 ⇒ null（正文段 / 工具卡不该进夹签槽）', () => {
    const plain = createBlock('markdown', { text: '正文' } as never, { messageId: '', part: null });
    expect(quoteCardOf(plain, 1, AT)).toBeNull();
  });

  it('标题缺省 = 空串（未命名卡也能引用，摘要里回落「未命名」）', () => {
    expect(quoteCardOf(block(), 1, AT)!.title).toBe('');
  });

  it('refId 每次都新发（同一张卡引用两次 = 两枚，去重靠卡身份不靠 refId）', () => {
    const a = quoteCardOf(block(), 1, AT)!;
    const b = quoteCardOf(block(), 1, AT)!;
    expect(a.refId).not.toBe(b.refId);
    expect(a.assetId).toBe(b.assetId);
  });
});
