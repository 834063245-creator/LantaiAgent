// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 窗口设施 API（app shell 四件套 · 件 A，S3）——宿主能力面（开/关/聚焦/
// 查询窗口），不是工具面：工具语义归插件（插件在 tools seam 贡献「开窗」
// 语义工具如 notes_open，执行体调本设施——宿主内核不实现任何窗口工具，
// §4-6 拍板）。设施经宿主桥 `window.__lantai_plugin_host__.windows` 暴露给
// 插件 entry 代码（全信任区，与 fs/mods 同级——不做调用方绑定）。
//
// 受治进程联动（S2 × S3）：开窗/关窗在真实开合处调 notifyPluginWindowOpened/
// Closed——with-window 档随窗开合拉起/回收（S2 合成事件面的真实接线），
// lazy 档窗开阻塞空闲回收。窗口管理 UI 面（启动器/任务栏）形态待用户设计
// 定稿后另批施工（走 canvas-nav 同款第一方产物通道），不阻塞本设施。

import { useShellStore } from '../app/shell-store';
import type { Context } from '../cordis';
import { resolveFileReference } from '../paper/file-ref';
import { cancelDocumentReviewsForWindow } from '../state/plugin-document-review';
import { issueDocumentGrant, revokeDocumentGrantsForWindow } from '../state/plugin-document-store';
import { type PluginWindowDef, type PluginWindowInstance, usePluginWindowStore } from '../state/plugin-window-store';
import { loadWindowGeometry } from '../state/window-geometry';
import { clampWindowSize, PLUGIN_WINDOW_DEFAULT_H, PLUGIN_WINDOW_DEFAULT_W } from '../state/window-metrics';
import { notifyPluginWindowClosed, notifyPluginWindowOpened } from './mcp-bridge';
import type { AppDecl, PluginWindowMode } from './types';
import { postBridgeEventToWindow } from './window-bridge';

/** manifest.app entry → 窗内容入口 URL：`./app/index.html` 归一为
 *  `<origin>/<插件名>/app/index.html`（`./` 前缀已由 schema 钉死）。 */
