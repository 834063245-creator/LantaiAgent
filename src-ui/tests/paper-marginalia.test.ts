// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-marginalia — P5 夹注眉批化：translate 配对（连续 reasoning 合并吸附
// 紧随 text）/ 回退规则（无正文后继不丢字）/ 复合测高 max(正文, 夹注@侧栏)。
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock pretext 全家（paper-v3a 同款）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  measureNaturalWidth: vi.fn(() => 200),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

import type { SourcedBlock } from '../src/paper/block-model';
import {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  MARGINALIA_OUT_H,
  MARGINALIA_TOGGLE_H,
  MARGINALIA_TOP,
  measureBlockHeight,
  measureBlockHeightCached,
  observedKeyOf,
  observedSidecarExtentOf,
  reportObservedBlockHeight,
  reportObservedSidecarExtent,
} from '../src/paper/measure';
import { translateMessage } from '../src/paper/translate';
import { injectPaperTokens } from '../src/paper/type-tokens';
import type { AssistantMessage } from '../src/ui/message-model';

function asstMsg(parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: 'm-marg', parts, sessionIndex: 0 };
}
function reasoning(text: string): AssistantMessage['parts'][number] {
  return { type: 'reasoning', text } as AssistantMessage['parts'][number];
}
function textPart(text: string): AssistantMessage['parts'][number] {
  return { type: 'text', text, finalised: true } as AssistantMessage['parts'][number];
}

/* ═══ translate 配对（方案甲）═══ */

describe('translate 眉批配对（P5）', () => {
  it('reasoning + 紧随 text → 单 markdown 复合块（sidecar 吸附，夹注不独立成块）', () => {
    const blocks = translateMessage(asstMsg([reasoning('思考全文'), textPart('正文内容')]), undefined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('markdown');
    expect(blocks[0].id).toBe('pb:m-marg:1'); // 复合块 id = text part 的稳定 id
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar?.text).toBe('思考全文');
    expect((blocks[0].payload as { text: string }).text).toBe('正文内容');
  });

  it('连续多条 reasoning 合并进同一眉批', () => {
    const blocks = translateMessage(asstMsg([reasoning('甲'), reasoning('乙'), textPart('正文')]), undefined);
    expect(blocks).toHaveLength(1);
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar?.text).toBe('甲\n\n乙');
  });

  it('夹注后继非正文（tool）→ 回退独立 reasoning 块（不丢字）', () => {
    const blocks = translateMessage(
      asstMsg([
        reasoning('前置思考'),
        {
          type: 'tool',
          toolId: 't1',
          name: 'n',
          label: 'l',
          args: '{}',
          status: 'done',
        } as AssistantMessage['parts'][number],
        textPart('正文'),
      ]),
      undefined,
    );
    // 回退 reasoning + tool + markdown（无 sidecar——text 前无紧邻 reasoning）
    expect(blocks.map((b) => b.kind)).toEqual(['reasoning', 'tool', 'markdown']);
    expect((blocks[0].payload as { text: string }).text).toBe('前置思考');
    expect((blocks[2].payload as { sidecar?: { text: string } }).sidecar).toBeUndefined();
  });

  it('消息尾 reasoning 无正文后继 → 独立块回退', () => {
    const blocks = translateMessage(asstMsg([textPart('正文'), reasoning('尾巴思考')]), undefined);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'reasoning']);
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar).toBeUndefined();
  });

  it('text 只含围栏（代码 / diff 皆然）→ 无正文段，眉批回退独立块（id 用原夹注 idx）', () => {
    // 2026-09-23 文类回归批：围栏一律独立成抄录块 ⇒ 只含围栏的 text 掏空了正文段，
    // 眉批没有正文可吸附——回退独立 reasoning 块，不丢字（「代码围栏吸附」是上一批
    // 回吐 markdown 的伴随行为，随该行为一并退役）。
    for (const fence of ['```ts\nconst a = 1;\n```', '```diff\n+ a\n```']) {
      const blocks = translateMessage(asstMsg([reasoning('围栏前的思考'), textPart(fence)]), undefined);
      const kinds = blocks.map((b) => b.kind);
      expect(kinds).not.toContain('markdown');
      expect(kinds).toContain('reasoning');
      expect(kinds).toContain('diff');
      const rb = blocks.find((b) => b.kind === 'reasoning')!;
      expect(rb.id).toBe('pb:m-marg:0'); // 原夹注 part idx——钉住态跨重组续命
      expect((rb.payload as { text: string }).text).toBe('围栏前的思考');
    }
  });
});

