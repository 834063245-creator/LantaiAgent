// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时实现登记表（批 7c-1，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 分类 = `feature`（产物 subagent-in-process 是 feature）：未登记 ⇒ blueprint 的
// merge-tool / discovery-tools 两条 capability 静默不装（与包内既有「缺帐即空集」语义同向）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表）。**叶模块纪律**：
// 零项目内运行时依赖（仅 type-only 引契约面）。

import type { SubagentRuntimeImplementation } from './subagent-runtime-contract';

let impl: SubagentRuntimeImplementation | null = null;
let seq = 0;

/** 登记运行时实现（池 / 生命周期 / 派生 + merge / discovery 两工具族）。
 *  栈语义同其余登记表。 */
export function registerSubagentRuntime(next: SubagentRuntimeImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读运行时实现；未登记即抛（池与生命周期是会话基础设施，service 语义）。 */
export function requireSubagentRuntime(): SubagentRuntimeImplementation {
  if (!impl) {
    throw new Error(
      '子代理运行时实现缺失：hologram/subagent-in-process 产物未装载（service 类产物不可禁用）——检查产物通道 / loadBuiltinPlugins。',
    );
  }
  return impl;
}

/** 读 merge 族实现。未登记 = null——消费点按 feature 语义静默跳过。 */
export function activeMergeTools(): SubagentRuntimeImplementation['mergeTools'] | null {
  return impl?.mergeTools ?? null;
}

/** 读 discovery 族实现。未登记 = null。 */
export function activeDiscoveryTools(): SubagentRuntimeImplementation['discoveryTools'] | null {
  return impl?.discoveryTools ?? null;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearSubagentRuntimeForTest(): void {
  impl = null;
}
