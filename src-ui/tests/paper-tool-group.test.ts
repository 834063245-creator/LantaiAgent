// Copyright (c) 2026 Wenbing Jing. MIT License.

// paper 工具组 + 折叠行信息专项（2026-08-30 会话流渲染走查第二弹）：
//   - 同轮连续工具调用合成 toolgroup 折叠头（用户报「edit、shell 并发好几个
//     全平铺」）——组头复用 fold 机制（默认收起、出错自动张开），壳层按折叠态
//     摘除子卡（collapseToolGroups），子卡独立块全机制复用；
//   - 折叠行此前只有字数（「▸ 参数 123 字」）没有信息量——改为「名字 + 参数
//     目标摘要」（toolDigest），用户不展开也知道卡是什么。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { defaultFolded, foldLabel, isFoldable } from '../src/paper/fold';
import { measureBlockHeight, measureSignature } from '../src/paper/measure';
import { hasArgsToShow, toolDigest } from '../src/paper/tool-text';
import { collapseToolGroups, translateMessages } from '../src/paper/translate';
import type { AssistantMessage, SubAgentPart, ToolCallPart } from '../src/ui/message-model';

function toolPart(name: string, args: string, status: ToolCallPart['status'] = 'done', output?: string): ToolCallPart {
  return {
    type: 'tool',
    toolId: `tc-${name}-${Math.random()}`,
    name,
    label: name,
    args,
    readOnly: false,
    status,
    output,
  };
}

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

/* ═══ 转译：连续工具调用成组 ═══ */

describe('translate：同轮并发工具调用 → 工具组', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('连续 ≥2 个工具块产出组头 + 子卡（组头 id 锚首子卡）', () => {
    const msg = asstMsg('a1', [
      toolPart('edit', '{"file_path":"a.ts"}'),
      toolPart('edit', '{"file_path":"b.ts"}'),
      toolPart('shell', '{"command":"ls"}'),
    ]);
    const blocks = translateMessages([msg]);
    expect(blocks.map((b) => b.kind)).toEqual(['toolgroup', 'tool', 'tool', 'tool']);
    const header = blocks[0];
    expect(header.id).toBe('pb:a1:0g');
    expect(header.w).toBe(640);
    const payload = header.payload as { childIds: string[]; items: ToolCallPart[] };
    expect(payload.childIds).toEqual(['pb:a1:0', 'pb:a1:1', 'pb:a1:2']);
    // 活引用：items 是原 part 对象
    expect(payload.items[2]).toBe(msg.parts[2]);
    expect(header.source.messageId).toBe('a1');
  });

  it('单个工具不成组；文本/程文打断连续运行；跨消息不成组', () => {
    const single = translateMessages([asstMsg('a1', [toolPart('edit', '{}')])]);
    expect(single.map((b) => b.kind)).toEqual(['tool']);
    const split = translateMessages([
      asstMsg('a2', [toolPart('edit', '{}'), { type: 'text', text: '中间', finalised: true }, toolPart('edit', '{}')]),
    ]);
    expect(split.map((b) => b.kind)).toEqual(['tool', 'markdown', 'tool']);
    const codeBreaks = translateMessages([
      asstMsg('a3', [
        toolPart('edit', '{}'),
        { type: 'tool', toolId: 'c', name: 'code_execution', label: '', args: '{}', readOnly: false, status: 'done' },
        toolPart('shell', '{}'),
      ]),
    ]);
    // 程文块不是 tool kind → 打断运行：前 1 个不成组、后 1 个不成组
    expect(codeBreaks.map((b) => b.kind)).toEqual(['tool', 'code', 'tool']);
    const cross = translateMessages([asstMsg('a4', [toolPart('edit', '{}')]), asstMsg('a5', [toolPart('edit', '{}')])]);
    expect(cross.map((b) => b.kind)).toEqual(['tool', 'tool']);
  });

  it('流式追加子卡：组头 id 稳定（锚首子卡），覆盖表不漂', () => {
    const msg1 = asstMsg('a1', [toolPart('edit', '{}'), toolPart('shell', '{}')]);
    const grow = asstMsg('a1', [...msg1.parts, toolPart('shell', '{}')]);
    const h1 = translateMessages([msg1])[0];
    const h2 = translateMessages([grow])[0];
    expect(h1.id).toBe('pb:a1:0g');
    expect(h2.id).toBe('pb:a1:0g');
    expect((h2.payload as { childIds: string[] }).childIds).toHaveLength(3);
  });
});

