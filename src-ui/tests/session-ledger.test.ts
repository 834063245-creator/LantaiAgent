// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// session-ledger L0 守护测试（session-ledger-plan §4 判据 ①②③④）：
//   ① 总目读写 roundtrip（含行号剥离/毒化容忍）
//   ② 工作集恢复：多卷全回、活跃指针正确、惰性卷无句柄
//   ③ 发号对账：max(内存, 总目, scan+1)——撞号场景不覆盖旧档
//   ④ 四动词记账：另起一卷 → 总目投影落盘
// mock 模式沿用 chat-session.test.ts（mockRpc 归一化 + 顺序式/实现式混合）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const createNoopTween = () => ({ kill: () => {}, play: () => {}, pause: () => {}, resume: () => {} });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import {
  type LedgerIo,
  ledgerFile,
  loadLedger,
  parseLedger,
  reconcileNextSessionId,
  type SessionLedgerDisk,
} from '../src/state/session-ledger';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

// ── Helpers ──

const PROJ = 'D:/ledger-proj';

function createChatPanel(): ChatCore {
  return new ChatCore();
}

/** 内存 IO（不经 mockInvoke——纯函数面直接喂内存文件表）。 */
function memIo(files: Record<string, string>): LedgerIo & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error('文件不存在');
    },
    writeFile: async (p, c) => {
      written[p] = c;
      files[p] = c;
    },
  };
}

function volumeFile(id: number, label: string, userContent: string): string {
  return JSON.stringify({
    id,
    label,
    savedAt: '2026-08-23T10:00:00Z',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: userContent },
      { role: 'assistant', content: 'ok' },
    ],
    tokensUsed: 100,
  });
}

function ledgerDisk(open: number[], activeId: number, nextSessionId: number): SessionLedgerDisk {
  return { version: 2, open: open.map((id) => ({ id })), activeId, nextSessionId };
}

/** 实现式磁盘 mock：_ledger.json / {id}.json / list_directory 三路由。 */
function mockDiskWith(ledger: SessionLedgerDisk | null, volumes: Record<number, string>, scanMax: number) {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: any) => {
    const { method, params } = payload;
    if (method === 'read_file_content') {
      const fp = params.file_path as string;
      if (fp.endsWith('_ledger.json')) {
        return ledger ? Promise.resolve(JSON.stringify(ledger)) : Promise.reject(new Error('no ledger'));
      }
      const m = fp.match(/\/(\d+)\.json$/);
      if (m && volumes[Number(m[1])]) return Promise.resolve(volumes[Number(m[1])]);
      return Promise.reject(new Error('文件不存在'));
    }
    if (method === 'write_file_content') return Promise.resolve('ok');
    if (method === 'list_directory') {
      const names = [...Object.keys(volumes).map((id) => `${id}.json`), '_active.json'];
      return Promise.resolve(
        JSON.stringify(names.map((n) => ({ name: n, path: `/s/${n}`, is_dir: false, children: null }))),
      );
    }
    void scanMax;
    return Promise.resolve(null);
  });
}

