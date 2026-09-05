// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件应用窗口（app shell 件 A · S3）钉住面：
//   - manifest.app schema：合法形状 / entry 围栏（./ 前缀 + .html + 无回溯）
//     / mode 枚举 / strictObject 未知键拒绝 / 缺省不变；
//   - 窗口注册表（plugin-window-store）：定义登记注销 / 开关聚焦模式拖拽 /
//     每插件单窗 v1 寻址；
//   - 设施 API × 治理器（S2 合成事件的真实接线）：开窗 notifyPluginWindowOpened
//     （with-window 拉起）、关窗 Closed（计数归零杀）、卸载收口关窗；
//   - loader 装载接线：manifest.app → 窗口定义登记（entryUrl 解析），
//     fiber dispose → 摘定义 + 关窗。
// 视口组件渲染 / postMessage 桥协议由 plugin-windows-host / plugin-window-bridge
// 测试文件覆盖；管理 UI 面（启动器/任务栏）待用户设计定稿后另批。

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  activateExternalPlugin,
  deactivateExternalPlugin,
  loadExternalPlugins,
  resetPluginRuntimeForTests,
} from '../src/plugins/loader';
import {
  type McpBridgeIO,
  notifyPluginWindowClosed,
  notifyPluginWindowOpened,
  registerMcpServerTools,
  resetMcpGovernorForTests,
} from '../src/plugins/mcp-bridge';
import { type AppDecl, validateManifest } from '../src/plugins/types';
import {
  appEntryUrl,
  closePluginWindow,
  focusPluginWindow,
  isPluginWindowOpen,
  listPluginWindows,
  mountPluginApp,
  openPluginWindow,
  setPluginWindowMode,
} from '../src/plugins/window-facility';
import { usePluginStore } from '../src/state/plugin-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const HELLO = { name: 'hello', version: '1.0.0', entry: 'entry.js' };
const ORIGIN = 'http://127.0.0.1:14570/plugins';

beforeEach(() => {
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  resetMcpGovernorForTests();
});

// ── manifest.app schema ──

describe('S3 窗口原语：manifest.app schema', () => {
  it('合法形状：entry 必填，mode/title 可选（entry 围栏只收 .html）', () => {
    const v = validateManifest({ ...HELLO, app: { entry: './app/index.html' } });
    expect(v.ok).toBe(true);
    expect(v.ok ? v.manifest.app?.entry : '').toBe('./app/index.html');
    expect(validateManifest({ ...HELLO, app: { entry: './app/index.html', mode: 'floating', title: '便签' } }).ok).toBe(
      true,
    );
    expect(validateManifest({ ...HELLO, app: { entry: './app/board.html', mode: 'dock', title: 'A' } }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, app: { entry: './app/plot.html', mode: 'fullscreen' } }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, app: { entry: './x.htm' } }).ok).toBe(false); // 围栏只收 .html
  });

  it('entry 围栏：非 ./ 前缀 / 回溯 / 绝对 / 非 .html / 非法字符全拒', () => {
    expect(validateManifest({ ...HELLO, app: { entry: 'app/index.html' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: '/app/index.html' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './app/../secret.html' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './app/index.js' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './app/index' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './app/ind ex.html' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './app/indi<ex.html' } }).ok).toBe(false);
  });

  it('mode 坏枚举 / title 空串 / 未知键（strictObject）/ 缺 entry 全拒', () => {
    expect(validateManifest({ ...HELLO, app: { entry: './a.html', mode: 'pinned' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './a.html', title: '' } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: { entry: './a.html', bogus: 1 } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, app: {} }).ok).toBe(false);
  });

  it('缺省不声明 = 行为不变（无 app 字段照常装载）', () => {
    expect(validateManifest(HELLO).ok).toBe(true);
  });
});

// ── 窗口注册表（纯状态层） ──

