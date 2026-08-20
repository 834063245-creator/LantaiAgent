// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 8（hologram/shell-nav）：AppShell 导航接线（显式分发替代 bus 命令）。
// 自 main.ts 632-647 机械迁移。FV 惰性句柄经 shell/runtime 统一出口。

import { useDockStore } from '../../state/dock-store';
import { shell } from '../../ui/app-shell';
import { FV, loadFileViewer, type ShellRefs } from '../runtime';

export function bootNav(refs: ShellRefs): void {
  // ── AppShell 接线 — 用显式分发替代 bus 命令 ──
  const starGraph = () => refs.starGraph;
  shell.wire({
    navigateToNode: (name) => starGraph()?.focusNode(name),
    navigateToFile: async (path, line) => {
      await loadFileViewer();
      FV()?.get().open(path, { line });
    },
    highlightFile: (path) => starGraph()?.highlightFile(path),
    highlightFolder: (path) => starGraph()?.highlightFolder(path),
    clearHighlight: () => starGraph()?.clearFileHighlight(),
    queryAgent: (question) => {
      const dock = useDockStore.getState();
      if (dock.isOpen('constraints')) dock.closePanel('constraints');
      refs.chatPanel?.ask(question);
    },
  });
}