/** 惰性水合后的 Agent 工厂桩：记录每次工厂调用（活跃卷 1 次）。 */
function stubFactory(): { calls: number } {
  const rec = { calls: 0 };
  const panel = createChatPanel();
  return Object.assign(rec, { panel });
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数面：parseLedger / loadLedger / ledgerFile
// ═══════════════════════════════════════════════════════════════

describe('parseLedger', () => {
  it('合法账本 roundtrip', () => {
    const raw = {
      version: 2,
      open: [{ id: 3, label: '卷三' }, { id: 7 }],
      activeId: 7,
      nextSessionId: 8,
      savedAt: 't',
    };
    const parsed = parseLedger(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.open).toEqual([
      { id: 3, label: '卷三' },
      { id: 7, label: undefined },
    ]);
    expect(parsed?.activeId).toBe(7);
    expect(parsed?.nextSessionId).toBe(8);
  });

  it('version≠2 / open 非数组 / 非对象 → null（毒化容忍）', () => {
    expect(parseLedger(null)).toBeNull();
    expect(parseLedger('x')).toBeNull();
    expect(parseLedger({ version: 1, open: [] })).toBeNull();
    expect(parseLedger({ version: 2 })).toBeNull();
    expect(parseLedger({ version: 2, open: 'no' })).toBeNull();
  });

  it('open 集去重 + 坏条目跳过（id 非数字/重复）', () => {
    const parsed = parseLedger({
      version: 2,
      open: [{ id: 1 }, { id: 1 }, { id: 'x' }, null, { id: 2 }],
      activeId: null,
      nextSessionId: 3,
    });
    expect(parsed?.open.map((o) => o.id)).toEqual([1, 2]);
  });

  it('nextSessionId 缺失/非法 → 1 兜底；activeId 非数字 → null', () => {
    const parsed = parseLedger({ version: 2, open: [{ id: 1 }], activeId: 'x', nextSessionId: -5 });
    expect(parsed?.nextSessionId).toBe(1);
    expect(parsed?.activeId).toBeNull();
  });
});

describe('loadLedger', () => {
  it('读 _ledger.json（带 read_file_content 行号前缀也容忍）', async () => {
    const io = memIo({ [ledgerFile(PROJ)]: '     1\t{"version":2,"open":[{"id":5}],"activeId":5,"nextSessionId":6}' });
    const { ledger } = await loadLedger(PROJ, io);
    expect(ledger?.open[0].id).toBe(5);
  });

  it('无总目 → null（不读 _active.json——自然迁移语义）', async () => {
    const io = memIo({});
    const { ledger } = await loadLedger(PROJ, io);
    expect(ledger).toBeNull();
  });

  it('毒化总目 → null（读路径容忍，不炸）', async () => {
    const io = memIo({ [ledgerFile(PROJ)]: '{broken json' });
    const { ledger } = await loadLedger(PROJ, io);
    expect(ledger).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 集成面：工作集恢复（判据②）+ 发号对账（判据③）+ 记账（判据④）
// ═══════════════════════════════════════════════════════════════

describe('autoRestoreLastSession — 总目多卷恢复', () => {
  it('多卷全回：摊开集整回 + 活跃卷真句柄 + 惰性卷无句柄 + 消息预填', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    let factoryCalls = 0;
    panel.setAgentFactory(async () => {
      factoryCalls++;
      return {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        bindSession: vi.fn(),
      } as any;
    });

    // 总目：3 卷摊开（7 活跃），磁盘有 3 个卷文件，最大档号 9
    mockDiskWith(
      ledgerDisk([3, 7, 9], 7, 10),
      {
        3: volumeFile(3, '背景卷', '卷三内容'),
        7: volumeFile(7, '活跃卷', '卷七内容'),
        9: volumeFile(9, '惰性卷', '卷九内容'),
      },
      9,
    );

    await panel.autoRestoreLastSession(PROJ);

    // 摊开集整回（3 卷，顺序 = 总目 open 序）
    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([3, 7, 9]);
    expect(st.sessions.map((s) => s.label)).toEqual(['背景卷', '活跃卷', '惰性卷']);
    // 活跃指针 = 总目 activeId
    expect(st.sessions[st.activeIdx]?.id).toBe(7);
    // 活跃卷真句柄（工厂只被调 1 次——惰性卷不建句柄）
    expect(factoryCalls).toBe(1);
    // 惰性卷消息已预填（内容层恢复，无句柄）
    const lazyMsgs = msgStoreFor(panel.panelId, 3).getState().messages;
    expect(lazyMsgs.some((m: any) => m.role === 'user' && m.text === '卷三内容')).toBe(true);
    const lazyMsgs9 = msgStoreFor(panel.panelId, 9).getState().messages;
    expect(lazyMsgs9.some((m: any) => m.role === 'user' && m.text === '卷九内容')).toBe(true);
    // 发号对账：max(内存 1, 总目 10, scan 9+1) = 10
    expect(st.nextSessionId).toBe(10);
  });

  it('总目卷部分损坏：跳过死卷，活卷照常恢复', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    // 总目说 3 卷，磁盘只有 2 卷（5 缺失）
    mockDiskWith(
      ledgerDisk([5, 11], 11, 12),
      {
        11: volumeFile(11, '幸存卷', '卷十一内容'),
      },
      11,
    );

    await panel.autoRestoreLastSession(PROJ);

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([11]);
    expect(st.sessions[st.activeIdx]?.id).toBe(11);
  });

  it('总目卷全灭 → 清账新建（不从 localStorage 复活）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    // localStorage 有残留（P1-14 精神：磁盘是权威，总目全灭不复活）
    localStorage.setItem(
      `hologram_session_${(await import('../src/ui/chat-session')).hashProjectPath(PROJ).toString(36)}_7`,
      JSON.stringify({ id: 7, savedAt: '2026-08-23T00:00:00Z', messages: [{ role: 'user', content: '残留' }] }),
    );
    mockDiskWith(ledgerDisk([7], 7, 8), {}, 0);

    await panel.autoRestoreLastSession(PROJ);

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.some((s) => s.id === 7)).toBe(false);
  });

  it('恢复成功后总目落盘（含死卷剔除后的最新摊开集）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    const writes: Record<string, string> = {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'read_file_content') {
        const fp = params.file_path as string;
        if (fp.endsWith('_ledger.json')) {
          return Promise.resolve(JSON.stringify(ledgerDisk([7], 7, 8)));
        }
        if (fp.endsWith('/7.json')) return Promise.resolve(volumeFile(7, '卷七', '内容'));
        return Promise.reject(new Error('文件不存在'));
      }
      if (method === 'write_file_content') {
        writes[params.file_path as string] = params.content as string;
        return Promise.resolve('ok');
      }
      if (method === 'list_directory') {
        return Promise.resolve(JSON.stringify([{ name: '7.json', path: '/s/7.json', is_dir: false, children: null }]));
      }
      return Promise.resolve(null);
    });

    await panel.autoRestoreLastSession(PROJ);

    const ledgerWrite = Object.entries(writes).find(([p]) => p.endsWith('_ledger.json'));
    expect(ledgerWrite).toBeTruthy();
    const parsed = JSON.parse(ledgerWrite?.[1]);
    expect(parsed.version).toBe(2);
    expect(parsed.open).toEqual([{ id: 7, label: '卷七' }]);
    expect(parsed.activeId).toBe(7);
  });
});

