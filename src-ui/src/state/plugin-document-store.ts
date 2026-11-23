// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件文档令牌表（插件文档通道 · 批 1 只读 + P1 工作区授权）——宿主侧单一真源。
//
// 为什么单独一张表：窗内容跑在 opaque origin 的 iframe 里，拿不到宿主桥，
// 唯一能力通道是 postMessage 白名单桥。桥上只接受**令牌**、不接受绝对路径——
// 路径解释权必须留在宿主（否则等于给插件任意读权限）。
//
// 两级授权（P1，2026-11-23 用户拍板「工作区根只读默认」）：
//   ① 根授权（rootToken）：绑 windowId + pluginName + 工作区根；
//      窗只能说「根的相对路径」，宿主负责拼接/围栏。
//   ② 文档令牌（docToken）：绑 windowId + pluginName + 真实路径（可带 rootToken）；
//      `ws.read` 打开一份文件时签发；`doc.read` / `doc.save` 继续用。
//
// 纪律：
//   · 跨窗/跨插件串用一律不中（三件齐全才解析）；
//   · 开窗签发、关窗整窗回收（根 + 全部文档令牌 + 最近令牌指针）；
//   · 同一窗同一路径复用同一文档令牌（多标签不重复签发）；
//   · 非渲染状态（没有订阅者）：纯模块 Map + 显式复位，故意不进 zustand。

/** 一笔工作区根授权：窗 + 插件 + 真实根（根路径只有宿主看得见）。 */
export interface WorkspaceGrant {
  rootToken: string;
  pluginName: string;
  windowId: string;
  rootPath: string;
  issuedAt: number;
}

/** 文档授权的两种来路：显式开窗带文档（会推 `doc-open`）/ 工作区里读出来的（不推）。 */
export type DocumentGrantOrigin = 'open' | 'workspace';

/** 一笔文档授权：窗 + 插件 + 真实路径 + 可选根令牌。 */
export interface DocumentGrant {
  docToken: string;
  pluginName: string;
  windowId: string;
  path: string;
  rootToken: string | null;
  origin: DocumentGrantOrigin;
  issuedAt: number;
}

const workspaceGrants = new Map<string, WorkspaceGrant>();
const documentGrants = new Map<string, DocumentGrant>();
/** 每窗最近一次签发的文档令牌（帧在 bridge-ready 后据此推 doc-open）。 */
const lastDocTokenByWindow = new Map<string, string>();
let seq = 0;

function nextToken(prefix: 'ws' | 'doc'): string {
  seq += 1;
  return `${prefix}#${seq}`;
}

/** 开窗签发根授权：一窗一根（换根即撤掉该窗全部文档令牌，旧根下的路径不能继续用）。 */
export function issueWorkspaceGrant(windowId: string, pluginName: string, rootPath: string): WorkspaceGrant {
  revokeDocumentGrantsForWindow(windowId);
  const grant: WorkspaceGrant = {
    rootToken: nextToken('ws'),
    pluginName,
    windowId,
    rootPath,
    issuedAt: Date.now(),
  };
  workspaceGrants.set(grant.rootToken, grant);
  return grant;
}

/** 桥面解析根授权：三件齐全才中。 */
export function resolveWorkspaceGrant(windowId: string, pluginName: string, rootToken: string): WorkspaceGrant | null {
  const grant = workspaceGrants.get(rootToken);
  if (!grant) return null;
  if (grant.windowId !== windowId || grant.pluginName !== pluginName) return null;
  return grant;
}

/** 该窗当前根授权（帧在 bridge-ready 后据此推 workspace-open）；无 → null。 */
export function pendingWorkspaceGrant(windowId: string): WorkspaceGrant | null {
  for (const grant of workspaceGrants.values()) {
    if (grant.windowId === windowId) return grant;
  }
  return null;
}

/**
 * 签发文档令牌：同一窗同一路径复用（多标签/重复点开不膨胀令牌表）。
 * 传 rootToken 时校验它确实属于该窗/插件。
 */
export function issueDocumentGrant(
  windowId: string,
  pluginName: string,
  path: string,
  opts: { rootToken?: string | null; origin?: DocumentGrantOrigin } = {},
): DocumentGrant {
  const rootToken = opts.rootToken ?? null;
  const origin = opts.origin ?? 'open';
  if (rootToken != null && resolveWorkspaceGrant(windowId, pluginName, rootToken) == null) {
    throw new Error('根授权无效或已过期');
  }
  for (const grant of documentGrants.values()) {
    if (grant.windowId === windowId && grant.pluginName === pluginName && grant.path === path) {
      if (rootToken != null && grant.rootToken == null) grant.rootToken = rootToken;
      if (origin === 'open') {
        grant.origin = 'open';
        lastDocTokenByWindow.set(windowId, grant.docToken);
      }
      return grant;
    }
  }
  const grant: DocumentGrant = {
    docToken: nextToken('doc'),
    pluginName,
    windowId,
    path,
    rootToken,
    origin,
    issuedAt: Date.now(),
  };
  documentGrants.set(grant.docToken, grant);
  // 只有「显式开窗带文档」才更新 doc-open 指针；工作区里读出来的文件不抢这个位。
  if (origin === 'open') lastDocTokenByWindow.set(windowId, grant.docToken);
  return grant;
}

/** 桥面解析文档令牌：三件齐全才中；跨窗/跨插件串用返回 null（不抛）。 */
export function resolveDocumentGrant(windowId: string, pluginName: string, docToken: string): DocumentGrant | null {
  const grant = documentGrants.get(docToken);
  if (!grant) return null;
  if (grant.windowId !== windowId || grant.pluginName !== pluginName) return null;
  return grant;
}

/** 该窗最近签发的文档令牌（帧在 bridge-ready 后据此推 doc-open）；无 → null。 */
export function pendingDocumentGrant(windowId: string): DocumentGrant | null {
  const token = lastDocTokenByWindow.get(windowId);
  return token ? (documentGrants.get(token) ?? null) : null;
}

/** 关窗 / 换根 / 卸载：整窗回收（根 + 文档 + 最近指针）。 */
export function revokeDocumentGrantsForWindow(windowId: string): void {
  for (const [token, grant] of workspaceGrants) {
    if (grant.windowId === windowId) workspaceGrants.delete(token);
  }
  for (const [token, grant] of documentGrants) {
    if (grant.windowId === windowId) documentGrants.delete(token);
  }
  lastDocTokenByWindow.delete(windowId);
}

/** 测试复位（vitest 同 worker 模块态跨用例共享——防串味）。 */
export function resetDocumentGrantsForTests(): void {
  workspaceGrants.clear();
  documentGrants.clear();
  lastDocTokenByWindow.clear();
  seq = 0;
}
