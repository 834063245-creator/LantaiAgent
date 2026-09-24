// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent 工具族实现登记表（批 7a，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 分类 = `feature`（产物名册条目 kind 派生）：产物未装载/被禁用 ⇒ blueprint 的两条
// capability 静默不装（与包内 `subAgentSpawner 缺帐 ⇒ 空集` 的既有语义同向）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表）。**叶模块纪律**：
// 零项目内运行时依赖（仅 type-only 引契约面）。

import type { SubAgentToolsImplementation } from './subagent-tools-contract';

let impl: SubAgentToolsImplementation | null = null;
let seq = 0;

/** 登记实现。栈语义同 plan/goal/state-hooks/compaction。 */
export function registerSubAgentTools(next: SubAgentToolsImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读实现。未登记 = null——消费点按 feature 语义静默跳过。 */
export function activeSubAgentTools(): SubAgentToolsImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearSubAgentToolsForTest(): void {
  impl = null;
}
