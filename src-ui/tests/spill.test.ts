// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// spill — 大输出溢写：小内容原样、大内容落盘 + locator、失败退回截断不静默。

// fs 域收口（2026-09-04）：spillToFile 经 kernelCreateDirectory/kernelWriteFile
// （rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站到 helper 层（不再
// 拦 bridge + legacyRpcShim 翻信封）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { parseIsolationDiff, spillToFile } from '../src/agent/spill';

beforeEach(() => {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
});

describe('spillToFile', () => {
  it('passes small text through without writing', async () => {
    const out = await spillToFile({ projectPath: '/proj', name: 'x', text: 'short', maxInline: 100 });
    expect(out.spilled).toBe(false);
    expect(out.display).toBe('short');
    expect(H.kernelFs!.fs.writes.length).toBe(0);
  });

  it('writes large text to .lantai/spill and returns a locator + preview', async () => {
    const big = 'x'.repeat(5000);
    const out = await spillToFile({ projectPath: '/proj', name: 'd', text: big, maxInline: 100, extension: 'diff' });
    expect(out.spilled).toBe(true);
    expect(out.path).toContain('/proj/.lantai/spill/');
    expect(out.path).toMatch(/\.diff$/);
    expect(out.display).toContain('已溢写 5000 字符');
    expect(out.display).toContain('read_file 读取全量');
    // 全量内容必须无损落盘
    const written = H.kernelFs!.fs.files.get(out.path!);
    expect(written).toBe(big);
  });

  it('falls back to truncation with a failure marker when the write fails', async () => {
    H.kernelFs!.fs.fail.write = 'disk full';
    const out = await spillToFile({ projectPath: '/proj', name: 'd', text: 'x'.repeat(5000), maxInline: 100 });
    expect(out.spilled).toBe(false);
    expect(out.display).toContain('spill 溢写失败');
    expect(out.display).toContain('truncated');
  });
});

describe('parseIsolationDiff', () => {
  it('parses small-diff, no-change and spilled JSON payloads', () => {
    expect(parseIsolationDiff('{"has_changes":true,"diff":"+a"}')).toEqual({
      hasChanges: true,
      diff: '+a',
      spillPath: undefined,
    });
    expect(parseIsolationDiff('{"has_changes":false,"diff":""}')?.hasChanges).toBe(false);
    const spilled = parseIsolationDiff(
      '{"has_changes":true,"diff":"[diff 全量落盘] /p/x.diff","spill_path":"/p/x.diff"}',
    );
    expect(spilled?.spillPath).toBe('/p/x.diff');
  });

  it('returns null for non-JSON input', () => {
    expect(parseIsolationDiff('not json')).toBeNull();
  });
});
