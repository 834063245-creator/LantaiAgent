import { describe, expect, it, vi } from 'vitest';

// buildSystemPrompt 图谱退役签名（2026-09-09）：graphData/graphSnapshot 参数
// 随图谱全量退役删除——(graphData, projectPath, ...) → (projectPath, ...)。
// 原图快照插值面（graph-snapshot 段）退役后 prompt 只按 projectPath 判面。

vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn(), rpc: vi.fn() }));
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
}));

import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';

// P4 B④ 收官（2026-08-23）：出厂面全段经 ctx.prompts 通道贡献——
// 出厂拼装的断言须在通道腰内复现生产装配面（无通道 = 空提示词）。
describe('buildSystemPrompt', () => {
  it('零目录 prompt 含身份与模型身份说明', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt('');
      expect(prompt).toContain('没有加载项目');
      expect(prompt).toContain('DeepSeek');
    });
  });

  it('有目录 prompt 含项目路径与模型身份说明', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt('D:\\test-project');
      expect(prompt).toContain('D:\\test-project');
      expect(prompt).toContain('DeepSeek');
    });
  });

  it('memory section is appended when provided', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt('D:\\test-project', '## 记忆库\n- 测试记忆');
      expect(prompt).toContain('## 记忆库');
      expect(prompt).toContain('- 测试记忆');
    });
  });

  it('collaboration 静态段已从 system prompt 移除（模式信息归运行时 reminder）', async () => {
    await withFirstPartyPromptChannel(async () => {
      // 2026-08-28：collaboration-mode 段删除——系统提示词不再含静态协作模式块，
      // 规划/执行模式信息由 PlanModeInjector 的运行时 system-reminder 承担。
      const prompt = buildSystemPrompt('D:\\proj');
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
      const base = buildSystemPrompt('');
      const withEmpty = buildSystemPrompt('', '', '', undefined, '', undefined, '');
      expect(withEmpty).toBe(base);
    });
  });

  it('非空 skillCatalog：尾部追加「可用技能」段（name + description + when_to_use）', async () => {
    await withFirstPartyPromptChannel(async () => {
      const prompt = buildSystemPrompt(
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
