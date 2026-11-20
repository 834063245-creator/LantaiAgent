// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布卡长按引用后，**落点写进哪一卷**（2026-11-20 用户要：摊开状态的卡也能长按）。
// 与坞里那枚夹签的长按共用同一条写入口（moveAttachedCardToSlot），差别只在：
// 画布卡不属于任何槽 ⇒ 落在哪一卷就写进哪一卷，包括它自己来源的那一卷。

import { beforeEach, describe, expect, it } from 'vitest';
import { createBlock } from '../src/paper/block-model';
import { quoteCardOf } from '../src/plugins/builtin/paper-shell/card-quote-of';
import type { QuoteCard } from '../src/state/card-quote';
import { getInputStore } from '../src/state/input-store';

let seq = 0;
const freshPanel = (): string => `canvas-hold-${seq++}-${Date.now()}`;

function assetBlock(assetId = 'as_a') {
  return createBlock(
    'html',
    { code: '<b>x</b>' } as never,
    { messageId: '', part: null },
    { asset: { assetId, presentation: 'html', title: '示例', finalised: true } },
  );
}

describe('画布卡长按 → 落进某卷的槽', () => {
  let storeId: string;
  beforeEach(() => {
    localStorage.clear();
    storeId = freshPanel();
    getInputStore(storeId).getState().claimLive('s:1');
  });

  it('落在**本卷**也写进去（画布卡不属于任何槽，本卷就是它的去处）', () => {
    const card = quoteCardOf(assetBlock(), 1)!;
    const input = getInputStore(storeId);
    // 画布卡不在 live 槽里 ⇒ move 也只是一次「摘掉不存在的那枚 + 写目标」
    expect(input.getState().moveAttachedCardToSlot('s:1', card)).toBe('moved');
    // 落本卷后它进了 s:1 的草稿槽（因为 liveOwner 也是 s:1，切走再回来才看得见）
    expect(input.getState().sessionDrafts['s:1']?.attachedCards.map((c) => c.refId)).toEqual([card.refId]);
  });

  it('落在别的卷：写进那一卷，活跃卷不变', () => {
    const card: QuoteCard = quoteCardOf(assetBlock(), 1)!;
    const input = getInputStore(storeId);
    input.getState().moveAttachedCardToSlot('s:2', card);
    expect(input.getState().sessionDrafts['s:2']?.attachedCards).toHaveLength(1);
    expect(input.getState().liveOwner).toBe('s:1');
    // live 那份没被动过（画布卡本来也不在 live 里）
    expect(input.getState().attachedCards).toEqual([]);
  });

  it('同一张卡在同一卷只留一枚（长按两次不堆叠）', () => {
    const input = getInputStore(storeId);
    input.getState().moveAttachedCardToSlot('s:2', quoteCardOf(assetBlock(), 1)!);
    const second = input.getState().moveAttachedCardToSlot('s:2', quoteCardOf(assetBlock(), 1)!);
    expect(second).toBe('duplicate');
    expect(input.getState().sessionDrafts['s:2']?.attachedCards).toHaveLength(1);
  });

  it('非资产块（正文段）拿不到夹签 ⇒ 长按无从起手', () => {
    const plain = createBlock('markdown', { text: '正文' } as never, { messageId: '', part: null });
    expect(quoteCardOf(plain, 1)).toBeNull();
  });
});
