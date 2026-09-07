import { describe, expect, it, vi } from 'vitest';

// buildSystemPrompt moved from workspace.ts to agent/bootstrap.ts
// Function signature changed: (ws: Workspace, ...) → (graphData, projectPath, ...)

vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/agent/agent', () => ({ Agent: class {} }));
vi.mock('../src/agent/tool', () => ({
  ToolRegistry: class {
    register() {}
    alias() {}
    all() {
      return [];
    }
    schemas() {
      return [];
    }
    get() {
      return null;
    }
  },
  createCodingTools: () => [],
  createSubAgentTool: () => ({}),
}));
vi.mock('../src/agent/memory', () => ({
  MemoryManager: class {},
  createMemoryTools: () => [],
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/agent/hooks', () => ({
  HookRegistry: class {},
  PreflightHookRegistry: class {},
  createGraphContextHook: vi.fn(),
  createGraphContext: vi.fn(),
  createGraphPreflightHook: vi.fn(),
  formatGraphSnapshot: vi.fn(() => ''),
  asGraphSnapshot: vi.fn(() => null),
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [], activeProvider: 'deepseek' })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'deepseek', apiKey: 'test', baseUrl: '', model: '', kind: 'openai' })),
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('../src/provider/anthropic', () => ({ createAnthropicProvider: vi.fn() }));
vi.mock('../src/provider/openai', () => ({ createOpenAIProvider: vi.fn() }));
vi.mock('../src/provider/types', () => ({}));
vi.mock('../src/ui/debug', () => ({ dbg: vi.fn() }));
vi.mock('../src/ui/chat-store', () => ({
  msgStoreForActive: () => null,
  msgStoreFor: () => ({ getState: () => ({ messages: [], setMessages: () => {}, bump: () => {} }) }),
  getChatStore: () => ({ sess: { getState: () => ({ sessions: [{ id: 1 }], activeIdx: 0 }) } }),
  bumpSession: vi.fn(),
}));
vi.mock('../src/ui/chat-session', () => ({ rebuildMessagesFromMessages: vi.fn() }));
vi.mock('../src/ui/lsp-client', () => ({ getDiagnosticsForFile: vi.fn() }));
vi.mock('../src/state/panel-store', () => ({ getPanelStore: () => ({ getState: () => ({}) }) }));
vi.mock('../src/ui/subagent-sink', () => ({ createSubAgentSink: vi.fn() }));
vi.mock('../src/ui/message-model', () => ({}));

import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';

// P4 B④ 收官（2026-08-23）：出厂面 13 段全经 ctx.prompts 通道贡献——
// 出厂拼装的断言须在通道腰内复现生产装配面（无通道 = 空提示词）。
describe('buildSystemPrompt', () => {
  it('empty graph prompt contains model identity disclaimer', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt(null, '');
      expect(prompt).toContain('没有加载项目');
      expect(prompt).toContain('DeepSeek');
    });
  });

  it('loaded graph prompt contains model identity disclaimer', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt({ nodes: [1, 2, 3], edges: [1, 2] }, 'D:\\test-project');
      expect(prompt).toContain('D:\\test-project');
      expect(prompt).toContain('DeepSeek');
    });
  });

  it('memory section is appended when provided', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt(null, '', '## 记忆库\n- 测试记忆');
      expect(prompt).toContain('## 记忆库');
      expect(prompt).toContain('- 测试记忆');
    });
  });

  it('collaboration 静态段已从 system prompt 移除（模式信息归运行时 reminder）', async () => {
    await withFirstPartyPromptChannel(async () => {
      // 2026-08-28：collaboration-mode 段删除——系统提示词不再含静态协作模式块，
      // 规划/执行模式信息由 PlanModeInjector 的运行时 system-reminder 承担。
      const prompt = buildSystemPrompt({ nodes: [1], edges: [1] }, 'D:\\proj');
      expect(prompt).toContain('你是兰台的编码 Agent。');
      expect(prompt).not.toContain('## 协作模式');
      expect(prompt).not.toContain('执行模式');
    });
  });
});

// 技能目录段（skills-mcp-production-plan Commit 2）：装配期追加可用技能清单。
// 空/缺省 catalog = 零注入（fixture 与前缀缓存逐字节不变）；非空 = 尾部追加段。
describe('buildSystemPrompt — skillCatalog 追加', () => {
  it('缺省/空 skillCatalog：输出与无技能环境逐字节一致', async () => {
    await withFirstPartyPromptChannel(async () => {
      const base = buildSystemPrompt(null, '');
      const withEmpty = buildSystemPrompt(null, '', '', '', '', undefined, '', undefined, '');
      expect(withEmpty).toBe(base);
    });
  });

  it('非空 skillCatalog：尾部追加「可用技能」段（name + description + when_to_use）', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt(
        null,
        '',
        '',
        '',
        '',
        undefined,
        '',
        undefined,
        ['- **code-review**: 审查代码变更\n  - 适用: 用户提到审查时', '- **deploy**: 部署到生产'].join('\n'),
      );
      expect(prompt).toContain('## 可用技能');
      expect(prompt).toContain('- **code-review**: 审查代码变更');
      expect(prompt).toContain('- **deploy**: 部署到生产');
      // 段在提示词末尾（增量追加，不扰动既有段落）
      expect(prompt.trimEnd().endsWith('- **deploy**: 部署到生产')).toBe(true);
    });
  });
});
