// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// folio-date — 卷首档行中文数字长日期（2026-09-16 卷首重排 B 案新增）。
// 规格源：prototype/lantai.html:490「二〇二六年八月廿二日」——首例即黄金用例。
// 覆盖：① 年月日三种写法全覆盖 ② 本地时区语义（不随 UTC 漂天）
// ③ 缺席/坏值 → 空串（旧卷无 createdAt = 不显日期，不编造）。

import { describe, expect, it } from 'vitest';
import { formatCNDate } from '../src/plugins/builtin/paper-shell/folio-date';

/** 本地时刻 → ISO（往返后本地年月日不变——被测函数取的就是本地年月日）。 */
function localISO(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

describe('formatCNDate — 卷首档行中文长日期', () => {
  it('规格源原值：2026-08-22 → 二〇二六年八月廿二日', () => {
    expect(formatCNDate(localISO(2026, 8, 22))).toBe('二〇二六年八月廿二日');
  });

  it('年逐位直读（不读「二千零二十六」）', () => {
    expect(formatCNDate(localISO(2026, 1, 1))).toBe('二〇二六年一月一日');
    expect(formatCNDate(localISO(1999, 1, 1))).toBe('一九九九年一月一日');
    expect(formatCNDate(localISO(2000, 1, 1))).toBe('二〇〇〇年一月一日');
  });

  it('月：一…十 / 十一 / 十二', () => {
    expect(formatCNDate(localISO(2026, 9, 1))).toBe('二〇二六年九月一日');
    expect(formatCNDate(localISO(2026, 10, 1))).toBe('二〇二六年十月一日');
    expect(formatCNDate(localISO(2026, 11, 1))).toBe('二〇二六年十一月一日');
    expect(formatCNDate(localISO(2026, 12, 1))).toBe('二〇二六年十二月一日');
  });

  it('日：一位 / 十x / 二十 / 廿x / 三十 / 卅一', () => {
    expect(formatCNDate(localISO(2026, 9, 9))).toBe('二〇二六年九月九日');
    expect(formatCNDate(localISO(2026, 9, 10))).toBe('二〇二六年九月十日');
    expect(formatCNDate(localISO(2026, 9, 19))).toBe('二〇二六年九月十九日');
    expect(formatCNDate(localISO(2026, 9, 20))).toBe('二〇二六年九月二十日');
    expect(formatCNDate(localISO(2026, 9, 21))).toBe('二〇二六年九月廿一日');
    expect(formatCNDate(localISO(2026, 9, 29))).toBe('二〇二六年九月廿九日');
    expect(formatCNDate(localISO(2026, 9, 30))).toBe('二〇二六年九月三十日');
    expect(formatCNDate(localISO(2026, 12, 31))).toBe('二〇二六年十二月卅一日');
  });

  it('取本地年月日——跨时区读同一卷不漂到隔天', () => {
    // 本地 23:59 与 00:01 分属两天：日期必须按本地日历判，不按 UTC
    expect(formatCNDate(localISO(2026, 3, 5, 0, 1))).toBe('二〇二六年三月五日');
    expect(formatCNDate(localISO(2026, 3, 5, 23, 59))).toBe('二〇二六年三月五日');
  });

  it('缺席 / 坏值 → 空串（不编造日期，也不阻断卷首渲染）', () => {
    expect(formatCNDate(undefined)).toBe('');
    expect(formatCNDate(null)).toBe('');
    expect(formatCNDate('')).toBe('');
    expect(formatCNDate('不是日期')).toBe('');
  });
});
