// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ctx.dynamicRunner 守护（平台化 Phase 4 · D7，2026-08-27）：
//   ① 求值面阴影：插件源码内 window/fetch/document/eval/Function 全 undefined
//   ② define 校验：语法错误 / 源码超预算 / name·purpose 形状 → 显式拒绝
//   ③ define → run（审批放行）→ 贡献可见 → stop → 贡献回收（P4-C2 主链）
//   ④ 审批门（P4-C3）：无通道未授权 = APPROVAL_REQUIRED；拒绝 = APPROVAL_DENIED
//   ⑤ 守卫注册面：def 缺 id / 非法属性访问 / 写 ctx → 响亮拒绝且零残留
//   ⑥ apply 超时：fiber 回收 + budget 取消（超时后 register 拒绝）
//   ⑦ 跨会话隔离：B 会话看不见/动不了 A 的插件
//   ⑧ update 失败回滚：旧包重挂，currentPackageId 回退

import { afterEach, describe, expect, it } from 'vitest';
import {
  DynamicRunnerService,
  dynamicRunnerPlugin,
  resetDynamicRunnerForTests,
} from '../src/agent/dynamic-runner/dynamic-runner-service';
import { DYNAMIC_APPLY_TIMEOUT_MS } from '../src/agent/dynamic-runner/sandbox';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';

afterEach(() => {
  resetDynamicRunnerForTests();
});

async function booted(): Promise<{ runner: DynamicRunnerService; dispose: () => Promise<void> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await root.plugin(dynamicRunnerPlugin);
  const runner = (root as unknown as { dynamicRunner: DynamicRunnerService }).dynamicRunner;
  expect(runner).toBeInstanceOf(DynamicRunnerService);
  return { runner, dispose: () => root.fiber.dispose() };
}

const TOOL_PLUGIN = (id: string): string =>
  `return { name: 'p', apply(ctx) { ctx.tools.register({ id: ${JSON.stringify(id)}, factory: () => [] }); } };`;

