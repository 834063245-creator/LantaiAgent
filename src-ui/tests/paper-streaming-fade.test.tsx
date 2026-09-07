// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流式增量渐显（streaming-fade-render-plan 2026-08-30）：renderer 增量机制守护。
// 用户操作序列式断言（不写实现形状——测「文本追加 → 只有新增段淡入」这个行为）：
//   1. 流式追加：旧内容稳定、新到达内容带 pp-ink-delta 淡入
//   2. 非追加（编辑/回填）：整块稳定，无增量尾巴
//   3. folded 切换（reasoning 收折/展开）：重置，不把已展示内容当增量
// 渲染 = 真实 react-dom createRoot（paper-c10-attachments 同款范式）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同款范式）
const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));

import { builtinRendererDefs } from '../src/composition/renderer-service';
import type { SourcedBlock } from '../src/paper/block-model';
import { createBlock } from '../src/paper/block-model';

/** 取内置渲染器组件（按 kind）——渲染器清单是装配产物的消费面。 */
function rendererFor(kind: string) {
  const def = builtinRendererDefs().find((d) => d.kind === kind);
  expect(def, `内置渲染器 ${kind} 存在`).toBeDefined();
  return def!.component;
}

/** 变出一个文本块（每次换 payload 文本 = 流式追加一帧） */
function textBlock(kind: 'markdown' | 'reasoning' | 'notice', text: string): SourcedBlock {
  return createBlock(kind, { text }, { messageId: 'm', part: null });
}

