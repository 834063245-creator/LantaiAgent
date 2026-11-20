// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 夹签槽的**归属**语义（docs/plans/card-quote-plan.md §2.3/§3.2/§9.1）：
// 槽是每卷一份、随草稿换手——最容易漏的一条正是「换手后夹签还在不在」。
// 直接测 input-store 的纯 zustand 原语（无需 DOM / Agent）。

import { beforeEach, describe, expect, it } from 'vitest';
import type { QuoteCard } from '../src/state/card-quote';
import { getInputStore } from '../src/state/input-store';

let panelSeq = 0;
const freshPanel = (): string => `quote-draft-panel-${panelSeq++}-${Date.now()}`;

function card(assetId: string, over: Partial<QuoteCard> = {}): QuoteCard {
  return {
    refId: `q-${assetId}`,
    origin: 'session',
    assetId,
    sourceSessionId: '3',
    kind: 'html',
    title: `卡 ${assetId}`,
    bytes: 12,
    at: '2026-11-19T02:52:13.000Z',
    ...over,
  };
}

describe('夹签槽（每卷一份，随草稿换手）', () => {
  let storeId: string;
  beforeEach(() => {
    localStorage.clear();
    storeId = freshPanel();
  });

  it('增删：add / remove / clear，同卡去重（第二次返回 false 且不新增）', () => {
    const s = getInputStore(storeId).getState();
    expect(s.addAttachedCard(card('as_a'))).toBe(true);
    expect(s.addAttachedCard(card('as_b'))).toBe(true);
    // 同一张卡（同 assetId、不同 refId）= 已存在
    expect(
      getInputStore(storeId)
        .getState()
        .addAttachedCard(card('as_a', { refId: 'q-other' })),
    ).toBe(false);
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_a', 'as_b']);

    getInputStore(storeId).getState().removeAttachedCard(0);
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_b']);

    getInputStore(storeId).getState().clearAttachedCards();
    expect(getInputStore(storeId).getState().attachedCards).toEqual([]);
  });

  it('架阁卡按 cardId 去重（assetId 不在场）', () => {
    const shelf = (cardId: string): QuoteCard =>
      card('', { origin: 'shelf', assetId: undefined, cardId, refId: `q-${cardId}` });
    expect(getInputStore(storeId).getState().addAttachedCard(shelf('card-1'))).toBe(true);
    expect(getInputStore(storeId).getState().addAttachedCard(shelf('card-1'))).toBe(false);
    expect(getInputStore(storeId).getState().addAttachedCard(shelf('card-2'))).toBe(true);
  });

  it('**换手往返**：claimLive 存旧主取新主后，夹签跟着卷走、不丢也不串', () => {
    const input = getInputStore(storeId);
    input.getState().claimLive('s:1');
    input.getState().addAttachedCard(card('as_a'));

    // 切到 2 卷：1 卷的夹签进它的草稿槽（live 清空）
    input.getState().claimLive('s:2');
    expect(input.getState().attachedCards).toEqual([]);
    expect(input.getState().sessionDrafts['s:1']?.attachedCards.map((c) => c.assetId)).toEqual(['as_a']);

    // 2 卷自己也引用一枚
    input.getState().addAttachedCard(card('as_b'));

    // 切回 1 卷：拿回属于 1 的，2 的进它自己的槽
    input.getState().claimLive('s:1');
    expect(input.getState().attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
    expect(input.getState().sessionDrafts['s:2']?.attachedCards.map((c) => c.assetId)).toEqual(['as_b']);
  });

  it('save/restore 往返（含夹签）—— 切卷不吞引用', () => {
    const input = getInputStore(storeId);
    input.getState().setInputText('正文');
    input.getState().addAttachedCard(card('as_a'));
    input.getState().saveSessionDraft(7);
    expect(input.getState().sessionDrafts['7']?.attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
    input.getState().clearAttachedCards();
    input.getState().restoreSessionDraft(7);
    expect(input.getState().attachedCards.map((c) => c.assetId)).toEqual(['as_a']);
  });

  it('clearSessionDraft 连带丢弃该卷的夹签（删卷不留幽灵引用）', () => {
    const input = getInputStore(storeId);
    input.getState().saveSessionDraft(9);
    input.getState().claimLive('s:9');
    input.getState().addAttachedCard(card('as_a'));
    input.getState().claimLive('s:8'); // 9 的草稿（含夹签）落槽
    expect(input.getState().sessionDrafts['s:9']?.attachedCards).toHaveLength(1);

    input.getState().clearSessionDraft('s:9');
    expect(input.getState().sessionDrafts['s:9']).toBeUndefined();
    input.getState().claimLive('s:9');
    expect(input.getState().attachedCards).toEqual([]);
  });

  it('clearSessionDrafts（整棵树重建）也清夹签', () => {
    const input = getInputStore(storeId);
    input.getState().addAttachedCard(card('as_a'));
    input.getState().clearSessionDrafts();
    expect(input.getState().attachedCards).toEqual([]);
    expect(input.getState().sessionDrafts).toEqual({});
  });

  it('**递给别的卷**（长按拖到 B，方案 §2.2 态二）：写 B 的槽、不切活跃卷、不碰 live', () => {
    const input = getInputStore(storeId);
    input.getState().claimLive('s:A');
    input.getState().addAttachedCard(card('as_live'));

    // 递给 B：只写 s:B 那份草稿
    expect(getInputStore(storeId).getState().addAttachedCardToSlot('s:B', card('as_b'))).toBe(true);
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_live']);
    expect(getInputStore(storeId).getState().liveOwner).toBe('s:A');
    expect(
      getInputStore(storeId)
        .getState()
        .sessionDrafts['s:B']?.attachedCards.map((c) => c.assetId),
    ).toEqual(['as_b']);
    // 重复递给同一卷 = 去重（返回 false，不新增第二条）
    expect(
      getInputStore(storeId)
        .getState()
        .addAttachedCardToSlot('s:B', card('as_b', { refId: 'q-2' })),
    ).toBe(false);

    // 切到 B 才看得见（「给 B 的夹签在 A 看不到」是语义，不是 bug）
    input.getState().claimLive('s:B');
    expect(
      getInputStore(storeId)
        .getState()
        .attachedCards.map((c) => c.assetId),
    ).toEqual(['as_b']);
  });
});
