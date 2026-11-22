// @vitest-environment happy-dom

// PromptShelf（ask_user 弹卡）行为测试 —
// 形状真源 = app/chat/ask-card-contract（2026-11-22 答案两栏化后：每题一条
// { selected, custom }，单问 = 长度 1）。
//
// 覆盖的用户操作序列（按用户实际会做的事写，不按实现形状写）：
// 1. 开放式问题：打字 → 点「提交回答」/ 回车 → 文本送达（点按钮也送，不必猜 Enter）
// 2. 单问有选项：勾选 / 再点取消 / 多选勾两个 / 勾选后改打字（文本取代选择）/ 多选文本并存
// 3. 批量分页：不再自动翻页；再点已选项可取消；逐题草稿不串字；末页整批提交；
//    跳过此题；自由文本点提交也送达（本次修的两个用户症状）
// 4. IME：组合中的 Enter 不提交（keyCode 229 / isComposing）
// 5. 主输入作答 answerActiveText：'submitted' / 'filled' / 权限卡 false
// 6. dismissByOwner 按卷杀卡 / 重复 label 分选 / 取消 → null
import { act, createElement, type ReactRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AskBatchPrompt,
  AskPrompt,
  AskQuestionItem,
  AskUserAnswer,
  PromptShelfHandle,
} from '../../src/app/chat/ask-card-contract';
import { PromptShelf } from '../../src/plugins/builtin/ask-cards/PromptShelf';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let ref: ReactRef<PromptShelfHandle | null> = { current: null };

/** showAsk 内同步 setActive — 必须包 act 才能同步 flush 渲染 */
function showAsk(prompt: AskPrompt): Promise<AskUserAnswer[] | null> {
  let p!: Promise<AskUserAnswer[] | null>;
  act(() => {
    p = ref.current!.showAsk(prompt);
  });
  return p;
}

function showAskBatch(prompt: AskBatchPrompt): Promise<AskUserAnswer[] | null> {
  let p!: Promise<AskUserAnswer[] | null>;
  act(() => {
    p = ref.current!.showAskBatch(prompt);
  });
  return p;
}

/** 原生受控外赋值（绕过 React value 拦截；textarea 与 input 各用各的原型 setter） */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function textarea(): HTMLTextAreaElement {
  return container!.querySelector<HTMLTextAreaElement>('.prompt-shelf__custom-input')!;
}

function buttonStartingWith(text: string): HTMLButtonElement {
  // 翻页钮带箭头（「← 上一题」），所以是包含匹配；提交钮用「提交」前缀即可区分「跳过此题」
  const hit = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(text),
  );
  if (!hit) throw new Error(`找不到按钮：${text}`);
  return hit;
}

async function click(sel: string, idx = 0): Promise<void> {
  await act(async () => {
    container!.querySelectorAll<HTMLButtonElement>(sel)[idx].click();
  });
}

async function clickButton(text: string): Promise<void> {
  await act(async () => {
    buttonStartingWith(text).click();
  });
}

