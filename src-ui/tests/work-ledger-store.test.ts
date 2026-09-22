// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// work-ledger-store.test.ts — 役台账（后台工作监视面的数据面）纯逻辑。
//
// 考官面：① 子 Agent 的 spawn/finished 记账（含「非本面板派生的收尾 = no-op」）；
// ② shell 快照对账（起算反推稳定、从在役集合消失即结转终态、退出码不编造）；
// ③ 按面板 × 卷的切分与在役/终态排序；④ 终态配额淘汰不吃在役；
// ⑤ 拉取失败**可见**（写 error，不静默吞）；⑥ 只读纪律（绝不调 bash_output）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂会提升到文件顶部，因此 mock 变量必须经 vi.hoisted 创建。
const { kernelProcessCall } = vi.hoisted(() => ({
  kernelProcessCall: vi.fn<(action: string, args?: Record<string, unknown>) => Promise<string>>(),
}));

vi.mock('../src/rpc-contract', () => ({ kernelProcessCall }));
// 动作失败走提示条（与人可见的反馈面同一条通道），测试里截住即可。
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../src/state/toast-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state/toast-store')>()),
  showToast,
}));

import {
  killShellWork,
  pullShellWork,
  resetWorkLedgerForTests,
  type ShellSnapshot,
  selectSessionWork,
  setOwnerSessionResolver,
  useWorkLedgerStore,
} from '../src/state/work-ledger-store';

const P = 'panel-a';
/** 系统时间不真跑——起算反推与终态时刻都按它算。 */
const T0 = 1_700_000_000_000;

function shell(jobId: number, over: Partial<ShellSnapshot> = {}): ShellSnapshot {
  return { jobId, label: `echo ${jobId}`, agent: 'main-1-aaaa', elapsedSecs: 5, stalled: false, ...over };
}

const snap = (shells: ShellSnapshot[]) => JSON.stringify({ shells, browsers: [] });

/** 读面走 store 的同一个选择器（组件与测试同一把尺子）。 */
const view = (panelId: string, sessionId: number | null) =>
  selectSessionWork(useWorkLedgerStore.getState().entries, panelId, sessionId);
/** 在役在前、终态在后（册页的读序）。 */
const listOf = (panelId: string, sessionId: number | null) => {
  const v = view(panelId, sessionId);
  return [...v.running, ...v.settled];
};
const counts = (panelId: string, sessionId: number | null) => {
  const v = view(panelId, sessionId);
  return { running: v.running.length, elsewhere: v.others.length };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  kernelProcessCall.mockReset();
  resetWorkLedgerForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('役台账 · 子 Agent 记账', () => {
  it('spawn 落一条在役，带会话归属、父身份与描述', () => {
    useWorkLedgerStore.getState().noteSubAgentSpawn(P, 3, 'sub-1', 'main-1', '查一下依赖');
    const [e] = listOf(P, 3);
    expect(e).toMatchObject({
      id: 'sub-1',
      kind: 'subagent',
      label: '查一下依赖',
      state: 'running',
      sessionId: 3,
      parentAgentId: 'main-1',
      endedAt: null,
      startedAt: T0,
    });
  });

  it('finished 按 ok 分 done / failed，并记结束时刻', () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(P, 1, 'sub-ok', null, 'A');
    s.noteSubAgentSpawn(P, 1, 'sub-bad', null, 'B');
    vi.setSystemTime(T0 + 4000);
    s.noteSubAgentFinished(P, 'sub-ok', true);
    s.noteSubAgentFinished(P, 'sub-bad', false);
    const list = listOf(P, 1);
    const byId = new Map(list.map((e) => [e.id, e]));
    expect(byId.get('sub-ok')).toMatchObject({ state: 'done', endedAt: T0 + 4000 });
    expect(byId.get('sub-bad')).toMatchObject({ state: 'failed', note: '失败' });
  });

  it('未观察到的子 Agent 收尾是 no-op——不凭 finished 造条目', () => {
    useWorkLedgerStore.getState().noteSubAgentFinished(P, 'sub-never-seen', true);
    expect(listOf(P, 1)).toEqual([]);
  });

  it('重派同 id 不重铸起算时刻（身份即时间）', () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(P, 1, 'sub-1', null, '第一次');
    vi.setSystemTime(T0 + 9000);
    s.noteSubAgentSpawn(P, 1, 'sub-1', null, '第二次');
    const [e] = listOf(P, 1);
    expect(e.startedAt).toBe(T0);
    expect(e.label).toBe('第二次');
  });
});

