// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plan 模式实现登记表（批 6a，2026-09-24；capability-impl-seam-design.md §2）。
//
// 为什么需要它：plan 的两条 capability 住在内核 `agent/blueprint.ts` 的**字节序表**里
// （贡献序 = 注册序 = capability 表序），条目位置不可动；而实现（两个工具工厂 +
// 提醒注入器）要进产物包 `plugins/builtin/plan-mode/`。两者只能靠一张**内核侧登记表**
// 对接：内核查表、产物登记实现 ⇒ 表序零漂移 + 宿主→插件零反向依赖。
//
// 分类 = `feature`（用户 2026-09-24 拍板）：未登记时 blueprint 的对应 capability
// **静默不装**（工具面少 enter/exit_plan_mode，与用户禁用该插件同义）；产物装载失败
// 由装载器的插件记录 fail-loud，不靠这里兜底。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表，生命周期 = 进程）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引契约面）——本文件被 blueprint
// 与产物包宿主面同时引用，长出静态边即成环。

import type { PlanModeImplementation } from './plan-contract';

let impl: PlanModeImplementation | null = null;
let seq = 0;

/** 登记实现。返回 disposer（调用方挂 ctx.effect——插件拆卸即撤销登记）。
 *  栈语义：后登记胜；disposer **回退到登记前的值**，且此后若又有人登记过则不动
 *  （`token !== seq`）——测试里「常驻登记 + 通道腰内瞬时 apply/dispose」共存时，
 *  腰的拆卸不得把常驻那版一并抹掉（生产只有装载器一个登记者，此语义与它一致）。 */
export function registerPlanImplementation(next: PlanModeImplementation): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读当前实现。未登记（插件被禁用 / 未装载）= null——消费点按 feature 语义跳过。 */
export function activePlanImplementation(): PlanModeImplementation | null {
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearPlanImplementationForTest(): void {
  impl = null;
}
