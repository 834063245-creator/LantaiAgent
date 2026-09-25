// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks · 宿主依赖面 · 开发/测试域。
//
// 本包**不自持内核实现**：机制面（两接口 + 两注册表类，agent/hooks.ts）与数据源
// （agent/state-inject.ts 的诊断/blame/构建缓存 + agent/tool-images.ts 的附图判定）留内核，
// 出厂 hook 四工厂归本包。内核依赖逐符号桥。

export type { Hook, PreflightHook } from '../../../agent/hooks';
export type { StateHooksImplementation } from '../../../agent/state-hooks-contract';
export { registerStateHooksImplementation } from '../../../agent/state-hooks-impl';
export type { DiagnosticsSource } from '../../../agent/state-inject';
export {
  buildPreReadBlock,
  cacheBuildResult,
  formatDiagnostics,
  invalidateBlameEntry,
  refreshGitBlame,
} from '../../../agent/state-inject';
export type { TaskBoardFace as TaskBoard } from '../../../agent/task-contract';
export { hasImageRefs } from '../../../agent/tool-images';
