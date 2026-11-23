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
import { kernelListDirectoryFlat, kernelReadFile, kernelWriteFile } from '../rpc-contract';
import { summarizeDocumentDiff } from '../state/plugin-document-diff';
import { hasPendingReviewForWindow, requestDocumentReview } from '../state/plugin-document-review';
import { issueDocumentGrant, resolveDocumentGrant, resolveWorkspaceGrant } from '../state/plugin-document-store';
import { contentRevision, joinWorkspacePath, normalizeRelPath } from '../state/plugin-workspace-path';
import type { PluginDataFs } from './data-fs';
import { pluginDataFs } from './data-fs';

/** 桥协议标识（窗内 SDK 与宿主对拍——非本协议的 message 静默忽略）。 */
export const WINDOW_BRIDGE_PROTOCOL = 'lantai-plugin-bridge';

/** 宿主→窗广播事件（§4-3：以加载完成/卸载告警为限）。
 *  - bridge-ready：宿主桥已就绪（窗内从此发 call 不会丢）；
 *  - window-closing：即将关窗（尽力而为告警——iframe 移除与投递同拍，
 *    收到与否无保证；需要可靠持久化的插件应改动即存）。 */
export type WindowBridgeEvent =
  | 'bridge-ready'
  | 'window-closing'
  | 'workspace-open'
  | 'doc-open'
  /** 改稿单裁决回推（批 2）：approve → 已落盘；reject → 用户退回或写盘失败（带 reason）。 */
  | 'doc-saved'
  | 'doc-rejected';

/** 桥方法白名单（默认最小集——扩展须过契约审视，克制开面）。 */
export type WindowBridgeMethod =
  | 'fs.list'
  | 'fs.read'
  | 'fs.write'
  | 'fs.delete'
  | 'notify'
  /** 文档通道（批 1 只读）：凭令牌读宿主文档——只收 docToken，不收路径。 */
  | 'doc.read'
  /** 文档通道（批 2 写回）：交新正文 → 宿主出改稿单；回执只报 pending-review。 */
  | 'doc.save'
  /** 工作区授权（P1）：根令牌 + 相对路径；`ws.read` 顺带签发文档令牌。 */
  | 'ws.list'
  | 'ws.read';

/** 每窗依赖（fs/notify 可注入——测试隔离 RPC 通道；缺省真源）。 */
export interface WindowBridgeDeps {
  fs: Pick<PluginDataFs, 'list' | 'read' | 'write' | 'delete'>;
  notify: (text: string) => void;
  /** 读宿主文档正文（路径来自宿主签发的令牌解析，窗不参与——见 plugin-document-store）。 */
  readDocument: (path: string) => Promise<string>;
  /** 写回宿主文档（只在改稿单被批准后调用；路径同样来自令牌解析）。 */
  writeDocument: (path: string, content: string) => Promise<void>;
  /** 列一层工作区目录（P1；缺省 = kernelListDirectoryFlat）。 */
  listDirectory?: (path: string) => Promise<Array<{ name: string; is_dir: boolean; size?: number }>>;
  /** 读工作区文件（P1；缺省 = kernelReadFile——与 readDocument 同源）。 */
  readWorkspaceFile?: (path: string) => Promise<string>;
}

export function defaultWindowBridgeDeps(): WindowBridgeDeps {
  return {
    fs: pluginDataFs,
    notify: (text) => useShellStore.getState().pushStatus(text),
    readDocument: (path) => kernelReadFile(path),
    writeDocument: async (path, content) => {
      await kernelWriteFile(path, content);
    },
    listDirectory: (path) => kernelListDirectoryFlat(path),
    readWorkspaceFile: (path) => kernelReadFile(path),
  };
}

