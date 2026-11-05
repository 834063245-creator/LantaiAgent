// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-cold-start）：冷启动落点 + 启动锚。
//
// 历史沿革：自 main.ts 机械迁移（S2-4）→ workspace-flip 批 1/3（纯会话优先 +
// 打开流两段化）→ V5 拆除（2026-08-22，星图渲染分支退役）→
// workspace-session-ownership-rework（2026-08-27，占位工作区退役）→
// 启动落点恒为案卷首页（2026-08-22 用户拍板）。
//
// ⚡ 2026-11-05 入口 UX 批（用户拍板）：**冷启动不再预开工作区**。
//   旧职责 = 读 `.last_project` → switchWorkspace（后台整份物化：Agent 装配 +
//   会话/画布恢复，本机实测 3~5s），落点却是首页——用户在首页点进工作区时撞上
//   状态机 busy，点击被丢弃（只换一行状态字）。现在：
//     · 进入工作区 = 用户动作 → switchWorkspace（纸壳展卷页承接等待）；
//     · 首页读面（上卷）不再依赖「有活动工作区」——Rust 侧给已登记工作区的
//       `.lantai/**` 开了用户通道只读豁免（utils/path_resolve.rs::
//       registered_workspace_read）；
//     · 冷启动唯一职责 = **启动锚**（原来挂在 Workspace.open 上——不预开工作区后，
//       那一刻要到用户进区才发生；诊断面「用户跑的是哪个构建/日志写在哪」不能等）。
//
// 视图落点仍由 bootShell 收尾（恒为案卷首页），本行不决定视图。

import { applyLogLevelFromShell, initLogger, log } from '../../agent/logger';
import * as Obs from '../../agent/obs';
import { providersFilePath } from '../../provider/providers-store';
import { getProxyPort } from '../../provider/transport';
import { typedJsonRpc } from '../../rpc-contract';
import { pushStatus, type ShellRefs, setLoading } from '../runtime';

export async function bootColdStart(_refs: ShellRefs): Promise<void> {
  let lastDir: string | null = null;
  try {
    lastDir = await typedJsonRpc('get_last_project', {});
  } catch {
    /* 无后端通道（浏览器 mock）→ 落点首页 */
  }
  if (!lastDir) {
    // 无恢复信号 → 落点案卷首页（不装配 Agent，用户从首页选/建工作区）
    setLoading(false);
    return;
  }

  // 启动锚（日志可观测性批 1，2026-09-27；2026-11-05 迁到冷启动行）：一条把
  // 「版本/commit/工作区/配置路径/代理端口/日志通道」一次说清。全程 best-effort
  // ——锚是诊断副产物，绝不拦启动。
  try {
    // 级别开关必须先于 initLogger（级别就位之前写的条目会按旧级别判）。
    await applyLogLevelFromShell();
    try {
      await initLogger(lastDir);
    } catch {
      // 日志通道初始化失败不拦启动——boot 会如实记 log_channel:unavailable
    }
    let port = 0;
    try {
      port = await getProxyPort();
    } catch {
      // 端口解析失败 = 回退直连（transport 的既有降级语义），记 0
    }
    Obs.boot({ workspace: lastDir, providersPath: providersFilePath(), proxyPort: String(port) });
  } catch (e) {
    log.warn('boot', '启动锚写入失败（不拦启动）', { error: String(e) });
  }

  // 首页已可交互：不打开任何工作区（进入由用户动作触发）。
  pushStatus('案头已就绪——从首页开卷');
  setLoading(false);
}
