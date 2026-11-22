// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 程文卡的流式预览：卡片保持折叠，折叠行显示「正在写什么」（2026-11-22 卷 165 后续）。
//
// 链路：ToolArgPreview（批量部分程序体）→ part.preview（覆盖语义，不碰 output）
//      → code 块 payload.preview → foldLabel 取 foldPreviewLine（与夹注同款读法）。
// 三件事各钉一处：数据面（mutator）、转译面（payload）、呈现面（折叠行）——
// 另外钉「参数到齐即清预览」（args 才是真源，卷里不存两份程序体）。

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { foldLabel } from '../src/paper/fold';
import { translateMessages } from '../src/paper/translate';
import type { AssistantMessage, AssistantPart, ToolCallPart } from '../src/ui/message-model';
import { applyEventToParts } from '../src/ui/part-mutator';

function dispatch(id: string, partial: boolean, args = ''): AgentEvent {
  return {
    kind: EventKind.ToolDispatch,
    tool: { id, name: 'code_execution', args, read_only: false, partial },
  } as AgentEvent;
}

function progress(id: string, output: string): AgentEvent {
  return {
    kind: EventKind.ToolProgress,
    tool: { id, name: 'code_execution', output, read_only: true },
  } as AgentEvent;
}

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

function codePart(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return {
    type: 'tool',
    toolId: 'call_code',
    name: 'code_execution',
    args: '',
    label: 'code_execution',
    readOnly: false,
    status: 'pending',
    ...overrides,
  };
}

describe('part-mutator — preview 写入与清空', () => {
  it('ToolProgress 写 preview（覆盖语义），不污染 output', () => {
    const parts: AssistantPart[] = [];
    applyEventToParts(parts, dispatch('call_code', true));
    const part = parts[0] as ToolCallPart;
    expect(part.status).toBe('pending');

    applyEventToParts(parts, progress('call_code', 'const a = 1;\n'));
    expect(part.status).toBe('running');
    expect(part.startedAt).toBeTypeOf('number');
    expect(part.preview).toBe('const a = 1;\n');
    expect(part.output).toBeUndefined(); // 输出是执行结果，预览不许冒充

    // 覆盖语义（不是追加）：后一帧是「到目前为止的全部」
    applyEventToParts(parts, progress('call_code', 'const a = 1;\nconst b = 2;\n'));
    expect(part.preview).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('参数到齐（完整 ToolDispatch）→ 清掉 preview（args 才是真源）', () => {
    const parts: AssistantPart[] = [];
    applyEventToParts(parts, dispatch('call_code', true));
    applyEventToParts(parts, progress('call_code', 'const a = 1;\n'));
    applyEventToParts(parts, dispatch('call_code', false, '{"code":"const a = 1;\n","description":"算数"}'));

    const part = parts[0] as ToolCallPart;
    expect(part.preview).toBeUndefined();
    expect(part.args).toContain('"code"');
    expect(part.status).toBe('running');
  });
});

describe('translate — 程文块带 preview', () => {
  it('待执行的 code_execution part → kind=code，payload.preview 透传', () => {
    const blocks = translateMessages([asstMsg('a1', [codePart({ preview: 'const a = 1;\nconst b = 2;' })])]);
    expect(blocks.map((b) => b.kind)).toEqual(['code']);
    const payload = blocks[0].payload as { code: string; preview?: string };
    expect(payload.code).toBe('');
    expect(payload.preview).toBe('const a = 1;\nconst b = 2;');
  });

  it('参数到齐的 part 不再带 preview（终态零漂移）', () => {
    const blocks = translateMessages([
      asstMsg('a1', [codePart({ args: JSON.stringify({ code: 'x = 1;', description: '算数' }), status: 'running' })]),
    ]);
    const payload = blocks[0].payload as { preview?: string };
    expect(payload.preview).toBeUndefined();
  });
});

describe('foldLabel — 折叠行流式显示最后一行', () => {
  it('有 preview 且程序体为空 → 「生成中 + 最新一行」', () => {
    const label = foldLabel(
      'code',
      { description: 'code_execution', code: '', status: 'running', preview: 'const a = 1;\nconst b = 2;' },
      true,
    );
    expect(label).toBe('▸ code_execution · 生成中 const b = 2;');
  });

  it('空行收尾时取最后一条非空行（流式行间断不吞字）', () => {
    expect(foldLabel('code', { description: '程序', preview: 'a = 1;\n\n' }, true)).toBe('▸ 程序 · 生成中 a = 1;');
  });

  it('程序体已到（code 非空）→ 回到既有读数，不再提「生成中」', () => {
    const label = foldLabel('code', { description: '算数', code: 'x = 1;', status: 'running' }, true);
    expect(label).toBe('▸ 算数');
    expect(label).not.toContain('生成中');
  });

  it('既无 code 也无 preview → 仍是「待执行」（旧行为零漂移）', () => {
    expect(foldLabel('code', { description: '程序', code: '' }, true)).toBe('▸ 程序 · 待执行');
  });
});
