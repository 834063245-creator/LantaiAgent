// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent/skill-contract — 技能域**契约面**（批 9h-3，2026-09-26）。
//
// 病灶：技能域实现（扫描器 377 行 + 出厂技能内容 358 行）此前住内核，而内核有四处构造/调用点
// （`workspace.ts` `new SkillRegistry` · `runtime.ts` 装配期 `scanSkills` 读技能目录 ·
//  `agent-builder.ts` / `tool-rows.ts` 的行材料类型）——「实现被内核 new 出来」正是批 6/7 立接缝
// 的那类病灶。本文件留**形状**，实现随 `plugins/builtin/skill-domain/` 包，登记表见
// `agent/skill-impl.ts`（service 语义：缺实现 fail-loud）。
//
// 对外可感知：`Skill` 工具（工具行由 `composition/tool-rows.ts` 按域声明，行序不变）与
// SkillsPage 的扫描面（`scanSkills`）语义逐字不变。

import type { DirEntry } from '../rpc-contract';
import type { Tool } from './tool';

/** 一条技能（SKILL.md front-matter + 正文）——逐字上收自产物实现（批 9h-3）。 */
export interface SkillDef {
  name: string;
  description: string;
  prompt: string;
  /** 附加元数据（原样保留，发现注入展示用）。 */
  whenToUse?: string;
  /** 技能目录绝对路径（${LANTAI_SKILL_DIR} 展开锚；出厂技能无盘上目录）。 */
  dir?: string;
  /** 来源根：'project' | 'user' | 'builtin'。 */
  source: 'project' | 'user' | 'builtin';
  /** 装载诊断（坏档时填充；正常为空）。 */
  error?: string;
}

/** 一次扫描的完整产出（目录 + 诊断）——逐字上收自产物实现。 */
export interface SkillScan {
  skills: SkillDef[];
  /** 跳过/损坏的技能条目（带 error reason）——坏档不静默。 */
  skipped: Array<{ name: string; reason: string; dir: string }>;
  /** 目录内容的稳定摘要（发现注入 digest——不变则注入方不重发）。 */
  digest: string;
}

/** 技能注册表**结构面**（内核只当类型用：行材料 + 工具工厂入参）。
 *  实现类随包（`plugins/builtin/skill-domain/skills.ts` 的 `SkillRegistry`）。 */
export interface SkillRegistryFace {
  /** 全量重扫磁盘（项目 + 用户两层）。 */
  reload(): Promise<SkillDef[]>;
  /** 只重扫（不返回列表——预热/变更检测）。 */
  refresh(): Promise<void>;
  /** 当前技能名（最近一次 reload 的结果）。 */
  readonly names: string[];
  /** 最近一次扫描 digest。 */
  readonly digest: string;
  /** 最近一次扫描产出（含 skipped 诊断）。 */
  readonly lastScan: SkillScan;
}

/** 技能域实现面（产物登记项）。 */
export interface SkillImplementation {
  /** 建注册表（工作区级——`workspace.ts` 装配期调用）。 */
  createRegistry(projectPath: string, userDirOverride?: string | null): SkillRegistryFace;
  /** 扫描技能目录（项目 + 用户两层；装配期技能目录段与 SkillsPage 列表源）。 */
  scanSkills(projectPath: string, userDirOverride?: string | null): Promise<SkillScan>;
  /** 建 `Skill` 工具（注册表每次调用热装载）。 */
  createSkillTool(registry: SkillRegistryFace): Tool;
}

/** 扫描器读目录的宿主面（实现随包后仍由内核 RPC 供面——纯读，无状态）。 */
export type { DirEntry };