describe('S3 窗口原语：窗口注册表（plugin-window-store）', () => {
  const DEF = {
    pluginName: 'hello',
    entryUrl: ORIGIN + '/hello/app/index.html',
    mode: 'floating' as const,
    title: '便签',
  };

  it('registerAppDef → openWindow 实例化（mode/title 取定义，级联落位，海拔递增）', () => {
    usePluginWindowStore.getState().registerAppDef(DEF);
    const r = usePluginWindowStore.getState().openWindow('hello');
    expect(r).toEqual({ windowId: 'hello#1', opened: true });
    const w = usePluginWindowStore.getState().windows[0];
    expect(w).toMatchObject({ pluginName: 'hello', mode: 'floating', z: 2 });
    expect(w.x).toBeGreaterThan(0);
    expect(w.y).toBeGreaterThan(0);
  });

  it('openWindow 无定义 → null；已开窗再 open = 聚焦（opened=false，不增实例）', () => {
    const st = usePluginWindowStore.getState();
    expect(st.openWindow('ghost')).toBeNull();
    st.registerAppDef(DEF);
    expect(st.openWindow('ghost-plugin-noop')).toBeNull(); // 无定义 no-op
    const first = st.openWindow('hello');
    const second = st.openWindow('hello');
    expect(second?.windowId).toBe(first?.windowId);
    expect(second?.opened).toBe(false); // 聚焦不开新窗
    expect(usePluginWindowStore.getState().windows).toHaveLength(1);
    expect(usePluginWindowStore.getState().windows[0].z).toBeGreaterThan(2); // 聚焦抬升海拔
  });

  it('closeWindow 返回所属插件；focus/setMode/moveWindow 就地改实例', () => {
    const st = usePluginWindowStore.getState();
    st.registerAppDef(DEF);
    const id = st.openWindow('hello')?.windowId ?? '';
    st.setWindowMode(id, 'fullscreen');
    st.moveWindow(id, 120, 40);
    st.focusWindow(id);
    expect(usePluginWindowStore.getState().windows[0]).toMatchObject({ mode: 'fullscreen', x: 120, y: 40 });
    expect(usePluginWindowStore.getState().closeWindow(id)).toBe('hello');
    expect(usePluginWindowStore.getState().windows).toHaveLength(0);
    expect(usePluginWindowStore.getState().closeWindow(id)).toBeNull();
  });

  it('unregisterAppDef：摘定义 + 关掉该插件全部开窗（返回被关实例）', () => {
    const st = usePluginWindowStore.getState();
    st.registerAppDef(DEF);
    st.openWindow('hello');
    const closed = st.unregisterAppDef('hello');
    expect(closed.map((w) => w.pluginName)).toEqual(['hello']);
    expect(usePluginWindowStore.getState().windows).toHaveLength(0);
    expect(usePluginWindowStore.getState().defs.hello).toBeUndefined();
  });
});

// ── 设施 API × 受治进程治理（S2 合成事件的真实接线） ──

