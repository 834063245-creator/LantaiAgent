// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// composition-store 引导期新鲜度守护（2026-08-24 工作区归属根治——真根因
// 「Agent 装配失败 — ToolRegistry: cannot alias unknown tool
// "read_file_content"」的回归钉）。
//
// 洞的机制（①b builtin 行表退役后引入）：composition-store 初始 resolved
// 在模块加载期快照（彼时 loadBuiltinPlugins 未跑、全部通道为空）——毒害的是
// 同一份快照的全部三个组合域：tools（装配炸 alias）/ prompt（系统提示词
// 空）/ capabilities（会话能力空）。alias 报错只是第一根绊线。
// 第一方贡献注册早于 bootShell 贡献监听武装（事件不倒放）；「无用户 patch
// （404 不动 store）+ standard preset（空 patch 跳过）」路径下 store 永持
// 空表。
//
// 修复：bootShell 在 armContributionsWatcher 后无条件 reapplyComposition()
// ——三域一并刷新（resetToFactory 重快照整份 factoryComposition）。本测试
// 以「三域镜像装载」（compositionServices + 三清单，= loadBuiltinPlugins 的
// 第一方子集）忠实复现生产序并钉住三域全刷新语义。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesServicePlugin } from '../src/composition/capability-service';
import { firstPartyCapabilityPlugins } from '../src/composition/first-party-capabilities';
import { firstPartyPromptPlugins } from '../src/composition/first-party-prompts';
import { firstPartyToolPlugins } from '../src/composition/first-party-tools';
import { reapplyComposition } from '../src/composition/preset-assembly';
import { promptsServicePlugin } from '../src/composition/prompt-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { useCompositionStore } from '../src/state/composition-store';

// 模块加载期捕获初始快照——与生产 main.ts 的静态 import 阶段等价
//（本文件 import composition-store 时无任何服务装载）。
const initialResolved = useCompositionStore.getState().resolved;

describe('composition-store 引导期新鲜度（①b boot 序洞）', () => {
  it('洞复现：模块加载期快照三域全空（通道未装载）', () => {
    expect(initialResolved.tools).toHaveLength(0);
    expect(initialResolved.prompt).toHaveLength(0);
    expect(initialResolved.capabilities).toHaveLength(0);
  });

  it('修复：三域装载后（监听武装时点的序）reapplyComposition 一次刷新 tools/prompt/capabilities', async () => {
    // 三域镜像装载 = loadBuiltinPlugins 的第一方子集（三 service 先装——
    // 清单插件的 inject 依赖可解析；paper/settings/codeRuntime/hooks 不贡献
    // 这三个域，子集即忠实镜像）。
    const root = new Context();
    const fibers = [
      await root.plugin(compositionServicesPlugin),
      await root.plugin(promptsServicePlugin),
      await root.plugin(capabilitiesServicePlugin),
    ];
    for (const plugin of [...firstPartyToolPlugins(), ...firstPartyPromptPlugins(), ...firstPartyCapabilityPlugins()]) {
      fibers.push(await root.plugin(plugin));
    }
    try {
      // 洞的行为复现：贡献注册本身不触发 store 刷新（生产 boot 序里监听
      // 武装晚于注册——事件不倒放）；store 仍持模块加载期的空表快照。
      expect(useCompositionStore.getState().resolved).toBe(initialResolved);
      expect(useCompositionStore.getState().resolved.tools).toHaveLength(0);

      // 修复入口（bootShell 在 armContributionsWatcher 后的无条件调用）
      reapplyComposition();

      const { tools, prompt, capabilities } = useCompositionStore.getState().resolved;
      // tools 域：fs 族 read_file_content 行在场——alias('read_file','read_file_content')
      // 的前提（真机报错的直接对治）；git/search 抽查防只回写局部
      expect(tools.some((r) => r.id === 'plugin/hologram/fs-domain/read_file_content')).toBe(true);
      expect(tools.some((r) => r.id === 'plugin/hologram/git-domain/git_status')).toBe(true);
      expect(tools.some((r) => r.id === 'plugin/hologram/search-domain/search_content')).toBe(true);
      expect(tools.length).toBeGreaterThan(20);
      // prompt 域：9 第一方段全量（空提示词是同一快照的第二处毒害）
      expect(prompt.map((s) => s.id)).toContain('identity-brief');
      expect(prompt.map((s) => s.id)).toContain('identity');
      expect(prompt).toHaveLength(9);
      // capabilities 域：15 第一方能力全量（第三处毒害）
      expect(capabilities.map((c) => c.key)).toContain('plan-tools');
      expect(capabilities.map((c) => c.key)).toContain('spawn-tool');
      expect(capabilities).toHaveLength(15);
      // 修复后快照与初始空表不再是同一引用
      expect(useCompositionStore.getState().resolved).not.toBe(initialResolved);
    } finally {
      for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
    }
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
