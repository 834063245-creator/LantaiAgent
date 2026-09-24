// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试腰：把 plan 模式实现按**生产生命周期**登记（批 6a）。
//
// 为什么要它：生产里实现由 `hologram/plan-mode` 插件在**装载期**登记，该 fiber 随
// 根 Context 常驻（main.ts → loadBuiltinPlugins）。而测试常用的
// `withFirstPartyCapabilityChannel(...)` 是**瞬时腰**——run 结束即拆卸、登记随之回退。
// 若 Agent 装配发生在腰外（组合值可带出腰使用，装配在测试体内），工具面就会少
// enter/exit_plan_mode。本腰复现「装载器已跑过」的常驻态：进程内登记一次，不撤销。
//
// 幂等：重复调用无害（登记表栈语义——后登记胜、回退到上一版）。

import { registerPlanImplementation } from '../../src/agent/plan/plan-impl';
import { planModeImplementation } from '../../src/plugins/builtin/plan-mode/implementation';

let installed = false;

/** 常驻登记 plan 模式实现（= 生产装载器已装载 hologram/plan-mode）。 */
export function installPlanModeForTest(): void {
  if (installed) return;
  installed = true;
  registerPlanImplementation(planModeImplementation);
}
