// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// A-2 管道钩子贡献通道（composition/hook-service.ts）钉住面：
//   1. 注册语义：enrich/preflight 两类贡献、id 寻址、重名装载期拒绝、
//      disposer 幂等 + 陈旧性守卫；
//   2. 消费闭环：activeHookContributions()（无服务 = 空集）；
//   3. 装配折叠：runtime._assembleAgent 把贡献按 kind 注册进 per-Agent
//      registries——enrich 进 HookRegistry、preflight 进
//      PreflightHookRegistry；序 = capability 钩子先、贡献随后；
//   4. 生效时机：装配时点折叠（在途会话不动——新 Agent 拿最新清单）；
//   5. 端到端：贡献 hook 真实参与工具管道（StreamingToolExecutor 经
//      Agent 装配后的 preflight 检查 + enrich 富化）。
// 零漂移守护：无贡献环境（convergence 夹具/生产初态）折叠为空集，
// phase 快照不受影响（verify:convergence 双 preset 实测）。

import { describe, expect, it } from 'vitest';
import { activeHookContributions, type HookContribution, hooksServicePlugin } from '../src/composition/hook-service';
import { Context } from '../src/cordis';

/** 富化贡献（记录调用——enrich 在输出尾部追加标记）。 */
function enrichContribution(id: string, tag: string, log: string[]): HookContribution {
  return {
    id,
    kind: 'enrich',
    hook: {
      name: `${id}-enrich`,
      shouldEnrich: () => true,
      enrich: async (_n, _a, result) => {
        log.push(tag);
        return `${result}[${tag}]`;
      },
    },
  };
}

/** 预检贡献（命中 edit_file 返回警告）。 */
function preflightContribution(id: string, warning: string): HookContribution {
  return {
    id,
    kind: 'preflight',
    hook: {
      name: `${id}-preflight`,
      shouldCheck: (n) => n === 'edit_file',
      check: () => warning,
    },
  };
}

