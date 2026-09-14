// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// C7 来文圈点解析回归——paper/marks.ts parseCircledSegments 全路径。

import { describe, expect, it } from 'vitest';
import { builtinRendererDefs } from '../../src/app/paper/builtin-renderers';
import { MAX_CIRCLED_CHARS, parseCircledSegments } from '../../src/paper/marks';

describe('parseCircledSegments — 基础解析', () => {
  it('无括号文本原样返回单段', () => {
    expect(parseCircledSegments('普通来文，没有圈点。')).toEqual([{ text: '普通来文，没有圈点。', circled: false }]);
  });

  it('单个【词】→ 圈点段，括号被消费', () => {
    const segs = parseCircledSegments('设置面板还是觉得【粗糙】，重点看间距。');
    expect(segs).toEqual([
      { text: '设置面板还是觉得', circled: false },
      { text: '粗糙', circled: true },
      { text: '，重点看间距。', circled: false },
    ]);
  });

  it('多个圈点与相邻文本交错', () => {
    const segs = parseCircledSegments('看看【间距】和【字重】');
    expect(segs).toEqual([
      { text: '看看', circled: false },
      { text: '间距', circled: true },
      { text: '和', circled: false },
      { text: '字重', circled: true },
    ]);
  });

  it('空内容【】不圈（按字面保留）', () => {
    expect(parseCircledSegments('空【】括号')).toEqual([{ text: '空【】括号', circled: false }]);
  });
});

describe('parseCircledSegments — 安全边界', () => {
  it(`超过 ${MAX_CIRCLED_CHARS} 字的内容整段按字面保留`, () => {
    const long = '一'.repeat(MAX_CIRCLED_CHARS + 1);
    expect(parseCircledSegments(`把【${long}】圈起来`)).toEqual([{ text: `把【${long}】圈起来`, circled: false }]);
  });

  it('恰好等于上限的内容仍圈', () => {
    const exact = '一'.repeat(MAX_CIRCLED_CHARS);
    const segs = parseCircledSegments(`【${exact}】`);
    expect(segs).toEqual([{ text: exact, circled: true }]);
  });

  it('未闭合的【按字面保留', () => {
    expect(parseCircledSegments('未闭合【粗糙，后面没了')).toEqual([
      { text: '未闭合【粗糙，后面没了', circled: false },
    ]);
  });

  it('括号内含换行不圈（跨行字面保留）', () => {
    expect(parseCircledSegments('跨行【粗糙\n粗糙】不圈')).toEqual([
      { text: '跨行【粗糙\n粗糙】不圈', circled: false },
    ]);
  });

  it('嵌套括号：外层未闭合按字面、内层正常圈', () => {
    const segs = parseCircledSegments('嵌套【外层【内层】尾巴');
    expect(segs).toEqual([
      { text: '嵌套【外层', circled: false },
      { text: '内层', circled: true },
      { text: '尾巴', circled: false },
    ]);
  });
});

describe('渲染器接线', () => {
  it('builtin/user 注册为 UserBody（非共用 TextBody）', () => {
    const r = builtinRendererDefs().find((d) => d.kind === 'user');
    expect(r?.id).toBe('builtin/user');
    // UserBody 是圈点渲染的载体：函数名即身份（dev/test 未混淆）
    expect(r?.component.name).toBe('UserBody');
  });
});
