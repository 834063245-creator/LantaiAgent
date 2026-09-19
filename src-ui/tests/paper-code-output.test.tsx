// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 程文（code）输出换代（2026-09-19，用户报「输出栏一点没处理，跟乱码一样」）
// ——信封分段 + 完成值解转义的渲染/测量同源守护。
//
// 病灶（真机 69 个存盘 code_execution 结果实测）：输出栏整段直出——信封行
// `── logs ──` 当正文渲染、日志与完成值无分界；完成值又是二次编码的字符串
// （真换行变字面 `\n`），31/69 个样本含 >800 字符单行，最长 14711 字符挤在
// 2 个物理行里。
// 断言按用户可见结果写：展开/折叠一张程文卡，看到的是分段的、可读的内容。

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

import { builtinRendererDefs } from '../src/app/paper/builtin-renderers';
import type { SourcedBlock } from '../src/paper/block-model';
import { createBlock } from '../src/paper/block-model';
import { inkSourcesFor, measureBlockHeight } from '../src/paper/measure';
import { codeDisplay, codeSections } from '../src/paper/tool-text';

/** 真机形态的目录清单（完成值是字符串 → 旧行为整段塌成一行字面转义）。 */
const LS = 'drwxr-xr-x agents\n-rw-r--r-- 1 x 37882346 audit.jsonl';

function codeBlock(payload: Record<string, unknown>): SourcedBlock {
  return {
    ...createBlock(
      'code',
      { toolId: 't', description: '盘点', code: 'return out;', status: 'done', ...payload } as never,
      { messageId: 'm', part: null },
    ),
    w: 640,
  };
}

describe('codeSections：信封 → 段', () => {
  it('日志 + 完成值两段，信封行不进正文（段头文案即语义）', () => {
    const secs = codeSections(`── logs ──\nhi\n── result ──\n42`);
    expect(secs.map((s) => [s.kind, s.label, s.raw])).toEqual([
      ['logs', '日志', 'hi'],
      ['result', '完成值', '42'],
    ]);
  });

  it('失败信封：分类进段头（kind=exception → 错误 · exception），消息成段体', () => {
    const out = `[code_execution 失败] kind=exception\n── logs ──\nboom-log\n── code run failed (exception) ──\nError: nope`;
    const secs = codeSections(out);
    expect(secs.map((s) => [s.kind, s.label])).toEqual([
      ['logs', '日志'],
      ['error', '错误 · exception'],
    ]);
    expect(secs[1].raw).toBe('Error: nope');
  });

  it('无信封载荷（旧卷 / 无输出）整体落一个「输出」段——老卡零回归', () => {
    expect(codeSections('(程序完成，无输出)')).toEqual([{ kind: 'out', label: '输出', raw: '(程序完成，无输出)' }]);
    expect(codeSections('裸文本一行')).toEqual([{ kind: 'out', label: '输出', raw: '裸文本一行' }]);
  });

  it('空白段不产出（不支空段头）；空载荷无段', () => {
    expect(codeSections('── logs ──\n   \n── result ──\n  \n')).toEqual([]);
    expect(codeSections(undefined)).toEqual([]);
  });

  it('完成值是二次编码的字符串：段展示解出真换行（纸面不再是字面 \\n）', () => {
    const raw = `── result ──\n${JSON.stringify(LS)}`;
    expect(raw).toContain('\\n'); // 存盘原文：转义形态
    const secs = codeDisplay(raw);
    expect(secs).toHaveLength(1);
    expect(secs[0].display.text).toBe(LS);
    expect(secs[0].display.text.split('\n')).toHaveLength(2);
  });
});

describe('渲染面 — 段头 / 折叠态 / 结构', () => {
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

  const renderCode = (payload: Record<string, unknown>, folded = false) => {
    const def = builtinRendererDefs().find((d) => d.kind === 'code');
    expect(def, '内置 code 渲染器存在').toBeDefined();
    act(() => {
      root?.render(createElement(def!.component, { block: codeBlock(payload), folded }));
    });
  };

  it('日志/完成值各有段头，完成值段走 pp-sec--result（石青：答案段）', () => {
    renderCode({ output: `── logs ──\nhi\n── result ──\n{"count":2}` });
    expect([...container!.querySelectorAll('.pp-sec-label')].map((el) => el.textContent)).toEqual(['日志', '完成值']);
    expect(container!.querySelector('.pp-sec--result')).not.toBeNull();
    expect(container!.querySelector('.pp-sec--result .pp-out')?.textContent).toContain('count: 2');
  });

  it('失败卡：错误段走 pp-sec--err + pp-out--err，段头带分类', () => {
    renderCode({ output: `[code_execution 失败] kind=exception\n── code run failed (exception) ──\nError: nope` });
    expect([...container!.querySelectorAll('.pp-sec-label')].map((el) => el.textContent)).toEqual(['错误 · exception']);
    expect(container!.querySelector('.pp-out--err')?.textContent).toContain('Error: nope');
  });

  it('折叠态：收程序体、留输出段（执行结果一眼可见）；展开态程序体在正文里', () => {
    renderCode({ output: `── result ──\n${JSON.stringify(LS)}` }, true);
    expect(container!.querySelector('.pp-code-src')).toBeNull();
    expect(container!.querySelector('.pp-sec--result')?.textContent).toContain('audit.jsonl');
    renderCode({ output: `── result ──\n${JSON.stringify(LS)}` }, false);
    expect(container!.querySelector('.pp-code-src')?.textContent).toContain('return out;');
  });

  it('旧卷载荷（无信封）仍渲染为「输出」段', () => {
    renderCode({ output: '(程序完成，无输出)' });
    expect([...container!.querySelectorAll('.pp-sec-label')].map((el) => el.textContent)).toEqual(['输出']);
  });
});

describe('测量镜像 — 段序/段高与渲染同源', () => {
  it('段数进高度：单段 < 双段，且随内容增长', () => {
    const one = codeBlock({ output: '── result ──\nok' });
    const two = codeBlock({ output: '── logs ──\nhi\n── result ──\nok' });
    expect(measureBlockHeight(two)).toBeGreaterThan(measureBlockHeight(one));
  });

  it('墨迹源 = 程序体 + 逐段（y 递增；段数与 codeDisplay 一致）', () => {
    const block = codeBlock({ output: '── logs ──\nhi\n── result ──\nok' });
    const sources = inkSourcesFor(block, false);
    expect(sources).toHaveLength(3); // 程序体 + 日志段 + 完成值段
    expect(sources[1].y).toBeLessThan(sources[2].y);
  });

  it('测量消费解转义后的文本（不是字面 \\n 的原始串）', () => {
    prepareMock.mockClear();
    measureBlockHeight(codeBlock({ output: `── result ──\n${JSON.stringify(LS)}` }));
    const seen = prepareMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(seen).toContain('audit.jsonl');
    expect(seen).not.toContain('\\n');
  });
});
