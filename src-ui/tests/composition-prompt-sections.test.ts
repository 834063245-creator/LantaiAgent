import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import {
  assembleSystemPrompt,
  builtinPromptSections,
  migratedPromptSections,
} from '../src/composition/prompt-sections';

// ── S1-4 section 注册表自检 ──
// 表序 = 拼装序（standard preset 的事实来源）。逐字节零漂移由
// verify:convergence 的 system-prompt.fixture 快照守护（设计件 §2.4），
// 此处钉注册表自身的结构语义。
// P4 B④（2026-08-23）：memory/claude-md（试点）+ graph-snapshot（续批）
// 迁出表入 ctx.prompts 插件通道——出厂装配面 = 表内段 + 通道贡献段；
// 涉及装配输出的断言经 withFirstPartyPromptChannel 复现生产装配面
// （与表内段逐字一致）。

const GRAPH_DATA = { nodes: [{ id: 'a.ts', name: 'a', community_id: 0 }], edges: [] };

/** 表内段（builtinPromptSections 出厂表）。 */
const TABLE_SECTION_IDS = [
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
];

/** B④ 迁出段（ctx.prompts 第一方插件通道贡献——序 = 迁出前表尾序，
 *  新迁段插头部保序：表尾逆序批次下先迁段在原表中更靠后）。 */
const MIGRATED_SECTION_IDS = ['graph-snapshot', 'memory', 'claude-md'];

/** 出厂装配面（表 + 迁出段，序 = 拼装序）。 */
const ALL_SECTION_IDS = [...TABLE_SECTION_IDS, ...MIGRATED_SECTION_IDS];

/** 出厂装配面段列表（表 + 迁出段——通道贡献经插件注册，序同此）。 */
const factorySections = () => [...builtinPromptSections(), ...migratedPromptSections()];

describe('composition/prompt-sections（S1-4 section 注册表）', () => {
  it('section id 唯一且稳定：表内 10 段 + B④ 迁出 3 段，出厂装配面 13 段', () => {
    expect(builtinPromptSections().map((s) => s.id)).toEqual(TABLE_SECTION_IDS);
    expect(migratedPromptSections().map((s) => s.id)).toEqual(MIGRATED_SECTION_IDS);
    const ids = factorySections().map((s) => s.id);
    expect(ids).toEqual(ALL_SECTION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('两面互斥分流：无 graphData 只剩 brief 段；有 graphData 时 brief 段全跳过', () => {
    // 带 memory/env 内容让条件段全部参与，验证的是面分流而非条件门
    const full = { memorySection: 'mem', graphSnapshot: 'snap', claudeMdSection: 'md', shellEnvSection: 'env-line' };
    const noGraphIds = factorySections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(noGraphIds).toEqual(['identity-brief', 'memory-brief', 'env-brief']);

    const withGraphIds = factorySections()
      .filter((s) => !s.applicable || s.applicable({ graphData: GRAPH_DATA, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(withGraphIds).toEqual(ALL_SECTION_IDS.slice(3));
  });

  it('条件段语义：空白 shellEnv/memory 不参与；非空 snapshot/memory/claudeMd 参与且在尾部', async () => {
    await withFirstPartyPromptChannel(async () => {
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
      // 尾部三段顺序：snapshot → memory → claude-md（B④ 三段经通道贡献，
      // 贡献序 = 迁出前表尾序 = 迁出前表尾原位——字节零漂移的序面证据）
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
      expect(withoutOptional).not.toContain('## 项目架构快照');
      expect(withoutOptional).not.toContain('## 记忆库');
      expect(withoutOptional).not.toContain('## 项目规范');
    });
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

  it('简短面记忆库参与条件保留原差异：trim 判空（完整面是真值判空）', async () => {
    await withFirstPartyPromptChannel(async () => {
      // 简短面：空白-only memory 不参与
      const briefBlank = assembleSystemPrompt({ graphData: null, projectPath: '/p', memorySection: '   ' });
      expect(briefBlank).not.toContain('## 记忆库');
      // 完整面：空白-only memory 仍参与（原 if (memorySection) 真值判断）
      const fullBlank = assembleSystemPrompt({ graphData: GRAPH_DATA, projectPath: '/p', memorySection: '   ' });
      expect(fullBlank).toContain('## 记忆库');
    });
  });
});