/* ═══ 折叠机制：组头默认收起、出错张开、摘要文案 ═══ */

describe('fold：工具组规则 + 折叠行关键信息', () => {
  it('isFoldable 含 toolgroup；默认收起，有子调用出错自动张开', () => {
    expect(isFoldable('toolgroup')).toBe(true);
    const ok = { childIds: ['x'], items: [toolPart('edit', '{}'), toolPart('shell', '{}')] };
    const errored = { childIds: ['x'], items: [toolPart('edit', '{}'), toolPart('shell', '{}', 'error', 'boom')] };
    expect(defaultFolded('toolgroup', ok)).toBe(true);
    expect(defaultFolded('toolgroup', errored)).toBe(false);
  });

  it('组头折叠行：×N + 名字去重分布（≤3 逐个列）+ 在跑数', () => {
    const items = [toolPart('edit', '{}'), toolPart('edit', '{}'), toolPart('shell', '{}')];
    expect(foldLabel('toolgroup', { childIds: [], items }, true)).toBe('▸ 工具 ×3 · edit ×2 · shell');
    const running = { childIds: [], items: [toolPart('edit', '{}', 'running'), toolPart('shell', '{}')] };
    expect(foldLabel('toolgroup', running, true)).toBe('▸ 工具 ×2 · edit · shell · 1 在跑');
    expect(foldLabel('toolgroup', { childIds: [], items }, false)).toBe('▾ 收起工具 ×3');
  });

  it('组头名字 >3 种：列前 3 + 等 N 种', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((n) => toolPart(n, '{}'));
    expect(foldLabel('toolgroup', { childIds: [], items }, true)).toBe('▸ 工具 ×5 · a · b · c · 等 5 种');
  });

  it('组头判别量（stream-rhythm 刀4a + 刀5 D 族签）：read_file ×3 露三个文件路径 + 族字', () => {
    const items = [
      toolPart('fs', '{"action":"read","path":"src/a.ts"}'),
      toolPart('fs', '{"action":"read","path":"src/b.ts"}'),
      toolPart('fs', '{"action":"read","path":"src/c.ts"}'),
    ];
    expect(foldLabel('toolgroup', { childIds: [], items }, true)).toBe('▸ 读 ×3 · fs src/a.ts / src/b.ts / src/c.ts');
  });

  it('组头判别量：截断 / 同值去重时计数补位（×N，总账不失真）', () => {
    // 5 个不同路径：露前 3 个判别值 + ×5
    const five = [1, 2, 3, 4, 5].map((k) => toolPart('fs', `{"action":"read","path":"f${k}.ts"}`));
    expect(foldLabel('toolgroup', { childIds: [], items: five }, true)).toBe('▸ 读 ×5 · fs ×5 f1.ts / f2.ts / f3.ts');
    // 两次同路径：判别值去重露一个 + ×2
    const dup = [toolPart('fs', '{"action":"read","path":"a.ts"}'), toolPart('fs', '{"action":"read","path":"a.ts"}')];
    expect(foldLabel('toolgroup', { childIds: [], items: dup }, true)).toBe('▸ 读 ×2 · fs ×2 a.ts');
  });

  it('组头判别量：混合族不缀族签（各露各的判别量 + 旧计数文案兜底）', () => {
    const items = [
      toolPart('fs', '{"action":"read","path":"a.ts"}'),
      toolPart('fs', '{"action":"read","path":"b.ts"}'),
      toolPart('shell', '{"action":"run","command":"cargo test"}'),
      toolPart('edit', '{"action":"write","path":"w.ts"}'),
      toolPart('notify', '{}'),
    ];
    expect(foldLabel('toolgroup', { childIds: [], items }, true)).toBe(
      '▸ 工具 ×5 · fs a.ts / b.ts · shell cargo test · edit w.ts · 等 4 种',
    );
  });

  it('组头判别量：流式半程 JSON（toolDigest 原串兜底）不炸，计数补位兜总账', () => {
    const half = [toolPart('fs', '{"action":"read","path":"a.ts"'), toolPart('fs', '{"action":"read"}')];
    // 半程 JSON 的判别值走原串兜底（与单工具折叠行同语义）；可解析无目标键 → 值兜底。
    // 族签：半程项不表态（null 跳过），已表态项（read）认领 → 读
    const label = foldLabel('toolgroup', { childIds: [], items: half }, true);
    expect(label.startsWith('▸ 读 ×2 · fs')).toBe(true);
    expect(label).toContain('read');
  });

  it('组头判别量：同族部分无判别值（无参）→ 计数补位不失总账', () => {
    const items = [toolPart('fs', '{"action":"read","path":"a.ts"}'), toolPart('fs', '{}')];
    // 一枚露路径、一枚无参：digests(1) < count(2) → ×2 补位
    expect(foldLabel('toolgroup', { childIds: [], items }, true)).toBe('▸ 读 ×2 · fs ×2 a.ts');
  });

  it('组头族签（刀5 D）：验证 / 落款族字（验 / 落），未知名不表态', () => {
    const verifyItems = [
      toolPart('shell', '{"action":"run","command":"cargo test"}'),
      toolPart('shell', '{"action":"run","command":"cargo build"}'),
    ];
    expect(foldLabel('toolgroup', { childIds: [], items: verifyItems }, true)).toBe(
      '▸ 验 ×2 · shell cargo test / cargo build',
    );
    const commitItems = [toolPart('git', '{"action":"commit","message":"x"}')];
    // 单项不成组（组头由 run ≥2 产生）——此处直接验 foldLabel 的族签面：
    expect(foldLabel('toolgroup', { childIds: [], items: [...commitItems, ...commitItems] }, true)).toContain('落');
  });

  it('工具卡折叠行带名字+参数摘要（旧「参数 N 字」退役）', () => {
    const p = { name: 'edit', label: 'edit', args: '{"file_path":"src/x.ts"}', status: 'done', output: 'ok' };
    expect(foldLabel('tool', p, true)).toBe('▸ edit src/x.ts · 输出 2 字');
    // 无参数待执行：名字 + 待执行
    expect(foldLabel('tool', { name: 'edit', label: 'edit', args: '', status: 'pending' }, true)).toBe(
      '▸ edit · 待执行',
    );
  });

  it('程文折叠行带 description', () => {
    const p = { description: '算个数', code: 'return 1', status: 'done', output: '1' };
    expect(foldLabel('code', p, true)).toBe('▸ 算个数 · 输出 1 字');
  });
});

