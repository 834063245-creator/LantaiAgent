// PromptShelf（ask_user 弹卡）行为测试 —
// 1. 开放式问题（无 options）：渲染文本输入 + 提交按钮，自定义回答可提交
// 2. 批量分页卡（AskBatchCard）：进度标签、单选自动翻页、末页整批提交、回看改答、取消
// 3. 多选、自定义回答、取消（null）、Enter 提交（单问 AskCard）
import { act, createElement, type ReactRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AskBatchPrompt,
  type AskPrompt,
  type AskQuestionItem,
  PromptShelf,
  type PromptShelfHandle,
} from '../../src/app/chat/PromptShelf';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let ref: ReactRef<PromptShelfHandle | null> = { current: null };

/** showAsk 内同步 setActive — 必须包 act 才能同步 flush 渲染 */
function showAsk(prompt: AskPrompt): Promise<string[] | null> {
  let p!: Promise<string[] | null>;
  act(() => {
    p = ref.current!.showAsk(prompt);
  });
  return p;
}

/** showAskBatch 同理 */
function showAskBatch(prompt: AskBatchPrompt): Promise<(string[] | null)[] | null> {
  let p!: Promise<(string[] | null)[] | null>;
  act(() => {
    p = ref.current!.showAskBatch(prompt);
  });
  return p;
}

/** 原生受控外 input 赋值（绕过 React value 拦截） */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(sel: string, idx = 0): Promise<void> {
  await act(async () => {
    container!.querySelectorAll<HTMLButtonElement>(sel)[idx].click();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  ref = { current: null };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(PromptShelf, { ref }));
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.useRealTimers();
});

const q = (over: Partial<AskPrompt> = {}): AskPrompt => ({
  type: 'ask',
  id: 'ask-1',
  question: '选一个方案',
  header: '方案',
  options: [
    { label: 'A 方案', description: 'a' },
    { label: 'B 方案', description: 'b' },
  ],
  multiSelect: false,
  ...over,
});

describe('PromptShelf — 开放式问题', () => {
  it('无 options：渲染输入框 + 提交按钮，输入后提交自定义回答', async () => {
    const p = showAsk(q({ id: 'open-1', options: [], question: '叫什么名字？' }));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    expect(input).toBeTruthy();
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交回答'))!;
    expect(submit).toBeTruthy();
    // 不应渲染选项列表
    expect(container!.querySelector('.prompt-shelf__options')).toBeNull();

    act(() => {
      setInputValue(input, '小蓝鲸');
    });
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual(['小蓝鲸']);
  });

  it('无 options：Enter 键提交', async () => {
    const p = showAsk(q({ id: 'open-2', options: [] }));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, '回车答案');
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(p).resolves.toEqual(['回车答案']);
  });
});

/** 批量多问构造器 */
const bq = (questions: AskQuestionItem[], over: Partial<AskBatchPrompt> = {}): AskBatchPrompt => ({
  type: 'ask-batch',
  id: 'batch-1',
  header: '批量',
  questions,
  ...over,
});

const questions2: AskQuestionItem[] = [
  {
    question: '选一个方案',
    header: '方案',
    options: [
      { label: 'A 方案', description: 'a' },
      { label: 'B 方案', description: 'b' },
    ],
  },
  {
    question: '第二个问题',
    options: [
      { label: '甲', description: 'x' },
      { label: '乙', description: 'y' },
    ],
  },
];

describe('PromptShelf — 批量分页卡（AskBatchCard）', () => {
  it('显示进度标签 问题 1/2；单选自动翻页；末页整批提交', async () => {
    const p = showAskBatch(bq(questions2));
    expect(container!.textContent).toContain('问题 1/2');
    expect(container!.textContent).toContain('选一个方案');

    // 第 1 题选 A → 自动翻第 2 页
    await click('.prompt-shelf__option', 0);
    expect(container!.textContent).toContain('问题 2/2');
    expect(container!.textContent).toContain('第二个问题');

    // 第 2 题选乙（末页停留，不自动提交）
    await click('.prompt-shelf__option', 1);
    expect(container!.querySelector('.prompt-shelf__card--batch')).toBeTruthy();

    // 点整批提交
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    expect(submit).toBeTruthy();
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['A 方案'], ['乙']]);
  });

  it('回看上一题改答后提交：改答覆盖旧答案', async () => {
    const p = showAskBatch(bq(questions2));
    await click('.prompt-shelf__option', 0); // 1/2 选 A → 翻页
    // 回看第 1 题
    const prevBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('上一题'))!;
    await act(async () => {
      prevBtn.click();
    });
    expect(container!.textContent).toContain('问题 1/2');
    // 改选 B
    await click('.prompt-shelf__option', 1);
    expect(container!.textContent).toContain('问题 2/2');
    // 提交
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['B 方案'], null]);
  });

  it('取消 → 整批 null', async () => {
    const p = showAskBatch(bq(questions2));
    await click('.prompt-shelf__dismiss');
    await expect(p).resolves.toBeNull();
  });

  it('多选题（multiSelect）：勾选后整批提交 label 数组', async () => {
    const p = showAskBatch(
      bq([
        {
          question: '挑几个',
          multiSelect: true,
          options: [
            { label: '一', description: '' },
            { label: '二', description: '' },
          ],
        },
      ]),
    );
    await click('.prompt-shelf__option', 0);
    await click('.prompt-shelf__option', 1);
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['一', '二']]);
  });

  it('开放式（无 options）：输入回答回车翻页', async () => {
    const p = showAskBatch(bq([{ question: '叫什么名字？' }, { question: '几岁？' }]));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, '小蓝鲸');
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    // 自动翻到第 2 题
    expect(container!.textContent).toContain('问题 2/2');
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['小蓝鲸'], null]);
  });
});

describe('PromptShelf — 单问卡片（AskCard）', () => {
  it('多选：点击多个后确认按钮提交', async () => {
    const p = showAsk(q({ id: 'm1', multiSelect: true }));
    await click('.prompt-shelf__option', 0);
    await click('.prompt-shelf__option', 1);
    const confirmBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    )!;
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn.click();
    });
    await expect(p).resolves.toEqual(['A 方案', 'B 方案']);
  });

  it('有选项时自定义输入仍可提交', async () => {
    const p = showAsk(q({ id: 'c1' }));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, '都不选，用我的');
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(p).resolves.toEqual(['都不选，用我的']);
  });

  it('取消按钮 → null', async () => {
    const p = showAsk(q({ id: 'x1' }));
    await click('.prompt-shelf__dismiss');
    await expect(p).resolves.toBeNull();
  });
});
