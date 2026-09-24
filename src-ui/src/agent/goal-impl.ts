// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 模式实现登记表（批 6b，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 为什么需要它：`Agent.runGoal/resumeGoal`（宿主类方法）必须调用循环实现，而实现要进
// 产物包 `plugins/builtin/goal-mode/`——两者只能靠一张**内核侧登记表**对接：内核查表、
// 产物登记实现 ⇒ 宿主→插件零反向依赖，且不改动任何装配序（goal 不经 capability/tool 通道）。
//
// 分类 = `feature`（用户 2026-09-24 拍板）：未登记（插件被禁用/未装载）时宿主方法返回
// 具名失败结果（`/goal` 命令可见原因，不静默）；产物装载失败由装载器的插件记录 fail-loud。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表，生命周期 = 进程）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引契约面）。

import type { GoalModeImplementation } from './goal-contract';

let impl: GoalModeImplementation | null = null;
let seq = 0;

/** 登记实现。栈语义同 plan（disposer 回退到登记前的值；此后有人再登记则不动）。 */
export function registerGoalImplementation(next: GoalModeImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读当前实现。未登记 = null——消费点用具名失败降解（feature 语义）。 */
export function activeGoalImplementation(): GoalModeImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearGoalImplementationForTest(): void {
  impl = null;
}
