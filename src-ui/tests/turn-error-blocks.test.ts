// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// turn-error — 回合墓碑块（2026-08-31 贴黄拆迁）：
//   assistant status=error + errorMessage → translateMessages 在该回合
//   parts 块之后追加一个 turn-error 块（id 锚消息级 pb:{msg}:err），
//   source.part = null（错误是消息级，不是 part）。
// 用户操作序列心智：回合跑挂了 → 错误行紧贴该回合正文尾部，不插队、不入流。

import { describe, expect, it } from 'vitest';
import { translateMessages } from '../src/paper/translate';
import type { AssistantMessage } from '../src/ui/message-model';

function asstMsg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    _id: 'a1',
    parts: [{ type: 'text', text: '回合正文', finalised: true }],
    status: 'done',
    respondingTo: 'u1',
    ...overrides,
  };
}

describe('paper/translate — 回合墓碑 turn-error', () => {
  it('status=error + errorMessage → 正文块后追加 turn-error 块（不插队）', () => {
    const msg = asstMsg({ status: 'error', errorMessage: '错误: 模型调用失败。发送任意消息重试' });
    const blocks = translateMessages([msg]);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'turn-error']);
    const err = blocks[1];
    expect(err.kind).toBe('turn-error');
    expect(err.id).toBe('pb:a1:err');
    expect(err.source.part).toBeNull();
    expect(err.payload).toMatchObject({
      text: '错误: 模型调用失败。发送任意消息重试',
      level: 'error',
    });
  });

  it('正常完成（status=done）→ 无 turn-error 块', () => {
    const blocks = translateMessages([asstMsg()]);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown']);
  });

  it('status=error 但无 errorMessage（防御）→ 无 turn-error 块', () => {
    const blocks = translateMessages([asstMsg({ status: 'error' })]);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown']);
  });

  it('多 part 回合（文本+工具）：墓碑在全部 parts 块之后', () => {
    const msg = asstMsg({
      parts: [
        { type: 'text', text: '先思考', finalised: true },
        { type: 'tool', toolId: 't1', name: 'read_file', label: '读文件', args: '{}', status: 'done' },
      ],
      status: 'error',
      errorMessage: '重试失败: 超时',
    });
    const blocks = translateMessages([msg]);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds[kinds.length - 1]).toBe('turn-error');
    expect(kinds.filter((k) => k === 'turn-error')).toHaveLength(1);
    expect(blocks[blocks.length - 1].payload).toMatchObject({ text: '重试失败: 超时' });
  });
});
