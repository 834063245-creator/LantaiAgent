// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 10（hologram/shell-actions）：registerActions 14 动作。
// 自 main.ts 659-774 机械迁移。动作体引用的 workspace 流函数
// （switchWorkspace/reanalyze/toggleDiff/doSearch/escLayer/runCheck）
// 属行 11（S2-4 搬迁）——本行经 deps 注入消费，编排期由 workspace 流
// 模块提供（行序：10 注册动作发生在 11 模块 import 之后，运行时调用
// 更晚，deps 函数引用稳定）。

import { registerActions } from '../../app/actions';
import { useShellStore } from '../../app/shell-store';
import { useDockStore } from '../../state/dock-store';
import type { ShellRefs } from '../runtime';

/** workspace 流函数注入面（行 11 产出；S2-4 起由 shell/workspace.ts 提供）。 */
export interface WorkspaceFlowDeps {
  switchWorkspace: (path?: string) => Promise<void>;
  reanalyze: () => Promise<void>;
  toggleDiff: () => Promise<void>;
  doSearch: (q: string) => void;
  escLayer: () => void;
  runCheck: () => Promise<void>;
}

export function bootActions(refs: ShellRefs, deps: WorkspaceFlowDeps): void {
  registerActions([
    { id: 'open', group: '操作', label: '打开文件夹…', icon: 'folder-open', run: () => deps.switchWorkspace() },
    { id: 'reanalyze', group: '操作', label: '重新分析当前项目', icon: 'refresh', run: () => deps.reanalyze() },
    {
      id: 'toggle-fold',
      group: '操作',
      label: '折叠 / 展开社区星系',
      icon: 'fold',
      kbd: 'F',
      run: () => {
        if (!refs.starGraph) return;
        refs.starGraph.toggleFold();
        useShellStore.getState().setFolded(refs.starGraph.isFolded);
      },
    },
    {
      id: 'reset-cam',
      group: '操作',
      label: '复位摄像机视角',
      icon: 'reset-cam',
      kbd: 'R',
      run: () => refs.starGraph?.resetCamera(),
    },
    {
      id: 'blast-toggle',
      group: '操作',
      label: '切换 Blast 模式',
      icon: 'blast',
      kbd: 'B',
      run: () => refs.starGraph?.handleBlastToggle(),
    },
    {
      id: 'toggle-diff',
      group: '操作',
      label: '变更回看着色',
      icon: 'diff',
      kbd: 'ctrl D',
      run: () => deps.toggleDiff(),
    },
    { id: 'search', group: '操作', label: '搜索符号', icon: 'search', run: (q) => deps.doSearch(q || '') },
    {
      id: 'panel.check',
      group: '面板',
      label: '面板：简报',
      icon: 'check',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        if (dock.isOpen('agents')) dock.closePanel('agents');
        dock.togglePanel('check');
        if (dock.isOpen('check') && refs.workspace?.path) deps.runCheck();
        useShellStore.getState().setViolations(0); // 打开即视为已知晓
      },
    },
    {
      id: 'panel.constraints',
      group: '面板',
      label: '面板：约束',
      icon: 'constraints',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('agents')) dock.closePanel('agents');
        dock.togglePanel('constraints');
      },
    },
    {
      id: 'panel.dataflow',
      group: '面板',
      label: '面板：数据流',
      icon: 'dataflow',
      run: () => {
        useDockStore.getState().togglePanel('dataflow');
      },
    },
    {
      id: 'panel.agents',
      group: '面板',
      label: '面板：智能体',
      icon: 'agent',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        dock.togglePanel('agents');
      },
    },
    {
      id: 'toggle-chat',
      group: '面板',
      label: '展开 / 折叠对话',
      icon: 'chat',
      kbd: 'ctrl L',
      run: () => {
        const dock = useDockStore.getState();
        if (dock.isOpen('check')) dock.closePanel('check');
        if (dock.isOpen('constraints')) dock.closePanel('constraints');
        if (dock.isOpen('agents')) dock.closePanel('agents');
        refs.chatPanel?.toggle();
      },
    },
    {
      id: 'toggle-settings',
      group: '设置',
      label: '设置…',
      icon: 'settings',
      kbd: 'ctrl ,',
      run: () => useDockStore.getState().togglePanel('settings'),
    },
    {
      id: 'toggle-shortcuts',
      group: '设置',
      label: '快捷键一览',
      icon: 'info',
      kbd: '?',
      run: () => {
        const st = useShellStore.getState();
        st.setShortcutsOpen(!st.shortcutsOpen);
      },
    },
    { id: 'esc-layer', group: '操作', label: '逐层关闭', icon: 'close', run: () => deps.escLayer() },
  ]);
}
