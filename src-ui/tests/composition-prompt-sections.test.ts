import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import { assembleSystemPrompt, firstPartyPromptSections } from '../src/composition/prompt-sections';

// ── S1-4 section 注册表自检 ──
// 表序 = 拼装序（standard preset 的事实来源）。逐字节零漂移由
// verify:convergence 的 system-prompt.fixture 快照守护（设计件 §2.4），
// 此处钉注册表自身的结构语义。
// P4 B④ 收官（2026-08-23）：13 段全量迁 ctx.prompts 插件通道——出厂段表
// builtinPromptSections() 退役，firstPartyPromptSections() 是出厂装配面
// 唯一清单（序 = 迁移前出厂表序）；涉及装配输出的断言经
// withFirstPartyPromptChannel 复现生产装配面。

const GRAPH_DATA = { nodes: [{ id: 'a.ts', name: 'a', community_id: 0 }], edges: [] };

/** 第一方 prompt 段清单（序 = 拼装序 = 迁移前出厂表序——B④ 收官全量面）。 */
const SECTION_IDS = [
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

/** 完整面段（表序第 4 段起——前 3 段是简短面 *-brief）。 */
const FULL_FACE_IDS = SECTION_IDS.slice(3);

describe('composition/prompt-sections（S1-4 section 注册表，B④ 收官纯插件面）', () => {
  it('section id 唯一且稳定：第一方面 13 段（清单序 = 迁移前出厂表序）', () => {
    expect(firstPartyPromptSections().map((s) => s.id)).toEqual(SECTION_IDS);
    const ids = firstPartyPromptSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('两面互斥分流：无 graphData 只剩 brief 段；有 graphData 时 brief 段全跳过', () => {
    // 带 memory/env 内容让条件段全部参与，验证的是面分流而非条件门
    const full = { memorySection: 'mem', graphSnapshot: 'snap', claudeMdSection: 'md', shellEnvSection: 'env-line' };
    const noGraphIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(noGraphIds).toEqual(['identity-brief', 'memory-brief', 'env-brief']);

    const withGraphIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: GRAPH_DATA, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(withGraphIds).toEqual(FULL_FACE_IDS);
  });

  it('出厂面零漂移：通道内缺省拼装 ≡ 清单注入（无通道重述迁移前面）', async () => {
    // 迁移前出厂面的重述：13 段一并作 sections 注入（无通道 = 无贡献追加）
    // ——通道内缺省拼装（空解析产物 + 13 贡献）与之逐字节全等
    const preMigrationFace = assembleSystemPrompt(
      {
        graphData: GRAPH_DATA,
        projectPath: '/p',
        memorySection: 'mem',
        graphSnapshot: 'snap',
        claudeMdSection: 'md',
        providerName: 'deepseek',
        shellEnvSection: 'env-line',
      },
      firstPartyPromptSections(),
    );
    await withFirstPartyPromptChannel(async () => {
      expect(
        assembleSystemPrompt({
          graphData: GRAPH_DATA,
          projectPath: '/p',
          memorySection: 'mem',
          graphSnapshot: 'snap',
          claudeMdSection: 'md',
          providerName: 'deepseek',
          shellEnvSection: 'env-line',
        }),
      ).toBe(preMigrationFace);
    });
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
      // 尾部三段顺序：snapshot → memory → claude-md（贡献序 = 迁移前表尾序
      // ——字节零漂移的序面证据）
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