/* ═══ 复合测高（max 语义 + 签名）═══ */

describe('measure 眉批复合块（P5）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    richStatsMock.mockClear();
    clearPaperMeasureCache();
  });

  function mdBlock(text: string, sidecar?: { text: string }): SourcedBlock {
    const msg = asstMsg(sidecar ? [reasoning(sidecar.text), textPart(text)] : [textPart(text)]);
    return translateMessage(msg, undefined)[0];
  }

  it('无眉批的 markdown：高度 = 正文（存量语义不变）', () => {
    expect(measureBlockHeight(mdBlock('单段'))).toBe(36);
  });

  it('有眉批：块高 = max(正文, 眉批 extent)——眉批更高时块长高（extent 含纵向 chrome）', () => {
    // 第 1 次 layout = 正文（36），第 2 次 = 夹注@侧栏（override 100）
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 100, lineCount: 2 });
    // 2026-09-19：noteH = top + 文字高 + 折叠钮行（旧实现只算文字高，真机实测
    // 眉批尾巴越出块高最多 218.75px）
    expect(measureBlockHeight(mdBlock('正文', { text: '一段很长很长的眉批' }))).toBe(
      100 + MARGINALIA_TOP + MARGINALIA_TOGGLE_H,
    );
  });

  it('夹注低于正文时取正文高（眉批恒容于块高——栈几何零变化）', () => {
    // 正文 36（第 1 次），眉批文字 override 10 → max(36, 10 + chrome 19) = 36
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 10, lineCount: 1 });
    expect(measureBlockHeight(mdBlock('正文', { text: '短眉批' }))).toBe(36);
    // 反例守边界：眉批文字 20 → 20 + chrome 19 = 39 > 正文 36 ⇒ 块随眉批长高
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 20, lineCount: 1 });
    expect(measureBlockHeight(mdBlock('正文', { text: '中眉批' }))).toBe(20 + MARGINALIA_TOP + MARGINALIA_TOGGLE_H);
  });

  it('眉批文本变化 → 测量签名失效重测（缓存正确性）', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '眉批一' });
    measureBlockHeightCached(b, cache);
    // payload 原位变更（流式/重组语义）
    (b.payload as { sidecar?: { text: string } }).sidecar = { text: '眉批二' };
    const hit = measureBlockHeightCached(b, cache);
    // 重测成功（mock 恒 36）——关键是不命中旧缓存也不抛；眉批侧 chrome 仍在
    expect(hit).toBe(36 + MARGINALIA_TOP + MARGINALIA_TOGGLE_H);
  });

  /* ═══ 眉批已钉出（2026-08-31 移出语义：`:sc` 快照钉在画布）═══ */

  it('眉批已钉出：眉批栏只剩占位一行（extent = top + 占位行实高，非折叠态一行夹注）', () => {
    // 正文很矮（20）→ max(20, top + 占位行 19) = 21
    layoutMock.mockReturnValueOnce({ height: 20, lineCount: 1 });
    expect(measureBlockHeight(mdBlock('短', { text: '长眉批' }), false, false, true)).toBe(
      Math.max(20, MARGINALIA_TOP + MARGINALIA_OUT_H),
    );
  });

  it('钉出/拔钉 → 测量签名失效重测（out 维度入签）', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '长眉批' });
    // 展开态：正文 1 次 + 夹注侧栏 1 次 layout
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 100, lineCount: 2 });
    expect(measureBlockHeightCached(b, cache, false, false, false)).toBe(100 + MARGINALIA_TOP + MARGINALIA_TOGGLE_H);
    // 钉出：签名变化必重测——夹注侧不再计高（占位一行）
    const calls = layoutMock.mock.calls.length;
    expect(measureBlockHeightCached(b, cache, false, false, true)).toBe(
      Math.max(36, MARGINALIA_TOP + MARGINALIA_OUT_H),
    );
    expect(layoutMock.mock.calls.length).toBe(calls + 1);
  });

  /* ═══ 眉批 extent 实测回写（2026-09-19：228px 窄列折行分歧被放大）═══ */

  it('眉批 extent 实测优先：块高 = max(块实测, 眉批实测 extent)——两个实测取 max', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '长眉批' });
    const key = observedKeyOf(b, false, true, false);
    // 块级实测（正文盒）68、眉批 extent 24014 ⇒ 块高取 24014（静态镜像只会给 ~23800）
    reportObservedBlockHeight(key, b.w, 68);
    reportObservedSidecarExtent(key, 24014);
    expect(observedSidecarExtentOf(key)).toBe(24014);
    expect(measureBlockHeightCached(b, cache, false, true, false)).toBe(24014);
    // 眉批钉出（换态）⇒ 旧 extent 作废，回落静态镜像
    expect(observedSidecarExtentOf(observedKeyOf(b, false, true, true))).toBeUndefined();
  });

  it('眉批 extent 变化 → 签名变化 → 重测采用新值（窄列折行随宽度/内容变）', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '长眉批' });
    const key = observedKeyOf(b, false, true, false);
    reportObservedBlockHeight(key, b.w, 68);
    reportObservedSidecarExtent(key, 500);
    expect(measureBlockHeightCached(b, cache, false, true, false)).toBe(500);
    reportObservedSidecarExtent(key, 300);
    expect(measureBlockHeightCached(b, cache, false, true, false)).toBe(300);
  });
});

