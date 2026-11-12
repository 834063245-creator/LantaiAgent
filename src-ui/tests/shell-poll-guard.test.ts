// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 后台任务「忙等」护栏回归门（2026-11-12 bash_output 滥用批）。
//
// 三组：
//   ① 判据（纯函数，`agent/shell-poll-guard.ts`）——空读/真增量的边界逐项钉住；
//   ② 接面（`agent/shell-poll-hook.ts`）——第 3 次空读被代等一次 wait，
//      失败/中止一律退回原结果（护栏不得成为新挂点）；
//   ③ 工具面（`shell-domain` 的 bash_output）——真经 provider seam 走一遍，
//      钉「第 3 次读的是 wait 而不是又一跳 output」，以及换招清零。

import { clearShellPollsForTest, shellPollStateOf } from '../src/agent/session-context';
import {
  isEmptyShellPoll,
  SHELL_POLL_NUDGE_THRESHOLD,
  shellPollNudge,
  shellPollVerdict,
} from '../src/agent/shell-poll-guard';
import { guardShellPoll, POLL_GUARD_WAIT_MS, resetShellPollState } from '../src/agent/shell-poll-hook';
import type { ShellProvider } from '../src/composition/shell-service';
import { createShellTools } from '../src/plugins/builtin/shell-domain/shell-tools';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

/** 运行中且零增量的真值形态（Rust `read_bg_output` 原样：header + 无正文）。 */
const RUNNING_EMPTY = '[任务运行中, 已运行: 37s]\n';
/** 运行中但有增量（watch mode 的正常形态）。 */
const RUNNING_WITH_OUTPUT = '[任务运行中, 已运行: 41s]\ncompiled 12 modules\n';
/** 终态。 */
const DONE = '[任务已完成, exit code: 0, 耗时: 272s]\nall green\n';

describe('shell poll guard — 判据（纯函数）', () => {
  it('只认「整段只有一行运行中 header」为空读', () => {
    expect(isEmptyShellPoll(RUNNING_EMPTY)).toBe(true);
    expect(isEmptyShellPoll('[任务运行中, 已运行: 0s]')).toBe(true); // 无尾换行
    expect(isEmptyShellPoll('  \n[任务运行中, 已运行: 9s]\r\n\r\n')).toBe(true); // 空白不参与
    expect(isEmptyShellPoll(RUNNING_WITH_OUTPUT)).toBe(false); // 有正文 = 读到东西了
    expect(isEmptyShellPoll(DONE)).toBe(false); // 终态
    expect(isEmptyShellPoll('')).toBe(true); // 空串 = 什么都没有
  });

  it('同一 job 连续空读达到阈值才喝止，一次为限', () => {
    let state = shellPollVerdict(undefined, 7, RUNNING_EMPTY);
    expect(state.next).toEqual({ jobId: 7, emptyReads: 1, nudged: false });
    expect(state.nudge).toBeNull();

    state = shellPollVerdict(state.next ?? undefined, 7, RUNNING_EMPTY);
    expect(state.next).toEqual({ jobId: 7, emptyReads: 2, nudged: false });
    expect(state.nudge).toBeNull();

    state = shellPollVerdict(state.next ?? undefined, 7, RUNNING_EMPTY);
    expect(state.next).toEqual({ jobId: 7, emptyReads: SHELL_POLL_NUDGE_THRESHOLD, nudged: true });
    expect(state.nudge).toContain(`[poll guard] bash_output(7)`);
    expect(state.nudge).toContain('bash_wait(7)');
    expect(state.nudge).toContain('full model round');

    // 第 4 次：同一段只喝止一次（不刷屏、不重复代等）
    state = shellPollVerdict(state.next ?? undefined, 7, RUNNING_EMPTY);
    expect(state.next?.emptyReads).toBe(4);
    expect(state.nudge).toBeNull();
  });

  it('读到增量即清零（watch mode 读多少次都不算空转）', () => {
    const v = shellPollVerdict({ jobId: 7, emptyReads: 2, nudged: false }, 7, RUNNING_WITH_OUTPUT);
    expect(v.next).toBeNull();
    expect(v.nudge).toBeNull();
  });

  it('读到终态即清零', () => {
    const v = shellPollVerdict({ jobId: 7, emptyReads: 2, nudged: false }, 7, DONE);
    expect(v.next).toBeNull();
  });

  it('换 job 重新计数（不把两个任务的空读拼在一起）', () => {
    const v = shellPollVerdict({ jobId: 7, emptyReads: 2, nudged: false }, 8, RUNNING_EMPTY);
    expect(v.next).toEqual({ jobId: 8, emptyReads: 1, nudged: false });
    expect(v.nudge).toBeNull();
  });

  it('喝止文案点名「超时就再 wait」，不教它回去轮询', () => {
    const text = shellPollNudge(11, 3);
    expect(text).toContain('bash_wait(11)');
    expect(text).toContain('larger timeoutMs');
    expect(text).not.toContain('poll again');
  });
});