function selectedCount(): number {
  return container!.querySelectorAll('.prompt-shelf__option--on').length;
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

describe('PromptShelf — 单问：自由文本', () => {
  it('开放式（无 options）：打字后点「提交回答」⇒ 文本送达', async () => {
    const p = showAsk(q({ id: 'open-1', options: [], question: '叫什么名字？' }));
    expect(container!.querySelector('.prompt-shelf__options')).toBeNull();
    act(() => typeInto(textarea(), '小蓝鲸'));
    await clickButton('提交回答');
    await expect(p).resolves.toEqual([{ selected: [], custom: '小蓝鲸' }]);
  });

  it('开放式：Enter 也提交（IME 组合中的 Enter 不算）', async () => {
    const p = showAsk(q({ id: 'open-2', options: [] }));
    act(() => typeInto(textarea(), '回车答案'));
    // 组合中的 Enter（中文选词上屏）不得提交/翻页
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(p).resolves.toEqual([{ selected: [], custom: '回车答案' }]);
  });

  it('空输入 ⇒ 提交钮 disabled（不产生空答案）', () => {
    showAsk(q({ id: 'open-3', options: [] }));
    expect(buttonStartingWith('提交回答').disabled).toBe(true);
  });
});

describe('PromptShelf — 单问：选项', () => {
  it('单选：勾选 → 提交 ⇒ label；再点同一项 ⇒ 取消勾选（提交钮转 disabled）', async () => {
    const p = showAsk(q({ id: 's1' }));
    await click('.prompt-shelf__option', 0);
    expect(selectedCount()).toBe(1);
    await click('.prompt-shelf__option', 0);
    expect(selectedCount()).toBe(0);
    expect(buttonStartingWith('提交回答').disabled).toBe(true);
    await click('.prompt-shelf__option', 1);
    await clickButton('提交回答');
    await expect(p).resolves.toEqual([{ selected: ['B 方案'] }]);
  });

  it('多选：勾两个 → 再点其中一个取消 → 提交只剩另一个', async () => {
    const p = showAsk(q({ id: 'm1', multiSelect: true }));
    await click('.prompt-shelf__option', 0);
    await click('.prompt-shelf__option', 1);
    expect(selectedCount()).toBe(2);
    await click('.prompt-shelf__option', 1);
    expect(selectedCount()).toBe(1);
    await clickButton('提交回答');
    await expect(p).resolves.toEqual([{ selected: ['A 方案'] }]);
  });

  // 症状 1 的单问入口：勾了选项再打字，点「确认」旧实现只发 label，文本静默消失
  it('单选：勾选后改打字 ⇒ 文本取代选择（选项取消勾选），提交带文本', async () => {
    const p = showAsk(q({ id: 'c1' }));
    await click('.prompt-shelf__option', 0);
    act(() => typeInto(textarea(), '都不选，用我的'));
    expect(selectedCount()).toBe(0);
    expect(container!.textContent).toContain('已填写自定义回答');
    await clickButton('提交回答');
    await expect(p).resolves.toEqual([{ selected: [], custom: '都不选，用我的' }]);
  });

  it('多选：勾选 + 文本并存（文本是追加的一项，不吞掉选项）', async () => {
    const p = showAsk(q({ id: 'c2', multiSelect: true }));
    await click('.prompt-shelf__option', 0);
    await click('.prompt-shelf__option', 1);
    act(() => typeInto(textarea(), '另加一条'));
    expect(selectedCount()).toBe(2);
    await clickButton('提交回答');
    await expect(p).resolves.toEqual([{ selected: ['A 方案', 'B 方案'], custom: '另加一条' }]);
  });

  it('数字快选只选中、Enter 提交；组合键数字不快选', async () => {
    const p = showAsk(q({ id: 'k1' }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
    });
    expect(selectedCount()).toBe(0);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    });
    expect(selectedCount()).toBe(1);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(p).resolves.toEqual([{ selected: ['A 方案'] }]);
  });

  it('取消按钮 / Esc ⇒ null', async () => {
    const p = showAsk(q({ id: 'x1' }));
    await click('.prompt-shelf__dismiss');
    await expect(p).resolves.toBeNull();
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

describe('PromptShelf — 批量分页', () => {
  it('显示 问 1/2；点选项不再自动翻页（给反悔留时间）；「下一题」才翻', async () => {
    showAskBatch(bq(questions2));
    expect(container!.textContent).toContain('问 1/2');
    expect(container!.textContent).toContain('选一个方案');
    await click('.prompt-shelf__option', 0);
    expect(container!.textContent).toContain('问 1/2'); // 不再自动跳页
    await clickButton('下一题');
    expect(container!.textContent).toContain('问 2/2');
    expect(container!.textContent).toContain('第二个问题');
  });

  // 症状 2：旧批量卡单选恒覆盖，再点不取消
  it('批量单选：再点已选项 = 取消勾选（进度点回到未答）', async () => {
    showAskBatch(bq(questions2));
    await click('.prompt-shelf__option', 0);
    expect(selectedCount()).toBe(1);
    await click('.prompt-shelf__option', 0);
    expect(selectedCount()).toBe(0);
    expect(container!.textContent).toContain('已答 0/2');
  });

  // 症状 1 的主因：文本只活在非受控 input 里，点提交时答案里没有它
  it('批量：输入自由文本后点「提交」⇒ 文本随答案送达（不必先回车）', async () => {
    const p = showAskBatch(bq(questions2));
    act(() => typeInto(textarea(), '我自己的答案'));
    expect(container!.textContent).toContain('已答 1/2');
    await clickButton('提交');
    await expect(p).resolves.toEqual([{ selected: [], custom: '我自己的答案' }, { selected: [] }]);
  });

  it('批量：逐题草稿不串字（回看第 1 题仍无文本，第 2 题的文本还在）', async () => {
    showAskBatch(bq(questions2));
    await click('.prompt-shelf__option', 0); // 第 1 题选 A
    await clickButton('下一题');
    act(() => typeInto(textarea(), '第二题的说明'));
    await clickButton('上一题');
    expect(textarea().value).toBe(''); // 第 1 题没有文本
    expect(selectedCount()).toBe(1); // 选项仍在
    await clickButton('下一题');
    expect(textarea().value).toBe('第二题的说明');
  });

  it('末页整批提交：选项 + 文本按题对齐；未答/跳过 = 空', async () => {
    const p = showAskBatch(bq(questions2));
    await click('.prompt-shelf__option', 0);
    await clickButton('下一题');
    await click('.prompt-shelf__option', 1);
    await clickButton('提交');
    await expect(p).resolves.toEqual([{ selected: ['A 方案'] }, { selected: ['乙'] }]);
  });

  it('跳过此题：清空当前题并前进；末页跳过后直接交整批', async () => {
    const p = showAskBatch(bq(questions2));
    act(() => typeInto(textarea(), '会被跳过清掉'));
    await clickButton('跳过此题');
    expect(container!.textContent).toContain('问 2/2');
    await clickButton('跳过此题');
    await expect(p).resolves.toEqual([{ selected: [] }, { selected: [] }]);
  });

  it('取消整批 ⇒ null', async () => {
    const p = showAskBatch(bq(questions2));
    await click('.prompt-shelf__dismiss');
    await expect(p).resolves.toBeNull();
  });

  it('多选：勾两个 → 取消一个 → 整批提交只剩一个', async () => {
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
    await click('.prompt-shelf__option', 1);
    await clickButton('提交');
    await expect(p).resolves.toEqual([{ selected: ['一'] }]);
  });

  it('重复 label 两枚选项可分别选中（idx 存储，不再 findIndex 撞第一枚）', async () => {
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
    expect(selectedCount()).toBe(2);
    await clickButton('提交');
    await expect(p).resolves.toEqual([{ selected: ['同名', '同名'] }]);
  });
});

describe('PromptShelf — 主输入 TextAnswer 位移', () => {
  it('dismissByOwner 按卷杀卡：停 A 卷只收 A 卷的卡，B 卷的照常可答', async () => {
    const pA = showAsk(q({ id: 'oa', ownerSid: 1 }));
    const pB = showAsk(q({ id: 'ob', ownerSid: 2 }));
    act(() => {
      ref.current!.dismissByOwner(1);
    });
    await expect(pA).resolves.toBeNull();
    let answered = false;
    void pB.then(() => {
      answered = true;
    });
    expect(answered).toBe(false);
    act(() => {
      expect(ref.current!.answerActiveText('B 卷自定义回答')).toBe('submitted');
    });
    await expect(pB).resolves.toEqual([{ selected: [], custom: 'B 卷自定义回答' }]);
  });

  it('answerActiveText：单问卡整卡提交', async () => {
    const p = showAsk(q({ id: 's2' }));
    act(() => {
      expect(ref.current!.answerActiveText('主输入里的话')).toBe('submitted');
    });
    await expect(p).resolves.toEqual([{ selected: [], custom: '主输入里的话' }]);
  });

  it('answerActiveText：批量中间页 = 填进当前题并翻页（filled，不谎称已提交）', async () => {
    const p = showAskBatch(bq([{ question: '第一问' }, { question: '第二问' }]));
    act(() => {
      expect(ref.current!.answerActiveText('答一')).toBe('filled');
    });
    expect(container!.textContent).toContain('问 2/2');
    // 末页再答 = 整批提交
    act(() => {
      expect(ref.current!.answerActiveText('答二')).toBe('submitted');
    });
    await expect(p).resolves.toEqual([
      { selected: [], custom: '答一' },
      { selected: [], custom: '答二' },
    ]);
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
});
