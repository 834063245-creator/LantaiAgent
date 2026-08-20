// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 9（hologram/shell-persistence）：轮次完成持久化 + agent-config
// 热切换订阅 + beforeunload 收尾。
// 自 main.ts 649-657 + 776-816 机械迁移（两段相邻语义：会话生命周期接线）。

import { loadSettings } from '../../settings';
import { useAgentConfigStore } from '../../state/agent-config-store';
import { useTurnDoneStore } from '../../state/turn-done-store';
import type { ShellRefs } from '../runtime';

export function bootPersistence(refs: ShellRefs): void {
  // ── 轮次完成通知（P1 总线归零：chat:turn-done → state/turn-done-store 信号）──
  useTurnDoneStore.subscribe((s, prev) => {
    if (s.turnDoneTick === prev.turnDoneTick) return;
    const ws = refs.workspace;
    if (ws?.path) {
      // 增量持久化 — 将最后一条消息追加到后端 NDJSON
      refs.chatPanel?.appendLastMessage(ws.path);
      refs.chatPanel?.scheduleAutoSave(ws.path);
    }
  });

  // Agent 配置变更统一入口：设置面板/模型切换/模式按钮只发信号
  // （P1b：agent-config-store 订阅，替代 bus 'agent:config-changed' 事件），
  // workspace.applyAgentConfig 热切换处理（不重建，会话/上下文全保留）。
  useAgentConfigStore.subscribe((state, prev) => {
    if (state.seq === prev.seq || !state.reason) return;
    const reason = state.reason;
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    refs.starGraph?.resize();
    const ws = refs.workspace;
    const chatPanel = refs.chatPanel;
    if (ws && chatPanel) {
      void ws
        .applyAgentConfig(chatPanel, reason)
        .catch((err) => console.error('[agent-config] hot-switch failed:', err));
    } else if (ws) {
      // chat 行被禁用的涟漪：无面板可热切换（设计件 §2.8 降级面）
      console.warn('[agent-config] chatPanel 缺席，跳过热切换:', reason);
    }
  });
  refs.chatPanel?.setOnOpenSettings(() => {
    // 动态 import 解耦：dock-store 经 actions 行已入依赖图，此处在
    // 用户点击时才取，避免行间模块级循环。
    void import('../../state/dock-store').then(({ useDockStore }) => useDockStore.getState().openPanel('settings'));
  });

  // 关闭时保存会话 — scheduleAutoSave 是同步的（设置超时）。
  // saveActiveSession 内的 LocalStorage 写入是同步的，因此即使 RPC 磁盘写入未完成，
  // 也能在窗口关闭前完成。
  // 同时同步停止子 Agent（AbortController.abort 是同步的）。
  // E6：刷新会话级 boards（DiscoveryBoard + TaskBoard）— 清除
  // debounce 定时器（同步）并触发刷新（尽力异步）。
  window.addEventListener('beforeunload', () => {
    const ws = refs.workspace;
    if (ws?.path) {
      try {
        refs.chatPanel?.scheduleAutoSave(ws.path);
      } catch {
        /* 静默 */
      }
      try {
        ws.subAgentPool.stopAll();
      } catch {
        /* 静默 */
      }
      try {
        void ws.runtime?.flushAllBoards();
      } catch {
        /* 静默 */
      }
    }
  });
}
