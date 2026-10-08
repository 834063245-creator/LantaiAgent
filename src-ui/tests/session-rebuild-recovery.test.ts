// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// session-rebuild-recovery — 卷重建的块恢复判据（2026-10-08 案卷 51 丢卡根治）：
//   重建（rebuildMessagesFromMessages）时：
//     · 资产工具（show_asset/update_asset）回执 → BlockPart 恢复（update 原位替换）
//     · exit_plan_mode 结果（含计划全文）→ PlanPart 恢复；无全文（修改/拒绝/超时）→ 不产卡
//   文案契约（plan-tools.ts 的结果模板：`## 已批准计划：` / `## 计划：` / `计划文件路径：`）
//   由本文件钉住——文案变更 = 测试红，解析需同步。
// 计划：docs/plans/session-rebuild-recovery-plan.md

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(tween),
      from: vi.fn(tween),
      fromTo: vi.fn(tween),
      killTweensOf: vi.fn(),
      isTweening: vi.fn(() => false),
      utils: { toArray: vi.fn(() => []) },
    },
    gsap: { set: vi.fn() },
  };
});

import type { Message } from '../src/provider/types';
import { resetAssetTablesForTests } from '../src/state/asset-store';
import { getSessionStore } from '../src/state/session-store';
import { rebuildMessagesFromMessages } from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, BlockPart, ChatMessage, PlanPart } from '../src/ui/message-model';

const STORE_ID = 'session-rebuild-recovery-test';
const SESSION_A = 1;

function assistantWithCalls(calls: Array<{ id: string; name: string; arguments: string }>): Message {
  return { role: 'assistant', content: '', tool_calls: calls } as Message;
}

function toolResult(callId: string, name: string, content: string): Message {
  return { role: 'tool', tool_call_id: callId, name, content } as Message;
}

function assistantOf(storeId: string, sessionId: number): AssistantMessage | undefined {
  const msgs = msgStoreFor(storeId, sessionId).getState().messages as ChatMessage[];
  return msgs.find((m): m is AssistantMessage => m.role === 'assistant');
}

beforeEach(() => {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: '会话 A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  resetAssetTablesForTests();
});

describe('rebuild — 资产块恢复', () => {
  it('show_asset 回执 → 重建恢复 BlockPart（数据取回执、位置紧随该工具卡）', () => {
    const output = JSON.stringify({
      assetId: 'as_rebuild_1',
      kind: 'table',
      presentation: 'grid',
      title: 'holo_docs_open_items',
      payload: { columns: ['类别'], rows: [['真·没开工', 8]] },
      receipt: { summary: '1 列 × 1 行', reused: false, note: '' },
    });
    const provider: Message[] = [
      { role: 'user', content: '给我一张表' } as Message,
      assistantWithCalls([{ id: 'call_1', name: 'show_asset', arguments: '{"kind":"table"}' }]),
      toolResult('call_1', 'show_asset', output),
    ];

    rebuildMessagesFromMessages(provider, STORE_ID, SESSION_A);

    const parts = assistantOf(STORE_ID, SESSION_A)?.parts ?? [];
    const toolIdx = parts.findIndex((p) => p.type === 'tool' && p.name === 'show_asset');
    const blockIdx = parts.findIndex((p) => p.type === 'block');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBe(toolIdx + 1);
    const block = parts[blockIdx] as BlockPart;
    expect(block.assetId).toBe('as_rebuild_1');
    expect(block.kind).toBe('table');
    expect(block.presentation).toBe('grid');
    expect(block.title).toBe('holo_docs_open_items');
    expect(block.payload).toEqual({ columns: ['类别'], rows: [['真·没开工', 8]] });
    expect(block.finalised).toBe(true);
  });

  it('update_asset 回执 → 同 assetId 原位替换（卡片不新增、位置不变）', () => {
    const showOutput = JSON.stringify({
      assetId: 'as_rebuild_2',
      kind: 'table',
      presentation: 'grid',
      payload: { v: 1 },
    });
    const updateOutput = JSON.stringify({
      assetId: 'as_rebuild_2',
      kind: 'table',
      presentation: 'grid',
      payload: { v: 2 },
    });
    const provider: Message[] = [
      assistantWithCalls([
        { id: 'c1', name: 'show_asset', arguments: '{"kind":"table"}' },
        { id: 'c2', name: 'update_asset', arguments: '{"assetId":"as_rebuild_2"}' },
      ]),
      toolResult('c1', 'show_asset', showOutput),
      toolResult('c2', 'update_asset', updateOutput),
    ];

    rebuildMessagesFromMessages(provider, STORE_ID, SESSION_A);

    const parts = assistantOf(STORE_ID, SESSION_A)?.parts ?? [];
    const blocks = parts.filter((p): p is BlockPart => p.type === 'block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].payload).toEqual({ v: 2 });
    expect(parts.indexOf(blocks[0])).toBe(parts.findIndex((p) => p.type === 'tool' && p.name === 'show_asset') + 1);
  });

  it('资产结果非资产文本（工具错误路径）→ 不产卡、不炸', () => {
    const provider: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'show_asset', arguments: '{"kind":"nope"}' }]),
      toolResult('c1', 'show_asset', "错误：kind 'nope' 未注册。当前可用资产 kind：table、chart…"),
    ];

    rebuildMessagesFromMessages(provider, STORE_ID, SESSION_A);

    const parts = assistantOf(STORE_ID, SESSION_A)?.parts ?? [];
    expect(parts.some((p) => p.type === 'block')).toBe(false);
  });
});