/** 最小 fake ProcIO：就绪握手 + 受控退出（S3 只需拉起/杀断言）。 */
function makeFakeIO(): { io: McpBridgeIO; spawns: number[]; killed: boolean[] } {
  const spawns: number[] = [];
  const killed: boolean[] = [];
  const io: McpBridgeIO = {
    createProcIO: async () => {
      const idx = spawns.length;
      spawns.push(idx);
      killed.push(false);
      const outCbs = new Set<(line: string) => void>();
      const exitCbs = new Set<(code: number | null) => void>();
      const proc: ProcIO = {
        writeLine: (line) => {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method === undefined || msg.id === undefined) return;
          const reply = (result: unknown) => {
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          };
          if (msg.method === 'initialize') {
            reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
          } else if (msg.method === 'tools/list') {
            reply({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
          } else {
            reply({});
          }
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
          killed[idx] = true;
          for (const cb of exitCbs) cb(0);
        },
      };
      return proc;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
  return { io, spawns, killed };
}

const TIMING = { startupDeadlineMs: 2000, idleTimeoutMs: 5000, restartBackoffMs: 40 };

const APP: AppDecl = { entry: './app/index.html', title: '便签' };

async function bootGovernedWithWindow(
  io: McpBridgeIO,
): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  const fiber = await root.plugin({
    name: 'acme/notes',
    inject: ['tools'],
    async apply(ctx) {
      await registerMcpServerTools(
        ctx,
        'acme/notes',
        [{ name: 'engine', transport: 'stdio', command: './bin/engine', lifecycle: 'with-window' }],
        io,
        { timing: TIMING },
      );
      mountPluginApp(ctx, 'acme/notes', APP, ORIGIN);
    },
  });
  return { root, fiber };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollUntil(cond: () => boolean, timeoutMs = 2000, stepMs = 15): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

describe('S3 窗口原语：设施 API × 受治进程（with-window 真实开合接线）', () => {
  beforeEach(() => {
    usePluginWindowStore.getState().resetPluginWindowsForTests();
    resetMcpGovernorForTests();
  });

  it('openPluginWindow → 治理器拉起；closePluginWindow → 计数归零杀（决策 4）', async () => {
    const { io, spawns, killed } = makeFakeIO();
    const { root, fiber } = await bootGovernedWithWindow(io);
    expect(spawns).toHaveLength(0); // with-window 装配不拉起
    expect(openPluginWindow('acme/notes')).toBe('acme/notes#1');
    expect(await pollUntil(() => spawns.length === 1)).toBe(true); // 开窗拉起
    // 再开（已开聚焦）不重复拉起
    expect(openPluginWindow('acme/notes')).toBe('acme/notes#1');
    await sleep(80);
    expect(spawns).toHaveLength(1);
    expect(closePluginWindow('acme/notes#1')).toBe(true);
    expect(await pollUntil(() => killed[0] === true)).toBe(true); // 关窗即杀
    // 再开再拉（换代 windowId #2）
    expect(openPluginWindow('acme/notes')).toBe('acme/notes#2');
    expect(await pollUntil(() => spawns.length === 2)).toBe(true);
    closePluginWindow('acme/notes#2');
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('插件卸载（fiber dispose）→ 窗全关 + 治理器出注册表（关窗通知不复活）', async () => {
    const { io, spawns, killed } = makeFakeIO();
    const { root, fiber } = await bootGovernedWithWindow(io);
    openPluginWindow('acme/notes');
    expect(await pollUntil(() => spawns.length === 1)).toBe(true);
    await fiber.dispose();
    expect(usePluginWindowStore.getState().windows).toHaveLength(0); // 窗全关
    expect(usePluginWindowStore.getState().defs['acme/notes']).toBeUndefined(); // 定义摘除
    expect(killed[0]).toBe(true); // 受治进程随卸载回收
    expect(isPluginWindowOpen('acme/notes')).toBe(false);
    await root[Symbol.asyncDispose]?.();
  });

  it('设施查询面：list / isOpen / focus / setMode', async () => {
    const { io } = makeFakeIO();
    const { root, fiber } = await bootGovernedWithWindow(io);
    const id = openPluginWindow('acme/notes') ?? '';
    expect(isPluginWindowOpen('acme/notes')).toBe(true);
    expect(listPluginWindows().map((w) => w.windowId)).toEqual([id]);
    setPluginWindowMode(id, 'fullscreen');
    expect(usePluginWindowStore.getState().windows[0].mode).toBe('fullscreen');
    focusPluginWindow(id);
    expect(usePluginWindowStore.getState().windows[0].z).toBeGreaterThan(2);
    closePluginWindow(id);
    expect(listPluginWindows()).toHaveLength(0);
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('窗口事件计数语义：设施面是唯一真实开合源（合成直调在别处仅供 S2 测试）', () => {
    // 设施面在治理器注册表无该插件时 no-op 不炸（窗口可先于/后于治理面存在）
    expect(() => {
      notifyPluginWindowOpened('no-such-plugin');
      notifyPluginWindowClosed('no-such-plugin');
    }).not.toThrow();
  });
});

// ── loader 装载接线 ──

interface MockResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
  return { ok: true, json: async () => body };
}

function notFound(): MockResponse {
  return { ok: false, json: async () => null };
}

function mockFetch(routes: Record<string, unknown>): (url: string) => Promise<MockResponse> {
  return async (url: string) => (url in routes ? jsonResponse(routes[url]) : notFound());
}

/** importModule mock：按 URL 目录返回与 manifest 同名的插件对象（loader
 *  有名字对拍门禁——错名直接 error 记录）。 */
function importByName(url: string): Promise<Record<string, unknown>> {
  const m = /\/plugins\/([^/]+)\/entry\.js$/.exec(url);
  const name = m ? m[1] : 'unknown';
  return Promise.resolve({ default: { name, apply() {} } });
}

describe('S3 窗口原语：loader 装载接线（manifest.app → 窗口定义）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
    resetPluginRuntimeForTests();
  });

  it('appEntryUrl：`./` 前缀归一拼资产通道 URL', () => {
    expect(appEntryUrl(ORIGIN, 'hello', './app/index.html')).toBe(ORIGIN + '/hello/app/index.html');
  });

  it('装载即登记窗口定义（entryUrl = origin/插件名/entry）；无 app 声明不登记', async () => {
    const manifestWithApp = {
      name: 'notes',
      version: '1.0.0',
      entry: 'entry.js',
      app: { entry: './app/index.html', title: '便签' },
    };
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['notes', 'plain'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/notes/manifest.json']: manifestWithApp,
        [ORIGIN + '/plain/manifest.json']: { name: 'plain', version: '1.0.0', entry: 'entry.js' },
      }),
      importModule: importByName,
    });
    const defs = usePluginWindowStore.getState().defs;
    expect(defs.notes).toMatchObject({
      pluginName: 'notes',
      entryUrl: ORIGIN + '/notes/app/index.html',
      mode: 'floating',
      title: '便签',
    });
    expect(defs.plain).toBeUndefined(); // 无 app 声明不登记
    // 开窗可用（定义在，视口有渲染源）
    expect(openPluginWindow('notes')).toBe('notes#1');
  });

  it('增量停用（deactivateExternalPlugin）→ 摘定义 + 关窗', async () => {
    const manifestWithApp = {
      name: 'notes',
      version: '1.0.0',
      entry: 'entry.js',
      app: { entry: './app/index.html' },
    };
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['notes'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/notes/manifest.json']: manifestWithApp,
      }),
      importModule: importByName,
    });
    expect(openPluginWindow('notes')).toBe('notes#1');
    await deactivateExternalPlugin('notes');
    expect(usePluginWindowStore.getState().defs.notes).toBeUndefined();
    expect(usePluginWindowStore.getState().windows).toHaveLength(0);
    // 增量重装（activate）→ 定义回来
    await activateExternalPlugin('notes');
    expect(usePluginWindowStore.getState().defs.notes).toBeDefined();
  });
});
