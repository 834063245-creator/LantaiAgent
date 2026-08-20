// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行表（S2-3 填充行 1-10；S2-4 迁入 11-12）—— 壳装配的组合数据源。
//
// 壳行 = 启动接线单元（S2 设计件 §2.6）：main.ts init() 既有执行序切成
// 12 块，每块一行（id 惯例 hologram/shell-<block>）。与 cordis 插件通道
// 的分工：壳行是纯 boot 时序（无服务注册、无 disposer 诉求——根 fiber
// 生命周期 = 应用生命周期，dispose 无意义）；有 ctx 生命周期诉求的单元
// （四 service / S3 起的域插件）走插件通道（plugins/loader.ts）。
// DSH 同构物：browser 行是「cordis 存在前经 module table 组合」的启动期
// 单元，同样不是运行时插件。
//
// 表序 = 引导序（保序 await，逐行执行）；行 id 经 roster patch 的 shell
// 域可寻址禁用（禁用行的接线不发生，调用一致地失败——涟漪表见设计件
// §2.8）。行内代码不得假设前行必然成功（失败隔离，loader 同款纪律）。
//
// boot 第二参 flowDeps 是 workspace 流注入面（行 10 actions 消费）：
// 行 11 真源在 src/shell/rows/workspace.ts（S2-4 起完整），S2-3 过渡期
// 由 main.ts 传入（零漂移：函数体尚未搬迁，引用同一实现）。

import { bootActions } from '../shell/rows/actions';
import { bootBridges } from '../shell/rows/bridges';
import { bootChat } from '../shell/rows/chat';
import { bootDataflowParser } from '../shell/rows/dataflow-parser';
import { bootGraph } from '../shell/rows/graph';
import { bootKeyguard } from '../shell/rows/keyguard';
import { bootNav } from '../shell/rows/nav';
import { bootPersistence } from '../shell/rows/persistence';
import { bootPlatform } from '../shell/rows/platform';
import { bootSandboxProbe } from '../shell/rows/sandbox-probe';
import type { ShellRefs } from '../shell/runtime';

/** 壳行：id 寻址 + boot 接线动作（flowDeps 由编排器转发，行内自取所需）。 */
export interface ShellRow {
  id: string;
  boot: (refs: ShellRefs, flowDeps?: WorkspaceFlowDeps) => void | Promise<void>;
}

/** workspace 流函数注入面（行 11 产出，行 10 消费；编排器透传）。 */
export interface WorkspaceFlowDeps {
  switchWorkspace: (path?: string) => Promise<void>;
  reanalyze: () => Promise<void>;
  toggleDiff: () => Promise<void>;
  doSearch: (q: string) => void;
  escLayer: () => void;
  runCheck: () => Promise<void>;
}

/** 内置壳行表 — 表序 = 引导序（§2.6 表 = 现 init() 执行序的证据）。 */
export function builtinShellRows(): ShellRow[] {
  return [
    { id: 'hologram/shell-platform', boot: () => bootPlatform() },
    { id: 'hologram/shell-graph', boot: (refs) => bootGraph(refs) },
    { id: 'hologram/shell-chat', boot: (refs) => bootChat(refs) },
    { id: 'hologram/shell-bridges', boot: (refs) => bootBridges(refs) },
    { id: 'hologram/shell-keyguard', boot: () => bootKeyguard() },
    { id: 'hologram/shell-sandbox-probe', boot: () => bootSandboxProbe() },
    { id: 'hologram/shell-dataflow-parser', boot: (refs) => bootDataflowParser(refs) },
    { id: 'hologram/shell-nav', boot: (refs) => bootNav(refs) },
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
  ];
}
