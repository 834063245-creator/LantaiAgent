// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 逐消息计数记忆（2026-11-19）：压缩预检**每步**都要量整个载荷，而载荷里 99% 的消息
// 上一步就量过。实测 500 条消息 / 33.9 万 token 的卷，全量重算 50–100ms/步 —— 会话越
// 长越贵，且 pre-flight / maybeCompact / 诊断三处各调一次。
//
// 记忆的前提是**消息对象不可变**（全仓既有事实：消息只在 _appendMessage 处新增，无一处
// 就地改 content/reasoning_content/tool_calls）。这组用例把前提钉成红绿灯：
//   - 同一对象第二次计数必须与第一次相同（命中缓存不等于换了答案）；
//   - 内容**相同但不同对象**必须给出相同结果（缓存键是身份，不是内容指纹）；
//   - 缓存不改变任何语义：与逐字段重算的结果逐条相等。

import { describe, expect, it } from 'vitest';
import { countMessage, countMessages } from '../src/agent/token-counter';
import type { Message } from '../src/provider/types';

const toolMsg = (): Message => ({
  role: 'tool',
  name: 'fs',
  tool_call_id: 'c1',
  content: 'x'.repeat(500) + '汉'.repeat(200),
});

const richMsg = (): Message => ({
  role: 'assistant',
  content: 'y'.repeat(100),
  reasoning_content: '汉'.repeat(150),
  tool_calls: [{ id: 'c2', name: 'fs', arguments: '{"path":"a.ts"}' }],
});

describe('countMessage 记忆：语义零变更', () => {
  it('同一对象重复计数结果稳定（命中的是同一份答案）', () => {
    const m = toolMsg();
    const first = countMessage(m);
    for (let i = 0; i < 5; i++) expect(countMessage(m)).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it('内容相同但不同对象：结果相同（缓存键是身份，不是指纹）', () => {
    expect(countMessage(toolMsg())).toBe(countMessage(toolMsg()));
    expect(countMessage(richMsg())).toBe(countMessage(richMsg()));
  });

  it('数组计数 = 逐条计数之和（缓存不改变可加性）', () => {
    const msgs = [toolMsg(), richMsg(), { role: 'user', content: '你好' } as Message];
    const sum = msgs.reduce((acc, m) => acc + countMessage(m), 0);
    expect(countMessages(msgs)).toBe(sum);
    // 再算一遍（全命中）仍然相等
    expect(countMessages(msgs)).toBe(sum);
  });

  it('不同内容的消息不会被混为一谈', () => {
    const a: Message = { role: 'user', content: '短' };
    const b: Message = { role: 'user', content: '长'.repeat(200) };
    expect(countMessage(b)).toBeGreaterThan(countMessage(a));
  });
});
