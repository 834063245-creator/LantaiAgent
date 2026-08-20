// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合解析产物 store（S2-1）— roster 组合的运行时唯一真源。
//
// 数据流（S2 设计件 §2.5）：patch-loader（S2-2）启动期 fetch 用户层
// patch → resolveRoster → 写入本 store；workspace.setupAgent / 壳引导
// 消费 resolved（装配面穿线的唯一数据源——确定性按构造保证：测试与
// 生产同一条路，不读用户盘）。
//
// 状态语义：
//   - factory：初始态 / 通道无文件 / 解析失败回退（resolved = 出厂组合）；
//   - ok：用户层 patch 已应用（resolved = 解析产物，diagnostics 可呈现）；
//   - error：patch 存在但被整体拒绝（all-or-nothing）——回退 factory，
//     error 原因可见（对齐 INVARIANTS #11.2：毒化数据拒绝 + 兜底 + 不静默）。
//
// 生效时机：组合解析只在启动期发生一次，改 patch 重启生效（S2 契约，
// 热重载延期至 S4 preset 体系）。

import { create } from 'zustand';
import { factoryComposition, type ResolvedComposition } from '../composition/roster';

export type CompositionStatus = 'factory' | 'ok' | 'error';

interface CompositionState {
  status: CompositionStatus;
  /** patch 来源标记（ok/error 态记录，供 UI 呈现「组合来自哪里」）。 */
  patchOrigin?: string;
  /** error 态的拒绝原因（all-or-nothing 的可见面）。 */
  error?: string;
  /** 解析产物 — 装配面穿线的唯一消费入口。 */
  resolved: ResolvedComposition;
  /** 应用解析产物（loader 成功路径）。 */
  setResolved(resolved: ResolvedComposition, patchOrigin?: string): void;
  /** 整体拒绝 → 回退出厂组合 + 错误可见（loader 失败路径）。 */
  setError(error: string, patchOrigin?: string): void;
  /** 回退出厂态（S4-2 热重载：patch 被删除——显式撤下旧组合）。 */
  resetToFactory(): void;
}

export const useCompositionStore = create<CompositionState>((set) => ({
  status: 'factory',
  resolved: factoryComposition(),
  setResolved: (resolved, patchOrigin) => set({ status: 'ok', resolved, patchOrigin, error: undefined }),
  setError: (error, patchOrigin) => set({ status: 'error', resolved: factoryComposition(), patchOrigin, error }),
  resetToFactory: () =>
    set({ status: 'factory', resolved: factoryComposition(), patchOrigin: undefined, error: undefined }),
}));
