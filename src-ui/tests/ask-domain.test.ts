// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask_user 工具侧的答案编码（2026-11-22 答案两栏化）——
// 卡面交上来的是每题一条 { selected, custom }；工具必须把它**无损**折成模型可见
// 的旧形状（单选/开放 = 字符串，多选 = 字符串数组，未答 = null），否则文本会
// 在最后一步再次消失（用户报的「文本没发给 agent」就是这一路的某一环）。
import { describe, expect, it } from 'vitest';
import type { AskUserAnswer, AskUserRequest } from '../src/agent/tool';
import { createAskUserTools } from '../src/plugins/builtin/ask-domain/ask-tools';

/** 替身 UI：记录请求，按给定答案回调。 */
function fakeUi(answer: AskUserAnswer[] | null): {
  ui: { askUser: (req: AskUserRequest) => void };
  calls: AskUserRequest[];
} {
  const calls: AskUserRequest[] = [];
  return {
    calls,
    ui: {
      askUser: (req) => {
        calls.push(req);
        req.callback(answer);
      },
    },
  };
}

async function run(args: Record<string, unknown>, answer: AskUserAnswer[] | null): Promise<Record<string, unknown>> {
  const { ui, calls } = fakeUi(answer);
  const tool = createAskUserTools(ui)[0];
  const out = await tool.execute(args);
  expect(calls).toHaveLength(1);
  return JSON.parse(out) as Record<string, unknown>;
}

describe('ask_user 答案编码', () => {
  it('开放式单问：自写文本 → answer = 文本', async () => {
    const out = await run({ question: '叫什么' }, [{ selected: [], custom: '小蓝鲸' }]);
    expect(out).toEqual({ answer: '小蓝鲸' });
  });

  it('单选：选中的 label → answer = label', async () => {
    const out = await run({ question: '选', options: [{ label: 'A', description: '' }] }, [{ selected: ['A'] }]);
    expect(out).toEqual({ answer: 'A' });
  });

  it('单选：文本取代选择（即便同时传来 selected 也不丢文本）', async () => {
    const out = await run({ question: '选', options: [{ label: 'A', description: '' }] }, [
      { selected: ['A'], custom: '还是用我的' },
    ]);
    expect(out).toEqual({ answer: '还是用我的' });
  });

  it('多选：选项 + 文本并存 → answers = 选项 label 数组 + 文本', async () => {
    const out = await run(
      {
        question: '挑',
        multiSelect: true,
        options: [
          { label: '一', description: '' },
          { label: '二', description: '' },
        ],
      },
      [{ selected: ['一', '二'], custom: '另加一条' }],
    );
    expect(out).toEqual({ answers: ['一', '二', '另加一条'] });
  });

  it('批量：按 questions 对齐，跳过/未答 = null', async () => {
    const out = await run(
      {
        questions: [
          { question: 'q1', options: [{ label: 'A', description: '' }] },
          { question: 'q2' },
          { question: 'q3', multiSelect: true, options: [{ label: 'x', description: '' }] },
        ],
      },
      [{ selected: ['A'] }, { selected: [], custom: '自答' }, { selected: ['x'], custom: '再补' }],
    );
    expect(out).toEqual({ answers: ['A', '自答', ['x', '再补']] });
  });

  it('用户取消 ⇒ answer = null（不伪造答案）', async () => {
    const out = await run({ question: 'q' }, null);
    expect(out).toEqual({ answer: null });
  });
});
