// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Merge 门禁执行器 —— 资源租约层的验证机制。
//
// 时序（merge-then-verify，见计划 F1）：
//   1. merge 前（可选，默认关）：worktree 内编译测试 —— 唯一有意义的 pre-merge 检查
//
// （图检查门禁 runGraphGate（merge 后轮询 hologram_run_check 直到非 quiet）
//  已随图谱功能全量退役删除，2026-09-09——兰台侧零引擎接线后无 run_check
//  可轮询；merge 验证面只剩编译测试 gate。）

import { errText } from '../loop-helpers';
import { execStreamedShell } from '../runtime/queued-shell';
import type { BoardEntry } from '../task-board';

export interface MergeGateOptions {
  /** 项目根路径（merge 发生在主仓） */
  projectPath: string;
  /** 编译测试命令（默认 cargo check --message-format short） */
  compileCommand?: string;
  /** 编译测试超时（默认 10min） */
  compileTimeoutMs?: number;
}

export interface GateResult {
  passed: boolean;
  quiet: boolean;
  report: string;
}

/**
 * 编译测试（默认关）：merge 前在 worktree 内跑 cargo check。
 * worktree 自带独立 target/ 目录，是唯一有意义的 pre-merge 检查；
 * 冷构建可达分钟级，故 v1 默认关闭（时间盒警告）。
 */
export async function runCompileTest(entry: BoardEntry, opts: MergeGateOptions): Promise<GateResult> {
  if (!entry.isolationId) {
    return { passed: true, quiet: true, report: '无 worktree（fresh 模式），跳过编译测试' };
  }
  const command = opts.compileCommand ?? 'cargo check --message-format short';
  // isolationId 已含 agent- 前缀（agent.ts spawn 生成 agent-{ts}-{rand}），
  // Rust 侧 slug 也不重复拼接 — cwd 直接用 isolationId。
  const cwd = `${opts.projectPath}/.lantai/worktrees/${entry.isolationId}`;
  try {
    // 直连流式执行（队列已退役，2026-08-10）— 构建锁冲突由 Rust BuildLock 打回。
    // R3-d：execStreamedShell 收 process_cap 顶层 snake 形（无 owner——用户路径，
    // 不参与粘性 cwd 捕获）。
    const out = await execStreamedShell({ command, cwd, timeout_ms: opts.compileTimeoutMs ?? 600_000 });
    const passed = !/^\[exit [^0]\]/m.test(out.trimStart());
    return { passed, quiet: false, report: passed ? '✅ 编译测试通过' : `⚠️ 编译测试失败:\n${out.slice(0, 2000)}` };
  } catch (e) {
    return { passed: false, quiet: false, report: `⚠️ 编译测试异常: ${errText(e)}` };
  }
}