describe('四动词记账（判据④）', () => {
  it('另起一卷 → 总目投影落盘（open 集 + 活跃指针 + 发号器）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgent({
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    const writes: Record<string, string> = {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'write_file_content') {
        writes[params.file_path as string] = params.content as string;
        return Promise.resolve('ok');
      }
      return Promise.resolve(null);
    });

    await panel.createNewSession();

    // 记账是 fire-and-forget——等微任务排干
    await new Promise((r) => setTimeout(r, 0));

    const ledgerWrite = Object.entries(writes).find(([p]) => p.endsWith('_ledger.json'));
    expect(ledgerWrite).toBeTruthy();
    const parsed = JSON.parse(ledgerWrite?.[1]);
    expect(parsed.open.map((o: any) => o.id)).toEqual([1, 2]);
    expect(parsed.activeId).toBe(2);
    expect(parsed.nextSessionId).toBe(3);
  });

  it('换卷 → 活跃指针变更落盘', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgent({
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    const writes: Record<string, string> = {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'write_file_content') {
        writes[params.file_path as string] = params.content as string;
        return Promise.resolve('ok');
      }
      return Promise.resolve(null);
    });

    await panel.createNewSession();
    await new Promise((r) => setTimeout(r, 0));
    delete Object.keys(writes).reduce((acc: Record<string, string>, k) => {
      void acc;
      delete writes[k];
      return writes;
    }, writes);

    panel.switchSession(0); // 换回卷 1
    await new Promise((r) => setTimeout(r, 0));

    const ledgerWrite = Object.entries(writes).find(([p]) => p.endsWith('_ledger.json'));
    expect(ledgerWrite).toBeTruthy();
    const parsed = JSON.parse(ledgerWrite?.[1]);
    expect(parsed.activeId).toBe(1);
    expect(parsed.open.map((o: any) => o.id)).toEqual([1, 2]);
  });
});

