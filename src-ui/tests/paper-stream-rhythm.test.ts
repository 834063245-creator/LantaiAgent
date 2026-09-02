// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper 版式语法专项（stream-rhythm 刀1：docs/plans/stream-rhythm-plan.md）：
//   - grammar：工具调用 → 版式族推导（领域名经 resolveSemanticToolName 反查旧名，
//     run_shell 按 command 内容判验证族；未知名兜底不破语法）；
//   - group：块序列 → 工作单元（封口纪律 + 跨消息前瞻禁止两条宪法的执行面）；
//   - 封口不变性专项：任意前缀下，全部成员来自封口消息的单元逐字段不变。

import { beforeEach, describe, expect, it } from 'vitest';
import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { ANCHOR, gapAbove, layoutFlow, rhythmGap } from '../src/paper/canvas-math';
import { classifyTool } from '../src/paper/grammar';
import type { WorkUnit } from '../src/paper/group';
import { groupWorkUnits, isErrorishBlock, leadOf, sealedMessageIdsOf, unitMembership } from '../src/paper/group';
import { translateMessages } from '../src/paper/translate';
import type { AssistantMessage, ChatMessage, ToolCallPart, UserMessage } from '../src/ui/message-model';

function toolPart(name: string, args: string, status: ToolCallPart['status'] = 'done'): ToolCallPart {
  return { type: 'tool', toolId: `tc-${name}-${Math.random()}`, name, label: name, args, readOnly: false, status };
}

function asstMsg(
  id: string,
  parts: AssistantMessage['parts'],
  status: 'done' | 'streaming' = 'done',
): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status, respondingTo: 'u1' };
}

function userMsg(id: string, text = '下一步？'): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}

/** 消息序列 → 工作单元（生产同款：translate → group + 封口集）。 */
function groupOf(msgs: ChatMessage[]): WorkUnit[] {
  const sealed = sealedMessageIdsOf(msgs);
  return groupWorkUnits(translateMessages(msgs), { isSealedMessage: (id) => sealed.has(id) });
}

/** 单元形状摘要（失败信息可读）：kind | 成员数 | 首成员 id。 */
function shapes(units: readonly WorkUnit[]): string[] {
  return units.map((u) => `${u.kind}#${u.memberIds.length}@${u.id}`);
}

/* ═══ grammar：工具族推导 ═══ */

describe('grammar：classifyTool 族推导', () => {
  it('领域名 + action 反查旧名入表：读 / 写 / 落款', () => {
    expect(classifyTool('fs', '{"action":"read","path":"a.ts"}')).toBe('read');
    expect(classifyTool('fs', '{"action":"write","path":"a.ts"}')).toBe('write');
    expect(classifyTool('fs', '{"action":"edit","path":"a.ts"}')).toBe('write');
    expect(classifyTool('git', '{"action":"status"}')).toBe('read');
    expect(classifyTool('git', '{"action":"stage"}')).toBe('write');
    expect(classifyTool('git', '{"action":"commit","message":"x"}')).toBe('commit');
    expect(classifyTool('search', '{"action":"content","pattern":"x"}')).toBe('read');
    expect(classifyTool('graph', '{"action":"impact"}')).toBe('read');
  });

  it('旧名直呼同样入表（历史卷 / 测试路径不经领域收敛）', () => {
    expect(classifyTool('read_file_content', '{"filePath":"x"}')).toBe('read');
    expect(classifyTool('edit_file', '{"filePath":"x"}')).toBe('write');
    expect(classifyTool('git_commit', '{}')).toBe('commit');
  });

  it('run_shell 按 command 内容判验证族；其余 other', () => {
    expect(classifyTool('shell', '{"action":"run","command":"cargo test"}')).toBe('verify');
    expect(classifyTool('shell', '{"action":"run","command":"npm run build"}')).toBe('verify');
    expect(classifyTool('shell', '{"action":"run","command":"npx vitest run"}')).toBe('verify');
    expect(classifyTool('shell', '{"action":"run","command":"python -m pytest -x"}')).toBe('verify');
    expect(classifyTool('shell', '{"action":"run","command":"npm run dev"}')).toBe('other');
    expect(classifyTool('shell', '{"action":"run","command":"ls -la"}')).toBe('other');
    expect(classifyTool('run_shell', '{"command":"make"}')).toBe('verify');
  });

  it('未知名兜底铁律：readOnly 证据 → read，否则 other（不破语法）', () => {
    expect(classifyTool('mcp__remote__foo', '{}')).toBe('other');
    expect(classifyTool('mcp__remote__foo', '{}', true)).toBe('read');
    expect(classifyTool('browser_click', '{}')).toBe('other');
    expect(classifyTool('agent_spawn', '{}')).toBe('other');
  });

  it('流式半程 JSON 解析失败 → 不炸（other 兜底）', () => {
    expect(classifyTool('shell', '{"command": "cargo te')).toBe('other');
    expect(classifyTool('fs', '{"action": "re')).toBe('other');
  });
});

