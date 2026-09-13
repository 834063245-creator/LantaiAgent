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

import type { Context } from '../cordis';
import { type PluginWindowDef, type PluginWindowInstance, usePluginWindowStore } from '../state/plugin-window-store';
import { notifyPluginWindowClosed, notifyPluginWindowOpened } from './mcp-bridge';
import type { AppDecl, PluginWindowMode } from './types';

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
  };
  usePluginWindowStore.getState().registerAppDef(def);
  ctx.effect(
    () => () => {
      const closed = usePluginWindowStore.getState().unregisterAppDef(pluginName);
      for (let i = 0; i < closed.length; i++) notifyPluginWindowClosed(pluginName);
    },
    `${pluginName}/app-window`,
  );
}

// ── 设施面（宿主桥 windows 键的真源；启动器/测试直调同面）──

/** 开窗：无定义 → null（插件未声明 app 或已卸载）；已开 → 聚焦返回原窗
 *  （v1 每插件单窗）。真开新窗才通知治理器（with-window 拉起 / lazy 阻塞
 *  空闲回收）——窗口计数与真实开窗恒等，聚焦不虚增。 */
export function openPluginWindow(pluginName: string): string | null {
  const result = usePluginWindowStore.getState().openWindow(pluginName);
  if (!result) return null;
  if (result.opened) notifyPluginWindowOpened(pluginName);
  return result.windowId;
}

/** 关窗：返回是否关掉了（未开 = false）。关窗即通知治理器（with-window
 *  计数归零回收 / lazy 重新起算空闲）。 */
export function closePluginWindow(windowId: string): boolean {
  const pluginName = usePluginWindowStore.getState().closeWindow(windowId);
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

/** 窗口设施面（宿主桥 `windows` 键的整体形状）。 */
export const pluginWindowFacility = {
  open: openPluginWindow,
  close: closePluginWindow,
  focus: focusPluginWindow,
  setMode: setPluginWindowMode,
  list: listPluginWindows,
  isOpen: isPluginWindowOpen,
} as const;

/** 设施面类型（宿主桥 Window 声明消费）。 */
export type PluginWindowFacility = typeof pluginWindowFacility;
