// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 后台任务的「忙等」护栏（2026-11-12 bash_output 滥用批）——**接面件**。
//
// 判据在叶模块 `shell-poll-guard.ts`（纯函数，零运行时依赖，可单测）；
// 本文件只做两件事：读/写 per-owner 记账（`session-context.ts` 的键控表）、
// 以及**打回动作**（本次 `output` 换成一次有界 `wait`，让模型这一次调用直接
// 拿到等待结果而不是又一条「仍在运行」）。
//
// 为什么打回要真等一次而不是只骂一句：模型已经证明自己在这件事上不听话
// （卷 97 被用户当面质问后当轮又复发），只加一句提示等于给它第 4 次机会。
// 直接把本次 `output` 换成有界 `wait`——等待是它本来就该做的事，结果也更有用。
//
// **不变量**：本文件任何失败都必须退化成「维持现状」（原样返回 output 结果）。
// 护栏是观测增强面，不是正确性面；它挂掉不能让读输出这件事挂掉。
// 同款纪律先例：`hooks.ts` 的 HOOK_ENRICH_TIMEOUT_MS（超时/抛错一律回落原值）。
//
// **护栏不得成为新的挂点**：代等有两条独立出口——`POLL_GUARD_WAIT_MS` 到期
// 与调用方 abort（用户按停止）。两者都立即结算，不新增「按停止没反应」这一族。

import { setShellPollState, shellPollStateOf } from './session-context';
import { shellPollVerdict } from './shell-poll-guard';

/** 代等一次的等待上限——3 分钟。
 *
 *  取值理由（对着实测定）：轮询间隔的中位数是 7.5s，卷 97 里让模型空转的
 *  两个 job 分别跑了 237s / 234s——3 分钟能吃掉绝大多数空转；而它又短到
 *  「即使这条代等路径表现异常，一轮也只被拖 3 分钟」，不会把整轮挂死。
 *  任务真还没完时 Rust 侧返回 `[任务运行中...]`，模型看到的是「等过了、还没完」，
 *  比第 N 条同样的「仍在运行」信息量高。 */
export const POLL_GUARD_WAIT_MS = 180_000;

/** 代等路径的兜底脱身时间：`wait` 调用本身卡住时的脱身点。
 *  比 `POLL_GUARD_WAIT_MS` 多 20s——留出 IPC 往返与 Rust 侧终态扫描的余量；
 *  仍超时说明这条通道本身有问题，退回原 output 结果（不新增挂点）。 */
const GUARD_WAIT_BACKSTOP_MS = POLL_GUARD_WAIT_MS + 20_000;

/** 一次 `output` 读的护栏裁决 + 可能的代等。
 *
 *  @param ownerId  发起方（executor 注入的 `_owner_id` / `_agent_id`）——
 *                  未登记 = 无 owner 上下文（UI 直调 / 单测），护栏不介入
 *  @param jobId    本次读的 job
 *  @param raw      原 `output` 结果（未裁决前的真值）
 *  @param waitOnce 代等动作：跑一次有界 `bash_wait` 并返回其结果；
 *                  实现由调用点给（它持有本 provider/seam 的引用）
 *  @param signal   本次工具调用的中止信号（用户停止时立刻脱身）
 */
export async function guardShellPoll(input: {
  ownerId: string | undefined;
  jobId: number;
  raw: string;
  waitOnce: (timeoutMs: number) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string> {
  const { ownerId, jobId, raw, waitOnce, signal } = input;
  // 无 owner（UI 直调 / 无 bus 的测试路径）：不记账、不代等——护栏只服务模型的循环。
  if (!ownerId) return raw;

  const verdict = shellPollVerdict(shellPollStateOf(ownerId), jobId, raw);
  setShellPollState(ownerId, verdict.next);
  if (!verdict.nudge) return raw;

  // 代等：把这次 output 换成一次真等待。任何失败/中止都退回原结果或纯提示。
  try {
    const waited = await raceWithAbort(waitOnce(POLL_GUARD_WAIT_MS), signal);
    // 代等拿到东西（终态或增量）⇒ 本段空转结束，记账清零。
    if (waited) {
      setShellPollState(ownerId, null);
      return `${verdict.nudge}\n\n──── bash_wait(${jobId}) 已代你等过一次 ────\n${waited}`;
    }
    return verdict.nudge;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${verdict.nudge}\n\n(bash_wait(${jobId}) 代等失败：${msg}——原 output 结果如下)\n${raw}`;
  }
}

/** 代等的三条出口竞速：拿到结果 / 调用方中止 / 兜底到期。
 *  中止与兜底都给空串 —— 调用方据此退回「只有提示、没有代等结果」。 */
function raceWithAbort(p: Promise<string>, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => resolve(''));
    const timer = setTimeout(() => finish(() => resolve('')), GUARD_WAIT_BACKSTOP_MS);
    if (signal?.aborted) {
      finish(() => resolve(''));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/** 读到增量 / 终态之外的工具（run / wait / kill）调用时清零本 owner 的记账。
 *
 *  语义：模型换了动作（真的去 wait 了、起了新 job、或者杀掉了），那段空转就结束了。
 *  不清的话，「先空读 2 次 → 去 wait → 回来再空读 1 次」会被拼成连续 3 次误喝止。 */
export function resetShellPollState(ownerId: string | undefined): void {
  if (!ownerId) return;
  setShellPollState(ownerId, null);
}
