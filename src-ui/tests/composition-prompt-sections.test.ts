import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import { assembleSystemPrompt } from '../src/composition/prompt-sections';
import { firstPartyPromptSections } from '../src/plugins/builtin/prompt-segments/sections';

// ── S1-4 section 注册表自检 ──
// 表序 = 拼装序（standard preset 的事实来源）。逐字节零漂移由
// verify:convergence 的 system-prompt.fixture 快照守护（设计件 §2.4），
// 此处钉注册表自身的结构语义。
// P4 B④ 收官（2026-08-23）：全量段迁 ctx.prompts 插件通道——出厂段表
// builtinPromptSections() 退役，firstPartyPromptSections() 是出厂装配面
// 唯一清单（序 = 迁移前出厂表序）；涉及装配输出的断言经
// withFirstPartyPromptChannel 复现生产装配面。
// 图谱退役（2026-09-09）：graphData/graphSnapshot 判面与 graph-snapshot 段、
// 「图谱引擎已停用」行删除——两面收缩为 hasProject（绑目录）独立判段：
// 零目录面 / 有目录面。

/** 第一方 prompt 段清单（序 = 拼装序 = 迁移前出厂表序——B④ 收官全量面）。
 *  2026-09-24 配方改文件批：补 `provider-config`（provider 配置文件路径与可改字段
 *  ——agent 要能自己配 provider，不必请用户去点设置页）。 */
const SECTION_IDS = [
  'identity-brief',
  'env-brief',
  'identity',
  'env',
  'model-identity',
  'provider-config',
  'claude-md',
];

/** 有目录面段（表序第 3 段起——前 2 段是零目录面 *-brief；memory-brief 已随
 *  2026-10-28 卷首字节稳定性批摘除）。 */
const FULL_FACE_IDS = SECTION_IDS.slice(2);

