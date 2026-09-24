// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P2-A 纸壳程文块：translate 特判 + measure 封顶 + 渲染器注册行。
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（paper-v3a 同款）。

import { describe, expect, it, vi } from 'vitest';

const { layoutMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
}));
// P3：measure 的富行内路径 → 子路径出口同样 mock（本文件全纯文本，rich 不触发）
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock } from '../src/paper/block-model';
import { measureBlockHeight } from '../src/paper/measure';
import { translateMessages } from '../src/paper/translate';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';
import type { AssistantMessage } from '../src/ui/message-model';

function toolMsg(name: string, args: string, status: 'running' | 'done' | 'error', output?: string, err?: string) {
  const m: AssistantMessage = {
    role: 'assistant',
    _id: 'm1',
    parts: [
      {
        type: 'tool',
        toolId: 'tc1',
        name,
        args,
        label: name,
        readOnly: false,
        status,
        output,
        err,
      },
    ],
    status: 'done',
    respondingTo: 'u1',
  };
  return m;
}

describe('translate：code_execution → 程文块', () => {
  it('code_execution 调用产出 code 块（payload 解析 code/description）', () => {
    const args = JSON.stringify({ code: 'return 1 + await tools.fs({});', description: '算个数' });
    const blocks = translateMessages([toolMsg('code_execution', args, 'running')]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe('code');
    expect(b.payload).toMatchObject({
      code: 'return 1 + await tools.fs({});',
      description: '算个数',
      status: 'running',
    });
    expect(b.w).toBe(640);
  });

  it('args 未流完（非法 JSON）→ 空 code 兜底，不炸', () => {
    const blocks = translateMessages([toolMsg('code_execution', '{"code": "ret', 'pending')]);
    expect(blocks[0].kind).toBe('code');
    expect((blocks[0].payload as { code: string }).code).toBe('');
  });

  it('终态：output/err 直映', () => {
    const args = JSON.stringify({ code: 'x', description: 'd' });
    const blocks = translateMessages([toolMsg('code_execution', args, 'error', undefined, 'boom')]);
    expect(blocks[0].payload).toMatchObject({ status: 'error', err: 'boom' });
  });

  it('普通工具调用仍走 tool 块（不受特判影响）', () => {
    const blocks = translateMessages([toolMsg('fs', '{"action":"read"}', 'done', 'ok')]);
    expect(blocks[0].kind).toBe('tool');
  });
});

describe('measure：code 块封顶测量', () => {
  it('三段叠加为正且随内容增长', () => {
    const small = {
      ...createBlock(
        'code',
        { toolId: 't', description: 'd', code: 'a', status: 'done' },
        { messageId: 'm', part: null },
      ),
      w: 640,
    };
    const big = {
      ...createBlock(
        'code',
        { toolId: 't', description: 'd', code: 'a\n'.repeat(50), status: 'done', output: 'x'.repeat(100) },
        { messageId: 'm', part: null },
      ),
      w: 640,
    };
    const hSmall = measureBlockHeight(small);
    const hBig = measureBlockHeight(big);
    expect(hSmall).toBeGreaterThan(0);
    expect(hBig).toBeGreaterThan(hSmall);
  });
});

describe('renderer：内置程文行', () => {
  it("builtinRendererDefs 含 builtin/code（kind='code'）", () => {
    const def = builtinRendererDefs().find((d) => d.id === 'builtin/code');
    expect(def?.kind).toBe('code');
    expect(typeof def?.component).toBe('function');
  });
});
