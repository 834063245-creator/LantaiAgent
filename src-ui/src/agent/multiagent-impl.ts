// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 通信域实现登记表（批 7b，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 分类 = `service`（用户 2026-09-24 拍板）：`runtime.ts` 在构造期就要造会话级 bus/store
// （每个 AgentRuntime 一份），缺实现 = 装歪了 ⇒ 构造点 fail-loud（`requireMultiagentComm`）。
// blueprint 的两条 capability 同样查表（工具面在装配期落）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表）。**叶模块纪律**：
// 零项目内运行时依赖（仅 type-only 引契约面）。

import type { MultiagentCommImplementation } from './message-contract';

let impl: MultiagentCommImplementation | null = null;
let seq = 0;

/** 登记实现。栈语义同 plan/goal/state-hooks/compaction/agent-domain。 */
export function registerMultiagentComm(next: MultiagentCommImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读实现；未登记即抛（service 语义）。 */
export function requireMultiagentComm(): MultiagentCommImplementation {
  if (!impl) {
    throw new Error(
      '通信域实现缺失：hologram/multiagent-comm 产物未装载（service 类产物不可禁用）——检查产物通道 / loadBuiltinPlugins。',
    );
  }
  return impl;
}

/** 只读探测（测试/诊断用）。 */
export function activeMultiagentComm(): MultiagentCommImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearMultiagentCommForTest(): void {
  impl = null;
}
