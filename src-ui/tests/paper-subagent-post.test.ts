// @vitest-environment happy-dom

// 子代理**帖**的数据面（2026-11-20 帖批）。
//
// 帖要说的三件事以前一件都读不到：怎么派的（mode）、走了多久（startedAt/finishedAt）、
// 办成什么样（回文）。本文件钉住这三点从**生产端 → part → 转译块**的穿透，
// 以及「活体行只在进行时存在」这条判据（它决定帖高，测高镜像靠它）。

import { describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  // 行高按 pretext 真实语义（height = lineCount × lineHeight，lineHeight 是 **px**）。
  // 2026-11-21 叠字事故里测高把系数 1.85 当 px 递进来，常高 mock（36）把单位病盖住了
  // ——mock 必须自己尊重第三个参数，单位漂移才测得出来。
  layout: vi.fn((_p: unknown, _w: number, lineHeight: number) => ({ height: lineHeight * 2, lineCount: 2 })),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock, isPostInner, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { defaultFolded } from '../src/paper/fold';
import { subagentPostFields, translateMessages } from '../src/paper/translate';
import {
  createBlockMeasureCache,
  FOLD_TAIL_H,
  measureBlockHeight,
  measureBlockHeightCached,
} from '../src/plugins/builtin/paper-shell/measure';
import { measurePostInnerStepH, postInnerShellH } from '../src/plugins/builtin/paper-shell/post-metrics';
import { cssUsedPx } from '../src/plugins/builtin/paper-shell/type-tokens';
import type { SubAgentPart, ToolCallPart } from '../src/ui/message-model';

function toolPart(name: string, status: ToolCallPart['status'] = 'done'): ToolCallPart {
  return {
    type: 'tool',
    toolId: `tc-${name}`,
    name,
    label: name,
    args: '{}',
    readOnly: false,
    status,
  };
}

function part(over: Partial<SubAgentPart> = {}): SubAgentPart {
  return {
    type: 'subagent',
    agentId: 'sub-1',
    description: '校对员 · 错别字扫描',
    status: 'running',
    parts: [],
    version: 0,
    ...over,
  };
}

describe('帖的读数投影（translate.subagentPostFields）', () => {
  it('步数 = 帖内工具卡数；doing = 最后一张仍在跑的卡；进行时无在跑工具 ⇒ 思考中', () => {
    const p = part({ parts: [toolPart('fs', 'done'), toolPart('search', 'running')] });
    const f = subagentPostFields(p);
    expect(f.step).toBe(2);
    expect(f.doing).toBe('search');
    const thinking = part({ parts: [toolPart('fs', 'done'), toolPart('search', 'done')] });
    expect(subagentPostFields(thinking).doing).toBe('思考中');
  });

  it('收尾后 doing 归零（活体行退场）；复命/未办分别投影 report / error', () => {
    const done = part({ status: 'done', parts: [toolPart('fs', 'running')], reportText: '全书 47 处图注断号' });
    const f = subagentPostFields(done);
    expect(f.doing).toBeNull();
    expect(f.report).toBe('全书 47 处图注断号');
    expect(f.error).toBeUndefined();
    const bad = part({ status: 'error', errorText: '超过 30 分钟上限被中止' });
    expect(subagentPostFields(bad).error).toBe('超过 30 分钟上限被中止');
    expect(subagentPostFields(bad).report).toBeUndefined();
  });

  it('走秒两端与派生模式原样透出（缺省 = 旧卷，不编造）', () => {
    const p = part({ mode: 'fresh', startedAt: 1000, finishedAt: 2000 });
    const f = subagentPostFields(p);
    expect(f.mode).toBe('fresh');
    expect(f.startedAt).toBe(1000);
    expect(f.finishedAt).toBe(2000);
    const legacy = part();
    expect(subagentPostFields(legacy).mode).toBeUndefined();
    expect(subagentPostFields(legacy).startedAt).toBeUndefined();
  });
});

describe('帖高随读数走（测高镜像与渲染同源）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  const blockOf = (f: ReturnType<typeof subagentPostFields>, status: SubAgentPart['status'] = 'done') =>
    createBlock(
      'subagent',
      { agentId: 'sub-1', description: 'd', status, childIds: [], items: [], ...f },
      { messageId: 'm', part: null },
    );

  it('在办比收尾高一条活体行；有复文再加复命段', () => {
    const live = blockOf(subagentPostFields(part({ parts: [toolPart('fs', 'running')] })), 'running');
    const settled = blockOf(subagentPostFields(part({ status: 'done', parts: [toolPart('fs', 'done')] })));
    // 展开态帖首底下还有一枚块底把手（2026-11-25 第二落点批）
    expect(measureBlockHeight(live)).toBe(10 + 20 + 2 + 15 + FOLD_TAIL_H);
    expect(measureBlockHeight(settled)).toBe(10 + 20 + FOLD_TAIL_H);
    // 收起态：块顶即收起面，无把手
    expect(measureBlockHeight(settled, true)).toBe(10 + 20);
    const withReport = blockOf(
      subagentPostFields(part({ status: 'done', parts: [toolPart('fs', 'done')], reportText: '办完了' })),
    );
    expect(measureBlockHeight(withReport)).toBeGreaterThan(measureBlockHeight(settled));
  });

  /* 2026-11-21 真机叠字事故（用户报「子代理卡片折叠状态盖住后一个工具卡片的文字」）：
   * 渲染端收起态照画复命段，测高却在 folded 分支提前 return ⇒ 后一块按没有复命的坐标排。
   * 本用例钉三件事：① 收起态也计复命段；② 行高按 px 用值（12.5×1.85）而不是系数；
   * ③ 上规线 + 段头 + 正文上距都在账上。 */
  it('收起态复命段照样计高（帖尾不是折叠的抽屉）——行高按 12.5×1.85 的 px 用值', () => {
    const withoutReport = blockOf(subagentPostFields(part({ status: 'done', parts: [toolPart('fs', 'done')] })));
    const withReport = blockOf(
      subagentPostFields(part({ status: 'done', parts: [toolPart('fs', 'done')], reportText: '办完了' })),
    );
    const delta = measureBlockHeight(withReport, true) - measureBlockHeight(withoutReport, true);
    // mock 固定两行：2 × (12.5 × 1.85)；段头行同 CSS 用值（9 × 1.2 过 1/64 量化）
    const reportBodyH = 2 * 12.5 * 1.85;
    expect(delta).toBeCloseTo(10 + 1 + 9 + cssUsedPx(9 * 1.2) + 6 + reportBodyH, 6);
  });

  it('帖默认收起；出错时张开', () => {
    const ok = blockOf(subagentPostFields(part({ status: 'done' })));
    expect(defaultFolded('subagent', ok.payload)).toBe(true);
    const bad = blockOf(subagentPostFields(part({ status: 'error', errorText: '挂了' })), 'error');
    expect(defaultFolded('subagent', bad.payload)).toBe(false);
  });
});

