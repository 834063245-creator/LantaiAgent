// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// skill 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。
//
// 批 9h-3（2026-09-26）：**实现整件随包**（`./skills` 扫描器 + `./builtin-skills` 出厂内容，
// 原 `agent/skills.ts` / `agent/builtin-skills.ts`）——apply 期把实现登记进内核登记表
// （`agent/skill-impl.ts`，service 语义：缺实现 fail-loud），内核 `workspace.ts` 不再
// `new SkillRegistry`、`runtime.ts` 不再直接调 `scanSkills`，改走登记表门面。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
// 登记函数**必须经包内宿主桥**取：产物域 esbuild 会把内核模块整件内联成副本，直连内核路径
// = 登记进副本（内核看不到）——与 memory-domain 同款实机缺陷（2026-09-25 现场取证）。
import { clearSkillImplementation, registerSkillImplementation } from './host';
import { createSkillTool, SkillRegistry, scanSkills } from './skills';

/** 技能域实现面（登记项；与包内实现同源——`tests/setup.ts` 复现装载态用同一对象）。 */
export const skillImplementation = {
  createRegistry: (projectPath: string, userDirOverride?: string | null) =>
    new SkillRegistry(projectPath, userDirOverride),
  scanSkills: (projectPath: string, userDirOverride?: string | null) => scanSkills(projectPath, userDirOverride),
  createSkillTool,
};

/** skill 域插件——skillRegistry 缺帐时空集（原 if 分支语义）。 */
export const skillDomainPlugin = {
  name: 'hologram/skill-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    // 实现登记（service 语义）：随 fiber 生命周期对称撤销
    ctx.effect(() => {
      registerSkillImplementation(skillImplementation);
      return () => clearSkillImplementation();
    }, 'skill-domain-implementation');
    registerFamily(
      ctx,
      'skill-domain-tools',
      noCacheContributions(
        'hologram/skill-domain',
        (rowCtx) => (rowCtx.skillRegistry ? [createSkillTool(rowCtx.skillRegistry)] : []),
        ['Skill'],
      ),
    );
  },
};

/** 撤销登记（fiber dispose 用；`clearSkillImplementationForTest` 是测试面同义口）。 */
export default skillDomainPlugin;
