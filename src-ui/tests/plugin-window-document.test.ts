// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件文档通道（批 1 只读）——桥面三道闸钉住：
//   · 未声明 app.documents ⇒ `doc.read` 具名拒绝，且 `readDocument` 一次都不许调（零副作用）；
//   · 无令牌 / 已撤销令牌 ⇒ 拒绝；
//   · 令牌跨窗串用 ⇒ 拒绝（令牌绑 windowId + pluginName，三件齐全才解析）；
//   · 正路：凭令牌拿回 `{ path, text }`——窗只说令牌，路径解释权只在宿主。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindBridgeWindow,
  resetWindowBridgeForTests,
  WINDOW_BRIDGE_PROTOCOL,
  type WindowBridgeDeps,
} from '../src/plugins/window-bridge';
import {
  issueDocumentGrant,
  resetDocumentGrantsForTests,
  revokeDocumentGrantsForWindow,
} from '../src/state/plugin-document-store';

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

function makeDeps(): { deps: WindowBridgeDeps; readDocument: ReturnType<typeof vi.fn> } {
  const fs = {
    list: vi.fn(async () => ({ entries: [] })),
    read: vi.fn(async () => 'x'),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const notify = vi.fn();
  const readDocument = vi.fn(async (path: string) => `TEXT:${path}`);
  return { deps: { fs, notify, readDocument } as WindowBridgeDeps, readDocument };
}

function docRead(cw: FakeWindow, reqId: number, params: unknown): void {
  postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId, method: 'doc.read', params });
}

beforeEach(() => {
  resetWindowBridgeForTests();
  resetDocumentGrantsForTests();
});

describe('插件文档通道：令牌化只读（批 1）', () => {
  it('声明 app.documents + 有令牌 → 读回 { path, text }（窗只交令牌）', async () => {
    const cw = fakeContentWindow();
    const { deps, readDocument } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    docRead(cw, 1, { docToken: grant.docToken });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    const payload = cw.postMessage.mock.calls[0][0] as {
      ok: boolean;
      result: { path: string; text: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result).toEqual({ path: '/work/docs/a.md', text: 'TEXT:/work/docs/a.md' });
    expect(readDocument).toHaveBeenCalledWith('/work/docs/a.md');
  });

  it('未声明 app.documents → 具名拒绝，且不读盘（零调用）', async () => {
    const cw = fakeContentWindow();
    const { deps, readDocument } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps);
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    docRead(cw, 1, { docToken: grant.docToken });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    const payload = cw.postMessage.mock.calls[0][0] as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('app.documents');
    expect(readDocument).not.toHaveBeenCalled();
  });

  it('无令牌 / 已撤销令牌 → 拒绝（不读盘）', async () => {
    const cw = fakeContentWindow();
    const { deps, readDocument } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    docRead(cw, 1, { docToken: 'doc#999' });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect((cw.postMessage.mock.calls[0][0] as { error: string }).error).toContain('令牌');
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    revokeDocumentGrantsForWindow('acme/md#1');
    docRead(cw, 2, { docToken: grant.docToken });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(2));
    expect((cw.postMessage.mock.calls[1][0] as { ok: boolean }).ok).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();
  });

  it('令牌跨窗串用 → 拒绝（绑 windowId + pluginName）', async () => {
    const a = fakeContentWindow();
    const b = fakeContentWindow();
    const { deps, readDocument } = makeDeps();
    bindBridgeWindow(a as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    bindBridgeWindow(b as unknown as Window, 'acme/md', 'acme/md#2', deps, { documents: true });
    const grant = issueDocumentGrant('acme/md#1', 'acme/md', '/work/docs/a.md');
    docRead(b, 1, { docToken: grant.docToken });
    await vi.waitFor(() => expect(b.postMessage).toHaveBeenCalledTimes(1));
    const payload = b.postMessage.mock.calls[0][0] as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('令牌');
    expect(readDocument).not.toHaveBeenCalled();
  });

  it('缺 docToken → 形状校验拒绝（不静默）', async () => {
    const cw = fakeContentWindow();
    const { deps } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/md', 'acme/md#1', deps, { documents: true });
    docRead(cw, 1, {});
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    const payload = cw.postMessage.mock.calls[0][0] as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('docToken');
  });
});
