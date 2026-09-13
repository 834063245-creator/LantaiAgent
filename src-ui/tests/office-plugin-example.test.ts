// office 载体插件范本守护（分发形态）——钉住「二进制随插件目录自带」这条路的形状与语义：
//   ① 形状守护（不依赖二进制）：manifest 过 validateManifest；stdio 命令是**相对插件目录**的
//      `./bin/officecli.exe`（resolveCommand 的相对解析路径）；治理字段（lazy + on-crash）在场；
//      **不得声明 readOnly**（officecli 写文件——声明 true 会让写动作绕过 plan 门禁，契约 v27）；
//      entry 导出 { name, apply }；bin/README.md 在（落位说明不被误删）。
//   ② 载体语义真机（二进制在场时，缺席自动跳过）：把已装二进制**硬链**进临时插件目录（同卷零拷贝，
//      失败回退复制）→ 用**本 manifest 的 mcpServers 声明**经 registerMcpServerTools 装载
//      （pluginDir 锚在临时目录）→ 受治 lazy 就绪后：工具名 mcp__office__officecli、readOnly false、
//      真命令执行（--version 回 pin 版本）。
//      这条覆盖的正是载体形态独有的语义：**相对命令 → 插件目录解析 → 真进程**。
// node 环境：真 child_process + 真 fs（与 notes-app 范本守护同款）。

// @vitest-environment node

import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeStdioProc } from '../src/agent/mcp/transport';
import type { Tool } from '../src/agent/tool';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { type McpBridgeIO, registerMcpServerTools, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { validateManifest } from '../src/plugins/types';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'office');
const MANIFEST_RAW = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const VALIDATED = validateManifest(MANIFEST_RAW);
if (!VALIDATED.ok) throw new Error(`office 载体 manifest 不通过校验：${VALIDATED.error}`);
const MANIFEST = VALIDATED.manifest;

/** 已装二进制（P1 落位；可用 OFFICECLI_PATH 覆写）。 */
const BIN = process.env.OFFICECLI_PATH ?? join(homedir(), '.lantai', 'tools', 'officecli', 'officecli.exe');
const available = existsSync(BIN);

process.env.OFFICECLI_SKIP_UPDATE = '1';

function importRealEntry(): Promise<Record<string, unknown>> {
  const src = readFileSync(join(EXAMPLE_DIR, 'entry.js'), 'utf8');
  const url = 'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

describe('office 载体插件范本：形状守护', () => {
  it('manifest 合法且声明形态符合载体语义', () => {
    expect(MANIFEST.name).toBe('office');
    expect(MANIFEST.entry).toBe('entry.js');
    const servers = MANIFEST.mcpServers ?? [];
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s).toMatchObject({
      name: 'office',
      transport: 'stdio',
      // 相对命令（含分隔符）→ 相对插件目录解析（resolveCommand 的 looksRelative 分支）
      command: './bin/officecli.exe',
      args: ['mcp'],
      lifecycle: 'lazy',
      restart: 'on-crash',
    });
    // 写型 server 不得声明只读担保（否则写动作绕过 plan 门禁——契约 v27 的洞）
    expect(s.readOnly).toBeUndefined();
  });

  it('entry 导出 { name, apply }（loader 契约）且 bin/ 落位说明在', async () => {
    const mod = await importRealEntry();
    expect(mod.name).toBe('office');
    expect(typeof mod.apply).toBe('function');
    expect(existsSync(join(EXAMPLE_DIR, 'bin', 'README.md'))).toBe(true);
  });

  // 活预览窗（契约 v28 的 app 入口二态：环回远端页）+ 开窗工具口
  it('app 声明为环回远端视图（活预览）且由工具口开窗', async () => {
    expect(MANIFEST.app).toMatchObject({
      url: 'http://127.0.0.1:26315/', // 环回白名单内；watch 默认端口
      mode: 'floating', // url 形态禁 fullscreen（schema 层已把）
      title: 'Office 活预览',
    });
    expect(MANIFEST.app?.entry).toBeUndefined();
    // 开窗动作必须住在宿主侧（窗口设施只有 webview 摸得到）——声明 + handler 成对
    expect(MANIFEST.tools?.map((t) => t.name)).toEqual(['office_preview_open']);
    expect(MANIFEST.tools?.[0]?.readOnly).toBe(true);
    const mod = await importRealEntry();
    expect(typeof (mod.toolHandlers as Record<string, unknown> | undefined)?.office_preview_open).toBe('function');
  });
});

const d = available ? describe : describe.skip;
const TEMP_ROOT = available ? mkdtempSync(join(tmpdir(), 'lantai-office-plugin-')) : '';
let root: Context | null = null;
let fiber: Awaited<ReturnType<Context['plugin']>> | null = null;

beforeAll(async () => {
  if (!available) return;
  resetMcpGovernorForTests();
  // 临时「插件目录」：bin/officecli.exe 硬链已装二进制（同卷零拷贝；跨卷回退复制）
  mkdirSync(join(TEMP_ROOT, 'bin'), { recursive: true });
  const target = join(TEMP_ROOT, 'bin', 'officecli.exe');
  try {
    linkSync(BIN, target);
  } catch {
    copyFileSync(BIN, target);
  }
  const io: McpBridgeIO = {
    createProcIO: async (_bridgeId, command, args) => createNodeStdioProc(command, args),
    pluginDir: async () => TEMP_ROOT, // 锚点 = 临时插件目录 → './bin/officecli.exe' 解到这里
  };
  root = new Context();
  await root.plugin(compositionServicesPlugin);
  fiber = await root.plugin({
    name: 'office',
    inject: ['tools'],
    async apply(ctx) {
      // 用**范本 manifest 的声明**装载（不是测试里手抄一份）——载体契约即范本契约
      await registerMcpServerTools(ctx, 'office', MANIFEST.mcpServers ?? [], io);
    },
  });
}, 180_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 清理临时插件目录（带重试）：刚被 kill 的 officecli 子进程可能仍持有 exe 映像句柄，
 *  Windows 下会让 rmSync 报 EBUSY/EPERM——不重试就会在 %TEMP% 里积残留（实测踩过）。 */
async function removeWithRetry(dir: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

afterAll(async () => {
  await fiber?.dispose();
  await root?.[Symbol.asyncDispose]?.();
  if (TEMP_ROOT) await removeWithRetry(TEMP_ROOT);
});

async function factoryTools(): Promise<Tool[]> {
  const row = pluginToolRows().find((r) => r.id === 'plugin/office/mcp/office');
  if (!row) throw new Error('未折算出行 plugin/office/mcp/office');
  return await row.factory({} as never);
}

d('office 载体插件范本：相对命令真机语义（二进制在场）', () => {
  it('受治 lazy 就绪 → 工具面 mcp__office__officecli / 视为写 / 真命令可执行', async () => {
    // 就绪轮询（受治 lazy 首装配空集是按设计——宿主机不阻塞等待）
    const deadline = Date.now() + 60_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await factoryTools();
      if (tools.length > 0) break;
      await sleep(100);
    }
    expect(tools.map((t) => t.name())).toEqual(['mcp__office__officecli']);
    const tool = tools[0]!;
    // 载体语义的关键一条：写型 server 在兰台是「写」工具（plan 模式会拦）
    expect(tool.readOnly()).toBe(false);
    // 真命令穿到真进程（相对命令已解到临时插件目录的 bin/）
    const out = (await tool.execute({ command: ['--version'] })) as string;
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 180_000);
});
