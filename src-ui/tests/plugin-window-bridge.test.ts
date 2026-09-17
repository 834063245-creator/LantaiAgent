// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// postMessage 白名单桥（app shell 件 A · S3）钉住面：
//   - 容器侧身份绑定：插件名取自绑定表（contentWindow 身份），消息不携带
//     也不可信插件名——fs 调用恒以绑定的插件身份发（S1 data-fs 注释的
//     「S3 窗口面由容器侧绑定」承诺兑现）；
//   - 方法级白名单：默认最小集 fs.list/read/write/delete + notify；白名单
//     外方法 error 回执（不静默）；
//   - 未绑定 source 静默丢弃；非本协议消息静默忽略；malformed 请求 error
//     回执（窗口内容不炸宿主——桥是宿主面，垃圾输入不炸不漏）；
//   - reqId 关联回执；宿主→窗广播（bridge-ready / window-closing）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindBridgeWindow,
  postBridgeEvent,
  resetWindowBridgeForTests,
  unbindBridgeWindow,
  WINDOW_BRIDGE_PROTOCOL,
  type WindowBridgeDeps,
} from '../src/plugins/window-bridge';

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

/** 伪 contentWindow：捕获宿主回执/广播（source 身份 = 对象同一性）。 */
function fakeContentWindow(): FakeWindow {
  return { postMessage: vi.fn() };
}

/** 以伪 iframe 身份向宿主发一条 message（source 携带——真实浏览器由
 *  MessageEvent.source 承载，此处同构）。 */
function postFrom(cw: FakeWindow, data: unknown): void {
  const ev = new MessageEvent('message', { source: cw as unknown as Window, data });
  window.dispatchEvent(ev);
}

function makeDeps(): {
  deps: WindowBridgeDeps;
  fs: {
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  notify: ReturnType<typeof vi.fn>;
} {
  const fs = {
    list: vi.fn(async () => ({ entries: [] })),
    read: vi.fn(async () => 'content'),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const notify = vi.fn();
  return { deps: { fs, notify }, fs, notify };
}

beforeEach(() => {
  resetWindowBridgeForTests();
});

describe('S3 postMessage 桥：容器侧身份绑定 + 白名单分发', () => {
  it('fs.* 四动作以绑定身份调用（消息不携带插件名）→ reqId 关联回执', async () => {
    const cw = fakeContentWindow();
    const { deps, fs } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/notes', 'acme/notes#1', deps);
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId: 1, method: 'fs.list', params: {} });
    postFrom(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'call',
      reqId: 2,
      method: 'fs.read',
      params: { path: 'notes.json' },
    });
    postFrom(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'call',
      reqId: 3,
      method: 'fs.write',
      params: { path: 'a.json', content: 'x' },
    });
    postFrom(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'call',
      reqId: 4,
      method: 'fs.delete',
      params: { path: 'a.json' },
    });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(4));
    expect(fs.list).toHaveBeenCalledWith('acme/notes', '');
    expect(fs.read).toHaveBeenCalledWith('acme/notes', 'notes.json');
    expect(fs.write).toHaveBeenCalledWith('acme/notes', 'a.json', 'x');
    expect(fs.delete).toHaveBeenCalledWith('acme/notes', 'a.json');
    const calls = cw.postMessage.mock.calls as unknown[][];
    expect(calls.map((c) => (c[0] as { reqId: number }).reqId)).toEqual([1, 2, 3, 4]);
    for (const c of calls) {
      const payload = c[0] as { op: string; ok: boolean };
      expect(payload.op).toBe('result');
      expect(payload.ok).toBe(true);
    }
  });

  it('notify → 宿主通知面；fs.read 缺 path → error 回执（形状校验）', async () => {
    const cw = fakeContentWindow();
    const { deps, notify } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/notes', 'acme/notes#1', deps);
    postFrom(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'call',
      reqId: 7,
      method: 'notify',
      params: { text: '保存成功' },
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('保存成功'));
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId: 8, method: 'fs.read', params: {} });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(2));
    const errPayload = cw.postMessage.mock.calls[1][0] as { reqId: number; ok: boolean; error: string };
    expect(errPayload.reqId).toBe(8);
    expect(errPayload.ok).toBe(false);
    expect(errPayload.error).toContain('path');
  });

  it('白名单外方法 → error 回执（不静默）；未绑定 source 静默丢弃；非本协议忽略', async () => {
    const cw = fakeContentWindow();
    const stranger = fakeContentWindow();
    const { deps, fs } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/notes', 'acme/notes#1', deps);
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId: 1, method: 'mods.takeAll', params: {} });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(1));
    expect((cw.postMessage.mock.calls[0][0] as { ok: boolean }).ok).toBe(false);
    // 未绑定窗（陌生 source）：静默丢弃——无回执无异常
    postFrom(stranger, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'call',
      reqId: 2,
      method: 'fs.read',
      params: { path: 'x' },
    });
    postFrom(cw, { someOther: 'protocol' });
    postFrom(cw, 'just a string');
    await new Promise((r) => setTimeout(r, 30));
    expect(cw.postMessage).toHaveBeenCalledTimes(1); // 仍是那一条 error 回执
    expect(stranger.postMessage).not.toHaveBeenCalled();
    expect(fs.read).not.toHaveBeenCalled();
  });

  it('malformed 请求（无 op/method/reqId）→ error 回执带 reqId 兜底', async () => {
    const cw = fakeContentWindow();
    const { deps } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/notes', 'acme/notes#1', deps);
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', method: 'notify' });
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, reqId: 5 });
    await vi.waitFor(() => expect(cw.postMessage).toHaveBeenCalledTimes(2));
    const p1 = cw.postMessage.mock.calls[0][0] as { reqId: number; ok: boolean };
    const p2 = cw.postMessage.mock.calls[1][0] as { reqId: number; ok: boolean };
    expect(p1.ok).toBe(false);
    expect(p1.reqId).toBe(-1);
    expect(p2.ok).toBe(false);
    expect(p2.reqId).toBe(5);
  });

  it('宿主 → 窗广播：bridge-ready / window-closing；unbind 后不再分发', async () => {
    const cw = fakeContentWindow();
    const { deps } = makeDeps();
    bindBridgeWindow(cw as unknown as Window, 'acme/notes', 'acme/notes#1', deps);
    postBridgeEvent(cw as unknown as Window, 'bridge-ready', 'acme/notes#1');
    expect(cw.postMessage).toHaveBeenCalledWith(
      { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'event', event: 'bridge-ready', windowId: 'acme/notes#1' },
      '*',
    );
    unbindBridgeWindow(cw as unknown as Window);
    postBridgeEvent(cw as unknown as Window, 'window-closing');
    postFrom(cw, { protocol: WINDOW_BRIDGE_PROTOCOL, op: 'call', reqId: 1, method: 'notify', params: { text: 'x' } });
    await new Promise((r) => setTimeout(r, 30));
    // 解绑后：广播仍可发（postBridgeEvent 是尽力而为的宿主动作，不查绑定表
    // ——contentWindow 死引用由 try/catch 兜），但 call 分发不再受理
    expect(cw.postMessage).toHaveBeenCalledTimes(2);
    expect((cw.postMessage.mock.calls[1][0] as { event: string }).event).toBe('window-closing');
  });
});
