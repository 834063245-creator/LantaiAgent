// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { cacheText, logText } from './helpers/session-files';

// ── Mock bridge — all Tauri backend calls route through here ──
const mockInvoke = vi.fn();
// ponytail: rpc() wrapper converts camelCase→snake_case, then calls invoke('rpc', ...)
// For tests we bypass normalization — mockInvoke already returns the right shape.
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

// ── Mock DOM-heavy libs that don't matter for session logic ──
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
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));

// GSAP in jsdom — gsap.fromTo needs requestAnimationFrame; vitest jsdom env provides it
vi.mock('gsap', () => {
  const createNoopTween = () => ({
    kill: () => {},
    play: () => {},
    pause: () => {},
    resume: () => {},
    restart: () => {},
    seek: () => {},
    // biome-ignore lint/suspicious/noThenProperty: GSAP tween 接口形状（thenable mock）
    then: () => {},
    eventCallback: () => {},
    timeScale: () => {},
    progress: () => {},
    totalProgress: () => {},
  });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
    killTweensOf: vi.fn(),
    isTweening: vi.fn(() => false),
    utils: { toArray: vi.fn(() => []) },
  };
  return { default: gsap, gsap };
});

vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

// 会话持久化 seam 装配（seam 接线 C 批 3）：会话卷 CRUD 已换轨 sessionExecute
// ——builtin provider 需在册（走 bridge.mock → fs_cap → mockInvoke 原链）。
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

import { agentSessionState } from '../src/agent/agent-session-state';
import { ChatCore } from '../src/app/chat/chat-core';
import { createBlock } from '../src/paper/block-model';
import { makeStrip } from '../src/paper/selection';
import {
  getCanvasStore,
  loadCanvasFromDisk,
  resetCanvasStoresForTests,
  snapshotFromBlock,
} from '../src/state/canvas-store';
import { getMessagesStore } from '../src/state/messages-store';
import { useSessionVolumesStore } from '../src/state/session-volumes-store';
import * as Session from '../src/ui/chat-session';
import { scanMaxSessionId } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

// ── Helpers ──

// fs 域收口（kernel-capability-c3-design.md）：UI 持久化 helper（kernelReadFile/
// kernelWriteFile/kernelListDirectory…）已从 tool_call 信封（builtin.fs）换
// fs_cap 能力口直呼。本文件 mock 面在 bridge.rpc 层（真 helper → fs_cap →
// mockInvoke）——下方 fsCapAware 把 fs_cap 调用翻译回各用例旧 (method, params)
// 形状交给 impl（旧 if 链零改动），使 mock 分派面理解当前真实 RPC 通道。
// 等价返回形状：fs_cap read 真实现返 {path,content}（kernelReadFileRaw 对非
// {content} 回退原文）；本层只翻译参数不包装返回——impl 的原文返回被
// kernel* helper 的解析兜底接受（非 JSON/无 content 字段 → 原文直通）。
function fsCapAware(
  impl: (cmd: string, payload: { method: string; params?: Record<string, unknown> }) => unknown,
): (cmd: string, payload: { method: string; params?: Record<string, unknown> }) => unknown {
  return (cmd: string, payload: { method: string; params?: Record<string, unknown> }) => {
    const { method, params } = payload;
    if (method !== 'fs_cap') return impl(cmd, payload);
    const action = (params?.action as string | undefined) ?? '';
    const legacy: Record<string, string> = {
      read: 'read_file_content',
      write: 'write_file_content',
      list: 'list_directory',
      create_dir: 'create_directory',
      delete: 'delete_file_or_dir',
    };
    const name = legacy[action];
    if (!name) throw new Error(`chat-session mock: 未处理的 fs_cap action '${action}'`);
    // fs_cap 顶层 snake 键 = 旧 RPC 参数键（file_path/content/path/filter_ignored
    // 等）——直传即可（旧 impl 按 file_path/path 读）
    const { action: _action, is_agent: _isAgent, agent_id: _agentId, ...rest } = params ?? {};
    void _action;
    void _isAgent;
    void _agentId;
    return impl(cmd, { method: name, params: rest });
  };
}

/** Create a minimal headless ChatCore (no DOM needed). */
function createChatPanel(): ChatCore {
  return new ChatCore();
}

// Phase 3b（权威翻转）：卷 = 事件日志 `.ndjson`；`.json` 只是 UI 投影缓存。
// 夹具助手（与生产写面同形）在 `tests/helpers/session-files.ts`（多文件共用单一真源）。
// ── Tests ──

