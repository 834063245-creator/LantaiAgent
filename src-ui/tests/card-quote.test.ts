// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卡片引用（夹签）的纯数据面（docs/plans/card-quote-plan.md §9.1）：
//   · 摘要模板**逐字**对拍（含跨卷降级文案、架阁来源、千分位规模）；
//   · refId 格式与唯一性；
//   · 多卡渲染 = 空行分隔、**不编号**（编号会让模型误以为有顺序语义）；
//   · 拼接形态（正文 → 分隔行 → 引卡块）。

import { describe, expect, it } from 'vitest';
import {
  composeQuotedText,
  formatThousands,
  newRefId,
  payloadChars,
  QUOTE_DEGRADED_SOURCE,
  QUOTE_SECTION_SEPARATOR,
  type QuoteCard,
  quoteKeyOf,
  quoteSnapshotPath,
  renderQuoteBlock,
  renderQuoteSection,
} from '../src/state/card-quote';

/** 固定时刻（本地时区构造 → 摘要里的时间与用户看到的一致）。 */
const AT = new Date(2026, 10, 19, 10, 52, 13).toISOString();

const SESSION_CARD: QuoteCard = {
  refId: 'q-20261119-1052-a1b2',
  origin: 'session',
  assetId: 'as_abc',
  sourceSessionId: '7',
  kind: 'html',
  title: '示例标题',
  bytes: 4524,
  at: AT,
};

const SHELF_CARD: QuoteCard = {
  refId: 'q-20261119-1053-b2c3',
  origin: 'shelf',
  cardId: 'card-123456-abcdef',
  kind: 'table',
  title: '',
  bytes: 12,
  at: AT,
};

const REF_PATH = 'D:/ws/.lantai/refs/q-20261119-1052-a1b2.json';

describe('摘要模板（方案 §4，逐字）', () => {
  it('会话卡：六行齐全，末尾带「改本体」', () => {
    expect(renderQuoteBlock(SESSION_CARD, REF_PATH)).toBe(
      [
        '〔引卡〕页《示例标题》',
        '· 快照：2026-11-19 10:52（此后原卡改动不影响本次引用）',
        '· 来源：本卷第 7 张 as_abc',
        '· 规模：payload 4,524 字符',
        `· 原文：${REF_PATH}（用 fs read 取）`,
        '· 改本体：update_asset({"assetId":"as_abc"})',
      ].join('\n'),
    );
  });

  it('架阁卡：来源写 cardId、**不出**「改本体」行（不是会话里的资产）', () => {
    const text = renderQuoteBlock(SHELF_CARD, 'D:/ws/.lantai/refs/q-2.json');
    expect(text.split('\n')[0]).toBe('〔引卡〕表《未命名》');
    expect(text).toContain('· 来源：架阁 card-123456-abcdef');
    expect(text).not.toContain('· 改本体');
  });

  it('降级（取不到 payload）：原文行换成逐字降级文案，且不假装成功', () => {
    const text = renderQuoteBlock(SESSION_CARD, null);
    expect(text).toContain(QUOTE_DEGRADED_SOURCE);
    expect(text).not.toContain('（用 fs read 取）'); // 没有路径可指，不能写出一个假地址
    expect(text).not.toContain('· 改本体'); // 没有原文可指，就别再给改本体的地址
  });

  it('未登记的 kind 也有签（回落「录」），标题空 = 未命名', () => {
    const text = renderQuoteBlock({ ...SESSION_CARD, kind: 'unknown-kind', title: '' }, REF_PATH);
    expect(text.startsWith('〔引卡〕录《未命名》')).toBe(true);
  });
});

describe('多卡渲染（方案 §4 规则 4）', () => {
  it('空行分隔、不编号', () => {
    const section = renderQuoteSection([
      { card: SESSION_CARD, refPath: REF_PATH },
      { card: SHELF_CARD, refPath: 'D:/ws/.lantai/refs/q-2.json' },
    ]);
    expect(section).toBe(
      `${renderQuoteBlock(SESSION_CARD, REF_PATH)}\n\n${renderQuoteBlock(SHELF_CARD, 'D:/ws/.lantai/refs/q-2.json')}`,
    );
    expect(section).not.toMatch(/^\s*1[.、)]/m);
  });

  it('拼接：正文 → 空行 → 分隔行 → 空行 → 引卡块；空清单 = 正文原样', () => {
    const body = '帮我改一下这张卡';
    expect(composeQuotedText(body, [])).toBe(body);
    expect(composeQuotedText(body, [{ card: SESSION_CARD, refPath: REF_PATH }])).toBe(
      `${body}\n\n${QUOTE_SECTION_SEPARATOR}\n\n${renderQuoteBlock(SESSION_CARD, REF_PATH)}`,
    );
    // 纯引用轮（正文为空）：不留前导空行
    expect(composeQuotedText('', [{ card: SESSION_CARD, refPath: REF_PATH }])).toBe(
      `${QUOTE_SECTION_SEPARATOR}\n\n${renderQuoteBlock(SESSION_CARD, REF_PATH)}`,
    );
  });
});

describe('夹签身份与读数', () => {
  it('refId 格式 q-<yyyymmdd-hhmmss>-<4 位>，且批量生成不重号', () => {
    const at = new Date(2026, 10, 19, 10, 52, 13);
    expect(newRefId(at)).toMatch(/^q-20261119-105213-[a-z0-9]{4}$/);
    const ids = new Set(Array.from({ length: 200 }, () => newRefId(at)));
    expect(ids.size).toBe(200);
    // 回归（2026-11-20 实测偶发红）：**同一秒**连发也要全不重号——refId 就是 refs 文件名，
    // 撞号 = 后写的覆盖前者（第二个引用静默丢内容）。窗口内重抽保证这条。
    const many = new Set(Array.from({ length: 2000 }, () => newRefId(at)));
    expect(many.size).toBe(2000);
  });

  it('千分位（规模一眼看出是不是大件）', () => {
    expect(formatThousands(0)).toBe('0');
    expect(formatThousands(999)).toBe('999');
    expect(formatThousands(4524)).toBe('4,524');
    expect(formatThousands(1234567)).toBe('1,234,567');
  });

  it('payload 字符数：序列化失败如实给 0（不炸整条引用）', () => {
    expect(payloadChars({ a: 1 })).toBe('{"a":1}'.length);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(payloadChars(cyclic)).toBe(0);
  });

  it('去重键 = 卡身份（同一张卡两次引用只留一枚）', () => {
    expect(quoteKeyOf(SESSION_CARD)).toBe('session:as_abc');
    expect(quoteKeyOf(SHELF_CARD)).toBe(`shelf:${SHELF_CARD.cardId}`);
    expect(quoteKeyOf({ ...SESSION_CARD, refId: 'q-other' })).toBe(quoteKeyOf(SESSION_CARD));
  });

  it('快照路径：反斜杠归一、尾斜杠不叠加（与附图道同一口径）', () => {
    expect(quoteSnapshotPath('D:\\ws\\', 'q-1')).toBe('D:/ws/.lantai/refs/q-1.json');
    expect(quoteSnapshotPath('D:/ws/', 'q-1')).toBe('D:/ws/.lantai/refs/q-1.json');
  });
});
