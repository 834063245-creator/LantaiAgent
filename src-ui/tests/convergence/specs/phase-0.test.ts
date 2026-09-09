// Phase 0 — 契约快照（验证计划 §4 Phase 0 / §2 gate.mjs check 的比对主体）。
//
// 默认模式：与 baseline/phase-0/ 下的人类审批快照逐行比对，漂移即失败。
// record 模式（CONVERGENCE_RECORD=1，仅经 gate.mjs record 触发）：重写 baseline。
// 快照覆盖（验证计划 §4 Phase 0 T3 清单）：
//   tool-schemas.full / tool-schemas.plan / system-prompt.fixture /
//   plan-gate.decisions / hook-pipeline.trace / create-agent.wiring
import { describe, expect, it } from 'vitest';
import { planGateCheck, planRegistry } from '../../../src/agent/plan/plan-registry';
import { PlanStateManager } from '../../../src/agent/plan/plan-state';
import { buildSystemPrompt } from '../../../src/agent/runtime/agent-builder';
import { withFirstPartyPromptChannel } from '../../../src/composition/first-party-prompts';
import { runDifferential } from '../helpers/differential';
import { agentDomainTool, buildStandardRegistry, fsDomainTool, readOnlyTool, throwingTool } from '../helpers/fixtures';
import { stableStringify } from '../helpers/normalize';
import { presetBaselineDir, resolvePreset, type ToolContribution } from '../helpers/presets';
import { compareText, snapshot } from '../helpers/snapshot';
import { runTraceCase, traceCases } from '../helpers/trace-fixtures';
import { extractRuntimeWiring, formatWiringReport } from '../helpers/wiring';