describe('ChatPanel session persistence', () => {
  let panel: ChatCore;

  beforeEach(() => {
    // Clean localStorage between tests
    localStorage.clear();
    // 卷清单投影缓存（模块级态，2026-09-18）：跨用例清空——否则同一 root 的
    // 前序用例清单会被复用，mock 盘形同虚设
    Session.resetSessionListCacheForTests();
    // Reset mock between tests
    mockInvoke.mockReset();
    // Default: all invoke calls resolve with empty
    mockInvoke.mockResolvedValue(null);
    // Reset global single-instance stores (projectPath 已收口为 shell-store 全局单例 —
    // 不重置会让前序测试的残留路径触发 ChatCore 构造期的 GoalManager 异步链，
    // 在 await 边界插队消费 Once mock 队列)
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
  });

  // （stripLineNumbers 已随 2026-09 fs(read) 行号默认翻转退役：kernelReadFile
  //  缺省原文、行号仅 lineNumbers:true 显式请求——剥行号路径无消费者，用例撤。）

  // ═══════════════════════════════════════════════════════════════
  // scanMaxSessionId — must never hang
  // ═══════════════════════════════════════════════════════════════

  describe('scanMaxSessionId', () => {
    it('returns 0 when list_directory rejects (backend unavailable)', async () => {
      panel = createChatPanel();
      mockInvoke.mockRejectedValue(new Error('backend down'));

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(0);
    });

    it('returns 0 when list_directory returns non-array', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue(null);

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(0);
    });

    it('returns max numeric ID from entries', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue(
        JSON.stringify([
          { name: '1.ndjson', path: '/sessions/1.ndjson', is_dir: false, children: null },
          { name: '71.ndjson', path: '/sessions/71.ndjson', is_dir: false, children: null },
          { name: '_active.json', path: '/sessions/_active.json', is_dir: false, children: null },
          { name: 'not-json.txt', path: '/sessions/not-json.txt', is_dir: false, children: null },
        ]),
      );

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(71);
    });

    it('skips directories and non-json files', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue(
        JSON.stringify([
          { name: 'sub', path: '/sessions/sub', is_dir: true, children: [] },
          { name: '3.ndjson', path: '/sessions/3.ndjson', is_dir: false, children: null },
          { name: 'readme.md', path: '/sessions/readme.md', is_dir: false, children: null },
        ]),
      );

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(3);
    });

    it('resolves within 100ms (no hang)', async () => {
      panel = createChatPanel();
      // Simulate a slow but not hung backend
      mockInvoke.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify([])), 10)));

      const start = Date.now();
      const result = await scanMaxSessionId('D:/test');
      const elapsed = Date.now() - start;

      expect(result).toBe(0);
      expect(elapsed).toBeLessThan(500); // generous upper bound
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listSavedSessions — 卷目录（清单投影持久化）+ 对账 + 补建
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions（卷目录）', () => {
    const P = 'D:/cat-proj';
    const ROOT = `${P}/.lantai/sessions`;

    /** 实现式会话盘 mock：**按路径路由**（目录/日志/投影缓存/卷目录一套盘）。
     *  替代旧「按调用次序出队」的队列 mock——清点链新增目录文件读写后，
     *  调用次序成了实现细节，钉次序 = 钉死实现（换实现即假红）。 */
    function mockSessionDisk(
      files: Record<string, string>,
      o?: { failRead?: (path: string) => boolean; hangRead?: (path: string) => boolean },
    ) {
      const reads: string[] = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = String(params.file_path ?? '');
            if (o?.hangRead?.(fp)) return new Promise(() => {});
            if (o?.failRead?.(fp)) return Promise.reject(new Error('读取失败（测试注入）'));
            reads.push(fp);
            return fp in files ? Promise.resolve(files[fp]) : Promise.reject(new Error('文件不存在'));
          }
          if (method === 'write_file_content') {
            files[String(params.file_path)] = String(params.content);
            return Promise.resolve('ok');
          }
          if (method === 'delete_file_or_dir') {
            delete files[String(params.path)];
            return Promise.resolve('ok');
          }
          if (method === 'list_directory') {
            const dir = String(params.path);
            const entries = Object.keys(files)
              .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
              .map((p) => ({ name: p.split('/').pop(), path: p, is_dir: false, children: null }));
            return Promise.resolve(JSON.stringify(entries));
          }
          return Promise.resolve('ok');
        }),
      );
      /** 卷体读（日志 + 投影缓存）——目录文件与目录枚举不算。 */
      const volumeReads = () => reads.filter((p) => /\/\d+\.(ndjson|json)$/.test(p.replace(/\\/g, '/')));
      return { files, reads, volumeReads };
    }

    /** 一卷的盘上形态：事件日志（卷本体）+ 投影缓存（label/savedAt——**卷名的家**）。 */
    function seedVolume(
      files: Record<string, string>,
      id: number,
      opts: {
        label?: string;
        savedAt?: string;
        msgs?: Array<{ role: string; content?: string }>;
        /** 会话树血缘边（枝卷）——写进**事件日志头行**（write-once 真源）。 */
        parent?: { id: number; atSeq: number };
      } = {},
    ): void {
      const msgs = opts.msgs ?? [{ role: 'user', content: `内容 ${id}` }];
      files[`${ROOT}/${id}.ndjson`] = logText(id, msgs, opts.savedAt, undefined, opts.parent);
      files[`${ROOT}/${id}.json`] = cacheText(id, {
        label: opts.label ?? '',
        savedAt: opts.savedAt ?? '2026-01-01T00:00:00Z',
      });
    }

    function catalogOfDisk(files: Record<string, string>): { ver: number; rows: Record<string, unknown> } {
      const raw = files[`${ROOT}/_index.json`];
      expect(raw, '卷目录文件应已落盘（_index.json）').toBeTruthy();
      return JSON.parse(raw);
    }

    // 2026-09-18 二批：清点 = 目录枚举 + 一份小 JSON（**不读卷体**）；缺失行由目录
    // 对账发现并补建（首次阻塞至预算，其余后台）。见 chat-session「卷目录」头注。

    it('首次清点：补建全部卷 + 落盘 _index.json', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '甲', savedAt: '2026-01-01T00:00:00Z' });
      seedVolume(files, 2, { label: '乙', savedAt: '2026-06-30T00:00:00Z' });
      mockSessionDisk(files);

      const result = await panel.listSavedSessions(P);
      expect(result.map((r) => r.id)).toEqual([2, 1]); // savedAt 倒序
      expect(result[0]).toEqual({
        id: 2,
        label: '乙',
        msgCount: 1,
        savedAt: '2026-06-30T00:00:00Z',
      });
      // 目录已落盘（下次清点直接用它）
      const cat = catalogOfDisk(files);
      expect(cat.ver).toBe(2);
      expect(Object.keys(cat.rows).sort()).toEqual(['1', '2']);
    });

    it('稳态清点零卷体读（几百卷也只是一份小 JSON）；跨「重启」仍不读卷体', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      for (const id of [1, 2, 3, 4, 5]) seedVolume(files, id, { label: `卷${id}` });
      const disk = mockSessionDisk(files);

      await panel.listSavedSessions(P);
      const afterFirst = disk.volumeReads().length;
      expect(afterFirst).toBeGreaterThan(0); // 首次必须真读（补建）

      const second = await panel.listSavedSessions(P);
      expect(second).toHaveLength(5);
      expect(disk.volumeReads().length).toBe(afterFirst); // 稳态：一卷体都不读

      // 模拟重启（进程内态清空）→ 从 _index.json 重建，仍不读卷体
      Session.resetSessionListCacheForTests();
      const third = await panel.listSavedSessions(P);
      expect(third).toHaveLength(5);
      expect(third.map((r) => r.label)).toEqual(['卷1', '卷2', '卷3', '卷4', '卷5'].sort());
      expect(disk.volumeReads().length).toBe(afterFirst);
    });

    it('对账：盘上新出现的卷补建、盘上没了的卷从清单消失', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '甲' });
      const disk = mockSessionDisk(files);
      await panel.listSavedSessions(P);

      // 外部新增一卷（本进程没写过它）→ 对账发现 → 补建
      seedVolume(files, 7, { label: '新卷', savedAt: '2026-09-01T00:00:00Z' });
      const withNew = await panel.listSavedSessions(P);
      expect(withNew.map((r) => r.id)).toEqual([7, 1]);
      expect(disk.volumeReads().some((p) => p.endsWith('/7.ndjson'))).toBe(true);

      // 外部删除一卷 → 对账摘掉（不读盘）
      delete files[`${ROOT}/1.ndjson`];
      delete files[`${ROOT}/1.json`];
      const before = disk.volumeReads().length;
      const afterDelete = await panel.listSavedSessions(P);
      expect(afterDelete.map((r) => r.id)).toEqual([7]);
      expect(disk.volumeReads().length).toBe(before);
      expect(Object.keys(catalogOfDisk(files).rows)).toEqual(['7']); // 摘行也落盘
    });

    it('卷目录坏档/版本不认 → 自愈重建（按空目录补建并覆写）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 3, { label: '丙' });
      files[`${ROOT}/_index.json`] = '{"ver":999,"rows":{"3":{"label":"坏","savedAt":"","msgCount":0}}}';
      mockSessionDisk(files);

      const result = await panel.listSavedSessions(P);
      expect(result.map((r) => r.id)).toEqual([3]);
      expect(result[0].label).toBe('丙'); // 真值来自卷体，不采信不认版本的目录
      expect(catalogOfDisk(files).ver).toBe(2);
    });

    it('v1 目录（无血缘栏）不认版本 → 整份重建：血缘从卷日志头行一次到位', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      // 卷 2 是从卷 1 的 seq 1 分出的枝
      seedVolume(files, 1, { label: '父卷' });
      seedVolume(files, 2, { label: '枝卷', parent: { id: 1, atSeq: 1 } });
      // v1 目录：行里没有 parentId（P2 之前的形状）
      files[`${ROOT}/_index.json`] =
        '{"ver":1,"rows":{"1":{"label":"父卷","savedAt":"2026-01-01T00:00:00Z","msgCount":1},' +
        '"2":{"label":"枝卷","savedAt":"2026-01-01T00:00:00Z","msgCount":1}}}';
      const disk = mockSessionDisk(files);

      const result = await panel.listSavedSessions(P);
      expect(result.find((r) => r.id === 1)?.parentId).toBeUndefined(); // 根卷无父
      expect(result.find((r) => r.id === 2)?.parentId).toBe(1); // 枝卷的边
      expect(disk.volumeReads().length).toBeGreaterThan(0); // 重建 = 真读头行
      expect(catalogOfDisk(files).ver).toBe(2);
      expect((catalogOfDisk(files).rows as Record<string, { parentId?: number }>)['2']?.parentId).toBe(1);
    });

    it('血缘在稳态清点里也不丢：重启后从 _index.json 取回（不重读卷体）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '父卷' });
      seedVolume(files, 2, { label: '枝卷', parent: { id: 1, atSeq: 1 } });
      const disk = mockSessionDisk(files);
      await panel.listSavedSessions(P);
      const reads = disk.volumeReads().length;

      Session.resetSessionListCacheForTests(); // 模拟重启
      const again = await panel.listSavedSessions(P);
      expect(again.find((r) => r.id === 2)?.parentId).toBe(1);
      expect(disk.volumeReads().length).toBe(reads); // 血缘随目录走，不额外读盘
    });

    it('写面不新建行（血缘只有头行一个真源）：写面先跑也不丢边，更新已建行更不抹边', async () => {
      panel = createChatPanel();
      useShellStore.setState({ projectPath: P });
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '父卷' });
      const disk = mockSessionDisk(files);

      // 立枝的盘上结果：新卷 2 带血缘，**目录里还没有它的行**——写面先跑一步
      // （改名即存走 writeSessionSnapshot → upsertCatalogRow；它不知道血缘）
      seedVolume(files, 2, { label: '', parent: { id: 1, atSeq: 1 } });
      await panel.renameSavedSession(2, '枝卷');

      const rows = await panel.listSavedSessions(P);
      expect(rows.find((r) => r.id === 2)?.parentId).toBe(1); // 行由补建读头行建
      expect(disk.volumeReads().some((p) => p.replace(/\\/g, '/').endsWith('/2.ndjson'))).toBe(true);

      // 再写一次（写面更新**已建**行）——边不丢
      await panel.renameSavedSession(2, '枝卷二');
      const again = await panel.listSavedSessions(P);
      expect(again.find((r) => r.id === 2)?.parentId).toBe(1);
      expect(again.find((r) => r.id === 2)?.label).toBe('枝卷二');
    });

    it('非卷文件与保留名不进清单（_active.json / _index.json / 非 .ndjson）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '甲' });
      files[`${ROOT}/_active.json`] = '{}';
      files[`${ROOT}/readme.md`] = '# nope';
      files[`${ROOT}/12.json`] = cacheText(12, { label: '旧投影缓存（无日志 = 无卷）' });
      mockSessionDisk(files);

      const result = await panel.listSavedSessions(P);
      expect(result.map((r) => r.id)).toEqual([1]);
      expect(result[0].msgCount).toBe(1); // 只数非 system 消息
    });

    it('单卷读失败不影响其余卷（该卷本轮不重试，错误可见）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '甲' });
      seedVolume(files, 2, { label: '乙' });
      const disk = mockSessionDisk(files, { failRead: (p) => p.replace(/\\/g, '/').endsWith('/1.ndjson') });

      const result = await panel.listSavedSessions(P);
      expect(result.map((r) => r.id)).toEqual([2]);
      const reads = disk.volumeReads().length;
      await panel.listSavedSessions(P); // 失败卷不反复重试
      expect(disk.volumeReads().length).toBe(reads);
    });

    it('挂死的卷读不吊死清点（预算护栏 + 后台补建）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '甲' });
      seedVolume(files, 2, { label: '乙' });
      mockSessionDisk(files, { hangRead: (p) => p.replace(/\\/g, '/').endsWith('/1.ndjson') });

      const started = Date.now();
      const result = await panel.listSavedSessions(P);
      expect(Date.now() - started).toBeLessThan(6000); // 首屏不被挂死卷吊住
      expect(result.map((r) => r.id)).toEqual([2]); // 可读的卷照常出
    });

    it('读面失败不伪装成空集：目录枚举失败上抛；空工作区返回 []', async () => {
      panel = createChatPanel();
      mockInvoke.mockReset();
      mockInvoke.mockRejectedValue(new Error('dir not found'));
      await expect(panel.listSavedSessions(P)).rejects.toThrow(/案卷目录枚举失败/);

      mockInvoke.mockReset();
      mockInvoke.mockResolvedValue('not an array');
      await expect(panel.listSavedSessions(P)).rejects.toThrow(/案卷目录枚举失败/);

      mockInvoke.mockReset();
      await expect(panel.listSavedSessions('')).resolves.toEqual([]);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('几百卷规模：补建一次之后，清点成本与历史体量**无关**（零卷体读）', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      const N = 300;
      for (let id = 1; id <= N; id++) {
        seedVolume(files, id, {
          label: `卷${id}`,
          savedAt: `2026-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        });
      }
      const disk = mockSessionDisk(files);

      const first = await panel.listSavedSessions(P);
      expect(first).toHaveLength(N);
      expect(Object.keys(catalogOfDisk(files).rows)).toHaveLength(N); // 一次补建，全量落盘
      const readsAfterFirst = disk.volumeReads().length;
      expect(readsAfterFirst).toBeGreaterThanOrEqual(N); // 首次确实逐卷读过

      // 稳态：无论 300 卷还是 3 卷，都是一次目录枚举 + 一份小 JSON
      const t0 = Date.now();
      const second = await panel.listSavedSessions(P);
      const elapsed = Date.now() - t0;
      expect(second).toHaveLength(N);
      expect(disk.volumeReads().length).toBe(readsAfterFirst);
      expect(elapsed).toBeLessThan(150);

      // 模拟重启：从盘上的目录重建，仍不读卷体
      Session.resetSessionListCacheForTests();
      expect(await panel.listSavedSessions(P)).toHaveLength(N);
      expect(disk.volumeReads().length).toBe(readsAfterFirst);
    });

    it('写面就地更行 + 落盘：改名/删除不必重扫卷体，且广播卷清单变更', async () => {
      panel = createChatPanel();
      const files: Record<string, string> = {};
      seedVolume(files, 1, { label: '旧名', savedAt: '2026-01-01T00:00:00Z' });
      const disk = mockSessionDisk(files);
      await panel.listSavedSessions(P);

      const tickBefore = useSessionVolumesStore.getState().volumesTick;
      const readsBefore = disk.volumeReads().length;
      await Session.renameSessionFile(P, 1, '新名'); // 真实写路 → 写面就地更行
      expect(useSessionVolumesStore.getState().volumesTick).toBe(tickBefore + 1);

      const renamed = await panel.listSavedSessions(P);
      expect(renamed[0].label).toBe('新名');
      // 改名自身读两跳：投影缓存（读-改-写）+ 事件日志（**同代校验**要卷的立卷时刻，
      // 见 `cacheOfThisVolume`——不读就分不清「本卷的缓存」与「上一代残留」，
      // 残留一旦被展开改名，死卷的消息表/账本就被写成新卷的快照）；清点仍零卷体读。
      const afterRename = disk.volumeReads().length;
      expect(afterRename).toBe(readsBefore + 2);
      expect(Object.values(catalogOfDisk(files).rows)[0]).toMatchObject({ label: '新名' });

      await panel.deleteSessionFile(P, 1);
      await expect(panel.listSavedSessions(P)).resolves.toEqual([]);
      expect(disk.volumeReads().length).toBe(afterRename); // 删除 + 清点零卷体读
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // autoRestoreLastSession — U4/Q1-B 扫描推导（恢复 = 磁盘扫描取最近卷）
  // ═══════════════════════════════════════════════════════════════

  describe('autoRestoreLastSession（Q-B：不自动摊开，只发号对账）', () => {
    it('completes fast when scan rejects（回归：后端不可用不挂起）', async () => {
      panel = createChatPanel();
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [{ role: 'system', content: 'sys' }],
            setSession: vi.fn(),
            run: vi.fn(),
          }) as any,
      );
      panel.setProjectPath('D:/test');

      // 扫描全拒 → 空列表 → 空态（不挂起、不建兜底卷）
      mockInvoke.mockRejectedValue(new Error('backend down'));

      const start = Date.now();
      await panel.autoRestoreLastSession('D:/test');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      // Q-B：不摊开不建卷，sess 空态常态（落案卷首页自选）
      expect(Session.getSessions(panel.panelId)).toHaveLength(0);
    });

    it('扫描全拒/空：无 notice、无兜底卷（Q-B 空态常态）', async () => {
      panel = createChatPanel();
      panel.setProjectPath('D:/test');

      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [{ role: 'system', content: 'sys' }],
            setSession: vi.fn(),
          }) as any,
      );

      mockInvoke.mockRejectedValue(new Error('no volumes'));

      await panel.autoRestoreLastSession('D:/test');

      const sessions = Session.getSessions(panel.panelId);
      expect(sessions).toHaveLength(0); // 不摊开、不建兜底
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listSavedSessions — 补建并发（老「parallel + timeout」批的承继面）
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions — 补建并发', () => {
    it('首次补建并发读（不是串行）', async () => {
      panel = createChatPanel();
      const P = 'D:/par-proj';
      const files: Record<string, string> = {};
      for (const id of [1, 2, 3, 4, 5]) {
        files[`${P}/.lantai/sessions/${id}.ndjson`] = logText(id, [{ role: 'user', content: `msg-${id}` }]);
        files[`${P}/.lantai/sessions/${id}.json`] = cacheText(id, { label: `卷${id}` });
      }
      // 并发度用**在途计数**钉（不用墙钟——机器被占满时绝对耗时断言必假红，
      // 见 CONVENTIONS §3「待机红线是超时不是逻辑」）
      let inFlight = 0;
      let maxInFlight = 0;
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = String(params.file_path);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve, reject) =>
              setTimeout(() => {
                inFlight -= 1;
                if (fp in files) resolve(files[fp]);
                else reject(new Error('文件不存在'));
              }, 10),
            );
          }
          if (method === 'list_directory') {
            const dir = String(params.path);
            const entries = Object.keys(files)
              .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
              .map((p) => ({ name: p.split('/').pop(), path: p, is_dir: false, children: null }));
            return Promise.resolve(JSON.stringify(entries));
          }
          return Promise.resolve('ok');
        }),
      );

      const result = await panel.listSavedSessions(P);

      expect(result).toHaveLength(5);
      expect(maxInFlight).toBeGreaterThan(1); // 串行实现恒 = 1
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // saveActiveSession → setAgent → autoRestoreLastSession race
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // setAgent(null) — 显式拆除（2026-08-07 B2 回归）：
  // API Key 清空后旧 provider/工厂不得继续服务会话。
  // 旧实现 `if (!agent) return` 早退 — 工厂与句柄全部残留。
  // ═══════════════════════════════════════════════════════════════

  describe('setAgent(null) teardown', () => {
    it('clears the factory and disposes all session agents', async () => {
      panel = createChatPanel();
      const dispose = vi.fn();
      const fakeAgent = {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose,
      };
      panel.setAgent(fakeAgent as any);
      panel.setAgentFactory(async () => fakeAgent as any);
      // 零目录退役（Stage-5）：创建必须要有目录——先绑定工作区再建卷
      panel.setProjectPath('D:/test');
      // 归零重建：setAgent 不铺卷——建卷 1 领预留句柄（disposable 面可测）
      await panel.createNewSession();
      expect(panel.getAgent()).toBeTruthy();
      expect(Session.getAgentFactory(panel.panelId)).not.toBeNull();

      panel.setAgent(null);

      // 工厂注销 + 句柄 dispose + 活动 agent 清空
      expect(Session.getAgentFactory(panel.panelId)).toBeNull();
      expect(panel.getAgent()).toBeNull();
      expect(dispose).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Internal meta-message filtering on restore
  // Agent injects <system-reminder>, <goal>, <truncated-context> as
  // role=user into the session. These must NOT appear as visible chat
  // bubbles after restore / export.
  // ═══════════════════════════════════════════════════════════════

  describe('internal meta-message filtering on restore', () => {
    const INTERNAL_MESSAGES = [
      '<system-reminder>some recall context</system-reminder>',
      '<goal>## 总体目标\n完成项目</goal>',
      '<truncated-context>前面的消息已被截断</truncated-context>',
      '<compacted-context>压缩内容</compacted-context>',
    ];

    const REAL_USER_MSG = '帮我分析这个项目';
    const REAL_ASSISTANT_MSG = '好的，正在分析…';

    /** A session with internal messages interleaved with real conversation */
    const sessionWithInternalMsgs = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: '<system-reminder>recall</system-reminder>' },
      { role: 'user', content: REAL_USER_MSG },
      { role: 'assistant', content: REAL_ASSISTANT_MSG },
      { role: 'user', content: '<goal>## 总体目标\n完成</goal>' },
      { role: 'user', content: '<truncated-context>已截断</truncated-context>' },
      { role: 'user', content: '<compacted-context>压缩</compacted-context>' },
    ];

    function setupRestorePanel(mockSessionMessages: any[]) {
      panel = createChatPanel();
      panel.setProjectPath('D:/test');

      // Mock agent that actually stores session messages passed via setSession
      let agentSession: any[] = [{ role: 'system', content: 'fresh sys' }];
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => agentSession,
            setSession: (msgs: any[]) => {
              agentSession = msgs;
            },
          }) as any,
      );

      // 归零重建：从首页打开历史卷 = 工作区会话根单读（归属即存储位置）
      const vol1 = logText(1, mockSessionMessages, undefined, 'D:/test');
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: { method: string; params: Record<string, unknown> }) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = params.file_path as string;
            if (fp === 'D:/test/.lantai/sessions/1.ndjson') return Promise.resolve(vol1);
            return Promise.reject(new Error('文件不存在'));
          }
          return Promise.resolve(null);
        }),
      );

      return panel.loadSessionFromDisk('D:/test', 1);
    }

    it('does not render internal messages as user bubbles', async () => {
      await setupRestorePanel(sessionWithInternalMsgs);

      const { msgStoreFor } = await import('../src/ui/chat-store');
      const msgs = msgStoreFor(panel.panelId, 1).getState().messages;

      const userMsgs = msgs.filter((m: any) => m.role === 'user');
      const userTexts = userMsgs.map((m: any) => m.text);

      // Only the real user message should appear
      expect(userMsgs).toHaveLength(1);
      expect(userTexts).toContain(REAL_USER_MSG);

      // None of the internal messages should leak through
      for (const internal of INTERNAL_MESSAGES) {
        expect(userTexts).not.toContain(internal);
      }
    });

    it('renders compacted-context as a notice, not a user bubble', async () => {
      await setupRestorePanel(sessionWithInternalMsgs);

      const { msgStoreFor } = await import('../src/ui/chat-store');
      const msgs = msgStoreFor(panel.panelId, 1).getState().messages;

      const notices = msgs.filter((m: any) => m.role === 'notice');
      expect(notices.length).toBeGreaterThan(0);
      expect(notices.some((n: any) => n.text.includes('上下文已压缩'))).toBe(true);
    });

    it('preserves real user and assistant messages alongside filtered internals', async () => {
      await setupRestorePanel(sessionWithInternalMsgs);

      const { msgStoreFor } = await import('../src/ui/chat-store');
      const msgs = msgStoreFor(panel.panelId, 1).getState().messages;

      const userMsgs = msgs.filter((m: any) => m.role === 'user');
      const assistantMsgs = msgs.filter((m: any) => m.role === 'assistant');

      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].text).toBe(REAL_USER_MSG);
      expect(assistantMsgs).toHaveLength(1);
      // Assistant text is in parts — find the text part
      const textParts = assistantMsgs[0].parts.filter((p: any) => p.type === 'text');
      expect(textParts.length).toBeGreaterThan(0);
      expect(textParts[0].text).toBe(REAL_ASSISTANT_MSG);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C8 合卷自动存：closeSession 被合卷先落盘（含背景卷）再 dispose
  // ═════════════════════════════════════════════════════════

  describe('C8 closeSession auto-archive', () => {
    const PROJ = 'D:/c8-proj';

    function makeAgent(content: string) {
      return {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(), // removeExec 级联中止面（真实 Agent 自带，桩补齐）
      };
    }

    /** 两卷现场：卷 1（背景，有内容）+ 卷 2（活跃）。返回捕获的写入调用。
     *  归零重建：setAgent 不铺卷——seed 的 createNewSession 领预留句柄（agent1）建卷 1。 */
    function setupTwoVolumes() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const agent1 = makeAgent('卷一的内容');
      panel.setAgent(agent1 as any);
      const agent2 = makeAgent('卷二的内容');
      panel.setAgentFactory(async () => agent2 as any);

      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'write_file_content') {
            writes.push({ file_path: params.file_path as string, content: params.content as string });
          }
          return Promise.resolve('ok');
        }),
      );
      // DSH 形态：两卷都走工厂现造（工厂依次返回 agent1、agent2）
      let call = 0;
      panel.setAgentFactory(async () => (call++ === 0 ? agent1 : agent2) as any);
      return {
        agent1,
        agent2,
        writes,
        seed: async () => {
          await panel.createNewSession(); // 卷 1（工厂第一次调用 = agent1）
          await panel.createNewSession(); // 卷 2（工厂第二次调用 = agent2）
        },
      };
    }

    it('合背景卷：先落盘该卷内容再移除（写 /1.json 带该卷消息）', async () => {
      const { agent1, writes, seed } = setupTwoVolumes();
      await seed();

      panel.closeSession(0); // 合背景卷 1

      // 归零重建：写目标同步直取全局位；排干微任务后断言（沿用既有节奏）
      await new Promise((r) => setTimeout(r, 0));
      expect(agent1.dispose).toHaveBeenCalled();
      const write1 = writes.find((w) => w.file_path.endsWith('/1.json'));
      expect(write1).toBeTruthy();
      const parsed = JSON.parse(write1!.content);
      expect(parsed.id).toBe(1);
      expect(parsed.messages.some((m: any) => m.content === '卷一的内容')).toBe(true);
      // 卷 1 已从会话列表移除
      const sessions = Session.getSessions(panel.panelId);
      expect(sessions.some((s) => s.id === 1)).toBe(false);
    });

    it('合活跃卷：同样先落盘（写 /2.json 带活跃卷消息）', async () => {
      const { writes, seed } = setupTwoVolumes();
      await seed();

      panel.closeSession(1); // 合活跃卷 2

      // 归零重建：排干微任务后断言（见合背景卷用例注释）
      await new Promise((r) => setTimeout(r, 0));
      const write2 = writes.find((w) => w.file_path.endsWith('/2.json'));
      expect(write2).toBeTruthy();
      const parsed = JSON.parse(write2!.content);
      expect(parsed.messages.some((m: any) => m.content === '卷二的内容')).toBe(true);
    });

    it('空卷（仅 system）合卷不落盘', async () => {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      // 双卷现场：卷 1 空卷（仅 system）+ 卷 2 有内容——合空卷须真正执行
      // （此前单卷靠「至少保留一卷案卷」守卫短路假绿，守卫已随画布模型移除）。
      const emptyAgent = {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      const contentAgent = makeAgent('有内容');
      let call = 0;
      panel.setAgentFactory(async () => (call++ === 0 ? emptyAgent : contentAgent) as any);
      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'write_file_content') {
            writes.push({ file_path: params.file_path as string, content: params.content as string });
          }
          return Promise.resolve('ok');
        }),
      );
      await panel.createNewSession(); // 卷 1（空卷）
      await panel.createNewSession(); // 卷 2（有内容）

      panel.closeSession(0); // 合空卷 1

      // 空卷（仅 system）合卷不落盘——快照捕获 hasContent 守卫
      await new Promise((r) => setTimeout(r, 0));
      expect(writes.find((w) => w.file_path.endsWith('/1.json'))).toBeUndefined();
    });

    it('合最后一卷（closeSession）：空画布（会话清空 + 流区移除），快照仍落盘可再摊开', async () => {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'write_file_content') {
            writes.push({ file_path: params.file_path as string, content: params.content as string });
          }
          return Promise.resolve('ok');
        }),
      );
      const agent = makeAgent('最后一卷的内容');
      panel.setAgentFactory(async () => agent as any);
      await panel.createNewSession();
      const sid = Session.getSessions(panel.panelId)[0].id;
      expect(Session.getSessions(panel.panelId)).toHaveLength(1);
      // 摊开该卷（流区落画布）
      const canvas = getCanvasStore(panel.panelId).getState();
      canvas.setRegion(String(sid), { anchorX: 0, anchorY: 0, width: 1440 });

      panel.closeSession(0); // 合唯一一卷——不再被「至少保留一卷案卷」守卫拦下

      // 画布清空：会话列表空 + activeIdx=-1（空画布 = 合法态，与删除唯一卷同规）
      expect(Session.getSessions(panel.panelId)).toHaveLength(0);
      expect(getChatStore(panel.panelId).sess.getState().activeIdx).toBe(-1);
      // 流区随卷退场
      expect(getCanvasStore(panel.panelId).getState().getRegion(String(sid))).toBeUndefined();
      // 合卷语义 = 数据保留：快照仍落盘（侧边栏「未摊开·已存卷」可再摊开）
      await new Promise((r) => setTimeout(r, 0));
      const write = writes.find((w) => w.file_path.endsWith(`/${sid}.json`));
      expect(write).toBeTruthy();
      const parsed = JSON.parse(write!.content);
      expect(parsed.messages.some((m: any) => m.content === '最后一卷的内容')).toBe(true);
    });

    it('合卷落盘带 token 账本（2026-09-18 修：重开该卷账本不再归零）', async () => {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'write_file_content') {
            writes.push({ file_path: params.file_path as string, content: params.content as string });
          }
          return Promise.resolve('ok');
        }),
      );
      const ledger = {
        version: 1,
        totals: { uncachedInputTokens: 120, cacheReadTokens: 880, cacheWriteTokens: 0, outputTokens: 40 },
        attempts: 2,
        turns: [],
      };
      const agent = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '账本卷的内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
        snapshotTokenLedger: () => ledger,
        sessionLog: { lastSeq: 42 },
      };
      panel.setAgentFactory(async () => agent as any);
      await panel.createNewSession();

      panel.closeSession(0); // 合卷 = 该卷最后一次落盘（此前这条路径不写 tokens/seq/ver）

      await new Promise((r) => setTimeout(r, 0));
      const write = writes.find((w) => w.file_path.endsWith('/1.json'));
      expect(write).toBeTruthy();
      const parsed = JSON.parse(write!.content);
      expect(parsed.tokens).toEqual(ledger); // 旧行为：字段缺席 → 重开卷四桶全 0、缓存命中「—」
      expect(parsed.seq).toBe(42);
      expect(typeof parsed.ver).toBe('number');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 画布公共物与摊开集合（Stage-5 工作区级）：布局/钉住/纸条不再随卷快照——
  // 属于工作区画布状态（state/canvas-store），会话文件不再携带 paper 字段。
  // ═══════════════════════════════════════════════════════════════

  describe('canvas state persistence (Stage-5 工作区级)', () => {
    const PROJ = 'D:/paper-test';

    /** 起一卷有内容的案卷，返回捕获的 write 记录数组。 */
    async function setupVolumeWithContent(writes: Array<{ file_path: string; content: string }>) {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [
              { role: 'system', content: 'sys' },
              { role: 'user', content: '钉住我' },
            ],
            setSession: vi.fn(),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
          }) as any,
      );
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'write_file_content') {
            writes.push({ file_path: params.file_path as string, content: params.content as string });
          }
          return Promise.resolve('ok');
        }),
      );
      await panel.createNewSession();
      return panel;
    }

    it('saveActiveSession 落盘 JSON 不再携带 paper（布局/公共物已升格工作区级）', async () => {
      const writes: Array<{ file_path: string; content: string }> = [];
      await setupVolumeWithContent(writes);

      // 钉住块/纸条现在写 canvas-store（工作区级），不随会话快照
      const canvasStore = getCanvasStore(panel.panelId).getState();
      const sid = Session.getSessions(panel.panelId)[0].id;
      const block = createBlock('markdown', { text: '钉住内容' }, { messageId: 'm1', part: null });
      canvasStore.setPin(block.id, {
        x: 800,
        y: -600,
        w: block.w,
        source: { sessionId: sid, blockId: block.id },
        snapshot: snapshotFromBlock(block),
      });
      canvasStore.addStrip(makeStrip('引用片段', 900, -300, 480, { messageId: 'm1' }));

      await panel.saveActiveSession(PROJ);

      const write = writes.find((w) => w.file_path.endsWith(`/${sid}.json`));
      expect(write).toBeTruthy();
      const parsed = JSON.parse(write!.content);
      expect(parsed.paper).toBeUndefined();
      // 公共物在 canvas-store（工作区级）——不随卷落盘
      expect(getCanvasStore(panel.panelId).getState().pins[block.id]).toMatchObject({ x: 800, y: -600 });
      expect(getCanvasStore(panel.panelId).getState().strips).toHaveLength(1);
    });

    it('合卷（closeSession）：流区从摊开集合移除、公共物钉保留（钉到拔为止）', async () => {
      const writes: Array<{ file_path: string; content: string }> = [];
      await setupVolumeWithContent(writes);
      // 起第二卷，让第一卷可被合掉
      const agent2 = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '卷二' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgentFactory(async () => agent2 as any);
      await panel.createNewSession();

      // 摊开卷一 + 钉卷一（背景卷）的块
      const canvasStore = getCanvasStore(panel.panelId).getState();
      canvasStore.setRegion('1', { anchorX: 0, anchorY: 0, width: 1440 });
      const block = createBlock('markdown', { text: '钉住内容' }, { messageId: 'm1', part: null });
      canvasStore.setPin(block.id, {
        x: 100,
        y: -100,
        w: block.w,
        source: { sessionId: 1, blockId: block.id },
        snapshot: snapshotFromBlock(block),
      });

      panel.closeSession(0); // 合卷一

      await new Promise((r) => setTimeout(r, 0));
      const write1 = writes.find((w) => w.file_path.endsWith('/1.json'));
      expect(write1).toBeTruthy();
      const parsed = JSON.parse(write1!.content);
      expect(parsed.paper).toBeUndefined();
      // 卷一从摊开集合移除（流区退场不重排）；公共物钉保留
      expect(getCanvasStore(panel.panelId).getState().spread['1']).toBeUndefined();
      expect(getCanvasStore(panel.panelId).getState().pins[block.id]).toMatchObject({ x: 100, y: -100 });
    });

    it('loadSessionFromDisk：会话文件里的旧 paper 字段不再回灌（只读工作区画布状态）', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      const agent2 = {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgentFactory(async () => agent2 as any);
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            // Phase 3b：卷内容 = 事件日志（`.ndjson`）。旧 `paper` 字段是**快照时代**
            // 的字段，事件日志里根本无从承载——「不回灌」由结构保证（属性退役）。
            return Promise.resolve(
              logText(5, [
                { role: 'system', content: 'sys' },
                { role: 'user', content: '旧消息' },
              ]),
            );
          }
          void params;
          return Promise.resolve('ok');
        }),
      );

      await panel.loadSessionFromDisk(PROJ, 5);

      // 会话文件里的旧 paper 是惰性字段——不回灌 canvas-store（工作区级由
      // 工作区画布状态文件提供，不在卷文件里）
      const canvas = getCanvasStore(panel.panelId).getState();
      expect(canvas.pins).toEqual({});
      expect(canvas.strips).toEqual([]);
      // 会话本身照常打开
      expect(Session.getSessions(panel.panelId).some((s) => s.id === 5)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Stage-5 收尾：恢复摊开集 + 删卷公共物不连坐 + 零目录退役（bind/archive）
  // ═══════════════════════════════════════════════════════════════

  describe('Stage-5 canvas restore & zero-dir retirement', () => {
    const PROJ = 'D:/restore-test';

    it('restoreCanvasSpread：读工作区画布状态文件 → 摊开集合落回画布 + 活跃会话', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const agent2 = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '旧消息' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgentFactory(async () => agent2 as any);
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = params.file_path as string;
            if (fp.endsWith('/.lantai/canvas.json')) {
              return Promise.resolve(
                JSON.stringify({
                  version: 1,
                  spread: [{ sessionId: 5, anchorX: 6480, anchorY: -1200, width: 1440 }],
                  activeSessionId: 5,
                  publics: { pinned: {}, strips: [] },
                }),
              );
            }
            if (fp.endsWith('/5.ndjson')) {
              // Phase 3b：卷内容 = 事件日志（不再是快照 JSON）
              return Promise.resolve(
                logText(5, [
                  { role: 'system', content: 'sys' },
                  { role: 'user', content: 'hi' },
                ]),
              );
            }
          }
          return Promise.resolve('ok');
        }),
      );

      await panel.restoreCanvasSpread(PROJ);

      // 摊开集合恢复：卷 5 已摊开 + 位置从画布状态文件恢复
      expect(Session.getSessions(panel.panelId).map((s) => s.id)).toContain(5);
      expect(getCanvasStore(panel.panelId).getState().getRegion('5')).toEqual({
        anchorX: 6480,
        anchorY: -1200,
        width: 1440,
      });
      // 活跃会话恢复（创作坞/输入条跟随）
      const st = getChatStore(panel.panelId).sess.getState();
      expect(st.sessions[st.activeIdx]?.id).toBe(5);
    });

    it('restoreCanvasSpread 自愈：画布摊开集引用磁盘不存在的卷 → 剪枝幽灵流区（不弹读取失败）', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const agent2 = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '旧消息' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgentFactory(async () => agent2 as any);
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'list_directory') {
            // 磁盘只有卷 5 的会话文件——卷 6 是幽灵（画布引用了它但文件不存在）
            return Promise.resolve(
              JSON.stringify([
                { name: '5.ndjson', path: 'D:/restore-test/.lantai/sessions/5.json', is_dir: false, children: null },
              ]),
            );
          }
          if (method === 'read_file_content') {
            const fp = params.file_path as string;
            if (fp.endsWith('/.lantai/canvas.json')) {
              return Promise.resolve(
                JSON.stringify({
                  version: 1,
                  spread: [
                    { sessionId: 5, anchorX: 6480, anchorY: -1200, width: 1440 },
                    { sessionId: 6, anchorX: 0, anchorY: 0, width: 1440 },
                  ],
                  activeSessionId: 5,
                  publics: { pinned: {}, strips: [] },
                }),
              );
            }
            if (fp.endsWith('/5.ndjson')) {
              return Promise.resolve(logText(5, [{ role: 'user', content: 'hi' }], undefined, PROJ));
            }
          }
          return Promise.resolve('ok');
        }),
      );

      await panel.restoreCanvasSpread(PROJ);

      // 卷 5 摊开并加载；卷 6 幽灵被剪枝（不摊开、不弹「案卷文件读取失败」）
      expect(Session.getSessions(panel.panelId).map((s) => s.id)).toContain(5);
      expect(Session.getSessions(panel.panelId).map((s) => s.id)).not.toContain(6);
      expect(Object.keys(getCanvasStore(panel.panelId).getState().spread)).toEqual(['5']);
    });

    it('deleteSessionFile：流区移除、公共物钉保留（公共物不连坐，钉到拔为止）', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [
              { role: 'system', content: 'sys' },
              { role: 'user', content: '内容' },
            ],
            setSession: vi.fn(),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
          }) as any,
      );
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            return Promise.resolve(
              JSON.stringify({
                id: 7,
                label: '卷七',
                workspace: PROJ,
                messages: [
                  { role: 'system', content: 'sys' },
                  { role: 'user', content: 'hi' },
                ],
              }),
            );
          }
          void params;
          return Promise.resolve('ok');
        }),
      );
      await panel.createNewSession();
      const canvas = getCanvasStore(panel.panelId).getState();
      const sid = Session.getSessions(panel.panelId)[0].id;
      canvas.setRegion(String(sid), { anchorX: 0, anchorY: 0, width: 1440 });
      const block = createBlock('markdown', { text: '公共钉' }, { messageId: 'm1', part: null });
      canvas.setPin(block.id, {
        x: 100,
        y: -100,
        w: block.w,
        source: { sessionId: sid, blockId: block.id },
        snapshot: snapshotFromBlock(block),
      });

      await panel.deleteSessionFile(PROJ, sid);

      // 流区从摊开集合移除（卷没了）；公共物钉保留（不连坐）
      const after = getCanvasStore(panel.panelId).getState();
      expect(after.getRegion(String(sid))).toBeUndefined();
      expect(after.getPin(block.id)).toMatchObject({ x: 100, y: -100 });
    });

    it('deleteSessionFile 删除唯一/最后一卷：标签页关闭（不僵尸、不复活）', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [{ role: 'system', content: 'sys' }],
            setSession: vi.fn(),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
          }) as any,
      );
      mockInvoke.mockReset();
      mockInvoke.mockResolvedValue('ok');
      await panel.createNewSession();
      const sid = Session.getSessions(panel.panelId)[0].id;
      expect(Session.getSessions(panel.panelId)).toHaveLength(1);

      await panel.deleteSessionFile(PROJ, sid);

      // 唯一/最后一卷删除 → 标签页随之关闭（closeSession 的「至少保留一卷」
      // 守卫是合卷语义，删除语义下允许清空——否则僵尸标签页 + 自动保存复活）
      expect(Session.getSessions(panel.panelId)).toHaveLength(0);
      expect(getChatStore(panel.panelId).sess.getState().activeIdx).toBe(-1);
    });

    it('deleteSessionFile 标记源会话已删：孤儿钉「收回」失效（画布渲染为「删除」的数据基础）', async () => {
      resetCanvasStoresForTests();
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [{ role: 'system', content: 'sys' }],
            setSession: vi.fn(),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
          }) as any,
      );
      mockInvoke.mockReset();
      mockInvoke.mockResolvedValue('ok');
      await panel.createNewSession();
      const sid = Session.getSessions(panel.panelId)[0].id;
      // 模拟该卷有一个钉住块（源指向本卷）
      const canvas = getCanvasStore(panel.panelId).getState();
      canvas.setPin('pin-a', {
        x: 0,
        y: 0,
        w: 480,
        source: { sessionId: sid, blockId: 'b1' },
        snapshot: { kind: 'markdown', text: '快照' },
      });

      await panel.deleteSessionFile(PROJ, sid);

      // 源卷已删 → deletedSessionIds 含该 id（PaperPanel 据此渲染「删除」而非「收回」）
      expect(getCanvasStore(panel.panelId).getState().deletedSessionIds.has(sid)).toBe(true);
      // 切换工作区（loadCanvas(null)）→ 标记清空
      await loadCanvasFromDisk(panel.panelId, 'D:/other-ws');
      expect(getCanvasStore(panel.panelId).getState().deletedSessionIds.size).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // M4：会话级消息 store 生命周期 — 卷消亡必须拆注册表项（无界内存拆除）
  // ═══════════════════════════════════════════════════════════════

  describe('M4 per-session message store disposal', () => {
    const PROJ = 'D:/m4-proj';

    function makeAgent() {
      return {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '有内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
    }

    /** 判定某卷的 msg store 是否已被拆除：拆除后惰性重建为全新实例
     *  （messages 空 + version 归零）；活 store 的 setMessages 用
     *  Date.now() 起版，version 恒 > 0。 */
    function isStoreFresh(panelId: string, sid: number): boolean {
      const st = getMessagesStore(`${panelId}:${sid}`).getState();
      return st.messages.length === 0 && st.version === 0;
    }

    function seedMsgStore(panelId: string, sid: number, text: string) {
      msgStoreFor(panelId, sid)
        .getState()
        .setMessages([{ _id: `m-${sid}`, role: 'user', content: text } as any]);
    }

    /** 两卷现场（归零重建：setAgent 不铺卷——两次 createNewSession 建卷 1/2），各自 seed 消息。 */
    async function setupTwoSeededVolumes() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(async () => makeAgent() as any);
      await panel.createNewSession(); // 卷 1（工厂现造）
      await panel.createNewSession(); // 卷 2（工厂现造）
      seedMsgStore(panel.panelId, 1, '卷一消息');
      seedMsgStore(panel.panelId, 2, '卷二消息');
      expect(isStoreFresh(panel.panelId, 1)).toBe(false);
      expect(isStoreFresh(panel.panelId, 2)).toBe(false);
    }

    it('合卷：被合卷的消息 store 从注册表移除，其余活卷不受影响', async () => {
      await setupTwoSeededVolumes();

      panel.closeSession(0); // 合卷一

      // 卷一 store 已拆（重建为空实例）；卷二保留内存态
      expect(isStoreFresh(panel.panelId, 1)).toBe(true);
      expect(isStoreFresh(panel.panelId, 2)).toBe(false);
      expect(
        msgStoreFor(panel.panelId, 2)
          .getState()
          .messages.some((m) => m.content === '卷二消息'),
      ).toBe(true);
    });

    it('换卷不拆：摊开集内即时切换依赖内存态', async () => {
      await setupTwoSeededVolumes();

      panel.switchSession(0); // 换到卷一（卷二仍摊开）

      expect(isStoreFresh(panel.panelId, 1)).toBe(false);
      expect(isStoreFresh(panel.panelId, 2)).toBe(false);
    });

    it('setAgent 全量重置：旧工作区全部卷 store 一并移除，摊开集为空（归零重建：不铺新卷）', async () => {
      await setupTwoSeededVolumes();

      panel.setAgent(makeAgent() as any); // 工作区切换路径（resetSessionState）

      expect(isStoreFresh(panel.panelId, 1)).toBe(true);
      expect(isStoreFresh(panel.panelId, 2)).toBe(true);
      // 归零重建：新会话树 = 空摊开集（卷由用户从首页点开），发号下限保留
      const sess = Session.getSessions(panel.panelId);
      expect(sess).toHaveLength(0);
    });

    it('setAgent(null)：句柄/工厂拆除，会话列表与消息 store 保留（Phase B 存在性解耦）', async () => {
      await setupTwoSeededVolumes();

      panel.setAgent(null); // 显式拆除路径（Phase B 后无生产调用方，防御性保留）

      // 工厂注销 + 句柄 dispose；会话列表/消息 store 不清——会话显示不依赖句柄
      expect(Session.getAgentFactory(panel.panelId)).toBeNull();
      expect(panel.getAgent()).toBeNull();
      expect(Session.getSessions(panel.panelId)).toHaveLength(2);
      expect(isStoreFresh(panel.panelId, 1)).toBe(false);
      expect(isStoreFresh(panel.panelId, 2)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 工作区会话根路由（workspace-session-ownership-rework 2026-08-27）
  //   · 卷唯一存储位 = {workspace}/.lantai/sessions/{id}.json（单一存储位）
  //   · 归属 = 存储位置——卷 JSON 不再携带 workspace 字段标签
  //   · 工作区隔离 = 目录隔离（结构保证，无字段匹配）
  // ═══════════════════════════════════════════════════════════════

  describe('工作区会话根路由（workspace-session-ownership-rework）', () => {
    const PROJ = 'D:/u1-proj';

    /** 实现式磁盘 mock：按路径精确路由（global / project 两目录）。
     *  list_directory 由 files 推导目录清单（U4 扫描推导恢复依赖）。 */
    function mockDualDirDisk(files: Record<string, string>) {
      const listDir = (dir: string) =>
        Object.keys(files)
          .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
          .map((p) => {
            const name = p.split('/').pop() as string;
            return { name, path: p, is_dir: false, children: null };
          });
      mockInvoke.mockReset();
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: any) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = params.file_path as string;
            if (fp in files) return Promise.resolve(files[fp]);
            return Promise.reject(new Error('文件不存在'));
          }
          if (method === 'write_file_content') {
            files[params.file_path as string] = params.content as string;
            return Promise.resolve('ok');
          }
          if (method === 'delete_file_or_dir') {
            // Phase 3b：delete_log 真删（日志 + 缓存各一次）——内存盘同步移除
            delete files[params.path as string];
            return Promise.resolve('ok');
          }
          if (method === 'list_directory') {
            return Promise.resolve(JSON.stringify(listDir(params.path as string)));
          }
          return Promise.resolve(null);
        }),
      );
      return files;
    }

    async function setupVolumePanel() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      // DSH 形态：工厂造真句柄（createNewSession 现造）；setAgent 仅清理不铺卷
      const stub = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'U1 内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgent(stub as any); // 清理路径（历史调用形）
      panel.setAgentFactory(async () => ({ ...stub }) as any);
      await panel.createNewSession();
      return panel;
    }

    it('saveActiveSession 落盘 {PROJ}/.lantai/sessions/{id}.json（唯一存储位）', async () => {
      const files = mockDualDirDisk({});
      await setupVolumePanel();

      await panel.saveActiveSession(PROJ);

      const write = Object.entries(files).find(([p]) => p.endsWith('/1.json'));
      expect(write?.[0]).toBe(`${PROJ}/.lantai/sessions/1.json`); // 工作区会话根，非全局位
      const parsed = JSON.parse(write![1]);
      expect(parsed).not.toHaveProperty('workspace'); // 归属 = 存储位置，无字段标签
      expect(parsed.messages.some((m: any) => m.content === 'U1 内容')).toBe(true);
    });

    // ── P0 记录闭环（2026-09-14）：组合身份随卷落盘 + 重开按其重建 ──
    // 「模型可见 ⟺ 已记录」：组合决定模型看到哪些工具/段落，卷必须能自证；
    // 重开一卷 = 重跑它当时的那套组合（而不是当前全局默认）。

    it('P0：落盘带组合身份——真源 = 本卷 Agent 的 presetId（能力位）', async () => {
      const files = mockDualDirDisk({});
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const stub = {
        presetId: 'review',
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'U1 内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      };
      panel.setAgentFactory(async () => ({ ...stub }) as any);
      await panel.createNewSession();

      await panel.saveActiveSession(PROJ);

      const write = Object.entries(files).find(([p]) => p.endsWith('/1.json'));
      const parsed = JSON.parse(write![1]);
      expect(parsed.presetId).toBe('review');
    });

    it('P0：句柄无 presetId 能力位（旧实现/桩）→ 无记录（字段省略，不猜全局默认）', async () => {
      const files = mockDualDirDisk({});
      await setupVolumePanel(); // 该桩无 presetId 字段
      await panel.saveActiveSession(PROJ);
      const write = Object.entries(files).find(([p]) => p.endsWith('/1.json'));
      expect(JSON.parse(write![1]).presetId).toBeUndefined();
    });

    it('P0：重开卷按卷内记录的组合身份登记（工厂据此重建；校验与提示在装配面）', async () => {
      mockDualDirDisk({
        // Phase 3b：卷 = 事件日志；组合身份记在头行（旧快照的 presetId 字段随
        // 权威翻转退役——记录载体从「快照字段」变为「日志头行」）
        [`${PROJ}/.lantai/sessions/7.ndjson`]: logText(
          7,
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '历史内容' },
          ],
          '2026-09-14T00:00:00Z',
          'ghost',
        ),
      });
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(storingFactory());

      await panel.loadSessionFromDisk(PROJ, 7);

      // 登记面：工厂读它决定用哪套组合重建（不可用时的提示也在那一面发；
      // workspace 工厂源码窗口断言见 composition-preset-assembly.test.ts）
      expect(agentSessionState.getRecordedPresetId(panel.panelId, 7)).toBe('ghost');
    });

    it('P0：旧存档无 presetId 字段 → 无记录（不猜、不迁移）', async () => {
      mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/8.ndjson`]: logText(
          8,
          [{ role: 'user', content: '旧内容' }],
          '2026-09-01T00:00:00Z',
        ),
      });
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(storingFactory());

      await panel.loadSessionFromDisk(PROJ, 8);

      expect(agentSessionState.getRecordedPresetId(panel.panelId, 8)).toBeNull();
    });

    it('P0 连带修复：renameSessionFile 不再抹掉卷内其它字段（tokens/compose/presetId）', async () => {
      const files = mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/9.json`]: JSON.stringify({
          id: 9,
          label: '旧名',
          savedAt: '2026-09-14T00:00:00Z',
          messages: [{ role: 'user', content: 'x' }],
          tokensUsed: 42,
          tokens: { total: 42 },
          compose: { provider: 'p', model: 'm' },
          presetId: 'minimal',
        }),
      });

      await Session.renameSessionFile(PROJ, 9, '新名');

      const parsed = JSON.parse(files[`${PROJ}/.lantai/sessions/9.json`]);
      expect(parsed.label).toBe('新名');
      expect(parsed.tokensUsed).toBe(42);
      expect(parsed.tokens).toEqual({ total: 42 }); // 旧行为：改名把它静默抹掉
      expect(parsed.compose).toEqual({ provider: 'p', model: 'm' });
      expect(parsed.presetId).toBe('minimal');
    });

    it('陈旧投影缓存不丢账本（fresh 门只管 uiMessages；账本是累计账，落后 ≠ 说错）', async () => {
      const ledger = {
        version: 1,
        totals: { uncachedInputTokens: 30, cacheReadTokens: 970, cacheWriteTokens: 0, outputTokens: 10 },
        attempts: 1,
        turns: [],
      };
      mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/9.ndjson`]: logText(9, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '历史内容' },
        ]),
        // 投影缓存落后于日志（seq 1 < 日志末序号 2）——旧行为：账本随 uiMessages 一起丢
        [`${PROJ}/.lantai/sessions/9.json`]: cacheText(9, {
          seq: 1,
          uiMessages: [{ id: 'stale' }],
          tokens: ledger,
        }),
      });

      const data = await Session.readVolumeData(PROJ, 9);

      expect(data?.tokens).toEqual(ledger);
      expect(data?.uiMessages).toBeUndefined(); // 内容投影仍按新鲜度取舍（陈旧即不采信）
    });

    it('惰性补建句柄恢复 token 账本（2026-09-23 修：拟文懒建不再把累计账丢掉）', async () => {
      // 病灶（案卷 35 实测）：句柄是惰性资源，「拟文/切卷补建」是最常见的来路，
      // 而 ensureVolumeAgent 此前只回填消息、不回填账本 ⇒ 卷文件里 14 次请求的
      // 累计账（未缓存 59,721 / 缓存读 708,736）在懒建那一刻消失，下一次落盘再把
      // 它覆盖成更小的账；墨量册「缓存命中」于是从 68% 起爬（看着像命中率坏了）。
      const ledger = {
        version: 1,
        totals: { uncachedInputTokens: 59721, cacheReadTokens: 708736, cacheWriteTokens: 0, outputTokens: 900 },
        attempts: 14,
        turns: [],
      };
      mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/9.ndjson`]: logText(9, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '历史内容' },
        ]),
        [`${PROJ}/.lantai/sessions/9.json`]: cacheText(9, { tokens: ledger }),
      });
      const restore = vi.fn();
      const STORE = 'lazy-ledger-store';
      Session.setAgentFactory(STORE, (async () => ({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
        restoreTokenLedger: restore,
      })) as never);

      await expect(Session.ensureVolumeAgent({ storeId: STORE, getProjectPath: () => PROJ } as never, 9)).resolves.toBe(
        true,
      );

      expect(restore).toHaveBeenCalledTimes(1);
      expect(restore).toHaveBeenCalledWith(ledger);
      Session.setAgentFactory(STORE, null);
    });

    /** 工厂桩：setSession 真正落进闭包（loadSessionFromDisk 重建消息依赖 agent 持有会话）。 */
    function storingFactory() {
      let agentSession: any[] = [{ role: 'system', content: 'sys' }];
      const factory = async () => ({
        getSession: () => agentSession,
        setSession: (msgs: any[]) => {
          agentSession = msgs;
        },
        dispose: vi.fn(),
        bindSession: vi.fn(),
      });
      return factory;
    }

    it('**同代校验**：上一代残留的 {id}.json 不是本卷的缓存——卷名/账本/UI 快照全不采信', async () => {
      mockDualDirDisk({
        // 本卷：今天立卷（头行 createdAt 是 write-once 真源）
        [`${PROJ}/.lantai/sessions/9.ndjson`]: logText(
          9,
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '本卷首句' },
          ],
          '2026-09-19T09:00:00Z',
        ),
        // 残留：**上一代**的 9.json（Phase 3b 前的旧格式化石 / 删除竞态复活）——
        // 早于本卷立卷时刻，`seq` 却比本卷日志大（旧实现只看 seq 就整份采信）
        [`${PROJ}/.lantai/sessions/9.json`]: JSON.stringify({
          id: 9,
          label: '死卷的名',
          savedAt: '2026-09-06T00:00:00Z',
          messages: [{ role: 'user', content: '死卷内容' }],
          uiMessages: [{ _id: 'dead' }],
          tokensUsed: 999,
          tokens: { total: 999 },
          presetId: 'minimal',
          seq: 99,
          ver: 1,
        }),
      });

      const data = await Session.readVolumeData(PROJ, 9);

      // 卷名留空（呈现层按档号兜底）——绝不顶着死卷的名（真机「子卷卷名乱套」的机理）
      expect(data?.label).toBe('');
      expect(data?.uiMessages).toBeUndefined();
      expect(data?.tokens).toBeUndefined();
      expect(data?.tokensUsed).toBeUndefined();
      expect(data?.presetId).toBeUndefined();
      // 内容真源仍是事件日志（残留缓存一个字段都进不来）
      expect(data?.messages.map((m) => m.content)).toEqual(['sys', '本卷首句']);
    });

    it('改名不展开上一代残留缓存：死卷的消息表/账本不得写成新卷的快照', async () => {
      const files = mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/9.ndjson`]: logText(
          9,
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '本卷首句' },
          ],
          '2026-09-19T09:00:00Z',
        ),
        [`${PROJ}/.lantai/sessions/9.json`]: JSON.stringify({
          id: 9,
          label: '死卷的名',
          savedAt: '2026-09-06T00:00:00Z',
          messages: [{ role: 'user', content: '死卷内容' }],
          uiMessages: [{ _id: 'dead' }],
          tokensUsed: 999,
          seq: 99,
          ver: 1,
        }),
      });

      await Session.renameSessionFile(PROJ, 9, '新名');

      const parsed = JSON.parse(files[`${PROJ}/.lantai/sessions/9.json`]);
      expect(parsed.label).toBe('新名');
      // 残留字段一个都不继承（否则下次开卷 seq 够大就把死卷的消息表搬过来）
      expect(parsed.messages).toEqual([]);
      expect(parsed.uiMessages).toBeUndefined();
      expect(parsed.tokensUsed).toBe(0);
      expect(parsed.seq).toBeUndefined();
    });

    it('删除**在案**的卷：合卷快照不得把 {id}.json 写回来（死卷快照 = 下次档号复用时冒充新卷的卷名）', async () => {
      const files = mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/8.ndjson`]: logText(8, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '八' },
        ]),
        [`${PROJ}/.lantai/sessions/9.ndjson`]: logText(9, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '九' },
        ]),
      });
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const bySid = new Map<number, any[]>();
      panel.setAgentFactory(
        async (sid: number) =>
          ({
            getSession: () => bySid.get(sid) ?? [{ role: 'system', content: 'sys' }],
            setSession: (msgs: any[]) => bySid.set(sid, msgs),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
            bindSession: vi.fn(),
          }) as any,
      );
      await panel.loadSessionFromDisk(PROJ, 8);
      await panel.loadSessionFromDisk(PROJ, 9);

      await panel.deleteSessionFile(PROJ, 8);
      // closeSession 的合卷快照是 fire-and-forget（走每卷写链）——等在途写落定再断言
      await Session.drainVolumeWrites();

      // 真删就是真删：两半文件都不许复活（旧行为：closeSession 把 8.json 写回来）
      expect(files[`${PROJ}/.lantai/sessions/8.ndjson`]).toBeUndefined();
      expect(files[`${PROJ}/.lantai/sessions/8.json`]).toBeUndefined();
    });

    it('卷不在本工作区会话根 = 不存在（无回退面——单一路径）', async () => {
      mockDualDirDisk({
        // 卷躺在别处（旧全局位/他目录残留）——本工作区会话根无此卷，代码不回读
        '/.lantai/sessions/5.json': logText(5, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '游离卷' },
        ]),
      });
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      panel.setAgentFactory(storingFactory());

      await panel.loadSessionFromDisk(PROJ, 5);

      const sess = Session.getSessions(panel.panelId);
      expect(sess.some((s) => s.id === 5)).toBe(false); // 不摊开——本区会话根无此卷
    });

    it('工作区隔离：B 区请求读不到 A 区卷，写只落 B 区会话根（目录隔离，结构保证）', async () => {
      const wsB = 'D:/other-ws';
      const files = mockDualDirDisk({
        // A 区卷在 A 区会话根
        [`${PROJ}/.lantai/sessions/1.json`]: JSON.stringify({
          id: 1,
          label: 'A 区卷',
          savedAt: '2026-08-24T00:00:00Z',
          messages: [{ role: 'user', content: 'A 区内容' }],
        }),
      });

      // 读：B 区请求读 B 区会话根——A 区卷不在其中（无需字段校验，目录即隔离）
      panel = createChatPanel();
      panel.setProjectPath(wsB);
      panel.setAgentFactory(storingFactory());
      await panel.loadSessionFromDisk(wsB, 1);
      const sess = Session.getSessions(panel.panelId);
      expect(sess.some((s) => s.id === 1)).toBe(false);

      // 写：B 区保存落 B 区会话根，A 区卷文件零触碰
      Session.setNextSessionId(panel.panelId, 1);
      panel.setAgentFactory(
        async () =>
          ({
            getSession: () => [
              { role: 'system', content: 'sys' },
              { role: 'user', content: 'B 区新内容' },
            ],
            setSession: vi.fn(),
            dispose: vi.fn(),
            cascadeAbort: vi.fn(),
          }) as any,
      );
      await panel.createNewSession(); // B 区卷 1
      await panel.saveActiveSession(wsB);

      const bWrite = JSON.parse(files[`${wsB}/.lantai/sessions/1.json`]);
      expect(bWrite.messages.some((m: any) => m.content === 'B 区新内容')).toBe(true);
      // A 区卷文件未被覆盖（同号卷天然隔离——不同目录）
      const aWrite = JSON.parse(files[`${PROJ}/.lantai/sessions/1.json`]);
      expect(aWrite.messages.some((m: any) => m.content === 'A 区内容')).toBe(true);
    });

    it('deleteSessionFile 真删卷：日志 + 投影缓存一并删除（墓碑语义退役）', async () => {
      const files = mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/3.ndjson`]: logText(3, [{ role: 'user', content: 'x' }]),
        [`${PROJ}/.lantai/sessions/3.json`]: cacheText(3, { label: '本区卷' }),
      });
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);

      await panel.deleteSessionFile(PROJ, 3);

      // 卷本体（日志）与投影缓存都从内存盘消失——「文件不在 = 卷不存在」，
      // 不再写 deleted:true 墓碑（墓碑是「快照即存储」时代的占位手段）。
      expect(files[`${PROJ}/.lantai/sessions/3.ndjson`]).toBeUndefined();
      expect(files[`${PROJ}/.lantai/sessions/3.json`]).toBeUndefined();
    });
  });
});