describe('发号对账（判据③）', () => {
  it('max(内存, 总目, scan+1)——撞号场景不覆盖旧档', async () => {
    const panel = createChatPanel();
    // 内存发号器低（1）+ 总目发号器低（2）+ 磁盘已有大档号（230）
    // 旧裂缝：跟踪文件+localStorage 双失效时发 1 号 → 覆盖 1.json
    const next = reconcileNextSessionId(panel.panelId, { version: 2, open: [], activeId: null, nextSessionId: 2 }, 230);
    expect(next).toBe(231);
  });

  it('loadSessionFromDisk 续开大号卷后另起一卷不发小号', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgent({
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'read_file_content' && (params.file_path as string).endsWith('/230.json')) {
        return Promise.resolve(volumeFile(230, '大号卷', '内容'));
      }
      if (method === 'write_file_content') return Promise.resolve('ok');
      return Promise.resolve(null);
    });

    await panel.loadSessionFromDisk(PROJ, 230);

    // 续开 230 后发号下限抬到 231
    expect(getChatStore(panel.panelId).sess.getState().nextSessionId).toBeGreaterThanOrEqual(231);
  });
});

describe('惰性水合（判据④補：ensureSessionAgent）', () => {
  it('切到惰性卷 → 句柄补建 + 磁盘内容回填到 agent session', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    const setSessionCalls: any[][] = [];
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: (msgs: any[]) => setSessionCalls.push(msgs),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    // 恢复两卷：3 活跃（真句柄）+ 9 惰性
    mockDiskWith(
      ledgerDisk([3, 9], 3, 10),
      {
        3: volumeFile(3, '活跃卷', '卷三内容'),
        9: volumeFile(9, '惰性卷', '卷九内容'),
      },
      9,
    );
    await panel.autoRestoreLastSession(PROJ);

    // 切到惰性卷 9（switchSession 内联 fire-and-forget 唤起）
    panel.switchSession(1);
    // 等水合链排干（factory + readSessionJSON + setSession 全异步）
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));

    // 句柄已建，会话内容从磁盘回填（含卷九的 user 消息）
    expect(setSessionCalls.length).toBeGreaterThanOrEqual(2);
    const last = setSessionCalls[setSessionCalls.length - 1];
    expect(last.some((m: any) => m.role === 'user' && m.content === '卷九内容')).toBe(true);
    // 活跃指针已切
    expect(getChatStore(panel.panelId).sess.getState().sessions[1].id).toBe(9);
  });

  it('sendMessage 同步唤起兑底：拟文时无句柄 → 补建后继续（不再报 Agent 未就绪）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
          run: vi.fn(async () => 'ok'),
          nextInsertIndex: 1,
          setUiSessionId: vi.fn(),
          insertMessage: vi.fn(),
        }) as any,
    );

    // 恢复一卷活跃（真句柄）+ 惰性卷 9；注意 run 桩最小面即可
    mockDiskWith(
      ledgerDisk([3, 9], 3, 10),
      {
        3: volumeFile(3, '活跃卷', '卷三内容'),
        9: volumeFile(9, '惰性卷', '卷九内容'),
      },
      9,
    );
    await panel.autoRestoreLastSession(PROJ);
    // 直接把活跃指针拨到惰性卷（不经 switchSession，模拟「句柄缺席的活跃卷」）
    getChatStore(panel.panelId).sess.getState().setActiveIdx(1);

    getChatStore(panel.panelId).input.getState().setInputText('问一句');
    // sendMessage 链路长（斜杠/命令/焦点等）——不 await 完成，只验证不因句柄缺席早退。
    // 早退会写入 error notice；水合成功则 notice 不含「Agent 未就绪」。
    await panel.sendMessage();
    const msgs = msgStoreFor(panel.panelId, 9).getState().messages;
    const notReady = msgs.filter((m: any) => m.role === 'notice' && String(m.text).includes('Agent 未就绪'));
    expect(notReady).toHaveLength(0);
  });
});