/* ═══ group：工作单元成型 ═══ */

describe('group：单元成型（版式语法表执行面）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('来文自成阶段；夹注挂靠进同消息工作单元；正文收尾成叙述', () => {
    const units = groupOf([
      userMsg('u1'),
      asstMsg('a1', [
        { type: 'reasoning', text: '想想' },
        toolPart('fs', '{"action":"read"}'),
        toolPart('search', '{}'),
        { type: 'text', text: '结论', finalised: true },
      ]),
    ]);
    // user | work(夹注+组头+2子卡) | narrative
    expect(shapes(units)).toEqual(['user#1@u:pb:u1', 'work#4@u:pb:a1:0', 'narrative#1@u:pb:a1:3']);
    expect(units[1].memberIds).toEqual(['pb:a1:0', 'pb:a1:1g', 'pb:a1:1', 'pb:a1:2']);
  });

  it('文本 + 围栏拆出的 markdown/diff 连续段并入同一叙述单元', () => {
    const units = groupOf([
      asstMsg('a1', [
        {
          type: 'text',
          text: '前文\n```diff\n+a\n```\n后文',
          finalised: true,
        },
      ]),
    ]);
    expect(shapes(units)).toEqual(['narrative#3@u:pb:a1:0t0']);
  });

  it('error 起恢复单元（转折）；error 前的工作单元保持不变', () => {
    const units = groupOf([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read"}'),
        { type: 'text', text: '中间叙述', finalised: true },
        toolPart('shell', '{"action":"run","command":"make"}', 'error'),
        toolPart('shell', '{"action":"run","command":"make"}'),
      ]),
    ]);
    expect(shapes(units)).toEqual(['work#1@u:pb:a1:0', 'narrative#1@u:pb:a1:1', 'recovery#3@u:pb:a1:2g']);
    expect(units[2].memberIds).toEqual(['pb:a1:2g', 'pb:a1:2', 'pb:a1:3']);
  });

  it('组内出错（toolgroup 错误子项）整组落恢复单元', () => {
    const units = groupOf([
      asstMsg('a1', [toolPart('fs', '{"action":"read"}'), toolPart('shell', '{"command":"x"}', 'error')]),
    ]);
    expect(shapes(units)).toEqual(['recovery#3@u:pb:a1:0g']);
  });

  it('回合墓碑自成终止单元（贴黄拆迁的组面）', () => {
    const units = groupOf([
      userMsg('u1'),
      { ...asstMsg('a1', [{ type: 'text', text: '半截', finalised: true }]), status: 'error', errorMessage: '断流' },
    ]);
    expect(shapes(units)).toEqual(['user#1@u:pb:u1', 'narrative#1@u:pb:a1:0', 'terminal#1@u:pb:a1:err']);
    expect(leadOf(units[2])).toBe('recovery');
  });

  it('拟策卡 / 通知各自成锚点 / 注疏单元', () => {
    const units = groupOf([
      { role: 'notice', _id: 'n1', text: '压缩', level: 'info' },
      asstMsg('a1', [
        {
          type: 'plan',
          planId: 'p1',
          planFilePath: '',
          content: '- a',
          status: 'pending',
          _callback: () => {},
        },
      ]),
    ]);
    // notice 块走 translate 计数器 id（既有行为，非 1:1 锚）——只断单元语义；
    // plan 块 id 锚 part 序号，精确断。
    expect(units[0]?.kind).toBe('annotation');
    expect(units[0]?.memberIds).toHaveLength(1);
    expect(shapes(units).slice(1)).toEqual(['anchor#1@u:pb:a1:0']);
  });

  it('子代理组：组头 + 子块一个单元（子块 markdown/plan 不拆散父单元）', () => {
    const units = groupOf([
      asstMsg('a1', [
        {
          type: 'subagent',
          agentId: 'sa1',
          description: '校对员',
          status: 'done',
          version: 1,
          parts: [
            { type: 'reasoning', text: '子思考' },
            { type: 'text', text: '子产出', finalised: true },
            toolPart('fs', '{"action":"read"}'),
          ],
        },
      ]),
    ]);
    // 组头 + 3 子块（reasoning/markdown/tool）全部归一个工作单元
    expect(shapes(units)).toEqual(['work#4@u:pb:a1:0g']);
  });

  it('未知 / 资产 kind 落产物单元（连续同类合并，开放面不猜语义）', () => {
    const a1 = { ...createBlock('html-asset', { html: '<b>x</b>' }, { messageId: 'm1', part: null }), id: 'as1' };
    const a2 = { ...createBlock('chart-asset', { rows: 3 }, { messageId: 'm1', part: null }), id: 'as2' };
    const md = { ...createBlock('markdown', { text: '中段' }, { messageId: 'm1', part: null }), id: 'md1' };
    const a3 = { ...createBlock('html-asset', { html: '<i>y</i>' }, { messageId: 'm1', part: null }), id: 'as3' };
    const units = groupWorkUnits([a1, a2, md, a3]);
    expect(shapes(units)).toEqual(['artifact#2@u:as1', 'narrative#1@u:md1', 'artifact#1@u:as3']);
  });

  /* 散块路径（translate 的 groupToolRuns 只并连续 tool；tool→code→tool 与
   * 单 tool 序列在块面上是散块——单元合并必须由本层兜住，tsc 曾抓到此路径
   * 的首版回归（push 即清 kind → 永不成组）。 */
  it('散块工作家族续收：tool→code→tool 合一个工作单元（tsc 抓过的回归面）', () => {
    const t1 = {
      ...createBlock(
        'tool',
        { toolId: 't1', name: 'fs', label: '', args: '', status: 'done', readOnly: false },
        { messageId: 'm1', part: null },
      ),
      id: 'w1',
    };
    const c1 = {
      ...createBlock(
        'code',
        { toolId: 'c1', description: '算', code: 'return 1', status: 'done' },
        { messageId: 'm1', part: null },
      ),
      id: 'w2',
    };
    const t2 = {
      ...createBlock(
        'tool',
        { toolId: 't2', name: 'search', label: '', args: '', status: 'done', readOnly: false },
        { messageId: 'm1', part: null },
      ),
      id: 'w3',
    };
    const units = groupWorkUnits([t1, c1, t2]);
    expect(shapes(units)).toEqual(['work#3@u:w1']);
  });

  it('散块 error 转折：error 块起恢复单元，后继并入（非 toolgroup 路径）', () => {
    const t1 = {
      ...createBlock(
        'tool',
        { toolId: 't1', name: 'fs', label: '', args: '', status: 'done', readOnly: false },
        { messageId: 'm1', part: null },
      ),
      id: 'w1',
    };
    const t2 = {
      ...createBlock(
        'tool',
        { toolId: 't2', name: 'fs', label: '', args: '', status: 'error', readOnly: false },
        { messageId: 'm1', part: null },
      ),
      id: 'w2',
    };
    const t3 = {
      ...createBlock(
        'tool',
        { toolId: 't3', name: 'fs', label: '', args: '', status: 'done', readOnly: false },
        { messageId: 'm1', part: null },
      ),
      id: 'w3',
    };
    const units = groupWorkUnits([t1, t2, t3]);
    expect(shapes(units)).toEqual(['work#1@u:w1', 'recovery#2@u:w2']);
  });

  it('夹注中途入单元：叙述/工作单元开放期内夹注直接并入（顺序恒正）', () => {
    const md1 = { ...createBlock('markdown', { text: '前' }, { messageId: 'm1', part: null }), id: 'md1' };
    const r = { ...createBlock('reasoning', { text: '想' }, { messageId: 'm1', part: null }), id: 'r1' };
    const md2 = { ...createBlock('markdown', { text: '后' }, { messageId: 'm1', part: null }), id: 'md2' };
    const units = groupWorkUnits([md1, r, md2]);
    expect(shapes(units)).toEqual(['narrative#3@u:md1']);
  });
});