interface BridgeBinding {
  pluginName: string;
  windowId: string;
  deps: WindowBridgeDeps;
  /** 文档通道（manifest.app.documents 折算）：false ⇒ 桥面不认 doc.*（kill switch）。 */
  documents: boolean;
  /** 工作区授权（manifest.app.workspace 折算）：false ⇒ 桥面不认 ws.*（kill switch）。 */
  workspace: boolean;
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

/** 按 windowId 定向广播（批 2：改稿单裁决要回推到**发起它的那扇窗**，不打扰别的窗）。 */
export function postBridgeEventToWindow(
  windowId: string,
  event: WindowBridgeEvent,
  payload?: Record<string, unknown>,
): void {
  for (const [cw, binding] of bindings) {
    if (binding.windowId === windowId) postBridgeEvent(cw, event, windowId, payload);
  }
}

/** 宿主 → 窗：广播（bridge-ready / window-closing）。 */
export function postBridgeEvent(
  cw: Window,
  event: WindowBridgeEvent,
  windowId?: string,
  payload?: Record<string, unknown>,
): void {
  try {
    cw.postMessage({ protocol: WINDOW_BRIDGE_PROTOCOL, op: 'event', event, windowId, ...(payload ?? {}) }, '*');
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
    // 文档通道（批 1 只读）：三道闸——能力声明 / 令牌 / 令牌绑窗（resolve 内判）。
    // 窗永远只说令牌，路径由令牌表解析：窗自报路径 ⇒ 等于任意读，这条不能破。
    case 'doc.read': {
      if (!binding.documents) {
        throw new Error('doc.read 拒绝：插件未声明 app.documents（文档通道未开启）');
      }
      const docToken = reqStr(p.docToken, 'docToken');
      const grant = resolveDocumentGrant(binding.windowId, binding.pluginName, docToken);
      if (grant == null) throw new Error('doc.read 拒绝：文档令牌无效或已过期');
      const text = await binding.deps.readDocument(grant.path);
      return { path: grant.path, text, rev: contentRevision(text) };
    }
    // 工作区授权（P1）：根令牌绑定窗/插件；窗只报 `relPath`，拼接与围栏在宿主。
    // `ws.list` 不签发文档令牌（列目录不该膨胀令牌表）；`ws.read` 读一份文件时
    // 顺带签发 docToken——后续保存走既有 doc.save 改稿单，不另开写通道。
    case 'ws.list': {
      if (!binding.workspace) {
        throw new Error('ws.list 拒绝：插件未声明 app.workspace（工作区授权未开启）');
      }
      const rootToken = reqStr(p.rootToken, 'rootToken');
      const grant = resolveWorkspaceGrant(binding.windowId, binding.pluginName, rootToken);
      if (grant == null) throw new Error('ws.list 拒绝：工作区根令牌无效或已过期');
      const relPath = typeof p.relPath === 'string' ? p.relPath : '';
      const relNorm = normalizeRelPath(relPath);
      if (relNorm == null) throw new Error('ws.list 拒绝：相对路径非法（禁绝对路径/回溯/反斜杠）');
      const absolute = joinWorkspacePath(grant.rootPath, relNorm);
      if (absolute == null) throw new Error('ws.list 拒绝：路径越出工作区根');
      const listDirectory = binding.deps.listDirectory;
      if (!listDirectory) throw new Error('ws.list 拒绝：宿主未装配目录列举能力');
      const entries = await listDirectory(absolute);
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          is_dir: entry.is_dir,
          size: entry.size ?? 0,
          relPath: relNorm ? `${relNorm}/${entry.name}` : entry.name,
        })),
      };
    }
    case 'ws.read': {
      if (!binding.workspace) {
        throw new Error('ws.read 拒绝：插件未声明 app.workspace（工作区授权未开启）');
      }
      const rootToken = reqStr(p.rootToken, 'rootToken');
      const grant = resolveWorkspaceGrant(binding.windowId, binding.pluginName, rootToken);
      if (grant == null) throw new Error('ws.read 拒绝：工作区根令牌无效或已过期');
      const relPath = reqStr(p.relPath, 'relPath');
      const relNorm = normalizeRelPath(relPath);
      if (relNorm == null || relNorm === '') {
        throw new Error('ws.read 拒绝：相对路径非法（必须是根内的文件路径）');
      }
      const absolute = joinWorkspacePath(grant.rootPath, relNorm);
      if (absolute == null) throw new Error('ws.read 拒绝：路径越出工作区根');
      const readWorkspaceFile = binding.deps.readWorkspaceFile ?? binding.deps.readDocument;
      const text = await readWorkspaceFile(absolute);
      const doc = issueDocumentGrant(binding.windowId, binding.pluginName, absolute, {
        rootToken,
        origin: 'workspace',
      });
      return { text, rev: contentRevision(text), docToken: doc.docToken, relPath: relNorm };
    }
    // 文档通道（批 2 写回）：门口与 doc.read 同三道（能力 / 令牌 / 绑窗），再多一道
    // 「一窗一笔待审」——同一扇窗不许同时挂两张改稿单（会在用户面前互相打架）。
    // **不直接落盘**：交单后立刻回 pending-review，用户批准才写（写盘调用零次是默认态）。
    case 'doc.save': {
      if (!binding.documents) {
        throw new Error('doc.save 拒绝：插件未声明 app.documents（文档通道未开启）');
      }
      const docToken = reqStr(p.docToken, 'docToken');
      const grant = resolveDocumentGrant(binding.windowId, binding.pluginName, docToken);
      if (grant == null) throw new Error('doc.save 拒绝：文档令牌无效或已过期');
      const path = grant.path;
      if (hasPendingReviewForWindow(binding.windowId)) {
        throw new Error('doc.save 拒绝：本窗已有一张待审改稿单');
      }
      const content = reqStr(p.content, 'content');
      const before = await binding.deps.readDocument(path);
      const baseRev = typeof p.baseRev === 'string' ? p.baseRev : null;
      if (baseRev != null && contentRevision(before) !== baseRev) {
        return { status: 'conflict', path, currentRev: contentRevision(before) };
      }
      const summary = summarizeDocumentDiff(before, content);
      if (summary.added === 0 && summary.removed === 0) return { status: 'unchanged', path };
      const { reviewId, approved } = requestDocumentReview({
        windowId: binding.windowId,
        pluginName: binding.pluginName,
        path,
        content,
        added: summary.added,
        removed: summary.removed,
        diff: summary.text,
      });
      const windowId = binding.windowId;
      void approved
        .then(async (ok) => {
          if (!ok) {
            postBridgeEventToWindow(windowId, 'doc-rejected', { reviewId, path, reason: 'rejected' });
            return;
          }
          try {
            await binding.deps.writeDocument(path, content);
            postBridgeEventToWindow(windowId, 'doc-saved', {
              reviewId,
              path,
              rev: contentRevision(content),
            });
          } catch (e) {
            postBridgeEventToWindow(windowId, 'doc-rejected', { reviewId, path, reason: errText(e) });
          }
        })
        .catch(() => undefined);
      return {
        status: 'pending-review',
        reviewId,
        path,
        added: summary.added,
        removed: summary.removed,
        diff: summary.text,
      };
    }
    default:
      throw new Error(
        `方法 "${method}" 不在白名单（默认最小集 fs.list/fs.read/fs.write/fs.delete/notify + doc.read/doc.save + ws.list/ws.read——按需申请）`,
      );
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
  capabilities: { documents?: boolean; workspace?: boolean } = {},
): void {
  bindings.set(cw, {
    pluginName,
    windowId,
    deps,
    documents: capabilities.documents === true,
    workspace: capabilities.workspace === true,
  });
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
