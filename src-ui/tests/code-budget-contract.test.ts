// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 前台窗口预算的**契约测试**（P0-2，2026-11-22）。
//
// 卷 167 的 exception 不是某一处笔误，是一类边界：
//   ① 预算算术漏算对端自己的收尾延迟（Rust promote 宽限窗 10s vs 宿主余量 8s）；
//   ② 工具级声明把 run 的无损语义借给了 wait（超时被当失败 → 程序里 await 抛异常）；
//   ③ 未声明的动作也被注入 timeoutMs（审计里出现模型没给过的参数）；
//   ④ 尾部窗口压不出前台窗口时，进程被外层墙 kill 掉。
// 本文件把四条钉成可执行判据——以后新增动作/新工具改坏任一条都会红。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBudget,
  type CodeBindingSpec,
  PROMOTE_GRACE_MS,
  SOFT_TIMEOUT_MARGIN_MS,
  type SoftTimeoutPlan,
} from '../src/agent/code-run/host';

function shell(plan: CodeBindingSpec['softTimeout']): CodeBindingSpec {
  return {
    name: 'shell',
    readOnly: false,
    softTimeout: plan,
    invoke: async () => ({ output: '', isError: false }),
  };
}

const RUN: Record<string, SoftTimeoutPlan> = { run: { defaultTimeoutMs: () => 300_000 } };

describe('前台窗口预算（applyBudget）', () => {
  it('run：预算不足时压到「剩余 - 余量」，余量必须盖住 Rust 宽限窗', () => {
    const d = applyBudget(shell(RUN), { action: 'run', command: 'x' }, 30_000);
    expect(d.rewrite).toMatchObject({ arg: 'timeoutMs', from: 300_000, kind: 'clamp' });
    expect(d.args.timeoutMs).toBe(30_000 - SOFT_TIMEOUT_MARGIN_MS);
    // 余量 < 宽限窗 = promote 落在外层墙之后（卷 167 的算术病灶）
    expect(SOFT_TIMEOUT_MARGIN_MS).toBeGreaterThan(PROMOTE_GRACE_MS);
  });

  it('run：预算充足零改写（不把 schema default 写进参数）', () => {
    const d = applyBudget(shell(RUN), { action: 'run', command: 'echo hi' }, 600_000);
    expect(d.rewrite).toBeUndefined();
    expect('timeoutMs' in d.args).toBe(false);
  });

  it('run：已交后台的调用不压（卷 155 审计污染的判据）', () => {
    const plan = {
      run: {
        defaultTimeoutMs: () => 300_000,
        detached: (a: Record<string, unknown>) => a.runInBackground === true,
      },
    };
    const d = applyBudget(shell(plan), { action: 'run', command: 'x', runInBackground: true }, 30_000);
    expect(d.rewrite).toBeUndefined();
    expect('timeoutMs' in d.args).toBe(false);
  });

  it('未声明的动作原样透传：output/kill 不再被塞 timeoutMs', () => {
    for (const action of ['output', 'kill']) {
      const d = applyBudget(shell(RUN), { action, jobId: 3 }, 5_000);
      expect(d.rewrite).toBeUndefined();
      expect('timeoutMs' in d.args).toBe(false);
    }
  });

  it('wait：缺省 60s 在尾部也要压（它没有宽限窗，余量只留 IPC）', () => {
    const plan = { wait: { defaultTimeoutMs: () => 60_000, marginMs: 3_000, floorMs: 2_000 } };
    const d = applyBudget(shell(plan), { action: 'wait', jobId: 3 }, 40_000);
    expect(d.rewrite).toMatchObject({ kind: 'clamp', from: 60_000, to: 37_000 });
    expect(d.args.timeoutMs).toBe(37_000);
  });

  it('wait：模型给了更短的等待就零改写', () => {
    const plan = { wait: { defaultTimeoutMs: () => 60_000, marginMs: 3_000, floorMs: 2_000 } };
    const d = applyBudget(shell(plan), { action: 'wait', jobId: 3, timeoutMs: 5_000 }, 40_000);
    expect(d.rewrite).toBeUndefined();
    expect(d.args.timeoutMs).toBe(5_000);
  });

  it('尾部窗口：run 改写成后台句柄，而不是压成「刚起就超时」', () => {
    const plan = {
      run: {
        defaultTimeoutMs: () => 300_000,
        onExhausted: (a: Record<string, unknown>) => ({ ...a, runInBackground: true }),
      },
    };
    const d = applyBudget(shell(plan), { action: 'run', command: 'npx vitest run' }, 20_000);
    expect(d.rewrite).toMatchObject({ kind: 'detach' });
    expect(d.args.runInBackground).toBe(true);
    expect('timeoutMs' in d.args).toBe(false);
  });

  it('没声明 softTimeout 的绑定零改动（默认 abort 语义不变）', () => {
    const b: CodeBindingSpec = {
      name: 'mcp',
      readOnly: false,
      invoke: async () => ({ output: '', isError: false }),
    };
    const args = { action: 'call', timeoutMs: 999_999 };
    const d = applyBudget(b, args, 1_000);
    expect(d.args).toBe(args);
    expect(d.rewrite).toBeUndefined();
  });
});

describe('跨语言常量对拍（改一边不改另一边 = 红）', () => {
  const srcUi = process.cwd();
  const read = (...parts: string[]) => readFileSync(join(srcUi, '..', ...parts), 'utf8');
  const num = (raw: string) => Number(raw.replace(/_/g, ''));

  it('Rust PROMOTE_GRACE_MS === TS PROMOTE_GRACE_MS', () => {
    const rs = read('src-tauri', 'src', 'commands', 'process_cap.rs');
    const m = /const PROMOTE_GRACE_MS: u64 = ([\d_]+);/.exec(rs);
    if (!m) throw new Error('process_cap.rs 里找不到 PROMOTE_GRACE_MS');
    expect(num(m[1])).toBe(PROMOTE_GRACE_MS);
  });

  it('Rust wait 缺省等待 === TS SHELL_WAIT_DEFAULT_TIMEOUT_MS', () => {
    const rs = read('src-tauri', 'src', 'commands', 'process_cap.rs');
    const m = /wait_timeout_ms\.unwrap_or\(([\d_]+)\)/.exec(rs);
    if (!m) throw new Error('process_cap.rs 里找不到 wait_timeout_ms 的缺省值');
    const ts = read('src-ui', 'src', 'plugins', 'builtin', 'capability-segments', 'segments.ts');
    const t = /const SHELL_WAIT_DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(ts);
    if (!t) throw new Error('segments.ts 里找不到 SHELL_WAIT_DEFAULT_TIMEOUT_MS');
    expect(num(t[1])).toBe(num(m[1]));
  });

  it('余量 = 宽限窗 + 5s 头寸（不能只等于宽限窗）', () => {
    expect(SOFT_TIMEOUT_MARGIN_MS).toBe(PROMOTE_GRACE_MS + 5_000);
  });
});
