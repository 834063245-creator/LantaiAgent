// @vitest-environment jsdom

// 卡架「顶队头」行为测试（2026-11-11 画布多卷审批 UX · A 面的后半句）。
//
// Why：多卷并行时卡架是单卡 + FIFO——用户从卷首角标或待答缩略行**点名**要答哪卷，
// 不该被强制先答完别的卷的问题。`promoteByOwner` 只重排**顺序**，不动卡的归属与内容。
//
// 覆盖（4 条）：顶到队头 / 已在队头 no-op / 该卷没有在等卡 no-op / 无归属档独立；
// 外加一条「被顶下的卡没丢」：它仍在队列里，答完新队头后自动回到队头。
//
// 与 tests/ui/prompt-shelf.test.ts 的分工：那份考卡片交互（选项/批量/键盘），
// 本份只考队列重排——改队列逻辑时不用碰那份大文件。

import { act, createElement, type ReactRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskPrompt, PromptShelfHandle } from '../../src/app/chat/ask-card-contract';
import { PromptShelf } from '../../src/plugins/builtin/ask-cards/PromptShelf';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let ref: ReactRef<PromptShelfHandle | null> = { current: null };

/** showAsk 内同步 setActive —— 必须包 act 才能同步 flush 渲染。 */
function showAsk(prompt: AskPrompt): Promise<string[] | null> {
  let p!: Promise<string[] | null>;
  act(() => {
    p = ref.current!.showAsk(prompt);
  });
  return p;
}

function ask(id: string, ownerSid: number | null): AskPrompt {
  return {
    type: 'ask',
    id,
    ownerSid,
    badge: ownerSid == null ? null : `卷${ownerSid}`,
    question: `问题 ${id}`,
    header: '提问',
    options: [],
    multiSelect: false,
  };
}

beforeEach(() => {
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
  container = null;
  root = null;
});

describe('卡架顶队头（promoteByOwner）', () => {
  it('把某卷的第一张在等卡顶到队头，返回 true', () => {
    void showAsk(ask('a', 1));
    void showAsk(ask('b', 2));
    expect(ref.current!.active?.id).toBe('a');

    let moved = false;
    act(() => {
      moved = ref.current!.promoteByOwner(2);
    });
    expect(moved).toBe(true);
    expect(ref.current!.active?.id).toBe('b');
  });

  it('已在队头 = no-op（不重排、不重渲）', () => {
    void showAsk(ask('a', 1));
    void showAsk(ask('b', 2));
    let moved = true;
    act(() => {
      moved = ref.current!.promoteByOwner(1);
    });
    expect(moved).toBe(false);
    expect(ref.current!.active?.id).toBe('a');
  });

  it('该卷没有在等卡 = no-op（点陈旧角标不炸）', () => {
    void showAsk(ask('a', 1));
    let moved = true;
    act(() => {
      moved = ref.current!.promoteByOwner(99);
    });
    expect(moved).toBe(false);
    expect(ref.current!.active?.id).toBe('a');
  });

  it('无归属（null）是独立一档：null 卡与真卷卡互不顶错', () => {
    void showAsk(ask('n', null));
    void showAsk(ask('a', 1));
    let moved = false;
    act(() => {
      moved = ref.current!.promoteByOwner(null);
    });
    expect(moved).toBe(false); // null 卡本来就在队头
    act(() => {
      moved = ref.current!.promoteByOwner(1);
    });
    expect(moved).toBe(true);
    expect(ref.current!.active?.id).toBe('a');
  });

  it('被顶下的卡没丢：它还在队列里，答完新队头后自动回到队头', () => {
    const first = showAsk(ask('a', 1));
    void showAsk(ask('b', 2));
    act(() => {
      ref.current!.promoteByOwner(2);
    });
    expect(ref.current!.active?.id).toBe('b');

    // 答掉队头（b）：开放式卡走主输入作答
    act(() => {
      expect(ref.current!.answerActiveText('先答 b')).toBe(true);
    });
    expect(ref.current!.active?.id).toBe('a');
    void first;
  });
});
