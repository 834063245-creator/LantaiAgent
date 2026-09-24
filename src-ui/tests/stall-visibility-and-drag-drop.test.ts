// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 挂起可见化 + 原生拖放接线回归（2026-09-22 读图挂起事故）。
//
// 事故现场（会话 26，21:15–21:17）：附图请求挂起 → 重试提示只活 6.4s（toast），
// 卷面只剩转圈 → 用户读成「Agent 直接挂了」，两次手动停止。用户原话还指出触发
// 路径：**创作坞粘贴/拖放失灵**，他才改成手打路径让 Agent 自己读。
//
// 本文件钉两件事：
//   ① 挂起类 warn 通知落**卷内贴黄**（持久、贴回合、同回合只一条）；
//      非挂起 warn 仍只走 toast（不把卷面变成通知垃圾场）。
//   ② 原生拖放（Tauri onDragDropEvent）→ 当前卷创作坞草稿槽；图片走附图道，
//      声明缺失时只提示不拦截。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DropHandler = (e: { payload: { type: string; paths: string[] } }) => void;
let dropHandler: DropHandler | null = null;

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: DropHandler) => {
      dropHandler = h;
      return () => {
        dropHandler = null;
      };
    },
  }),
}));

import { COMPACTION_NOTICE_MARK } from '../src/agent/agent-compaction';
import { EventKind } from '../src/agent/agent-types';
import { STALL_NOTICE_MARK } from '../src/agent/retry';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { bootDragDrop } from '../src/shell/rows/drag-drop';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { useToastStore } from '../src/state/toast-store';
import { getChatStore } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { handleAgentNotice, renderEvent } from '../src/ui/chat-stream';
import type { ChatMessage } from '../src/ui/message-model';
import { createAssistantMessage, createUserMessage } from '../src/ui/message-model';

// ── ① 挂起留痕 ──

