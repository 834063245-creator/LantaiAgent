// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 「递给别的卷」的**归属落点**（docs/plans/card-quote-plan.md §2.3 / §8）：
// 长按拖到 B 卷松手 = 写进 B 卷的草稿槽，**不切活跃卷、不动 live 那一份**。
// 这里把坞里的接线（addAttachedCardToSlot）与 input-store 的既有语义对起来测。

import { beforeEach, describe, expect, it } from 'vitest';
import type { QuoteCard } from '../src/state/card-quote';
import { getInputStore } from '../src/state/input-store';

let seq = 0;
const freshPanel = (): string => `quote-drop-slot-${seq++}-${Date.now()}`;

const card = (assetId: string): QuoteCard => ({
  refId: `q-${assetId}`,
  origin: 'session',
  assetId,
  sourceSessionId: '1',
  kind: 'html',
  title: '',
  bytes: 4,
  at: '2026-11-20T02:00:00.000Z',
});

describe('递给另一卷 = 只写那一卷的槽', () => {
  let storeId: string;
  beforeEach(() => {
    localStorage.clear();
    storeId = freshPanel();
    getInputStore(storeId).getState().claimLive('s:1');
    getInputStore(storeId).getState().addAttachedCard(card('as_a'));
  });

  it('递出去那一枚进 B 卷草稿槽；A 卷 live 原样、活跃卷不变', () => {
    const input = getInputStore(storeId);
    expect(input.getState().addAttachedCardToSlot('s:2', card('as_a'))).toBe(true);

    // live（A 卷）没被动过——这正是「不抢焦点」的实现本身
    expect(input.getState().attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
    expect(input.getState().liveOwner).toBe('s:1');
    // B 卷槽里有了
    expect(input.getState().sessionDrafts['s:2']?.attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
  });

  it('递完原卷那枚**不消失**（拓印不是搬家：同一张卡可以在两卷各有一枚）', () => {
    const input = getInputStore(storeId);
    input.getState().addAttachedCardToSlot('s:2', card('as_a'));
    expect(input.getState().attachedCards).toHaveLength(1);
    // 切到 B：看得见那一枚；切回 A：还在
    input.getState().claimLive('s:2');
    expect(input.getState().attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
    input.getState().claimLive('s:1');
    expect(input.getState().attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
  });

  it('B 卷已有同一张卡 ⇒ 不重复投（返回 false，槽里仍只有一枚）', () => {
    const input = getInputStore(storeId);
    expect(input.getState().addAttachedCardToSlot('s:2', card('as_a'))).toBe(true);
    expect(getInputStore(storeId).getState().addAttachedCardToSlot('s:2', card('as_a'))).toBe(false);
    expect(getInputStore(storeId).getState().sessionDrafts['s:2']?.attachedCards).toHaveLength(1);
  });
});
