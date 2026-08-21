// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：应用壳 — 单 React 根。组合全部新 chrome，挂全局快捷键。
// P3：六个 dock 面板收编进 DockPanel；ContextMenu / FileTranslator 经 portal 宿主渲染。

import { useEffect } from 'react';
import { CommandBar } from './CommandBar';
import { CommandPalette } from './CommandPalette';
import { ContextMenuHost } from './ContextMenu';
import { ChatBeacon } from './chat/ChatBeacon';
import { useCoreStore } from './chat/core-instance';
import { DockRail } from './DockRail';
import { DockPanel } from './panels/DockPanel';
import { FileTranslatorPortal } from './panels/FileTranslatorPortal';
import { SessionsHome } from './SessionsHome';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { StatusBar } from './StatusBar';
import { useShellStore } from './shell-store';
import { TimelineHUD } from './TimelineHUD';
import { useGlobalKeys } from './useGlobalKeys';

export function App() {
  useGlobalKeys();
  const core = useCoreStore((s) => s.core);
  const view = useShellStore((s) => s.view);

  useEffect(() => {
    // 会话首页（workspace-flip 批 1）：React 渲染，替换原静态 welcome DOM。
    // 星图 canvas 仍是 imperative-DOM 所有者（scene/graph.ts）——只做显隐。
    const graph = document.getElementById('graph');
    if (graph) graph.classList.toggle('hidden', view === 'home');
  }, [view]);
  return (
    <>
      {view === 'home' && <SessionsHome />}
      <CommandBar />
      <TimelineHUD />
      <DockRail side="right" />
      <StatusBar />
      <CommandPalette />
      <ShortcutsOverlay />
      {core ? <ChatBeacon core={core} /> : null}
      <DockPanel />
      <ContextMenuHost />
      <FileTranslatorPortal />
    </>
  );
}