describe('ctx.dynamicRunner（D7 动态插件运行时）', () => {
  it('① 求值面阴影：危险全局在插件源码内全为 undefined', async () => {
    const { runner, dispose } = await booted();
    // 探测通道 = 工具工厂回传（宿主唯一可达面——插件闭包无法逃逸）
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'shadow',
      name: 'shadow-probe',
      purpose: '验证阴影面',
      code: `return { name: 'shadow', apply(ctx) {
        ctx.tools.register({ id: 'dyn/shadow-probe', factory: () => ({
          name: () => 'shadow_probe',
          description: () => 'typeof 探针',
          parameters: () => ({ type: 'object', properties: {} }),
          readOnly: () => true,
          execute: () => JSON.stringify({
            fetch: typeof fetch,
            window: typeof window,
            document: typeof document,
            eval: typeof eval,
            Function: typeof Function,
            localStorage: typeof localStorage,
            require: typeof require,
            process: typeof process,
          }),
        }) }); } };`,
    });
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    const contrib = activeToolContributions().find((c) => c.id === 'dyn/shadow-probe');
    expect(contrib).toBeDefined();
    const tool = (await contrib!.factory()) as { execute: (args: Record<string, unknown>) => Promise<string> };
    const probe = JSON.parse(await tool.execute({})) as Record<string, string>;
    expect(probe).toEqual({
      fetch: 'undefined',
      window: 'undefined',
      document: 'undefined',
      eval: 'undefined',
      Function: 'undefined',
      localStorage: 'undefined',
      require: 'undefined',
      process: 'undefined',
    });
    await runner.undefine('s1', receipt.pluginId);
    await dispose();
  });

  it('② define 校验：语法错误 / 超预算 / 形状缺项显式拒绝（不执行）', async () => {
    const { runner } = await booted();
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'bad', name: 'x', purpose: 'y', code: 'return { apply: (' }),
    ).toThrow(/语法错误/);
    // 语法合法但形状不对的源码在 define 期放行（预检不执行工厂）——run 期求值拒绝
    const badShape = runner.define('s1', { kind: 'new', idPrefix: 'bad', name: 'x', purpose: 'y', code: 'return "x"' });
    await expect(runner.run('s1', badShape.pluginId, badShape.packageId, 'run', async () => true)).rejects.toThrow(
      /工厂必须返回对象/,
    );
    const big = 'const x = 1;' + 'x;'.repeat(200_000);
    expect(() => runner.define('s1', { kind: 'new', idPrefix: 'big', name: 'x', purpose: 'y', code: big })).toThrow(
      /超预算/,
    );
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'Toolongprefix', name: 'x', purpose: 'y', code: 'return {}' }),
    ).toThrow(/idPrefix/);
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'ok', name: '', purpose: 'y', code: 'return {}' }),
    ).toThrow(/name/);
  });

  it('③ define → run（审批放行）→ 贡献可见 → stop → 贡献回收（P4-C2 主链）', async () => {
    const { runner, dispose } = await booted();
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'tool',
      name: '工具插件',
      purpose: '注册一个工具贡献',
      code: TOOL_PLUGIN('dyn/tool-a'),
    });
    expect(receipt.pluginId).toMatch(/^dyn-tool-\d{4}$/);
    // 运行前贡献不存在
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    // 审批放行 → 贡献出现
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(true);
    expect(runner.listInspect('s1')[0]?.running).toBe(true);
    // 已授权 → 重启无需再次审批
    await runner.stop('s1', receipt.pluginId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run'); // 无审批回调——已授权缓存
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(true);
    // undefine → 贡献回收 + 记录删除
    await runner.undefine('s1', receipt.pluginId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    expect(runner.listInspect('s1')).toEqual([]);
    await dispose();
  });

  it('④ 审批门：无通道未授权 = APPROVAL_REQUIRED；拒绝 = APPROVAL_DENIED（P4-C3）', async () => {
    const { runner } = await booted();
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'gate',
      name: '审批门',
      purpose: '验证未授权不能运行',
      code: TOOL_PLUGIN('dyn/gate'),
    });
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run')).rejects.toThrow(/APPROVAL_REQUIRED/);
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(false);
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => false)).rejects.toThrow(
      /APPROVAL_DENIED/,
    );
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(false);
    // 批准后可运行
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(true);
  });

  it('⑤ 守卫注册面：def 缺 id / 非法属性访问 → 响亮拒绝且零残留', async () => {
    const { runner, dispose } = await booted();
    // def 缺 id → register 拒绝 → apply 失败 → fiber dispose
    const bad1 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '缺 id',
      purpose: '验证形状校验',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ factory: () => [] }); } };",
    });
    await expect(runner.run('s1', bad1.pluginId, bad1.packageId, 'run', async () => true)).rejects.toThrow(/缺合法 id/);
    expect(activeToolContributions().some((c) => c.id.startsWith('dyn/'))).toBe(false);
    // 非法属性访问（白名单外）→ 响亮拒绝
    const bad2 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '越权访问',
      purpose: '验证守卫面',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ id: 'dyn/ok', factory: () => [] }); void ctx.fetch; } };",
    });
    await expect(runner.run('s1', bad2.pluginId, bad2.packageId, 'run', async () => true)).rejects.toThrow(
      /非法访问 ctx\.fetch/,
    );
    // 零残留：失败 apply 里先注册成功的贡献也随 fiber dispose 回收
    expect(activeToolContributions().some((c) => c.id === 'dyn/ok')).toBe(false);
    // 写 ctx → 拒绝
    const bad3 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '写 ctx',
      purpose: '验证只读面',
      code: "return { name: 'p', apply(ctx) { ctx.tools = null; } };",
    });
    await expect(runner.run('s1', bad3.pluginId, bad3.packageId, 'run', async () => true)).rejects.toThrow(
      /不得写 ctx/,
    );
    await dispose();
  });

  it('⑥ apply 超时：fiber 回收 + 取消后 register 拒绝', async () => {
    const { runner, dispose } = await booted();
    runner.applyTimeoutMs = 60; // 测试注入小预算
    expect(DYNAMIC_APPLY_TIMEOUT_MS).toBeGreaterThan(1000); // 生产常量未被改动
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'slow',
      name: '慢 apply',
      purpose: '验证超时回收',
      code: "return { name: 'p', apply() { return new Promise(() => {}); } };",
    });
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true)).rejects.toThrow(
      /超预算/,
    );
    expect(runner.listInspect('s1')[0]?.running).toBe(false);
    expect(runner.inspectSelf('s1', receipt.pluginId, receipt.packageId)).toMatchObject({
      diagnostics: { status: 'failed', message: expect.stringContaining('超预算') },
    });
    await dispose();
  });

  it('⑦ 跨会话隔离：B 会话看不见 / 动不了 A 的插件', async () => {
    const { runner } = await booted();
    const receipt = runner.define('agentA', {
      kind: 'new',
      idPrefix: 'iso',
      name: 'A 的插件',
      purpose: '会话隔离',
      code: TOOL_PLUGIN('dyn/iso'),
    });
    expect(runner.listInspect('agentB')).toEqual([]);
    await expect(runner.run('agentB', receipt.pluginId, receipt.packageId, 'run')).rejects.toThrow(/非本会话所有/);
    await expect(runner.stop('agentB', receipt.pluginId)).rejects.toThrow(/非本会话所有/);
    expect(() => runner.inspectSelf('agentB', receipt.pluginId)).toThrow(/非本会话所有/);
    await runner.run('agentA', receipt.pluginId, receipt.packageId, 'run', async () => true);
    await runner.undefine('agentA', receipt.pluginId);
  });

  it('⑧ update 失败回滚：旧包重挂，currentPackageId 回退', async () => {
    const { runner, dispose } = await booted();
    const first = runner.define('s1', {
      kind: 'new',
      idPrefix: 'roll',
      name: 'v1',
      purpose: '稳定版',
      code: TOOL_PLUGIN('dyn/v1'),
    });
    await runner.run('s1', first.pluginId, first.packageId, 'run', async () => true);
    const second = runner.define('s1', {
      kind: 'existing',
      pluginId: first.pluginId,
      name: 'v2',
      purpose: '会失败的更新',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ id: 'dyn/v2', factory: () => [] }); throw new Error('boom'); } };",
    });
    await expect(runner.run('s1', first.pluginId, second.packageId, 'update', async () => true)).rejects.toThrow(
      'boom',
    );
    // 回滚：current 回退到 v1；v1 贡献仍在；v2 贡献被回收
    const plugin = runner.inspectSelf('s1', first.pluginId) as { currentPackageId?: string };
    expect(plugin.currentPackageId).toBe(first.packageId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/v1')).toBe(true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/v2')).toBe(false);
    await runner.undefine('s1', first.pluginId);
    await dispose();
  });
});
