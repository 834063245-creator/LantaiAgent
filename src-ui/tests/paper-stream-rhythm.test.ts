// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper 版式语法专项（stream-rhythm 刀1+刀3：docs/plans/stream-rhythm-plan.md）：
//   - grammar：工具调用 → 版式族推导（领域名经 resolveSemanticToolName 反查旧名，
//     run_shell 按 command 内容判验证族；未知名兜底不破语法）；
//   - group：块序列 → 工作单元（封口纪律 + 跨消息前瞻禁止两条宪法的执行面）；
//   - 封口不变性专项：任意前缀下，全部成员来自封口消息的单元逐字段不变；
//   - 活尾重排限定（刀3 布局级）：封口前缀 = 刚体——追加事件只许整体平移，
//     节奏档/间距/相对位置逐字段不变（滚动锚定的数学面）；
//   - 组原子性（刀3 长会话）：折叠组 = 布局栈单条目，展开组成员连续——
//     虚拟化窗口对组只能整取整舍/切在边缘，永不交错；
//   - 长流性能烟测（刀3 旧卷回放）：单卷千块级全链预算。

import { beforeEach, describe, expect, it } from 'vitest';
import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { ANCHOR, gapAbove, layoutFlow, type RhythmClass, rhythmGap } from '../src/paper/canvas-math';
import { defaultFolded } from '../src/paper/fold';
import { classifyTool } from '../src/paper/grammar';
import type { WorkUnit } from '../src/paper/group';
import {
  groupWorkUnits,
  isErrorishBlock,
  leadOf,
  rhythmAssign,
  sealedMessageIdsOf,
  unitMembership,
} from '../src/paper/group';
import { collapseToolGroups, translateMessages } from '../src/paper/translate';
import { visibleFlowWindow } from '../src/paper/virtualize';
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
    // graph 域随图谱全量退役：领域名/动作不再入表，落 unknown 兜底（other）
    expect(classifyTool('graph', '{"action":"impact"}')).toBe('other');
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
    // 活尾允许演化：夹注自叙述 → 工作单元（id 锚夹注稳定）→ 错误后成恢复单元。
    // 刀5 B 后读工具与出错 shell 按族切分不再并成一个错误组——读包保持 work，
    // 错误 shell 独立成恢复单元（转折自宣告）
    expect(shapes(p1).slice(-1)).toEqual(['narrative#1@u:pb:a2:0']);
    expect(shapes(p2).slice(-1)).toEqual(['work#2@u:pb:a2:0']);
    expect(shapes(p3).slice(-3)).toEqual(['work#2@u:pb:a2:0', 'recovery#1@u:pb:a2:2', 'narrative#1@u:pb:a2:3']);
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

/* ═══ 活尾重排限定（刀3 布局级）：封口前缀 = 刚体 ═══ */

/** 合成块高（确定性哈希——判别量在分组/节奏层；真实测高由 measure 签名保证
 *  封口内容不变，此处只需「同一 id 恒同高」）。 */
function synthH(id: string): number {
  let n = 7;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) % 97;
  return 24 + (n % 60);
}

/** 生产同款布局栈（纯函数链，与 PaperPanel regions memo 同源——折叠摘除 +
 *  rhythmAssign 分派 + layoutFlow）：布局级封口测试的对象。 */
function layoutOf(msgs: ChatMessage[]): {
  blocks: ReturnType<typeof collapseToolGroups>;
  translated: ReturnType<typeof translateMessages>;
  units: WorkUnit[];
  rhythmOf: Map<string, RhythmClass>;
  stageLeadIds: ReadonlySet<string>;
  unitLeadIds: ReadonlySet<string>;
  verifyDoneIds: ReadonlySet<string>;
  layout: Map<string, { x: number; y: number }>;
} {
  const translated = translateMessages(msgs);
  const sealed = sealedMessageIdsOf(msgs);
  const units = groupWorkUnits(translated, { isSealedMessage: (id) => sealed.has(id) });
  const blocks = collapseToolGroups(translated, (b) => defaultFolded(b.kind, b.payload));
  const { rhythmOf, stageLeadIds, unitLeadIds, verifyDoneIds } = rhythmAssign(blocks, units);
  const stack = blocks.map((b) => ({ id: b.id, h: synthH(b.id), w: b.w, kind: b.kind, rhythm: rhythmOf.get(b.id) }));
  return {
    blocks,
    translated,
    units,
    rhythmOf,
    stageLeadIds,
    unitLeadIds,
    verifyDoneIds,
    layout: layoutFlow(stack),
  };
}