describe('帖内页：子块不属于父卷（2026-11-21 内页批）', () => {
  beforeEach(() => resetBlockIdCounterForTests());

  const msgWithPost = () => {
    const p = part({
      status: 'done',
      parts: [toolPart('fs', 'done'), toolPart('search', 'done'), { type: 'text', text: '子正文', finalised: true }],
    });
    return {
      _id: 'm1',
      role: 'assistant' as const,
      respondingTo: 'u1',
      status: 'done' as const,
      parts: [{ type: 'text' as const, text: '父正文', finalised: true }, p],
    };
  };

  it('translate：子块带 ownerPostId，帖 payload 持有同一批块（inner）', () => {
    const blocks = translateMessages([msgWithPost() as never]);
    const post = blocks.find((b) => b.kind === 'subagent')!;
    const children = blocks.filter((b) => isPostInner(b));
    expect(children.length).toBe(3);
    for (const c of children) expect(c.source.ownerPostId).toBe(post.id);
    const inner = (post.payload as { inner: typeof blocks }).inner;
    expect(inner.map((b) => b.id)).toEqual(children.map((b) => b.id));
  });

  it('父卷视角：滤掉内页块后只剩父卷自己的块（块数/流水号不再被子代理撑大）', () => {
    const blocks = translateMessages([msgWithPost() as never]);
    const parent = blocks.filter((b) => !isPostInner(b));
    expect(parent.map((b) => b.kind)).toEqual(['markdown', 'subagent']);
    expect(parent.length).toBe(2);
  });

  it('内页默认收起 ⇒ 帖高只算帖签；展开才把内页算进去', () => {
    const blocks = translateMessages([msgWithPost() as never]);
    const post = blocks.find((b) => b.kind === 'subagent')!;
    const collapsed = measureBlockHeight(post, true);
    const expanded = measureBlockHeight(post, false);
    expect(collapsed).toBe(10 + 20);
    expect(expanded).toBeGreaterThan(collapsed);
  });

  /* 2026-11-21 叠字批：内页测宽必须等于 DOM 的实际行盒宽——帖块 border-box，
   * 块宽先扣聘线 1 + 左内距 15；内页自己再扣左规线 1 + 左内距 10；步内再扣
   * 序号列 26 + 列距 8。旧式子从块宽直接扣后三样，多算 16px ⇒ 长内页少折一行。 */
  it('内页测宽扣齐帖块聘线/左内距与内页规线（漏扣 = 长内页少折一行）', () => {
    let bodyW = Number.NaN;
    const h = measurePostInnerStepH({ kind: 'markdown', w: 0 }, 600, (b) => {
      bodyW = b.w;
      return 120;
    });
    expect(bodyW).toBe(600 - (1 + 15) - (1 + 10) - 26 - 8);
    expect(h).toBe(120); // markdown 内页无父卷块壳
  });

  /* 内页是**体**渲染（folded=false）：父卷的折叠行不在 DOM 里，测高必须扣掉。
   * 2026-11-21 叠字批：旧表只扣 padTop、夹注一分不扣 ⇒ 每步多算 20px 的虚高空白。 */
  it('内页块壳含折叠行与块底把手（脚注 50 / 夹注 40 / 工具组 30 / 正文 0）——多扣或少扣都是虚高/压字', () => {
    // 2026-11-25 第二落点批：内页只画体，父卷那枚块底把手也不在 DOM 里 ⇒ 一并扣掉。
    expect(postInnerShellH('tool', true)).toBe(10 + 20 + FOLD_TAIL_H); // toolPadTop + .pp-fold + 把手
    expect(postInnerShellH('code', true)).toBe(10 + 20 + FOLD_TAIL_H);
    expect(postInnerShellH('reasoning', true)).toBe(20 + FOLD_TAIL_H);
    // 工具组头无体、无把手（判据同 paper/fold.hasFoldTail）
    expect(postInnerShellH('toolgroup', true)).toBe(10 + 20);
    expect(postInnerShellH('markdown')).toBe(0);
    // 内页步高 = 父卷形态量出来的块高 − 块壳（130 = 体 80 + 壳 50）
    expect(measurePostInnerStepH({ kind: 'tool', w: 0 }, 600, () => 130)).toBe(80);
  });
});

