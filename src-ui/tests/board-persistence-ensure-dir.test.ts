// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1-22 回归：BoardPersistence._ensureDir 失败不得假成功。
// 修复前：catch 把一切错误当「已存在」→ _dirReady=true 永久锁存
// → board 永不落盘、永不再试、零信号，重启全丢。
// （后端 create_dir_all 本就幂等，「已存在」不会抛错，catch 到的全是真实失败。）
// 修复后：失败不置位（下次 flush 重试）+ warn 信号（每段连续失败一次）。

// fs 域收口（2026-09-04）：BoardPersistence 持久化经 kernelCreateDirectory/
// kernelWriteFile（rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站到
// helper 层（不再拦 bridge + legacyRpcShim 翻信封）。create_directory 失败
// 注入走共享内存 fs 的 fail.createDir / fail.write；调用侧断言用 fs.writes
// （写调用记录）计数。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { BoardPersistence } from '../src/agent/board-persistence';

function makeBoard(): BoardPersistence {
  return new BoardPersistence({ projectPath: '/fake/project', sessionId: 's1', dirName: 'taskboard' });
}

describe('P1-22: BoardPersistence._ensureDir 假成功', () => {
  beforeEach(() => {
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
  });

  it('create_directory 失败不锁存 _dirReady，下次 flush 重试', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    H.kernelFs!.fs.fail.createDir = '磁盘只读';

    const bp = makeBoard();
    await bp.flush('{"v":1}');
    // 第一次失败：create_directory 抛错（未落盘——flush catch），有 warn
    expect(H.kernelFs!.fs.writes.length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    // 恢复后第二次 flush：必须重试 create_directory（修复前因 _dirReady 锁存而直接写文件）
    H.kernelFs!.fs.fail.createDir = undefined;
    await bp.flush('{"v":2}');
    expect(H.kernelFs!.fs.writes.length).toBe(1);
    warn.mockRestore();
  });

  it('连续失败只 warn 一次，成功落盘后复位', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    H.kernelFs!.fs.fail.createDir = 'IO 错误';
    H.kernelFs!.fs.fail.write = 'IO 错误';

    const bp = makeBoard();
    await bp.flush('a');
    await bp.flush('b');
    expect(warn).toHaveBeenCalledTimes(1);

    // 成功落盘后复位 warn 计数
    H.kernelFs!.fs.fail.createDir = undefined;
    H.kernelFs!.fs.fail.write = undefined;
    await bp.flush('c');
    expect(H.kernelFs!.fs.writes.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1); // 成功不 warn

    // 再次失败：复位后应重新 warn
    H.kernelFs!.fs.fail.createDir = 'IO 错误';
    H.kernelFs!.fs.fail.write = 'IO 错误';
    await bp.flush('d');
    expect(H.kernelFs!.fs.writes.length).toBe(1); // 仍失败，无新写
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
