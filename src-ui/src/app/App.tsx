// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 应用壳 — 单 React 根（V5 拆除后，2026-08-22）。
//
// 纸壳（PaperPanel，组合层贡献）是唯一主界面；本树常驻：
//   - SessionsHome：案卷首页（纸面板关闭后的去向——换卷/续开/绑定目录）
//   - DockPanel：面板容器（paper / settings 均为组合层贡献——S3 后常量面为空）
//   - CommandPalette：命令面板（Ctrl+K；组合层命令贡献的合流消费面）
//   - PromptShelfHost：ask_user / 权限卡独立浮层（会话编排域刚需）
//
// 旧观测台 chrome（CommandBar/DockRail/StatusBar/TimelineHUD/
// ShortcutsOverlay/ChatBeacon）已随 V5 退役。

import { CommandPalette } from './CommandPalette';
import { useCoreStore } from './chat/core-instance';
import { PromptShelfHost } from './chat/PromptShelfHost';
import { DockPanel } from './panels/DockPanel';
import { SessionsHome } from './SessionsHome';
import { useDocumentTitle } from './use-document-title';
import { useGlobalKeys } from './useGlobalKeys';

export function App() {
  useGlobalKeys();
  useDocumentTitle();
  const core = useCoreStore((s) => s.core);
  return (
    <>
      <SessionsHome />
      <DockPanel />
      <CommandPalette />
      {core ? <PromptShelfHost core={core} /> : null}
    </>
  );
}
