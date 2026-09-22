// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 壳行表（S2-3 填充；S2-4 迁入；V5 拆除 2026-08-22 缩至 9 行；2026-08-24
// 增 shell-update-check 行至 10 行；2026-09-22 增 shell-drag-drop 行至 11 行）
// —— 壳装配的组合数据源。
//
// 壳行 = 启动接线单元（S2 设计件 §2.6）：main.ts init() 既有执行序切成
// 行块，每行一行（id 惯例 hologram/shell-<block>）。与 cordis 插件通道
// 的分工：壳行是纯 boot 时序（无服务注册、无 disposer 诉求——根 fiber
// 生命周期 = 应用生命周期，dispose 无意义）；有 ctx 生命周期诉求的单元
// （四 service / S3 起的域插件）走插件通道（plugins/loader.ts）。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：以下行随旧观测台退役——
//   - shell-graph（StarGraph 构造 + AgentVisualizer + Dock 注入）：
//     星图不渲染，图谱数据面在 workspace（后台预热）；
//   - shell-nav（AppShell 导航接线：navigateToNode/highlight/queryAgent）：
//     导航目标（星图/FileViewer）已退役；
//   - shell-dataflow-parser（NL→符号回退解析器）：DataflowPanel 已退役。
//
// 表序 = 引导序（保序 await，逐行执行）；行 id 经 roster patch 的 shell
// 域可寻址禁用（禁用行的接线不发生，调用一致地失败——涟漪表见设计件
// §2.8）。行内代码不得假设前行必然成功（失败隔离，loader 同款纪律）。
//
// boot 第二参 flowDeps 是 workspace 流注入面（actions 行消费）：
// workspace 流真源在 src/shell/rows/workspace.ts。

import { bootActions, type WorkspaceFlowDeps } from '../shell/rows/actions';
import { bootBridges } from '../shell/rows/bridges';
import { bootChat } from '../shell/rows/chat';
import { bootColdStart } from '../shell/rows/cold-start';
import { bootDragDrop } from '../shell/rows/drag-drop';
import { bootKeyguard } from '../shell/rows/keyguard';
import { bootPersistence } from '../shell/rows/persistence';
import { bootPlatform } from '../shell/rows/platform';
import { bootSandboxProbe } from '../shell/rows/sandbox-probe';
import { bootUpdateCheck } from '../shell/rows/update-check';
import { bootWorkspace, workspaceFlow } from '../shell/rows/workspace';
import type { ShellRefs } from '../shell/runtime';

export type { WorkspaceFlowDeps };

/** 壳行：id 寻址 + boot 接线动作（flowDeps 由编排器转发，行内自取所需）。 */
export interface ShellRow {
  id: string;
  boot: (refs: ShellRefs, flowDeps?: WorkspaceFlowDeps) => void | Promise<void>;
}

/** 内置壳行表 — 表序 = 引导序（§2.6 表 = 现 init() 执行序的证据）。 */
export function builtinShellRows(): ShellRow[] {
  return [
    { id: 'hologram/shell-platform', boot: () => bootPlatform() },
    { id: 'hologram/shell-chat', boot: (refs) => bootChat(refs) },
    { id: 'hologram/shell-bridges', boot: (refs) => bootBridges(refs) },
    { id: 'hologram/shell-drag-drop', boot: () => bootDragDrop() },
    { id: 'hologram/shell-keyguard', boot: () => bootKeyguard() },
    { id: 'hologram/shell-sandbox-probe', boot: () => bootSandboxProbe() },
    { id: 'hologram/shell-persistence', boot: (refs) => bootPersistence(refs) },
    {
      id: 'hologram/shell-actions',
      boot: (refs, deps) => {
        if (!deps) {
          // workspace 流缺席（行禁用涟漪，§2.8）：动作体依赖流函数，跳过注册
          console.warn('[shell] workspace 流 deps 缺席，跳过动作注册');
          return;
        }
        bootActions(refs, deps);
      },
    },
    { id: 'hologram/shell-workspace', boot: (refs) => bootWorkspace(refs) },
    { id: 'hologram/shell-cold-start', boot: (refs) => bootColdStart(refs) },
    { id: 'hologram/shell-update-check', boot: () => bootUpdateCheck() },
  ];
}

/** 出厂 workspace 流（main.ts 终态引导传给 bootShell 的 deps 真源）。 */
export { workspaceFlow };
