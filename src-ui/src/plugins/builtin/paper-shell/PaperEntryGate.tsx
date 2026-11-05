// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperEntryGate — 纸面入口门（2026-11-05 入口 UX 批）。
//
// 展卷态（workspace-entry-store.target 非空）→ EnteringSheet；否则 → PaperPanel。
// 为什么独立成门、而不是在 PaperPanel 里早退：画布那 16 个域 hook 完全不挂载，
// 展卷期间**没有任何旧区纸面 / 空案头 / 可点输入条**出现——落纸才是第一次画布渲染
// （旧 UX 的「切区先闪上一区纸面 0.3~0.5s、再挂一张空案头等 3s」两帧病灶结构性消失）。

import { EnteringSheet } from './EnteringSheet';
import { useWorkspaceEntryStore } from './host';
import { PaperPanel } from './PaperPanel';

export function PaperEntryGate() {
  const entering = useWorkspaceEntryStore((s) => s.target != null);
  return entering ? <EnteringSheet /> : <PaperPanel />;
}
