// PromptShelf（ask_user 弹卡）行为测试 —
// 1. 开放式问题（无 options）：渲染文本输入 + 提交按钮，自定义回答可提交
// 2. 批量分页卡（AskBatchCard）：进度标签、单选自动翻页、末页整批提交、回看改答、取消
// 3. 多选、自定义回答、取消（null）、Enter 提交（单问 AskCard）
// 4. 2026-09-10 用户侧完备化：单选显式确认（240ms 自动确认退役）、数字快选
//    只选中、Enter 确认、dismissByOwner 按卷杀卡、answerActiveText 主输入作答、
//    批量重复 label 分选（idx 存储）
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

const q = (over: Partial<AskPrompt> & { ownerSid?: number | null } = {}): AskPrompt & { ownerSid?: number | null } => ({
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
    // 提交钮改为「有输入才出现」（2026-09-16 断链修复：原先只有开放式问题
    // 渲染它、且常在未输入时就显示；现统一为输入驱动——避免空提交与
    // 「有选项时无钮可点」的双向病灶）
    act(() => {
      setInputValue(input, '小蓝鲸');
    });
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交回答'))!;
    expect(submit).toBeTruthy();
    // 不应渲染选项列表
    expect(container!.querySelector('.prompt-shelf__options')).toBeNull();

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
  it('显示进度标签 问 1/2；单选自动翻页；末页整批提交', async () => {
    const p = showAskBatch(bq(questions2));
    expect(container!.textContent).toContain('问 1/2');
    expect(container!.textContent).toContain('选一个方案');

    // 第 1 题选 A → 自动翻第 2 页
    await click('.prompt-shelf__option', 0);
    expect(container!.textContent).toContain('问 2/2');
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
    expect(container!.textContent).toContain('问 1/2');
    // 改选 B
    await click('.prompt-shelf__option', 1);
    expect(container!.textContent).toContain('问 2/2');
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
    expect(container!.textContent).toContain('问 2/2');
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

  // ── 2026-09-16 断链修复：有选项时也必须有「可点的」自定义提交键 ──
  // 此前「提交回答」钮只在开放式（无选项）时渲染，有选项卡上用户打字后
  // **没有任何按钮可点**（只能猜 Enter）——既有测试只走 Enter 路径故未暴露。
  it('有选项 + 输入文字 ⇒ 出现「提交回答」钮（此前缺失）', async () => {
    const p = showAsk(q({ id: 'c2' }));
    // 未输入时无提交钮（不与「确认选择」并排造成歧义）
    expect(Array.from(container!.querySelectorAll('button')).some((b) => b.textContent?.includes('提交回答'))).toBe(
      false,
    );
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, '我自己的答案');
    });
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交回答'));
    expect(submit, '有选项时输入文字后必须出现可点的提交钮').toBeTruthy();
    await act(async () => {
      submit!.click();
    });
    await expect(p).resolves.toEqual(['我自己的答案']);
  });

  it('开放式（无选项）+ 输入文字 ⇒ 同样出现「提交回答」钮且可点', async () => {
    const p = showAsk(q({ id: 'c3', options: [] }));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, '开放式答案');
    });
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交回答'));
    expect(submit).toBeTruthy();
    await act(async () => {
      submit!.click();
    });
    await expect(p).resolves.toEqual(['开放式答案']);
  });

  it('清空输入 ⇒ 提交钮收回（不残留可点空提交）', async () => {
    showAsk(q({ id: 'c4' }));
    const input = container!.querySelector<HTMLInputElement>('.prompt-shelf__custom-input')!;
    act(() => {
      setInputValue(input, 'x');
    });
    expect(Array.from(container!.querySelectorAll('button')).some((b) => b.textContent?.includes('提交回答'))).toBe(
      true,
    );
    act(() => {
      setInputValue(input, '');
    });
    expect(Array.from(container!.querySelectorAll('button')).some((b) => b.textContent?.includes('提交回答'))).toBe(
      false,
    );
  });

  it('取消按钮 → null', async () => {
    const p = showAsk(q({ id: 'x1' }));
    await click('.prompt-shelf__dismiss');
    await expect(p).resolves.toBeNull();
  });
});

