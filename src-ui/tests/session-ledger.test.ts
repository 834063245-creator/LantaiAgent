// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License: MIT.

// 会话统一 U4（Q1-B 总目退役）守护测试：
//   ① 摊开集扫描推导：重启恢复 = 磁盘扫描取最近 N 卷（savedAt 序，最新活跃），
//      workspace 过滤（本工作区卷 + 零目录卷各归其位）
//   ② 发号对账：reconcileNextSessionId = max(内存, 恢复集, scan+1)
//   ③ 记账退役负向：会话操作不再写 _ledger.json / _active.json
//   ④ 多卷恢复行为面：摊开集整回/死卷跳过/活跃指针/惰性句柄（承继
//      session-ledger L0 判据②，数据源从总目换为扫描推导）
// mock 模式沿用 chat-session.test.ts（mockRpc 归一化 + 实现式磁盘 mock）。

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
import { reconcileNextSessionId, type SessionLedgerDisk } from '../src/state/session-ledger';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

// ── Helpers ──

const PROJ = 'D:/ledger-proj';
const GLOBAL = '/.lantai/sessions'; // _userSessionsDir 未解析时的兜底路径（测试态）

function createChatPanel(): ChatCore {
  return new ChatCore();
}

function volumeFile(
  id: number,
  label: string,
  userContent: string,
  savedAt = '2026-08-24T10:00:00Z',
  ws?: string,
): string {
  return JSON.stringify({
    id,
    label,
    savedAt,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: userContent },
      { role: 'assistant', content: 'ok' },
    ],
    tokensUsed: 100,
    ...(ws ? { workspace: ws } : {}),
  });
}

/** 扫描推导磁盘 mock：list_directory 两目录路由（全局位 + 项目旧目录），
 *  read 按路径精确命中（workspace 字段在卷文件体内），write 捕获。 */
function mockScanDisk(globalVolumes: Record<number, string>, legacyVolumes: Record<number, string> = {}) {
  const writes: Array<{ file_path: string; content: string }> = [];
  const globalListing = Object.keys(globalVolumes).map((id) => ({
    name: `${id}.json`,
    path: `${GLOBAL}/${id}.json`,
    is_dir: false,
    children: null,
  }));
  const legacyListing = Object.keys(legacyVolumes).map((id) => ({
    name: `${id}.json`,
    path: `${PROJ}/.lantai/sessions/${id}.json`,
    is_dir: false,
    children: null,
  }));
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: any) => {
    const { method, params } = payload;
    if (method === 'list_directory') {
      const p = params.path as string;
      if (p === GLOBAL) return Promise.resolve(JSON.stringify(globalListing));
      if (p === `${PROJ}/.lantai/sessions`) return Promise.resolve(JSON.stringify(legacyListing));
      return Promise.resolve(JSON.stringify([]));
    }
    if (method === 'read_file_content') {
      const fp = params.file_path as string;
      const gm = fp.match(/^\/\.lantai\/sessions\/(\d+)\.json$/);
      if (gm) {
        const body = globalVolumes[Number(gm[1])];
        if (body) return Promise.resolve(body);
        return Promise.reject(new Error('文件不存在'));
      }
      const lm = fp.match(/\/(\d+)\.json$/);
      if (lm && legacyVolumes[Number(lm[1])]) return Promise.resolve(legacyVolumes[Number(lm[1])]);
      return Promise.reject(new Error('文件不存在'));
    }
    if (method === 'write_file_content') {
      writes.push({ file_path: params.file_path as string, content: params.content as string });
      return Promise.resolve('ok');
    }
    return Promise.resolve(null);
  });
  return writes;
}

function stubAgentFactory(bindings: any[][] = []) {
  return async () => {
    const stub = {
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      bindSession: vi.fn(),
    };
    bindings.push(stub);
    return stub;
  };
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
});

// ═══════════════════════════════════════════════════════════════
// ② 发号对账（纯函数面，承继 F5 判据）
// ═══════════════════════════════════════════════════════════════

