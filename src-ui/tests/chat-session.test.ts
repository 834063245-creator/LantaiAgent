import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

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
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
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
import * as Session from '../src/ui/chat-session';
import { scanMaxSessionId, stripLineNumbers } from '../src/ui/chat-session';
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

/** Mock invoke to return session data on disk for read_file_content calls.
 *  workspace（U1）：卷归属工作区——默认 D:/test（listSavedSessions 测试的
 *  查询路径），零目录退役后（Stage-5）无归属卷不再进列表。 */
function mockSessionFile(id: number, messages: any[], label = `会话 ${id}`, savedAt?: string, workspace?: string) {
  return JSON.stringify({
    id,
    label,
    savedAt: savedAt || new Date().toISOString(),
    messages,
    workspace: workspace ?? 'D:/test',
  });
}

// ── Tests ──

describe('ChatPanel session persistence', () => {
  let panel: ChatCore;

  beforeEach(() => {
    // Clean localStorage between tests
    localStorage.clear();
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

  // ═══════════════════════════════════════════════════════════════
  // stripLineNumbers — cat -n format from Rust read_file_content
  // ═══════════════════════════════════════════════════════════════

  describe('stripLineNumbers', () => {
    const strip = stripLineNumbers;

    it('removes single line number prefix', () => {
      const input = '     1\t{"id":1,"label":"test"}';
      const result = strip(input);
      expect(result).toBe('{"id":1,"label":"test"}');
    });

    it('removes multi-line line numbers', () => {
      const input = '     1\t{"id":1,\n     2\t"label":"test",\n     3\t"ok":true}';
      const result = strip(input);
      expect(result).toBe('{"id":1,\n"label":"test",\n"ok":true}');
    });

    it('handles large line numbers (right-aligned in 6 chars)', () => {
      const input = '   999\t{"big":true}';
      const result = strip(input);
      expect(result).toBe('{"big":true}');
    });

    it('passes through text without line numbers unchanged', () => {
      const input = '{"plain":"json"}';
      const result = strip(input);
      expect(result).toBe('{"plain":"json"}');
    });

    it('handles empty string', () => {
      expect(strip('')).toBe('');
    });
  });

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
          { name: '1.json', path: '/sessions/1.json', is_dir: false, children: null },
          { name: '71.json', path: '/sessions/71.json', is_dir: false, children: null },
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
          { name: '3.json', path: '/sessions/3.json', is_dir: false, children: null },
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
  // listSavedSessions — filters, parses, sorts
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions', () => {
    it('returns empty array when list_directory rejects', async () => {
      panel = createChatPanel();
      mockInvoke.mockRejectedValue(new Error('dir not found'));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toEqual([]);
    });

    it('returns empty array when list_directory returns non-array', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue('not an array');

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toEqual([]);
    });

    it('filters out _active.json and deleted sessions', async () => {
      panel = createChatPanel();
      // U1：listSavedSessions 先扫全局位（listing + 文件读），再扫项目旧目录
      // （第二次 list_directory）——空列表响应在文件读之后
      mockInvoke
        .mockResolvedValueOnce(
          JSON.stringify([
            { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
            { name: '_active.json', path: '/s/_active.json', is_dir: false, children: null },
            { name: '40.json', path: '/s/40.json', is_dir: false, children: null },
          ]),
        )
        // read_file_content for 1.json
        .mockResolvedValueOnce(
          mockSessionFile(1, [
            { role: 'system', content: 'prompt' },
            { role: 'user', content: 'hello' },
          ]),
        )
        // read_file_content for 40.json (deleted marker)
        .mockResolvedValueOnce(JSON.stringify({ id: 40, deleted: true }));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].msgCount).toBe(1); // only user message counts
    });

    it('returns sessions sorted by savedAt descending', async () => {
      panel = createChatPanel();
      mockInvoke
        .mockResolvedValueOnce(
          JSON.stringify([
            { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
            { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
          ]),
        )
        .mockResolvedValueOnce(mockSessionFile(1, [{ role: 'user', content: 'old' }], 'Old', '2026-01-01T00:00:00Z'))
        .mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'new' }], 'New', '2026-06-30T00:00:00Z'));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(2); // newest first
      expect(result[1].id).toBe(1);
    });

    it('handles cat -n formatted session files (read_file_content regression)', async () => {
      panel = createChatPanel();
      const rawJSON = mockSessionFile(
        46,
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'real conversation' },
        ],
        '有对话',
        '2026-06-30T12:00:00Z',
      );

      mockInvoke
        .mockResolvedValueOnce(JSON.stringify([{ name: '46.json', path: '/s/46.json', is_dir: false, children: null }]))
        // P1-3（2026-09-02）：readSessionJSON 改 raw 模式——后端 raw=true 跳过
        // format_lines，直接返回原文。mock 模拟新契约（原文直返）。
        // 旧契约（cat -n 格式）的剥行号路径由 stripLineNumbers 单测覆盖。
        .mockResolvedValueOnce(rawJSON);

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(46);
      expect(result[0].label).toBe('有对话');
      expect(result[0].msgCount).toBe(1);
    });

    it('skips entries with unreadable session files', async () => {
      panel = createChatPanel();
      mockInvoke
        .mockResolvedValueOnce(
          JSON.stringify([
            { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
            { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
          ]),
        )
        // First read fails
        .mockRejectedValueOnce(new Error('permission denied'))
        // Second succeeds
        .mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'ok' }]));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
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
  // listSavedSessions — parallel read + timeout (regression fix)
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions — parallel + timeout', () => {
    it('reads all session files in parallel (not serial)', async () => {
      panel = createChatPanel();
      // 5 session files — if serial, this takes 5x as long
      const files = [1, 2, 3, 4, 5].map((id) => ({
        name: `${id}.json`,
        path: `/s/${id}.json`,
        is_dir: false,
        children: null,
      }));
      mockInvoke.mockResolvedValueOnce(JSON.stringify(files));
      for (const id of [1, 2, 3, 4, 5]) {
        mockInvoke.mockResolvedValueOnce(mockSessionFile(id, [{ role: 'user', content: `msg-${id}` }]));
      }

      const start = Date.now();
      const result = await panel.listSavedSessions('D:/test');
      const elapsed = Date.now() - start;

      expect(result).toHaveLength(5);
      // Parallel reads should complete quickly (< 100ms for mocked calls)
      // Serial would be at least 5 * async overhead
      expect(elapsed).toBeLessThan(500);
    });

    it('returns empty after 10s timeout if a session read hangs', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify([
          { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
          { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
        ]),
      );
      // First file hangs forever, second resolves
      mockInvoke.mockReturnValueOnce(new Promise(() => {})); // never resolves
      mockInvoke.mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'ok' }]));

      vi.useFakeTimers();
      const promise = panel.listSavedSessions('D:/test');

      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toEqual([]);
    });

    it('still returns readable sessions when one file fails', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify([
          { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
          { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
          { name: '3.json', path: '/s/3.json', is_dir: false, children: null },
        ]),
      );
      // File 1: success
      mockInvoke.mockResolvedValueOnce(mockSessionFile(1, [{ role: 'user', content: 'hello' }]));
      // File 2: error
      mockInvoke.mockRejectedValueOnce(new Error('corrupt file'));
      // File 3: success
      mockInvoke.mockResolvedValueOnce(mockSessionFile(3, [{ role: 'user', content: 'world' }]));

      const result = await panel.listSavedSessions('D:/test');

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id).sort()).toEqual([1, 3]);
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
      const vol1 = mockSessionFile(1, mockSessionMessages, '测试会话', undefined, 'D:/test');
      mockInvoke.mockImplementation(
        fsCapAware((_cmd: string, payload: { method: string; params: Record<string, unknown> }) => {
          const { method, params } = payload;
          if (method === 'read_file_content') {
            const fp = params.file_path as string;
            if (fp === 'D:/test/.lantai/sessions/1.json') return Promise.resolve(vol1);
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
            // 模拟磁盘上的会话文件（带旧 paper 字段——归零世界卷恒带归属）
            return Promise.resolve(
              JSON.stringify({
                id: 5,
                label: '带纸面的卷',
                savedAt: new Date().toISOString(),
                workspace: PROJ,
                messages: [
                  { role: 'system', content: 'sys' },
                  { role: 'user', content: '旧消息' },
                ],
                paper: {
                  pinned: { 'pb:m9:0': { x: 42, y: -42 } },
                  strips: [{ id: 'strip1', text: '旧纸条', x: 10, y: -10, w: 480 }],
                },
              }),
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
            if (fp.endsWith('/5.json')) {
              return Promise.resolve(
                JSON.stringify({
                  id: 5,
                  label: '卷五',
                  workspace: PROJ,
                  messages: [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'hi' },
                  ],
                }),
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
                { name: '5.json', path: 'D:/restore-test/.lantai/sessions/5.json', is_dir: false, children: null },
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
            if (fp.endsWith('/5.json')) {
              return Promise.resolve(mockSessionFile(5, [{ role: 'user', content: 'hi' }], '卷五', undefined, PROJ));
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
          .filter((p) => p.startsWith(`${dir}/`) && /\.json$/.test(p))
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

    it('卷不在本工作区会话根 = 不存在（无回退面——单一路径）', async () => {
      mockDualDirDisk({
        // 卷躺在别处（旧全局位/他目录残留）——本工作区会话根无此卷，代码不回读
        '/.lantai/sessions/5.json': mockSessionFile(
          5,
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '游离卷' },
          ],
          '游离卷',
          undefined,
        ),
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

    it('deleteSessionFile 墓碑写 {PROJ}/.lantai/sessions/{id}.json（无 workspace 字段）', async () => {
      const files = mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/3.json`]: JSON.stringify({
          id: 3,
          label: '本区卷',
          savedAt: '2026-08-24T00:00:00Z',
          messages: [{ role: 'user', content: 'x' }],
        }),
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

      const tomb = JSON.parse(files[`${PROJ}/.lantai/sessions/3.json`]);
      expect(tomb.deleted).toBe(true);
      expect(tomb).not.toHaveProperty('workspace'); // 归属 = 存储位置，无字段标签
    });
  });
});
