// SPDX-License-Identifier: MIT

// notes-app 软件级插件范本守护（app shell · S5）——钉住「示例的四件套形状」
// （对位 first-party-manifest / hello 的守护套路）：
//   - manifest 字段齐全（app 窗入口 / dataDir / mcpServers lazy / tools
//     notes_open）+ 范本文件完备（窗页桥协议串 / 工具口 handler）；
//   - 装载即目录（loader wrapper ensure 以插件名调用）+ 窗口定义登记 +
//     notes_open 走工具口端到端（宿主桥 windows 设施开窗——工具语义归插件）；
//   - 真 server 进程集成（child_process spawn node server.cjs，非 fake IO）：
//     lazy 装配触发拉起 → initialize 握手就绪 → 数据四工具随 tools/list 进
//     registry（动态名面族——一行贡献承载整族）→ notes_create 落数据地盘 →
//     notes_list 可见；
//   - 异步导出（件 D）：提交即回卡片 → 真 server 发 lantai/deferred 完成通知
//     → 桥翻译成唤醒（minimal 定位键归因 notes-app·mcp__notes__notes_export）
//     → 凭 taskId 再调取导出内容；
//   - 窗 HTTP 面：port.json 落数据地盘 + /notes CORS 应答（窗是 opaque origin）。
// node 环境：child_process / fs 真进程集成（jsdom 下 node: 模块 baseline 不可用）。

// @vitest-environment node

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  pendingDeferredCountForTests,
  registerDeferredWakeHandler,
  resetPluginDeferredForTests,
} from '../src/plugins/deferred';
import { type McpBridgeIO, registerMcpServerTools, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { validateManifest } from '../src/plugins/types';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'notes-app');
const MANIFEST_RAW = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const VALIDATED = validateManifest(MANIFEST_RAW);
if (!VALIDATED.ok) throw new Error('notes-app 范本 manifest 不通过校验（守护前置失败）');
const MANIFEST = VALIDATED.manifest;

/** 真 entry 模块导入：entry 在 src-ui 根外（examples/），file URL 会被 vite
 *  fs.allow 拒——自包含 ESM（零 import）经 data URL 装载，逐字节是范本真身。 */
async function importRealEntry(): Promise<Record<string, unknown>> {
  const src = readFileSync(join(EXAMPLE_DIR, 'entry.js'), 'utf8');
  const url = 'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return await import(/* @vite-ignore */ url);
}

const tempDirs: string[] = [];

function makeTempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lantai-notes-app-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetPluginDeferredForTests();
  resetMcpGovernorForTests();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── 真 Node 子进程 ProcIO（child_process spawn——非 fake，server.cjs 全真跑） ──

interface NodeProcHandle {
  proc: ProcIO;
  child: ChildProcess;
}

function nodeProcIOFactory(): { io: McpBridgeIO; children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  const io: McpBridgeIO = {
    createProcIO: async (_bridgeId, command, args, env) => {
      const child = spawn(command, args, {
        cwd: EXAMPLE_DIR,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      const outCbs = new Set<(line: string) => void>();
      const exitCbs = new Set<(code: number | null) => void>();
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim() !== '') for (const cb of outCbs) cb(line);
          idx = buf.indexOf('\n');
        }
      });
      child.on('exit', (code) => {
        for (const cb of exitCbs) cb(code);
      });
      const handle: NodeProcHandle = {
        child,
        proc: {
          writeLine: (line) => {
            child.stdin?.write(line + '\n');
          },
          onStdoutLine: (cb) => {
            outCbs.add(cb);
            return () => outCbs.delete(cb);
          },
          onExit: (cb) => {
            exitCbs.add(cb);
            return () => exitCbs.delete(cb);
          },
          kill: () => {
            if (!child.killed) child.kill();
          },
        },
      };
      return handle.proc;
    },
    pluginDir: async (name) => (name === 'notes-app' ? EXAMPLE_DIR.replaceAll('\\', '/') : `C:/plugins/${name}`),
  };
  return { io, children };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return await cond();
}

// ── manifest + 范本文件形状 ──

describe('notes-app 范本：manifest 与文件形状', () => {
  it('manifest 字段齐全且通过校验（app/dataDir/mcpServers lazy/tools notes_open）', () => {
    expect(MANIFEST.app).toEqual({ entry: './app/index.html', mode: 'floating', title: '便签' });
    expect(MANIFEST.dataDir).toBe(true);
    expect(MANIFEST.mcpServers).toEqual([
      { name: 'notes', transport: 'stdio', command: 'node', args: ['./server.cjs'], lifecycle: 'lazy' },
    ]);
    expect(MANIFEST.tools?.map((t) => t.name)).toEqual(['notes_open']);
  });

  it('范本文件完备：窗页含桥协议串 + 桥 SDK；entry 含工具口 handler', async () => {
    expect(existsSync(join(EXAMPLE_DIR, 'server.cjs'))).toBe(true);
    const html = readFileSync(join(EXAMPLE_DIR, 'app', 'index.html'), 'utf8');
    expect(html).toContain("'lantai-plugin-bridge'");
    expect(html).toContain('fs.read'); // 桥 fs 面：读 port.json
    const entry = await importRealEntry();
    expect(entry.toolHandlers).toHaveProperty('notes_open');
    expect((entry.default as { name: string }).name).toBe('notes-app');
  });
});

// （装载即目录 / notes_open 工具口 / 窗口定义登记 的 loader 集成测试在
//   tests/notes-app-loader.test.ts——jsdom 环境，与既有 plugin-loader 测试同
//   惯例：loader 牵全内置插件图，jsdom 是其原生环境。）