describe('shell poll guard — 接面（代等 / 回落）', () => {
  beforeEach(() => {
    clearShellPollsForTest();
  });

  it('无 owner（UI 直调 / 单测）＝护栏不介入：原样返回', async () => {
    const raw = await guardShellPoll({
      ownerId: undefined,
      jobId: 7,
      raw: RUNNING_EMPTY,
      waitOnce: async () => 'should not be called',
    });
    expect(raw).toBe(RUNNING_EMPTY);
  });

  it('未到阈值只记账，不代等', async () => {
    let waited = 0;
    const r1 = await guardShellPoll({
      ownerId: 'a1',
      jobId: 7,
      raw: RUNNING_EMPTY,
      waitOnce: async () => {
        waited++;
        return DONE;
      },
    });
    expect(r1).toBe(RUNNING_EMPTY);
    expect(waited).toBe(0);
    expect(shellPollStateOf('a1')).toEqual({ jobId: 7, emptyReads: 1, nudged: false });
  });

  it('第 3 次空读被代等一次 wait，结果里带等待产物', async () => {
    for (let i = 0; i < SHELL_POLL_NUDGE_THRESHOLD - 1; i += 1) {
      await guardShellPoll({ ownerId: 'a2', jobId: 7, raw: RUNNING_EMPTY, waitOnce: async () => DONE });
    }
    let gotTimeout: number | undefined;
    const out = await guardShellPoll({
      ownerId: 'a2',
      jobId: 7,
      raw: RUNNING_EMPTY,
      waitOnce: async (ms) => {
        gotTimeout = ms;
        return DONE;
      },
    });
    expect(gotTimeout).toBe(POLL_GUARD_WAIT_MS);
    expect(out).toContain('[poll guard]');
    expect(out).toContain('已代你等过一次');
    expect(out).toContain('all green'); // 等待拿到的是真结果
    // 代等成功后整段清零（不让下一次读继承「已喝止」态）
    expect(shellPollStateOf('a2')).toBeUndefined();
  });

  it('代等失败 ⇒ 退回提示 + 原结果（护栏不制造挂点）', async () => {
    for (let i = 0; i < SHELL_POLL_NUDGE_THRESHOLD - 1; i += 1) {
      await guardShellPoll({ ownerId: 'a3', jobId: 7, raw: RUNNING_EMPTY, waitOnce: async () => DONE });
    }
    const out = await guardShellPoll({
      ownerId: 'a3',
      jobId: 7,
      raw: RUNNING_EMPTY,
      waitOnce: async () => {
        throw new Error('后台任务不存在或已完成');
      },
    });
    expect(out).toContain('[poll guard]');
    expect(out).toContain('代等失败');
    expect(out).toContain('后台任务不存在或已完成');
    expect(out).toContain(RUNNING_EMPTY.trim()); // 原结果仍在
  });

  it('调用方中止 ⇒ 立刻脱身（不新增「按停止没反应」）', async () => {
    for (let i = 0; i < SHELL_POLL_NUDGE_THRESHOLD - 1; i += 1) {
      await guardShellPoll({ ownerId: 'a4', jobId: 7, raw: RUNNING_EMPTY, waitOnce: async () => DONE });
    }
    const ac = new AbortController();
    const pending = guardShellPoll({
      ownerId: 'a4',
      jobId: 7,
      raw: RUNNING_EMPTY,
      // 永不 settle 的 wait：只有 abort 能脱身
      waitOnce: () => new Promise<string>(() => {}),
      signal: ac.signal,
    });
    ac.abort();
    const out = await pending; // 必须 settle
    expect(out).toContain('[poll guard]');
  });

  it('resetShellPollState 清账（换招即那段空转结束）', async () => {
    await guardShellPoll({ ownerId: 'a5', jobId: 7, raw: RUNNING_EMPTY, waitOnce: async () => DONE });
    expect(shellPollStateOf('a5')).toEqual({ jobId: 7, emptyReads: 1, nudged: false });
    resetShellPollState('a5');
    expect(shellPollStateOf('a5')).toBeUndefined();
  });
});

