// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时实现登记表（批 7c-1，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 分类 = `feature`（产物 subagent-in-process 是 feature）：未登记 ⇒ blueprint 的
// merge-tool / discovery-tools 两条 capability 静默不装（与包内既有「缺帐即空集」语义同向）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表）。**叶模块纪律**：
// 零项目内运行时依赖（仅 type-only 引契约面）。

import type { DiscoveryToolsImplementation, MergeToolsImplementation } from './subagent-runtime-contract';

let merge: MergeToolsImplementation | null = null;
let discovery: DiscoveryToolsImplementation | null = null;
let seq = 0;

/** 登记 merge / discovery 两族实现。栈语义同其余登记表。 */
export function registerSubagentRuntime(next: {
  mergeTools: MergeToolsImplementation;
  discoveryTools: DiscoveryToolsImplementation;
}): () => void {
  const prev = { merge, discovery };
  const token = ++seq;
  merge = next.mergeTools;
  discovery = next.discoveryTools;
  return () => {
    if (token !== seq) return;
    seq++;
    merge = prev.merge;
    discovery = prev.discovery;
  };
}

/** 读 merge 族实现。未登记 = null——消费点按 feature 语义静默跳过。 */
export function activeMergeTools(): MergeToolsImplementation | null {
  return merge;
}

/** 读 discovery 族实现。未登记 = null。 */
export function activeDiscoveryTools(): DiscoveryToolsImplementation | null {
  return discovery;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearSubagentRuntimeForTest(): void {
  merge = null;
  discovery = null;
}