/** 封口前缀指纹：栈序封口块的 {id, 节奏档, 相对锚块 y}——刚体不变性的比较面。 */
function sealedFingerprint(l: ReturnType<typeof layoutOf>): Array<{ id: string; rhythm: RhythmClass; relY: number }> {
  const sealedIds = new Set<string>();
  for (const u of l.units) if (u.sealed) for (const m of u.memberIds) sealedIds.add(m);
  const anchorId = l.blocks[0]!.id; // 栈首（最旧块）——所有前缀下的同一稳定锚
  const anchorY = l.layout.get(anchorId)!.y;
  return l.blocks
    .filter((b) => sealedIds.has(b.id))
    .map((b) => {
      const rhythm = l.rhythmOf.get(b.id);
      if (!rhythm) throw new Error(`栈块 ${b.id} 无节奏档`);
      return { id: b.id, rhythm, relY: Math.round((l.layout.get(b.id)!.y - anchorY) * 1000) / 1000 };
    });
}

describe('活尾重排限定（刀3 布局级）：封口前缀 = 刚体', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('活尾演化全谱（夹注→工具→成组→组内错误→重试→收尾→新来文）：封口前缀的节奏档与相对位置逐字段不变', () => {
    const head: ChatMessage[] = [
      userMsg('u1'),
      asstMsg('a1', [
        { type: 'reasoning', text: '先想' },
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
        toolPart('search', '{"action":"content","pattern":"x"}'),
        { type: 'text', text: '第一轮结论', finalised: true },
      ]),
      userMsg('u2'),
    ];
    const tailStages: Array<{ status: 'streaming' | 'done'; parts: AssistantMessage['parts'] }> = [
      { status: 'streaming', parts: [{ type: 'reasoning', text: '再想' }] },
      {
        status: 'streaming',
        parts: [{ type: 'reasoning', text: '再想' }, toolPart('fs', '{"action":"read","path":"c.ts"}')],
      },
      {
        status: 'streaming',
        parts: [
          { type: 'reasoning', text: '再想' },
          toolPart('fs', '{"action":"read","path":"c.ts"}'),
          toolPart('fs', '{"action":"read","path":"d.ts"}'),
        ],
      },
      {
        status: 'streaming',
        parts: [
          { type: 'reasoning', text: '再想' },
          toolPart('fs', '{"action":"read","path":"c.ts"}'),
          toolPart('fs', '{"action":"read","path":"d.ts"}'),
          toolPart('shell', '{"action":"run","command":"make"}', 'error'),
        ],
      },
      {
        status: 'streaming',
        parts: [
          { type: 'reasoning', text: '再想' },
          toolPart('fs', '{"action":"read","path":"c.ts"}'),
          toolPart('fs', '{"action":"read","path":"d.ts"}'),
          toolPart('shell', '{"action":"run","command":"make"}', 'error'),
          toolPart('shell', '{"action":"run","command":"make"}'),
        ],
      },
      {
        status: 'done',
        parts: [
          { type: 'reasoning', text: '再想' },
          toolPart('fs', '{"action":"read","path":"c.ts"}'),
          toolPart('fs', '{"action":"read","path":"d.ts"}'),
          toolPart('shell', '{"action":"run","command":"make"}', 'error'),
          toolPart('shell', '{"action":"run","command":"make"}'),
          { type: 'text', text: '恢复后结论', finalised: true },
        ],
      },
    ];
    const layouts = tailStages.map((t) => layoutOf([...head, asstMsg('a2', t.parts, t.status)]));
    // 活尾确实在演化（非平凡测试：尾块节奏档在阶段间有变化）
    const tailRhythms = layouts.map((l) => l.rhythmOf.get('pb:a2:1g') ?? l.rhythmOf.get('pb:a2:1'));
    expect(new Set(tailRhythms).size).toBeGreaterThan(1);
    // 头部封口前缀在全部前缀下逐字段一致（刚体）——前缀比对：封口集单调只增，
    // 已封块冻结后永不改值，新封块只许追加在尾部（P6 收尾封口 = 指纹变长）
    const base = sealedFingerprint(layouts[0]!);
    expect(base.length).toBeGreaterThanOrEqual(4);
    for (const l of layouts) expect(sealedFingerprint(l).slice(0, base.length)).toEqual(base);
    // 新来文到达后再看：a2 收尾后封口的块也冻结（finalised 后永不再动）
    const after = layoutOf([
      ...head,
      asstMsg('a2', tailStages[5]!.parts, 'done'),
      userMsg('u3'),
      asstMsg('a3', [{ type: 'reasoning', text: '新阶段' }], 'streaming'),
    ]);
    const a2Frozen = sealedFingerprint(layouts[5]!);
    expect(sealedFingerprint(after).slice(0, a2Frozen.length)).toEqual(a2Frozen);
  });

  it('刚体平移：封口块的绝对位移在两前缀间同值（滚动锚定——视口上方无相对跳动）', () => {
    const head: ChatMessage[] = [userMsg('u1'), asstMsg('a1', [toolPart('fs', '{"action":"read","path":"a.ts"}')])];
    const p1 = layoutOf([...head, asstMsg('a2', [{ type: 'reasoning', text: '想' }], 'streaming')]);
    const p2 = layoutOf([
      ...head,
      asstMsg(
        'a2',
        [{ type: 'reasoning', text: '想' }, toolPart('fs', '{"action":"read","path":"b.ts"}')],
        'streaming',
      ),
    ]);
    const deltas = new Set<number>();
    for (const b of p1.blocks) {
      const y1 = p1.layout.get(b.id)!.y;
      const y2 = p2.layout.get(b.id)!.y;
      deltas.add(Math.round((y2 - y1) * 1000) / 1000);
    }
    // 封口块全体同 Δ（刚体平移）；活尾块（夹注被吸入工作单元）不在此约束内
    const sealedIds = new Set(p1.units.filter((u) => u.sealed).flatMap((u) => u.memberIds));
    const sealedDeltas = new Set<number>();
    for (const b of p1.blocks) {
      if (!sealedIds.has(b.id)) continue;
      sealedDeltas.add(Math.round((p2.layout.get(b.id)!.y - p1.layout.get(b.id)!.y) * 1000) / 1000);
    }
    expect(sealedDeltas.size).toBe(1);
    expect(deltas.size).toBeGreaterThan(0);
  });
});