describe('L1 视图对齐', () => {
  it('续开查重（F2）：已摊开的卷 loadSessionFromDisk = 换卷不克隆（书脊不增条、句柄不重建）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    let factoryCalls = 0;
    panel.setAgentFactory(async () => {
      factoryCalls++;
      return {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        bindSession: vi.fn(),
      } as any;
    });

    // 恢复两卷：3 活跃 + 9 惰性
    mockDiskWith(
      ledgerDisk([3, 9], 3, 10),
      {
        3: volumeFile(3, '卷三', '卷三内容'),
        9: volumeFile(9, '卷九', '卷九内容'),
      },
      9,
    );
    await panel.autoRestoreLastSession(PROJ);
    const callsAfterRestore = factoryCalls;

    // 续开已摊开的卷 9（当前非活跃）→ 应换卷而非克隆
    await panel.loadSessionFromDisk(PROJ, 9);

    const st = getChatStore(panel.panelId).sess.getState();
    // 书脊不增条（仍两卷，无双 9）——查重主判据
    expect(st.sessions.filter((s) => s.id === 9)).toHaveLength(1);
    expect(st.sessions.map((s) => s.id)).toEqual([3, 9]);
    // 换卷到位
    expect(st.sessions[st.activeIdx]?.id).toBe(9);
    // 工厂增量 ≤ 1（仅切卷内联惰性水合一次；克隆路径会伴随书脊增条已被上方排除）
    expect(factoryCalls - callsAfterRestore).toBeLessThanOrEqual(1);
  });

  it('续开未摊开的卷 → 正常 clone 路径（查重不误伤）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    mockDiskWith(
      ledgerDisk([3], 3, 10),
      {
        3: volumeFile(3, '卷三', '卷三内容'),
        5: volumeFile(5, '新卷', '卷五内容'),
      },
      5,
    );
    await panel.autoRestoreLastSession(PROJ);

    // 续开未摊开的卷 5 → 正常追加
    await panel.loadSessionFromDisk(PROJ, 5);
    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([3, 5]);
    expect(st.sessions[st.activeIdx]?.id).toBe(5);
  });

  it('isOpen 投影：sess store 是唯一真相（首页标记查账不查磁盘）', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
        }) as any,
    );

    mockDiskWith(
      ledgerDisk([3, 9], 9, 10),
      {
        3: volumeFile(3, '卷三', '卷三内容'),
        9: volumeFile(9, '卷九', '卷九内容'),
      },
      9,
    );
    await panel.autoRestoreLastSession(PROJ);

    // 磁盘上有 3 和 9，摊开集也有 3 和 9 → isOpen 均真
    const { isOpen } = await import('../src/state/session-ledger');
    expect(isOpen(panel.panelId, 3)).toBe(true);
    expect(isOpen(panel.panelId, 9)).toBe(true);
    // 未摊开档号（磁盘在但在案头没有）→ 假
    expect(isOpen(panel.panelId, 5)).toBe(false);
  });
});

// ponytail: stubFactory 目前只在多卷用例内联使用——保留导出面供后续 L 段扩展
void stubFactory;
void Session;
