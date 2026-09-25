// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 应用壳 — 单 React 根（V5 拆除后，2026-08-22）。
//
// 纸壳（PaperPanel，组合层贡献）是唯一主界面；本树常驻：
//   - 外壳视图槽（`ctx.rootViews`，批 9e）：'home' 主区 = 案卷首页（产物 `sessions-home` 贡献），
//     'overlay' 根浮层 = 无工作区也要在场的浮层（产物贡献）；槽内无贡献 = 该层零渲染
//   - DockPanel：面板容器（paper / settings 均为组合层贡献——S3 后常量面为空）
//   - CommandPalette：命令面板（Ctrl+K；组合层命令贡献的合流消费面）
//   - PromptShelfHost：ask_user / 权限卡独立浮层（**批 9e-3 迁往 rootViews 'overlay' 槽**）
//   - ExitConfirmDialog：退出确认（关窗时若有会话在跑——2026-09-19）
//   - PluginWindowsHost：插件应用窗视口层（app shell 件 A——无开窗零渲染）
//
// 旧观测台 chrome（CommandBar/DockRail/StatusBar/TimelineHUD/
// ShortcutsOverlay/ChatBeacon）已随 V5 退役。

import { useEffect, useState } from 'react';
import { activeRootViews, type RootViewSlot, subscribeRootViews } from '../composition/root-views-service';
import { CommandPalette } from './CommandPalette';
import { useCoreStore } from './chat/core-instance';
import { PromptShelfHost } from './chat/PromptShelfHost';
import { ExitConfirmDialog } from './ExitConfirmDialog';
import { DockPanel } from './panels/DockPanel';
import { PluginWindowsHost } from './plugin-windows/PluginWindowsHost';
import { useDocumentTitle } from './use-document-title';
import { useGlobalKeys } from './useGlobalKeys';

/** 外壳视图槽取用面（批 9e）：贡献热注册即时重取（对齐 PaperPanel 订阅 overlays 的同款纪律）。 */
function useRootViewRows(slot: RootViewSlot) {
  const [, setTick] = useState(0);
  useEffect(() => subscribeRootViews(() => setTick((t) => t + 1)), []);
  return activeRootViews(slot);
}

export function App() {
  useGlobalKeys();
  useDocumentTitle();
  const core = useCoreStore((s) => s.core);
  const homeViews = useRootViewRows('home');
  const overlayViews = useRootViewRows('overlay');
  return (
    <>
      {homeViews.map((v) => (
        <v.component key={v.id} />
      ))}
      <DockPanel />
      <CommandPalette />
      {core ? <PromptShelfHost core={core} /> : null}
      {overlayViews.map((v) => (
        <v.component key={v.id} />
      ))}
      <PluginWindowsHost />
      <ExitConfirmDialog />
    </>
  );
}