describe('帖的测量缓存必须区分折叠态（2026-11-21 长空白事故）', () => {
  /* 真机事故：点开帖之后流里出现**非常长的一段空白**。
   * 根因 = `measureSignature('subagent')` 漏了折叠位——折叠态算出的 30px 写进测量缓存，
   * 展开那一帧签名完全相同 ⇒ 直接吃 30，而 DOM 已经展开成几百 px：帖的内容溢出块框、
   * 下方块仍按 30px 排。tool / code / plan 三条兄弟分支都靠 `f` 入签避免这类事故，唯独帖漏了。
   *
   * 这条钉子查的是**缓存行为**，不是字面量：同一块先量收起、再量展开，两次必须不同。 */
  const postWithInner = () => {
    const inner = [
      createBlock(
        'tool',
        {
          toolId: 't',
          name: 'fs',
          label: 'fs(read) a.ts',
          args: '{"path":"a.ts"}',
          status: 'done',
          output: 'hello',
        } as never,
        { messageId: 'm', part: null },
      ),
    ];
    return createBlock(
      'subagent',
      { agentId: 'a', description: 'd', status: 'done', childIds: [], items: [], inner } as never,
      { messageId: 'm', part: null },
    );
  };

  it('展开与收起是两个高（缓存不许串味）', () => {
    const cache = createBlockMeasureCache();
    const post = postWithInner();
    const collapsed = measureBlockHeightCached(post, cache, true);
    const expanded = measureBlockHeightCached(post, cache, false);
    expect(collapsed).toBe(10 + 20);
    expect(expanded, '展开态必须重新量（旧事故：吃到收起态的 30）').toBeGreaterThan(collapsed);
    // 反向再来一次：先展开后收起也必须各自正确（缓存双向都不许串）
    const cache2 = createBlockMeasureCache();
    expect(measureBlockHeightCached(post, cache2, false)).toBe(expanded);
    expect(measureBlockHeightCached(post, cache2, true)).toBe(collapsed);
  });

  it('内页步数变化要重测（流式追加步骤时帖要长高）', () => {
    const cache = createBlockMeasureCache();
    const post = postWithInner();
    const before = measureBlockHeightCached(post, cache, false);
    const more = {
      ...post,
      payload: {
        ...(post.payload as object),
        inner: [
          ...(post.payload as { inner: unknown[] }).inner,
          createBlock('markdown', { text: '第二步产出' }, { messageId: 'm', part: null }),
        ],
      },
    };
    expect(measureBlockHeightCached(more as never, cache, false)).toBeGreaterThan(before);
  });
});