describe('phase-0 契约快照', () => {
  it('tool-schemas.full — 标准 buildToolRegistry 的模型可见工具面', async () => {
    // S1-0 §2.3：装配显式传 preset 贡献集（贡献集是参数不是环境）；
    // standard → 空集 = 现行装配，快照零漂移即回滚保证成立的证据。
    // S4-1b：减法型 preset（minimal）经 toolRows 传行集合（helper 派生）。
    const preset = resolvePreset();
    const reg = await buildStandardRegistry(preset.contributions, preset.toolRows);
    const schemas = reg.schemas();
    snapshot('phase-0/tool-schemas.full.json', {
      note: '本快照钉住装配后的模型可见静态注册面（内置行表 + 通道贡献 + 领域收敛）；引擎侧 MCP 工具面由引擎契约与 Rust 测试守护，不在本快照内',
      count: schemas.length,
      schemas,
    });
  });

  it('tool-schemas.plan — planRegistry 静态只读克隆工具面', async () => {
    const preset = resolvePreset();
    const base = await buildStandardRegistry(preset.contributions, preset.toolRows);
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const planReg = planRegistry(base, ps);
    const schemas = planReg.schemas();
    snapshot('phase-0/tool-schemas.plan.json', {
      count: schemas.length,
      schemas,
    });
  });

  it('system-prompt.fixture — 固定输入的 buildSystemPrompt（两面夹具：有目录 / 零目录）', async () => {
    // P4 B④ 收官（2026-08-23）：prompt 段全量经 ctx.prompts 第一方插件通道
    // 贡献（prompt-segments 装载 firstPartyPromptSections()）——测试环境
    // 不跑 main.ts 引导，通道腰在此复现生产装配面（同 B① 工具面
    // buildStandardRegistry 先例；贡献序 = 出厂表序，快照零漂移按构造）。
    // 两面（2026-09-09 图谱退役后）：hasProject = projectPath 非空——
    // 原三面（withGraph/engineOff/noGraph）随 graphData/引擎开关行为删除，
    // 夹具改两面：project（有目录面：path 非空，memory/claudeMd/shellEnv/
    // providerName 齐备——identity → env → model-identity → memory →
    // claude-md 按序拼装）与 noProject（零目录面：path=''，其余空——
    // identity-brief 独段，"当前没有加载项目"在此面才是真话）。
    await withFirstPartyPromptChannel(async () => {
      // 有目录面：memory/claudeMd/shellEnv/providerName 全注入。
      const project = buildSystemPrompt(
        '/projects/demo',
        '### 固定记忆段落\n- 记忆条目 A',
        '### CLAUDE.md 固定内容\n- 规范条目 A',
        'deepseek',
        '- OS: win32\n- Shell: bash (Git Bash)',
      );
      // 零目录面：占位工作区装配真值（path='' → hasProject=false）。
      const noProject = buildSystemPrompt('');
      // 面内实况断言（对照 prompt-sections.ts 的 IDENTITY/IDENTITY_BRIEF/
      // ENV/MODEL_IDENTITY/MEMORY/CLAUDE_MD 段渲染）——不依赖 baseline，
      // 两面的段位与关键内容直接钉死：
      expect(project.startsWith('你是兰台的编码 Agent。')).toBe(true);
      expect(project).toContain('\n\n## 运行环境\n- OS: win32\n- Shell: bash (Git Bash)');
      expect(project).toContain('## 模型身份');
      expect(project).toContain('- 项目: `/projects/demo`');
      expect(project).toContain('## 记忆库\n### 固定记忆段落\n- 记忆条目 A');
      expect(project).toContain('## 项目规范\n### CLAUDE.md 固定内容\n- 规范条目 A');
      expect(project).not.toContain('当前没有加载项目');
      expect(noProject.startsWith('你是兰台的 AI 编码助手。当前没有加载项目。')).toBe(true);
      expect(noProject).toContain('## 模型身份');
      expect(noProject).not.toContain('/projects/demo');
      expect(noProject).not.toContain('你是兰台的编码 Agent。');
      snapshot('phase-0/system-prompt.fixture.json', {
        projectLength: project.length,
        project,
        noProjectLength: noProject.length,
        noProject,
      });
    });
  });

  it('plan-gate.decisions — 固定矩阵的 planGateCheck 判定', () => {
    const ps = new PlanStateManager();
    const planFile = ps.enter('/proj');
    const matrix: Array<{ label: string; active: boolean; name: string; args: Record<string, unknown>; tool: Tool }> = [
      {
        label: '未激活-fs写放行',
        active: false,
        name: 'fs',
        args: { action: 'write', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      { label: '未激活-非只读放行', active: false, name: 'analyze_project', args: {}, tool: throwingTool() },
      { label: '激活-只读工具放行', active: true, name: 'graph_summary', args: {}, tool: readOnlyTool() },
      {
        label: '激活-领域只读动作放行',
        active: true,
        name: 'fs',
        args: { action: 'read', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      {
        label: '激活-领域写动作拦截',
        active: true,
        name: 'fs',
        args: { action: 'write', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      {
        label: '激活-fs写命中计划文件豁免',
        active: true,
        name: 'fs',
        args: { action: 'write', filePath: planFile },
        tool: fsDomainTool(),
      },
      {
        label: '激活-fs编辑path别名命中计划文件豁免',
        active: true,
        name: 'fs',
        args: { action: 'edit', path: planFile },
        tool: fsDomainTool(),
      },
      {
        label: '激活-agent spawn放行',
        active: true,
        name: 'agent',
        args: { action: 'spawn', description: 'explore' },
        tool: agentDomainTool(),
      },
      {
        label: '激活-agent kill拦截',
        active: true,
        name: 'agent',
        args: { action: 'kill', id: 'sub-1' },
        tool: agentDomainTool(),
      },
      { label: '激活-非领域非只读拦截', active: true, name: 'analyze_project', args: {}, tool: throwingTool() },
    ];
    const decisions = matrix.map((c) => {
      const state = c.active ? ps : null;
      const d = planGateCheck(state, c.name, c.args, c.tool);
      return { label: c.label, name: c.name, args: c.args, decision: d === null ? 'allow' : d };
    });
    snapshot('phase-0/plan-gate.decisions.json', { count: decisions.length, decisions });
  });

  it('hook-pipeline.trace — StreamingToolExecutor 固定事件顺序与输出', async () => {
    const traces = [];
    for (const c of traceCases()) {
      traces.push(await runTraceCase(c));
    }
    snapshot('phase-0/hook-pipeline.trace.json', { count: traces.length, traces });
  });

  it('create-agent.wiring — createAgent/_disposeAgent 装配 AST 清单', () => {
    snapshot('phase-0/create-agent.wiring.txt', formatWiringReport(extractRuntimeWiring()));
  });
});

// ── 机制自检：比对器自身被测（验证计划 §7.4 — 门禁脚本要有会故意失败的小 spec）──

describe('snapshot 机制自检', () => {
  it('compareText 检出首个差异行并给出上下文', () => {
    const r = compareText('a\nb\nc', 'a\nX\nc');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(2);
    expect(r.context).toContain('X');
    expect(r.context).toContain('期望: b');
    expect(compareText('same\nsame', 'same\nsame').ok).toBe(true);
  });

  it('stableStringify 排序 key 且归一计划 id / ISO 时间戳', () => {
    const s = stableStringify({
      b: 1,
      a: { y: 'plan-1720000000000-ab12', x: '2026-08-15T00:00:00.000Z' },
    });
    const aIdx = s.indexOf('"a"');
    const bIdx = s.indexOf('"b"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(s).toContain('plan-<id>');
    expect(s).toContain('<iso-ts>');
  });

  it('runDifferential：相同输入 ok，不同输入报告差异行', async () => {
    const same = await runDifferential(
      async () => ({ output: 'x', truncated: false }),
      async () => ({ output: 'x', truncated: false }),
    );
    expect(same.ok).toBe(true);
    const diff = await runDifferential(
      async () => ({ output: 'legacy', truncated: false }),
      async () => ({ output: 'new', truncated: false }),
    );
    expect(diff.ok).toBe(false);
    expect(diff.differences[0]).toContain('legacy');
  });
});
// ── preset 维度机制自检（S1-0 设计件 §2——门禁新维度自身被测，防自证）──

describe('preset 维度机制自检', () => {
  it('resolvePreset：缺省/显式 standard → STANDARD_PRESET；未知 preset 显式报错不静默回退', () => {
    expect(resolvePreset({}).name).toBe('standard');
    expect(resolvePreset({}).contributions).toEqual([]);
    expect(resolvePreset({ CONVERGENCE_PRESET: 'standard' }).name).toBe('standard');
    expect(() => resolvePreset({ CONVERGENCE_PRESET: 'ghost' })).toThrow(/未知 preset: ghost/);
  });

  it('presetBaselineDir：standard（含缺省）→ 原地布局零迁移；其他 → preset-<name>/ 子目录', () => {
    expect(presetBaselineDir({})).toBe('');
    expect(presetBaselineDir({ CONVERGENCE_PRESET: 'standard' })).toBe('');
    expect(presetBaselineDir({ CONVERGENCE_PRESET: 'minimal' })).toBe('preset-minimal/');
  });

  it('contributions 参数真实生效：注入行出现在注册面，重名行装载期拒绝', async () => {
    const probe: ToolContribution = {
      id: 'convergence/probe',
      factory: () => ({
        name: () => 'convergence_probe',
        description: () => 'preset mechanism probe',
        parameters: () => ({ type: 'object', properties: {} }),
        readOnly: () => true,
        execute: async () => 'ok',
      }),
    };
    const withProbe = await buildStandardRegistry([probe]);
    expect(withProbe.names()).toContain('convergence_probe');
    // 重名行 → ToolRegistry.register 装载期 duplicate throw（S1-3 冲突拒绝语义的先声）
    await expect(buildStandardRegistry([probe, probe])).rejects.toThrow(/duplicate tool/);
  });
});
