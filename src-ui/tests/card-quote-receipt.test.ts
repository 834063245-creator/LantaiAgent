// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 来文气泡上的**紧凑引用回执**（2026-11-20 用户报「来文里显示了全部的快照内容」）。
//
// 纸面上那张纸写的是**人读的那一句**：摘要块（类型/标题/快照时刻/来源/规模/原文路径/
// 改本体命令）五六个字段铺开来，把用户自己写的那句话挤没了。故两处**投影不同、真源同一**：
//   · 发给模型：完整摘要块（方案 §4/§5.1——模型要读地址、规模与改本体的入参）；
//   · 来文气泡：一行回执（引了哪几张），摘要模板一个字不改。

import { describe, expect, it } from 'vitest';
import { type QuoteCard, renderQuoteBlock, renderQuoteReceipt } from '../src/state/card-quote';

const card = (kind: string, title: string, assetId = 'as_1'): QuoteCard => ({
  refId: `q-${assetId}`,
  origin: 'session',
  assetId,
  sourceSessionId: '1',
  kind,
  title,
  bytes: 10,
  at: '2026-11-20T04:00:00.000Z',
});

describe('来文回执（紧凑投影）', () => {
  it('一枚：物类签 + 书名号标题', () => {
    expect(renderQuoteReceipt([card('html', '示例标题')])).toBe('引 页《示例标题》');
  });

  it('多枚：顿号连成一串，不换行、不带字段', () => {
    const text = renderQuoteReceipt([card('html', 'A', 'as_1'), card('table', 'B', 'as_2')]);
    expect(text).toBe('引 页《A》、表《B》');
    // 摘要块的字段一个都不许漏进气泡
    for (const field of ['快照：', '来源：', '规模：', '原文：', '改本体']) {
      expect(text).not.toContain(field);
    }
  });

  it('超过三枚收成「等 N 枚」（回执是一行，不是一张表）', () => {
    const many = [card('html', 'A', 'a'), card('html', 'B', 'b'), card('html', 'C', 'c'), card('html', 'D', 'd')];
    expect(renderQuoteReceipt(many)).toBe('引 页《A》、页《B》、页《C》 等 4 枚');
  });

  it('未命名回落「未命名」；空清单 = 空串（不占行）', () => {
    expect(renderQuoteReceipt([card('table', '')])).toBe('引 表《未命名》');
    expect(renderQuoteReceipt([])).toBe('');
  });

  it('**同一批卡，两种投影**：摘要块照旧逐字给模型，回执只给人看', () => {
    const cards = [card('html', '示例标题')];
    const block = renderQuoteBlock(cards[0], 'D:/ws/.lantai/refs/q-1.json');
    // 摘要块该有的都还在（模型面不动）
    expect(block).toContain('· 原文：D:/ws/.lantai/refs/q-1.json（用 fs read 取）');
    expect(block).toContain('· 改本体：update_asset(');
    // 回执里一个都没有
    expect(renderQuoteReceipt(cards)).not.toContain('fs read');
  });
});
