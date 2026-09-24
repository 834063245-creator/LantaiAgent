// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩域实现登记表（批 6d-2，2026-09-24；capability-impl-seam-design.md §3）。
//
// 为什么需要它：`Agent` 的压缩方法 + `agent-builder` 的工具注册都要调用实现，而实现归
// 产物包 `plugins/builtin/compaction/`——两者靠一张**内核侧登记表**对接：内核查表、
// 产物登记实现 ⇒ 宿主→插件零反向依赖，装配序与工具面零改动。
//
// 分类 = `service`（用户 2026-09-24 拍板）：压缩是会话正确性前提（每轮触发判定 + 摘要
// 管线），缺实现 = 装歪了 ⇒ **调用点** fail-loud（`requireCompactionImplementation`），
// 不静默降级（与 plan/goal 两个 feature 产物相对）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表，生命周期 = 进程）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引契约面）。

import type { CompactionImplementation } from './compaction-contract';

let impl: CompactionImplementation | null = null;
let seq = 0;

/** 登记实现。栈语义同 plan/goal/state-hooks（disposer 回退到登记前的值）。 */
export function registerCompactionImplementation(next: CompactionImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读实现；未登记即抛（service 语义——调用点 fail-loud，不静默降级）。 */
export function requireCompactionImplementation(): CompactionImplementation {
  if (!impl) {
    throw new Error(
      '压缩实现缺失：hologram/compaction 产物未装载（service 类产物不可禁用）——检查产物通道 / loadBuiltinPlugins。',
    );
  }
  return impl;
}

/** 只读探测（测试/诊断用；生产调用点用 require 版）。 */
export function activeCompactionImplementation(): CompactionImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearCompactionImplementationForTest(): void {
  impl = null;
}
