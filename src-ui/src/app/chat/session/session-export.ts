// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 对话导出
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState } from '../../../agent/agent-session-state';
import { kernelWriteFile } from '../../../rpc-contract';
import { getActiveProvider, loadSettings } from '../../../settings';
import { showToast } from '../../../state/toast-store';
import { getChatStore } from '../../../ui/chat-store';
import { isInternalMessage, type SessionContext } from './session-types';

// ── 对话导出 ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
  if (!agent) {
    showToast('没有可导出的案卷', 'info');
    return;
  }

  const msgs = agent.getSession();
  const settings = loadSettings();
  const active = getActiveProvider(settings);
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# 兰台 · 案卷 — ${dateStr}\n`;
  md += `> 模型: ${active?.model || 'unknown'} · 总 token: ${ctx.getTotalTokensUsed().toLocaleString()}\n\n`;

  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          md += `> *[上下文压缩]*\n\n`;
        }
        continue;
      }
      md += `## 用户\n${m.content || ''}\n\n`;
    }
    if (m.role === 'assistant') {
      md += `## Agent\n${m.content || ''}\n`;
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          md += `\n### 工具调用: ${tc.name}\n`;
          md += `> 参数: \`${tc.arguments || ''}\`\n`;
        }
      }
      md += '\n';
    }
  }

  // 尝试 Tauri 保存对话框，回退到浏览器下载
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: `hologram-session-${now.toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (filePath) {
      // 豁免（session-persistence-seam-wiring-plan 表 1.1 #9）：用户自选路径的
      // .md 导出，非会话存储语义——直连 kernelWriteFile，不进 sessionExecute。
      await kernelWriteFile(filePath, md);
    }
  } catch {
    // 浏览器回退
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hologram-session-${now.toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
