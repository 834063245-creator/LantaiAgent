// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// C10 附件链守护：translate 结构化（不进正文）+ measure 计高 + UserBody 渲染。
// 旧病灶钉死：📎 行拼进楷书正文 = 回归。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinRendererDefs } from '../src/composition/renderer-service';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'
// （paper-v3a 同款范式）：文本高度恒 36，附件行差值断言不受影响（线性叠加精确可期）。
const { prepareMock, layoutMock, richStatsMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
// P3：measure 的富行内路径（圈点走 rich）→ 子路径出口同样 mock
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

import { parseCircledSegments } from '../src/paper/marks';
import { measureBlockHeight } from '../src/paper/measure';
import { translateMessages } from '../src/paper/translate';
import type { UserMessage } from '../src/ui/message-model';

function userMsg(files?: Array<{ path: string; name: string; size: number }>): UserMessage {
  return {
    role: 'user',
    _id: 'm-test-1',
    text: '附件验证【词】',
    ...(files ? { files } : undefined),
    sessionIndex: 0,
  };
}

describe('C10 附件链 — translate 结构化', () => {
  it('带附件的来文：payload.files 携带 path/name，正文不混入路径', () => {
    const blocks = translateMessages([userMsg([{ path: 'D:/x/报告.md', name: '报告.md', size: 0 }])]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe('user');
    const p = b.payload as { text: string; files?: Array<{ path: string; name: string }> };
    expect(p.text).toBe('附件验证【词】'); // 正文纯净——旧病灶（📎 行拼正文）钉死
    expect(p.files).toEqual([{ path: 'D:/x/报告.md', name: '报告.md' }]);
  });

  it('无附件来文：files 不出现（undefined 不入 payload）', () => {
    const blocks = translateMessages([userMsg()]);
    const p = blocks[0].payload as { files?: unknown };
    expect(p.files).toBeUndefined();
  });
});

describe('C10 附件链 — measure 计高', () => {
  const W = 560;
  it('附件行计入块高：2 文件 > 0 文件', () => {
    const without = translateMessages([userMsg()])[0];
    const with2 = translateMessages([
      userMsg([
        { path: 'D:/a.md', name: 'a.md', size: 0 },
        { path: 'D:/b.md', name: 'b.md', size: 0 },
      ]),
    ])[0];
    without.w = W;
    with2.w = W;
    const h0 = measureBlockHeight(without);
    const h2 = measureBlockHeight(with2);
    expect(h2).toBeGreaterThan(h0);
    // 每行 16px + 上边距 9：两行 = 41px（线性叠加可精确断言）
    expect(h2 - h0).toBe(9 + 2 * 16);
  });
});

describe('C10 附件链 — UserBody 渲染（内置渲染器）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('附件行独立渲染（pp-user-files / 附 · name），圈点同存不互扰', () => {
    const userDef = builtinRendererDefs().find((d) => d.kind === 'user');
    expect(userDef).toBeDefined();
    const UserBody = userDef!.component;
    const blocks = translateMessages([
      userMsg([{ path: 'D:/HoloGramHG/CONVENTIONS.md', name: 'CONVENTIONS.md', size: 0 }]),
    ]);
    act(() => {
      root?.render(createElement(UserBody, { block: blocks[0] }));
    });
    const filesRow = container!.querySelector('.pp-user-files');
    expect(filesRow).not.toBeNull();
    const fileLine = container!.querySelector('.pp-user-file');
    expect(fileLine?.textContent).toContain('CONVENTIONS.md');
    expect(fileLine?.textContent).toContain('附 ·');
    expect(fileLine?.getAttribute('title')).toBe('D:/HoloGramHG/CONVENTIONS.md');
    // 圈点仍工作（C7 不回归）
    expect(container!.querySelector('.pp-circled')?.textContent).toBe('词');
    // 正文不含路径
    expect(container!.querySelector('.pp-body')?.textContent).not.toContain('D:/');
  });

  it('无附件：不渲染 pp-user-files', () => {
    const userDef = builtinRendererDefs().find((d) => d.kind === 'user')!;
    const blocks = translateMessages([userMsg()]);
    act(() => {
      root?.render(createElement(userDef.component, { block: blocks[0] }));
    });
    expect(container!.querySelector('.pp-user-files')).toBeNull();
  });
});

describe('C10 圈点不回归（parseCircledSegments 冒烟）', () => {
  it('【词】解析为圈段', () => {
    const segs = parseCircledSegments('前【中】后');
    expect(segs.some((s) => s.circled && s.text === '中')).toBe(true);
  });
});
