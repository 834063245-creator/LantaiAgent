// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 程序内调用的展示记录（2026-11-21 显形批；2026-11-23 起两拍）。
//
// 为什么单列成叶模块（零 import）：纸面（paper/code-calls）与消息分流
// （ui/part-mutator）都要读同一份记录类型与旧卷回退判据；若留在 host.ts，
// paper-shell 产物会把 worker bootstrap 一并拖进模块图（内置产物按名册
// `shared` 白名单校验输入集，见 scripts/build-builtin-plugins.mjs）。
// 这里只放形状与纯判据，不碰 Worker / 协议 / 会话。

/** 程序内调用的阶段（2026-11-23 运行态批）。 */
export type CodeCallStatus = 'running' | 'done' | 'error';

/** 程序内调用的一笔**事件**（展示面旁路；2026-11-21 建立，2026-11-23 起两拍）。
 *
 *  同一 seq 会来两条：起跑（status='running'，无 summary）与落定
 *  （status='done'|'error'，带 summary）。展示面按 seq 原地更新——用户不必等内层
 *  工具跑完才看见「现在在跑什么」（用户 2026-11-23：程序里跑 shell(run) 时，卡片
 *  要等 shell 结束才出现一行）。
 *
 *  ⚠ 旧卷快照（2026-11-23 前写的 uiMessages）**只有 ok、没有 status**：读取面
 *  一律经 `codeCallStatus` 回退，不得直接读 `status`。 */
export interface CodeDispatchRecord {
  /** 程序内调用序（1 起，按**起跑序**——与 session-log 的 dispatchCounter 不同源：
   *  后者在过写闸后计数，本序在通过校验时计数，排队中的写也会先占一号）。 */
  seq: number;
  name: string;
  /** 该动作（域工具的 args.action；非域工具为 undefined）。 */
  action?: string;
  /** 阶段；旧卷缺省（读取面用 `codeCallStatus` 回退 `ok`）。 */
  status?: CodeCallStatus;
  /** **旧卷快照的成败位**（2026-11-23 前；新记录不再写）。 */
  ok?: boolean;
  /** 结果首行（已截断）——只够「一眼看出它干了什么」，不做正文。running 时缺省。 */
  summary?: string;
  /** 起跑时刻（毫秒）。落定事件沿用起跑值——展示面不得重置计时。 */
  startedAt?: number;
}

/** 一笔调用的阶段（**单一判据**：UI 分流、纸面投影、折读都读它）。
 *  旧卷无 status 时按 ok 判——`ok === false` 才是失败，其余（含 ok 缺省）算落定。 */
export function codeCallStatus(c: Pick<CodeDispatchRecord, 'status' | 'ok'>): CodeCallStatus {
  if (c.status === 'running' || c.status === 'done' || c.status === 'error') return c.status;
  return c.ok === false ? 'error' : 'done';
}