/* ═══ 组原子性（刀3 长会话）：虚拟化窗口不腰斩折叠组 ═══ */

describe('组原子性（刀3）：折叠组 = 布局栈单条目，展开组连续', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('折叠组（无错默认收起）：子卡不进布局栈——任何窗口对它只能整取整舍', () => {
    const l = layoutOf([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
        toolPart('fs', '{"action":"read","path":"c.ts"}'),
        { type: 'text', text: '收尾', finalised: true },
      ]),
    ]);
    const headers = l.blocks.filter((b) => b.kind === 'toolgroup');
    expect(headers).toHaveLength(1);
    const childIds = (headers[0]!.payload as { childIds: string[] }).childIds;
    expect(childIds).toHaveLength(3);
    // 原子性：子卡全部不在布局栈（几何/渲染/窗口面对组只有一个条目）
    for (const c of childIds) {
      expect(l.blocks.some((b) => b.id === c)).toBe(false);
      expect(l.layout.has(c)).toBe(false);
    }
    // 组头有节奏档（恢复/工作单元成员面）
    expect(l.rhythmOf.has(headers[0]!.id)).toBe(true);
  });

  it('展开组（组内出错自动张开）：组头 + 子卡在栈内连续（窗口切不出交错序）', () => {
    const l = layoutOf([
      asstMsg('a1', [
        { type: 'reasoning', text: '想' },
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}', 'error'),
        toolPart('search', '{}'),
        { type: 'text', text: '收尾', finalised: true },
      ]),
    ]);
    const headers = l.blocks.filter((b) => b.kind === 'toolgroup');
    expect(headers).toHaveLength(1);
    const childIds = (headers[0]!.payload as { childIds: string[] }).childIds;
    expect(childIds).toHaveLength(3);
    // 展开组：子卡在栈内，且组头与子卡构成连续 run（无外来块插入）
    const memberIds = [headers[0]!.id, ...childIds];
    const idx = l.blocks.findIndex((b) => b.id === headers[0]!.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(l.blocks.slice(idx, idx + memberIds.length).map((b) => b.id)).toEqual(memberIds);
  });

  it('长流窗口二分过节奏栈：窗口只按栈序连续取段，折叠组原子存活', () => {
    // 两段折叠组夹叙述块的长流
    const msgs: ChatMessage[] = [userMsg('u1')];
    for (let t = 0; t < 6; t++) {
      msgs.push(
        asstMsg(`a${t}`, [
          toolPart('fs', `{"action":"read","path":"f${t}.ts"}`),
          toolPart('fs', `{"action":"read","path":"g${t}.ts"}`),
          { type: 'text', text: `结论 ${t}`, finalised: true },
        ]),
      );
    }
    const l = layoutOf(msgs);
    const geom = l.blocks.map((b) => ({
      id: b.id,
      y: l.layout.get(b.id)!.y,
      h: synthH(b.id),
      x: 0,
      w: 720,
    }));
    const groupHeaders = l.blocks.filter((b) => b.kind === 'toolgroup').map((b) => b.id);
    expect(groupHeaders).toHaveLength(6);
    // 逐档视口：任取一段窗口，命中折叠组必是组头条目本身（子卡不在栈——不可能半截）
    for (let k = 0; k < geom.length; k += 3) {
      const mid = geom[k]!;
      const win = visibleFlowWindow(geom, { x0: 0, y0: mid.y - 10, x1: 100, y1: mid.y + 10 }, 200);
      for (let i = win.first; i < win.lastExcl; i++) {
        const id = geom[i]!.id;
        const isHeader = groupHeaders.includes(id);
        expect(isHeader || !groupHeaders.includes(`${id}g`)).toBe(true);
      }
    }
  });
});

