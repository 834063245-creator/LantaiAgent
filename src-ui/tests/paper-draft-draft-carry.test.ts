// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸（题签）上的**附图 / 路径附件**必须跟着开卷一起走（2026-11-19 用户真机报：
// 「题签上附的截图没有发送给模型」）。
//
// 病灶：开卷编排只交了**正文**这一件——`pendingText` 存了、还了；`attachedFiles` /
// `attachedImages` 没有。而 `createNewSession` 起卷时会 `restoreSessionDraft(新号)`，
// 新卷无草稿槽 ⇒ live 输入整体被 `emptyDraft()` 清空（含附图道）。于是纸上那几张图
// 在「纸化成卷」那一拍蒸发：rail 上的缩略图没了，发出去的这一轮也没有图。
//
// 判据：起卷是「换一次账本」，不是「清一次桌面」——纸上没发出去的输入（正文 + 附件 +
// 附图）三件同权，要么一起过门，要么一起丢。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge', () => ({
  invoke: vi.fn(async () => null),
  rpc: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

/** 起卷替身：只复现「新卷无草稿 ⇒ live 被清」这一条事实（真实现见 session-crud）。 */
vi.mock('../src/app/chat/session-composition', async () => {
  const { getChatStore } = await import('../src/ui/chat-store');
  return {
    CREATOR_OPENING_PROMPT: 'creator-opening',
    createSessionWithPreset: vi.fn(async (ctx: { storeId: string }) => {
      const store = getChatStore(ctx.storeId);
      const sid = 7;
      store.input.getState().restoreSessionDraft(sid); // 真实起卷的清洗动作
      store.sess.setState((s) => ({
        ...s,
        sessions: [...s.sessions, { id: sid, label: '' }],
        activeIdx: s.sessions.length,
      }));
      return { ok: true, sessionId: sid } as const;
    }),
  };
});

import { openDraftVolume } from '../src/app/chat/session/draft-opening';
import type { SessionContext } from '../src/app/chat/session/session-types';
import type { ChatImageRef } from '../src/provider/types';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'panel-draft-carry';
const IMG: ChatImageRef = {
  id: 'img-on-paper',
  mediaType: 'image/png',
  bytes: 4096,
  width: 32,
  height: 32,
  name: 'shot-on-paper.png',
};

const HOOKS = {
  placeRegion: vi.fn(),
  requestFocus: vi.fn(),
  applyDraftPicks: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  HOOKS.placeRegion.mockReset();
  HOOKS.requestFocus.mockReset();
  HOOKS.applyDraftPicks.mockReset();
});

describe('开卷：纸上输入整份交接', () => {
  it('正文 / 附图 / 路径附件三件一起过门（不被起卷清空）', async () => {
    const input = getChatStore(PANEL).input;
    input.getState().setInputText('照着这张图改');
    input.getState().addAttachedImage(IMG);
    input.getState().addAttachedFile({ path: 'D:/ws/paper/a.txt', name: 'a.txt', size: 0 });

    const r = await openDraftVolume(
      PANEL,
      { storeId: PANEL } as unknown as SessionContext,
      {
        presetId: null,
        picks: { providerName: 'p', model: 'm', thinking: undefined },
        fallback: { providerName: 'p', model: 'm' },
        anchor: null,
      },
      HOOKS,
      () => true,
    );

    expect(r.ok).toBe(true);
    const live = input.getState();
    expect(live.inputText, '正文丢了').toBe('照着这张图改');
    expect(
      live.attachedImages.map((i) => i.id),
      '纸上的附图没交接——开卷那一拍被起卷的草稿清洗吞掉',
    ).toEqual(['img-on-paper']);
    expect(
      live.attachedFiles.map((f) => f.name),
      '纸上的路径附件没交接',
    ).toEqual(['a.txt']);
  });

  it('纸上什么都没有时：开卷后 live 是干净的空槽（不复活上一卷的草稿）', async () => {
    const input = getChatStore(PANEL).input;
    input.getState().releaseLive();

    await openDraftVolume(
      PANEL,
      { storeId: PANEL } as unknown as SessionContext,
      {
        presetId: null,
        picks: { providerName: 'p', model: 'm', thinking: undefined },
        fallback: { providerName: 'p', model: 'm' },
        anchor: null,
      },
      HOOKS,
      () => true,
    );

    const live = input.getState();
    expect(live.inputText).toBe('');
    expect(live.attachedImages).toEqual([]);
    expect(live.attachedFiles).toEqual([]);
  });
});
