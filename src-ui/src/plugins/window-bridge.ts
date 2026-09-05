// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// postMessage 白名单桥 — 宿主侧（app shell 四件套 · 件 A，S3）。
//
// 隔离模型（§4-3 拍板 iframe 真隔离）：窗内容是插件自包含 HTML（资产通道
// 寻址，opaque origin——sandbox 不给 allow-same-origin），拿不到宿主桥
// window.__lantai_plugin_host__。窗内向宿主要能力走本桥：
//   - 窗 → 宿主：`{ protocol, op: 'call', reqId, method, params }`
//     → 宿主回 `{ protocol, op: 'result', reqId, ok, result | error }`；
//   - 宿主 → 窗：仅加载完成/卸载告警两种广播
//     （`{ protocol, op: 'event', event: 'bridge-ready' | 'window-closing' }`）。
//
// 白名单纪律（§4-3：方法级白名单，不整体开放 mods）：默认最小集 =
// fs 数据目录四动作（list/read/write/delete）+ notify。其余按需申请，
// 清单以此处 switch 为准。
//
// 信任模型：**插件身份由容器侧绑定**（绑定表 contentWindow → pluginName，
// 视口容器在 iframe onLoad 时登记）——窗内消息不携带也不可信插件名；
// event.source 不在绑定表 = 静默丢弃。fs 路径围栏在 Rust plugin_data
// （名字 + rel 双围栏 + canonicalize 前缀），本桥只做形状校验。

import { useShellStore } from '../app/shell-store';
import type { PluginDataFs } from './data-fs';
import { pluginDataFs } from './data-fs';

/** 桥协议标识（窗内 SDK 与宿主对拍——非本协议的 message 静默忽略）。 */
export const WINDOW_BRIDGE_PROTOCOL = 'lantai-plugin-bridge';

/** 宿主→窗广播事件（§4-3：以加载完成/卸载告警为限）。
 *  - bridge-ready：宿主桥已就绪（窗内从此发 call 不会丢）；
 *  - window-closing：即将关窗（尽力而为告警——iframe 移除与投递同拍，
 *    收到与否无保证；需要可靠持久化的插件应改动即存）。 */
export type WindowBridgeEvent = 'bridge-ready' | 'window-closing';

/** 桥方法白名单（默认最小集——扩展须过契约审视，克制开面）。 */
export type WindowBridgeMethod = 'fs.list' | 'fs.read' | 'fs.write' | 'fs.delete' | 'notify';

/** 每窗依赖（fs/notify 可注入——测试隔离 RPC 通道；缺省真源）。 */
export interface WindowBridgeDeps {
  fs: Pick<PluginDataFs, 'list' | 'read' | 'write' | 'delete'>;
  notify: (text: string) => void;
}

export function defaultWindowBridgeDeps(): WindowBridgeDeps {
  return {
    fs: pluginDataFs,
    notify: (text) => useShellStore.getState().pushStatus(text),
  };
}

interface BridgeBinding {
  pluginName: string;
  windowId: string;
  deps: WindowBridgeDeps;
}

/** 绑定表：contentWindow → 插件身份（容器侧权威——消息不携带插件名）。 */
const bindings = new Map<Window, BridgeBinding>();
let listener: ((ev: MessageEvent) => void) | null = null;

function ensureListener(): void {
  if (listener || typeof window === 'undefined') return;
  listener = (ev: MessageEvent) => {
    void handleHostMessage(ev);
  };
  window.addEventListener('message', listener);
}

function dropListenerIfIdle(): void {
  if (bindings.size > 0 || !listener) return;
  if (typeof window !== 'undefined') window.removeEventListener('message', listener);
  listener = null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function reqStr(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`参数 ${what} 必须是字符串`);
  return value;
}

/** 宿主 → 窗：回执（ok=true 带 result——undefined 归一为 null；ok=false 带 error）。 */
function postResult(cw: Window, payload: Record<string, unknown>): void {
  try {
    cw.postMessage(payload, '*');
  } catch {
    // 窗已关（contentWindow 死引用）——回执丢弃即可
  }
}

/** 宿主 → 窗：广播（bridge-ready / window-closing）。 */
export function postBridgeEvent(cw: Window, event: WindowBridgeEvent, windowId?: string): void {
  try {
    cw.postMessage({ protocol: WINDOW_BRIDGE_PROTOCOL, op: 'event', event, windowId }, '*');
  } catch {
    // 窗已关——尽力而为，丢即丢
  }
}

/** 白名单分发：插件身份取自绑定（容器侧），params 只做形状校验。 */
async function invokeMethod(binding: BridgeBinding, method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'fs.list':
      return binding.deps.fs.list(binding.pluginName, typeof p.path === 'string' ? p.path : '');
    case 'fs.read':
      return binding.deps.fs.read(binding.pluginName, reqStr(p.path, 'path'));
    case 'fs.write':
      return binding.deps.fs.write(binding.pluginName, reqStr(p.path, 'path'), reqStr(p.content, 'content'));
    case 'fs.delete':
      return binding.deps.fs.delete(binding.pluginName, reqStr(p.path, 'path'));
    case 'notify':
      binding.deps.notify(reqStr(p.text, 'text'));
      return null;
    default:
      throw new Error(`方法 "${method}" 不在白名单（默认最小集 fs.list/fs.read/fs.write/fs.delete/notify——按需申请）`);
  }
}

async function handleHostMessage(ev: MessageEvent): Promise<void> {
  const data: unknown = ev.data;
  if (data == null || typeof data !== 'object') return;
  const msg = data as Record<string, unknown>;
  if (msg.protocol !== WINDOW_BRIDGE_PROTOCOL) return;
  const source = ev.source;
  const binding = source != null ? bindings.get(source as Window) : undefined;
  if (!binding) return; // 未绑定窗（或已关）——静默丢弃
  const reqId = msg.reqId;
  if (msg.op !== 'call' || typeof msg.method !== 'string' || typeof reqId !== 'number') {
    postResult(source as Window, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'result',
      reqId: typeof reqId === 'number' ? reqId : -1,
      ok: false,
      error: 'malformed request（期望 { protocol, op:"call", reqId:number, method, params }）',
    });
    return;
  }
  const cw = source as Window;
  try {
    const result = await invokeMethod(binding, msg.method, msg.params);
    postResult(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'result',
      reqId,
      ok: true,
      result: result === undefined ? null : result,
    });
  } catch (e) {
    postResult(cw, {
      protocol: WINDOW_BRIDGE_PROTOCOL,
      op: 'result',
      reqId,
      ok: false,
      error: errText(e),
    });
  }
}

/** 视口容器绑定窗（iframe onLoad 时调）：contentWindow → 插件身份。
 *  deps 缺省真源（fs = pluginDataFs，notify = 状态栏通知）。 */
export function bindBridgeWindow(
  cw: Window,
  pluginName: string,
  windowId: string,
  deps: WindowBridgeDeps = defaultWindowBridgeDeps(),
): void {
  bindings.set(cw, { pluginName, windowId, deps });
  ensureListener();
}

/** 视口容器解绑（iframe 卸载/关窗时调）。 */
export function unbindBridgeWindow(cw: Window): void {
  bindings.delete(cw);
  dropListenerIfIdle();
}

/** 测试复位（vitest 同 worker 模块态跨用例共享——防串味）。 */
export function resetWindowBridgeForTests(): void {
  bindings.clear();
  if (listener && typeof window !== 'undefined') {
    window.removeEventListener('message', listener);
  }
  listener = null;
}
