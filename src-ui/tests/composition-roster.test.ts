// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// roster 组合引擎测试（S2-0）—— 设计件 §3 S2-0 验收的完整钉面：
//   1. 恒等性：resolveRoster(factory, []) 与出厂表 id+序 全等（零漂移的构造性保证）；
//   2. 语义：disable（四域）/ text 覆盖（保位保 applicable）/ insert（三种锚，
//      锚可指禁用行，同层链式）/ last-write-wins（跨层 + 同层）；
//   3. 确定性：同输入两次解析 id 序全等；
//   4. 拒绝：未知 id / insert 撞 id / 锚点不存在 → CompositionPatchError
//      （all-or-nothing：throw 即整体拒绝，无部分应用产出）；
//   5. parseCompositionPatch：合法全形状 / 各类形状违规（strict + refine）。
// P4 B④ 收官（2026-08-23）：prompt 域出厂表空（13 第一方段经 ctx.prompts
// 通道贡献）——prompt 域语义探针全部改用「已插入段」。
// S4-4 甲（2026-08-23）：解析域收编通道贡献——factoryComposition() 是
// 通道装载态快照（无通道环境 = builtin 行 + 空段表，本文件多数探针在该面
// 跑；通道内快照/第一方段寻址恢复另有专测）。

import { describe, expect, it } from 'vitest';
import { builtinCapabilities } from '../src/agent/blueprint';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { activePromptContributions } from '../src/composition/prompt-service';
import {
  CompositionPatchError,
  factoryComposition,
  parseCompositionPatch,
  resolveRoster,
} from '../src/composition/roster';
import { builtinShellRows } from '../src/composition/shell-rows';
import { builtinToolRows } from '../src/composition/tool-rows';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);
const capKeys = (): string[] => builtinCapabilities().map((c) => c.key);

