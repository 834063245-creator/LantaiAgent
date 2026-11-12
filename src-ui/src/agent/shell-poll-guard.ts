// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 后台任务的「忙等」判据（2026-11-12 bash_output 滥用批）。
//
// **来由（实测，不是审美）**：最近 7 卷 `.lantai/sessions/*.ndjson` 里
// `shell(output)` 共 132 次，其中 120 次（91%）只换回一行
// `[任务运行中, 已运行: Ns]`；最长一段是同一 job 连读 31 次 / 237 秒。
// 每次读 = 一整轮模型调用（该卷 cacheRead 66.4M / uncached 1.27M / output 195k）
// ⇒ 这不是「便宜」而是最贵的空转。同卷模型被用户当面质问
// （`97.ndjson` seq 929「为什么你一直在跑output工具」）后承认是操作毛病，
// **且当轮又原样复发**——说明只改提示词不够，必须有一条运行时不依赖模型自觉的护栏。
//
// **护栏形态**：本文件只做**判据**（纯函数 + 一份每 owner 的计数状态）。
// 打回动作在 `shell-poll-guard.ts`（它要经 seam 调 `bash_wait`，会进运行时依赖）。
// 这样纯判据可以被单测逐项钉住，而本文件保持零 IO 零项目内运行时依赖。
//
// **为什么判据是「零增量」而不是「调用次数」**：轮询键控在增量上才有意义——
// 模型看 watch mode / dev server 的真实增量时读多少次都合理（那也是 `output`
// 存在的理由）。只有「连续多次一个字节都没拿到」才是空转，才该被喝止。
//
// **为什么阈值是 3**：与 storm breaker（`agent.ts` 的 STORM_BREAK_THRESHOLD = 3）
// 同一个数——仓库里「同一个动作失败/空转 3 次就推模型换招」是既有语义，不另造一把尺。

/** 连续几次零增量的 `output` 才喝止（= storm breaker 的既有阈值）。 */
export const SHELL_POLL_NUDGE_THRESHOLD = 3;

/** `[任务运行中, 已运行: Ns]` 且**没有正文** = 本次读一个字节都没新增。
 *
 *  判据必须是「整段只有这一行」：Rust 侧 `read_bg_output` 把运行态 header
 *  和增量正文拼在一起返回（`bg_jobs.rs` 的 info + stdout_inc + stderr_inc），
 *  所以「运行中」后面还有任何非空行 = 这次确实读到了东西，不算空转。
 *  末尾换行 / 前后空白不参与判定（header 恒以 `\n` 收尾）。 */
export function isEmptyShellPoll(result: string): boolean {
  const lines = result
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return true;
  if (lines.length > 1) return false;
  return /^\[任务运行中[^\]]*\]$/.test(lines[0] ?? '');
}

/** 单 owner 的忙等记账。 */
export interface ShellPollState {
  /** 正在被反复空读的 job id（换 job = 重新计数）。 */
  jobId: number;
  /** 连续空读数（读到任何增量 / 终态即归零）。 */
  emptyReads: number;
  /** 本段空转是否已经喝止过（同一段只喝止一次，不刷屏、不重复烧轮次）。 */
  nudged: boolean;
}

/** 一次 `output` 读的裁决结果。 */
export interface ShellPollVerdict {
  /** 下一个状态（null = 清零：读到东西了 / 换了 job 且该清零）。 */
  next: ShellPollState | null;
  /** 要追加到工具结果尾部的喝止文案（null = 不打回）。 */
  nudge: string | null;
}

/** 状态转移：把「本次读到的结果」折算成新状态 + 是否喝止。
 *
 *  @param prev  本 owner 上一次的记账（未读过 = undefined）
 *  @param jobId 本次读的 job
 *  @param result 本次 `output` 返回的完整文本
 */
export function shellPollVerdict(prev: ShellPollState | undefined, jobId: number, result: string): ShellPollVerdict {
  // 读到增量 / 读到终态 ⇒ 这次读是有价值的，整段归零。
  if (!isEmptyShellPoll(result)) return { next: null, nudge: null };

  const sameJob = prev !== undefined && prev.jobId === jobId;
  const emptyReads = sameJob ? prev.emptyReads + 1 : 1;
  const next: ShellPollState = { jobId, emptyReads, nudged: sameJob ? prev.nudged : false };

  if (next.emptyReads < SHELL_POLL_NUDGE_THRESHOLD || next.nudged) return { next, nudge: null };

  next.nudged = true;
  return { next, nudge: shellPollNudge(jobId, next.emptyReads) };
}

/** 喝止文案。形态对齐 storm breaker 的 `[loop guard]`（同一位置：追加到首个工具结果尾部）。
 *
 *  内容三件：① 事实（读了几次、一个字节都没新增）；② 为什么这是浪费（每次读是一整轮
 *  模型调用）；③ 该改用什么（`wait` 一次等到结束，超时就再 wait——不是再 output）。 */
export function shellPollNudge(jobId: number, emptyReads: number): string {
  return (
    `\n\n[poll guard] bash_output(${jobId}) has now returned no new bytes ${emptyReads} times in a row — ` +
    'each of those reads cost a full model round and told you nothing but "still running". ' +
    `Stop polling. Call bash_wait(${jobId}) to wait for completion (a timed-out wait leaves the job running: ` +
    'call bash_wait again with a larger timeoutMs). The completion also arrives as a bg notice, so you can ' +
    'leave the job alone and do other work. Use bash_output again only when you genuinely want partial output.'
  );
}