/* ═══ 族边界切单元（刀5 A+B）：读→写→验证是不同的工作行为 ═══ */

describe('族边界切单元（刀5 A+B）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('translate：连续工具按族切组——读 ×2 / 写 ×2 各自成行（组头锚各族首工具，前缀稳定）', () => {
    const p1 = translateMessages([asstMsg('a1', [toolPart('fs', '{"action":"read","path":"a.ts"}')])]);
    const p2 = translateMessages([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
      ]),
    ]);
    const p3 = translateMessages([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
        toolPart('fs', '{"action":"write","path":"c.ts"}'),
      ]),
    ]);
    // 前缀稳定：lone → 读组头 pb:a1:0g → 写族不并入读组（写族 lone）
    expect(p1.some((b) => b.kind === 'toolgroup')).toBe(false);
    expect(p2.find((b) => b.kind === 'toolgroup')?.id).toBe('pb:a1:0g');
    const headers = p3.filter((b) => b.kind === 'toolgroup');
    expect(headers.map((b) => b.id)).toEqual(['pb:a1:0g']);
    expect((headers[0]!.payload as { childIds: string[] }).childIds).toEqual(['pb:a1:0', 'pb:a1:1']);
  });

  it('group：族切换封口旧单元——读包 / 写包各自工作单元（family 在册）', () => {
    const units = groupOf([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
        toolPart('fs', '{"action":"write","path":"c.ts"}'),
        toolPart('fs', '{"action":"write","path":"d.ts"}'),
      ]),
    ]);
    expect(shapes(units)).toEqual(['work#3@u:pb:a1:0g', 'work#3@u:pb:a1:2g']);
    expect(units[0]!.family).toBe('read');
    expect(units[1]!.family).toBe('write');
  });

  it('未表态族不切节奏：other 并入当前 run / 单元（不破语法铁律的节奏层延伸）', () => {
    // other 夹在已知族之间：并入读包（run 不断），写族才切
    const units = groupOf([
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('browser_click', '{}'),
        toolPart('fs', '{"action":"write","path":"c.ts"}'),
      ]),
    ]);
    expect(shapes(units)).toEqual(['work#3@u:pb:a1:0g', 'work#1@u:pb:a1:2']);
    expect(units[0]!.family).toBe('read');
    // other 打头：未认领单元被首个已知族认领（不切）——run ≥2 成组，族取末位表态
    const units2 = groupOf([
      asstMsg('a1', [toolPart('browser_click', '{}'), toolPart('fs', '{"action":"read","path":"a.ts"}')]),
    ]);
    expect(shapes(units2)).toEqual(['work#3@u:pb:a1:0g']);
    expect(units2[0]!.family).toBe('read');
  });

  it('recovery：同族重试续收恢复单元，异族切出新工作单元', () => {
    const units = groupOf([
      asstMsg('a1', [
        toolPart('shell', '{"action":"run","command":"cargo test"}', 'error'),
        toolPart('shell', '{"action":"run","command":"cargo test"}'),
        toolPart('fs', '{"action":"write","path":"fix.ts"}'),
      ]),
    ]);
    // 验证错误 + 同族重试 → 恢复单元（verify）；写修复 → 族界切出新工作单元
    expect(shapes(units)).toEqual(['recovery#3@u:pb:a1:0g', 'work#1@u:pb:a1:2']);
    expect(units[0]!.family).toBe('verify');
    expect(units[1]!.family).toBe('write');
  });
});

