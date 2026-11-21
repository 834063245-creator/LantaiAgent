// @vitest-environment happy-dom
//
// 子代理**帖**的渲染面（2026-11-20 帖批）：复命段真的落在纸上。
//
// 只测测高不够——测高是纸壳的镜像，它可以对而渲染端什么都不画（旧实现正是
// SubagentGroupBody 恒 return null，测高 30 却一张卡也没有）。本文件穿真渲染器。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock } from '../src/paper/block-model';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';

function postBlock(payload: Record<string, unknown>) {
  return createBlock(
    'subagent',
    { agentId: 'a', description: 'd', status: 'done', childIds: [], items: [], ...payload } as never,
    { messageId: 'm', part: null },
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPost(payload: Record<string, unknown>): void {
  const def = builtinRendererDefs().find((d) => d.kind === 'subagent');
  expect(def, 'subagent 渲染器必须注册（缺注册 = 落 JSON 兜底，payload 含活 part 引用会炸）').toBeTruthy();
  const C = def!.component;
  const folded = payload.__folded === true;
  act(() => {
    root.render(createElement(C, { block: postBlock(payload) as never, folded }));
  });
}

describe('帖的渲染面：复命段', () => {
  it('复命正文落在纸上，并标「已办」', () => {
    renderPost({ status: 'done', report: '全书 47 处图注断号，已列成清单。' });
    const text = container.querySelector('.pp-post-report-text')?.textContent ?? '';
    expect(text).toContain('47 处图注断号');
    expect(container.querySelector('.pp-post-report-res--ok')?.textContent).toBe('已办');
  });

  it('未办：正文取 error，并标「未办」', () => {
    renderPost({ status: 'error', error: '超过 30 分钟上限被中止。' });
    expect(container.querySelector('.pp-post-report-text')?.textContent).toContain('30 分钟上限');
    expect(container.querySelector('.pp-post-report-res--bad')?.textContent).toBe('未办');
    expect(container.querySelector('.pp-post-report--failed')).toBeTruthy();
  });

  /* 2026-11-21 真机叠字事故：收起态的帖照画复命段（帖尾不随内页收起），而测高把
   * 它当「无复命」算 ⇒ 后一块压上复命正文。这里钉住渲染面的语义：折叠只管内页。 */
  it('收起态：复命段仍在纸面（折叠只收内页，帖尾不收起）', () => {
    renderPost({ status: 'done', report: '全书 47 处图注断号，已列成清单。', __folded: true });
    expect(container.querySelector('.pp-post-report-text')?.textContent).toContain('47 处图注断号');
  });

  it('无回文（还在办）⇒ 整段不在场（不留空框）', () => {
    renderPost({ status: 'running', doing: 'fs(read) a.ts' });
    expect(container.querySelector('.pp-post-report')).toBeNull();
  });

  it('报成功但正文为空 ⇒ 仍不出段（宁缺勿造，不铺半截复命）', () => {
    renderPost({ status: 'done', report: '' });
    expect(container.querySelector('.pp-post-report')).toBeNull();
  });
});

describe('帖内页的渲染面（2026-11-21 内页批）', () => {
  const innerBlocks = () => [
    createBlock('reasoning', { text: '想了想' }, { messageId: 'm', part: null }),
    createBlock(
      'tool',
      { toolId: 't', name: 'fs', label: 'fs(read)', args: '{"path":"a.ts"}', status: 'done', output: 'ok' } as never,
      { messageId: 'm', part: null },
    ),
  ];

  it('默认收起：内页不出 DOM（父卷纸面干净——用户 2026-11-21 拍板「思考放父卷里干嘛」）', () => {
    renderPost({ status: 'done', inner: innerBlocks(), __folded: true });
    expect(container.querySelector('.pp-post-inner')).toBeNull();
  });

  it('展开：内页出 DOM，局部编号 1/N 与父卷流水号无关', () => {
    renderPost({ status: 'done', inner: innerBlocks() });
    expect(container.querySelector('.pp-post-inner')).toBeTruthy();
    const nos = [...container.querySelectorAll('.pp-post-inner-no')].map((e) => e.textContent);
    expect(nos).toEqual(['1/2', '2/2']);
  });

  it('内页里的工具卡走同一套语义投影（不是第二套渲染）', () => {
    renderPost({ status: 'done', inner: innerBlocks() });
    const body = container.querySelector('.pp-post-inner-step--tool');
    expect(body?.textContent?.length, '工具卡体应当有内容（投影渲染）').toBeGreaterThan(0);
  });
});