describe('composition/prompt-sections（S1-4 section 注册表，B④ 收官纯插件面）', () => {
  it('section id 唯一且稳定：第一方面 9 段（清单序 = 迁移前出厂表序 − graph-snapshot + provider-config）', () => {
    expect(firstPartyPromptSections().map((s) => s.id)).toEqual(SECTION_IDS);
    const ids = firstPartyPromptSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('两面互斥分流：零目录只剩 brief 段；有目录时 brief 段全跳过', () => {
    // 带 memory/env 内容让条件段全部参与，验证的是面分流而非条件门
    // （provider-config 段同款：给路径才参与——见下一条用例的条件面）
    const full = {
      claudeMdSection: 'md',
      shellEnvSection: 'env-line',
      providerConfigPath: '/home/u/.lantai/providers.yml',
    };
    // 两面（图谱退役后）：hasProject 独立判段——零目录面 = 显式 hasProject:false
    // （占位工作区 path='' 的装配真值）；缺省推导（无 hasProject 字段）按
    // projectPath 非空落面——兼容壳 buildSystemPrompt 恒传 hasProject:path!==''。
    const noProjectIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ projectPath: '/p', hasProject: false, ...full }))
      .map((s) => s.id);
    expect(noProjectIds).toEqual(['identity-brief', 'env-brief']);

    const withProjectIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(withProjectIds).toEqual(FULL_FACE_IDS);
  });

  it('有目录面装配：目录段注入、模型身份带项目路径、无零目录面假话', async () => {
    const full = {
      claudeMdSection: 'md',
      shellEnvSection: 'env-line',
      providerConfigPath: '/home/u/.lantai/providers.yml',
    };

    // 段面：有目录面 = 完整 8 段扣 brief 前三段
    const projectIds = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ projectPath: '/p', hasProject: true, ...full }))
      .map((s) => s.id);
    expect(projectIds).toEqual(FULL_FACE_IDS);

    // 缺省推导：无 hasProject 字段 + 非空路径 → 有目录面（壳函数恒传 path）
    const legacyProject = firstPartyPromptSections()
      .filter((s) => !s.applicable || s.applicable({ projectPath: '/p', ...full }))
      .map((s) => s.id);
    expect(legacyProject).toEqual(FULL_FACE_IDS);

    await withFirstPartyPromptChannel(async () => {
      // 拼装面：有目录面含项目规范/记忆库 + 模型身份项目路径行 + provider 配置段，
      // 不含零目录面的"当前没有加载项目"假话，无图谱停用行（引擎已不存在）。
      const assembled = assembleSystemPrompt({
        projectPath: '/projects/demo',
        hasProject: true,
        claudeMdSection: 'md',
        providerName: 'deepseek',
        shellEnvSection: 'env-line',
        providerConfigPath: '/home/u/.lantai/providers.yml',
      });
      // 2026-10-28 卷首字节稳定性：记忆库**不进卷首**（改走对话尾部注入）
      expect(assembled).not.toContain('## 记忆库');
      expect(assembled).toContain('## 项目规范\nmd');
      expect(assembled).toContain('项目: `/projects/demo`');
      expect(assembled).toContain('## provider 配置');
      expect(assembled).toContain('/home/u/.lantai/providers.yml');
      expect(assembled).not.toContain('图谱引擎已停用');
      expect(assembled).not.toContain('## 项目架构快照');
      expect(assembled).not.toContain('当前没有加载项目');
    });
  });

  // provider 配置段（2026-09-24 配方改文件批）：没路径就不注入（零目录/未装载
  // = 不编造一份不存在的文件路径——零注入纪律同 memory/技能目录）。
  it('provider-config 段条件面：无路径不参与，有路径参与且给出可改字段', async () => {
    await withFirstPartyPromptChannel(async () => {
      const without = assembleSystemPrompt({ projectPath: '/p' });
      expect(without).not.toContain('## provider 配置');
      const withPath = assembleSystemPrompt({
        projectPath: '/p',
        providerConfigPath: 'C:/Users/u/.lantai/providers.yml',
      });
      expect(withPath).toContain('## provider 配置');
      expect(withPath).toContain('C:/Users/u/.lantai/providers.yml');
      expect(withPath).toContain('.lantai/providers.yml');
      expect(withPath).toContain('apiKey');
      expect(withPath).toContain('kind');
    });
  });

  it('出厂面零漂移：通道内缺省拼装 ≡ 清单注入（无通道重述迁移前面）', async () => {
    // 迁移前出厂面的重述：8 段一并作 sections 注入（无通道 = 无贡献追加）
    // ——通道内缺省拼装（空解析产物 + 8 贡献）与之逐字节全等
    const preMigrationFace = assembleSystemPrompt(
      {
        projectPath: '/p',
        hasProject: true,
        claudeMdSection: 'md',
        providerName: 'deepseek',
        shellEnvSection: 'env-line',
      },
      firstPartyPromptSections(),
    );
    await withFirstPartyPromptChannel(async () => {
      expect(
        assembleSystemPrompt({
          projectPath: '/p',
          claudeMdSection: 'md',
          providerName: 'deepseek',
          shellEnvSection: 'env-line',
        }),
      ).toBe(preMigrationFace);
    });
  });

  it('条件段语义：空白 shellEnv/memory/claudeMd 不参与；非空参与且在尾部', async () => {
    await withFirstPartyPromptChannel(async () => {
      const withAll = assembleSystemPrompt({
        projectPath: '/p',
        claudeMdSection: 'md',
        shellEnvSection: 'env-line',
      });
      expect(withAll).toContain('## 运行环境\nenv-line');
      expect(withAll).toContain('## 项目规范\nmd');
      // 卷首恒不含记忆库（2026-10-28 起改走对话尾部）
      expect(withAll).not.toContain('## 记忆库');

      const withoutOptional = assembleSystemPrompt({
        projectPath: '/p',
      });
      expect(withoutOptional).not.toContain('## 运行环境');
      expect(withoutOptional).not.toContain('## 记忆库');
      expect(withoutOptional).not.toContain('## 项目规范');
    });
  });

  it('壳函数与拼装器一致：buildSystemPrompt === assembleSystemPrompt（同输入，无技能目录）', async () => {
    await withFirstPartyPromptChannel(async () => {
      const projectPath = '/projects/demo';
      const claudeMdSection = 'md';
      const providerName = 'deepseek';
      const shellEnvSection = '- OS: win32';
      const viaBuilder = buildSystemPrompt(projectPath, claudeMdSection, providerName, shellEnvSection);
      const viaSections = assembleSystemPrompt({
        projectPath,
        claudeMdSection,
        providerName,
        shellEnvSection,
      });
      expect(viaBuilder).toBe(viaSections);
    });
  });

  it('记忆库**永不在卷首**（2026-10-28 卷首字节稳定性批）', async () => {
    await withFirstPartyPromptChannel(async () => {
      // 两面前提下都不出现：记忆随增删变字节，坐卷首会打穿其后的**全部对话**前缀。
      // 它改由 Agent 每轮以 transient reminder 注入对话尾部（agent.ts memoryDigest，
      // 永不落历史）——旧卷也能看到新写的记忆。
      const brief = assembleSystemPrompt({ projectPath: '', hasProject: false });
      expect(brief).not.toContain('## 记忆库');
      const full = assembleSystemPrompt({
        projectPath: '/p',
        hasProject: true,
        claudeMdSection: 'md',
      });
      expect(full).not.toContain('## 记忆库');
      // 段表里也不该再有这两个 id——防止有人「顺手加回来」
      const ids = firstPartyPromptSections().map((s) => s.id);
      expect(ids).not.toContain('memory');
      expect(ids).not.toContain('memory-brief');
    });
  });
});
