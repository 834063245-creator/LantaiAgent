// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工作区授权（P1）——桥面五条闸钉住：
//   · 未声明 app.workspace ⇒ `ws.*` 具名拒绝且零读盘；
//   · 根令牌跨窗串用 / 无效 ⇒ 拒绝；
//   · 相对路径回溯/绝对路径 ⇒ 拒绝；
//   · 正路 list/read：只把根内绝对路径交给宿主 deps；
//   · `ws.read` 顺带签发的 docToken 能走既有 doc.save（写回仍过审）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindBridgeWindow,
  resetWindowBridgeForTests,
  WINDOW_BRIDGE_PROTOCOL,
  type WindowBridgeDeps,
} from '../src/plugins/window-bridge';
import { resetDocumentReviewsForTests, settleDocumentReview } from '../src/state/plugin-document-review';
import {
  issueDocumentGrant,
  issueWorkspaceGrant,
  resetDocumentGrantsForTests,
  resolveDocumentGrant,
} from '../src/state/plugin-document-store';

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

function fakeContentWindow(): FakeWindow {
  return { postMessage: vi.fn() };
}

function postFrom(cw: FakeWindow, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { source: cw as unknown as Window, data }));
}

function call(cw: FakeWindow, reqId: number, method: string, params: unknown): void {
  postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId, method, params });
}

function lastResult(cw: FakeWindow): Record<string, unknown> {
  const calls = cw.postMessage.mock.calls as unknown[][];
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

function makeDeps() {
  const listDirectory = vi.fn(async (_path: string) => [
    { name: 'a.md', is_dir: false, size: 3 },
    { name: 'sub', is_dir: true, size: 0 },
  ]);
  const readWorkspaceFile = vi.fn(async (path: string) => `TEXT:${path}`);
  const readDocument = vi.fn(async (path: string) => `TEXT:${path}`);
  const writeDocument = vi.fn(async () => undefined);
  const deps: WindowBridgeDeps = {
    fs: {
      list: vi.fn(async () => ({ entries: [] })),
      read: vi.fn(async () => 'x'),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    notify: vi.fn(),
    readDocument,
    writeDocument,
    listDirectory,
    readWorkspaceFile,
  };
  return { deps, listDirectory, readWorkspaceFile, readDocument, writeDocument };
}

beforeEach(() => {
  resetWindowBridgeForTests();
  resetDocumentGrantsForTests();
  resetDocumentReviewsForTests();
});

describe('工作区授权（P1）：根令牌 + 相对路径', () => {
  it('ws.list：根内相对路径拼接后交给宿主；entries 带 relPath', async () => {
    const cw = fakeContentWindow();
    const { deps, listDirectory } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, {
      documents: true,
      workspace: true,
    });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    call(cw, 1, 'ws.list', { rootToken: root.rootToken, relPath: 'docs' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(cw).ok).toBe(true);
    expect(listDirectory).toHaveBeenCalledWith('/work/docs');
    const result = lastResult(cw).result as { entries: Array<{ relPath: string }> };
    expect(result.entries.map((entry) => entry.relPath)).toEqual(['docs/a.md', 'docs/sub']);
  });

  it('ws.read：只读根内绝对路径；顺带签发 docToken 且可保存', async () => {
    const cw = fakeContentWindow();
    const { deps, readWorkspaceFile, writeDocument } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, {
      documents: true,
      workspace: true,
    });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    call(cw, 1, 'ws.read', { rootToken: root.rootToken, relPath: 'docs/a.md' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(cw).ok).toBe(true);
    expect(readWorkspaceFile).toHaveBeenCalledWith('/work/docs/a.md');
    const result = lastResult(cw).result as { text: string; rev: string; docToken: string };
    expect(result.text).toBe('TEXT:/work/docs/a.md');
    expect(result.rev).toMatch(/^[0-9a-z]+\.[0-9a-f]{8}$/);

    const grant = resolveDocumentGrant('acme/md#1', 'acme/md', result.docToken);
    expect(grant?.path).toBe('/work/docs/a.md');
    expect(grant?.rootToken).toBe(root.rootToken);

    call(cw, 2, 'doc.save', {
      docToken: result.docToken,
      content: 'after\n',
      baseRev: result.rev,
    });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(2));
    const save = lastResult(cw).result as { status: string; reviewId: string };
    expect(save.status).toBe('pending-review');
    settleDocumentReview(save.reviewId, true);
    await vi.waitFor(() => expect(writeDocument).toHaveBeenCalledWith('/work/docs/a.md', 'after\n'));
  });

  it('ws.read 的 baseRev 不匹配 → conflict，写盘零次', async () => {
    const cw = fakeContentWindow();
    const { deps, writeDocument } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, {
      documents: true,
      workspace: true,
    });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    const doc = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md', { rootToken: root.rootToken });
    call(cw, 1, 'doc.save', { docToken: doc.docToken, content: 'after\n', baseRev: 'stale' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect((lastResult(cw).result as { status: string }).status).toBe('conflict');
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('未声明 app.workspace → ws.* 拒绝且零读盘', async () => {
    const cw = fakeContentWindow();
    const { deps, listDirectory, readWorkspaceFile } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    call(cw, 1, 'ws.list', { rootToken: root.rootToken, relPath: '' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(cw).ok).toBe(false);
    expect(String(lastResult(cw).error)).toContain('app.workspace');
    expect(listDirectory).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('根令牌跨窗串用 / 无令牌 ⇒ 拒绝', async () => {
    const a = fakeContentWindow();
    const b = fakeContentWindow();
    const { deps } = makeDeps();
    bindBridgeWindow(a as unknown as Window, 'acme/md', 'acme/md#1', deps, {
      documents: true,
      workspace: true,
    });
    bindBridgeWindow(b as unknown as Window, 'acme/md', 'acme/md#2', deps, {
      documents: true,
      workspace: true,
    });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    call(b, 1, 'ws.list', { rootToken: root.rootToken, relPath: '' });
    await vi.waitFor(() => expect(b.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(b).ok).toBe(false);
    expect(String(lastResult(b).error)).toContain('根令牌');

    call(a, 2, 'ws.list', { relPath: '' });
    await vi.waitFor(() => expect(a.postMessage).toHaveBeenCalledTimes(1));
    expect(lastResult(a).ok).toBe(false);
    expect(String(lastResult(a).error)).toContain('rootToken');
  });

  it('回溯 / 绝对路径 / 空文件路径 ⇒ 拒绝且零读盘', async () => {
    const cw = fakeContentWindow();
    const { deps, listDirectory, readWorkspaceFile } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, {
      documents: true,
      workspace: true,
    });
    const root = issueWorkspaceGrant('acme/md#1', 'acme/md', '/work');
    for (const [reqId, method, params] of [
      [1, 'ws.list', { rootToken: root.rootToken, relPath: '../secret' }],
      [2, 'ws.list', { rootToken: root.rootToken, relPath: '/etc/passwd' }],
      [3, 'ws.read', { rootToken: root.rootToken, relPath: '../secret' }],
      [4, 'ws.read', { rootToken: root.rootToken, relPath: '' }],
    ] as const) {
      call(cw, reqId, method, params);
    }
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(4));
    for (const result of cw.postMessage.mock.calls) {
      expect((result[0] as { ok: boolean }).ok).toBe(false);
    }
    expect(listDirectory).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });
});