/* ═══ 单元界短规线 + 验证链毕锚（刀5 C+D）═══ */

describe('单元界短规线 + 验证链毕锚（刀5 C+D）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('验证链毕锚：链毕（后继非恢复 / sealed 末位）发；流式在跑与失败转折不发', () => {
    // ① verify 后随叙述（done 消息）→ 链末块发锚
    const r1 = layoutOf([
      asstMsg('a1', [
        toolPart('shell', '{"action":"run","command":"cargo test"}'),
        { type: 'text', text: '结论', finalised: true },
      ]),
    ]);
    expect(r1.verifyDoneIds.has('pb:a1:0')).toBe(true);
    // ② verify 后随 recovery（失败转折）→ 不发（✓ 不说谎）
    const r2 = layoutOf([
      asstMsg('a1', [
        toolPart('shell', '{"action":"run","command":"cargo test"}'),
        toolPart('fs', '{"action":"write","path":"c.ts"}', 'error'),
        { type: 'text', text: '修后结论', finalised: true },
      ]),
    ]);
    expect(r2.verifyDoneIds.size).toBe(0);
    // ③ 流式在跑：verify 是流末开放单元 → 不发
    const r3 = layoutOf([asstMsg('a1', [toolPart('shell', '{"action":"run","command":"cargo test"}')], 'streaming')]);
    expect(r3.verifyDoneIds.size).toBe(0);
    // ④ sealed 末位 verify（回合以验证收尾）→ 发
    const r4 = layoutOf([asstMsg('a1', [toolPart('shell', '{"action":"run","command":"cargo test"}')])]);
    expect(r4.verifyDoneIds.has('pb:a1:0')).toBe(true);
  });

  it('单元界短规线：work 首且上方非来文才发；叙述 / 恢复 / 来文后不发', () => {
    const r1 = layoutOf([
      userMsg('u1'),
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        toolPart('fs', '{"action":"read","path":"b.ts"}'),
        toolPart('fs', '{"action":"write","path":"c.ts"}'),
        { type: 'text', text: '结论', finalised: true },
      ]),
    ]);
    // 栈：user → 读组头 → 写 lone → 叙述
    expect(r1.unitLeadIds.has('pb:a1:0g')).toBe(false); // 来文后首包：B1 反转区（尾距 8）无线位
    expect(r1.unitLeadIds.has('pb:a1:2')).toBe(true); // 写包首（上方是读组头）
    expect(r1.unitLeadIds.has('pb:a1:3')).toBe(false); // 叙述不发线
    // 恢复首不发（转折自宣告）；栈首 work 首不发线（2026-09-06 尸检改：
    // -32px 线画进卷首头带——贴 head 底硬规线上方 2px，同病灶同判据）
    const r2 = layoutOf([
      asstMsg('a1', [
        toolPart('fs', '{"action":"write","path":"c.ts"}'),
        toolPart('shell', '{"action":"run","command":"cargo test"}', 'error'),
      ]),
    ]);
    expect(r2.unitLeadIds.has('pb:a1:0')).toBe(false); // 栈首：上方无物可界
    expect(r2.unitLeadIds.has('pb:a1:1')).toBe(false);
  });

  it('栈首不发线（2026-09-06 尸检回归）：阶段线/单元线的 -48/-32px 不得画进卷首头带', () => {
    // 病灶：stageLeadIds/unitLeadIds 原对栈首（i=0）块也发——块级线的
    // 负偏移落进卷首头带（阶段线 -48 在 head padding-bottom 带内、head
    // 底硬规线上方 ~18px 处，每卷必现一根全宽错位线；单元线 -32 贴规线
    // 上方 2px）。语义正解：线标记「上方有界」——栈首之上只有卷首（天然
    // 界），无线位。rhythmOf 不动（间距档语义与封口指纹不受影响）。
    const r = layoutOf([
      userMsg('u1'),
      asstMsg('a1', [
        toolPart('fs', '{"action":"read","path":"a.ts"}'),
        { type: 'text', text: '结论', finalised: true },
      ]),
      userMsg('u2'),
      asstMsg('a2', [toolPart('fs', '{"action":"read","path":"b.ts"}')]),
    ]);
    // 栈首来文：无上方阶段，不发阶段线；流内来文恒发
    expect(r.stageLeadIds.has('pb:u1')).toBe(false);
    expect(r.stageLeadIds.has('pb:u2')).toBe(true);
    // 节奏档不受线发放影响（u1 仍是 stage 档——间距语义不变）
    expect(r.rhythmOf.get('pb:u1')).toBe('stage');
  });
});

