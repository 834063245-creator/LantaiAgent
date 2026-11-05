// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// sessions-home 产物 · 宿主依赖面 · 开发/测试/编译域（批 9e，2026-09-26）。
//
// 案卷首页是**应用入口页**（列工作区 / 新建 / 改名 / 移除 / 进画布），随包后仍要用内核的：
//   - `rpc-contract`：`workspace_list` 走强制层 RPC（typedRpc）+ 清单写代缓存（唯一数据源）；
//   - `shell/rows/workspace`：`pickFolder`（系统目录选择器）与 `workspaceFlow`（切区/强制重置
//     ——工作区生命周期的唯一入口，宿主在壳行）；
//   - 状态：`useShellStore`（项目路径/首页态）· `useDockStore`（开设置面板）
//     · `useUpdateStore`（更新角标）；
//   - 上卷数据（丁案）：`useCoreStore` 的 `listSavedSessions`（**上次在案**工作区的
//     卷清单——冷启动恢复的当前区、或 `.last_project` 记住的已关工作区；读盘只依赖
//     会话根，不要求工作区在活动态）+ `useSessionVolumesStore`（卷清单写代，落盘后
//     freshness）+ `activeSpace`（点「继续」/点其他卷时摊开定位）。
//   - `get_last_project`（JsonValue）：回首页 = 真关工作区，`shell.projectPath` 被清空；
//     上卷的「上次在案」必须走 `.last_project` 记住的那条路径（冷启动同源），
//     `typedJsonRpc` 解析 JSON 出口。
//   - 窗口壳件：`WinControls`（最小化/最大化/关闭）+ `window-drag`（顶栏拖拽/双击最大化）。
// 这些全是**内核单例**（RPC 通道 / 壳行函数族 / zustand store / 原生窗口面）——内联 = 第二份状态或
// 第二套窗口按钮 ⇒ 一律经宿主桥取真实例。

export { useCoreStore } from '../../../app/chat/core-instance';
export { useShellStore } from '../../../app/shell-store';
export { WinControls } from '../../../app/WinControls';
export { onTopbarDoubleClick, onTopbarPointerDown } from '../../../app/window-drag';
export { activeSpace } from '../../../composition/space-service';
export {
  clearWorkspaceListCache,
  typedJsonRpc,
  typedRpc,
  type WorkspaceSummary,
  workspaceListCached,
} from '../../../rpc-contract';
export { pickFolder, workspaceFlow } from '../../../shell/rows/workspace';
export { useDockStore } from '../../../state/dock-store';
export { useSessionVolumesStore } from '../../../state/session-volumes-store';
export { useUpdateStore } from '../../../state/update-store';
