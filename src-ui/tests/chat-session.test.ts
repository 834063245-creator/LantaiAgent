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
import { makeStrip } from '../src/paper/selection';
import { getMessagesStore } from '../src/state/messages-store';
import { getPaperStore } from '../src/state/paper-store';
import * as Session from '../src/ui/chat-session';
import { scanMaxSessionId, stripLineNumbers } from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';

// ── Helpers ──

/** Create a minimal headless ChatCore (no DOM needed). */
function createChatPanel(): ChatCore {
  return new ChatCore();
}

/** Mock invoke to return session data on disk for read_file_content calls.
 *  workspace（U1）：卷归属工作区——带字段的桩模拟「已吸收进全局位的卷」。 */
function mockSessionFile(id: number, messages: any[], label = `会话 ${id}`, savedAt?: string, workspace?: string) {
  return JSON.stringify({
    id,
    label,
    savedAt: savedAt || new Date().toISOString(),
    messages,
    ...(workspace ? { workspace } : {}),
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
        // read_file_content returns cat -n format: line numbers prepended
        .mockResolvedValueOnce(
          rawJSON
            .split('\n')
            .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
            .join('\n'),
        );

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
    it('clears the factory and disposes all session agents', () => {
      panel = createChatPanel();
      const dispose = vi.fn();
      const fakeAgent = {
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose,
      };
      panel.setAgent(fakeAgent as any);
      panel.setAgentFactory(async () => fakeAgent as any);
      expect(panel.getAgent()).toBe(fakeAgent);
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

      // 归零重建：从首页打开历史卷 = 全局位单读（卷带 workspace 归属）
      const vol1 = mockSessionFile(1, mockSessionMessages, '测试会话', undefined, 'D:/test');
      mockInvoke.mockImplementation((_cmd: string, payload: { method: string; params: Record<string, unknown> }) => {
        const { method, params } = payload;
        if (method === 'read_file_content') {
          const fp = params.file_path as string;
          if (fp === '/.lantai/sessions/1.json') return Promise.resolve(vol1);
          return Promise.reject(new Error('文件不存在'));
        }
        return Promise.resolve(null);
      });

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

    /** 两卷现场：卷 1（背景，有内容）+ 卷 2（活跃）。返回捕获的写入调用。 */
    function setupTwoVolumes() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      const agent1 = makeAgent('卷一的内容');
      panel.setAgent(agent1 as any);
      const agent2 = makeAgent('卷二的内容');
      panel.setAgentFactory(async () => agent2 as any);

      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation((_cmd: string, payload: any) => {
        const { method, params } = payload;
        if (method === 'write_file_content') {
          writes.push({ file_path: params.file_path as string, content: params.content as string });
        }
        return Promise.resolve('ok');
      });
      return { agent1, agent2, writes, seed: async () => void (await panel.createNewSession()) };
    }

    it('合背景卷：先落盘该卷内容再移除（写 /1.json 带该卷消息）', async () => {
      const { agent1, writes, seed } = setupTwoVolumes();
      await seed();

      panel.closeSession(0); // 合背景卷 1

      // U1：落盘目标经 resolveVolumeWriteTarget 异步消解（预读全局位）——
      // fire-and-forget 写链需排干微任务后再断言
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

      // U1：写目标异步消解——排干微任务（见合背景卷用例注释）
      await new Promise((r) => setTimeout(r, 0));
      const write2 = writes.find((w) => w.file_path.endsWith('/2.json'));
      expect(write2).toBeTruthy();
      const parsed = JSON.parse(write2!.content);
      expect(parsed.messages.some((m: any) => m.content === '卷二的内容')).toBe(true);
    });

    it('空卷（仅 system）合卷不落盘', async () => {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      const agent2 = makeAgent('有内容');
      panel.setAgentFactory(async () => agent2 as any);
      const writes: Array<{ file_path: string; content: string }> = [];
      mockInvoke.mockReset();
      mockInvoke.mockImplementation((_cmd: string, payload: any) => {
        const { method, params } = payload;
        if (method === 'write_file_content') {
          writes.push({ file_path: params.file_path as string, content: params.content as string });
        }
        return Promise.resolve('ok');
      });
      await panel.createNewSession();

      panel.closeSession(0); // 合空卷 1

      expect(writes.find((w) => w.file_path.endsWith('/1.json'))).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 纸面用户层持久化（2026-08-24 收尾）：钉住块 + 纸条随卷落盘/恢复
  // ═══════════════════════════════════════════════════════════════

  describe('paper state persistence', () => {
    const PROJ = 'D:/paper-test';

    /** 起一卷有内容的案卷，返回捕获的 write 记录数组。 */
    function setupVolumeWithContent(writes: Array<{ file_path: string; content: string }>) {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '钉住我' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      mockInvoke.mockReset();
      mockInvoke.mockImplementation((_cmd: string, payload: any) => {
        const { method, params } = payload;
        if (method === 'write_file_content') {
          writes.push({ file_path: params.file_path as string, content: params.content as string });
        }
        return Promise.resolve('ok');
      });
      return panel;
    }

    it('saveActiveSession 落盘 JSON 携带 paper（钉住 + 纸条）', async () => {
      const writes: Array<{ file_path: string; content: string }> = [];
      setupVolumeWithContent(writes);

      // 模拟用户钉块 + 抽纸条（写 paper-store）
      const paperStore = getPaperStore(panel.panelId).getState();
      const sid = Session.getSessions(panel.panelId)[0].id;
      paperStore.setPinned(String(sid), 'pb:m1:0', { x: 800, y: -600 });
      paperStore.addStrip(String(sid), makeStrip('引用片段', 900, -300, 480, { messageId: 'm1' }));

      await panel.saveActiveSession(PROJ);

      const write = writes.find((w) => w.file_path.endsWith(`/${sid}.json`));
      expect(write).toBeTruthy();
      const parsed = JSON.parse(write!.content);
      expect(parsed.paper).toBeDefined();
      expect(parsed.paper.pinned).toEqual({ 'pb:m1:0': { x: 800, y: -600 } });
      expect(parsed.paper.strips).toHaveLength(1);
      expect(parsed.paper.strips[0].text).toBe('引用片段');
      expect(parsed.paper.strips[0].source).toEqual({ messageId: 'm1' });
    });

    it('纸面空（无钉住无纸条）落盘仍带空 paper 字段（恢复路径零特判）', async () => {
      const writes: Array<{ file_path: string; content: string }> = [];
      setupVolumeWithContent(writes);
      await panel.saveActiveSession(PROJ);

      const sid = Session.getSessions(panel.panelId)[0].id;
      const write = writes.find((w) => w.file_path.endsWith(`/${sid}.json`));
      const parsed = JSON.parse(write!.content);
      expect(parsed.paper).toEqual({ pinned: {}, strips: [] });
    });

    it('合卷（closeSession）落盘快照携带该卷纸面数据，且内存中该卷纸面被清除', async () => {
      const writes: Array<{ file_path: string; content: string }> = [];
      setupVolumeWithContent(writes);
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

      // 钉卷一（背景卷）的块
      const paperStore = getPaperStore(panel.panelId).getState();
      paperStore.setPinned('1', 'pb:m1:0', { x: 100, y: -100 });

      panel.closeSession(0); // 合卷一

      // U1：写目标异步消解——排干微任务（见 C8 用例注释）
      await new Promise((r) => setTimeout(r, 0));
      const write1 = writes.find((w) => w.file_path.endsWith('/1.json'));
      expect(write1).toBeTruthy();
      const parsed = JSON.parse(write1!.content);
      expect(parsed.paper?.pinned).toEqual({ 'pb:m1:0': { x: 100, y: -100 } });
      // 内存中卷一纸面已清（getPinned 回到稳定空引用）
      expect(paperStore.getPinned('1')).toEqual({});
    });

    it('loadSessionFromDisk 恢复 paper 到 paper-store（旧存档无字段 = 空纸面）', async () => {
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
      mockInvoke.mockImplementation((_cmd: string, payload: any) => {
        const { method, params } = payload;
        if (method === 'read_file_content') {
          // 模拟磁盘上的会话文件（带 paper + workspace 字段——归零世界卷恒带归属）
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
      });

      await panel.loadSessionFromDisk(PROJ, 5);

      const paperStore = getPaperStore(panel.panelId).getState();
      expect(paperStore.getPinned('5')).toEqual({ 'pb:m9:0': { x: 42, y: -42 } });
      expect(paperStore.getStrips('5')).toHaveLength(1);
      expect(paperStore.getStrips('5')[0].text).toBe('旧纸条');
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

    /** 两卷现场：卷 1（setAgent 起）+ 卷 2（工厂建），各自 seed 消息。 */
    async function setupTwoSeededVolumes() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent(makeAgent() as any);
      panel.setAgentFactory(async () => makeAgent() as any);
      await panel.createNewSession();
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

    it('setAgent 全量重置：旧工作区全部卷 store 一并移除', async () => {
      await setupTwoSeededVolumes();

      panel.setAgent(makeAgent() as any); // 工作区切换路径（resetSessionState）

      expect(isStoreFresh(panel.panelId, 1)).toBe(true);
      expect(isStoreFresh(panel.panelId, 2)).toBe(true);
      // 新会话树：单卷（id 沿 nextSessionId 续发），消息为空
      const sess = Session.getSessions(panel.panelId);
      expect(sess).toHaveLength(1);
      expect(sess[0].id).toBe(3);
      expect(getMessagesStore(`${panel.panelId}:3`).getState().messages).toHaveLength(0);
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
  // 全局存储位路由（U1 2026-08-24 → 归零重建 2026-08-25）
  //   · 卷统一落全局位，workspace 字段随卷写入
  //   · 单一路径：读写均全局位——双读回退/旧目录加扫已拆（旧目录已归档）
  //   · 归属校验（防御）：他区卷/零目录卷按 workspace 字段匹配
  // ═══════════════════════════════════════════════════════════════

  describe('全局存储位路由（归零重建）', () => {
    const PROJ = 'D:/u1-proj';
    const GLOBAL = '/.lantai/sessions'; // _userSessionsDir 未解析时的兜底路径（测试态）

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
      mockInvoke.mockImplementation((_cmd: string, payload: any) => {
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
      });
      return files;
    }

    function setupVolumePanel() {
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgent({
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'U1 内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      return panel;
    }

    it('saveActiveSession 统一落全局位，卷 JSON 携带 workspace 字段', async () => {
      const files = mockDualDirDisk({});
      setupVolumePanel();

      await panel.saveActiveSession(PROJ);

      const write = Object.entries(files).find(([p]) => p.endsWith('/1.json'));
      expect(write?.[0]).toBe(`${GLOBAL}/1.json`); // 全局位，非项目旧目录
      const parsed = JSON.parse(write![1]);
      expect(parsed.workspace).toBe(PROJ); // workspace 字段（正斜杠）
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

    it('归零重建：全局位缺席 → 旧目录卷不可打开（回退面已拆，卷不在全局位=不存在）', async () => {
      mockDualDirDisk({
        [`${PROJ}/.lantai/sessions/5.json`]: mockSessionFile(
          5,
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '旧目录的卷' },
          ],
          '旧卷',
          undefined,
        ), // 旧目录卷（已归档世界里的残留——代码不再读这里）
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
      expect(sess.some((s) => s.id === 5)).toBe(false); // 不摊开——全局位无此卷
    });

    it('归零重建：他区卷对本工作区不可见（归属校验防御），写恒落全局位', async () => {
      const files = mockDualDirDisk({
        // 全局位 1.json 归属另一个工作区（防御性场景——归零后发号单调，正常不撞号）
        [`${GLOBAL}/1.json`]: JSON.stringify({
          id: 1,
          label: '别的工作区的卷',
          savedAt: '2026-08-24T00:00:00Z',
          messages: [{ role: 'user', content: '他区内容' }],
          workspace: 'D:/other-ws',
        }),
      });

      // 读：loadSessionFromDisk(PROJ, 1) 拿不到他区卷（归属不符 = 对本区不存在）
      panel = createChatPanel();
      panel.setProjectPath(PROJ);
      panel.setAgentFactory(storingFactory());
      await panel.loadSessionFromDisk(PROJ, 1);
      const sess = Session.getSessions(panel.panelId);
      expect(sess.some((s) => s.id === 1)).toBe(false);

      // 写：saveActiveSession(PROJ) 恒落全局位（单一路径，无旧目录回退）
      Session.setNextSessionId(panel.panelId, 1);
      panel.setAgent({
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '本区新内容' },
        ],
        setSession: vi.fn(),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
      } as any);
      await panel.saveActiveSession(PROJ);

      const write = JSON.parse(files[`${GLOBAL}/1.json`]);
      expect(write.workspace).toBe(PROJ); // 全局位被本区卷覆盖（同号防御场景下后写胜）
      expect(write.messages.some((m: any) => m.content === '本区新内容')).toBe(true);
      expect(files[`${PROJ}/.lantai/sessions/1.json`]).toBeUndefined(); // 旧目录零写入
    });

    it('零目录卷：全局位无 workspace 字段卷匹配零目录请求，带 workspace 卷不匹配', async () => {
      mockDualDirDisk({
        [`${GLOBAL}/7.json`]: JSON.stringify({
          id: 7,
          label: '零目录卷',
          savedAt: '2026-08-24T00:00:00Z',
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '零目录内容' },
          ],
        }),
      });
      panel = createChatPanel();
      panel.setProjectPath('');
      panel.setAgentFactory(async () => null);

      // 归零重建：零目录请求只匹配无 ws 字段卷（归属校验防御）
      await panel.loadSessionFromDisk('', 7);

      const sess = Session.getSessions(panel.panelId);
      expect(sess).toHaveLength(1);
      expect(sess[0].id).toBe(7);
      expect(
        msgStoreFor(panel.panelId, 7)
          .getState()
          .messages.some((m: any) => m.text === '零目录内容'),
      ).toBe(true);
    });

    it('deleteSessionFile 墓碑路由到卷所在位并携带 workspace 归属', async () => {
      const files = mockDualDirDisk({
        [`${GLOBAL}/3.json`]: JSON.stringify({
          id: 3,
          label: '已吸收卷',
          savedAt: '2026-08-24T00:00:00Z',
          messages: [{ role: 'user', content: 'x' }],
          workspace: PROJ,
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

      const tomb = JSON.parse(files[`${GLOBAL}/3.json`]);
      expect(tomb.deleted).toBe(true);
      expect(tomb.workspace).toBe(PROJ); // 墓碑带归属——双读匹配依赖
    });
  });
});
