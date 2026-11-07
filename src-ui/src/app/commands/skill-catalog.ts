// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 技能候选目录 — 斜杠面板里 `/<技能名>` 一类条目的真源。
//
// 技能扫描是异步的（读 `{ws}/.lantai/skills` + `~/.lantai/skills`），而命令
// 清单是同步读取面（面板每次渲染取一次）——本模块用「工作区路径键控缓存」
// 桥接：同步读缓存，发现工作区变了就 fire-and-forget 重扫。
//
// 2026-11-07 热装载闭环（用户报「热装载之后斜杠命令里能不能正常刷出新 skills」）：
// 旧实现有两处断点，任何一处都足以让新装的技能看不见——
//   ① **键没变就不重扫**：`_scannedPath === path` 直接 return。而「热装载」恰恰
//      是同一个工作区里多出一个 `.lantai/skills/<名>/SKILL.md`（设置页新建、
//      手放目录、Agent 自己写）——路径键根本没变，于是永远不重扫；
//   ② **扫完了没人知道**：旧注释写的就是「扫描完成不主动通知 UI（下次渲染自然
//      读到新清单）」——可下一次渲染要等别的状态变，用户看到的还是旧清单。
// 现在：`ensureSkillCatalog(path, { force: true })` 强制重扫并把「清单变了」
// 作为返回值交给调用方（`Promise<boolean>`）——面板拿到 true 就自增 tick 重取，
// 这就是「扫描完成发信号」；不新增导出、不改宿主桥键，产物域零影响。
// 同键在途扫描去重（连打几次 / 多个面板同时开，只扫一遍）。
//
// 变更判据不是 digest：digest 只算 `source:name`（发现注入增量用），技能正文/
// 描述改了它不变——而面板要显示 description，得按 `name|description` 比对。
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
/** 当前在途扫描（去重：同工作区并发请求只发一次）；`null` = 空闲。 */
let _inflight: Promise<boolean> | null = null;
/** 在途扫描对应的键（`ensureSkillCatalog(null)` 清缓存时要能判定结果作废）。 */
let _inflightPath: string | null = null;

export interface EnsureSkillCatalogOptions {
  /** 强制重扫（不管工作区键变没变）——热装载用：面板每次「打开」都重扫一遍，
   *  新装的技能下一帧就出现在清单里。缺省 false = 只做键控检查。 */
  force?: boolean;
}

/** 清单签名（变更判据 = `name|description`；digest 只算 source:name，管不到描述）。 */
function signatureOf(skills: readonly SkillCatalogEntry[]): string {
  return skills
    .map((s) => `${s.name}|${s.description ?? ''}`)
    .sort()
    .join('\u0000');
}

/** 同步确保当前工作区的技能清单：键（工作区路径）变了就后台重扫。
 *  无工作区 = 清空候选。重复调用同键是空操作（含在途扫描）。
 *
 *  @returns 清单是否**真的变了**（新装/删掉/描述改了 = true）。调用方据此决定
 *  要不要重取命令清单——`force: true` 的「打开即重扫」路径靠它拿到信号。 */
export async function ensureSkillCatalog(
  path: string | null,
  options: EnsureSkillCatalogOptions = {},
): Promise<boolean> {
  if (!path) {
    const had = _skills.length > 0;
    _skills = [];
    _scannedPath = null;
    _inflight = null;
    _inflightPath = null;
    return had;
  }
  const keyChanged = _scannedPath !== path;
  if (!keyChanged && !options.force) return false;
  if (!keyChanged && _inflight && _inflightPath === path) return _inflight; // 在途去重

  _scannedPath = path;
  _inflightPath = path;
  const run = scanFor(path).finally(() => {
    if (_inflight === run) {
      _inflight = null;
      _inflightPath = null;
    }
  });
  _inflight = run;
  return run;
}

/** 重扫并同步缓存。返回「清单变了没」——判据见 {@link signatureOf}。 */
async function scanFor(path: string): Promise<boolean> {
  const before = signatureOf(_skills);
  let next: SkillCatalogEntry[];
  try {
    // 批 9h-3：技能域实现随 skill-domain 包 ⇒ 走内核登记表门面（缺实现 fail-loud，
    // 由本函数 catch 兜成「候选为空 + 留痕」的既有降级语义）
    const { scanSkills } = await import('../../agent/skill-impl');
    const scan = await scanSkills(path);
    if (_scannedPath !== path) return false; // 键已换代（工作区又切了）——本结果作废
    next = scan.skills.map((s) => ({ name: s.name, description: s.description }));
  } catch (e) {
    // 技能读不到不阻塞命令面——保持空候选，但错误必须留痕（错误不静默）
    if (_scannedPath === path) _skills = [];
    console.warn('[command-catalog] 技能扫描失败，斜杠技能候选保持为空:', e);
    return false;
  }
  const after = signatureOf(next);
  _skills = next;
  /* 返回值就是「信号」本身：调用方（创作坞的斜杠面板）拿到 true 自增 tick 重取。
   * 刻意**不**复用 panel-defs-store 的 bumpCommands——那要往宿主桥 faceDeps 加键，
   * 会改宿主面指纹、连带全体产物重建（见 hostSurfaceFingerprint 头注）；而翰
   * （Ctrl+K）本来就不陈列技能候选，bump 过去也只是空转。 */
  return after !== before;
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
