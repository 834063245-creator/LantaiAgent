// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」的**入口位置**守护（2026-09-18）——分支按钮挂在**消息自己的动作行**
// （与「改 / 重发 / 抄」同族），不是会话列表、不是标题栏、不是卷首。
//
// 为什么单列一条：本轮先把它放进侧栏（默认收起 ⇒ 唯一入口不可见）、又差点放进卷首
// 芯片旁——两次都是位置错。位置是产品语义（主流 agent 软件的分支入口都在消息上），
// 故用行为测试钉住，防止再漂。
//
// 走生产单点：真 `useBlockOps`（不复制编排），桩 core 只带被调用的能力位。

import { act, createElement, useMemo, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import type { RegionView } from '../src/paper/region-view';
import { type BlockOp, useBlockOps } from '../src/plugins/builtin/paper-shell/use-block-ops';
import type { ChatMessage } from '../src/ui/message-model';
import { createAssistantMessage, createUserMessage } from '../src/ui/message-model';

const SID = 7;

const uiUser = createUserMessage('一');
const uiAssistant = createAssistantMessage(uiUser._id);
uiAssistant.parts.push({ type: 'text', text: '二' }); // 有正文才有「抄」——与真实回复同形

const region = {
  sessionNum: SID,
  blocks: [
    { id: 'pb-user', source: { messageId: uiUser._id, part: null } },
    { id: 'pb-assistant', source: { messageId: uiAssistant._id, part: null } },
  ],
} as unknown as RegionView;

const regionMsgs: Record<string, { messages: readonly ChatMessage[]; tick: number }> = {
  [String(SID)]: { messages: [uiUser, uiAssistant], tick: 1 },
};

/** 桩 core：只带块动作行用到的那几个能力位（含新的 branchFromMessage）。 */
function fakeCore(): { core: ChatCore; branchCalls: Array<{ sid: number; msgId: string }> } {
  const branchCalls: Array<{ sid: number; msgId: string }> = [];
  const core = {
    panelId: 'p-branch-op',
    copyText: vi.fn(),
    editUserMessage: vi.fn(),
    resendUserMessage: vi.fn(),
    canRetraceUserMessage: vi.fn(() => true),
    branchFromMessage: vi.fn(async (msg: ChatMessage, sid: number) => {
      branchCalls.push({ sid, msgId: msg._id });
      return 8;
    }),
  } as unknown as ChatCore;
  return { core, branchCalls };
}

/** 探针组件：只跑 hook 并把 opsByBlock 交出来（不渲染纸面）。 */
function Probe({ core, onOps }: { core: ChatCore; onOps: (map: Map<string, BlockOp[]>) => void }): null {
  const regions = useMemo(() => [region], []);
  const regionsRef = useRef(regions);
  const { opsByBlock } = useBlockOps({ core, regions, regionsRef, regionMsgs });
  onOps(opsByBlock);
  return null;
}

describe('会话树「枝」入口 = 消息动作行（useBlockOps）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it('来文块：与「改 / 重发 / 抄」同行出现「立枝」，点击 = core.branchFromMessage(本块, 本卷)', async () => {
    const { core, branchCalls } = fakeCore();
    let ops = new Map<string, BlockOp[]>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m) }));
    });

    const userOps = ops.get('pb-user') ?? [];
    expect(userOps.map((o) => o.key)).toEqual(['edit', 'resend', 'copy', 'branch']);
    const branch = userOps.find((o) => o.key === 'branch');
    expect(branch?.label).toBe('立枝');
    expect(branch?.disabled).toBeFalsy();

    act(() => branch?.run());
    expect(branchCalls).toEqual([{ sid: SID, msgId: uiUser._id }]);
  });

  it('回复块：也有「立枝」（切点落在本轮末尾，由 session-branch 判定）', () => {
    const { core } = fakeCore();
    let ops = new Map<string, BlockOp[]>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m) }));
    });

    const assistOps = ops.get('pb-assistant') ?? [];
    expect(assistOps.map((o) => o.key)).toEqual(['copy', 'branch']);
    expect(assistOps.find((o) => o.key === 'branch')?.title).toContain('本卷原样保留');
  });
});