describe('流式增量渐显 — MarkdownBody（正文）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const render = (b: SourcedBlock) => {
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: b }));
    });
  };

  it('首帧：整块稳定，无增量段（历史回填不闪）', () => {
    render(textBlock('markdown', '第一行\n第二行'));
    const body = container!.querySelector('.pp-body');
    expect(body?.textContent).toBe('第一行\n第二行');
    // 无流式增量 → 无淡入段
    expect(container!.querySelector('.pp-ink-delta')).toBeNull();
  });

  it('流式追加：旧内容稳定（正文里），新到达内容单独淡入', () => {
    // 帧 1：整行稳定
    render(textBlock('markdown', '第一行\n第二行'));
    const delta1 = container!.querySelectorAll('.pp-ink-delta');
    expect(delta1).toHaveLength(0);

    // 帧 2：追加"\n第三行" → 增量含换行 → 块级新块淡入（第三行）
    render(textBlock('markdown', '第一行\n第二行\n第三行'));
    const delta2 = container!.querySelectorAll('.pp-ink-delta');
    expect(delta2).toHaveLength(1);
    expect(delta2[0]?.textContent).toBe('第三行');
    // 旧内容仍在稳定段，未被吞
    expect(container!.querySelector('.pp-body')?.textContent).toContain('第一行');
    expect(container!.querySelector('.pp-body')?.textContent).toContain('第二行');
  });

  it('行内追加（不跨换行）：增量接进最后一个块（字符级淡入），旧内容零动画', () => {
    render(textBlock('markdown', '第一行\n第二行'));
    // 帧 2：在"第二行"内追加"续" → 无换行 → 行内 tail 接进最后一个段落
    render(textBlock('markdown', '第一行\n第二行续'));
    const delta2 = container!.querySelectorAll('.pp-ink-delta');
    expect(delta2).toHaveLength(1);
    // 增量在最后一个块内（与旧段落同容器）
    expect(delta2[0]?.textContent).toBe('续');
    // 完整内容不重复：正文文本恰等于最新全文
    expect(container!.querySelector('.pp-body')?.textContent).toBe('第一行\n第二行续');
  });

  it('首 token（stable 空）：增量不丢字', () => {
    render(textBlock('markdown', '')); // 流式开始：空文本
    expect(container!.querySelector('.pp-body')?.textContent).toBe('');
    // 第一个 token 到达：stable 空 → blocks 空 → 增量兜底落体
    render(textBlock('markdown', '第'));
    expect(container!.querySelector('.pp-body')?.textContent).toBe('第');
    expect(container!.querySelector('.pp-ink-delta')?.textContent).toBe('第');
  });

  it('编辑/重置（非追加）：整块稳定，不把旧文本当增量', () => {
    render(textBlock('markdown', '原内容'));
    // 替换（非追加前缀）：如用户编辑、历史回填
    render(textBlock('markdown', '完全不同的新内容'));
    expect(container!.querySelectorAll('.pp-ink-delta')).toHaveLength(0);
    expect(container!.querySelector('.pp-body')?.textContent).toBe('完全不同的新内容');
  });

  /* ── 尾块行内续写回归（会话流偶发吞尾字 bug 根因）──
   * 行内增量（无换行的 delta）由 MarkdownBody 切成 tailNode 只挂最后一个块；
   * 若收尾块是 list/table/math/hr（renderMdBlock 的 case 不消费 tail），
   * 该帧新字符被静默丢弃——数据没丢，块重挂/全量重解析时"又出现"。
   * 断言聚焦增量字是否出现（列表标记/表格格线是 CSS 呈现，不进 textContent）。 */
  it('回归：列表收尾 + 行内续写——增量不丢字（吞尾字根因）', () => {
    render(textBlock('markdown', '- 甲\n- 乙'));
    render(textBlock('markdown', '- 甲\n- 乙丙'));
    expect(container!.querySelector('.pp-body')?.textContent).toContain('乙');
    expect(container!.querySelector('.pp-body')?.textContent).toContain('丙'); // 尾块续写增量——丢 tail 时此断言红
  });

  it('回归：表格收尾 + 行内续写——增量不丢字', () => {
    render(textBlock('markdown', '| a | b |\n|---|---|\n| 1 | 2 |'));
    render(textBlock('markdown', '| a | b |\n|---|---|\n| 1 | 2X |'));
    expect(container!.querySelector('.pp-body')?.textContent).toContain('2X');
    expect(container!.querySelector('.pp-body')?.textContent).toContain('X'); // hr 尾块续写——丢 tail 时此断言红
  });

  it('回归：列表尾连续多 token 行内续写——整串不丢（真实偶发观感）', () => {
    render(textBlock('markdown', '- 甲\n- 乙'));
    render(textBlock('markdown', '- 甲\n- 乙丙'));
    render(textBlock('markdown', '- 甲\n- 乙丙丁'));
    render(textBlock('markdown', '- 甲\n- 乙丙丁戊'));
    expect(container!.querySelector('.pp-body')?.textContent).toContain('戊');
    expect(container!.querySelector('.pp-body')?.textContent).toContain('乙丙丁');
  });

  it('回归：分隔线收尾 + 同行续写——不静默吞字', () => {
    render(textBlock('markdown', '---'));
    render(textBlock('markdown', '---X'));
    expect(container!.querySelector('.pp-body')?.textContent).toContain('X');
  });
});

describe('流式增量渐显 — TextBody（思考/通知）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const render = (b: SourcedBlock, folded?: boolean) => {
    act(() => {
      root?.render(createElement(rendererFor('reasoning'), { block: b, ...(folded !== undefined ? { folded } : {}) }));
    });
  };

  it('流式追加：新内容淡入，旧内容稳定', () => {
    render(textBlock('reasoning', '思考一'));
    render(textBlock('reasoning', '思考一续'));
    const delta = container!.querySelectorAll('.pp-ink-delta');
    expect(delta).toHaveLength(1);
    expect(delta[0]?.textContent).toBe('续'); // 增量只含新字符
    expect(container!.querySelector('.pp-body')?.textContent).toBe('思考一续'); // 完整内容无重复
  });

  it('folded 收折再展开：重置 ref，不把已展示内容当增量', () => {
    render(textBlock('reasoning', '思考内容'), true); // 折叠态 → 单行预览
    render(textBlock('reasoning', '思考内容'), false); // 展开
    // 展开后旧文本稳定，无增量尾巴（重置语义）
    expect(container!.querySelectorAll('.pp-ink-delta')).toHaveLength(0);
  });
});
