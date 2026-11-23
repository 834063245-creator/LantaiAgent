// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 宿主桥客户端（协议真源 = src-ui/src/plugins/window-bridge.ts）。
// 窗内容是 opaque origin：不能直接摸宿主，只能 postMessage 白名单调用。
// 这一层只管协议，不认文档/文件语义——业务在 main.js。

export const BRIDGE_PROTOCOL = 'lantai-plugin-bridge';

const CALL_TIMEOUT_MS = 15_000;

export function createBridge() {
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;
  let ready = false;
  let destroyed = false;
  const readyWaiters = [];

  function markReady() {
    if (ready) return;
    ready = true;
    while (readyWaiters.length) readyWaiters.shift()(true);
  }

  function waitReady(timeoutMs) {
    if (ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      readyWaiters.push(done);
      setTimeout(() => done(false), timeoutMs);
    });
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[wenjuan] 事件 ${event} 处理器失败`, error);
      }
    }
  }

  function onMessage(ev) {
    const data = ev.data;
    if (!data || typeof data !== 'object' || data.protocol !== BRIDGE_PROTOCOL) return;
    if (data.op === 'result') {
      const waiter = pending.get(data.reqId);
      if (!waiter) return;
      pending.delete(data.reqId);
      clearTimeout(waiter.timer);
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(new Error(String(data.error || '桥调用失败')));
      return;
    }
    if (data.op !== 'event') return;
    if (data.event === 'bridge-ready') markReady();
    emit(data.event, data);
  }

  window.addEventListener('message', onMessage);

  async function call(method, params) {
    if (destroyed) throw new Error('窗口已关闭');
    const ok = await waitReady(8_000);
    if (!ok) throw new Error('宿主桥未就绪——文卷需在兰台宿主内打开');
    return new Promise((resolve, reject) => {
      const reqId = ++seq;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`桥调用超时：${method}（宿主可能未响应）`));
      }, CALL_TIMEOUT_MS);
      pending.set(reqId, { resolve, reject, timer });
      try {
        window.parent.postMessage(
          { protocol: BRIDGE_PROTOCOL, op: 'call', reqId, method, params: params ?? {} },
          '*',
        );
      } catch (error) {
        pending.delete(reqId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  function destroy() {
    destroyed = true;
    window.removeEventListener('message', onMessage);
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('窗口已关闭'));
    }
    pending.clear();
    listeners.clear();
  }

  return {
    call,
    on,
    whenReady: (timeoutMs = 2_000) => waitReady(timeoutMs),
    isReady: () => ready,
    destroy,
  };
}
