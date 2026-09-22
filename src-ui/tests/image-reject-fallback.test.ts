// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图发送策略「先发、被拒再降级」回归（2026-09-19 语义变更）。
//
// 旧行为：Provider.inputModalities 未声明 image ⇒ 请求期直接把图投影成占位，
// 图**根本不发**。四层声明链末位默认 ['text']（覆盖 ?? 拉取元数据 ?? 目录
// 声明 ?? ['text']），声明缺失 / 过时 / 与实际端点不符时，用户贴的图静默送不
// 出去——模型与用户都无从知晓（B3/B5 一族失效形态：全链无痕、测试全绿）。
//
// 新行为：除非该模型**已实测拒过图**，一律先发；真被服务商拒了才记档（按
// 模型 id）并去图重发——用户侧表现为自动恢复，而不是「一贴图就报错」。
// 声明面（inputModalities）就此退回 UI 提示，不再参与发送决策：
// 「猜错了会响」优先于「猜对了省一次请求」。
//
// 本文件钉四件事（按用户可感知的操作序列写）：
//   ① 首次被拒 → 自动去图重发（占位随 wire 抵达模型，用户只看到一次提示）；
//   ② 记档生效 → 同模型下一轮不再白撞（直接带占位发，provider 只被调一次）；
//   ③ 记档按**模型 id** 键控 → 换模型自动重新尝试发图（不把旧模型的拒绝延续）；
//   ④ 非图片类失败不触发去图降级（不许把普通错误当「该丢图」的证据）。

import { describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import type { AgentEvent, EventKind } from '../src/agent/agent-types';
import { ToolRegistry } from '../src/agent/tool';
import { ApiError, type ChatImageRef, type Chunk, ChunkType, type Provider, type Request } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

const IMG: ChatImageRef = {
  id: 'aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233',
  mediaType: 'image/png',
  bytes: 12,
  width: 114,
  height: 1182,
  name: '截图.png',
};
const IMG2: ChatImageRef = { ...IMG, id: 'bb' + IMG.id.slice(2), name: '截图2.png' };

/** 图字节读取腰（app 注入面的替身）——2026-09-22 起产物 = {mediaType, data}。 */
const reader = async (): Promise<{ mediaType: 'image/png'; data: string }> => ({
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
});

interface SeenCall {
  /** 本次请求是否真的带了图字节（wire 侧判据）。 */
  hasImages: boolean;
  /** 末条 user 消息的文本（模型实际读到的内容）。 */
  userText: string;
}

function userTextOf(req: Request): string {
  const msgs = req.messages as Array<{ role: string; content?: unknown }>;
  const user = [...msgs].reverse().find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

/** 模拟服务商：**带图就拒**（真实形态——只有收到图才会抱怨图）。
 *  拒绝形态 = 400 + image_url 措辞（OpenAI 兼容族真实文案）。 */
function makeImageRejectingProvider(initialModel = 'vision-unlisted-model'): {
  prov: Provider;
  seen: SeenCall[];
  setModel: (id: string) => void;
} {
  let modelId = initialModel;
  const seen: SeenCall[] = [];
  const prov: Provider = {
    name: () => 'mock',
    model: () => modelId,
    stream: (_signal: AbortSignal, req: Request) => {
      const hasImages = Object.keys(req.imageData ?? {}).length > 0;
      seen.push({ hasImages, userText: userTextOf(req) });
      return (async function* (): AsyncGenerator<Chunk> {
        if (hasImages) {
          throw new ApiError('[未知错误] "mock" 返回了意外错误 (400)：image_url is only supported by certain models', {
            status: 400,
            raw: '{"error":{"message":"image_url is only supported by certain models"}}',
          });
        }
        yield { type: ChunkType.Text, text: '收到（无图）' };
        yield { type: ChunkType.Done } as Chunk;
      })();
    },
  };
  return { prov, seen, setModel: (id) => (modelId = id) };
}

/** 带读图腰 + 事件捕获的测试 Agent（walk 真链路：createTestAgent 走 ctx 入口）。 */
function makeAgent(prov: Provider, events: AgentEvent[]): ReturnType<typeof createTestAgent> {
  return createTestAgent(prov, new ToolRegistry(), 'sys', {
    eventSink: (ev: AgentEvent) => events.push(ev),
    contextWindow: 0,
    imageReader: reader,
  });
}

function notices(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.kind === ('notice' as EventKind))
    .map((e) => String((e as { text?: unknown }).text ?? ''));
}

describe('附图策略 — 先发、被拒再降级（2026-09-19）', () => {
  it('首次被拒 → 自动去图重发：用户只贴一次图、只看到一次提示，图走 wire 一次', async () => {
    const { prov, seen } = makeImageRejectingProvider();
    const events: AgentEvent[] = [];
    const agent = makeAgent(prov, events);

    await agent.run(new AbortController().signal, '看看这个图', [IMG]);

    // ① 先发（第一发确实带图）→ ② 记档后去图重发
    expect(seen).toHaveLength(2);
    expect(seen[0].hasImages).toBe(true);
    expect(seen[1].hasImages).toBe(false);
    // 去图重发那轮把「图已省略」写进 wire——模型知道图存在过，不是纯文字黑洞
    expect(seen[1].userText).toContain('当前模型不支持图片输入');
    expect(seen[1].userText).toContain('截图.png');
    // 用户可感知的交代（响亮降级，不静默）
    expect(notices(events).some((t) => t.includes('不接受图片输入'))).toBe(true);
  });

  it('记档生效 → 同模型下一轮不再白撞：直接带占位发，provider 只被调一次', async () => {
    const { prov, seen } = makeImageRejectingProvider();
    const events: AgentEvent[] = [];
    const agent = makeAgent(prov, events);
    const signal = new AbortController().signal;

    await agent.run(signal, '看看这个图', [IMG]);
    const afterFirst = seen.length;
    expect(afterFirst).toBe(2); // 首发 + 去图重发

    // 第二轮（同模型）——已实测拒图，直接投影，不再浪费一次被拒的请求
    await agent.run(signal, '再看一张', [IMG2]);

    expect(seen).toHaveLength(afterFirst + 1);
    expect(seen[afterFirst].hasImages).toBe(false);
    expect(seen[afterFirst].userText).toContain('当前模型不支持图片输入');
  });

  it('记档按模型 id 键控 → 换模型自动重新尝试发图', async () => {
    const { prov, seen, setModel } = makeImageRejectingProvider('model-a');
    const events: AgentEvent[] = [];
    const agent = makeAgent(prov, events);
    const signal = new AbortController().signal;

    await agent.run(signal, '图一', [IMG]);
    expect(seen).toHaveLength(2);
    expect(seen[0].hasImages).toBe(true); // model-a 拒过了

    // 换模型 = 换能力，拒绝记忆不得延续（否则又是一条静默丢图链）
    setModel('model-b');
    const before = seen.length;
    await agent.run(signal, '图二', [IMG2]);

    // model-b 先发（带图）→ 被拒 → 去图重发：证明重新尝试而不是直接投影
    expect(seen).toHaveLength(before + 2);
    expect(seen[before].hasImages).toBe(true);
    expect(seen[before + 1].hasImages).toBe(false);
  });

  it('非图片类失败不触发去图降级（普通错误不许被当成「该丢图」的证据）', async () => {
    // 与图无关的 400：不带图片特征措辞 —— 即使请求里有图也不去图。
    // （普通 400 在 classifyError 里落 [未知错误]，走既有自愈重试——正是要点：
    //   重试期间图**始终带着**，不许因为「失败过」就被悄悄换成占位。）
    const observed: boolean[] = [];
    const prov: Provider = {
      name: () => 'mock',
      model: () => 'plain-model',
      stream: (_signal: AbortSignal, req: Request) => {
        observed.push(Object.keys(req.imageData ?? {}).length > 0);
        return (async function* (): AsyncGenerator<Chunk> {
          // 每次都失败（observed 已 push 过 → 恒真）；yield 留作生成器形状
          if (observed.length > 0) {
            throw new ApiError('[未知错误] "mock" 返回了意外错误 (400)：bad parameter foo', { status: 400 });
          }
          yield { type: ChunkType.Done } as Chunk;
        })();
      },
    };
    const events: AgentEvent[] = [];
    const agent = makeAgent(prov, events);

    vi.useFakeTimers();
    let surfaced: unknown;
    try {
      // 失败最终向上抛（会话层落墓碑 = 错误不静默）；本测只关心图有没有被悄悄丢掉
      const runPromise = agent.run(new AbortController().signal, '看看这个图', [IMG]).catch((e: unknown) => e);
      // 推完退避（单次推进 < 挂起预算，避免误触时间预算分支）
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(5_000);
      surfaced = await runPromise;
    } finally {
      vi.useRealTimers();
    }

    // 失败可见（不是静默吞掉）
    expect(surfaced).toBeInstanceOf(Error);
    // 每一次尝试都带着图（零降级）+ 没有「不接受图片输入」的误判提示
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((has) => has)).toBe(true);
    expect(notices(events).some((t) => t.includes('不接受图片输入'))).toBe(false);
  });
});
