import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import { assembleSystemPrompt, firstPartyPromptSections } from '../src/composition/prompt-sections';

// ── S1-4 section 注册表自检 ──
// 表序 = 拼装序（standard preset 的事实来源）。逐字节零漂移由
// verify:convergence 的 system-prompt.fixture 快照守护（设计件 §2.4），
// 此处钉注册表自身的结构语义。
// P4 B④ 收官（2026-08-23）：9 段全量迁 ctx.prompts 插件通道——出厂段表
// builtinPromptSections() 退役，firstPartyPromptSections() 是出厂装配面
// 唯一清单（序 = 迁移前出厂表序）；涉及装配输出的断言经
// withFirstPartyPromptChannel 复现生产装配面。
// 三面解耦（2026-08-25）：hasProject（绑目录）与 hasGraph（图谱数据）独立
// 判段——零目录面 / 关引擎面 / 完整面。null 图 + 非空路径不再落零目录
// 简短面（旧二分的缺陷——行为规则/协作模式/项目规范全部陪葬）。

const GRAPH_DATA = { nodes: [{ id: 'a.ts', name: 'a', community_id: 0 }], edges: [] };

/** 第一方 prompt 段清单（序 = 拼装序 = 迁移前出厂表序——B④ 收官全量面）。 */
const SECTION_IDS = [
  'identity-brief',
  'memory-brief',
  'env-brief',
  'identity',
  'env',
  'model-identity',
  'graph-snapshot',
  'memory',
  'claude-md',
];

/** 完整面段（表序第 4 段起——前 3 段是零目录面 *-brief）。 */
const FULL_FACE_IDS = SECTION_IDS.slice(3);

/** 关引擎面段（完整面去掉 graph-snapshot——没图不注入图快照）。 */
const ENGINE_OFF_FACE_IDS = FULL_FACE_IDS.filter((id) => id !== 'graph-snapshot');

describe('composition/prompt-sections（S1-4 section 注册表，B④ 收官纯插件面）', () => {
  it('section id 唯一且稳定：第一方面 9 段（清单序 = 迁移前出厂表序）', () => {
    expect(firstPartyPromptSections().map((s) => s.id)).toEqual(SECTION_IDS);
    const ids = firstPartyPromptSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('两面互斥分流：无 graphData 只剩 brief 段；有 graphData 时 brief 段全跳过', () => {
    // 带 memory/env 内容让条件段全部参与，验证的是面分流而非条件门
    const full = { memorySection: 'mem', graphSnapshot: 'snap', claudeMdSection: 'md', shellEnvSection: 'env-line' };
    // 三面解耦（2026-08-25）：零目录面 = 显式 hasProject:false（占位工作区
    // path='' 的装配真值）；缺省推导（无 hasProject 字段）在 null 图时
    // 落关引擎面——兼容壳 buildSystemPrompt 恒传 hasProject:path!==''。
    const noGraphIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '/p', hasProject: false, ...full }))
      .map((s) => s.id);
    expect(noGraphIds).toEqual(['identity-brief', 'memory-brief', 'env-brief']);

    const withGraphIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: GRAPH_DATA, projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(withGraphIds).toEqual(FULL_FACE_IDS);
  });

  it('三面解耦：关引擎面（有目录、无图）——目录段注入、图段缺席、缺省推导兼容', async () => {
    // 三面解耦（2026-08-25）核心断言：绑目录但关图谱引擎的 Agent
    // 不再跌进零目录简短面。
    const full = { memorySection: 'mem', graphSnapshot: 'snap', claudeMdSection: 'md', shellEnvSection: 'env-line' };

    // 段面：关引擎面 = 完整面减图纪律/图快照
    const engineOffIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '/p', hasProject: true, ...full }))
      .map((s) => s.id);
    expect(engineOffIds).toEqual(ENGINE_OFF_FACE_IDS);

    // 缺省推导：null 图 + 无 hasProject 字段 + 无路径（旧测试路径）→ 零目录面
    // ——兼容 B④ 收官时代的既有调用点（显式 false 与 path='' 缺省同面）。
    const legacyBrief = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ graphData: null, projectPath: '', ...full }))
      .map((s) => s.id);
    expect(legacyBrief).toEqual(['identity-brief', 'memory-brief', 'env-brief']);

    await withFirstPartyPromptChannel(async () => {
      // 拼装面：关引擎面含项目规范/记忆库，含模型身份项目路径行与引擎停用行，
      // 不含图快照，不含零目录面的"当前没有加载项目"假话。
      const engineOff = assembleSystemPrompt({
        graphData: null,
        projectPath: '/projects/demo',
        hasProject: true,
        memorySection: 'mem',
        claudeMdSection: 'md',
        providerName: 'deepseek',
        shellEnvSection: 'env-line',
      });
      expect(engineOff).toContain('## 记忆库\nmem');
      expect(engineOff).toContain('## 项目规范\nmd');
      expect(engineOff).toContain('项目: `/projects/demo`');
      expect(engineOff).toContain('图谱引擎已停用');
      expect(engineOff).not.toContain('## 项目架构快照');
      expect(engineOff).not.toContain('当前没有加载项目');

      // 关引擎面 = 完整面扣除图快照 + 模型身份停用行差异：
      // 完整面（同内容输入）与之共享全部非图段文本。
      const withGraphFace = assembleSystemPrompt({
        graphData: GRAPH_DATA,
        projectPath: '/projects/demo',
        memorySection: 'mem',
        graphSnapshot: 'snap',
        claudeMdSection: 'md',
        providerName: 'deepseek',
        shellEnvSection: 'env-line',
      });
      expect(withGraphFace).toContain('## 项目架构快照');
      // 模型身份段：完整面无停用行（有图），关引擎面有（无图 + 有目录）
      expect(withGraphFace).not.toContain('图谱引擎已停用');
    });
  });

  it('出厂面零漂移：通道内缺省拼装 ≡ 清单注入（无通道重述迁移前面）', async () => {
    // 迁移前出厂面的重述：9 段一并作 sections 注入（无通道 = 无贡献追加）
    // ——通道内缺省拼装（空解析产物 + 9 贡献）与之逐字节全等
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

  it('零目录面记忆库参与条件保留原差异：trim 判空（完整面是真值判空）', async () => {
    await withFirstPartyPromptChannel(async () => {
      // 零目录面：空白-only memory 不参与（显式 hasProject:false——三面解耦
      // 后零目录面不再由 null 图单信号决定）
      const briefBlank = assembleSystemPrompt({
        graphData: null,
        projectPath: '/p',
        hasProject: false,
        memorySection: '   ',
      });
      expect(briefBlank).not.toContain('## 记忆库');
      // 完整面：空白-only memory 仍参与（原 if (memorySection) 真值判断）
      const fullBlank = assembleSystemPrompt({ graphData: GRAPH_DATA, projectPath: '/p', memorySection: '   ' });
      expect(fullBlank).toContain('## 记忆库');
    });
  });
});
