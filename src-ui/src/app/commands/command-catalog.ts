// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 命令目录 — 斜杠命令与命令面板的唯一合流点（command-surface-rework 2026-09-19）。
//
// 三段来源，顺序即呈现序（分组相邻）：
//   ① 会话内建命令 —— ChatCore 提供（面板级：handler 绑本卷实例、作用于本卷）
//   ② ctx.commands 贡献 —— 插件/第一方面的面板与画布命令（应用级）
//   ③ 技能候选 —— `<技能名>` 动态折算（见 skill-catalog）
//
// 旧形态（本模块之前）是两套互不相通的命令面：`ui/command-registry.ts` 的模块级
// 单例数组只喂 `/` 内联面板（且靠 `_wireCommandHandlers` 就地把 handler 写进全局
// 表——多面板串扰形状），`ctx.commands` 只喂 Ctrl+K——于是退役命令留在面板里、
// 插件新命令永远进不来。本模块是二者唯一的消费读取面：`/` 面板与命令面板消费
// 同一份清单，差异只在过滤（`/` 触发只列有斜杠触发词的条目）。
//
// 归属：纯函数 + 两段只读来源，无自有可变状态（技能缓存在 skill-catalog）。

import { activeCommandContributions, type CommandContribution } from '../../composition/services';
import { skillCommands } from './skill-catalog';

/** 会话内建命令的提供方 —— ChatCore 实例实现（handler 已绑本卷）。 */
export interface CommandHost {
  builtinCommands(): CommandContribution[];
}

/** 合流清单（缺 host = 只有应用级贡献与技能）。 */
export function listCommands(host?: CommandHost | null): CommandContribution[] {
  return [...(host?.builtinCommands() ?? []), ...activeCommandContributions(), ...skillCommands()];
}

/** 斜杠触达子集（`/` 触发词面板用：无斜杠触发词的键位命令不进此列）。 */
export function slashOnly(cmds: readonly CommandContribution[]): CommandContribution[] {
  return cmds.filter((c) => (c.slash ?? '') !== '');
}

/** 查询过滤：匹配斜杠触发词、显示名、描述（空查询 = 全量原序）。 */
export function filterCommands(cmds: readonly CommandContribution[], query: string): CommandContribution[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return [...cmds];
  return cmds.filter((c) => {
    const slash = (c.slash ?? '').toLowerCase().replace(/^\//, '');
    return slash.includes(q) || c.label.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q);
  });
}

/** 按斜杠触发词精确查找（大小写不敏感；入参可带可不带前导 `/`）。 */
export function findCommandBySlash(
  cmds: readonly CommandContribution[],
  slash: string,
): CommandContribution | undefined {
  const want = (slash.startsWith('/') ? slash : `/${slash}`).toLowerCase();
  return cmds.find((c) => (c.slash ?? '').toLowerCase() === want);
}

/** 斜杠行解析：`/goal resume` → `{ cmd: /goal 条目, arg: 'resume' }`；
 *  非斜杠行或未命中命令 → null（调用方决定是否回落技能路由）。
 *  命令词 = 首个空白之前的部分；参数 = 其余（已 trim）。 */
export function parseSlashInput(
  cmds: readonly CommandContribution[],
  text: string,
): { cmd: CommandContribution; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const sp = t.search(/\s/);
  const word = sp < 0 ? t : t.slice(0, sp);
  const arg = sp < 0 ? '' : t.slice(sp + 1).trim();
  const cmd = findCommandBySlash(cmds, word);
  return cmd ? { cmd, arg } : null;
}
