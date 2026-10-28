// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 记忆库改走对话尾部（2026-10-28 卷首字节稳定性批）的守护面。
//
// 病灶：记忆库原先坐在 system prompt（卷首）。它是卷首里**唯一随用户操作变化**的内容
// ——写一条记忆，卷首就变一字节，其后**全部对话**按未缓存计费（实测命中率 99% → 0.6%，
// 一次 34.7 万 token 全价）。修法 = 把它挪到请求载荷的**最后一条**（transient reminder，
// 不落历史）：已缓存前缀照常命中，且记忆始终是最新的。
//
// 这里钉三件事（从用户操作序列出发，不钉实现形状）：
//   1. 有记忆 ⇒ 请求最后一条是记忆快照，且排在全部临时提醒之后；
//   2. 无记忆 ⇒ 不追加任何东西（载荷与改动前一致，零回归）；
//   3. 每轮重拼 ⇒ 记忆改了下一轮就带上新的（不需要重启，也不靠"换卷首"）。

import { describe, expect, it } from 'vitest';
import { buildTransientMessages } from '../src/agent/agent';

describe('记忆库：走对话尾部（不坐卷首）', () => {
  it('有记忆：快照是最后一条，且排在全部临时提醒之后', () => {
    const msgs = buildTransientMessages(
      ['<system-reminder>甲</system-reminder>', '<system-reminder>乙</system-reminder>'],
      '- 一条记忆',
    );
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toContain('甲');
    expect(msgs[1].content).toContain('乙');

    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('## 记忆库');
    expect(last.content).toContain('- 一条记忆');
    expect(last.content.startsWith('<system-reminder>')).toBe(true);
  });

  it('无记忆：不追加任何东西（零回归——载荷与改动前一致）', () => {
    expect(buildTransientMessages([], '')).toEqual([]);
    const onlyReminders = buildTransientMessages(['<system-reminder>甲</system-reminder>'], '');
    expect(onlyReminders).toHaveLength(1);
    expect(onlyReminders[0].content).toBe('<system-reminder>甲</system-reminder>');
  });

  it('每轮重拼：记忆变了，下一轮拼出来的就是新内容（不需要重启）', () => {
    const before = buildTransientMessages([], '- 旧记忆');
    const after = buildTransientMessages([], '- 旧记忆\n- 新写的记忆');
    expect(before[before.length - 1].content).toContain('旧记忆');
    expect(after[after.length - 1].content).toContain('新写的记忆');
  });
});
