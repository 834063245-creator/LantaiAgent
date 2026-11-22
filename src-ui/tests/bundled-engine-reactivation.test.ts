// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包引擎 · 工作区**重新激活**回归（2026-11-22 实机报错）：
//
//   卷的 Agent 补建失败: [activation] 插件激活失败，装配中止：
//   hologram-engine: Error: 受治进程 "hologram"（hologram-engine）已随插件卸载——不可再拉起
//
// 病灶：引擎的激活声明只在**第一次**工作区激活时登记，且 `declare` 返回的撤销函数
// 被丢弃 ⇒ declarations（模块级表，键 = 插件名）里留着指向旧治理器的 start 闭包。
// 第二次开工作区时 `!activation.has(OWNER)` 为真 ⇒ 跳过重新声明；而旧治理器已随
// 旧工作区 fiber dispose（终态），于是新卷装配期 retain 打到它 → 抛错 → 装配中止、
// 卷拿不到句柄（且此后每个新补建的卷都复现，直到重启应用）。
//
// 不变量（本用例钉住）：**声明生命周期 = 声明者的 fiber**——工作区 A 拆掉后声明必须
// 消失；工作区 B 的 retain 必须打到 B 自己新起的治理器。
//
// 破测：把 wiring.ts 里的 `c.effect(() => disposeDeclaration, ...)` 删掉 →
// 第二条断言（declared === false）当场红。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ rpc: null as null | ReturnType<typeof vi.fn> }));

// 只替换 bridge 的 rpc 出口（探测走真实 typedJsonRpc 语义）。
vi.mock('../src/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bridge')>();
  const rpc = vi.fn();
  H.rpc = rpc;
  return { ...actual, rpc };
});

import type { ProcIO } from '../src/agent/mcp';
import { activationDeclared, clearActivationsForTest } from '../src/composition/activation';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { registerBundledEngineTools } from '../src/plugins/builtin/bundled-engine/wiring';
import { resetBundledEngineForTests } from '../src/plugins/bundled-engine-prefs';
import type { McpBridgeIO } from '../src/plugins/mcp-bridge';

/** 引擎就位时 `engine_bundled_info` 的结构化线形。 */
const ENGINE_ON_DISK = { path: 'D:/x/hologram-engine.exe', dir: 'D:/x', available: true };

/** 内存 MCP server（行协议 fake：initialize / tools/list 应答）。 */
function fakeProcIO(): ProcIO {
  const out = new Set<(line: string) => void>();
  const exit = new Set<(code: number | null) => void>();
  const send = (id: number, result: unknown) => {
    for (const cb of out) cb(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  return {
    writeLine: (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.id === undefined || !msg.method) return;
      if (msg.method === 'initialize') {
        send(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
      } else if (msg.method === 'tools/list') {
        send(msg.id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
      } else {
        send(msg.id, {});
      }
    },
    onStdoutLine: (cb) => {
      out.add(cb);
      return () => out.delete(cb);
    },
    onExit: (cb) => {
      exit.add(cb);
      return () => exit.delete(cb);
    },
    kill: () => {
      for (const cb of exit) cb(0);
    },
  };
}

/** 注入 IO：每次 spawn 一个新 fake 进程（两次工作区激活 = 两个治理器）。 */
const io: McpBridgeIO = {
  createProcIO: async () => fakeProcIO(),
  pluginDir: async () => 'D:/x',
};

/** 组合的最小形状（激活判定只读行 id 前缀）。 */
const COMP = {
  tools: [{ id: 'plugin/hologram-engine/mcp/hologram' }],
  activationDecl: { requires: [], exclusive: [] },
};

beforeEach(() => {
  H.rpc?.mockReset();
  resetBundledEngineForTests();
  clearActivationsForTest();
  localStorage.clear();
  localStorage.setItem('lantai.bundledEngine.enabled', 'true');
});

/** 开一个工作区并完成引擎接线（= workspace.ts 的 activateWorkspaceContributions 那一步）。 */
async function openWorkspace(root: Context): Promise<Awaited<ReturnType<Context['plugin']>>> {
  const ws = await root.plugin({ name: 'hologram/workspace', apply() {} });
  H.rpc?.mockResolvedValueOnce({ ...ENGINE_ON_DISK });
  const wiring = await registerBundledEngineTools(ws.ctx, 'D:/proj', io);
  expect(wiring.wired, '夹具前提：引擎接线成功（否则测不到激活面）').toBe(true);
  return ws;
}

describe('随包引擎 · 工作区重新激活（实机「已随插件卸载」回归）', () => {
  it('工作区 A 拆除后声明不得残留；工作区 B 的装配打到新治理器', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);

    // ── 工作区 A：接线 + 开卷（retain → start） ──
    const wsA = await openWorkspace(root);
    const handlesA = await root.activation.retainForComposition(COMP, 'agent-a');
    expect(handlesA[0]?.ok).toBe(true);
    await root.activation.releaseAll(handlesA); // 切走工作区时旧卷 Agent 全拆

    await wsA.dispose(); // 切工作区：fiber dispose → 治理器终态
    expect(activationDeclared('hologram-engine'), '声明必须随工作区 fiber 一起撤销').toBe(false);

    // ── 工作区 B：同一进程内第二次激活 ──
    const wsB = await openWorkspace(root);
    const handlesB = await root.activation.retainForComposition(COMP, 'agent-b');
    // 破测（修复前）：失败文本 = "Error: 受治进程 ... 已随插件卸载——不可再拉起"
    expect(handlesB[0]?.failure, '旧声明残留时这里会是「已随插件卸载」').toBeNull();
    expect(handlesB[0]?.ok).toBe(true);

    await root.activation.releaseAll(handlesB);
    await wsB.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});
