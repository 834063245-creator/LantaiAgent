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
  // L2（session-ledger）：谁跑完存谁——doneSid = 后台卷 → 该卷全量快照
  // （saveSessionById，F3 窗口期闭合）；doneSid = 活跃卷/缺席 → 现行链
  // （NDJSON 增量 + 防抖全量）不变。占位工作区（path=''，单槽统一后进槽）
  // 同样参与：saveActiveSession('') 路由用户级目录（appendLastMessage 对
  // path='' 自行跳过——Rust session_append 不支持空路径）。
  useTurnDoneStore.subscribe((s, prev) => {
    if (s.turnDoneTick === prev.turnDoneTick) return;
    const ws = refs.workspace;
    const chatPanel = refs.chatPanel;
    if (!ws || !chatPanel) return;
    const doneSid = s.lastDoneSid;
    if (doneSid != null) {
      const activeSid = chatPanel.activeSessionId;
      if (doneSid !== activeSid) {
        // 后台卷跑完：立即全量落盘自己的卷（不等切回）
        chatPanel.saveSessionById(doneSid).catch(() => {});
        return;
      }
    }
    // 增量持久化 — 将最后一条消息追加到后端 NDJSON
    chatPanel.appendLastMessage(ws.path);
    chatPanel.scheduleAutoSave(ws.path);
  });

  // Agent 配置变更统一入口：设置面板/模型切换/模式按钮只发信号
  // （P1b：agent-config-store 订阅，替代 bus 'agent:config-changed' 事件），
  // workspace.applyAgentConfig 热切换处理（不重建，会话/上下文全保留）。
  // 单槽统一（2026-08-24）：refs.workspace 是唯一工作区注册表（占位工作区
  // path='' 也是槽内普通条目）——路由坍缩为单分支，占位影子实例的三分支
  // 猜测退役。
  useAgentConfigStore.subscribe((state, prev) => {
    if (state.seq === prev.seq || !state.reason) return;
    const reason = state.reason;
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    const ws = refs.workspace;
    const chatPanel = refs.chatPanel;
    if (ws && chatPanel) {
      void ws
        .applyAgentConfig(chatPanel, reason)
        .catch((err) => console.error('[agent-config] hot-switch failed:', err));
    } else {
      // chat 行被禁用的涟漪（设计件 §2.8 降级面）+ 错误不静默
      console.warn('[agent-config] workspace/chatPanel 缺席，丢弃信号:', reason);
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
  // L2（session-ledger）：不再只存活跃卷——全部有内容卷都落盘
  // （F3 收尾：后台卷即使从未被切回也不丢）。
  // 单槽统一：占位工作区（path=''）同样收尾——saveAllSessions 对空路径
  // 卷照常落盘（sessionsDir('') = 用户级目录）。
  window.addEventListener('beforeunload', () => {
    const ws = refs.workspace;
    if (ws) {
      try {
        refs.chatPanel?.scheduleAutoSave(ws.path);
        refs.chatPanel?.saveAllSessions().catch(() => {});
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
