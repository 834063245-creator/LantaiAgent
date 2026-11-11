// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-pending-store —— 画布多卷审批 UX（A+B）的待答账回归测试（2026-11-11）。
//
// Why：这张账是「哪卷在等我」的唯一事实源（卷首角标 + 待答缩略行都读它）。
// 记错的两种后果都是用户可见的：多卷并发时把 A 卷的待答记到 B 卷（点角标跳错卷）、
// 或答复后不结账（角标永久挂着「待批 1」，用户以为还有事没做）。
//
// 覆盖：入账序 / 同 id 覆盖 / 结账幂等 / 按卷清场不误伤别卷 / 全清 /
// 按卷聚合 / 摘要截断。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipLabel,
  type PendingAskEntry,
  pendingCountsBySid,
  useAskPendingStore,
} from '../src/state/ask-pending-store';

const entry = (over: Partial<PendingAskEntry> = {}): PendingAskEntry => ({
  id: 'ask-1',
  ownerSid: 1,
  kind: 'ask',
  label: '要不要现在改？',
  badge: '第一卷',
  at: 1,
  ...over,
});

const store = () => useAskPendingStore.getState();

describe('待答账（ask-pending-store）', () => {
  beforeEach(() => {
    store().reset();
  });

  it('入账：保持交付序，读面按入账顺序给出', () => {
    store().upsert(entry({ id: 'a', at: 1 }));
    store().upsert(entry({ id: 'b', at: 2, kind: 'perm', ownerSid: 2 }));
    expect(store().entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('同 id 覆盖：重复交付不产生第二条（chat-core 回放同一条请求时不翻倍）', () => {
    store().upsert(entry({ id: 'a', label: '旧' }));
    store().upsert(entry({ id: 'a', label: '新' }));
    expect(store().entries).toHaveLength(1);
    expect(store().entries[0]?.label).toBe('新');
  });

  it('结账：答复后条目消失；未知 id / 重复结账是 no-op', () => {
    store().upsert(entry({ id: 'a' }));
    store().settle('a');
    expect(store().entries).toHaveLength(0);
    expect(() => store().settle('a')).not.toThrow();
    expect(() => store().settle('nope')).not.toThrow();
  });

  it('按卷清场：停 A 卷不抹掉 B 卷的待答（并发会话的按卷隔离）', () => {
    store().upsert(entry({ id: 'a1', ownerSid: 1 }));
    store().upsert(entry({ id: 'a2', ownerSid: 1, kind: 'perm' }));
    store().upsert(entry({ id: 'b1', ownerSid: 2 }));
    store().settleByOwner(1);
    expect(store().entries.map((e) => e.id)).toEqual(['b1']);
    expect(store().entries[0]?.ownerSid).toBe(2);
  });

  it('无归属（null）是独立一档：按 null 清场不动真卷的条目', () => {
    store().upsert(entry({ id: 'n', ownerSid: null, badge: null }));
    store().upsert(entry({ id: 'a', ownerSid: 1 }));
    store().settleByOwner(null);
    expect(store().entries.map((e) => e.id)).toEqual(['a']);
  });

  it('全清：工作区切换 / 卡架卸载把账抹干净', () => {
    store().upsert(entry({ id: 'a' }));
    store().upsert(entry({ id: 'b', ownerSid: 2 }));
    store().reset();
    expect(store().entries).toHaveLength(0);
  });

  it('按卷聚合：卷首角标读面（ask / perm 分列，total 恒等）', () => {
    store().upsert(entry({ id: 'a1', ownerSid: 1 }));
    store().upsert(entry({ id: 'a2', ownerSid: 1, kind: 'perm' }));
    store().upsert(entry({ id: 'a3', ownerSid: 1, kind: 'perm' }));
    store().upsert(entry({ id: 'b1', ownerSid: 2 }));
    const counts = pendingCountsBySid(store().entries);
    expect(counts.get(1)).toEqual({ ask: 1, perm: 2, total: 3 });
    expect(counts.get(2)).toEqual({ ask: 1, perm: 0, total: 1 });
    expect(counts.get(3)).toBeUndefined();
  });

  it('摘要截断：空白归一 + 超长补省略号（角标 tooltip 与缩略行共用口径）', () => {
    expect(clipLabel('  甲\n\n 乙  ')).toBe('甲 乙');
    const long = 'x'.repeat(60);
    expect(clipLabel(long, 10)).toBe(`${'x'.repeat(10)}…`);
    expect(clipLabel('短', 10)).toBe('短');
  });
});