/* ═══ 长流性能烟测（刀3 旧卷回放）═══ */

describe('长流性能烟测（刀3）：单卷千块级全链预算', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  it('~2200 块全链（translate→group→rhythm→layout）远低于预算（预算 1.5s，防回放回归）', () => {
    const msgs: ChatMessage[] = [];
    for (let t = 0; t < 55; t++) {
      msgs.push(userMsg(`u${t}`, `回合 ${t}`));
      const parts: AssistantMessage['parts'] = [{ type: 'reasoning', text: `回合 ${t} 思考` }];
      for (let k = 0; k < 20; k++) parts.push(toolPart('fs', `{"action":"read","path":"src/f${t}_${k}.ts"}`));
      parts.push(toolPart('shell', '{"action":"run","command":"cargo test"}'));
      parts.push({ type: 'text', text: `回合 ${t} 结论`, finalised: true });
      msgs.push(asstMsg(`a${t}`, parts));
    }
    const t0 = Date.now();
    const l = layoutOf(msgs);
    const elapsed = Date.now() - t0;
    // 正确性面：全封口、组头成型、节奏档齐备（栈块数被折叠组压缩——判别量
    // 看转译总数；折叠组是原子单条目，见组原子性组）
    expect(l.translated.length).toBeGreaterThan(1200);
    expect(l.blocks.length).toBeGreaterThan(200);
    expect(l.units.every((u) => u.sealed)).toBe(true);
    expect(l.units.filter((u) => u.kind === 'work').length).toBeGreaterThan(50);
    for (const b of l.blocks) expect(l.rhythmOf.has(b.id)).toBe(true);
    // 性能面：宽松预算防环境抖动（实测 ~几十 ms 量级；此断言护的是数量级回归）
    expect(elapsed).toBeLessThan(1500);
  });
});