/* ═══ group：封口不变性（宪法 1）与跨消息前瞻禁止（宪法 2）═══ */

describe('group：封口不变性专项', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('活尾演化（夹注→工作→错误恢复）：封口前缀单元逐字段不变', () => {
    const head: ChatMessage[] = [
      userMsg('u1'),
      asstMsg('a1', [
        { type: 'reasoning', text: '先想' },
        toolPart('fs', '{"action":"read"}'),
        toolPart('search', '{}'),
        { type: 'text', text: '第一轮结论', finalised: true },
      ]),
      userMsg('u2'),
    ];
    const p1 = groupOf([...head, asstMsg('a2', [{ type: 'reasoning', text: '再想' }], 'streaming')]);
    const p2 = groupOf([
      ...head,
      asstMsg('a2', [{ type: 'reasoning', text: '再想' }, toolPart('fs', '{"action":"read"}')], 'streaming'),
    ]);
    const p3 = groupOf([
      ...head,
      asstMsg(
        'a2',
        [
          { type: 'reasoning', text: '再想' },
          toolPart('fs', '{"action":"read"}'),
          toolPart('shell', '{"action":"run","command":"make"}', 'error'),
          { type: 'text', text: '恢复后', finalised: true },
        ],
        'streaming',
      ),
    ]);
    // 封口前缀（u1/a1/u2 的单元）在三档前缀下逐字段一致
    const sealedSlice = (us: WorkUnit[]) => us.filter((u) => u.sealed);
    expect(sealedSlice(p1)).toEqual(sealedSlice(p2));
    expect(sealedSlice(p2)).toEqual(sealedSlice(p3));
    // 活尾允许演化：夹注自叙述 → 工作单元（id 锚夹注稳定）→ 错误后成恢复单元
    expect(shapes(p1).slice(-1)).toEqual(['narrative#1@u:pb:a2:0']);
    expect(shapes(p2).slice(-1)).toEqual(['work#2@u:pb:a2:0']);
    expect(shapes(p3).slice(-2)).toEqual(['recovery#4@u:pb:a2:0', 'narrative#1@u:pb:a2:3']);
    // a2 单元未封口
    for (const u of p3) if (!u.sealed) expect(u.memberIds.some((m) => m.startsWith('pb:a2'))).toBe(true);
  });

  it('跨消息前瞻禁止：封口消息尾部的夹注绝不重挂进下一消息的工作单元', () => {
    const head: ChatMessage[] = [
      userMsg('u1'),
      // a1 以夹注收尾（全围栏正文后的回退夹注）：并入 a1 的叙述单元
      asstMsg('a1', [
        { type: 'reasoning', text: '收尾思考' },
        { type: 'text', text: '```diff\n+a\n```', finalised: true },
      ]),
    ];
    const before = groupOf(head);
    const after = groupOf([...head, userMsg('u2'), asstMsg('a2', [toolPart('fs', '{"action":"read"}')])]);
    // a1 的叙述单元（含夹注）在后续消息到达后逐字段不变
    const a1unit = (us: WorkUnit[]) => us.find((u) => u.memberIds.some((m) => m.startsWith('pb:a1:')))!;
    expect(a1unit(after)).toEqual(a1unit(before));
    // 夹注没有漂进 a2 的工作单元
    const a2work = after.find((u) => u.kind === 'work')!;
    expect(a2work.memberIds.every((m) => !m.startsWith('pb:a1:'))).toBe(true);
  });

  it('封口标志：done 消息的单元 sealed，streaming 消息的单元未封', () => {
    const units = groupOf([
      userMsg('u1'),
      asstMsg('a1', [toolPart('fs', '{"action":"read"}')]),
      asstMsg('a2', [toolPart('fs', '{"action":"read"}')], 'streaming'),
    ]);
    expect(units.map((u) => u.sealed)).toEqual([true, true, false]);
  });
});

