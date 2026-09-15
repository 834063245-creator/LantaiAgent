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
import { applySeamDisabled } from '../composition/seam-resolution';

export type CompositionStatus = 'factory' | 'ok' | 'error';

interface CompositionState {
  status: CompositionStatus;
  /** patch 来源标记（ok/error 态记录，供 UI 呈现「组合来自哪里」）。 */
  patchOrigin?: string;
  /** error 态的拒绝原因（all-or-nothing 的可见面）。 */
  error?: string;
  /** 解析产物 — 装配面穿线的唯一消费入口。 */
  resolved: ResolvedComposition;
  /** 产物的**输入身份**（S6 P1d：composition/preset-assembly 的 compositionIdentity /
   *  userLayerIdentity）——装配面据此判定「共享注册表是否就按这份组合建的」，
   *  取代原先的对象引用比较（引用在 factory 态恒不等 ⇒ 每卷白建一份会话注册表）。
   *  写入口 = 知道自己是叠了哪几层的调用方（patch-loader / preset-assembly）；
   *  **缺省 = 未知**：装配面按「不同」处理（会话自建注册表 = 旧行为，安全方向）。 */
  resolvedKey?: string;
  /** 应用解析产物（loader / preset 装配路径；resolvedKey 见上）。 */
  setResolved(resolved: ResolvedComposition, patchOrigin?: string, resolvedKey?: string): void;
  /** 整体拒绝 → 回退出厂组合 + 错误可见（loader 失败路径）。 */
  setError(error: string, patchOrigin?: string, resolvedKey?: string): void;
  /** 回退出厂态（S4-2 热重载：patch 被删除——显式撤下旧组合）。 */
  resetToFactory(resolvedKey?: string): void;
  /** 只补记产物输入身份（不动产物/状态）。boot 的**保持态**分支用：用户层 404 /
   *  生效 preset 为空 patch 时 store 不被写（零漂移语义），但那时的产物是按
   *  「用户层（可能为空）」解析出来的——身份必须补记，否则装配面永远读到「未知」
   *  ⇒ 每卷仍白建注册表（P1d 要消掉的那笔开销）。 */
  noteResolvedKey(resolvedKey: string): void;
}

export const useCompositionStore = create<CompositionState>((set) => ({
  status: 'factory',
  resolved: factoryComposition(),
  // 组合写入口 = seam 裁剪面的唯一灌入点（平台化 Phase 3）：三个 setter
  // 都先经 applySeamDisabled 把 resolved.seamDisabled 灌进运行时读面
  // （seam-resolution.ts 叶模块——消费单点 active*/emitLoopEvent 的过滤源）。
  setResolved: (resolved, patchOrigin, resolvedKey) => {
    applySeamDisabled(resolved.seamDisabled);
    set({ status: 'ok', resolved, patchOrigin, resolvedKey, error: undefined });
  },
  setError: (error, patchOrigin, resolvedKey) => {
    applySeamDisabled(factoryComposition().seamDisabled); // 回退出厂 = 裁剪面清空
    set({ status: 'error', resolved: factoryComposition(), patchOrigin, resolvedKey, error });
  },
  resetToFactory: (resolvedKey) => {
    applySeamDisabled(factoryComposition().seamDisabled);
    set({ status: 'factory', resolved: factoryComposition(), patchOrigin: undefined, resolvedKey, error: undefined });
  },
  noteResolvedKey: (resolvedKey) => set({ resolvedKey }),
}));
