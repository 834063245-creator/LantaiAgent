// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 宿主登记表（2026-10-23，DSH goal 栈移植 P2）。
//
// 为什么需要它：goal 工具在产物包里，执行时只拿得到 executor 注入的
// `_owner_id`（bus id）；目标状态住在 Agent 的会话日志里——两者只能靠一张
// **内核侧登记表**对接（与 `goal-impl`/`plan-impl` 同款接缝，但方向相反：
// 这里是宿主登记、消费方查表）。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（键控自清理注册表，生命周期 =
// Agent 存活期）。登记点在 Agent 构造期（ctx.effect），dispose 即注销；
// 未登记 = 工具具名失败（「目标宿主未就绪」），不静默兜底。
//
// 叶模块纪律：零项目内运行时依赖（仅 type-only 引 GoalHost/Disposer）。

import type { Disposer } from '../lifecycle';
import type { GoalHost } from './service';
import { forgetGoalActivation } from './service';

const hosts = new Map<string, GoalHost>();

/** Agent 装配期登记。同一 owner 重登记 = 覆盖（旧 owner 已被回收）。 */
export function registerGoalHost(host: GoalHost): Disposer {
  hosts.set(host.id, host);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (hosts.get(host.id) === host) hosts.delete(host.id);
    forgetGoalActivation(host.id);
  };
}

/** 按 owner id（executor 注入的 `_owner_id`）取宿主。未登记 = undefined。 */
export function goalHostOf(ownerId: string | undefined | null): GoalHost | undefined {
  if (!ownerId) return undefined;
  return hosts.get(ownerId);
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearGoalHostsForTest(): void {
  hosts.clear();
}
