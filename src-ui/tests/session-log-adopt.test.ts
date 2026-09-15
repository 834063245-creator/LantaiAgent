// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Phase 3a：**采用原语**（权威翻转的基础件）——日志已含磁盘历史时，开卷不再
// 「整段替换」（那要把全部消息再写一遍：每次开卷 +1 份全文），而是发一条**头部
// 重设**事件（`session/reset{reason:'adopt'}`）并让内存投影从日志派生。
//
// 本文件钉住两件事（Phase 3b 的读路径翻转依赖它们）：
//   ① 投影：adopt 只换/补头部 system，尾部历史原样 —— 且不产全文副本
//   ② Agent：`adoptSessionLog` 后 in-memory session == deriveMessages()（双写等价）
//   ③ 既有 reason（init/restore/new-session/goal-*）仍是**整段替换**语义（零漂移）

import { describe, expect, it } from 'vitest';
import { SessionLog } from '../src/agent/session-log';
import { ToolRegistry } from '../src/agent/tool';
import type { Message } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

const SYS_OLD = { role: 'system', content: '旧系统提示' } as Message;
const SYS_NEW = '本轮系统提示（组合/设置可能已变）';

/** 一段磁盘历史：user → assistant（带工具调用）→ tool。 */
function history(): Message[] {
  return [
    { role: 'user', content: '跑个命令' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }],
    } as Message,
    { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.txt' },
  ];
}

function makeProvider() {
  return {
    name: () => 'mock',
    model: () => 'mock',
    // 本文件不跑回合——stream 永不被调用
    async *stream() {
      /* noop */
    },
  } as never;
}

describe('Phase 3a 采用原语（adopt）', () => {
  it('投影：adopt 只重设头部 system，尾部历史保留；事件体量 = 一条 system', () => {
    const events = [
      { seq: 1, ts: 1, kind: 'user/message' as const, data: { message: SYS_OLD } },
      ...history().map((m, i) => ({
        seq: i + 2,
        ts: 2 + i,
        kind: (m.role === 'user' ? 'user/message' : m.role === 'assistant' ? 'assistant/text' : 'tool/result') as
          | 'user/message'
          | 'assistant/text'
          | 'tool/result',
        data: { message: m },
      })),
    ];
    const log = SessionLog.replay(events);
    const before = JSON.stringify(log.deriveMessages());

    // 采用：追加一条「头部重设」（reason='adopt'）——内容只有一条 system 消息
    log.append('session/reset', { messages: [{ role: 'system', content: SYS_NEW }], reason: 'adopt' });

    const derived = log.deriveMessages();
    expect(derived[0]).toEqual({ role: 'system', content: SYS_NEW });
    // 历史一条不少（旧 system 头被换掉，其余原样）
    expect(derived.slice(1)).toEqual(history());
    // 与采用前相比：历史面零变化（只换了头）
    const stripHead = (msgs: Message[]) => JSON.stringify(msgs.slice(1));
    expect(stripHead(derived)).toBe(stripHead(JSON.parse(before) as Message[]));
    // 事件体量：新事件只带 system（不是全文副本）
    const appended = log.events().at(-1)!;
    expect((appended.data as { messages: Message[] }).messages).toHaveLength(1);
  });

  it('Agent.adoptSessionLog：内存 session == deriveMessages（双写等价），system 换新', () => {
    const tools = new ToolRegistry();
    const provider = makeProvider();
    const agent = createTestAgent(provider, tools, SYS_NEW, { agentId: 'adopt-agent' });
    // 模拟「磁盘历史已置回真源」：restoreInPlace 后日志尾部即磁盘事件
    const diskEvents = history().map((m, i) => ({
      seq: i + 1,
      ts: 1 + i,
      kind: (m.role === 'user' ? 'user/message' : m.role === 'assistant' ? 'assistant/text' : 'tool/result') as
        | 'user/message'
        | 'assistant/text'
        | 'tool/result',
      data: { message: m },
    }));
    agent.getSessionLog().restoreInPlace(diskEvents as never);
    expect(agent.getSession()).toHaveLength(1); // 构造期只有 system

    agent.adoptSessionLog(SYS_NEW);

    const derived = agent.getSessionLog().deriveMessages();
    expect(JSON.stringify(agent.getSession())).toBe(JSON.stringify(derived));
    expect(agent.getSession()[0]).toEqual({ role: 'system', content: SYS_NEW });
    expect(agent.getSession().slice(1)).toEqual(history());
    // 只追加了一条事件（不是把 4 条消息写成 reset 全文）
    const appended = agent.getSessionLog().events().slice(-1)[0];
    expect((appended.data as { messages: Message[] }).messages).toHaveLength(1);
  });

  it('既有 reason 仍是整段替换（零漂移）', () => {
    const log = SessionLog.replay(
      history().map((m, i) => ({
        seq: i + 1,
        ts: 1 + i,
        kind: (m.role === 'user' ? 'user/message' : m.role === 'assistant' ? 'assistant/text' : 'tool/result') as
          | 'user/message'
          | 'assistant/text'
          | 'tool/result',
        data: { message: m },
      })),
    );
    log.append('session/reset', { messages: [{ role: 'system', content: 'restore 面' }], reason: 'restore' });
    expect(log.deriveMessages()).toEqual([{ role: 'system', content: 'restore 面' }]);
  });
});
