// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具收敛回归测试 — 模型调用领域工具（fs/shell/search/...）后，
// UI 流式渲染（diff 视图 / bash 代码块 / 写入预览 / 替换语义）必须继续工作。
// 覆盖 tool-semantics / extractWritePreview / part-mutator。
// （formatToolResult 段随 C13 休眠层 sweep 删除——chat-utils 已退役）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks（与 audit-fixes-*.test.ts 一致的最小集）──
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

// ═══════════════════════════════════════════════════════════════════
// resolveSemanticToolName / displayToolName
// ═══════════════════════════════════════════════════════════════════

describe('resolveSemanticToolName — 领域调用归一化为旧语义名', () => {
  it('fs(write/edit/read/glob) 映射到旧名', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('fs', '{"action":"write","filePath":"/a.ts"}')).toBe('write_file');
    expect(resolveSemanticToolName('fs', '{"action":"edit"}')).toBe('edit_file');
    expect(resolveSemanticToolName('fs', '{"action":"read"}')).toBe('read_file_content');
    expect(resolveSemanticToolName('fs', '{"action":"glob"}')).toBe('glob');
  });

  it('shell/search/git 映射到旧名', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('shell', '{"action":"run"}')).toBe('run_shell');
    expect(resolveSemanticToolName('shell', '{"action":"output"}')).toBe('bash_output');
    expect(resolveSemanticToolName('shell', '{"action":"wait"}')).toBe('bash_wait');
    expect(resolveSemanticToolName('search', '{"action":"content"}')).toBe('search_content');
    expect(resolveSemanticToolName('git', '{"action":"commit"}')).toBe('git_commit');
  });

  it('非领域工具 / action 缺失 / 非法 JSON 原样返回', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('trace_impact', '{}')).toBe('trace_impact');
    expect(resolveSemanticToolName('fs', '{"filePath":"/a.ts"}')).toBe('fs');
    expect(resolveSemanticToolName('fs', '{not json')).toBe('fs');
    expect(resolveSemanticToolName('fs', undefined)).toBe('fs');
  });

  it('与 DOMAIN_SPECS 保持同步 — 每个 (domain, action) 都能解析', async () => {
    const { DOMAIN_SPECS } = await import('../src/agent/tools/domains');
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    for (const spec of DOMAIN_SPECS) {
      for (const [action, oldName] of Object.entries(spec.actions)) {
        expect(resolveSemanticToolName(spec.name, `{"action":"${action}"}`), `${spec.name}(${action})`).toBe(oldName);
      }
    }
  });
});

describe('displayToolName — 领域调用显示名', () => {
  it('领域工具显示 domain(action)', async () => {
    const { displayToolName } = await import('../src/ui/tool-semantics');
    expect(displayToolName('fs', '{"action":"write"}')).toBe('fs(write)');
    expect(displayToolName('git', '{"action":"status"}')).toBe('git(status)');
  });

  it('非领域工具 / 无 action 显示原名', async () => {
    const { displayToolName } = await import('../src/ui/tool-semantics');
    expect(displayToolName('trace_impact', '{}')).toBe('trace_impact');
    expect(displayToolName('fs', '{}')).toBe('fs');
    expect(displayToolName('glob', undefined)).toBe('glob');
  });
});

// ═══════════════════════════════════════════════════════════════════
// extractWritePreview — 领域工具流式写入预览
// ═══════════════════════════════════════════════════════════════════

describe('extractWritePreview — 领域工具流式预览', () => {
  it('fs(action=write) 从部分 JSON 提取 content', async () => {
    const { extractWritePreview } = await import('../src/plugins/builtin/llm-adapters/shared');
    const partial = '{"action":"write","filePath":"/a.ts","content":"hello\\nworld';
    const preview = extractWritePreview('fs', partial);
    expect(preview).toContain('hello');
    expect(preview).toContain('world');
  });

  it('fs(action=edit) 提取 newString', async () => {
    const { extractWritePreview } = await import('../src/plugins/builtin/llm-adapters/shared');
    const partial = '{"action":"edit","filePath":"/a.ts","newString":"replacement text';
    const preview = extractWritePreview('fs', partial);
    expect(preview).toBe('replacement text');
  });

  it('旧工具名行为不回归', async () => {
    const { extractWritePreview } = await import('../src/plugins/builtin/llm-adapters/shared');
    expect(extractWritePreview('write_file', '{"content":"data')).toBe('data');
    expect(extractWritePreview('edit_file', '{"newString":"x')).toBe('x');
    expect(extractWritePreview('run_shell', '{"command":"ls"}')).toBeNull();
    expect(extractWritePreview('fs', '{"action":"read"}')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// part-mutator — 领域工具流式输出语义（替换 vs 追加）
// ═══════════════════════════════════════════════════════════════════

describe('part-mutator — 领域工具 ToolProgress 语义', () => {
  let applyEventToParts: Awaited<ReturnType<typeof import('../src/ui/part-mutator')>>['applyEventToParts'];
  let AssistantPart: Awaited<ReturnType<typeof import('../src/ui/message-model')>>['AssistantPart'];
  let EventKind: Awaited<ReturnType<typeof import('../src/agent/agent-types')>>['EventKind'];

  beforeEach(async () => {
    const pm = await import('../src/ui/part-mutator');
    applyEventToParts = pm.applyEventToParts;
    const mm = await import('../src/ui/message-model');
    AssistantPart = mm.AssistantPart;
    const at = await import('../src/agent/agent-types');
    EventKind = at.EventKind;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fs(write) 的流式预览替换而非累积', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', read_only: false, partial: true },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', output: 'line 1' },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', output: 'line 1\nline 2' },
    });
    const tp = parts[0];
    expect(tp.type).toBe('tool');
    if (tp.type === 'tool') expect(tp.output).toBe('line 1\nline 2');
  });

  it('shell(run) 的 stdout 增量追加', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', read_only: false, partial: true },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', output: 'a' },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', output: 'b' },
    });
    const tp = parts[0];
    expect(tp.type).toBe('tool');
    if (tp.type === 'tool') expect(tp.output).toBe('ab');
  });

  /* ── startedAt 落戳（2026-09-06 纸面运行态：行走秒计时源） ── */

  it('partial dispatch = pending 不落戳；首转 running（progress/整参 dispatch）落戳且不重置', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'fs', args: '{"action":"read"', read_only: true, partial: true },
    });
    const tp = parts[0];
    if (tp.type !== 'tool') throw new Error('part 形状错误');
    expect(tp.status).toBe('pending');
    expect(tp.startedAt).toBeUndefined(); // 参数流式中不计时
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"read"}', output: 'x' },
    });
    const stamp = tp.startedAt;
    expect(typeof stamp).toBe('number'); // 首转 running 落戳
    // 后续 progress 不重置（elapsed 连续累计）
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"read"}', output: 'xy' },
    });
    expect(tp.startedAt).toBe(stamp);
    // 整参重发 dispatch（partial=false）同样不重置
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'fs', args: '{"action":"read"}', read_only: true, partial: false },
    });
    expect(tp.startedAt).toBe(stamp);
  });

  it('直建整参 dispatch（无 partial 期）→ 创建即落戳', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't9', name: 'search', args: '{"action":"content"}', read_only: true, partial: false },
    });
    const tp = parts[0];
    if (tp.type !== 'tool') throw new Error('part 形状错误');
    expect(tp.status).toBe('running');
    expect(typeof tp.startedAt).toBe('number');
  });
});
