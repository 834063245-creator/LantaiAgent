// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 窗口标题动态化（R5 D6，2026-08-29 拍板 C）：
//   {工作区名} · {活跃案卷} — 兰台
// 工作区名取 projectPath 末段（注册表登记名另需异步查表，basename 即用户
// 认识的目录名）；无工作区 = 「兰台」；有工作区无活跃案卷 = 「{工作区名} — 兰台」。
// 活跃案卷名跟随 sess store（切卷/改名即刷新）。

import { useEffect } from 'react';
import { volumeDisplayName } from '../state/volume-name';
import { getChatStore } from '../ui/chat-store';
import { useCoreStore } from './chat/core-instance';
import { useShellStore } from './shell-store';

function pathBasename(p: string | null | undefined): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm.split('/').filter(Boolean).pop() ?? '';
}

export function useDocumentTitle(): void {
  const core = useCoreStore((s) => s.core);
  const projectPath = useShellStore((s) => s.projectPath);

  useEffect(() => {
    const ws = pathBasename(projectPath);
    const apply = (): void => {
      let title = '兰台';
      if (ws) {
        title = `${ws} — 兰台`;
        if (core) {
          const st = getChatStore(core.panelId).sess.getState();
          const cur = st.sessions[st.activeIdx];
          if (cur) title = `${ws} · ${volumeDisplayName(cur.label, cur.id)} — 兰台`;
        }
      }
      document.title = title;
    };
    apply();
    if (!core) return;
    // 切卷/改名跟随：sess store 任何变化重算标题
    return getChatStore(core.panelId).sess.subscribe(apply);
  }, [core, projectPath]);
}
