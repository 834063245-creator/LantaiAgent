// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-state — html 沙箱卡的用户交互状态表（2026-10-07 立项）。
//
// 判据只写用户操作序列（不写实现形状）：卡里输入 → 读回；两次输入不同字段 → 都在；
// 写超限 / 坏值 → 整笔拒绝且既有内容一个字不动；真删卷 → 内存与文件一起走；
// 落盘恢复 → 重启后值一致；恢复在途的用户输入 → 不被旧值覆盖且磁盘旧值的其它键不丢。
//
// 落盘经 BoardPersistence（kernel* 具名 helper）——mock 站到 helper 层
// （helpers/kernel-fs 的内存盘语义，见该文件头注）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import {
  type AssetStateKey,
  clearAssetStateForTests,
  flushAssetStateSession,
  getAssetState,
  listAssetStateSummary,
  listAssetStateSummaryForOwner,
  patchAssetState,
  removeAssetStateSession,
} from '../src/agent/asset-state';
import { clearOwnerSessionsForTest, registerOwnerContext, setOwnerSessionId } from '../src/agent/session-context';

const KEY: AssetStateKey = { projectPath: '/proj', sessionId: '7' };
const FILE = '/proj/.lantai/asset-state/7.json';

function disk(): Map<string, string> {
  const k = H.kernelFs;
  if (!k) throw new Error('kernelFs mock 未就绪（vi.mock 工厂未执行）');
  return k.fs.files;
}

/** 模拟一次应用重启：清空全部内存表（磁盘不动）。 */
function restart(): void {
  clearAssetStateForTests();
}

beforeEach(() => {
  restart();
  clearOwnerSessionsForTest();
  const k = H.kernelFs;
  if (!k) throw new Error('kernelFs mock 未就绪');
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
});

describe('asset-state — 卡里输入的东西，读得回来', () => {
  it('输入一个字段 → 读回同一份', () => {
    expect(patchAssetState(KEY, 'as_1', { memo: '今天的风很大' })).toEqual({ ok: true });
    expect(getAssetState(KEY, 'as_1')).toEqual({ memo: '今天的风很大' });
  });

  it('两次输入不同字段 → 两个字段都在（浅合并，不是覆盖）', () => {
    patchAssetState(KEY, 'as_1', { memo: 'a' });
    patchAssetState(KEY, 'as_1', { checked: ['买牛奶'] });
    expect(getAssetState(KEY, 'as_1')).toEqual({ memo: 'a', checked: ['买牛奶'] });
  });

  it('没动过的资产 → 读回 null（不造空对象假象）', () => {
    expect(getAssetState(KEY, 'as_none')).toBeNull();
  });
});

