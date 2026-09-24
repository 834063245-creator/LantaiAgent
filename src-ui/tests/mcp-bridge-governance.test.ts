// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 受治进程治理（app shell 件 C · S2，app-shell-software-plugin-plan §5-S2）
// 钉住面（计划测试 a–e；f 兼容钉 = mcp-bridge.test.ts 既有旧形态套件零改动）：
//   a) spawn + 握手就绪成功 / 就绪超时两路径（就绪 = initialize 握手 +
//      tools/list 在时限内完成——到点判启动失败，免 stdout 探测）；
//   b) 崩溃重启策略生效（on-crash 退避自动重启；无 on-crash 不自动重启）；
//   c) 卸载回收（TS 侧 dispose 链杀进程；进程树完整性含子进程在 Rust
//      protocol_bridge cargo test 钉——Windows taskkill /T）；
//   d) 未就绪报错不阻塞 + lazy 首调报错时已触发拉起、重试可成（决策 7
//      fail-fast 钉死：service_not_ready 带 starting / not-running 状态）；
//   e) 三档启动策略各自回收出口（lazy 空闲回收 × 窗口闸 / eager 卸载回收 /
//      with-window 随窗开合——合成开合事件，S3 接真实窗口）；
//   附加：数据目录 spawn 注入（LANTAI_PLUGIN_DATA_DIR——S1 × S2 衔接）。
//
// ProcIO 注入 fake（行协议是真的；时序参数经 opts.timing 注入小值——生产
// 缺省 60s/5min 在单测不可等待）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import type { Tool } from '../src/agent/tool';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import type { BuiltinToolRow } from '../src/composition/tool-rows';
import { Context } from '../src/cordis';
import {
  type McpBridgeIO,
  type McpGovernorTiming,
  notifyPluginWindowClosed,
  notifyPluginWindowOpened,
  registerMcpServerTools,
  resetMcpGovernorForTests,
} from '../src/plugins/mcp-bridge';
import type { McpServerDecl } from '../src/plugins/types';

/** 数组取首项（断言前置——已断言长度/存在的取值面，免非空断言）。 */
function first<T>(list: T[]): T {
  if (list.length === 0) throw new Error('断言前置失败：期望非空数组');
  return list[0] as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（真实时钟 + 小步进——治理时序是真实 setTimeout）。 */
async function pollUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000, stepMs = 15): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return await cond();
}

/** 可控 fake 进程句柄：crash 模拟意外退出（不经 kill）；killed 标记意图杀。 */
interface FakeProcHandle {
  proc: ProcIO;
  crash(): void;
  killed: boolean;
}

