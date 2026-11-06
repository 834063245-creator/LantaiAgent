// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸面字号缩放（2026-11-06 字号批）——正例：文档根上落了 --font-scale，
// 纸面字号族按同一枚因子同比放大（CSS 与测量共用 PAPER_TYPE，一处放大即两端一致）。
//
// ⚠ 必须 vi.resetModules() + 动态 import：tests/setup.ts 的 beforeAll 会先装载
// paper-shell 的 measure-implementation（连带 type-tokens），此时文档上还没有
// --font-scale ⇒ 模块常量定格在 1。复位后重导入才能拿到本文件设的 1.5。
// 反向基线（无 document ⇒ 1）钉在 tests/ui-type-scale.test.ts 的 node 用例里。

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

async function freshTokens() {
  vi.resetModules();
  return import('../src/plugins/builtin/paper-shell/type-tokens');
}

describe('纸面字号吃 --font-scale', () => {
  it('PAPER_SCALE = 文档根上的因子；七族正文同比放大、行高系数不变', async () => {
    document.documentElement.style.setProperty('--font-scale', '1.5');
    const mod = await freshTokens();
    expect(mod.PAPER_SCALE).toBe(1.5);
    expect(mod.PAPER_TYPE.body.size).toBe(25.5); // 17 × 1.5
    expect(mod.PAPER_TYPE.tool.size).toBe(17.25); // 11.5 × 1.5
    expect(mod.PAPER_TYPE.body.lh).toBe(2); // 行高系数是比例，不缩放
  });

  it('markdown 标题与表格同族（高度由 size × lh 派生，故测量自动跟随）', async () => {
    document.documentElement.style.setProperty('--font-scale', '1.5');
    const mod = await freshTokens();
    expect(mod.MD_TOKENS.h[0]!.size).toBe(30); // 20 × 1.5
    expect(mod.MD_TOKENS.tableSize).toBe(17.25); // 11.5 × 1.5
  });

  it('夹取与 FONT_SCALE_RANGE 同域：越界→夹回，非法/缺省→1', async () => {
    const { paperScaleFrom } = await freshTokens();
    expect(paperScaleFrom('9')).toBe(2);
    expect(paperScaleFrom('0.4')).toBe(1);
    expect(paperScaleFrom('')).toBe(1);
    expect(paperScaleFrom('abc')).toBe(1);
    expect(paperScaleFrom('1.2')).toBe(1.2);
  });
});
