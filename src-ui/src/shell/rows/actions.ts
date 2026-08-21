// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-actions）：registerActions — 命令面板 / 全局快捷键
// 的统一动作注册表。自 main.ts 迁移（S2-4）。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：星图操作族（折叠/复位/Blast/
// 变更回看/符号搜索）与旧面板族（简报/约束/数据流/智能体/对话开关）随
// 观测台退役。保留动作 = 纸壳时代仍可达的最小集：打开目录（绑定）/
// 设置 / 纸视图（回案卷首页）/ 逐层关闭。
// 依赖注入：switchWorkspace / escLayer 属 workspace 流（行表注入）。

import { registerActions } from '../../app/actions';
import { useDockStore } from '../../state/dock-store';
import type { ShellRefs } from '../runtime';

/** workspace 流函数注入面（workspace 行产出；编排期由 shell/workspace.ts 提供）。 */
export interface WorkspaceFlowDeps {
  switchWorkspace: (path?: string) => Promise<void>;
  escLayer: () => void;
}

export function bootActions(_refs: ShellRefs, deps: WorkspaceFlowDeps): void {
  registerActions([
    {
      id: 'open',
      group: '操作',
      label: '绑定目录…（切换工作区）',
      icon: 'folder-open',
      run: () => deps.switchWorkspace(),
    },
    {
      id: 'toggle-paper',
      group: '面板',
      label: '纸视图（开/回案卷首页）',
      icon: 'file',
      kbd: 'ctrl P',
      run: () => useDockStore.getState().togglePanel('paper'),
    },
    {
      id: 'toggle-settings',
      group: '设置',
      label: '设置…',
      icon: 'settings',
      kbd: 'ctrl ,',
      run: () => useDockStore.getState().togglePanel('settings'),
    },
    { id: 'esc-layer', group: '操作', label: '逐层关闭', icon: 'close', run: () => deps.escLayer() },
  ]);
}
