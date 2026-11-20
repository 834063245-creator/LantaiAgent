// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 夹签轨的渲染（docs/plans/card-quote-plan.md §2.4/§2.6/§9.2）：
//   · 空槽不出轨；一枚 / 多枚；超长标题单行省略由 CSS 承担（这里只钉结构）；
//   · **只有夹签也能拟文**（canSend 判据加夹签）；
//   · 撕掉 = 只出槽，不动正文。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputRow, type InputRowProps } from '../src/plugins/builtin/compose-dock/composer-rows';
import type { QuoteCard } from '../src/state/card-quote';

const quote = (assetId: string, over: Partial<QuoteCard> = {}): QuoteCard => ({
  refId: `q-${assetId}`,
  origin: 'session',
  assetId,
  sourceSessionId: '1',
  kind: 'html',
  title: `卡 ${assetId}`,
  bytes: 4524,
  at: '2026-11-19T02:52:13.000Z',
  ...over,
});

function props(over: Partial<InputRowProps> = {}): InputRowProps {
  return {
    composerRef: { current: null },
    placeholder: '拟文…',
    inputText: '',
    onPaste: vi.fn(),
    onChange: vi.fn(),
    onFocus: vi.fn(),
    onKeyDown: vi.fn(),
    slashCommands: [],
    slashQuery: null,
    slashIdx: 0,
    slashHit: '',
    onSlashHover: vi.fn(),
    onSlashCommit: vi.fn(),
    yinOpen: false,
    yinQuery: '',
    onYinQuery: vi.fn(),
    yinMatches: [],
    yinIdx: 0,
    onYinHover: vi.fn(),
    yinEmpty: '',
    yinInputRef: { current: null },
    onYinKeyDown: vi.fn(),
    onYinAttach: vi.fn(),
    onPreviewImage: vi.fn(),
    attachedFiles: [],
    attachedImages: [],
    attachedCards: [],
    onRemoveAttached: vi.fn(),
    onRemoveAttachedImage: vi.fn(),
    onRemoveAttachedCard: vi.fn(),
    onToggleYin: vi.fn(),
    onAttach: vi.fn(),
    running: false,
    onSend: vi.fn(),
    onAbort: vi.fn(),
    ...over,
  };
}

describe('夹签轨', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const mount = (p: InputRowProps) => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(InputRow, p));
    });
  };

  it('空槽：整条轨不渲染（不占位、不留空洞）', () => {
    mount(props());
    expect(container.querySelector('.pp-card-rail')).toBeNull();
  });

  it('一枚：物类签 + 标题 + 撕掉钮；缩略纸本体**不可聚焦**（点它没有动作）', () => {
    mount(props({ attachedCards: [quote('as_a')] }));
    const rail = container.querySelector('.pp-card-rail')!;
    expect(rail).not.toBeNull();
    expect(rail.querySelectorAll('.pp-quote')).toHaveLength(1);
    expect(rail.querySelector('.pp-quote-sign')?.textContent).toBe('页'); // html → 页
    expect(rail.querySelector('.pp-quote-title')?.textContent).toBe('卡 as_a');
    // 本体是说明性纸片（方案 §0.2：要动的是原卡）——不许是一颗按下去什么都不发生的按钮
    expect(rail.querySelector('.pp-quote')?.tagName).toBe('SPAN');
    expect(rail.querySelector('button.pp-quote')).toBeNull();
    expect(rail.querySelector('.pp-quote-remove')?.tagName).toBe('BUTTON');
    // 一枚时不显示「共 N 签」
    expect(rail.querySelector('.pp-attach-count')).toBeNull();
  });

  it('多枚：逐枚渲染 + 计数；未命名回落「未命名」；未知 kind 回落「录」', () => {
    mount(
      props({
        attachedCards: [quote('as_a'), quote('as_b', { title: '', kind: 'weird-kind' })],
      }),
    );
    const rail = container.querySelector('.pp-card-rail')!;
    const items = rail.querySelectorAll('.pp-quote');
    expect(items).toHaveLength(2);
    expect(items[1].querySelector('.pp-quote-sign')?.textContent).toBe('录');
    expect(items[1].querySelector('.pp-quote-title')?.textContent).toBe('未命名');
    expect(rail.querySelector('.pp-attach-count')?.textContent).toBe('共 2 签');
  });

  it('撕掉：回调携带**槽内下标**（点第二枚 = 1）', () => {
    const onRemove = vi.fn();
    mount(props({ attachedCards: [quote('as_a'), quote('as_b')], onRemoveAttachedCard: onRemove }));
    const removes = container.querySelectorAll('.pp-quote-remove');
    act(() => (removes[1] as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('canSend：**只有夹签**也能拟文（正文 / 附件 / 附图全空）', () => {
    mount(props({ attachedCards: [quote('as_a')] }));
    const send = container.querySelector('.pp-send') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('守门：三槽全空时拟文仍是死键', () => {
    mount(props());
    const send = container.querySelector('.pp-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
