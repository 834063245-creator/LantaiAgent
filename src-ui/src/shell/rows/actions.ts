// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-actions）：registerActions — 命令面板 / 全局快捷键
// 的统一动作注册表。自 main.ts 迁移（S2-4）。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：星图操作族（折叠/复位/Blast/
// 变更回看/符号搜索）与旧面板族（简报/约束/数据流/智能体/对话开关）随
// 观测台退役。S3（2026-08-22）：面板切换动作行化到域插件——toggle-settings
// → plugins/builtin/settings-domain 的 settings/toggle 贡献；toggle-paper →
// plugins/builtin/paper-shell 的 paper/toggle 贡献（快捷键链路经 app/actions.ts
// 别名翻译层桥接，useGlobalKeys 字面量不变）。保留动作 = 纸壳时代仍可达
// 的最小集：打开目录（绑定）/ 逐层关闭（依赖 workspace 流注入）。
// 依赖注入：switchWorkspace / escLayer 属 workspace 流（行表注入）。

import { registerActions } from '../../app/actions';
import type { ShellRefs } from '../runtime';

/** workspace 流函数注入面（workspace 行产出；编排期由 shell/workspace.ts 提供）。 */
export interface WorkspaceFlowDeps {
  switchWorkspace: (path?: string, opts?: { graphEngine?: boolean | null }) => Promise<void>;
  escLayer: () => void;
}

export function bootActions(_refs: ShellRefs, deps: WorkspaceFlowDeps): void {
  registerActions([
    {
      id: 'open',
      group: '操作',
      label: '打开工作区…（指定目录切换）',
      icon: 'folder-open',
      run: () => deps.switchWorkspace(),
    },
    { id: 'esc-layer', group: '操作', label: '逐层关闭', icon: 'close', run: () => deps.escLayer() },
  ]);
}
