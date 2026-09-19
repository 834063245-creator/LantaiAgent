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
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
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
function fakeCore(branches: Map<string, { ok: true; atSeq: number } | { ok: false; reason: string }> = new Map()): {
  core: ChatCore;
  branchCalls: Array<{ sid: number; msgId: string }>;
} {
  const branchCalls: Array<{ sid: number; msgId: string }> = [];
  const core = {
    panelId: 'p-branch-op',
    copyText: vi.fn(),
    editUserMessage: vi.fn(),
    resendUserMessage: vi.fn(),
    canRetraceUserMessage: vi.fn(() => true),
    branchPoints: vi.fn(() => branches),
    branchFromMessage: vi.fn(async (msg: ChatMessage, sid: number) => {
      branchCalls.push({ sid, msgId: msg._id });
      return 8;
    }),
  } as unknown as ChatCore;
  return { core, branchCalls };
}

/** 探针组件：只跑 hook 并把 opsByBlock / branchGrips 交出来（不渲染纸面）。 */
function Probe({
  core,
  onOps,
  onGrips,
}: {
  core: ChatCore;
  onOps: (map: Map<string, BlockOp[]>) => void;
  onGrips: (set: Set<string>) => void;
}): null {
  const regions = useMemo(() => [region], []);
  const regionsRef = useRef(regions);
  const { opsByBlock, branchGrips } = useBlockOps({ core, regions, regionsRef, regionMsgs });
  onOps(opsByBlock);
  onGrips(branchGrips);
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
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m), onGrips: () => {} }));
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
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m), onGrips: () => {} }));
    });

    const assistOps = ops.get('pb-assistant') ?? [];
    expect(assistOps.map((o) => o.key)).toEqual(['copy', 'branch']);
    expect(assistOps.find((o) => o.key === 'branch')?.title).toContain('本卷原样保留');
  });

  it('未落定节点：判据表里的具名原因 = 按钮置灰 + title 可见（不在渲染期逐块判定）', () => {
    const { core, branchCalls } = fakeCore(
      new Map([
        [uiUser._id, { ok: true as const, atSeq: 2 }],
        [uiAssistant._id, { ok: false as const, reason: '这一轮还有 1 处工具调用没落定——等它跑完再立枝' }],
      ]),
    );
    let ops = new Map<string, BlockOp[]>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m), onGrips: () => {} }));
    });

    // 判据每卷一趟（不是每块一趟）
    expect((core as unknown as { branchPoints: Mock }).branchPoints).toHaveBeenCalledTimes(1);
    expect((core as unknown as { branchPoints: Mock }).branchPoints).toHaveBeenCalledWith(SID, [uiUser, uiAssistant]);

    const branch = ops.get('pb-assistant')?.find((o) => o.key === 'branch');
    expect(branch?.disabled).toBe(true);
    expect(branch?.title).toContain('没落定');
    // 同一卷里切点在未落定之前的来文块照常可点
    const userBranch = ops.get('pb-user')?.find((o) => o.key === 'branch');
    expect(userBranch?.disabled).toBeFalsy();
    expect(userBranch?.title).toContain('本卷原样保留');

    // 置灰的按钮点击不落动作（PaperPanel 的渲染面同判据：disabled 即 return）
    expect(branchCalls).toEqual([]);
  });

  it('空间手势的握把可见性 = **同一张判据表**（P4-①：判据通过才有握把）', () => {
    // 全通过：两个对话块都有握把
    const ok = fakeCore(
      new Map([
        [uiUser._id, { ok: true as const, atSeq: 2 }],
        [uiAssistant._id, { ok: true as const, atSeq: 3 }],
      ]),
    );
    let grips = new Set<string>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core: ok.core, onOps: () => {}, onGrips: (s) => (grips = s) }));
    });
    expect([...grips].sort()).toEqual(['pb-assistant', 'pb-user']);

    // 未落定的块不长握把（按钮同时置灰）；切点在它之前的来文块照常有
    act(() => root?.unmount());
    const refused = fakeCore(
      new Map([
        [uiUser._id, { ok: true as const, atSeq: 2 }],
        [uiAssistant._id, { ok: false as const, reason: '这一轮还有 1 处工具调用没落定——等它跑完再立枝' }],
      ]),
    );
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core: refused.core, onOps: () => {}, onGrips: (s) => (grips = s) }));
    });
    expect([...grips]).toEqual(['pb-user']);

    // 判据表缺席（非对话节点：工具卡/通知块——`branchPoints` 只收 user/assistant）
    // ⇒ 也不长握把（一个注定被拒的整段手势比置灰的按钮更糟）
    act(() => root?.unmount());
    const none = fakeCore();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core: none.core, onOps: () => {}, onGrips: (s) => (grips = s) }));
    });
    expect(grips.size).toBe(0);
  });
});