/* ═══ 消费面助手 ═══ */

describe('group：消费面（leadOf / unitMembership / isErrorishBlock）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('间距档映射：user→stage，recovery/terminal→recovery，其余→unit', () => {
    const mk = (kind: WorkUnit['kind']): WorkUnit => ({ id: 'u:x', kind, memberIds: ['x'], sealed: true });
    expect(leadOf(mk('user'))).toBe('stage');
    expect(leadOf(mk('recovery'))).toBe('recovery');
    expect(leadOf(mk('terminal'))).toBe('recovery');
    expect(leadOf(mk('work'))).toBe('unit');
    expect(leadOf(mk('narrative'))).toBe('unit');
    expect(leadOf(mk('anchor'))).toBe('unit');
    expect(leadOf(mk('annotation'))).toBe('unit');
    expect(leadOf(mk('artifact'))).toBe('unit');
  });

  it('unitMembership：成员查所属单元，首成员标记正确', () => {
    const units = groupOf([
      userMsg('u1'),
      asstMsg('a1', [toolPart('fs', '{"action":"read"}'), toolPart('search', '{}')]),
    ]);
    const m = unitMembership(units);
    const userBlock = units[0].memberIds[0];
    const work = units[1];
    expect(m.get(userBlock)?.isFirst).toBe(true);
    expect(m.get(work.memberIds[0])?.unit).toBe(work);
    expect(m.get(work.memberIds[1])?.isFirst).toBe(false);
    expect(m.get(work.memberIds[2])?.unit).toBe(work);
  });

  it('isErrorishBlock：tool/code 看自身 status，组头看子项，非工具恒否', () => {
    const mk = (kind: 'tool' | 'markdown' | 'reasoning' | 'toolgroup', payload: object) =>
      createBlock(kind, payload as never, { messageId: 'm', part: null });
    expect(
      isErrorishBlock(
        mk('tool', { toolId: 't', name: 'shell', label: '', args: '', status: 'error', readOnly: false }),
      ),
    ).toBe(true);
    expect(
      isErrorishBlock(mk('tool', { toolId: 't', name: 'shell', label: '', args: '', status: 'done', readOnly: false })),
    ).toBe(false);
    expect(isErrorishBlock(mk('markdown', { text: 'x' }))).toBe(false);
    expect(isErrorishBlock(mk('reasoning', { text: '想' }))).toBe(false);
    expect(
      isErrorishBlock(
        mk('toolgroup', { childIds: [], items: [toolPart('shell', '{}'), toolPart('shell', '{}', 'error')] }),
      ),
    ).toBe(true);
    expect(isErrorishBlock(mk('toolgroup', { childIds: [], items: [toolPart('shell', '{}')] }))).toBe(false);
  });
});

