// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks 实现登记表（批 6c，2026-09-24；capability-impl-seam-design.md §2 同款接缝）。
//
// 分类 = `service`（用户 2026-09-24 拍板）：hook 管道是内核语义（prompt 注入 / 诊断 /
// 构建结果缓存），缺实现 = 装配歪了 ⇒ 消费点（blueprint 两条 capability）**fail-loud**，
// 不静默降级（与 plan/goal 两个 feature 产物的「静默不装 / 具名失败」相对）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表，生命周期 = 进程）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引契约面）。

import type { StateHooksImplementation } from './state-hooks-contract';

let impl: StateHooksImplementation | null = null;
let seq = 0;

/** 登记实现。栈语义同 plan/goal（disposer 回退到登记前的值；此后有人再登记则不动）。 */
export function registerStateHooksImplementation(next: StateHooksImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读当前实现。未登记 = null——消费点 fail-loud（service 语义）。 */
export function activeStateHooksImplementation(): StateHooksImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearStateHooksImplementationForTest(): void {
  impl = null;
}