function makeCtx(storeId: string, sessionId: number, assistantId: string, msgs: ChatMessage[]): StreamContext {
  getChatStore(storeId).sess.setState({
    sessions: [{ id: sessionId, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: sessionId + 1,
  });
  let current = msgs;
  return {
    storeId,
    sessionId,
    getSessionMessages: () => current,
    getActiveMessages: () => current,
    setSessionMessages: (_sid: number, m: ChatMessage[]) => {
      current = m;
    },
    bumpSessionMessages: () => {},
    getStreamingAssistantId: () => assistantId,
    // 流内 part 路径经 _scheduleSync（rAF 防抖）——真 ctx 有这两个口，替身同形。
    getSyncRafId: () => null,
    setSyncRafId: () => {},
    // ToolDispatch 分派要用（本次位置用例驱动真实分流）——真 ctx 同形。
    _recordToolUsage: () => {},
    _updateStatusBar: () => {},
  } as unknown as StreamContext;
}

function turn(): { msgs: ChatMessage[]; assistantId: string; ctx: StreamContext } {
  const storeId = `stall-test-${Date.now()}-${Math.random()}`;
  const assistant = createAssistantMessage('u1');
  const msgs: ChatMessage[] = [createUserMessage('看这张图'), assistant];
  return { msgs, assistantId: assistant._id, ctx: makeCtx(storeId, 1, assistant._id, msgs) };
}

function notices(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.filter((m) => m.role === 'notice');
}

describe('挂起通知的卷内留痕（2026-09-22）', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('挂起 warn → 卷内贴黄一条（持久），且插在流式正文之前', () => {
    const { msgs, assistantId, ctx } = turn();
    handleAgentNotice(
      ctx,
      `${STALL_NOTICE_MARK} 服务商 30 秒内未返回任何数据，已进入自动重试——期间卷面可能只有转圈，可随时停止。`,
      'warn',
    );
    const found = notices(ctx.getSessionMessages(1));
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain(STALL_NOTICE_MARK);
    expect((found[0] as { level?: string }).level).toBe('warn');
    // 读序 = 来文 → 贴黄 → 正文
    const seq = ctx.getSessionMessages(1).map((m) => (m._id === assistantId ? 'assistant' : m.role));
    expect(seq).toEqual(['user', 'notice', 'assistant']);
    expect(notices(msgs)).toHaveLength(1); // 写入的是同一份卷数组
  });

  it('同一回合内重复重试 → 仍只一条贴黄（不刷屏）', () => {
    const { ctx } = turn();
    handleAgentNotice(ctx, `${STALL_NOTICE_MARK} 服务商 30 秒内未返回任何数据，已进入自动重试。`, 'warn');
    handleAgentNotice(ctx, `${STALL_NOTICE_MARK} 服务商仍未返回数据，29.3s 后重试（仍未收到服务商数据）…`, 'warn');
    handleAgentNotice(ctx, `${STALL_NOTICE_MARK} 服务商仍未返回数据，58.6s 后重试（仍未收到服务商数据）…`, 'warn');
    expect(notices(ctx.getSessionMessages(1))).toHaveLength(1);
  });

  it('非挂起 warn 不落卷（仍只走 toast）——卷面不被通知淹没', () => {
    const { ctx } = turn();
    handleAgentNotice(ctx, '上下文过长，自动压缩后重试…', 'warn');
    expect(notices(ctx.getSessionMessages(1))).toHaveLength(0);
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });
});

// ── ①b 压缩通知的卷内留痕（2026-09-24 压缩无痕事故）──
//
// 事故现场（假卷 37，真机）：压缩真跑了、也真成功了（事件账 outcome=summary、
// 压前 295,017 → 压后 22,281），但界面上「什么都没看到」——因为压缩进度通知是
// info 级，而上面那条政策把 info 整条丢弃；开头那条 warn 只活 6.4 秒 toast。
// 用户等了一分钟无反馈，当场手动停止运行（与①的挂起同形）。
// 判据 = agent 侧给压缩通知加 COMPACTION_NOTICE_MARK 前缀，UI 按前缀落卷内贴黄。
//
// ⚡ 2026-09-24 追加（用户报「贴黄只停在来文下面」）：贴黄由**消息级**改为**流内 part**
// ——消息级只能插在「来文之后、助手消息之前」，于是永远停在回合顶部；而压缩恰恰常发生
// 在一轮工具循环的中段（案卷 35 形态：1 条来文 + 54 步工具循环），停在顶部说的不是它
// 发生的位置。落成 notice part 后，位置由流决定。

/** 流内贴黄（notice part）序列 —— 顺序即流序。 */
function noticeParts(msgs: ChatMessage[]): Array<{ text: string; level: string }> {
  const assistant = msgs.filter((m) => m.role === 'assistant').at(-1) as { parts?: unknown[] } | undefined;
  return ((assistant?.parts ?? []) as Array<{ type: string; text?: string; level?: string }>)
    .filter((p) => p.type === 'notice')
    .map((p) => ({ text: String(p.text ?? ''), level: String(p.level ?? '') }));
}

describe('压缩通知的卷内留痕（2026-09-24）', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('压缩进度（info）→ 落成流内 notice part，不另起消息、不刷 toast', () => {
    const { msgs, assistantId, ctx } = turn();
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 共 2 块（约 27.3 万 token）`, 'info');
    const parts = noticeParts(ctx.getSessionMessages(1));
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('共 2 块');
    expect(parts[0].level).toBe('info');
    // 贴黄是流的一部分 ⇒ 不再另起 notice 消息
    expect(notices(ctx.getSessionMessages(1))).toHaveLength(0);
    expect(notices(msgs)).toHaveLength(0);
    const seq = ctx.getSessionMessages(1).map((m) => (m._id === assistantId ? 'assistant' : m.role));
    expect(seq).toEqual(['user', 'assistant']);
    expect(useToastStore.getState().toasts).toHaveLength(0); // 进度不刷 toast
  });

  it('位置由流决定：已在跑的工具循环里到达的贴黄，落在**已产出的部分之后**（用户报的病灶）', () => {
    const { assistantId, ctx } = turn();
    // 真实的压缩现场：助手已经说了一句、发出一个工具调用（流到中段），压缩才发生
    renderEvent(ctx, { kind: EventKind.Text, text: '先看第一份档案。' } as never);
    renderEvent(ctx, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'fs', args: '{"action":"read"}', label: '读档', readOnly: true } as never,
    } as never);
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 共 1 块（约 23 万 token）`, 'info');

    const assistant = ctx.getSessionMessages(1).find((m) => m._id === assistantId) as { parts: unknown[] };
    const order = (assistant.parts as Array<{ type: string; text?: string }>).map((p) =>
      p.type === 'text' ? `text:${String(p.text).slice(0, 4)}` : p.type,
    );
    // 贴黄在已产出的正文与工具卡**之后** —— 旧实现（消息级）它会贴在来文下面、全部之前
    expect(order).toEqual(['text:先看第一', 'tool', 'notice']);
  });

  it('每块一条贴黄（进度心跳不去重）——挂起的「同回合只一条」不适用', () => {
    const { ctx } = turn();
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 共 3 块（约 60.0 万 token）`, 'info');
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 第 1/3 块完成（用时 41s）`, 'info');
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 第 2/3 块完成（用时 38s）`, 'info');
    handleAgentNotice(ctx, `${COMPACTION_NOTICE_MARK} 压缩中 · 第 3/3 块完成（用时 44s）`, 'info');
    const parts = noticeParts(ctx.getSessionMessages(1));
    expect(parts).toHaveLength(4);
    expect(parts.filter((p) => p.text.includes('块完成'))).toHaveLength(3);
  });

  it('降级 / 失败（warn）→ 流内贴黄 + toast（失败要看见，也要留痕）', () => {
    const { ctx } = turn();
    handleAgentNotice(
      ctx,
      `${COMPACTION_NOTICE_MARK} 压缩降级 · summary truncated at the token cap (max_tokens=8192) —— 本次改用机械提取（完整历史仍保留）`,
      'warn',
    );
    const parts = noticeParts(ctx.getSessionMessages(1));
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('truncated at the token cap');
    expect(parts[0].level).toBe('warn');
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it('收尾（info）→ 贴黄带压前/压后读数', () => {
    const { ctx } = turn();
    handleAgentNotice(
      ctx,
      `${COMPACTION_NOTICE_MARK} 上下文已压缩: 83 条消息 → 摘要；压前 295,017 → 压后 22,281`,
      'info',
    );
    const parts = noticeParts(ctx.getSessionMessages(1));
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('压前 295,017 → 压后 22,281');
  });
});

// ── ② 原生拖放 ──

function fakeCore(panelId: string): ChatCore {
  // attachIntakePaths 真身是 async（Promise<void>）——替身必须同形：拖放行按契约挂了
  // `.catch`（入卷失败不静默），返回 undefined 的替身会当场炸。
  return { panelId, attachIntakePaths: vi.fn(async () => {}) } as unknown as ChatCore;
}

function seedModel(model: string, declarations?: { input?: string[] }): void {
  const provider: Record<string, unknown> = {
    kind: 'openai',
    name: 'p',
    apiKey: '',
    baseUrl: 'https://gateway.example/v1',
    model,
  };
  if (declarations?.input) provider.modelOverrides = { [model]: { input: declarations.input } };
  localStorage.setItem(
    'hologram_settings',
    JSON.stringify({
      activeProvider: 'p',
      providers: [provider],
      projectPath: '.',
      agent: {},
      display: { language: 'zh', fontScale: 1 },
    }),
  );
}

describe('创作坞原生拖放（Tauri onDragDropEvent）', () => {
  beforeEach(() => {
    dropHandler = null;
    useToastStore.setState({ toasts: [] });
    localStorage.clear();
  });

  afterEach(() => {
    resetComposeStoresForTests();
  });

  it('拖进来的路径落到当前卷草稿槽（图片与普通文件一并交给共用底座分流）', async () => {
    const core = fakeCore(`drop-test-${Date.now()}`);
    useCoreStore.getState().setChatCore(core);
    getChatStore(core.panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    seedModel('vision-x', { input: ['text', 'image'] });
    getComposeStore(core.panelId).setState({
      sessions: { '1': { providerName: 'p', model: 'vision-x', thinking: '' } },
    });

    await bootDragDrop();
    expect(dropHandler).not.toBeNull();
    dropHandler?.({ payload: { type: 'drop', paths: ['D:/x/user-ref.png', 'D:/x/notes.txt'] } });

    expect(core.attachIntakePaths).toHaveBeenCalledWith(['D:/x/user-ref.png', 'D:/x/notes.txt']);
    expect(useToastStore.getState().toasts).toHaveLength(0); // 声明了 vision → 不提示
  });

  it('未声明图片输入也照收（先发语义），只加一条提示', async () => {
    const core = fakeCore(`drop-test-${Date.now()}`);
    useCoreStore.getState().setChatCore(core);
    getChatStore(core.panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    seedModel('text-only-model'); // 无声明（末位缺省 ['text']）
    getComposeStore(core.panelId).setState({
      sessions: { '1': { providerName: 'p', model: 'text-only-model', thinking: '' } },
    });

    await bootDragDrop();
    dropHandler?.({ payload: { type: 'drop', paths: ['D:/x/user-ref.png'] } });

    expect(core.attachIntakePaths).toHaveBeenCalledTimes(1); // 收——不再按声明拦
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.text).toContain('图已收');
  });

  it('非 drop 阶段（enter/over/leave）不触发入卷', async () => {
    const core = fakeCore(`drop-test-${Date.now()}`);
    useCoreStore.getState().setChatCore(core);
    await bootDragDrop();
    dropHandler?.({ payload: { type: 'enter', paths: [] } });
    dropHandler?.({ payload: { type: 'over', paths: [] } });
    dropHandler?.({ payload: { type: 'leave', paths: [] } });
    expect(core.attachIntakePaths).not.toHaveBeenCalled();
  });
});