describe('rebuild — 拟策块恢复', () => {
  it('exit_plan_mode 批准结果 → 恢复 PlanPart（正文 = 结果里的计划全文、路径取 enter 游标）', () => {
    const planBody = '# 测试计划\n\n## 一句话\n把 A 移入 B。';
    const enterResult =
      '已进入规划模式。计划文件路径：D:/ws/.lantai/plans/plan-123.md\n' +
      '用 fs 的 write 动作把计划写到这个文件（计划文件写入不受只读限制）。\n' +
      '然后调 exit_plan_mode 提交计划给用户审批。';
    const exitResult =
      '计划已批准。选定方案：全量归档。只执行选中的方案。\n' +
      '已切换到执行模式，所有工具恢复可用。\n\n' +
      `## 已批准计划：\n${planBody}`;
    const provider: Message[] = [
      assistantWithCalls([{ id: 'c_en', name: 'enter_plan_mode', arguments: '{}' }]),
      toolResult('c_en', 'enter_plan_mode', enterResult),
      assistantWithCalls([
        {
          id: 'c_ex',
          name: 'exit_plan_mode',
          arguments: JSON.stringify({
            options: [
              { label: '全量归档', description: '全量执行', outcome: 'execute' },
              { label: '保守：先归 18 份', description: '只归档无争议的', outcome: 'execute' },
            ],
          }),
        },
      ]),
      toolResult('c_ex', 'exit_plan_mode', exitResult),
    ];

    rebuildMessagesFromMessages(provider, STORE_ID, SESSION_A);

    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages as ChatMessage[];
    const all = msgs.flatMap((m) => (m.role === 'assistant' ? m.parts : []));
    const plan = all.find((p): p is PlanPart => p.type === 'plan');
    expect(plan).toBeDefined();
    expect(plan?.content).toBe(planBody);
    expect(plan?.planFilePath).toBe('D:/ws/.lantai/plans/plan-123.md');
    expect(plan?.status).toBe('pending');
    expect(plan?.options?.map((o) => o.label)).toEqual(['全量归档', '保守：先归 18 份']);
  });

  it('exit_plan_mode 无全文的结果（拒绝/修改/超时）→ 不产卡（宁缺勿造）', () => {
    const provider: Message[] = [
      assistantWithCalls([{ id: 'c_en', name: 'enter_plan_mode', arguments: '{}' }]),
      toolResult('c_en', 'enter_plan_mode', '已进入规划模式。计划文件路径：D:/ws/.lantai/plans/plan-9.md'),
      assistantWithCalls([{ id: 'c_ex', name: 'exit_plan_mode', arguments: '{}' }]),
      toolResult('c_ex', 'exit_plan_mode', '用户拒绝了计划。规划模式仍然激活。可以重新探索并修改计划。'),
    ];

    rebuildMessagesFromMessages(provider, STORE_ID, SESSION_A);

    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages as ChatMessage[];
    const all = msgs.flatMap((m) => (m.role === 'assistant' ? m.parts : []));
    expect(all.some((p) => p.type === 'plan')).toBe(false);
  });
});
