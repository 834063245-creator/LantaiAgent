// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P6-C2 跨 seam 替换集成（平台化 Phase 6）——「换实现路径」的真实性证明：
//   llm adapter / fs provider / subagent provider 三 seam **同时**被假实现
//   替换，三消费面（createProvider / fsExecute / Agent.spawnSubAgent）零
//   消费面改动全部路由到假实现；逐个 dispose 回落出厂默认。
//   （单 seam 替换的细粒度钉子：provider-dialect ③ / fs-seam ④ /
//   subagent-seam ③ 已各自覆盖；本测试证明三 seam 正交共存不互相污染。）

import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import { resetAgentLoopForTests } from '../src/agent/agent-loop/agent-loop-active';
import { AgentContext } from '../src/agent/context';
import type { SubAgentSpawnHost } from '../src/agent/subagent-spawn';
import type { ToolExecutor, ToolRegistry } from '../src/agent/tool';
import type { FsProvider } from '../src/composition/fs-service';
import type { LlmAdapterContribution } from '../src/composition/services';
import type { SubagentProvider } from '../src/composition/subagent-service';
import { createFsTools } from '../src/plugins/builtin/fs-domain/fs-tools';
import { createProvider } from '../src/provider/index';
import type { Provider } from '../src/provider/types';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

afterEach(() => {
  resetAgentLoopForTests();
});

const stubExec: ToolExecutor = async () => 'stub';

function stubProvider(): Provider {
  return {
    name: () => 'cross-seam-model',
    model: () => 'cross-seam-model',
    stream: async function* () {
      /* 不产流 */
    },
  };
}

function stubRegistry(): ToolRegistry {
  return { get: () => undefined } as unknown as ToolRegistry;
}

describe('P6-C2 跨 seam 替换集成（llm + fs + subagents 同时换实现）', () => {
  it('三 seam 同时被假实现接管，消费面零改动；逐个回落出厂', async () => {
    const root = await ensureProductionChannelsBooted();

    // ── 三个假实现 ──
    const fakeLlm: LlmAdapterContribution = {
      id: 'test/cross-llm',
      kind: 'openai',
      create: () =>
        ({
          name: () => 'cross-llm',
          model: () => 'cross-llm',
          stream: async function* () {
            /* 探针 */
          },
        }) as Provider,
    };
    const fsCalls: string[] = [];
    const fakeFs: FsProvider = {
      id: 'test/cross-fs',
      execute: async (action) => {
        fsCalls.push(action);
        return '(cross-fs) ' + action;
      },
    };
    const fakeSubagents: SubagentProvider = {
      id: 'test/cross-subagents',
      spawn: async (_host: SubAgentSpawnHost, args: { description: string }) => ({
        text: `(cross-subagents) ${args.description}`,
      }),
    };

    // ── 同时注册（三 seam 正交）──
    const disposeLlm = root.llm.register(fakeLlm);
    const disposeFs = root.fs.register(fakeFs);
    const disposeSub = root.subagents.register(fakeSubagents);

    // ① llm：openai kind 路由到假 adapter
    const settings = { kind: 'openai', name: 'p', apiKey: 'k', baseUrl: 'http://a', model: 'm' };
    expect(createProvider(settings as never).name()).toBe('cross-llm');

    // ② fs：工具 execute 路由到假 fs（dispatch 腰零触碰）
    const readTool = createFsTools(stubExec).find((t) => t.name() === 'read_file_content')!;
    expect(await readTool.execute({ filePath: '/x' })).toBe('(cross-fs) read');

    // ③ subagents：Agent.spawnSubAgent 路由到假 provider
    const agent = new Agent(
      new AgentContext(
        { agentId: 'cross', parentId: null, subagentDepth: 0 },
        {
          provider: stubProvider(),
          tools: stubRegistry(),
          eventSink: () => {},
        },
      ),
      'test',
    );
    const out = await agent.spawnSubAgent('cross-seam-task', 'probe');
    expect(out.text).toBe('(cross-subagents) cross-seam-task');

    // ── 逐个回落出厂（后注册胜逆序消失）──
    disposeSub();
    disposeFs();
    disposeLlm();
    // fs 回落 builtin/rust-fs（dispatch 腰恢复——stubExec 即 Rust 腰替身）
    const back = await readTool.execute({ filePath: '/x' });
    expect(back).toBe('stub');
    expect(fsCalls).toEqual(['read']);
    // subagents 回落 in-process（注册表视图证明——后注册胜逆序消失）
    const { activeSubagentProviders } = await import('../src/composition/subagent-service');
    expect(activeSubagentProviders().map((p) => p.id)).toContain('builtin/in-process');
    expect(activeSubagentProviders().some((p) => p.id === 'test/cross-subagents')).toBe(false);
  });
});