describe('役台账 · shell 快照对账', () => {
  it('新 job 入在役：起算由 elapsedSecs 反推，停滞进旁注', () => {
    useWorkLedgerStore
      .getState()
      .noteShells(P, [shell(7, { label: 'cargo test', elapsedSecs: 12, stalled: true })], () => 2);
    const [e] = listOf(P, 2);
    expect(e).toMatchObject({
      id: 'job-7',
      kind: 'shell',
      label: 'cargo test',
      state: 'running',
      sessionId: 2,
      note: '停滞',
      startedAt: T0 - 12_000,
    });
  });

  it('连续对账不重算起算（截断误差不漂移）', () => {
    const s = useWorkLedgerStore.getState();
    s.noteShells(P, [shell(7, { elapsedSecs: 12 })], () => 2);
    vi.setSystemTime(T0 + 3000);
    // 同一 job：Rust 侧 elapsed 也涨了 3s，但起算必须钉住首次反推值
    useWorkLedgerStore.getState().noteShells(P, [shell(7, { elapsedSecs: 15 })], () => 2);
    const [e] = listOf(P, 2);
    expect(e.startedAt).toBe(T0 - 12_000);
    expect(e.state).toBe('running');
  });

  it('从在役集合消失 = 已结束：中性终态 + 如实标注，不编造成败', () => {
    const s = useWorkLedgerStore.getState();
    s.noteShells(P, [shell(7)], () => 2);
    vi.setSystemTime(T0 + 8000);
    useWorkLedgerStore.getState().noteShells(P, [], () => 2);
    const [e] = listOf(P, 2);
    expect(e).toMatchObject({ state: 'done', note: '已结束', endedAt: T0 + 8000 });
    expect(e.state).not.toBe('failed'); // 账本没有退出码，不许外推成失败
  });

  it('owner 解析不出会话：条目不丢，落归属未知档', () => {
    useWorkLedgerStore.getState().noteShells(P, [shell(9, { agent: null })], () => null);
    const unknown = listOf(P, null);
    expect(unknown.map((e) => e.id)).toEqual(['job-9']);
    // 不冒充任何一卷
    expect(listOf(P, 1)).toEqual([]);
  });
});

describe('役台账 · 切分与排序', () => {
  it('按面板隔离：别的面板的条目看不见', () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(P, 1, 'sub-a', null, 'A');
    s.noteSubAgentSpawn('panel-b', 1, 'sub-b', null, 'B');
    expect(listOf(P, 1).map((e) => e.id)).toEqual(['sub-a']);
    expect(listOf('panel-b', 1).map((e) => e.id)).toEqual(['sub-b']);
  });

  it('在役在前（按起算升序），终态在后（按结束倒序）', () => {
    const s = useWorkLedgerStore.getState();
    vi.setSystemTime(T0);
    s.noteSubAgentSpawn(P, 1, 'done-old', null, '旧');
    vi.setSystemTime(T0 + 1000);
    s.noteSubAgentSpawn(P, 1, 'done-new', null, '新');
    vi.setSystemTime(T0 + 2000);
    s.noteSubAgentFinished(P, 'done-old', true);
    vi.setSystemTime(T0 + 3000);
    s.noteSubAgentFinished(P, 'done-new', true);
    vi.setSystemTime(T0 + 4000);
    s.noteSubAgentSpawn(P, 1, 'run-late', null, '在役晚');
    vi.setSystemTime(T0 + 5000);
    s.noteSubAgentSpawn(P, 1, 'run-early', null, '在役早');

    const list = listOf(P, 1).map((e) => e.id);
    // 在役升序：run-early(5000) 起算晚于 run-late(4000) ⇒ run-late 在前
    expect(list).toEqual(['run-late', 'run-early', 'done-new', 'done-old']);
  });

  it('读面分开报「本卷在役」与「他卷在役」', () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(P, 1, 'sub-mine', null, 'A');
    s.noteSubAgentSpawn(P, 2, 'sub-other', null, 'B');
    s.noteShells(P, [shell(7)], () => 1);
    s.noteSubAgentSpawn(P, 3, 'sub-done', null, 'C');
    s.noteSubAgentFinished(P, 'sub-done', true);
    expect(counts(P, 1)).toEqual({ running: 2, elsewhere: 1 });
  });

  it('clearPanel 只清本面板，别面板条目留存', () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(P, 1, 'sub-a', null, 'A');
    s.noteSubAgentSpawn('panel-b', 1, 'sub-b', null, 'B');
    useWorkLedgerStore.getState().clearPanel(P);
    expect(listOf(P, 1)).toEqual([]);
    expect(listOf('panel-b', 1)).toHaveLength(1);
  });

  it('终态配额淘汰只吃终态，在役永不淘汰', () => {
    const s = useWorkLedgerStore.getState();
    for (let i = 0; i < 45; i++) {
      s.noteSubAgentSpawn(P, 1, `sub-${i}`, null, `T${i}`);
      s.noteSubAgentFinished(P, `sub-${i}`, true);
    }
    s.noteSubAgentSpawn(P, 1, 'sub-live', null, '在役');
    const list = listOf(P, 1);
    expect(list.filter((e) => e.state === 'running').map((e) => e.id)).toEqual(['sub-live']);
    // 40 = MAX_TERMINAL：被淘汰的是最旧的终态（sub-0..sub-4）
    expect(list.filter((e) => e.state !== 'running')).toHaveLength(40);
    expect(list.some((e) => e.id === 'sub-0')).toBe(false);
    expect(list.some((e) => e.id === 'sub-44')).toBe(true);
  });
});