describe('toolDigest：参数目标摘要', () => {
  it('优先命中目标键（file_path/command）', () => {
    expect(toolDigest('{"old_string":"x","file_path":"src/a.ts"}')).toBe('src/a.ts');
    expect(toolDigest('{"command":"cargo build --release"}')).toBe('cargo build --release');
  });

  it('无目标键取首个字符串值；非对象取原串', () => {
    expect(toolDigest('{"zzz":"fallback","aaa":"x"}')).toBe('fallback');
    expect(toolDigest('"raw string"')).toBe('raw string');
    expect(toolDigest('{"count":3}')).toBe('');
  });

  it('长摘要截断；流式未完按首行兜底', () => {
    const long = 'abcdefghij'.repeat(5); // 50 字符
    expect(toolDigest(`{"command":"${long}"}`)).toBe(`${long.slice(0, 40)}…`);
    expect(toolDigest('{"command": "git sta')).toBe('{"command": "git sta');
    expect(toolDigest('')).toBe('');
  });
});

/* ═══ 测量与壳层摘除 ═══ */

describe('measure/摘除：组头恒一行，收起摘子卡', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('toolgroup 测高 = 注线顶距 10 + 折叠行 20（与子卡数无关）', () => {
    const header = createBlock(
      'toolgroup',
      { childIds: ['a', 'b'], items: [toolPart('edit', '{}'), toolPart('shell', '{}')] },
      { messageId: 'm', part: null },
    );
    expect(measureBlockHeight(header)).toBe(10 + 20);
    expect(measureSignature(header, false)).toBe('toolgroup|2');
  });

  it('collapseToolGroups：折叠头摘除 flow 子卡，钉住子卡保留，展开不摘', () => {
    const child = () => createBlock('tool', toolPart('edit', '{}'), { messageId: 'm', part: null });
    const c1 = { ...child(), id: 'c1' };
    const c2 = { ...child(), id: 'c2' };
    const pinned = { ...child(), id: 'c3', state: 'pinned' as const, x: 5, y: 5 };
    const header = {
      ...createBlock('toolgroup', { childIds: ['c1', 'c2', 'c3'], items: [] }, { messageId: 'm', part: null }),
      id: 'h1',
    };
    const blocks = [header, c1, c2, pinned];
    const collapsed = collapseToolGroups(blocks, () => true);
    expect(collapsed.map((b) => b.id)).toEqual(['h1', 'c3']); // flow 子卡摘除、钉住保留
    expect(collapseToolGroups(blocks, () => false)).toEqual(blocks);
  });
});

