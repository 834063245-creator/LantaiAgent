import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { assembleSystemPrompt, builtinPromptSections } from '../src/composition/prompt-sections';

// ── S1-4 section 注册表自检 ──
// 表序 = 拼装序（standard preset 的事实来源）。逐字节零漂移由
// verify:convergence 的 system-prompt.fixture 快照守护（设计件 §2.4），
// 此处钉注册表自身的结构语义。

const GRAPH_DATA = { nodes: [{ id: 'a.ts', name: 'a', community_id: 0 }], edges: [] };

const ALL_SECTION_IDS = [
  'identity-brief',
  'memory-brief',
  'env-brief',
  'behavior-rules',
  'graph-discipline',
  'visual-discipline',
  'collaboration-mode',
  'env',
  'model-identity',
  'multi-agent',
  'graph-snapshot',
  'memory',
  'claude-md',
];

describe('composition/prompt-sections（S1-4 section 注册表）', () => {
  it('section id 唯一且稳定，表序 = 拼装序（13 段）', () => {
    const ids = builtinPromptSections().map((s) => s.id);
    expect(ids).toEqual(ALL_SECTION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('两面互斥分流：无 graphData 只剩 brief 段；有 graphData 时 brief 段全跳过', () => {
    // 带 memory/env 内容让条件段全部参与，验证的是面分流而非条件门
    const full = { memorySection: 'mem', graphSnapshot: 'snap', claudeMdSection: 'md', shellEnvSection: 'env-line' };
    const noGraphIds = builtinPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(noGraphIds).toEqual(['identity-brief', 'memory-brief', 'env-brief']);

    const withGraphIds = builtinPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: GRAPH_DATA, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(withGraphIds).toEqual(ALL_SECTION_IDS.slice(3));
  });

  it('条件段语义：空白 shellEnv/memory 不参与；非空 snapshot/memory/claudeMd 参与且在尾部', () => {
    const withAll = assembleSystemPrompt({
      graphData: GRAPH_DATA,
      projectPath: '/p',
      memorySection: 'mem',
      graphSnapshot: 'snap',
      claudeMdSection: 'md',
      shellEnvSection: 'env-line',
    });
    expect(withAll).toContain('## 运行环境\nenv-line');
    expect(withAll).toContain('## 记忆库\nmem');
    expect(withAll).toContain('## 项目架构快照');
    expect(withAll).toContain('## 项目规范\nmd');
    // 尾部三段顺序：snapshot → memory → claude-md
    const snapIdx = withAll.indexOf('## 项目架构快照');
    const memIdx = withAll.indexOf('## 记忆库');
    const mdIdx = withAll.indexOf('## 项目规范');
    expect(snapIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(mdIdx);

    const withoutOptional = assembleSystemPrompt({
      graphData: GRAPH_DATA,
      projectPath: '/p',
    });
    expect(withoutOptional).not.toContain('## 运行环境');
    expect(withoutOptional).not.toContain('## 记忆库');
    expect(withoutOptional).not.toContain('## 项目规范');
  });

  it('壳函数与拼装器一致：buildSystemPrompt === assembleSystemPrompt（同输入）', () => {
    const args = [GRAPH_DATA, '/projects/demo', 'mem', 'snap', 'md', 'deepseek', '- OS: win32'] as const;
    const viaBuilder = buildSystemPrompt(...args);
    const viaSections = assembleSystemPrompt({
      graphData: args[0],
      projectPath: args[1],
      memorySection: args[2],
      graphSnapshot: args[3],
      claudeMdSection: args[4],
      providerName: args[5],
      shellEnvSection: args[6],
    });
    expect(viaBuilder).toBe(viaSections);
  });

  it('简短面记忆库参与条件保留原差异：trim 判空（完整面是真值判空）', () => {
    // 简短面：空白-only memory 不参与
    const briefBlank = assembleSystemPrompt({ graphData: null, projectPath: '/p', memorySection: '   ' });
    expect(briefBlank).not.toContain('## 记忆库');
    // 完整面：空白-only memory 仍参与（原 if (memorySection) 真值判断）
    const fullBlank = assembleSystemPrompt({ graphData: GRAPH_DATA, projectPath: '/p', memorySection: '   ' });
    expect(fullBlank).toContain('## 记忆库');
  });
});
