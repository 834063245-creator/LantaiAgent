// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 4（hologram/shell-bridges）：Tauri 事件桥 — unity-event 双击导航 +
// permission-ask 权限卡片。
// 自 main.ts 426-511 机械迁移（原 try/catch 外壳保留——浏览器 mock 无
// Tauri 事件总线，listen 抛错静默）。

import { typedListen, typedRpc } from '../../rpc-contract';
import { getPanelStore } from '../../state/panel-store';
import type { ShellRefs } from '../runtime';

export async function bootBridges(refs: ShellRefs): Promise<void> {
  const chatPanel = refs.chatPanel;
  // Tauri 事件监听 — 纯浏览器 dev(mock) 环境无 __TAURI_INTERNALS__，
  // bridge.listen 返回空操作 unlisten（权限卡在 mock 下不会出现）
  try {
    await typedListen('unity-event', ({ event: evt, payload }) => {
      console.log('[Unity]', evt, payload);
      if (evt === 'node_double_clicked') {
        const parts = payload.split('|');
        if (parts.length > 1 && parts[1]) shellNavigateToFile(parts[1]);
      }
      if (evt === 'path_selected') {
        const parts = payload.split('|');
        if (parts.length === 2) {
          chatPanel?.open();
          chatPanel?.ask(
            `分析从 ${parts[0]} 到 ${parts[1]} 的依赖路径。请分析这条依赖链的架构合理性、风险点、以及如果修改起点的潜在影响范围。`,
          );
        }
      }
    });

    // ── 后端权限请求 → 前端内联聊天卡片桥接 ──
    // 白名单按后端 Tool.name() 匹配（payload.tool）：
    // "Edit" = edit_file/write_file/delete_file/move_file/create_directory/log_append。
    // 注意与 src-tauri permissions::auto_mode_allows 保持同一份名单（两端镜像）。
    const AUTO_WHITELIST = new Set(['Edit']);
    const timedOutRequests = new Set<string>();
    await typedListen('permission-ask', (p) => {
      if (!chatPanel) return;
      // 权限模式旁路：yolo → 全部自动，auto → 仅安全编辑
      const permMode = getPanelStore(chatPanel.panelId).getState().permissionMode;
      if (permMode === 'yolo' || (permMode === 'auto' && AUTO_WHITELIST.has(p.tool))) {
        void typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: true,
          remember: false,
        });
        return;
      }

      // 子 Agent 权限请求使用更短的超时（60 秒 vs 120 秒）
      const isSubAgent = p.agentId && p.agentId !== 'main';
      const timeoutMs = isSubAgent ? 60_000 : 120_000;

      const timeoutId = setTimeout(() => {
        timedOutRequests.add(p.requestId);
        void typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: false,
          remember: false,
        });
      }, timeoutMs);

      // 为子 Agent 可见性标注来源 Agent 的原因
      const displayReason = isSubAgent ? `[子Agent ${p.agentId}] ${p.reason}` : p.reason;

      chatPanel
        .showPermissionCard(p.tool, displayReason, p.path, p.danger)
        .then((result) => {
          clearTimeout(timeoutId);
          if (timedOutRequests.has(p.requestId)) {
            timedOutRequests.delete(p.requestId);
            return;
          }
          void typedRpc('permission_ask_response', {
            request_id: p.requestId,
            allow: result.allow,
            remember: result.remember || undefined,
            rule_to_add: result.remember && p.suggestions.length > 0 ? p.suggestions[0].rule : undefined,
            rule_behavior:
              result.remember && p.suggestions.length > 0 ? p.suggestions[0]?.behavior || 'allow' : undefined,
          });
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          if (timedOutRequests.has(p.requestId)) {
            timedOutRequests.delete(p.requestId);
            return;
          }
          console.error('[permission-ask]', err);
          void typedRpc('permission_ask_response', {
            request_id: p.requestId,
            allow: false,
            remember: false,
          });
        });
    });
  } catch {
    /* 浏览器 mock：无 Tauri 事件总线 */
  }
}

// shell.wire 在 nav 行注册（行 8）——此处经动态 import 解耦模块级循环：
// bridges 行先于 nav 行执行是表序事实，运行时 shell.wire 已就绪。
async function shellNavigateToFile(path: string): Promise<void> {
  const { shell } = await import('../../ui/app-shell');
  shell.navigateToFile(path);
}
