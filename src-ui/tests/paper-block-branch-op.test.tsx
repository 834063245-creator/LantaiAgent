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
uiAssistant.parts.push({
  type: 'tool',
  toolId: 'c1',
  name: 'fs',
  args: '{}',
  label: 'fs',
  readOnly: false,
  status: 'done',
});

const region = {
  sessionNum: SID,
  blocks: [
    { id: 'pb-user', source: { messageId: uiUser._id, part: null } },
    { id: 'pb-assistant', source: { messageId: uiAssistant._id, part: uiAssistant.parts[0] } },
    { id: 'pb-tool', source: { messageId: uiAssistant._id, part: uiAssistant.parts[1] } },
  ],
} as unknown as RegionView;

const regionMsgs: Record<string, { messages: readonly ChatMessage[]; tick: number }> = {
  [String(SID)]: { messages: [uiUser, uiAssistant], tick: 1 },
};

/** 桩 core：只带块动作行用到的那几个能力位（含新的 branchFromMessage）。
 *  判据表按**块** id 键（同一条答复的各块切点不同）。 */
function fakeCore(branches: Map<string, { ok: true; atSeq: number } | { ok: false; reason: string }> = new Map()): {
  core: ChatCore;
  branchCalls: Array<{ sid: number; msgId: string; block?: { parts: readonly unknown[]; index: number } }>;
} {
  const branchCalls: Array<{ sid: number; msgId: string; block?: { parts: readonly unknown[]; index: number } }> = [];
  const core = {
    panelId: 'p-branch-op',
    copyText: vi.fn(),
    editUserMessage: vi.fn(),
    resendUserMessage: vi.fn(),
    canRetraceUserMessage: vi.fn(() => true),
    branchPoints: vi.fn(() => branches),
    branchFromMessage: vi.fn(
      async (
        msg: ChatMessage,
        sid: number,
        _drop?: { x: number; y: number },
        block?: { parts: readonly unknown[]; index: number },
      ) => {
        branchCalls.push({ sid, msgId: msg._id, ...(block ? { block } : {}) });
        return 8;
      },
    ),
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
    // 来文块不带块坐标（切点 = 这条来文自己，与块无关）
    expect(branchCalls).toEqual([{ sid: SID, msgId: uiUser._id }]);
  });

  it('回复块：也有「立枝」，点击带上**本块坐标**（切点 = 该块那一步的末尾）', () => {
    const { core, branchCalls } = fakeCore();
    let ops = new Map<string, BlockOp[]>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m), onGrips: () => {} }));
    });

    const assistOps = ops.get('pb-assistant') ?? [];
    expect(assistOps.map((o) => o.key)).toEqual(['copy', 'branch']);
    const branch = assistOps.find((o) => o.key === 'branch');
    expect(branch?.title).toContain('本卷原样保留');

    act(() => branch?.run());
    expect(branchCalls).toEqual([{ sid: SID, msgId: uiAssistant._id, block: { parts: uiAssistant.parts, index: 0 } }]);

    // 同一条消息的**另一块**（工具卡）带的是自己的坐标——同源不同点
    const toolOps = ops.get('pb-tool') ?? [];
    act(() => toolOps.find((o) => o.key === 'branch')?.run());
    expect(branchCalls[1]).toEqual({
      sid: SID,
      msgId: uiAssistant._id,
      block: { parts: uiAssistant.parts, index: 1 },
    });
  });

  it('未落定节点：判据表里的具名原因 = 按钮置灰 + title 可见（不在渲染期逐块判定）', () => {
    const { core, branchCalls } = fakeCore(
      new Map([
        ['pb-user', { ok: true as const, atSeq: 2 }],
        ['pb-tool', { ok: false as const, reason: '这一轮还有 1 处工具调用没落定——等它跑完再立枝' }],
      ]),
    );
    let ops = new Map<string, BlockOp[]>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core, onOps: (m) => (ops = m), onGrips: () => {} }));
    });

    // 判据每卷一趟（不是每块一趟）；节点 = **块**（键 + 块坐标），不是消息
    expect((core as unknown as { branchPoints: Mock }).branchPoints).toHaveBeenCalledTimes(1);
    const [, nodes] = (core as unknown as { branchPoints: Mock }).branchPoints.mock.calls[0] as [
      number,
      Array<{ key: string; _id: string; role: string }>,
    ];
    expect(nodes.map((n) => [n.key, n.role])).toEqual([
      ['pb-user', 'user'],
      ['pb-assistant', 'assistant'],
      ['pb-tool', 'assistant'],
    ]);

    const branch = ops.get('pb-tool')?.find((o) => o.key === 'branch');
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
    // 全通过：三个对话块都有握把
    const ok = fakeCore(
      new Map([
        ['pb-user', { ok: true as const, atSeq: 2 }],
        ['pb-assistant', { ok: true as const, atSeq: 3 }],
        ['pb-tool', { ok: true as const, atSeq: 3 }],
      ]),
    );
    let grips = new Set<string>();
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core: ok.core, onOps: () => {}, onGrips: (s) => (grips = s) }));
    });
    expect([...grips].sort()).toEqual(['pb-assistant', 'pb-tool', 'pb-user']);

    // 未落定的**那一块**不长握把（按钮同时置灰）——同一条消息的另一块照常有（按块判据）
    act(() => root?.unmount());
    const refused = fakeCore(
      new Map([
        ['pb-user', { ok: true as const, atSeq: 2 }],
        ['pb-assistant', { ok: true as const, atSeq: 3 }],
        ['pb-tool', { ok: false as const, reason: '这一轮还有 1 处工具调用没落定——等它跑完再立枝' }],
      ]),
    );
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe, { core: refused.core, onOps: () => {}, onGrips: (s) => (grips = s) }));
    });
    expect([...grips].sort()).toEqual(['pb-assistant', 'pb-user']);

    // 判据表缺席（非对话节点：通知块——`branchPoints` 只收 user/assistant 的块）
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