interface SpawnRecord {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** 注入 IO：记录 spawn 参数（含 env）+ 返回受控 fake。
 *  silent = 不应答（就绪超时路径）；initializeDelayMs = 握手应答延迟
 *  （拉宽 starting 状态窗）。 */
function makeFakeIO(opts: { silent?: boolean; initializeDelayMs?: number } = {}): {
  io: McpBridgeIO;
  spawns: SpawnRecord[];
  procs: FakeProcHandle[];
} {
  const spawns: SpawnRecord[] = [];
  const procs: FakeProcHandle[] = [];
  const io: McpBridgeIO = {
    createProcIO: async (id, command, args, env) => {
      spawns.push({ id, command, args, env });
      const outCbs = new Set<(line: string) => void>();
      const exitCbs = new Set<(code: number | null) => void>();
      const handle: FakeProcHandle = {
        killed: false,
        crash: () => {
          for (const cb of exitCbs) cb(1);
        },
        proc: {
          writeLine: (line: string) => {
            if (opts.silent) return;
            const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
            if (msg.method === undefined || msg.id === undefined) return;
            const respond = (result: unknown) => {
              for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
            };
            if (msg.method === 'initialize') {
              const reply = () =>
                respond({
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'fake', version: '1.0.0' },
                });
              if (opts.initializeDelayMs) setTimeout(reply, opts.initializeDelayMs);
              else reply();
            } else if (msg.method === 'tools/list') {
              respond({
                tools: [
                  {
                    name: 'echo',
                    description: '回声工具',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                  },
                  { name: 'ping', description: '探活', inputSchema: { type: 'object', properties: {} } },
                ],
              });
            } else if (msg.method === 'tools/call') {
              const name = (msg.params?.name as string) ?? '';
              respond({ content: [{ type: 'text', text: `[${name}] ok` }], isError: false });
            } else {
              respond({});
            }
          },
          onStdoutLine: (cb) => {
            outCbs.add(cb);
            return () => {
              outCbs.delete(cb);
            };
          },
          onExit: (cb) => {
            exitCbs.add(cb);
            return () => {
              exitCbs.delete(cb);
            };
          },
          kill: () => {
            handle.killed = true;
            for (const cb of exitCbs) cb(0);
          },
        },
      };
      procs.push(handle);
      return handle.proc;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
  return { io, spawns, procs };
}

const STDIO_BASE: McpServerDecl = {
  name: 'my-engine',
  transport: 'stdio',
  command: './bin/engine',
  args: ['--serve'],
};

/** 治理时序（小值注入；生产缺省 60s/5min/1s）。 */
const TIMING: McpGovernorTiming = { startupDeadlineMs: 2000, idleTimeoutMs: 5000, restartBackoffMs: 40 };

/** 生产形态的受治装载：插件 fiber 内注册（loader 包装 apply 的同款）。 */
async function bootGoverned(
  servers: McpServerDecl[],
  io: McpBridgeIO,
  opts: { dataDirPath?: string; timing?: McpGovernorTiming } = {},
): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  const fiber = await root.plugin({
    name: 'acme/tools',
    inject: ['tools'],
    async apply(ctx) {
      await registerMcpServerTools(ctx, 'acme/tools', servers, io, opts);
    },
  });
  return { root, fiber };
}

/** 行 factory 到工具面非空（就绪 + 快照到位）。 */
async function factoryTools(): Promise<Tool[]> {
  const rows = pluginToolRows();
  const row: BuiltinToolRow = first(rows.filter((r) => r.id === 'plugin/acme/tools/mcp/my-engine'));
  const tools = await row.factory({} as never);
  return tools;
}

/** 轮询到就绪并取回工具面。 */
async function waitForTools(): Promise<Tool[]> {
  await pollUntil(async () => (await factoryTools()).length > 0);
  return await factoryTools();
}

async function cleanup(root: Context, fiber: Awaited<ReturnType<Context['plugin']>>): Promise<void> {
  await fiber.dispose();
  await root[Symbol.asyncDispose]?.();
}

describe('受治进程治理（S2）：a) 握手就绪 / 就绪超时', () => {
  beforeEach(() => {
    resetMcpGovernorForTests();
  });

  it('受治 lazy：装配期有界等待就绪，工具面**当场**可用（不再空集等下轮）', async () => {
    const { io, spawns } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, { timing: TIMING });
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/acme/tools/mcp/my-engine']);
    const row = first(rows);
    // 行为变更（2026-09-24）：装配期**有界等待**就绪后取工具面——工具面在装配时点
    // 冻结，旧语义「立即返回空集」在共享注册表路径上等于**永久**没有工具
    // （空集不缓存 = 下次装配重试，而那条路径没有下次装配）。见 ASSEMBLY_READY_WAIT_MS。
    const tools = await row.factory({} as never);
    expect(tools.map((t) => t.name())).toEqual(['mcp__my-engine__echo', 'mcp__my-engine__ping']);
    expect(spawns).toHaveLength(1); // 等待本身即拉起触发（不重复触发）
    const echo = first(tools);
    expect(await echo.execute({ text: 'hi' })).toBe('[echo] ok');
    await cleanup(root, fiber);
  });

  it('就绪超时：到点判启动失败（杀挂壁进程 + warn），无自动重拉；再装配再触发', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { io, spawns, procs } = makeFakeIO({ silent: true });
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, {
      timing: { startupDeadlineMs: 80, restartBackoffMs: 30 },
    });
    const row = first(pluginToolRows());
    await row.factory({} as never); // 触发拉起（装配期有界等待，失败不抛）
    await pollUntil(() => spawns.length === 1);
    // 到点判负：清场杀挂壁进程 + 拉起失败 warn（就绪超时）
    expect(await pollUntil(() => procs[0]?.killed === true, 1000)).toBe(true);
    // 行为变更（2026-09-24）：warn 由「装配期未就绪：<治理器原文>」一条承担
    // （此前是 ensureStarted 的 `拉起失败: <err>`）——断言改成看整行文本。
    expect(warnSpy.mock.calls.some((c) => c.map(String).join(' ').includes('就绪超时'))).toBe(true);
    // 启动失败 ≠ 崩溃：restart 不接管——无自动重拉
    await sleep(120);
    expect(spawns).toHaveLength(1);
    // 再装配再触发（lazy 兜底拉起）
    await row.factory({} as never);
    await pollUntil(() => spawns.length === 2);
    warnSpy.mockRestore();
    await cleanup(root, fiber);
  });
});

