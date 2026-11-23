// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 改稿单确认面（文档通道 · 批 2 的最后一环）——把「薄壳」钉住：
//   · 有待审单 ⇒ 真的渲染出来（路径 + 计数 + 差分都在）；
//   · 点「写入」⇒ 决议 true + store 清空；点「退回」⇒ 决议 false + store 清空；
//   · 关窗撤单 ⇒ 决议 false + 弹窗消失（不留孤儿单）。

// 为什么值得单测：宿主写盘与否只取决于这里的决议——它错了，前面所有门都白设。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentReviewHost } from '../src/app/plugin-windows/DocumentReviewHost';
import {
  cancelDocumentReviewsForWindow,
  requestDocumentReview,
  resetDocumentReviewsForTests,
} from '../src/state/plugin-document-review';
import { useDocumentReviewStore } from '../src/state/plugin-document-review-store';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetDocumentReviewsForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 按钮可能落在 Overlay 的 portal 里——查整个 body，不查容器。 */
function clickByText(text: string): void {
  const btn = Array.from(document.body.querySelectorAll('button')).find((b) => (b.textContent || '').includes(text));
  if (!btn) throw new Error('找不到按钮：' + text);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function requestOne() {
  return requestDocumentReview({
    windowId: 'acme/md#1',
    pluginName: 'acme/md',
    path: '/work/docs/a.md',
    content: '二行\n',
    added: 1,
    removed: 1,
    diff: '-一行\n+二行',
  });
}

describe('改稿单确认面：决议只在这里产生', () => {
  it('渲染路径 / 计数 / 差分；点「写入」→ true 且 store 清空', async () => {
    const { approved } = requestOne();
    act(() => {
      root.render(createElement(DocumentReviewHost));
    });
    expect(document.body.textContent).toContain('/work/docs/a.md');
    expect(document.body.textContent).toContain('+1');
    expect(document.body.textContent).toContain('−1');
    clickByText('写入');
    await expect(approved).resolves.toBe(true);
    expect(useDocumentReviewStore.getState().review).toBeNull();
  });

  it('点「退回」→ false 且 store 清空（写盘不发生由桥侧测试保证）', async () => {
    const { approved } = requestOne();
    act(() => {
      root.render(createElement(DocumentReviewHost));
    });
    clickByText('退回');
    await expect(approved).resolves.toBe(false);
    expect(useDocumentReviewStore.getState().review).toBeNull();
  });

  it('关窗撤单 → 决议 false + 弹窗消失（不留孤儿单）', async () => {
    const { approved } = requestOne();
    act(() => {
      root.render(createElement(DocumentReviewHost));
    });
    expect(useDocumentReviewStore.getState().review).not.toBeNull();
    act(() => {
      cancelDocumentReviewsForWindow('acme/md#1');
    });
    await expect(approved).resolves.toBe(false);
    expect(useDocumentReviewStore.getState().review).toBeNull();
  });
});
