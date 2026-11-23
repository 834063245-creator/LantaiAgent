// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件文档令牌表（插件文档通道 · 批 1 只读打通）——宿主侧单一真源。
//
// 为什么单独一张表：窗内容跑在 opaque origin 的 iframe 里，拿不到宿主桥，
// 唯一能力通道是 postMessage 白名单桥。桥上的 `doc.read` 只接受**令牌**、
// 不接受路径——路径解释权必须留在宿主（否则等于给插件任意读权限）。
//
// 绑定纪律（施工单 docs/plans/plugin-document-channel-plan.md §0）：
//   ① 令牌绑 windowId + pluginName，三件齐全才可解析——跨窗/跨插件串用一律不中；
//   ② 开窗签发、关窗整窗回收，卸载随窗走（不落盘、不跨会话）；
//   ③ v1 每窗一文档（开新文档先撤销该窗旧令牌）。
//
// 非渲染状态（没有订阅者）：纯模块 Map + 显式复位，故意不进 zustand。

/** 一笔文档授权：窗 + 插件 + 真实路径（路径只有宿主看得见）。 */
export interface DocumentGrant {
  docToken: string;
  pluginName: string;
  windowId: string;
  path: string;
}

const grants = new Map<string, DocumentGrant>();
let seq = 0;

/** 开窗签发：一窗一文档（先撤销该窗旧令牌，杜绝「上一份文档还活着」）。 */
export function issueDocumentGrant(windowId: string, pluginName: string, path: string): DocumentGrant {
  revokeDocumentGrantsForWindow(windowId);
  seq += 1;
  const grant: DocumentGrant = { docToken: `doc#${seq}`, pluginName, windowId, path };
  grants.set(grant.docToken, grant);
  return grant;
}

/** 桥面解析：三件齐全才中；跨窗/跨插件串用返回 null（不抛——调用方出具名错误文案）。 */
export function resolveDocumentGrant(windowId: string, pluginName: string, docToken: string): string | null {
  const grant = grants.get(docToken);
  if (!grant) return null;
  if (grant.windowId !== windowId || grant.pluginName !== pluginName) return null;
  return grant.path;
}

/** 该窗当前令牌（帧在 bridge-ready 后据此推 `doc-open`）；无 → null。 */
export function pendingDocumentGrant(windowId: string): DocumentGrant | null {
  for (const grant of grants.values()) {
    if (grant.windowId === windowId) return grant;
  }
  return null;
}

/** 关窗 / 换文档回收（整窗撤销——v1 一窗一文档）。 */
export function revokeDocumentGrantsForWindow(windowId: string): void {
  for (const [token, grant] of grants) {
    if (grant.windowId === windowId) grants.delete(token);
  }
}

/** 测试复位（vitest 同 worker 模块态跨用例共享——防串味）。 */
export function resetDocumentGrantsForTests(): void {
  grants.clear();
  seq = 0;
}
