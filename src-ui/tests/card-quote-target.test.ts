// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 夹签**落给谁**（docs/plans/card-quote-plan.md §2.2 态一 / §2.3 归属模型 / §8 首行）：
//   · 已认领 → 就是它；
//   · 未认领但活跃卷在场 → 按活跃卷认领（不认领 = 下次换手把夹签写回错的卷）；
//   · 有纸无卷 → 纸的草稿槽；
//   · 什么都没有 → 空串（入口据此置灰，tooltip「先展开一卷或落一张纸」）。

import { beforeEach, describe, expect, it } from 'vitest';
import { quoteSlotOf } from '../src/plugins/builtin/paper-shell/quote-target';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { getChatStore } from '../src/ui/chat-store';

let panelSeq = 0;
const freshPanel = (): string => `quote-target-${panelSeq++}-${Date.now()}`;

describe('夹签落槽目标', () => {
  let panelId: string;
  beforeEach(() => {
    localStorage.clear();
    panelId = freshPanel();
    useDraftSheetStore.getState().dismissAll();
    getChatStore(panelId).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    getChatStore(panelId).input.setState({ liveOwner: '', inputText: '', attachedCards: [] });
  });

  it('空画布（无卷无纸）→ 无处可落', () => {
    expect(quoteSlotOf(panelId)).toBe('');
  });

  it('有卷但还没认领 → 按**活跃卷**落（否则换手会把夹签写回旧主）', () => {
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 3, label: '卷三' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 4,
    });
    expect(quoteSlotOf(panelId)).toBe('s:3');
  });

  it('已认领 → 认领优先（纸拿走输入时夹签跟着纸走）', () => {
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 3, label: '卷三' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 4,
    });
    getChatStore(panelId).input.setState({ liveOwner: 'draft:p1' });
    expect(quoteSlotOf(panelId)).toBe('draft:p1');
  });

  it('无卷但有焦点纸 → 纸的草稿槽', () => {
    const id = useDraftSheetStore.getState().openSheet();
    expect(quoteSlotOf(panelId)).toMatch(/^draft:/);
    expect(quoteSlotOf(panelId)).toContain(String(id));
  });
});
