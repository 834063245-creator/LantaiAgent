// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 2 测试 → workspace-session-ownership-rework（2026-08-27）重写：
// 会话**物理归属工作区**——scanMaxSessionId 扫 `{projectPath}/.lantai/sessions`
// 单一存储位。零目录路由（ensureUserSessionsDir / '' 用户级目录兜底）已退役。

// fs 域收口（2026-09-04）：scanMaxSessionId 经 kernelListDirectory（rpc-contract
// 具名 helper，内部直呼 fs_cap）读盘——mock 站到 helper 层（不再拦 bridge +
// legacyDispatchShim 翻信封）。路由正确性由行为断言承载：扫错目录 → 读空 →
// max 0 → 红。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { scanMaxSessionId } from '../src/ui/chat-session';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 会话持久化 seam 装配（seam 接线 C 批 3）：scanMaxSessionId 已换轨
// sessionExecute——builtin provider 需在册（走 kernel-fs mock 内存盘）。
await ensureProductionChannelsBooted();

describe('工作区会话根路由（workspace-session-ownership-rework）', () => {
  beforeEach(() => {
    H.kernelFs!.fs.files.clear();
    H.kernelFs!.fs.dirs.clear();
    H.kernelFs!.fs.writes.length = 0;
    H.kernelFs!.fs.fail = {};
  });

  it('scanMaxSessionId(projectPath) 扫 {projectPath}/.lantai/sessions（单一路径）', async () => {
    // 预置两卷在工作区会话根——若扫错目录（旧全局位 / 用户级目录）则读空 → 0
    H.kernelFs!.fs.setFile('D:/proj/.lantai/sessions/1.ndjson', '{}');
    H.kernelFs!.fs.setFile('D:/proj/.lantai/sessions/2.ndjson', '{}');
    const max = await scanMaxSessionId('D:/proj');
    expect(max).toBe(2);
  });

  it('目录缺席 / 读失败 → 0（首启常态，不抛）', async () => {
    // 目录缺席：无预置文件 → list 空
    expect(await scanMaxSessionId('D:/proj')).toBe(0);
    // 读失败（list 抛错）：scanMaxSessionId 自身 catch → 0
    H.kernelFs!.fs.fail.list = 'no dir';
    expect(await scanMaxSessionId('D:/proj')).toBe(0);
    H.kernelFs!.fs.fail.list = undefined;
  });
});