/** document 级 keydown 快捷键（数字快选/Enter 确认） */
function key(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('PromptShelf — 2026-09-10 用户侧完备化', () => {
  it('单选：点击只选中不自动提交（240ms 自动确认退役）；确认钮显式提交', async () => {
    const p = showAsk(q({ id: 's1' }));
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await click('.prompt-shelf__option', 0);
    // 时间流逝后仍不 resolve——自动确认路径已死
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(settled).toBe(false);
    expect(container!.querySelector('.prompt-shelf__confirm')).toBeTruthy();
    await click('.prompt-shelf__confirm');
    await expect(p).resolves.toEqual(['A 方案']);
  });

  it('单选：再点同一项 = 取消选中（确认钮消失）', async () => {
    showAsk(q({ id: 's2' }));
    await click('.prompt-shelf__option', 0);
    expect(container!.querySelectorAll('.prompt-shelf__option--on').length).toBe(1);
    await click('.prompt-shelf__option', 0);
    expect(container!.querySelectorAll('.prompt-shelf__option--on').length).toBe(0);
    expect(container!.querySelector('.prompt-shelf__confirm')).toBeNull();
  });

  it('数字快选只选中；Enter（焦点不在输入/按钮）提交已选项', async () => {
    const p = showAsk(q({ id: 'k1' }));
    key('1'); // 选中第 1 项
    expect(container!.querySelectorAll('.prompt-shelf__option--on').length).toBe(1);
    key('Enter'); // 提交
    await expect(p).resolves.toEqual(['A 方案']);
  });

  it('组合键数字不快选（Ctrl+1 切标签页等不误答）', async () => {
    showAsk(q({ id: 'k2' }));
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(container!.querySelectorAll('.prompt-shelf__option--on').length).toBe(0);
  });

  it('dismissByOwner 按卷杀卡：停 A 卷只收 A 卷的卡，B 卷的照常可答', async () => {
    const pA = showAsk(q({ id: 'oa', ownerSid: 1 }));
    const pB = showAsk(q({ id: 'ob', ownerSid: 2 }));
    act(() => {
      ref.current!.dismissByOwner(1);
    });
    await expect(pA).resolves.toBeNull(); // A 卷的卡按取消收口
    // B 卷的卡激活且可答
    let answered = false;
    void pB.then(() => {
      answered = true;
    });
    expect(answered).toBe(false);
    act(() => {
      expect(ref.current!.answerActiveText('B 卷自定义回答')).toBe(true);
    });
    await expect(pB).resolves.toEqual(['B 卷自定义回答']);
  });

  it('answerActiveText：权限卡在头不吃文本作答（返回 false）', async () => {
    let permP!: Promise<{ allow: boolean; remember: boolean }>;
    act(() => {
      permP = ref.current!.showPermission({ type: 'permission', id: 'pp', toolName: 't', reason: 'r', subject: 's' });
    });
    act(() => {
      expect(ref.current!.answerActiveText('yes')).toBe(false);
    });
    await click('.prompt-shelf__perm-btn--deny');
    await expect(permP).resolves.toEqual({ allow: false, remember: false });
  });

  it('批量：主输入作答填当前页并翻页', async () => {
    const p = showAskBatch(bq([{ question: '第一问' }, { question: '第二问' }]));
    act(() => {
      expect(ref.current!.answerActiveText('答一')).toBe(true);
    });
    expect(container!.textContent).toContain('问 2/2');
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['答一'], null]);
  });

  it('批量：重复 label 两枚选项可分别选中（idx 存储，不再 findIndex 撞第一枚）', async () => {
    const p = showAskBatch(
      bq([
        {
          question: '同名片',
          multiSelect: true,
          options: [
            { label: '同名', description: '甲' },
            { label: '同名', description: '乙' },
          ],
        },
      ]),
    );
    await click('.prompt-shelf__option', 0);
    await click('.prompt-shelf__option', 1);
    expect(container!.querySelectorAll('.prompt-shelf__option--on').length).toBe(2);
    const submit = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交'))!;
    await act(async () => {
      submit.click();
    });
    await expect(p).resolves.toEqual([['同名', '同名']]);
  });
});