/* ═══ F1（2026-09-01 三轴审计）：空/无意义参数不裸奔 ═══ */

describe('hasArgsToShow：空/无意义参数判据（渲染/测量/墨迹/折叠行四处同源）', () => {
  it('空串/纯空白/`{}`/`[]`/`null` = 无意义；其余（含原始串、非 JSON）= 有意义', () => {
    expect(hasArgsToShow('')).toBe(false);
    expect(hasArgsToShow('   \n ')).toBe(false);
    expect(hasArgsToShow(undefined)).toBe(false);
    expect(hasArgsToShow('{}')).toBe(false);
    expect(hasArgsToShow('{ }')).toBe(false);
    expect(hasArgsToShow('[]')).toBe(false);
    expect(hasArgsToShow('null')).toBe(false);
    expect(hasArgsToShow('{"a":1}')).toBe(true);
    expect(hasArgsToShow('{"a":""}')).toBe(true); // 空值字段保守保留（可能是流式半程）
    expect(hasArgsToShow('"raw string"')).toBe(true);
    expect(hasArgsToShow('{"command": "git sta')).toBe(true); // 流式未完
  });

  it('折叠行：`{}` 骨架与空参数同判——都是「待执行」', () => {
    expect(foldLabel('tool', { name: 'edit', label: 'edit', args: '{}', status: 'pending' }, true)).toBe(
      '▸ edit · 待执行',
    );
  });

  it('测量镜像：args 无意义时测高与空参数一致（渲染端不画 → 测高不占）', () => {
    resetBlockIdCounterForTests();
    const tool = (args: string) =>
      createBlock(
        'tool',
        { toolId: 't1', name: 'run_build', label: '构建验证', args, readOnly: false, status: 'error', err: 'TS2304' },
        { messageId: 'm', part: null },
      );
    const bare = measureBlockHeight(tool(''));
    expect(measureBlockHeight(tool('{}'))).toBe(bare); // 骨架不占高
    expect(measureBlockHeight(tool('{"cmd":"x"}'))).toBeGreaterThan(bare); // 真参数仍占高
  });
});

/* ═══ F4（2026-09-01 三轴审计）：子代理组内折叠 ═══ */

function subAgentPart(parts: SubAgentPart['parts'], overrides?: Partial<SubAgentPart>): SubAgentPart {
  return {
    type: 'subagent',
    agentId: 'sa1',
    description: '校对员：错别字扫描',
    status: 'done',
    version: 1,
    parts,
    ...overrides,
  };
}

describe('translate：subagent → 组头 + 子块（不摊平、不嵌套成组）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('组内连续 tool 子块不再被二次成组（不建嵌套组）', () => {
    const msg = asstMsg('a1', [
      subAgentPart([toolPart('edit', '{"file_path":"a.ts"}'), toolPart('shell', '{"command":"ls"}')]),
    ]);
    const blocks = translateMessages([msg]);
    expect(blocks.map((b) => b.kind)).toEqual(['subagent', 'tool', 'tool']);
    expect(blocks[0].id).toBe('pb:a1:0g');
  });

  it('组头不打断父层工具组的连续运行（组间边界照常）', () => {
    const msg = asstMsg('a1', [
      toolPart('edit', '{}'),
      toolPart('shell', '{}'),
      subAgentPart([{ type: 'text', text: '子产出', finalised: true }]),
    ]);
    const blocks = translateMessages([msg]);
    expect(blocks.map((b) => b.kind)).toEqual(['toolgroup', 'tool', 'tool', 'subagent', 'markdown']);
  });
});