describe('reconcileNextSessionId（发号对账）', () => {
  it('max(内存, 恢复集, scan+1)——scan 主导时不发小号', () => {
    const panel = createChatPanel();
    const next = reconcileNextSessionId(panel.panelId, null, 230);
    expect(next).toBe(231);
  });
  it('恢复集 nextSessionId 抬升内存值', () => {
    const panel = createChatPanel();
    const set: SessionLedgerDisk = { version: 2, open: [], activeId: null, nextSessionId: 2 };
    const next = reconcileNextSessionId(panel.panelId, set, 0);
    expect(next).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// ①④ 摊开集扫描推导（autoRestoreLastSession — Q1-B 后唯一恢复引擎）
// ═══════════════════════════════════════════════════════════════

describe('autoRestoreLastSession — 扫描推导恢复', () => {
  it('本工作区卷全回：最近 N 卷摊开（savedAt 序），最新为活跃，惰性卷消息预填', async () => {
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

    // 全局位三卷（归属本工作区），savedAt 9 > 7 > 3；另有一卷归属别的工作区（不进恢复集）
    mockScanDisk({
      9: volumeFile(9, '最新卷', '卷九内容', '2026-08-24T09:00:00Z', PROJ),
      7: volumeFile(7, '中间卷', '卷七内容', '2026-08-24T07:00:00Z', PROJ),
      3: volumeFile(3, '旧卷', '卷三内容', '2026-08-24T03:00:00Z', PROJ),
      5: volumeFile(5, '他区卷', '不该恢复', '2026-08-24T08:00:00Z', 'D:/other'),
    });

    await panel.autoRestoreLastSession(PROJ);

    const st = getChatStore(panel.panelId).sess.getState();
    // 最近 3 卷（上限内）摊开，最新活跃；他区卷不进
    expect(st.sessions.map((s) => s.id)).toEqual([9, 7, 3]);
    expect(st.sessions[st.activeIdx]?.id).toBe(9);
    // 惰性卷消息预填（内容层恢复）
    const lazyMsgs = msgStoreFor(panel.panelId, 7).getState().messages;
    expect(lazyMsgs.some((m: any) => m.text === '卷七内容')).toBe(true);
    // 发号对账：scan 最大 9 → next = 10
    expect(st.nextSessionId).toBe(10);
    // 活跃卷句柄后台补建恰 1 次（惰性卷不建句柄）
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
    expect(factoryCalls).toBe(1);
    // 恢复全程零写盘（摊开集推导不落任何账）
    expect(mockInvoke.mock.calls.some((c: any[]) => c[1]?.method === 'write_file_content')).toBe(false);
  });

  it('摊开集上限（RESTORE_OPEN_MAX=3）：第 4 新的卷不摊开', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(stubAgentFactory());
    mockScanDisk({
      1: volumeFile(1, '一', 'a', '2026-08-24T01:00:00Z', PROJ),
      2: volumeFile(2, '二', 'b', '2026-08-24T02:00:00Z', PROJ),
      3: volumeFile(3, '三', 'c', '2026-08-24T03:00:00Z', PROJ),
      4: volumeFile(4, '四', 'd', '2026-08-24T04:00:00Z', PROJ),
    });

    await panel.autoRestoreLastSession(PROJ);

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([4, 3, 2]); // 最新 3 卷
    // 发号仍对账到最大档号：next = 5
    expect(st.nextSessionId).toBe(5);
  });

  it('项目旧目录未吸收卷（legacy 无 ws 字段）按位置归属进恢复集', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(stubAgentFactory());
    // 全局位空；项目旧目录有 230.json（无 workspace 字段——迁移期旧卷）
    mockScanDisk({}, { 230: volumeFile(230, '未吸收卷', '旧目录内容') });

    await panel.autoRestoreLastSession(PROJ);

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([230]);
    const msgs = msgStoreFor(panel.panelId, 230).getState().messages;
    expect(msgs.some((m: any) => m.text === '旧目录内容')).toBe(true);
  });

  it('死卷跳过：墓碑卷不进恢复集；全灭 → 新建兜底', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgentFactory(stubAgentFactory());
    mockScanDisk({
      8: JSON.stringify({ id: 8, deleted: true, label: '', messages: [], savedAt: '', workspace: PROJ }),
    });

    await panel.autoRestoreLastSession(PROJ);

    // 墓碑被 listSavedSessions 过滤 → 无卷 → baseline 新建
    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].id).toBeGreaterThanOrEqual(1);
  });

  it('零目录恢复（projectPath=""）：只取零目录卷，带 ws 的卷不进', async () => {
    const panel = createChatPanel();
    panel.setProjectPath('');
    panel.setAgentFactory(stubAgentFactory());
    mockScanDisk({
      6: volumeFile(6, '零目录卷', '零目录内容'), // 无 ws 字段 = 零目录卷
      7: volumeFile(7, '项目卷', '不该进', '2026-08-24T11:00:00Z', PROJ),
    });

    await panel.autoRestoreLastSession('');

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([6]);
    expect(
      msgStoreFor(panel.panelId, 6)
        .getState()
        .messages.some((m: any) => m.text === '零目录内容'),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 记账退役负向：会话操作不再写 _ledger.json / _active.json
// ═══════════════════════════════════════════════════════════════

describe('Q1-B 记账退役负向', () => {
  it('恢复/另起/合卷全程零 _ledger.json 与 _active.json 写入', async () => {
    const panel = createChatPanel();
    panel.setProjectPath(PROJ);
    panel.setAgent({
      getSession: () => [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '内容' },
      ],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(stubAgentFactory());
    const writes = mockScanDisk({
      1: volumeFile(1, '卷一', '内容', '2026-08-24T10:00:00Z', PROJ),
    });

    await panel.createNewSession(); // 另起（两卷现场）
    panel.closeSession(0); // 合卷一（C8 自动存 = 真实卷写入路径）
    await new Promise((r) => setTimeout(r, 0)); // 写目标异步消解——排干微任务

    // 卷文件照常落盘（全局位）——禁止清单非空洞
    expect(writes.some((w) => w.file_path.endsWith('/1.json'))).toBe(true);
    const forbidden = writes.filter(
      (w) => w.file_path.endsWith('_ledger.json') || w.file_path.endsWith('_active.json'),
    );
    expect(forbidden).toEqual([]);
  });
});

// ponytail: Session 导出面保留给后续扩展（loadSessionFromDisk 换卷语义在
// chat-session.test.ts 钉）
void Session;
