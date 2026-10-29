// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拟策卡终态（2026-10-29，用户报「批准/拒绝等操作后的 plan 卡片状态会回到待批准」）。
//
// 病灶：终态只住在 PlanBody 的本地 useState（done）——纸壳的块是**虚拟化卸挂**的
// （滚出视口再滚回）、切卷再摊开、会话恢复重建都会让组件重挂载，done 归零 ⇒ 操作钮
// 原样长回来，卡面把「已批准」说回「待批准」。
//
// 修法：决议写回**活引用 part**（status/selectedLabel/feedback，纯 JSON 随卷持久化），
// 渲染一律按 part 判终态。本文件把「卸载再挂载仍是终态」钉成行为断言——只认本地态
// 的实现在 remount 那几例必红。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translateMessages } from '../src/paper/translate';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';
import type { AssistantMessage, PlanPart } from '../src/ui/message-model';

/** 一条只含拟策 part 的助手消息（part 对象在重挂载间保持同一身份——活引用语义）。 */
function planMessage(overrides: Partial<PlanPart> = {}): { msg: AssistantMessage; part: PlanPart } {
  const part: PlanPart = {
    type: 'plan',
    planId: 'plan-1',
    planFilePath: '/tmp/plan.md',
    content: '1. 先读现有实现\n2. 再按最小改动落地',
    status: 'pending',
    _callback: vi.fn(() => true),
    ...overrides,
  };
  const msg: AssistantMessage = {
    role: 'assistant',
    _id: 'm1',
    status: 'done',
    respondingTo: 'm0',
    parts: [part],
  };
  return { msg, part };
}

/** 每次挂载都重新转译——与纸壳「重挂载/重译后重新拿 block」同形。 */
function planBlock(msg: AssistantMessage) {
  const block = translateMessages([msg]).find((b) => b.kind === 'plan');
  if (!block) throw new Error('plan 块未产出');
  return block;
}

const PlanRenderer = builtinRendererDefs().find((d) => d.kind === 'plan')?.component;
if (!PlanRenderer) throw new Error('缺 plan 渲染器');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function mount(msg: AssistantMessage): void {
  root = createRoot(container as HTMLDivElement);
  act(() => root?.render(createElement(PlanRenderer, { block: planBlock(msg) })));
}

/** 卸载再挂载 = 虚拟化卸挂 / 切卷重开 / 会话重建重挂。 */
function remount(msg: AssistantMessage): void {
  act(() => root?.unmount());
  root = null;
  mount(msg);
}

const buttons = (): string[] =>
  Array.from(container?.querySelectorAll('button') ?? []).map((b) => (b.textContent ?? '').trim());
const cardText = (): string => container?.textContent ?? '';

function clickButton(label: string): void {
  const btn = Array.from(container?.querySelectorAll('button') ?? []).find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!btn) throw new Error(`找不到按钮：${label}（现有：${buttons().join('/')}）`);
  act(() => (btn as HTMLButtonElement).click());
}

/** 方案选项按钮（文案 = 方案名 + 描述，故按 .pp-pc-option-label 精确匹配）。 */
function clickOption(label: string): void {
  const btn = Array.from(container?.querySelectorAll('.pp-pc-option') ?? []).find(
    (b) => (b.querySelector('.pp-pc-option-label')?.textContent ?? '').trim() === label,
  );
  if (!btn) throw new Error(`找不到方案：${label}`);
  act(() => (btn as HTMLButtonElement).click());
}

describe('拟策卡终态 — 决议写回 part，重挂载不丢', () => {
  it('批准：part.status 写回 approved，卡面转终态行、操作钮退场', () => {
    const { msg, part } = planMessage();
    mount(msg);
    expect(buttons()).toContain('批准');
    clickButton('批准');
    expect(part.status).toBe('approved');
    expect(cardText()).toContain('已批准');
    expect(buttons()).not.toContain('批准');
  });

  it('批准后卸载重挂（虚拟化卸挂/切卷重开）：仍是终态，不长回待批准', () => {
    const { msg, part } = planMessage();
    mount(msg);
    clickButton('批准');
    remount(msg);
    expect(part.status).toBe('approved');
    expect(cardText()).toContain('已批准');
    expect(buttons()).not.toContain('批准');
    expect(buttons()).not.toContain('拒绝');
  });

  it('拒绝：part.status 写回 rejected，重挂后仍是拒绝终态', () => {
    const { msg, part } = planMessage();
    mount(msg);
    clickButton('拒绝');
    expect(part.status).toBe('rejected');
    remount(msg);
    expect(cardText()).toContain('已拒绝此拟策');
    expect(buttons()).not.toContain('批准');
  });

  it('修改：意见写回 part，重挂后仍是「已提交修改意见」', () => {
    const { msg, part } = planMessage();
    mount(msg);
    clickButton('修改');
    const ta = container?.querySelector('textarea');
    if (!ta) throw new Error('缺修改意见输入框');
    act(() => {
      // React 受控输入：走原生 setter 才会触发 onChange
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(ta, '第三步再补测试');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickButton('提交');
    expect(part.status).toBe('revise');
    expect(part.feedback).toBe('第三步再补测试');
    remount(msg);
    expect(cardText()).toContain('已提交修改意见');
    expect(cardText()).toContain('第三步再补测试');
    expect(buttons()).not.toContain('批准');
  });

  it('多方案：选定方案名进终态行，重挂后仍标出选中的那一案', () => {
    const { msg, part } = planMessage({
      options: [
        { label: '甲案', description: '全量重写' },
        { label: '乙案', description: '最小改动' },
      ],
    });
    mount(msg);
    clickOption('乙案');
    clickButton('批准');
    expect(part.selectedLabel).toBe('乙案');
    remount(msg);
    expect(cardText()).toContain('已批准 · 选定方案：乙案');
    const on = container?.querySelector('.pp-pc-option--on');
    expect((on?.textContent ?? '').includes('乙案')).toBe(true);
  });

  it('历史卡（无审批回调）按 part.status 显示终态，不出操作钮', () => {
    const { msg } = planMessage({ status: 'approved', selectedLabel: '乙案', _callback: undefined });
    mount(msg);
    expect(cardText()).toContain('已批准 · 选定方案：乙案');
    expect(buttons()).toEqual([]);
  });

  it('审批窗口已过（回调回 false）：不写终态，卡面如实说「未生效」', () => {
    const { msg, part } = planMessage({ _callback: vi.fn(() => false) });
    mount(msg);
    clickButton('批准');
    expect(part.status).toBe('pending'); // 决议没被采纳，不许替 agent 记账
    expect(cardText()).toContain('审批已过期，此决定未生效');
    expect(cardText()).not.toContain('已批准');
  });
});
