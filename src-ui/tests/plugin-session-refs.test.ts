// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 本卷引用（P1c 尾项）：从会话消息抽文件引用——只认可见事实与根内路径。

import { describe, expect, it } from 'vitest';
import { extractSessionFileRefs } from '../src/app/plugin-windows/session-refs';
import type { ChatMessage } from '../src/ui/message-model';

const messages = [
  {
    role: 'user',
    _id: 'u1',
    sessionIndex: 0,
    text: '[验收稿](docs/a.md) 与 `docs/b.md`，外部 https://example.com/x.md 不算。',
    files: [{ path: 'notes/c.txt', name: 'c.txt', size: 3 }],
  },
  {
    role: 'assistant',
    _id: 'a1',
    respondingTo: 'u1',
    status: 'done',
    parts: [
      { type: 'text', text: '读 [d](/work/docs/d.md) 和 `../outside/e.md`。' },
      {
        type: 'tool',
        toolId: 't1',
        name: 'fs',
        args: '{"path":"docs/e.md"}',
        label: '读',
        readOnly: true,
        status: 'done',
      },
    ],
  },
] as unknown as ChatMessage[];

describe('本卷引用抽取', () => {
  it('Markdown 链接 / 行内码 / 附件 / 工具参数 → 根内相对路径，去重且根外丢弃', () => {
    const refs = extractSessionFileRefs(messages, '/work');
    expect(refs).toEqual(['docs/a.md', 'docs/b.md', 'notes/c.txt', 'docs/d.md', 'docs/e.md']);
  });

  it('无工作区根 ⇒ 空', () => {
    expect(extractSessionFileRefs(messages, '')).toEqual([]);
  });
});