describe('shell poll guard — 工具面（真经 provider seam）', () => {
  /** 只实现 output/wait 的内存 provider：output 恒回「运行中且零增量」，
   *  wait 直接返回终态。记录每次被调用的动作。 */
  function stallProvider(calls: string[]): ShellProvider {
    return {
      id: 'test/stall-shell',
      async execute(action) {
        calls.push(action);
        if (action === 'output') return RUNNING_EMPTY;
        if (action === 'wait') return DONE;
        return `(stall) ${action}`;
      },
    };
  }

  function toolByName(name: string, exec: () => Promise<string>) {
    const t = createShellTools(exec).find((x) => x.name() === name);
    if (!t) throw new Error(`shell 工具缺失: ${name}`);
    return t;
  }

  it('第 3 次 bash_output 换成一次 wait，第 4 次才又回到 output', async () => {
    clearShellPollsForTest();
    const root = await ensureProductionChannelsBooted();
    const calls: string[] = [];
    const dispose = root.shell.register(stallProvider(calls));
    // dispatch 不该被触到（provider 全权服务）
    const exec = async () => {
      throw new Error('dispatch 不应被调用');
    };
    const output = toolByName('bash_output', exec);
    const meta = { jobId: 7, _owner_id: 'tool-owner-1' };

    expect(await output.execute(meta)).toBe(RUNNING_EMPTY);
    expect(await output.execute(meta)).toBe(RUNNING_EMPTY);
    const third = await output.execute(meta);
    expect(third).toContain('[poll guard]');
    expect(third).toContain('all green');
    // 前两次 output，第三次 = output 之后接一次 wait（打回的代等）
    expect(calls).toEqual(['output', 'output', 'output', 'wait']);

    // 代等成功 ⇒ 清零：第 4 次回到普通 output
    calls.length = 0;
    expect(await output.execute(meta)).toBe(RUNNING_EMPTY);
    expect(calls).toEqual(['output']);
    dispose();
  });

  it('bash_wait 真正被调用时清零（模型自己学会等待即不再喝止）', async () => {
    clearShellPollsForTest();
    const root = await ensureProductionChannelsBooted();
    const calls: string[] = [];
    const dispose = root.shell.register(stallProvider(calls));
    const exec = async () => 'unused';
    const output = toolByName('bash_output', exec);
    const wait = toolByName('bash_wait', exec);
    const meta = { jobId: 9, _owner_id: 'tool-owner-2' };

    await output.execute(meta);
    await output.execute(meta);
    expect(shellPollStateOf('tool-owner-2')?.emptyReads).toBe(2);
    // 模型换招去 wait ⇒ 记账清零
    await wait.execute({ jobId: 9, _owner_id: 'tool-owner-2' });
    expect(shellPollStateOf('tool-owner-2')).toBeUndefined();
    // 之后重新从 1 开始数，不会因为「之前的 2 次」立刻触发
    const after = await output.execute(meta);
    expect(after).toBe(RUNNING_EMPTY);
    expect(shellPollStateOf('tool-owner-2')?.emptyReads).toBe(1);
    dispose();
  });

  it('读到增量的 watch mode 不受影响（output 的正当用途）', async () => {
    clearShellPollsForTest();
    const root = await ensureProductionChannelsBooted();
    const calls: string[] = [];
    let n = 0;
    const dispose = root.shell.register({
      id: 'test/watch-shell',
      async execute(action) {
        calls.push(action);
        if (action !== 'output') return DONE;
        n += 1;
        return `${RUNNING_EMPTY}${'chunk-'.repeat(1)}${n}\n`; // 每次都有增量
      },
    });
    const output = toolByName('bash_output', async () => 'unused');
    const meta = { jobId: 3, _owner_id: 'tool-owner-3' };
    for (let i = 0; i < 6; i += 1) {
      const r = await output.execute(meta);
      expect(r).not.toContain('[poll guard]');
    }
    expect(calls).toEqual(['output', 'output', 'output', 'output', 'output', 'output']);
    expect(shellPollStateOf('tool-owner-3')).toBeUndefined();
    dispose();
  });
});
