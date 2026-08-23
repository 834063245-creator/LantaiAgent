// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-bridges）：Tauri 事件桥 — permission-ask 权限卡片。
// 自 main.ts 426-511 机械迁移（S2）；只保留权限请求桥——它服务
// Agent 会话编排（与视图无关）。
//
// 权限卡承接面：chat-core.showPermissionCard → PromptShelf（V5 起经
// App 根的 PromptShelfHost 独立挂载，不再依赖旧聊天面板）。

import { typedListen, typedRpc } from '../../rpc-contract';
import { useModeStore } from '../../state/mode-store';
import type { ShellRefs } from '../runtime';

export async function bootBridges(refs: ShellRefs): Promise<void> {
  const chatPanel = refs.chatPanel;
  // Tauri 事件监听 — 纯浏览器 dev(mock) 环境无 __TAURI_INTERNALS__，
  // bridge.listen 返回空操作 unlisten（权限卡在 mock 下不会出现）
  try {
    // ── 后端权限请求 → 前端提示卡桥接 ──
    // 白名单按后端 Tool.name() 匹配（payload.tool）：
    // "Edit" = edit_file/write_file/delete_file/move_file/create_directory/log_append。
    // 注意与 src-tauri permissions::auto_mode_allows 保持同一份名单（两端镜像）。
    const AUTO_WHITELIST = new Set(['Edit']);
    const timedOutRequests = new Set<string>();
    await typedListen('permission-ask', (p) => {
      if (!chatPanel) return;
      // 权限模式旁路：yolo → 全部自动，auto → 仅安全编辑。
      // 单一真相 = mode-store（C11 重设计，2026-08-22）：app 级单例，
      // 切换时已同步镜像 Rust + 落盘；不再读 per-panel 的旧字段。
      const permMode = useModeStore.getState().permissionMode;
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
