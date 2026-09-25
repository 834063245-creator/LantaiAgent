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

let _impl: SkillImplementation | null = null;

/** 产物登记实现（`skill-domain` 包 apply 期调用；测试域由 `tests/setup.ts` 复现）。 */
export function registerSkillImplementation(impl: SkillImplementation): void {
  _impl = impl;
}

/** 当前实现（未登记 = null——诊断/测试面读用）。 */
export function activeSkillImplementation(): SkillImplementation | null {
  return _impl;
}

/** 撤销登记（产物 fiber dispose 与测试复位共用同一口——对称释放，不留悬空实现）。 */
export function clearSkillImplementation(): void {
  _impl = null;
}

/** 测试复位（语义同 `clearSkillImplementation`；历史命名保留以对齐其余登记表）。 */
export function clearSkillImplementationForTest(): void {
  clearSkillImplementation();
}

/** 缺实现时的具名错误（fail-loud：不静默当成「无技能」）。 */
const SKILL_DOMAIN_UNAVAILABLE =
  'SKILL_DOMAIN_UNAVAILABLE: 技能域实现缺席——请确认内置产物 hologram/skill-domain 已装载' +
  '（它由 loader 从产物通道装载）。';

function requireImpl(): SkillImplementation {
  if (!_impl) throw new Error(SKILL_DOMAIN_UNAVAILABLE);
  return _impl;
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
