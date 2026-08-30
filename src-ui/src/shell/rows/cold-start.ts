// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-cold-start）：冷启动决策。
// 自 main.ts 机械迁移（S2-4）；workspace-flip 批 1/3（纯会话优先 + 打开流
// 两段化）；V5 拆除（2026-08-22）——星图渲染分支退役（旧「有缓存图→
// 星图视图」不再成立）。
// workspace-session-ownership-rework（2026-08-27）：setupPlaceholderAgent
// 退役——零目录/占位工作区移除，无恢复信号 = 直接落案卷首页（不装配 Agent，
// 用户从首页选/建工作区）。
// per-workspace 引擎旗标（2026-08-31）：恢复信号统一 = .last_project（与图谱
// 引擎无关，workspace_activate 每次绑定都写）；旧「全局引擎开关二分信号路径」
// （引擎开 = 缓存图 source_root / 引擎关 = .last_project）随旗标 per-workspace
// 化退役——该区开不开引擎由 Workspace.open 内部按注册表现值解析。
//
// 现职责只剩一件：
//   有恢复信号（.last_project）→ switchWorkspace 恢复工作区数据面
//   （Agent 工具的图谱预热 + 会话 + 画布摊开集）；
//   无恢复信号 → 落点首页。
// 视图不再由此行决定——启动落点恒为案卷首页（bootShell 不再开纸面板，
// 2026-08-22 用户拍板；纸面板由用户的新建/续开动作唤起）。

import { isMockMode } from '../../bridge';
import { typedJsonRpc } from '../../rpc-contract';
import { pushStatus, type ShellRefs, setLoading } from '../runtime';
import { workspaceFlow } from './workspace';

export async function bootColdStart(_refs: ShellRefs): Promise<void> {
  try {
    let lastDir: string | null = null;
    try {
      lastDir = await typedJsonRpc<string | null>('get_last_project', {});
    } catch {
      /* 无后端通道（浏览器 mock）→ 落点首页 */
    }
    if (!lastDir) {
      // 无恢复信号 → 落点案卷首页（不装配 Agent，用户从首页选/建工作区）
      setLoading(false);
      return;
    }
    // 使用统一的 switchWorkspace 恢复上次工作区（数据面：图谱预热 + 会话 +
    // 画布摊开集；该区引擎旗标由 Workspace.open 按注册表现值解析）。
    // 引擎预热通过 runCheck → engine_init（SQLite 缓存）完成。不要在此处触发
    // analyze_project — 它会与 runCheck 的分析回退竞争并阻塞工作区切换。
    console.log('[init] cold start: restoring last workspace', lastDir);
    await workspaceFlow.switchWorkspace(lastDir);
    console.log('[init] cold start: switchWorkspace done');
    pushStatus(isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已恢复上次案卷');
    return;
  } catch {
    /* 恢复异常 → 落点首页 */
  }

  // 无恢复信号 / 恢复异常 — 落点案卷首页（不装配 Agent）
  setLoading(false);
}
