// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 技能候选目录 — 斜杠面板里 `/<技能名>` 一类条目的真源。
//
// 技能扫描是异步的（读 `{ws}/.lantai/skills` + `~/.lantai/skills`），而命令
// 清单是同步读取面（面板每次渲染取一次）——本模块用「工作区路径键控缓存」
// 桥接：同步读缓存，发现工作区变了就 fire-and-forget 重扫；扫描完成不主动
// 通知 UI（下次渲染自然读到新清单）。
//
// 模块级可变态归属 CONVENTIONS §1.10 第 3 类（键控自清理：单一键 = 工作区
// 路径；在途扫描结果按扫描发起时的键判定，键换代即丢弃）。
//
// 2026-09-19 command-surface-rework：本模块自 chat-core 的 `_slashSkillCache`
// 迁出——技能候选从此是命令目录的一段来源，不再由 ChatCore 私有。

import type { CommandContribution } from '../../composition/services';

interface SkillCatalogEntry {
  name: string;
  description?: string;
}

let _skills: SkillCatalogEntry[] = [];
let _scannedPath: string | null = null;

/** 同步确保当前工作区的技能清单：键（工作区路径）变了就后台重扫。
 *  无工作区 = 清空候选。重复调用同键是空操作（含在途扫描）。 */
export function ensureSkillCatalog(path: string | null): void {
  if (!path) {
    _skills = [];
    _scannedPath = null;
    return;
  }
  if (_scannedPath === path) return;
  _scannedPath = path;
  void scanFor(path);
}

async function scanFor(path: string): Promise<void> {
  try {
    const { scanSkills } = await import('../../agent/skills');
    const scan = await scanSkills(path);
    if (_scannedPath !== path) return; // 键已换代（工作区又切了）——本结果作废
    _skills = scan.skills.map((s) => ({ name: s.name, description: s.description }));
  } catch (e) {
    // 技能读不到不阻塞命令面——保持空候选，但错误必须留痕（错误不静默）
    if (_scannedPath === path) _skills = [];
    console.warn('[command-catalog] 技能扫描失败，斜杠技能候选保持为空:', e);
  }
}

/** 技能候选折算为命令条目（`/<技能名>` 直达 Skill 工具）。 */
export function skillCommands(): CommandContribution[] {
  return _skills.map((s) => ({
    id: `skill:${s.name}`,
    label: s.name,
    description: s.description || `执行技能 ${s.name}`,
    group: '技能',
    slash: `/${s.name}`,
    action: { type: 'skill', skillName: s.name },
  }));
}
