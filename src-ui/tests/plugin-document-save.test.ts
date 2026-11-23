// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件文档通道批 2（写回过审）——钉住四条：
//   · 未声明 / 无令牌 ⇒ 拒绝，且**写盘零次**；
//   · 正路 ⇒ 立刻回 `pending-review`（不等用户），**此刻写盘仍是零次**；
//   · 用户批准 ⇒ 写盘一次 + 窗收到 `doc-saved`；
//   · 用户退回 ⇒ 写盘零次 + 窗收到 `doc-rejected`。
//   · 正文与磁盘一致 ⇒ `unchanged`，不弹单。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindBridgeWindow,
  resetWindowBridgeForTests,
  WINDOW_BRIDGE_PROTOCOL,
  type WindowBridgeDeps,
} from '../src/plugins/window-bridge';
import { resetDocumentReviewsForTests, settleDocumentReview } from '../src/state/plugin-document-review';
import { issueDocumentGrant, resetDocumentGrantsForTests } from '../src/state/plugin-document-store';

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

function fakeContentWindow(): FakeWindow {
  return { postMessage: vi.fn() };
}

function postFrom(cw: FakeWindow, data: unknown): void {
  const ev = new MessageEvent('message', { source: cw as unknown as Window, data });
  window.dispatchEvent(ev);
}

function makeDeps(before: string): {
  deps: WindowBridgeDeps;
  writeDocument: ReturnType<typeof vi.fn>;
} {
  const fs = {
    list: vi.fn(async () => ({ entries: [] })),
    read: vi.fn(async () => 'x'),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const writeDocument = vi.fn(async () => undefined);
  return {
    deps: {
      fs,
      notify: vi.fn(),
      readDocument: vi.fn(async () => before),
      writeDocument,
    } as WindowBridgeDeps,
    writeDocument,
  };
}

function saveCall(cw: FakeWindow, reqId: number, params: unknown): void {
  postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId, method: 'doc.save', params });
}

function lastResult(cw: FakeWindow): Record<string, unknown> {
  const calls = cw.postMessage.mock.calls as unknown[][];
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  resetWindowBridgeForTests();
  resetDocumentGrantsForTests();
  resetDocumentReviewsForTests();
});

describe('插件文档通道批 2：交单 → 批准/退回', () => {
  it('正路：回 pending-review 且**未裁决前写盘零次**；批准后写一次 + doc-saved', async () => {
    const cw = fakeContentWindow();
    const { deps, writeDocument } = makeDeps('一行\n二行\n');
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    saveCall(cw, 1, { docToken: grant.docToken, content: '一行\n改过的二行\n' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    const payload = lastResult(cw);
    expect(payload.ok).toBe(true);
    expect((payload.result as { status: string }).status).toBe('pending-review');
    expect(writeDocument).not.toHaveBeenCalled();

    const reviewId = (payload.result as { reviewId: string }).reviewId;
    settleDocumentReview(reviewId, true);
    await vi.waitFor(() => expect(writeDocument).toHaveBeenCalledTimes(1));
    expect(writeDocument).toHaveBeenCalledWith('/work/docs/a.md', '一行\n改过的二行\n');
    await vi.waitFor(() =>
      expect(
        cw.postMessage.mock.calls.some((c) => (c[0] as { op: string; event?: string }).event === 'doc-saved'),
      ).toBe(true),
    );
  });

  it('退回：写盘零次 + doc-rejected', async () => {
    const cw = fakeContentWindow();
    const { deps, writeDocument } = makeDeps('a\n');
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    saveCall(cw, 1, { docToken: grant.docToken, content: 'b\n' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    const reviewId = (lastResult(cw).result as { reviewId: string }).reviewId;
    settleDocumentReview(reviewId, false);
    await vi.waitFor(() =>
      expect(cw.postMessage.mock.calls.some((c) => (c[0] as { event?: string }).event === 'doc-rejected')).toBe(true),
    );
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('未声明 app.documents → 拒绝，写盘零次', async () => {
    const cw = fakeContentWindow();
    const { deps, writeDocument } = makeDeps('a\n');
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps);
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    saveCall(cw, 1, { docToken: grant.docToken, content: 'b\n' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(cw).ok).toBe(false);
    expect(String(lastResult(cw).error)).toContain('app.documents');
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('无令牌 → 拒绝；正文与磁盘一致 → unchanged（不弹单不写盘）', async () => {
    const cw = fakeContentWindow();
    const { deps, writeDocument } = makeDeps('a\n');
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    saveCall(cw, 1, { docToken: 'doc#999', content: 'b\n' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(cw).ok).toBe(false);

    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    saveCall(cw, 2, { docToken: grant.docToken, content: 'a\n' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(2));
    expect((lastResult(cw).result as { status: string }).status).toBe('unchanged');
    expect(writeDocument).not.toHaveBeenCalled();
  });
});