describe('asset-state — 拒绝必须带窗且不半写', () => {
  it('patch 不是对象 → 整笔拒绝', () => {
    const r = patchAssetState(KEY, 'as_1', 'nope' as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('对象');
  });

  it('值含函数 / undefined / 循环引用 → 拒绝，既有内容一个字不动', () => {
    patchAssetState(KEY, 'as_1', { keep: 1 });
    expect(patchAssetState(KEY, 'as_1', { bad: () => 1 }).ok).toBe(false);
    expect(patchAssetState(KEY, 'as_1', { bad: undefined }).ok).toBe(false);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(patchAssetState(KEY, 'as_1', { bad: cyc }).ok).toBe(false);
    expect(getAssetState(KEY, 'as_1')).toEqual({ keep: 1 });
  });

  it('合并后超过 64 KiB → 拒绝（既有内容不动，不回退成截断）', () => {
    patchAssetState(KEY, 'as_1', { keep: 'x' });
    const r = patchAssetState(KEY, 'as_1', { big: 'x'.repeat(70 * 1024) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('超限');
    expect(getAssetState(KEY, 'as_1')).toEqual({ keep: 'x' });
  });

  it('缺少会话定位（无工作区 / 无会话号）→ 拒绝读写', () => {
    expect(patchAssetState({ projectPath: '', sessionId: '7' }, 'as_1', { a: 1 }).ok).toBe(false);
    expect(getAssetState({ projectPath: '/proj', sessionId: '' }, 'as_1')).toBeNull();
  });
});

describe('asset-state — 落盘与恢复', () => {
  it('输入 → 落盘 → 重启 → 值一致', async () => {
    patchAssetState(KEY, 'as_1', { memo: 'a', n: 2 });
    await flushAssetStateSession(KEY);
    expect(disk().has(FILE)).toBe(true);

    restart();
    expect(getAssetState(KEY, 'as_1')).toBeNull(); // 恢复在途：先如实读到 null
    await flushAssetStateSession(KEY); // 等恢复落定
    expect(getAssetState(KEY, 'as_1')).toEqual({ memo: 'a', n: 2 });
  });

  it('恢复在途的用户输入不被旧值覆盖，磁盘旧值的其它键也不丢', async () => {
    patchAssetState(KEY, 'as_1', { a: 1, b: 2 });
    await flushAssetStateSession(KEY);

    restart();
    // 重启后立刻输入（此刻读盘恢复还没完成——写入发生在恢复前）
    expect(patchAssetState(KEY, 'as_1', { a: 9 })).toEqual({ ok: true });
    await flushAssetStateSession(KEY);
    expect(getAssetState(KEY, 'as_1')).toEqual({ a: 9, b: 2 });
  });

  it('恢复在途不落盘（不会把只有当帧输入的空表覆盖上去）', async () => {
    patchAssetState(KEY, 'as_1', { a: 1, b: 2 });
    await flushAssetStateSession(KEY);
    const before = disk().get(FILE);

    restart();
    patchAssetState(KEY, 'as_1', { a: 9 });
    // 此刻恢复尚未落定：磁盘内容保持原样（未被空表/半表覆盖）
    expect(disk().get(FILE)).toBe(before);

    await flushAssetStateSession(KEY);
    expect(JSON.parse(disk().get(FILE) ?? '{}')).toEqual({ as_1: { a: 9, b: 2 } });
  });
});

describe('asset-state — 真删卷：内存与文件一起走', () => {
  it('真删除 → 读不到、文件也没了；再写是干净的新表', async () => {
    patchAssetState(KEY, 'as_1', { memo: 'a' });
    await flushAssetStateSession(KEY);
    expect(disk().has(FILE)).toBe(true);

    await removeAssetStateSession('/proj', '7');
    expect(disk().has(FILE)).toBe(false);

    expect(getAssetState(KEY, 'as_1')).toBeNull();
    patchAssetState(KEY, 'as_1', { fresh: true });
    expect(getAssetState(KEY, 'as_1')).toEqual({ fresh: true });
  });
});

describe('asset-state — Agent 读口（规模 + 内容）', () => {
  it('读数 = 键数 + 字节数 + 内容本身；该资产出现且只有它', () => {
    patchAssetState(KEY, 'as_1', { a: 1, b: 'x' });
    const sum = listAssetStateSummary(KEY);
    expect(sum).toHaveLength(1);
    expect(sum[0]?.assetId).toBe('as_1');
    expect(sum[0]?.keys).toBe(2);
    expect(sum[0]?.bytes).toBeGreaterThan(0);
    expect(sum[0]?.state).toEqual({ a: 1, b: 'x' });
  });

  it('用户在卡里分两次留下的字段 → 两条内容一起读回（不只剩一个规模数）', () => {
    patchAssetState(KEY, 'as_1', { notes: 3 });
    patchAssetState(KEY, 'as_1', { last: 'B4' });
    expect(listAssetStateSummary(KEY)[0]?.state).toEqual({ notes: 3, last: 'B4' });
  });

  it('没碰过状态的资产不进读数（不造空条目）', () => {
    patchAssetState(KEY, 'as_1', { a: 1 });
    expect(listAssetStateSummary(KEY).map((s) => s.assetId)).toEqual(['as_1']);
  });

  it('重启后内容照样读得到——走落盘恢复，不靠内存', async () => {
    patchAssetState(KEY, 'as_1', { notes: 7, last: 'C5' });
    await flushAssetStateSession(KEY);

    restart();
    expect(getAssetState(KEY, 'as_1')).toBeNull(); // 恢复在途：先如实读到 null
    await flushAssetStateSession(KEY); // 等恢复落定
    expect(listAssetStateSummary(KEY)[0]?.state).toEqual({ notes: 7, last: 'C5' });
  });

  it('owner 解析：绑定了会话的 agent 读得到本会话读数（含内容）', () => {
    patchAssetState(KEY, 'as_1', { a: 1 });
    const dispose = registerOwnerContext('main-1', '/proj');
    setOwnerSessionId('main-1', '7');
    const rows = listAssetStateSummaryForOwner('main-1');
    expect(rows.map((s) => s.assetId)).toEqual(['as_1']);
    expect(rows[0]?.state).toEqual({ a: 1 });
    dispose();
  });

  it('解析不出会话的 owner → 空表（如实省略，不造假设）', () => {
    patchAssetState(KEY, 'as_1', { a: 1 });
    registerOwnerContext('main-2', '/proj'); // 有工作区、无会话绑定
    expect(listAssetStateSummaryForOwner('main-2')).toEqual([]);
    expect(listAssetStateSummaryForOwner(undefined)).toEqual([]);
  });
});