// ── 真 server 进程集成（MCP 面 + 数据地盘 + 异步唤醒 + 窗 HTTP 面） ──

describe('notes-app 范本：真 server.cjs 进程集成（受治 lazy + 件 D 唤醒）', () => {
  it('握手就绪 → 数据四工具进 registry → 增查落数据地盘 → 异步导出唤醒 → 凭 taskId 取内容', async () => {
    const dataDir = makeTempDir('mcp');
    const { io, children } = nodeProcIOFactory();
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'notes-app',
      inject: ['tools'],
      async apply(ctx) {
        await registerMcpServerTools(ctx, 'notes-app', MANIFEST.mcpServers ?? [], io, {
          dataDirPath: dataDir,
          timing: { startupDeadlineMs: 5000, idleTimeoutMs: 60_000, restartBackoffMs: 50 },
        });
      },
    });
    try {
      const row = pluginToolRows().find((r) => r.id === 'plugin/notes-app/mcp/notes');
      expect(row).toBeDefined();
      // lazy 装配触发拉起（真实 spawn：node server.cjs）→ 就绪后工具整组产出
      let tools = await row?.factory({} as never);
      expect(
        await pollUntil(async () => {
          tools = (await row?.factory({} as never)) ?? [];
          return tools.length > 0;
        }),
      ).toBe(true);
      expect(tools.map((t) => t.name()).sort()).toEqual([
        'mcp__notes__notes_create',
        'mcp__notes__notes_delete',
        'mcp__notes__notes_export',
        'mcp__notes__notes_list',
      ]);
      const byName = new Map(tools.map((t) => [t.name(), t]));
      // 增：写入数据地盘 notes.json（单写者 = server 进程）
      const create = await byName.get('mcp__notes__notes_create')?.execute({ text: '第一条便签' });
      expect(String(create)).toMatch(/便签已创建（id: n-/);
      expect(readFileSync(join(dataDir, 'notes.json'), 'utf8')).toContain('第一条便签');
      // 查
      const list = await byName.get('mcp__notes__notes_list')?.execute({});
      expect(String(list)).toContain('第一条便签');
      // 异步导出（件 D）：提交即回卡片（Agent 发起 → 绑 deferred token）
      const wakeSpy = vi.fn();
      const unWake = registerDeferredWakeHandler((ownerId, key) => {
        wakeSpy(ownerId, key);
        return true;
      });
      const card = await byName.get('mcp__notes__notes_export')?.execute({ _owner_id: 'main-x' });
      const taskId = /export-[a-z0-9]+/.exec(String(card))?.[0] ?? '';
      expect(String(card)).toContain('导出任务已提交');
      expect(taskId).not.toBe('');
      expect(pendingDeferredCountForTests().tokens).toBe(1);
      // 真 server 1.2s 后发 lantai/deferred → 桥翻译成同一唤醒（含归因工具名）
      expect(await pollUntil(() => wakeSpy.mock.calls.length > 0, 6000)).toBe(true);
      expect(wakeSpy).toHaveBeenCalledWith(
        'main-x',
        expect.objectContaining({
          taskId,
          status: 'completed',
          plugin: 'notes-app',
          tool: 'mcp__notes__notes_export',
        }),
      );
      expect(pendingDeferredCountForTests().tokens).toBe(0); // 翻译即消费
      // 凭定位键取内容（内容不进唤醒体）
      const result = await byName.get('mcp__notes__notes_export')?.execute({ taskId });
      expect(String(result)).toContain('第一条便签');
      // 删
      const list2 = JSON.parse(String(await byName.get('mcp__notes__notes_list')?.execute({}))) as {
        notes: Array<{ id: string }>;
      };
      const del = await byName.get('mcp__notes__notes_delete')?.execute({ id: list2.notes[0]?.id ?? '' });
      expect(String(del)).toContain('便签已删除');
      unWake();
    } finally {
      await fiber.dispose();
      await root[Symbol.asyncDispose]?.();
      for (const c of children) if (!c.killed) c.kill();
    }
  });

  it('窗 HTTP 面：port.json 落数据地盘 + /notes 应答带 CORS *（窗是 opaque origin）', async () => {
    const dataDir = makeTempDir('http');
    // 独立裸跑形态：不经 mcp-bridge，直接 spawn 真 server（env 注入数据地盘）
    const { io, children } = nodeProcIOFactory();
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'notes-app',
      inject: ['tools'],
      async apply(ctx) {
        await registerMcpServerTools(ctx, 'notes-app', MANIFEST.mcpServers ?? [], io, {
          dataDirPath: dataDir,
          timing: { startupDeadlineMs: 5000, idleTimeoutMs: 60_000, restartBackoffMs: 50 },
        });
      },
    });
    try {
      const row = pluginToolRows().find((r) => r.id === 'plugin/notes-app/mcp/notes');
      expect(await pollUntil(async () => (await row?.factory({} as never)) != null)).toBe(true);
      // server 启动即写 port.json（listen 回调）
      expect(await pollUntil(() => existsSync(join(dataDir, 'port.json')), 5000)).toBe(true);
      const { port } = JSON.parse(readFileSync(join(dataDir, 'port.json'), 'utf8')) as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/notes`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(((await res.json()) as { notes: unknown[] }).notes).toEqual([]);
      // 预检（opaque origin 的 fetch 先 OPTIONS）
      const pre = await fetch(`http://127.0.0.1:${port}/notes`, { method: 'OPTIONS' });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    } finally {
      await fiber.dispose();
      await root[Symbol.asyncDispose]?.();
      for (const c of children) if (!c.killed) c.kill();
    }
  });
});