export function appEntryUrl(origin: string, pluginName: string, entry: string): string {
  const rel = entry.replace(/^\.\//, '');
  return `${origin}/${pluginName}/${rel}`;
}

/** 装载挂接（loader 包装 apply 调用）：manifest.app 声明 → 窗口定义登记；
 *  卸载收口挂 ctx.effect（fiber dispose 链式）：摘定义 + 关掉该插件全部
 *  开窗 + 逐窗通知治理器关窗事件（受治进程 with-window 档随关窗回收）。
 *
 *  入口二态（契约 v28）：schema 已保证 entry / url 恰有其一——asset 形态走
 *  资产 origin 前缀解析，remote 形态 url 原样透传（环回白名单已在 schema 把过）。 */
export function mountPluginApp(ctx: Context, pluginName: string, app: AppDecl, origin: string): void {
  const remote = app.url !== undefined;
  const def: PluginWindowDef = {
    pluginName,
    kind: remote ? 'remote' : 'asset',
    entryUrl: remote ? (app.url as string) : appEntryUrl(origin, pluginName, app.entry ?? ''),
    mode: app.mode ?? 'floating',
    title: app.title ?? pluginName,
    documents: app.documents === true,
    // v75：manifest 声明首选尺寸——只在用户没拖过时生效（落盘几何优先，见
    // openPluginWindow 的 seed 组装）。
    ...(app.size ? { size: app.size } : {}),
  };
  usePluginWindowStore.getState().registerAppDef(def);
  ctx.effect(
    () => () => {
      const closed = usePluginWindowStore.getState().unregisterAppDef(pluginName);
      for (let i = 0; i < closed.length; i++) {
        // 卸载收口：窗没了，令牌跟着死（不留给下一任同 id 窗口）
        revokeDocumentGrantsForWindow(closed[i].windowId);
        cancelDocumentReviewsForWindow(closed[i].windowId);
        notifyPluginWindowClosed(pluginName);
      }
    },
    `${pluginName}/app-window`,
  );
}

// ── 设施面（宿主桥 windows 键的真源；启动器/测试直调同面）──

/** 开窗：无定义 → null（插件未声明 app 或已卸载）；已开 → 聚焦返回原窗
 *  （v1 每插件单窗）。真开新窗才通知治理器（with-window 拉起 / lazy 阻塞
 *  空闲回收）——窗口计数与真实开窗恒等，聚焦不虚增。 */
export function openPluginWindow(pluginName: string, opts?: { document?: { path: string } }): string | null {
  const state = usePluginWindowStore.getState();
  const def = state.defs[pluginName];
  // 文档载荷只在插件声明 app.documents 时受理（能力不是权限：未声明 = 载荷被
  // 忽略、窗照常开——但要让作者看得见，不静默）。
  const requested = opts?.document;
  if (requested && def?.documents !== true) {
    console.warn(`[plugin-window] ${pluginName} 未声明 app.documents——文档载荷被忽略`);
  }
  // 相对路径按工作区根解析（2026-11-23 相对路径批）——设施是**所有开窗入口**的共同收口：
  // 仓库相对路径在会话里是最自然的写法，走到这里若还是相对串，Rust canonicalize 必失败。
  const doc =
    def?.documents === true && requested
      ? { path: resolveFileReference(requested.path, useShellStore.getState().projectPath) ?? requested.path }
      : undefined;
  /* 起手几何（优先级从高到低）：用户拖过的落盘几何 > manifest.app.size > 缺省
     460×360。两个来源都夹进当前视口——上次关机时的分辨率/显示器未必还是现在这台。
     store 只收夹好的种子（它保持纯状态层：不读 window、不读 localStorage）。 */
  const viewport = typeof window === 'undefined' ? undefined : { w: window.innerWidth, h: window.innerHeight };
  const restored = loadWindowGeometry(pluginName, viewport);
  const seed = restored ?? {
    ...clampWindowSize(def?.size?.w ?? PLUGIN_WINDOW_DEFAULT_W, def?.size?.h ?? PLUGIN_WINDOW_DEFAULT_H, viewport),
  };
  const result = state.openWindow(pluginName, seed);
  if (!result) return null;
  if (result.opened) notifyPluginWindowOpened(pluginName);
  if (doc) {
    const grant = issueDocumentGrant(result.windowId, pluginName, doc.path);
    // 窗已开着（聚焦路径）：iframe 不重载，帧那条 bridge-ready 不会再发一次 ⇒
    // 由设施直接把 doc-open 推到同一窗（新开的窗由帧在 bridge-ready 后自己取）。
    if (!result.opened) {
      postBridgeEventToWindow(result.windowId, 'doc-open', { docToken: grant.docToken, path: grant.path });
    }
  }
  return result.windowId;
}

/** 关窗：返回是否关掉了（未开 = false）。关窗即通知治理器（with-window
 *  计数归零回收 / lazy 重新起算空闲）。 */
export function closePluginWindow(windowId: string): boolean {
  const pluginName = usePluginWindowStore.getState().closeWindow(windowId);
  revokeDocumentGrantsForWindow(windowId);
  cancelDocumentReviewsForWindow(windowId);
  if (pluginName == null) return false;
  notifyPluginWindowClosed(pluginName);
  return true;
}

/** 聚焦窗（海拔置顶）。 */
export function focusPluginWindow(windowId: string): void {
  usePluginWindowStore.getState().focusWindow(windowId);
}

/** 三模式切换（floating/dock/fullscreen）。 */
export function setPluginWindowMode(windowId: string, mode: PluginWindowMode): void {
  usePluginWindowStore.getState().setWindowMode(windowId, mode);
}

/** 查询：开着窗口实例清单（启动器/任务栏与测试面）。 */
export function listPluginWindows(): PluginWindowInstance[] {
  return usePluginWindowStore.getState().windows;
}

/** 查询：插件是否有开着的窗。 */
export function isPluginWindowOpen(pluginName: string): boolean {
  return usePluginWindowStore.getState().windows.some((w) => w.pluginName === pluginName);
}

/** 用「文档能力」插件打开一份文件——**会话里点文件引用的宿主出口**（2026-11-23 用户定调：
 *  入口不该是 Agent 命令，而是"引用到的文件点一下"）。
 *
 *  谁来开：注册面里第一个声明 `app.documents` 的插件（v1 单选；多编辑器并存是后续产品决定）。
 *  没有这样的插件 ⇒ 状态栏具名提示并返回 false——**不静默什么都不发生**。
 *  窗已开着也照样能换页（设施层会直接把新令牌推到同一窗）。
 */
export function openFileWithPlugin(path: string): boolean {
  const defs = usePluginWindowStore.getState().defs;
  const name = Object.keys(defs)
    .sort()
    .find((n) => defs[n].documents === true);
  if (!name) {
    useShellStore.getState().pushStatus('没有能打开文档的软件插件（插件需声明 app.documents）');
    return false;
  }
  return openPluginWindow(name, { document: { path } }) != null;
}

/** 窗口设施面（宿主桥 `windows` 键的整体形状）。 */
export const pluginWindowFacility = {
  open: openPluginWindow,
  close: closePluginWindow,
  focus: focusPluginWindow,
  setMode: setPluginWindowMode,
  list: listPluginWindows,
  isOpen: isPluginWindowOpen,
  openWith: openFileWithPlugin,
} as const;

/** 设施面类型（宿主桥 Window 声明消费）。 */
export type PluginWindowFacility = typeof pluginWindowFacility;