/* ═══ 眉批纵向 chrome 的 CSS 端在场（镜像的另一半，2026-09-19）═══
 * 测高镜像只在 CSS 真的按同一批 token 取值时才成立：顶距不许再是裸字面量
 * `top: 2px`，两个按钮的行高不许再吃 UA 的 `line-height: normal`（引擎相关值，
 * 真机实测 10px 字得 13px 行——正是镜像要算的那一项）。 */

describe('眉批纵向 chrome：CSS 与 token 同源', () => {
  const CSS = readFileSync(join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
  const ruleOf = (sel: string): string => {
    const i = CSS.indexOf(sel);
    if (i < 0) throw new Error(`选择器缺席：${sel}`);
    return CSS.slice(i, CSS.indexOf('}', i));
  };

  it('.pp-marginalia 顶距走 token（禁裸 2px）', () => {
    const rule = ruleOf('.pp-marginalia {');
    expect(rule).toContain('top: var(--pp-ch-marginalia-top)');
    expect(rule).not.toMatch(/top:\s*2px/);
  });

  it('折叠钮 / 移出占位行高显式钉死（不吃 UA line-height: normal）', () => {
    expect(ruleOf('.pp-marginalia-toggle {')).toContain('line-height: var(--pp-ch-marginalia-toggleH)');
    expect(ruleOf('.pp-marginalia-toggle {')).toContain('margin: 0 0 var(--pp-ch-marginalia-toggleGap)');
    expect(ruleOf('.pp-marginalia-out {')).toContain('line-height: var(--pp-ch-marginalia-outLineH)');
    expect(ruleOf('.pp-marginalia-out {')).toContain('padding: var(--pp-ch-marginalia-outPadV) 0');
  });

  it('token 注入表带齐四项（改 token 即改 CSS 用值）', () => {
    const injected: Record<string, string> = {};
    injectPaperTokens({
      style: { setProperty: (k: string, v: string) => (injected[k] = v) },
    } as unknown as HTMLElement);
    expect(injected['--pp-ch-marginalia-top']).toBe(`${MARGINALIA_TOP}px`);
    expect(injected['--pp-ch-marginalia-toggleH']).toBe('13px');
    expect(injected['--pp-ch-marginalia-toggleGap']).toBe('4px');
    expect(injected['--pp-ch-marginalia-outLineH']).toBe('13px');
    expect(MARGINALIA_TOGGLE_H).toBe(13 + 4); // 钮行 + 钮下距
    expect(MARGINALIA_OUT_H).toBe(2 * 2 + 2 * 1 + 13); // 上下内距 + 上下规线 + 行盒
  });
});
