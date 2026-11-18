// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 记忆库快照的落史行为（2026-11-18 变更驱动批）。
//
// 病史（两段，都要记住）：
//   ① 2026-10-28 之前：记忆坐 system prompt（卷首）。它是卷首里**唯一随用户操作
//      变化**的内容 —— 写一条记忆就成一字节变化，其后**全部对话**按未缓存计费
//      （实测命中率 99% → 0.6%，一次 34.7 万 token 全价）。
//   ② 2026-10-28 → 2026-11-18：改走「请求载荷最后一条的 transient reminder」。
//      卷首稳了，但代价是**每步都重发整份快照**：实测 26 条项目记忆渲染成 2,114
//      tokens，落点正是缓存断点之后的 miss 段（同卷 miss 段通常只有 3.5K–7.7K）
//      ⇒ 每步 30%–60% 的未命中 token 在重付同一段不变内容的全价。语义上也坏了：
//      副本每步在历史中段重新出现，模型分不清「固定快照」与「历史被改写」——
//      真机卷 121 三次把它读成「上下文被压缩了（记忆注入）」。
//
// 现行（对齐 DSH agent-loop/src/runtime-context.ts 的 RuntimeContextProjection）：
//   ① **未变不发**（可见历史里那份 === 当前内容 ⇒ 什么都不写）
//   ② **一次性落史**（durable user 消息：可回放、可压缩、靠前缀缓存复用）
//   ③ **被压缩遮蔽后自愈**（快照落在折叠区间内 ⇒ 补发一份）
//   ④ **取代声明**（新快照开头明说取代此前所有快照，含摘要里的内容）
//
// 这里按**用户可见行为**钉这四件事，不钉实现形状。

import { describe, expect, it } from 'vitest';
import { buildTransientMessages } from '../src/agent/agent';
import {
  buildMemorySnapshotMessage,
  isMemorySnapshotMessage,
  memorySnapshotTextOf,
  planMemorySnapshotSync,
} from '../src/agent/memory-snapshot';
import type { Message } from '../src/provider/types';

const user = (content: string): Message => ({ role: 'user', content });
const snap = (text: string, supersedes = false) => buildMemorySnapshotMessage(text, supersedes);

describe('记忆库快照：一条 durable 消息，不是每步重发的尾部副本', () => {
  it('请求尾部的 transient 里**不再有**记忆库（只剩本轮临时提醒）', () => {
    // 本次改动的核心断言：旧实现会在尾部追加一条「## 记忆库」。
    const msgs = buildTransientMessages(['<system-reminder>甲</system-reminder>']);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('<system-reminder>甲</system-reminder>');
    expect(msgs.some((m) => String(m.content).includes('## 记忆库'))).toBe(false);
    expect(buildTransientMessages([])).toEqual([]);
  });

  it('落史的快照能被自己的尺子认回来，且正文逐字往返（恢复/开卷要用）', () => {
    const body = '### 📋 参考 (reference)\n- **甲** — 内容一\n- **乙** — 内容二';
    const msg = snap(body);
    expect(msg.role).toBe('user');
    expect(isMemorySnapshotMessage(String(msg.content))).toBe(true);
    expect(memorySnapshotTextOf(String(msg.content))).toBe(body);
  });

  it('普通 system-reminder / 用户正文不算记忆快照（尺子不误伤）', () => {
    expect(isMemorySnapshotMessage('<system-reminder>\n[Git] main\n</system-reminder>')).toBe(false);
    expect(isMemorySnapshotMessage('请把这条存进记忆库')).toBe(false);
    expect(isMemorySnapshotMessage(undefined)).toBe(false);
    expect(memorySnapshotTextOf('<system-reminder>\n[Git] main\n</system-reminder>')).toBe(null);
  });
});

describe('什么时候补一条快照（planMemorySnapshotSync）', () => {
  const msgs = (...extra: Message[]): Message[] => [{ role: 'system', content: 'sys' }, ...extra];

  it('① 未变不发：可见的那份 === 当前内容 ⇒ 什么都不写', () => {
    const history = msgs(user('你好'), snap('- 甲'));
    expect(planMemorySnapshotSync(history, 1, 1, '- 甲')).toBe(null);
  });

  it('② 内容变了 ⇒ 补一条，并声明取代（本会话发过）', () => {
    const history = msgs(user('你好'), snap('- 甲'));
    const plan = planMemorySnapshotSync(history, 1, 1, '- 甲\n- 乙');
    expect(plan).not.toBe(null);
    expect(plan?.supersedes).toBe(true);
  });

  it('首份快照没有「更早的版本」可取代 ⇒ 不带取代句', () => {
    const history = msgs(user('你好'));
    const plan = planMemorySnapshotSync(history, 1, 1, '- 甲');
    expect(plan).toEqual({ supersedes: false });
    expect(String(snap('- 甲').content)).not.toContain('取代');
  });

  it('③ 被压缩遮蔽（快照落在折叠点之前）⇒ 补发，且仍声明取代', () => {
    // 折叠点 = 3：快照（index 2）已被摘要取代 ⇒ 模型看不见它了，必须补发。
    const history = msgs(user('早'), snap('- 甲'), user('<compacted-context>摘要'), user('新'));
    const plan = planMemorySnapshotSync(history, 1, 3, '- 甲');
    expect(plan).toEqual({ supersedes: true });
  });

  it('被遮蔽后补发的那份**是**取代（摘要里可能还留着旧记忆）', () => {
    const history = msgs(snap('- 甲'));
    // 内容没变，但可见面里已经没有了 ⇒ 也要补，且必须声明取代
    expect(planMemorySnapshotSync(history, 1, 2, '- 甲')).toEqual({ supersedes: true });
    expect(String(snap('- 甲', true).content)).toContain('取代此前所有记忆库快照');
  });
});
