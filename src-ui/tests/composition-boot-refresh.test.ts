// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// composition-store 引导期新鲜度守护（2026-08-24 工作区归属根治——真根因
// 「Agent 装配失败 — ToolRegistry: cannot alias unknown tool
// "read_file_content"」的回归钉）。
//
// 洞的机制（①b builtin 行表退役后引入）：composition-store 初始 resolved
// 在模块加载期快照（彼时 loadBuiltinPlugins 未跑、tools 通道为空 → tools 域
// = 空表）；第一方工具贡献注册早于 bootShell 的贡献监听武装（事件不倒放）；
// 「无用户 patch（404 不动 store）+ standard preset（空 patch 跳过）」路径下
// store 永持空表 → buildToolRegistry 空行表 → fs 族缺席 → alias 抛错。
//
// 修复：bootShell 在 armContributionsWatcher 后无条件 reapplyComposition()
// ——本测试行为级复现该序并钉住修复语义；另以静态钉守住 boot.ts 的调用序。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { reapplyComposition } from '../src/composition/preset-assembly';
import { useCompositionStore } from '../src/state/composition-store';

// 模块加载期捕获初始快照——与生产 main.ts 的静态 import 阶段等价
//（本文件 import composition-store 时无任何服务装载）。
const initialResolved = useCompositionStore.getState().resolved;

describe('composition-store 引导期新鲜度（①b boot 序洞）', () => {
  it('洞复现：模块加载期快照 tools 为空（通道未装载）', () => {
    expect(initialResolved.tools).toHaveLength(0);
  });

  it('修复：贡献装载后（监听武装时点的序）reapplyComposition 把含 fs 族的行表回写 store', async () => {
    await withFirstPartyToolChannel(async () => {
      // 洞的行为复现：贡献注册本身不触发 store 刷新（生产 boot 序里监听
      // 武装晚于注册——事件不倒放）；store 仍持模块加载期的空表快照。
      expect(useCompositionStore.getState().resolved).toBe(initialResolved);
      expect(useCompositionStore.getState().resolved.tools).toHaveLength(0);

      // 修复入口（bootShell 在 armContributionsWatcher 后的无条件调用）
      reapplyComposition();

      const tools = useCompositionStore.getState().resolved.tools;
      // fs 族的 read_file_content 行在场——alias('read_file','read_file_content')
      // 的前提（真机报错的直接对治）
      expect(tools.some((r) => r.id === 'plugin/hologram/fs-domain/read_file_content')).toBe(true);
      // 全量第一方十四族行都在（防只回写局部的退化）
      expect(tools.some((r) => r.id === 'plugin/hologram/git-domain/git_status')).toBe(true);
      expect(tools.some((r) => r.id === 'plugin/hologram/search-domain/search_content')).toBe(true);
      expect(tools.length).toBeGreaterThan(20);
      // 修复后快照与初始空表不再是同一引用
      expect(useCompositionStore.getState().resolved).not.toBe(initialResolved);
    });
  });

  it('静态钉：bootShell 在贡献监听武装后无条件重应用（调用序不可倒置）', () => {
    const src = readFileSync(resolve(__dirname, '../src/shell/boot.ts'), 'utf8');
    const arm = src.indexOf('armContributionsWatcher();');
    const reapply = src.indexOf('reapplyComposition();');
    expect(arm).toBeGreaterThan(-1);
    expect(reapply).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(reapply);
  });
});