describe('composition/roster（S2-0 组合引擎）', () => {
  it('factoryComposition 聚合三张出厂表 + 壳行表（V5 拆除后 9 行全量，序 = 引导序）', () => {
    const f = factoryComposition();
    expect(ids(f.tools)).toEqual(ids(builtinToolRows()));
    // 无通道环境 = 空贡献快照（B④ 收官的注册面依赖语义——S4-4 甲不变）
    expect(f.prompt).toEqual([]);
    expect(f.capabilities.map((c) => c.key)).toEqual(capKeys());
    expect(ids(f.shell)).toEqual(ids(builtinShellRows()));
    // V5 拆除（2026-08-22）：shell-graph / shell-dataflow-parser / shell-nav
    // 三行随旧观测台退役（星图渲染/DataflowPanel/导航 wire）。
    expect(ids(f.shell)).toEqual([
      'hologram/shell-platform',
      'hologram/shell-chat',
      'hologram/shell-bridges',
      'hologram/shell-keyguard',
      'hologram/shell-sandbox-probe',
      'hologram/shell-persistence',
      'hologram/shell-actions',
      'hologram/shell-workspace',
      'hologram/shell-cold-start',
    ]);
  });

  it('S4-4 甲：工厂基座快照收编通道贡献（通道内 = builtin 行 + plugin 行 + 段贡献）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyPromptChannel(async () => {
        const f = factoryComposition();
        // tools 域：builtin 行在前、插件贡献行随后（序 = 装配序）
        expect(ids(f.tools)).toEqual([...ids(builtinToolRows()), ...pluginToolRows().map((r) => r.id)]);
        expect(f.tools.some((r) => r.id === 'plugin/hologram/git-domain/git_status')).toBe(true);
        // prompt 域：通道段贡献快照（注册序）
        expect(f.prompt.map((s) => s.id)).toEqual(activePromptContributions().map((s) => s.id));
        expect(f.prompt.map((s) => s.id)).toContain('multi-agent');
        // 恒等解析在快照面同样成立（空层列表 = 快照全等）
        const r = resolveRoster(f, []);
        expect(ids(r.tools)).toEqual(ids(f.tools));
        expect(r.prompt.map((s) => s.id)).toEqual(f.prompt.map((s) => s.id));
      }),
    );
  });

  it('空层列表 = 恒等（id + 序，零漂移的构造性保证；无通道 = 空贡献面）', () => {
    const r = resolveRoster(factoryComposition(), []);
    expect(ids(r.tools)).toEqual(ids(builtinToolRows()));
    expect(r.prompt).toEqual([]);
    expect(r.capabilities.map((c) => c.key)).toEqual(capKeys());
    expect(ids(r.shell)).toEqual(ids(builtinShellRows()));
    expect(r.diagnostics).toEqual({ disabled: [], overridden: [], inserted: [] });
  });

  it('确定性：同输入两次解析 id 序全等（纯函数）', () => {
    const layers = [
      {
        tools: [{ id: 'builtin/web', disabled: true }],
        prompt: [{ insert: [{ id: 'det-probe', text: 'X' }] }],
      },
    ];
    const a = resolveRoster(factoryComposition(), layers);
    const b = resolveRoster(factoryComposition(), layers);
    expect(ids(a.tools)).toEqual(ids(b.tools));
    expect(ids(a.prompt)).toEqual(ids(b.prompt));
    expect(a.prompt.map((s) => s.render({ projectPath: '' }))).toEqual(
      b.prompt.map((s) => s.render({ projectPath: '' })),
    );
  });

  // ── disable 语义 ──

  it('disable：tools 行移除、其余保序、diagnostics 记录', () => {
    // ①c（2026-08-23）：builtin/wait 迁插件通道——禁用探针改 builtin/web
    // （builtin 行表）+ plugin/hologram/wait-domain/wait（贡献行，无通道
    // 环境不在解析域——改 builtin/browser-desktop 作第二行）
    const r = resolveRoster(factoryComposition(), [
      {
        tools: [
          { id: 'builtin/web', disabled: true },
          { id: 'builtin/browser-desktop', disabled: true },
        ],
      },
    ]);
    const expected = ids(builtinToolRows()).filter((id) => id !== 'builtin/web' && id !== 'builtin/browser-desktop');
    expect(ids(r.tools)).toEqual(expected);
    // 诊断按表序收集（描述终态组合，与 patch 声明序无关）
    expect(r.diagnostics.disabled).toEqual(['builtin/web', 'builtin/browser-desktop']);
  });

  it('disable：已插入段可禁用（prompt 域现存寻址面）/ capability 同语义', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [{ insert: [{ id: 'user-seg', text: '用户段' }] }, { id: 'user-seg', disabled: true }],
        capabilities: [{ id: 'auto-tune', disabled: true }],
        // shell 出厂表为空 → 未知 id 拒绝（见拒绝组），此处只验证空域无操作
      },
    ]);
    expect(r.prompt).toEqual([]);
    expect(r.capabilities.map((c) => c.key)).toEqual(capKeys().filter((k) => k !== 'auto-tune'));
  });

  it('S4-4 甲：第一方段寻址恢复（disable/text/锚定/insert 撞名拒绝——通道内）', async () => {
    // 13 第一方段经 ctx.prompts 通道贡献——通道内快照进解析域，
    // 寻址/锚定/撞名语义与出厂段表时代一致（B④ 收官临时语义消灭）
    await withFirstPartyPromptChannel(async () => {
      const f = factoryComposition();
      // disable 第一方段
      const r1 = resolveRoster(f, [{ prompt: [{ id: 'multi-agent', disabled: true }] }]);
      expect(r1.prompt.map((s) => s.id)).not.toContain('multi-agent');
      expect(r1.diagnostics.disabled).toContain('multi-agent');
      // text 覆盖第一方段：保位 + 保 applicable、render 换固定文本
      const r2 = resolveRoster(f, [{ prompt: [{ id: 'identity-brief', text: '【替换段】' }] }]);
      const seg = r2.prompt.find((s) => s.id === 'identity-brief');
      expect(seg?.render({ projectPath: '' })).toBe('【替换段】');
      expect(r2.diagnostics.overridden).toContain('identity-brief');
      // insert 锚定第一方段（after：紧随其后）
      const r3 = resolveRoster(f, [{ prompt: [{ insert: [{ id: 'probe', after: 'behavior-rules', text: 'P' }] }] }]);
      const idx = r3.prompt.findIndex((s) => s.id === 'behavior-rules');
      expect(r3.prompt[idx + 1].id).toBe('probe');
      // insert id 与第一方段同名 → 撞名拒绝（B④ 收官「不拒」临时语义消灭）
      expect(() =>
        resolveRoster(f, [{ prompt: [{ insert: [{ id: 'multi-agent', text: '自定义多 Agent 段' }] }] }]),
      ).toThrow(CompositionPatchError);
    });
  });

  it('disable(false) = 显式启用：后层覆盖先层禁用（last-write-wins）', () => {
    const r = resolveRoster(factoryComposition(), [
      { tools: [{ id: 'builtin/web', disabled: true }] },
      { tools: [{ id: 'builtin/web', disabled: false }] },
    ]);
    expect(ids(r.tools)).toEqual(ids(builtinToolRows())); // 全量（wait 被重新启用）
    expect(r.diagnostics.disabled).toEqual([]);
  });

  it('同层同 id 重复 = 后条覆盖前条（已插入段上）', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          { insert: [{ id: 'dup-seg', text: '一' }] },
          { id: 'dup-seg', disabled: true },
          { id: 'dup-seg', disabled: false },
        ],
      },
    ]);
    expect(ids(r.prompt)).toEqual(['dup-seg']);
  });

  // ── text 覆盖语义 ──

  it('text 覆盖：已插入段保位 + render 换固定文本', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          {
            insert: [
              { id: 'seg-1', text: '第一版' },
              { id: 'seg-2', text: '第二版' },
            ],
          },
          { id: 'seg-1', text: '整段替换后的文本' },
        ],
      },
    ]);
    // 保位
    expect(ids(r.prompt)).toEqual(['seg-1', 'seg-2']);
    // render 换新文本（无前导分隔符——整段接管，含分隔符由用户文本自备）
    expect(r.prompt[0].render({ projectPath: '' })).toBe('整段替换后的文本');
    // 插入段恒参与（无 applicable）——text 覆盖不引入 applicable
    expect(r.prompt[0].applicable).toBeUndefined();
    expect(r.diagnostics.overridden).toEqual(['seg-1']);
  });

  it('text 覆盖两次（跨层）= 后层文本胜出，诊断去重', () => {
    const r = resolveRoster(factoryComposition(), [
      { prompt: [{ insert: [{ id: 'seg', text: '原文' }] }] },
      { prompt: [{ id: 'seg', text: '第一版' }] },
      { prompt: [{ id: 'seg', text: '第二版' }] },
    ]);
    const section = r.prompt.find((s) => s.id === 'seg');
    expect(section?.render({ projectPath: '' })).toBe('第二版');
    expect(r.diagnostics.overridden).toEqual(['seg']);
  });

  // ── insert 语义 ──

  it('insert after：落在锚段之后（锚 = 已插入段）', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          { insert: [{ id: 'base', text: '基段' }] },
          { insert: [{ id: 'team-convention', after: 'base', text: '## 团队约定' }] },
        ],
      },
    ]);
    const idx = r.prompt.findIndex((s) => s.id === 'team-convention');
    expect(idx).toBeGreaterThan(0);
    expect(r.prompt[idx - 1].id).toBe('base');
    expect(r.prompt[idx].render({ projectPath: '' })).toBe('## 团队约定');
    expect(r.diagnostics.inserted).toEqual(['base', 'team-convention']);
  });

  it('insert before：落在锚段之前', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          { insert: [{ id: 'base', text: '基段' }] },
          { insert: [{ id: 'preface', before: 'base', text: '前言' }] },
        ],
      },
    ]);
    const idx = r.prompt.findIndex((s) => s.id === 'preface');
    expect(r.prompt[idx + 1].id).toBe('base');
  });

  it('insert 缺省锚：追加表尾', () => {
    const r = resolveRoster(factoryComposition(), [{ prompt: [{ insert: [{ id: 'tail', text: '尾段' }] }] }]);
    expect(r.prompt[r.prompt.length - 1].id).toBe('tail');
  });

  it('insert 锚可指禁用行：落位该行原位（终步才过滤）', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          {
            insert: [
              { id: 'base', text: '基段' },
              { id: 'replacement', after: 'base', text: '替代段' },
            ],
          },
          { id: 'base', disabled: true },
        ],
      },
    ]);
    // base 被禁用移除；replacement 落在 base 原位
    //（工作列表里插在禁用行之后，终步过滤禁用行 → 原位露出）
    const idx = r.prompt.findIndex((s) => s.id === 'replacement');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(r.prompt.some((s) => s.id === 'base')).toBe(false);
    // replacement 落 base 原位 = 表尾，无后继段
    expect(idx).toBe(r.prompt.length - 1);
  });

  it('insert 同层链式：先插段可作后插段锚', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [
          {
            insert: [
              { id: 'seg-a', text: 'A' },
              { id: 'seg-b', after: 'seg-a', text: 'B' },
            ],
          },
        ],
      },
    ]);
    const a = r.prompt.findIndex((s) => s.id === 'seg-a');
    const b = r.prompt.findIndex((s) => s.id === 'seg-b');
    expect(a).toBe(0); // 出厂表空——缺省锚即首行
    expect(b).toBe(a + 1);
  });

  it('insert 段可被后续条目 disable / 覆盖（工作列表寻址含已插行）', () => {
    const r = resolveRoster(factoryComposition(), [
      {
        prompt: [{ insert: [{ id: 'temp', text: '临时段' }] }, { id: 'temp', disabled: true }],
      },
    ]);
    expect(r.prompt.some((s) => s.id === 'temp')).toBe(false);
    expect(r.diagnostics.inserted).toEqual(['temp']);
    expect(r.diagnostics.disabled).toEqual(['temp']);
  });

  // ── 拒绝（all-or-nothing）──

  it('拒绝：未知 id（四域）', () => {
    expect(() => resolveRoster(factoryComposition(), [{ tools: [{ id: 'builtin/nope', disabled: true }] }])).toThrow(
      CompositionPatchError,
    );
    expect(() => resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'nope', disabled: true }] }])).toThrow(
      CompositionPatchError,
    );
    expect(() =>
      resolveRoster(factoryComposition(), [{ shell: [{ id: 'hologram/shell-nope', disabled: true }] }]),
    ).toThrow(CompositionPatchError);
    expect(() => resolveRoster(factoryComposition(), [{ prompt: [{ id: 'nope', disabled: true }] }])).toThrow(
      CompositionPatchError,
    );
  });

  it('拒绝：insert 撞已有 id（已插段 / 通道贡献段——S4-4 甲统一撞名拒绝）', async () => {
    // 撞已插段（无通道也成立）
    expect(() =>
      resolveRoster(factoryComposition(), [
        {
          prompt: [{ insert: [{ id: 'dup', text: '第一' }] }, { insert: [{ id: 'dup', text: '第二' }] }],
        },
      ]),
    ).toThrow(CompositionPatchError);
    // 撞通道贡献段（通道内——第一方段进解析域后恢复拒绝）
    await withFirstPartyPromptChannel(async () => {
      expect(() =>
        resolveRoster(factoryComposition(), [
          { prompt: [{ insert: [{ id: 'multi-agent', text: '自定义多 Agent 段' }] }] },
        ]),
      ).toThrow(CompositionPatchError);
    });
  });

  it('拒绝：insert 锚点不存在', () => {
    expect(() =>
      resolveRoster(factoryComposition(), [
        { prompt: [{ insert: [{ id: 'orphan', after: 'no-such-anchor', text: 'X' }] }] },
      ]),
    ).toThrow(CompositionPatchError);
    expect(() =>
      resolveRoster(factoryComposition(), [
        { prompt: [{ insert: [{ id: 'orphan', before: 'no-such-anchor', text: 'X' }] }] },
      ]),
    ).toThrow(CompositionPatchError);
  });

  it('all-or-nothing：任一条失败 → 整体 throw，无部分应用产出', () => {
    // 纯函数 throw = 无输出（不存在「前几条已应用」的中间态可泄漏）；
    // 本条钉住该契约防回归（一旦改成收集错误继续跑，这里立刻红）。
    const layers = [
      { tools: [{ id: 'builtin/web', disabled: true }] },
      { tools: [{ id: 'builtin/nope', disabled: true }] },
    ];
    expect(() => resolveRoster(factoryComposition(), layers)).toThrow(CompositionPatchError);
    // 同输入去掉坏条目后正常应用（失败不污染调用方状态——每次调用全新工作列表）
    const ok = resolveRoster(factoryComposition(), [layers[0]]);
    expect(ids(ok.tools)).not.toContain('builtin/web');
  });

  // ── parseCompositionPatch（zod 校验层）──

  describe('parseCompositionPatch', () => {
    it('合法全形状（四域 + insert + 覆盖 + 禁用）', () => {
      const raw = {
        tools: [{ id: 'builtin/web', disabled: true }],
        prompt: [
          // B④ 收官：prompt 域寻址面 = 已插入段——条目按「先插后寻址」链式排列
          { insert: [{ id: 'user-seg', text: '用户段' }] },
          { id: 'user-seg', text: '新规则' },
          { insert: [{ id: 'extra', after: 'user-seg', text: '补充段' }] },
        ],
        capabilities: [{ id: 'auto-tune', disabled: false }],
        shell: [{ id: 'hologram/shell-keyguard', disabled: true }],
      };
      const r = parseCompositionPatch(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.tools).toEqual([{ id: 'builtin/web', disabled: true }]);
        expect(r.patch.capabilities).toEqual([{ id: 'auto-tune', disabled: false }]);
      }
    });

    it('空对象 = 合法（全域无增量）', () => {
      expect(parseCompositionPatch({}).ok).toBe(true);
    });

    it('拒绝：未知顶层键', () => {
      const r = parseCompositionPatch({ panels: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('panels');
    });

    it('拒绝：disable-only 域（tools）条目带 text', () => {
      const r = parseCompositionPatch({ tools: [{ id: 'x', disabled: true, text: '越域' }] });
      expect(r.ok).toBe(false);
    });

    it('拒绝：tools 条目缺 disabled（无操作条目）', () => {
      const r = parseCompositionPatch({ tools: [{ id: 'x' }] });
      expect(r.ok).toBe(false);
    });

    it('拒绝：prompt 条目 disabled 与 text 并存', () => {
      const r = parseCompositionPatch({ prompt: [{ id: 'x', disabled: true, text: 'y' }] });
      expect(r.ok).toBe(false);
    });

    it('拒绝：prompt 条目既无 disabled 又无 text', () => {
      const r = parseCompositionPatch({ prompt: [{ id: 'x' }] });
      expect(r.ok).toBe(false);
    });

    it('拒绝：insert 的 before 与 after 并存', () => {
      const r = parseCompositionPatch({
        prompt: [{ insert: [{ id: 'x', text: 't', before: 'a', after: 'b' }] }],
      });
      expect(r.ok).toBe(false);
    });

    it('拒绝：空 insert 数组（无操作）', () => {
      const r = parseCompositionPatch({ prompt: [{ insert: [] }] });
      expect(r.ok).toBe(false);
    });

    it('拒绝：非对象输入', () => {
      expect(parseCompositionPatch(null).ok).toBe(false);
      expect(parseCompositionPatch('tools: []').ok).toBe(false);
      expect(parseCompositionPatch(42).ok).toBe(false);
    });

    it('合法 patch 全链路：parse → resolve 生效', () => {
      const parsed = parseCompositionPatch({
        tools: [{ id: 'builtin/web', disabled: true }],
        prompt: [{ insert: [{ id: 'tail', text: '尾段' }] }],
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const r = resolveRoster(factoryComposition(), [parsed.patch]);
      expect(ids(r.tools)).not.toContain('builtin/web');
      expect(r.prompt[r.prompt.length - 1].id).toBe('tail');
    });
  });
});
