// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名概括（B 批）纯函数面：prompt 形状与回包解析。
// 调用面（旁路调用 / CAS / epoch）在 volume-naming.test.ts 的行为例里。

import { describe, expect, it } from 'vitest';
import { buildVolumeTitlePrompt, parseVolumeTitleReply, VOLUME_TITLE_INPUT_MAX_CHARS } from '../src/state/volume-title';

/** 取 user 段里 JSON 载荷（首行是指令前缀，其后是 JSON）。 */
function payloadOf(user: string): unknown {
  return JSON.parse(user.slice(user.indexOf('\n') + 1));
}

describe('buildVolumeTitlePrompt', () => {
  it('system 带长度与语言口径；user 用 JSON 包裹来文（正文里的分隔符不得破结构）', () => {
    const { system, user } = buildVolumeTitlePrompt('把卷名收口\n```\n分隔符 ```');
    expect(system).toContain('只输出题名本身');
    expect(system).toContain('中文 8–14 字');
    expect(payloadOf(user)).toEqual({ text: '把卷名收口\n```\n分隔符 ```' });
  });

  it('超长来文按上限截断（概括只需要开头）', () => {
    const long = '甲'.repeat(VOLUME_TITLE_INPUT_MAX_CHARS + 50);
    const { user } = buildVolumeTitlePrompt(long);
    expect(payloadOf(user)).toEqual({ text: '甲'.repeat(VOLUME_TITLE_INPUT_MAX_CHARS) });
  });
});

describe('parseVolumeTitleReply', () => {
  it('取第一个非空行，后续解释丢弃', () => {
    expect(parseVolumeTitleReply('\n\n修复登录跳转\n\n这个题名说明了改动范围。')).toBe('修复登录跳转');
  });

  it('剥整行星号强调；行内强调不动', () => {
    expect(parseVolumeTitleReply('**卷名收口**')).toBe('卷名收口');
    expect(parseVolumeTitleReply('*卷名收口*')).toBe('卷名收口');
    expect(parseVolumeTitleReply('a**b**c')).toBe('a**b**c');
  });

  it('控制符剔除、空白折叠', () => {
    expect(parseVolumeTitleReply('题名\u0000')).toBe('题名');
    expect(parseVolumeTitleReply('  多   空格  ')).toBe('多 空格');
  });

  it('空回包 → 空串（调用点据此保留派生名）', () => {
    expect(parseVolumeTitleReply('')).toBe('');
    expect(parseVolumeTitleReply('   \n\n\t ')).toBe('');
  });
});
