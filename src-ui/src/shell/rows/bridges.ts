// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-bridges）：Tauri 事件桥 — permission-ask 权限卡片。
// 自 main.ts 426-511 机械迁移（S2）；只保留权限请求桥——它服务
// Agent 会话编排（与视图无关）。
//
// 权限卡承接面：chat-core.showPermissionCard → PromptShelf（V5 起经
// App 根的 PromptShelfHost 独立挂载，不再依赖旧聊天面板）。
//
// 并发会话（2026-08-26）：权限卡按 agentId 归属卷路由——Rust 送来的
// agentId（主 Agent = main-<ts>-<rand>，子 Agent = sub-*）经注册表解析到
// 所属卷，卡挂该卷的 execState（停止语义按卷隔离：停 A 卷不杀 B 卷的卡）。
// 旧「p.agentId !== 'main'」判子 Agent 已失效（工厂改唯一 id 后所有主
// Agent 都被误判为子 Agent——60s 短超时 + 错误前缀）。子 Agent 判定改为
// 「请求方 id ≠ 归属卷的主 Agent id」。

import { agentSessionState } from '../../agent/agent-session-state';
import type { RuntimePort } from '../../agent/runtime/types';
import { typedListen, typedRpc } from '../../rpc-contract';
import { useModeStore } from '../../state/mode-store';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
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

      // ── 归属解析（并发会话）：agentId → 所属卷 ──
      // 主 Agent id 直接查注册表；子 Agent（sub-*）经 runtime parentId
      // 链上溯到主 Agent 再查。解析失败（未登记/无身份）→ null，卡按
      // 活跃卷兜底（单卷/恢复期等场景不降级）。
      const agentId = p.agentId || null;
      const owner = agentId ? resolveOwnerSession(agentId) : null;
      // 子 Agent 判定：请求方 id ≠ 归属卷主 Agent id（无归属信息时保守视为主
      // Agent——保 120s 长超时，宁可多等不错杀）。
      const isSubAgent = !!agentId && !!owner && agentId !== owner.mainAgentId;

      // 子 Agent 权限请求使用更短的超时（60 秒 vs 120 秒）
      const timeoutMs = isSubAgent ? 60_000 : 120_000;

      const timeoutId = setTimeout(() => {
        timedOutRequests.add(p.requestId);
        void typedRpc('permission_ask_response', {
          request_id: p.requestId,
          allow: false,
          remember: false,
        });
      }, timeoutMs);

      // 为子 Agent 可见性标注来源 Agent 的原因；并发卷加卷徽标（替哪卷作答）
      const badge = owner ? `${chatPanel.sessionLabelOf(owner.sessionId)}` : null;
      const parts: string[] = [];
      if (badge) parts.push(`[${badge}]`);
      if (isSubAgent) parts.push(`[子Agent ${agentId}]`);
      parts.push(p.reason);
      const displayReason = parts.join(' ');

      chatPanel
        .showPermissionCard(p.tool, displayReason, p.path, p.danger, owner?.sessionId ?? null)
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

/** agentId → 归属卷解析。主 Agent 直接查表；子 Agent 经 runtime parentId
 *  上溯（最深 8 层防环）。返回归属卷 + 该卷主 Agent 的 runtime id。 */
function resolveOwnerSession(agentId: string): { sessionId: number; mainAgentId: string } | null {
  const direct = agentSessionState.sessionOfAgent(agentId);
  if (direct) return { sessionId: direct.sessionId, mainAgentId: agentId };

  // 子 Agent：沿 runtime parentId 链上溯到主 Agent
  //（runtimeRef 是 RuntimePort 的窄化投影——getAgent/AgentHandle 是其真面）
  const runtime = useAgentPanelStore.getState().runtimeRef as
    | (RuntimePort & { getAgent(id: string): { parentId: string | null } | null })
    | null;
  if (!runtime?.getAgent) return null;
  let cursor: string | null = agentId;
  for (let depth = 0; depth < 8 && cursor; depth++) {
    const handle: { parentId: string | null } | null = runtime.getAgent(cursor);
    const parentId: string | null = handle?.parentId ?? null;
    if (!parentId) return null; // 到顶了都不是主会话 Agent（游离子体）——无归属
    const owner = agentSessionState.sessionOfAgent(parentId);
    if (owner) return { sessionId: owner.sessionId, mainAgentId: parentId };
    cursor = parentId;
  }
  return null;
}
