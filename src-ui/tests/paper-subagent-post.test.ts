// @vitest-environment happy-dom

// 子代理**帖**的数据面（2026-11-20 帖批）。
//
// 帖要说的三件事以前一件都读不到：怎么派的（mode）、走了多久（startedAt/finishedAt）、
// 办成什么样（回文）。本文件钉住这三点从**生产端 → part → 转译块**的穿透，
// 以及「活体行只在进行时存在」这条判据（它决定帖高，测高镜像靠它）。

import { describe, expect, it, vi } from 'vitest';

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
import { defaultFolded } from '../src/paper/fold';
import { subagentPostFields } from '../src/paper/translate';
import { measureBlockHeight } from '../src/plugins/builtin/paper-shell/measure';
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
    expect(measureBlockHeight(live)).toBe(10 + 20 + 2 + 15);
    expect(measureBlockHeight(settled)).toBe(10 + 20);
    const withReport = blockOf(
      subagentPostFields(part({ status: 'done', parts: [toolPart('fs', 'done')], reportText: '办完了' })),
    );
    expect(measureBlockHeight(withReport)).toBeGreaterThan(measureBlockHeight(settled));
  });

  it('帖默认收起（体是子块，壳层摘除）；出错时张开', () => {
    const ok = blockOf(subagentPostFields(part({ status: 'done' })));
    expect(defaultFolded('subagent', ok.payload)).toBe(true);
    const bad = blockOf(subagentPostFields(part({ status: 'error', errorText: '挂了' })), 'error');
    expect(defaultFolded('subagent', bad.payload)).toBe(false);
  });
});