describe('composition/hook-service（A-2 管道钩子贡献通道）', () => {
  it('注册语义：两类贡献经 ctx.hooks 注册，activeHookContributions 保序读取', async () => {
    const root = new Context();
    const fiber = await root.plugin(hooksServicePlugin);
    expect(activeHookContributions()).toEqual([]); // 起点是空集
    const a = root.hooks.register(enrichContribution('acme/enrich', 'A', []));
    const b = root.hooks.register(preflightContribution('acme/preflight', '⚠️ W'));
    expect(activeHookContributions().map((c) => c.id)).toEqual(['acme/enrich', 'acme/preflight']);
    expect(activeHookContributions().map((c) => c.kind)).toEqual(['enrich', 'preflight']);
    a();
    b();
    expect(activeHookContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('重名 id 装载期拒绝（throw，不静默覆盖）', async () => {
    const root = new Context();
    const fiber = await root.plugin(hooksServicePlugin);
    root.hooks.register(enrichContribution('acme/dup', 'A', []));
    expect(() => root.hooks.register(enrichContribution('acme/dup', 'B', []))).toThrow(/duplicate contribution id/);
    await fiber.dispose();
  });

  it('disposer 幂等 + 陈旧性守卫（同 id 重注册后旧 disposer 不误删新行）', async () => {
    const root = new Context();
    const fiber = await root.plugin(hooksServicePlugin);
    const stale = root.hooks.register(enrichContribution('acme/slot', '旧', []));
    stale(); // 先注销，同 id 重注册才合法（重名是装载期拒绝）
    expect(activeHookContributions()).toEqual([]);
    const fresh = root.hooks.register(enrichContribution('acme/slot', '新', []));
    stale(); // 陈旧 disposer 二次调用不误删新行
    expect(activeHookContributions().map((c) => c.id)).toEqual(['acme/slot']);
    fresh();
    expect(activeHookContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('无服务环境：activeHookContributions = 空集（消费面零改写）', () => {
    // 新 Context（未挂 hooksServicePlugin）——模块级活动服务为 null
    // （上一个用例的 fiber dispose 后守卫式清空）
    expect(activeHookContributions()).toEqual([]);
  });

  it('装配折叠：runtime.createAgent 把贡献按 kind 注册进 per-Agent registries', async () => {
    // 超时预算 20s：用例内冷导入 runtime/tool/fixtures 模块图 + 两次完整
    // AgentRuntime 装配——全量套件并发下 5s 默认预算曾被打穿（2026-08-24
    // 全量实测 5023ms 假红，单跑亚秒）。预算吸收冷导入成本，逻辑面无慢操作。
    const root = new Context();
    const fiber = await root.plugin(hooksServicePlugin);
    const enrichLog: string[] = [];
    root.hooks.register(enrichContribution('acme/enrich', 'ACME', enrichLog));
    root.hooks.register(preflightContribution('acme/preflight', '⚠️ ACME 预检警告'));

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const { ToolRegistry } = await import('../src/agent/tool');
    const { scriptedProvider, readOnlyTool } = await import('./convergence/helpers/fixtures');
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存
    await rt.ready();
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    const handle = await rt.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools,
      eventSink: () => {},
    });
    // Agent 的 hooks 面是 private（setHooks 整体替换语义）——经运行时
    // 行为验证：preflight 贡献经 Agent 嵌套分发面（_codeDispatch 同源的
    // preflightHooks.check）不可直达；此处经 hooks.apply 富化链验证折叠：
    // enrich 贡献在 Agent 的 HookRegistry 上生效（运行时行为面）。
    const agentInner = (
      handle as unknown as {
        _getAgent(): {
          hooks: { apply: (n: string, a: Record<string, unknown>, r: string) => Promise<string> } | null;
        };
      }
    )._getAgent();
    // biome-ignore lint/style/noNonNullAssertion: 测试内已知贡献折叠后 hooks 必在册（与 ①c 测试同款钉面手法）
    const enriched = await agentInner.hooks!.apply('edit_file', { filePath: '/p/a.ts' }, '原始结果');
    expect(enriched).toContain('[ACME]'); // enrich 贡献参与富化链
    expect(enrichLog).toEqual(['ACME']);

    handle.dispose();
    await fiber.dispose();
    // 通道拆卸后新装配不再折叠（生效时机 = 装配时点快照）
    const rt2 = new AgentRuntime();
    await rt2.ready();
    const tools2 = new ToolRegistry();
    tools2.register(readOnlyTool());
    const handle2 = await rt2.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: tools2,
      eventSink: () => {},
    });
    const agent2Inner = (
      handle2 as unknown as {
        _getAgent(): { hooks: { apply: (n: string, a: Record<string, unknown>, r: string) => Promise<string> } | null };
      }
    )._getAgent();
    const enriched2 = await agent2Inner.hooks!.apply('edit_file', {}, '原始结果');
    expect(enriched2).toBe('原始结果'); // 无贡献 = 不富化
    handle2.dispose();
  }, 20_000);

  it('端到端：preflight 贡献警告进工具结果顶部（executor 管道真实消费）', async () => {
    const root = new Context();
    const fiber = await root.plugin(hooksServicePlugin);
    root.hooks.register({
      id: 'acme/high-gate',
      kind: 'preflight',
      hook: {
        name: 'acme-high-gate',
        shouldCheck: (n) => n === 'edit_file',
        check: () => '⚠️ [ACME] 风险等级: HIGH — 插件预检命中',
      },
    });

    const { StreamingToolExecutor } = await import('../src/agent/streaming-executor');
    const { ToolRegistry } = await import('../src/agent/tool');
    const { HookRegistry, PreflightHookRegistry } = await import('../src/agent/hooks');
    const { legacyEditTool } = await import('./convergence/helpers/fixtures');

    // 复刻 _assembleAgent 的折叠序：capability registries → 贡献按 kind 注册
    const hooks = new HookRegistry();
    const preflight = new PreflightHookRegistry();
    for (const c of activeHookContributions()) {
      if (c.kind === 'enrich') hooks.register(c.hook);
      else preflight.register(c.hook);
    }
    const tools = new ToolRegistry();
    tools.register(legacyEditTool());
    const sink = () => {};
    const executor = new StreamingToolExecutor(tools, sink, hooks, preflight);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{"filePath":"/p/a.ts"}' });
    const results = await executor.awaitRemaining();
    expect(results[0]?.output).toContain('⚠️ [ACME] 风险等级: HIGH');
    expect(results[0]?.output).toContain('🚫 架构门禁已阻止此操作'); // HIGH 语义沿用
    await fiber.dispose();
  });
});