/* ═══ 布局消费：节奏档 → 间距（canvas-math）═══ */

describe('canvas-math：节奏档间距（刀2 布局面）', () => {
  it('rhythmGap 表驱动：intra 32 < 块距 48 < unit 64 < recovery/stage 96（D1 试值）', () => {
    expect(rhythmGap('intra')).toBe(32);
    expect(rhythmGap('unit')).toBe(64);
    expect(rhythmGap('recovery')).toBe(96);
    expect(rhythmGap('stage')).toBe(96);
    expect(ANCHOR.intraUnitGap).toBeLessThan(ANCHOR.blockGap);
    expect(ANCHOR.blockGap).toBeLessThan(ANCHOR.unitGap);
    expect(ANCHOR.unitGap).toBeLessThan(ANCHOR.stageGap);
  });

  it('gapAbove：节奏档优先于 B1 基线；上方是来文恒尾距（B1 反转让位）', () => {
    expect(gapAbove({ rhythm: 'intra' }, { kind: 'markdown' })).toBe(32);
    expect(gapAbove({ rhythm: 'unit' }, { kind: 'markdown' })).toBe(64);
    expect(gapAbove({ rhythm: 'recovery' }, { kind: 'markdown' })).toBe(96);
    expect(gapAbove({ rhythm: 'stage' }, { kind: 'markdown' })).toBe(96);
    // B1 反转优先：上方是 user → 尾距 8（asterism 让位），节奏档不覆盖
    expect(gapAbove({ rhythm: 'unit' }, { kind: 'user' })).toBe(ANCHOR.userTailGap);
    expect(gapAbove({ rhythm: 'stage' }, { kind: 'user' })).toBe(ANCHOR.userTailGap);
    // 无 rhythm 的外部调用面走 B1 基线（回归保障）
    expect(gapAbove({ kind: 'markdown' }, { kind: 'markdown' })).toBe(ANCHOR.blockGap);
    expect(gapAbove({ kind: 'user' }, { kind: 'markdown' })).toBe(ANCHOR.blockGap + ANCHOR.userLeadGap);
  });

  it('layoutFlow 节奏栈：单元内紧 / 单元间松 / 阶段换气 + B1 反转叠加（自底向上对拍）', () => {
    // 栈序（旧→新）：a(md) → u(user, stage) → r(夹注, unit) → tg(组头, intra) → b(md, unit)
    // 间距归属：gapAbove(b, 上方块) 决定 b 头顶的间距（自底向上游标累积）。
    const stack = [
      { id: 'a', h: 100, kind: 'markdown' },
      { id: 'u', h: 50, kind: 'user', rhythm: 'stage' as const },
      { id: 'r', h: 40, kind: 'reasoning', rhythm: 'unit' as const },
      { id: 'tg', h: 30, kind: 'toolgroup', rhythm: 'intra' as const },
      { id: 'b', h: 100, kind: 'markdown', rhythm: 'unit' as const },
    ];
    const lay = layoutFlow(stack);
    // b 底贴锚 y=0 → b 顶 -100；b(unit) 头顶 unit 64
    expect(lay.get('b')?.y).toBe(-100);
    // tg 顶 = -100 - 64(unit) - 30；tg(intra) 头顶 intra 32
    expect(lay.get('tg')?.y).toBe(-100 - 64 - 30);
    // r 顶 = -194 - 32(intra) - 40；r 的上方是 user u —— B1 反转优先：
    // asterism 让位（userTailGap 8），r 的 unit 档不覆盖
    expect(lay.get('r')?.y).toBe(-100 - 64 - 30 - 32 - 40);
    // u 顶 = -266 - 8(尾距) - 50；u(stage) 头顶 stage 96
    expect(lay.get('u')?.y).toBe(-100 - 64 - 30 - 32 - 40 - 8 - 50);
    // a 顶 = -324 - 96(stage) - 100
    expect(lay.get('a')?.y).toBe(-100 - 64 - 30 - 32 - 40 - 8 - 50 - 96 - 100);
  });
});