describe('役台账 · 只读对账（pullShellWork / killShellWork）', () => {
  it('成功：写条目并清错；归属经注入的解析器', async () => {
    setOwnerSessionResolver(P, (owner) => (owner === 'main-1-aaaa' ? 5 : null));
    kernelProcessCall.mockResolvedValueOnce(snap([shell(1)]));
    await pullShellWork(P);
    expect(useWorkLedgerStore.getState().error[P] ?? null).toBeNull();
    expect(listOf(P, 5).map((e) => e.id)).toEqual(['job-1']);
  });

  it('**只读纪律**：对账绝不碰 bash_output（共享增量游标 + 读到终态即删账）', async () => {
    kernelProcessCall.mockResolvedValue(snap([]));
    await pullShellWork(P);
    await pullShellWork(P);
    expect(kernelProcessCall).toHaveBeenCalledTimes(2);
    for (const call of kernelProcessCall.mock.calls) {
      expect(call[0]).toBe('background_activity');
    }
  });

  it('返回体形状坏：错误可见（写 error），不抛给调用方', async () => {
    kernelProcessCall.mockResolvedValueOnce('not json at all');
    await expect(pullShellWork(P)).resolves.toBeUndefined();
    expect(useWorkLedgerStore.getState().error[P]).toBeTruthy();
  });

  it('缺 shells 数组：按契约破坏报错，不静默当空表', async () => {
    kernelProcessCall.mockResolvedValueOnce(JSON.stringify({ browsers: [] }));
    await pullShellWork(P);
    expect(useWorkLedgerStore.getState().error[P]).toContain('shells');
  });

  it('传输层抛错：写 error（宪法四：失败不静默）', async () => {
    kernelProcessCall.mockRejectedValueOnce(new Error('bridge down'));
    await pullShellWork(P);
    expect(useWorkLedgerStore.getState().error[P]).toBe('bridge down');
  });

  it('错误是每面板的：A 面板失败不动 B 面板', async () => {
    kernelProcessCall.mockRejectedValueOnce(new Error('boom'));
    await pullShellWork(P);
    expect(useWorkLedgerStore.getState().error[P]).toBe('boom');
    expect(useWorkLedgerStore.getState().error['panel-b'] ?? null).toBeNull();
  });

  it('killShellWork：走 bash_kill（不带 owner ⇒ 用户路径，可停任何 job），随后立刻对账', async () => {
    kernelProcessCall.mockResolvedValueOnce('killed').mockResolvedValueOnce(snap([]));
    await killShellWork(P, 42);
    expect(kernelProcessCall.mock.calls[0][0]).toBe('bash_kill');
    expect(kernelProcessCall.mock.calls[0][1]).toMatchObject({ job_id: 42 });
    // 关键：**不**注入 _owner_id —— 那会把 UI 降级成某个 Agent，反倒杀不动别人的 job
    expect(kernelProcessCall.mock.calls[0][1]).not.toHaveProperty('_owner_id');
    expect(kernelProcessCall.mock.calls[1][0]).toBe('background_activity');
  });

  it('killShellWork 失败：走提示条（不占册页 error 槽——那是「账本读不出」的位），仍对账一次', async () => {
    kernelProcessCall.mockRejectedValueOnce(new Error('no such job')).mockResolvedValueOnce(snap([]));
    await killShellWork(P, 42);
    expect(useWorkLedgerStore.getState().error[P] ?? null).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('no such job'), 'warn', expect.any(Number));
    expect(kernelProcessCall).toHaveBeenCalledTimes(2);
  });
});
