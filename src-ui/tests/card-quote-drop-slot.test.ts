// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 长按把夹签拖给另一卷 = **挪**（docs/plans/card-quote-plan.md §2.2 态二 / §2.3）。
//
// 2026-11-20 用户报：「引用的夹签被长按拖给另外的会话，原位置上的夹签是不是应该消失了」。
// 是——卡本体早就在画布上（那才是拓印，方案 §1），夹签本身只有一枚：拖走 = 换归属。
// 旧实现调 `addAttachedCardToSlot`（只写不摘），原位那枚留在原地，读作「没挪动」。

import { beforeEach, describe, expect, it } from 'vitest';
import type { QuoteCard } from '../src/state/card-quote';
import { getInputStore } from '../src/state/input-store';

let seq = 0;
const freshPanel = (): string => `quote-drop-slot-${seq++}-${Date.now()}`;

const card = (assetId: string, over: Partial<QuoteCard> = {}): QuoteCard => ({
  refId: `q-${assetId}`,
  origin: 'session',
  assetId,
  sourceSessionId: '1',
  kind: 'html',
  title: '',
  bytes: 4,
  at: '2026-11-20T02:00:00.000Z',
  ...over,
});

describe('递给另一卷 = 挪（原位不再有）', () => {
  let storeId: string;
  beforeEach(() => {
    localStorage.clear();
    storeId = freshPanel();
    getInputStore(storeId).getState().claimLive('s:1');
    getInputStore(storeId).getState().addAttachedCard(card('as_a'));
  });

  it('挪成：原位摘掉 + 目标槽出现这一枚；活跃卷与 live 不切', () => {
    const input = getInputStore(storeId);
    expect(input.getState().moveAttachedCardToSlot('s:2', card('as_a'))).toBe('moved');

    // ① 原位没了 —— 这正是用户报的那条
    expect(input.getState().attachedCards).toEqual([]);
    // ② 目标槽里有
    expect(input.getState().sessionDrafts['s:2']?.attachedCards.map((c) => c.refId)).toEqual(['q-as_a']);
    // ③ 没有偷偷切活跃卷 / 改归属
    expect(input.getState().liveOwner).toBe('s:1');

    // 切过去看得见、切回来不再有
    input.getState().claimLive('s:2');
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_a']);
    input.getState().claimLive('s:1');
    expect(getInputStore(storeId).getState().attachedCards).toEqual([]);
  });

  it('目标卷已有同一张卡：不重复加，但**原位照样摘掉**（用户意思就是给它）', () => {
    const input = getInputStore(storeId);
    input.getState().addAttachedCardToSlot('s:2', card('as_a', { refId: 'q-other' }));
    expect(input.getState().moveAttachedCardToSlot('s:2', card('as_a'))).toBe('duplicate');
    expect(input.getState().attachedCards, '原位还留着 = 用户以为没挪动').toEqual([]);
    expect(input.getState().sessionDrafts['s:2']?.attachedCards).toHaveLength(1);
  });

  it('挪的是**这一枚**（同卡另有一枚不同 refId 时不误删）', () => {
    const input = getInputStore(storeId);
    input.getState().setAttachedCards([card('as_a', { refId: 'q-1' })]); // 槽里只剩 q-1
    input.getState().moveAttachedCardToSlot('s:2', card('as_a', { refId: 'q-other' }));
    // 挪的那一枚不在 live 里 ⇒ live 原样（不能把别的枚当它删掉）
    expect(input.getState().attachedCards.map((c) => c.refId)).toEqual(['q-1']);
  });

  it('两卷各持有自己的夹签时互不干扰', () => {
    const input = getInputStore(storeId);
    input.getState().claimLive('s:2');
    input.getState().addAttachedCard(card('as_b'));
    input.getState().claimLive('s:1');
    // A 卷那枚挪给 3 卷
    input.getState().moveAttachedCardToSlot('s:3', card('as_a'));
    expect(input.getState().attachedCards).toEqual([]);
    input.getState().claimLive('s:2');
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_b']);
  });
});
