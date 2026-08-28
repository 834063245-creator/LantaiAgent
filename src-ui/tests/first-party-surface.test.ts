// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 平台化 Phase 5 守卫：
//   P5-C1（出厂面零硬编码）：任何内置实现必须是某 seam 的默认 provider /
//   某通道的贡献，可被配置替换——本测试逐面证明可替换路径存在：
//     - 工具域：每个 DOMAIN_SPEC 的域工具都来自 ctx.tools 第一方插件通道
//       （无装配期硬编码——withFirstPartyToolChannel 复现生产装配）；
//     - seam 默认 provider：llm 2 adapter / fs / shell / sessionPersistence /
//       graph / subagents 全有注册；agentLoop 默认已登记；
//     - 动态插件运行时已装配（cordis 工具面存在）。
//   P5-C2（扩展方不 import loop 内部）：扫描 src 里 import agent-loop 包
//   的位置——只允许 Agent（消费者宿主）、runtime 装配器、loader 表与包自身。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAgentLoop } from '../src/agent/agent-loop/agent-loop-service';
import { activeDynamicRunner } from '../src/agent/dynamic-runner/dynamic-runner-service';
import { DOMAIN_SPECS } from '../src/agent/tools/domains';
import { activeFsProviders } from '../src/composition/fs-service';
import { activeGraphProviders } from '../src/composition/graph-service';
import { activeLlmAdapters } from '../src/composition/services';
import { activeSessionPersistenceProviders } from '../src/composition/session-persistence-service';
import { activeShellProviders } from '../src/composition/shell-service';
import { activeSubagentProviders } from '../src/composition/subagent-service';
import { buildStandardRegistry } from './convergence/helpers/fixtures';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

describe('P5-C1 出厂面零硬编码守卫', () => {
  it('工具域：全部 DOMAIN_SPEC 域工具经 ctx.tools 第一方通道贡献（标准装配面）', async () => {
    const registry = await buildStandardRegistry();
    for (const spec of DOMAIN_SPECS) {
      // 条件族（memory/skill/agent 缺装配依赖）缺帐时域工具合法缺席——
      // 判定：声明动作的旧工具任一在册 ⇒ 域工具必须折叠可见。
      const anyPresent = Object.values(spec.actions).some((n) => registry.get(n) !== undefined);
      if (!anyPresent) continue;
      const domainTool = registry.get(spec.name);
      expect(domainTool, `域工具 ${spec.name} 应经通道贡献后折叠可见（有 ${spec.name} 旧工具在册）`).toBeDefined();
      // 域内折叠动作 = 注册表现存旧工具的子集（条件注册族如 git_blame 缺席时
      // 动作不折叠——不是硬编码面）；断言折叠面非空且 ⊆ 声明面
      const folded = domainTool!.actions?.() ?? [];
      expect(folded.length, `域 ${spec.name} 至少有一个折叠动作`).toBeGreaterThan(0);
      for (const action of folded) {
        expect(spec.actions[action], `域 ${spec.name} 折叠动作 ${action} 应在 DOMAIN_SPECS 声明`).toBeDefined();
      }
    }
    // cordis 域（D7 动态插件面）同样在面内
    expect(registry.get('cordis')).toBeDefined();
  });

  it('seam 默认 provider 全注册（llm 2 adapter / fs / shell / sessions / graph / subagents）', async () => {
    await ensureProductionChannelsBooted();
    expect(activeLlmAdapters().map((a) => a.id)).toContain('builtin/anthropic');
    expect(activeLlmAdapters().map((a) => a.id)).toContain('builtin/openai');
    expect(activeFsProviders().map((p) => p.id)).toContain('builtin/rust-fs');
    expect(activeShellProviders().map((p) => p.id)).toContain('builtin/rust-shell');
    expect(activeSessionPersistenceProviders().map((p) => p.id)).toContain('builtin/rust-sessions');
    expect(activeGraphProviders().map((p) => p.id)).toContain('builtin/rust-graph');
    expect(activeSubagentProviders().map((p) => p.id)).toContain('builtin/in-process');
    // 动态插件运行时（D7）与 agent loop（D13）出厂面在册
    expect(activeDynamicRunner()).not.toBeNull();
    expect(resolveAgentLoop().id).toBe('builtin/default');
  });
});

describe('P5-C2 扩展方不 import agent-loop 内部实现（grep 归零）', () => {
  it('import agent-loop 包的消费面只允许：Agent / runtime 装配 / loader / 包自身', () => {
    const allowed = new Set([
      path.join(SRC, 'agent', 'agent.ts'),
      path.join(SRC, 'agent', 'runtime', 'runtime.ts'),
      path.join(SRC, 'plugins', 'loader.ts'),
      path.join(SRC, 'agent', 'agent-loop'), // 包自身（目录内互相 import）
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/(\.ts|\.tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
          const text = readFileSync(full, 'utf8');
          if (/from ['"]\.?\.?\/?agent\/agent-loop\//.test(text)) {
            const isAllowed = [...allowed].some((a) => full.startsWith(a));
            if (!isAllowed) offenders.push(full);
          }
        }
      }
    };
    walk(SRC);
    expect(
      offenders,
      '扩展方不得 import agent-loop 包内部——loop 是 D13 可替换 seam，消费面只有 Agent 宿主 / 装配器 / loader' +
        '；见 docs/agents/open-surface-contract.md v3',
    ).toEqual([]);
  });
});
