// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-slash — 创作坞的**斜杠命令域**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组状态**随同一个事件变化**——都随「正文里那个 / 触发词」变：
// 查询词、过滤后的命令清单、高亮下标、技能清单换代信号，以及唯一一条提交动作。
//
// 命令清单真源 = app/commands/command-catalog 合流点（本卷内建命令 + ctx.commands
// 贡献 + 技能候选）——旧 CommandRegistry 单例已退役。
// **翰 = 全局命令面板（Ctrl+K 同一份）**：带搜索框、分组、动作/插件命令，不再在坞里
// 维护第二份内联清单；`/` 触发词仍走本坞内联面板（只列斜杠触达的命令、查询词就在
// 正文里，↑↓/Enter/Esc 照旧）。两处共用 listCommands/filterCommands 与执行面。
//
// ⚠ 技能换代用**显式入参**而不是「依赖数组里的魔法值」：`skillTick` 既进 memo 体
// （`void skillTick`）也进依赖——两者写在同一处，lint 无须豁免，读的人也看得见
// 「这个值只当信号用」。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatCore, CommandContribution } from '../host';
import { ensureSkillCatalog, filterCommands, listCommands, slashOnly, useShellStore } from '../host';

export interface ComposerSlashInput {
  core: ChatCore | null;
  /** 输入框正文（查询词的唯一来源）。 */
  inputText: string;
}

export function useComposerSlash({ core, inputText }: ComposerSlashInput) {
  const slashQuery = useMemo(() => {
    const v = inputText;
    if (!v) return null;
    const last = v.lastIndexOf('/');
    if (last < 0) return null;
    if (last > 0 && v[last - 1] !== ' ' && v[last - 1] !== '\n') return null;
    const q = v.slice(last + 1);
    /* 参数模式：命令词后面出现空白 = 已经在写参数（`/goal pause`），面板让位。
     * 没有这条，带参命令填完「/goal 」后查询词变成「goal 」，列表会继续挂着，
     * 用户接着打的参数再把它顶成「无匹配命令」。 */
    if (/\s/.test(q)) return null;
    return q;
  }, [inputText]);
  /* 技能清单变更信号（2026-11-07 热装载）：扫描完成且清单真变了 → 自增一次，
   * 让下面的 slashCommands 重取（命令清单是同步读取面，靠 tick 触发重算）。
   * 产物域不订阅 panel-defs-store（那要动宿主桥 faceDeps、改宿主面指纹），
   * 改读 ensureSkillCatalog 的返回值——同一条闭环，零新增宿主面键。 */
  const [skillTick, setSkillTick] = useState(0);
  const slashCommands = useMemo(() => {
    void skillTick; // 「技能清单换代」触发器：命令清单是同步读取面，正是要靠它重算
    if (slashQuery === null) return [];
    return filterCommands(slashOnly(listCommands(core)), slashQuery);
  }, [slashQuery, core, skillTick]);
  /* 面板每次**打开** = 强制重扫技能目录（不只是键变了才扫）：热装载就是在同一个
   * 工作区里多出 `.lantai/skills/<名>/SKILL.md`（设置页新建 / 手放 / Agent 自己写），
   * 路径键根本不变——旧实现靠键控检查，「永远不重扫」+「扫完不通知」两处叠加，
   * 新技能在斜杠面板里就是不出现。
   * ⚠ 只在「未开 → 已开」那一次扫：slashQuery 随每个按键变，按它无条件扫 =
   * 打一个 /co 就 list+read 两遍磁盘（每个按键一次全量扫描）。 */
  const slashOpened = useRef(false);
  useEffect(() => {
    const open = slashQuery !== null;
    const justOpened = open && !slashOpened.current;
    slashOpened.current = open;
    if (!justOpened) return;
    let cancelled = false;
    void ensureSkillCatalog(useShellStore.getState().projectPath, { force: true }).then((changed) => {
      if (!cancelled && changed) setSkillTick((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [slashQuery]);
  /* ── C3（2026-08-27）：斜杠面板键盘导航（↑↓ 选、Enter 执行、Esc 关）。 ── */
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => {
    void slashQuery; // 查询词变化触发器：正是要响应它复位高亮
    setSlashIdx(0); // 查询词变化 → 高亮复位首项（滚动归零在面板件内）
  }, [slashQuery]);
  const slashActive = slashCommands.length > 0;
  /** 命中查询词（与 filterCommands 同口径：去首斜杠 + 小写），交给面板标朱。 */
  const slashHit = (slashQuery ?? '').trim().replace(/^\//, '');
  /* 点选/回车 = 提交。带参命令（takesArg：/goal <目标> · /remember <事实>）**不执行**，
   * 改成把「/cmd 」填进输入框等用户补参数——旧形态点一下就 handler('') 空参跑掉。 */
  const commitSlash = useCallback(
    (cmd: CommandContribution) => {
      if (!core) return;
      if (cmd.takesArg) core.prepareCommand(cmd);
      else core.executeCommand(cmd);
    },
    [core],
  );

  return { slashQuery, slashCommands, slashIdx, setSlashIdx, slashActive, slashHit, commitSlash };
}
