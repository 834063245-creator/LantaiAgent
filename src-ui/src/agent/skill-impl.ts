// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent/skill-impl — 技能域实现登记表（批 9h-3，2026-09-26）。
//
// 形状照抄批 6/7 的接缝（`agent/plan/plan-impl.ts` / `agent/multiagent-impl.ts` /
// `agent/subagent-runtime-impl.ts`）：契约面住 `agent/skill-contract.ts`，实现由产物
// `plugins/builtin/skill-domain/` 在 apply 期经 `registerSkillImplementation` 登记进本表；
// 内核调用点改走下方**门面**（`createSkillRegistry` / `scanSkills`），缺实现 = 具名 fail-loud
// （service 语义——不静默降级成「无技能」）。
//
// 为什么走登记表而不是 faceDeps 桥工厂：工厂是内核**调用**产物的方向（workspace/runtime 装配期
// 调用），faceDeps 是产物**取用**内核的方向；两者不可互替（批 6d-2 已立判据）。

import type { SkillDef, SkillImplementation, SkillRegistryFace, SkillScan } from './skill-contract';

// 登记表是**栈**（后注册胜 + 对称弹出，对齐 `composition/contribution-channel.ts` 的行语义）：
// 批 9h-5 实测——测试域的装配腰（`withFirstParty*Channel`）会加载并 dispose 贡献者 fiber，
// 单值登记会被那次 dispose 抹掉，导致同一测试里「腰跑完之后」的 Agent 装配撞 fail-loud；
// 栈式登记下，常驻登记（tests/setup.ts）不会被后来者的弹出波及。
const _impls: SkillImplementation[] = [];

/** 产物登记实现（`skill-domain` 包 apply 期调用；测试域由 `tests/setup.ts` 复现）。 */
export function registerSkillImplementation(impl: SkillImplementation): void {
  _impls.push(impl);
}

/** 当前实现 = 栈顶（未登记 = null——诊断/测试面读用）。 */
export function activeSkillImplementation(): SkillImplementation | null {
  return _impls.at(-1) ?? null;
}

/** 对称撤销（产物 fiber dispose）：弹出**本 fiber 注册的那一层**，不波及更早的登记。 */
export function clearSkillImplementation(): void {
  _impls.pop();
}

/** 测试复位（清空整栈；生产不调用）。 */
export function clearSkillImplementationForTest(): void {
  _impls.length = 0;
}

/** 缺实现时的具名错误（fail-loud：不静默当成「无技能」）。 */
const SKILL_DOMAIN_UNAVAILABLE =
  'SKILL_DOMAIN_UNAVAILABLE: 技能域实现缺席——请确认内置产物 hologram/skill-domain 已装载' +
  '（它由 loader 从产物通道装载）。';

function requireImpl(): SkillImplementation {
  const impl = activeSkillImplementation();
  if (!impl) throw new Error(SKILL_DOMAIN_UNAVAILABLE);
  return impl;
}

/** 门面：建工作区级技能注册表（`workspace.ts` 装配期调用）。 */
export function createSkillRegistry(projectPath: string, userDirOverride?: string | null): SkillRegistryFace {
  return requireImpl().createRegistry(projectPath, userDirOverride);
}

/** 门面：扫描技能目录（装配期技能目录段 + SkillsPage 列表源）。 */
export function scanSkills(projectPath: string, userDirOverride?: string | null): Promise<SkillScan> {
  return requireImpl().scanSkills(projectPath, userDirOverride);
}

/** 类型再出口（内核消费点从本文件取形状，单一入口）。 */
export type { SkillDef, SkillImplementation, SkillRegistryFace, SkillScan };