describe('fold：subagent 组规则 + 折叠行文案', () => {
  it('isFoldable 含 subagent；完成/在跑收起，组自身或子调用出错张开，子拟策待审批张开', () => {
    expect(isFoldable('subagent')).toBe(true);
    const done = subAgentPart([{ type: 'text', text: 'x', finalised: true }]);
    expect(
      defaultFolded('subagent', { agentId: 'a', description: 'd', status: 'done', childIds: [], items: done.parts }),
    ).toBe(true);
    const running = {
      agentId: 'a',
      description: 'd',
      status: 'running',
      childIds: [],
      items: [toolPart('edit', '{}', 'running')],
    };
    expect(defaultFolded('subagent', running)).toBe(true);
    const selfError = { agentId: 'a', description: 'd', status: 'error', childIds: [], items: [] };
    expect(defaultFolded('subagent', selfError)).toBe(false);
    const childError = {
      agentId: 'a',
      description: 'd',
      status: 'done',
      childIds: [],
      items: [toolPart('edit', '{}', 'error', 'boom')],
    };
    expect(defaultFolded('subagent', childError)).toBe(false);
    const planPending = {
      agentId: 'a',
      description: 'd',
      status: 'done',
      childIds: [],
      items: [{ type: 'plan', planId: 'p1', planFilePath: '', content: '', status: 'pending', _callback: () => {} }],
    };
    expect(defaultFolded('subagent', planPending)).toBe(false);
  });

  it('折叠行：描述即身份 + 段数量化 + 在跑/出错缀', () => {
    const items = [{ type: 'text', text: 'x', finalised: true }] as SubAgentPart['parts'];
    const payload = (status: SubAgentPart['status']) => ({
      agentId: 'a',
      description: '校对员：错别字扫描',
      status,
      childIds: ['c1'],
      items,
    });
    expect(foldLabel('subagent', payload('done'), true)).toBe('▸ 校对员：错别字扫描 · 1 段');
    expect(foldLabel('subagent', payload('running'), true)).toBe('▸ 校对员：错别字扫描 · 1 段 · 在跑');
    expect(foldLabel('subagent', payload('error'), true)).toBe('▸ 校对员：错别字扫描 · 1 段 · 出错');
    expect(foldLabel('subagent', payload('done'), false)).toBe('▾ 收起 校对员：错别字扫描');
  });

  it('长描述截断 24 字；空描述回落「子代理」', () => {
    const payload = (description: string) => ({ agentId: 'a', description, status: 'done', childIds: [], items: [] });
    const long = '这是一段特别长的子代理描述文字超过二十四个字的边界测试用例';
    expect(foldLabel('subagent', payload(long), true)).toBe(`▸ ${long.slice(0, 24)}… · 0 段`);
    expect(foldLabel('subagent', payload(''), true)).toBe('▸ 子代理 · 0 段');
  });
});

describe('measure/摘除：subagent 组头恒一行，收起摘子块', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('组头测高与工具组头同构（注线顶距 10 + 折叠行 20），签名含描述/状态/段数', () => {
    const header = createBlock(
      'subagent',
      {
        agentId: 'sa1',
        description: '调研',
        status: 'done',
        childIds: ['c1'],
        items: [{ type: 'text', text: 'x', finalised: true }],
      },
      { messageId: 'm', part: null },
    );
    expect(measureBlockHeight(header)).toBe(10 + 20);
    expect(measureSignature(header, false)).toBe('subagent|调研|done|1');
  });

  it('collapseToolGroups：subagent 组折叠摘 flow 子块，钉住子块保留', () => {
    const child = () => createBlock('markdown', { text: '子产出' }, { messageId: 'm', part: null });
    const c1 = { ...child(), id: 'c1' };
    const pinned = { ...child(), id: 'c2', state: 'pinned' as const, x: 5, y: 5 };
    const header = {
      ...createBlock(
        'subagent',
        { agentId: 'a', description: 'd', status: 'done', childIds: ['c1', 'c2'], items: [] },
        { messageId: 'm', part: null },
      ),
      id: 'h1',
    };
    const blocks = [header, c1, pinned];
    expect(collapseToolGroups(blocks, () => true).map((b) => b.id)).toEqual(['h1', 'c2']);
    expect(collapseToolGroups(blocks, () => false)).toEqual(blocks);
  });
});