describe('受治进程治理（S2）：b) 崩溃重启策略（含退避）', () => {
  beforeEach(() => {
    resetMcpGovernorForTests();
  });

  it('on-crash：意外退出 → 退避后自动重启，就绪后工具恢复', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy', restart: 'on-crash' }], io, {
      timing: TIMING,
    });
    const tools = await waitForTools();
    expect(spawns).toHaveLength(1);
    const echo = first(tools);
    expect(await echo.execute({ text: 'a' })).toBe('[echo] ok');
    // 崩溃（进程自己退出——非意图 kill）
    procs[0].crash();
    // 退避中：不立即重拉
    await sleep(15);
    expect(spawns).toHaveLength(1);
    // 退避到点自动重启
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    // 重启后就绪 + 同一工具实例可再执行（调用期现取 client——旧实例不滞留死连接）
    expect(
      await pollUntil(async () => {
        try {
          await echo.execute({ text: 'b' });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(await echo.execute({ text: 'b' })).toBe('[echo] ok');
    expect(procs[0].killed).toBe(false); // 崩溃进程非意图杀
    await cleanup(root, fiber);
  });

  it('无 on-crash（restart 缺省 off）：崩溃不自动重启——下次调用兜底拉起', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, { timing: TIMING });
    const tools = await waitForTools();
    const echo = first(tools);
    procs[0].crash();
    await sleep(120);
    expect(spawns).toHaveLength(1); // 无自动重启
    // 调用 → service_not_ready + 已触发拉起（决策 7）
    await expect(echo.execute({ text: 'x' })).rejects.toThrow('service_not_ready');
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    expect(
      await pollUntil(async () => {
        try {
          await echo.execute({ text: 'x' });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    await cleanup(root, fiber);
  });
});

describe('受治进程治理（S2）：c) 卸载回收 + d) fail-fast 未就绪语义（决策 7）', () => {
  beforeEach(() => {
    resetMcpGovernorForTests();
  });

  it('空闲回收后调用：立即报 service_not_ready(not-running) + 已触发拉起，重试可成', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, {
      timing: { startupDeadlineMs: 2000, idleTimeoutMs: 70, restartBackoffMs: 500 },
    });
    const tools = await waitForTools();
    const echo = first(tools);
    expect(await echo.execute({ text: 'a' })).toBe('[echo] ok');
    // lazy 空闲回收：无窗 + 超时无调用即停（回收出口之一）
    expect(await pollUntil(() => procs[0]?.killed === true, 1000)).toBe(true);
    expect(spawns).toHaveLength(1);
    // 未就绪调用：立即抛结构化错 + 调用本身已触发拉起（fail-fast——宿主永不阻塞等待）
    await expect(echo.execute({ text: 'b' })).rejects.toThrow(/service_not_ready.*not-running/);
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    // 重试可成（「等待」由调用方按需重试承担）
    expect(
      await pollUntil(async () => {
        try {
          await echo.execute({ text: 'b' });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(await echo.execute({ text: 'b' })).toBe('[echo] ok');
    await cleanup(root, fiber);
  });

  it('新一轮握手途中调用：报 starting 且不重复 spawn；就绪后可成', async () => {
    const { io, spawns, procs } = makeFakeIO({ initializeDelayMs: 150 });
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, {
      timing: { startupDeadlineMs: 3000, idleTimeoutMs: 70, restartBackoffMs: 500 },
    });
    const tools = await waitForTools();
    const echo = first(tools);
    expect(await echo.execute({ text: 'a' })).toBe('[echo] ok');
    expect(await pollUntil(() => procs[0]?.killed === true, 1000)).toBe(true); // 空闲回收
    await expect(echo.execute({ text: 'b' })).rejects.toThrow(/service_not_ready.*not-running/); // 触发拉起
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    // 新一轮握手途中（initializeDelay 150ms）：报 starting、不重复拉起
    await expect(echo.execute({ text: 'b' })).rejects.toThrow(/service_not_ready.*starting/);
    expect(spawns).toHaveLength(2);
    expect(
      await pollUntil(async () => {
        try {
          await echo.execute({ text: 'b' });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    await cleanup(root, fiber);
  });

  it('卸载回收：fiber dispose → 进程杀 + 治理器出注册表（窗口事件不再复活）', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, { timing: TIMING });
    await waitForTools();
    notifyPluginWindowOpened('acme/tools'); // 留开窗态——dispose 后事件不得复活
    await fiber.dispose();
    expect(procs[0].killed).toBe(true); // 卸载即杀（任何受治进程必须有回收出口）
    expect(pluginToolRows()).toEqual([]);
    notifyPluginWindowClosed('acme/tools');
    notifyPluginWindowOpened('acme/tools'); // 无治理器在场——no-op
    await sleep(80);
    expect(spawns).toHaveLength(1); // 不复活
    notifyPluginWindowClosed('acme/tools'); // 计数归零清态
    await root[Symbol.asyncDispose]?.();
  });
});

describe('受治进程治理（S2）：e) 三档生命周期各自回收出口', () => {
  beforeEach(() => {
    resetMcpGovernorForTests();
  });

  it('lazy × 窗口：首开窗拉起；窗开不空闲回收；关窗重新起算后回收', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, {
      timing: { startupDeadlineMs: 2000, idleTimeoutMs: 80, restartBackoffMs: 500 },
    });
    // 冷启动：首开窗拉起（lazy 首开窗语义）
    notifyPluginWindowOpened('acme/tools');
    expect(await pollUntil(() => spawns.length === 1)).toBe(true);
    const tools = await waitForTools();
    const echo = first(tools);
    expect(await echo.execute({ text: 'a' })).toBe('[echo] ok');
    // 窗开：空闲超时不回收（调用后 idle 80ms 已过窗仍在——窗是闸）
    await sleep(250);
    expect(procs[0].killed).toBe(false);
    // 关窗：重新起算空闲 → 回收
    notifyPluginWindowClosed('acme/tools');
    expect(await pollUntil(() => procs[0].killed === true, 1000)).toBe(true);
    await cleanup(root, fiber);
  });

  it('eager：装载即拉起（注册期 spawn），卸载才停；崩溃无 on-crash 由装配兜底拉起', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'eager' }], io, { timing: TIMING });
    expect(spawns).toHaveLength(1); // 装载即拉起
    const tools = await waitForTools();
    const echo = first(tools);
    expect(await echo.execute({ text: 'a' })).toBe('[echo] ok');
    // 崩溃（restart 缺省 off）：不自动重启；下次装配兜底拉起
    procs[0].crash();
    await sleep(100);
    expect(spawns).toHaveLength(1);
    const row = first(pluginToolRows());
    await row.factory({} as never); // 装配发现未就绪 → 兜底拉起
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    expect(
      await pollUntil(async () => {
        try {
          await echo.execute({ text: 'b' });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    // 卸载才停：fiber dispose → 杀
    await fiber.dispose();
    expect(procs.some((p) => p.killed)).toBe(true);
    expect(pluginToolRows()).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });

  it('eager 装载失败（就绪时限内未握上）：registerMcpServerTools 抛出（插件 error 路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { io } = makeFakeIO({ silent: true });
    await expect(
      bootGoverned([{ ...STDIO_BASE, lifecycle: 'eager' }], io, { timing: { startupDeadlineMs: 80 } }),
    ).rejects.toThrow('就绪超时');
    warnSpy.mockRestore();
  });

  it('with-window：装配不拉起；开窗拉起，多窗计数，全关即杀，再开再拉', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'with-window' }], io, { timing: TIMING });
    expect(spawns).toHaveLength(0); // 装载不拉起（窗是生命周期主）
    const row = first(pluginToolRows());
    expect(await row.factory({} as never)).toEqual([]); // 装配也不拉起
    expect(spawns).toHaveLength(0);
    // 开窗 → 拉起
    notifyPluginWindowOpened('acme/tools');
    expect(await pollUntil(() => spawns.length === 1)).toBe(true);
    await waitForTools();
    // 多窗：第二扇开不重复拉起
    notifyPluginWindowOpened('acme/tools');
    await sleep(100);
    expect(spawns).toHaveLength(1);
    // 关一扇（仍剩一扇）→ 不杀
    notifyPluginWindowClosed('acme/tools');
    await sleep(100);
    expect(procs[0].killed).toBe(false);
    // 全关 → 即杀（决策 4：关窗默认杀）
    notifyPluginWindowClosed('acme/tools');
    expect(await pollUntil(() => procs[0].killed === true, 1000)).toBe(true);
    expect(spawns).toHaveLength(1);
    // 再开 → 再拉
    notifyPluginWindowOpened('acme/tools');
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    notifyPluginWindowClosed('acme/tools');
    await cleanup(root, fiber);
  });

  it('with-window 崩溃（窗开）：on-crash 退避重启继续随窗；无窗崩溃不重启', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'with-window', restart: 'on-crash' }], io, {
      timing: TIMING,
    });
    notifyPluginWindowOpened('acme/tools');
    expect(await pollUntil(() => spawns.length === 1)).toBe(true);
    await waitForTools();
    // 窗开崩溃 → 退避重启（仍应随窗在跑）
    procs[0].crash();
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    // 关窗（计数归零）→ 退避计时被取消，不再有重启；活代进程被杀
    notifyPluginWindowClosed('acme/tools');
    const countAfterClose = spawns.length;
    await sleep(150);
    expect(spawns).toHaveLength(countAfterClose);
    expect(procs[1].killed).toBe(true);
    await cleanup(root, fiber);
  });
});

describe('受治进程治理（S2）：数据目录 spawn 注入（S1 × S2 衔接）', () => {
  beforeEach(() => {
    resetMcpGovernorForTests();
  });

  it('dataDirPath 在场 → spawn env 注入 LANTAI_PLUGIN_DATA_DIR（受治 + 旧形态同注）', async () => {
    const { io, spawns } = makeFakeIO();
    const servers: McpServerDecl[] = [
      { name: 'legacy-srv', transport: 'stdio', command: 'node' },
      { name: 'gov-srv', transport: 'stdio', command: 'node', lifecycle: 'lazy' },
    ];
    const dataDir = 'C:/users/x/.lantai/plugins-data/acme/tools';
    const { root, fiber } = await bootGoverned(servers, io, { dataDirPath: dataDir, timing: TIMING });
    // 受治 lazy：装配触发拉起
    const rows = pluginToolRows();
    const govRow = first(rows.filter((r) => r.id === 'plugin/acme/tools/mcp/gov-srv'));
    await govRow.factory({} as never);
    expect(await pollUntil(() => spawns.some((s) => s.id.includes('gov-srv')))).toBe(true);
    // 旧形态：装配建连
    const legacyRow = first(rows.filter((r) => r.id === 'plugin/acme/tools/mcp/legacy-srv'));
    await legacyRow.factory({} as never);
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    // 两路 spawn 都带注入 env；受治代次后缀在 bridgeId 上（#1）
    expect(spawns.map((s) => s.env)).toEqual([
      { LANTAI_PLUGIN_DATA_DIR: dataDir },
      { LANTAI_PLUGIN_DATA_DIR: dataDir },
    ]);
    expect(first(spawns.filter((s) => s.id.includes('gov-srv'))).id).toBe('mcp-bridge/acme/tools/gov-srv#1');
    expect(first(spawns.filter((s) => s.id.includes('legacy-srv'))).id).toBe('mcp-bridge/acme/tools/legacy-srv');
    await cleanup(root, fiber);
  });

  it('dataDirPath 缺席（未声明 dataDir 的插件）→ 不注入（行为与 S2 前一致）', async () => {
    const { io, spawns } = makeFakeIO();
    const { root, fiber } = await bootGoverned([{ ...STDIO_BASE, lifecycle: 'lazy' }], io, { timing: TIMING });
    const row = first(pluginToolRows());
    await row.factory({} as never);
    expect(await pollUntil(() => spawns.length === 1)).toBe(true);
    expect(first(spawns).env).toBeUndefined();
    await cleanup(root, fiber);
  });
});
