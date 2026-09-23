// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上下文压缩管线端到端测试 — mock provider 驱动完整 compact 流程。
// 覆盖：
//   1. 单块摘要（旧行为回归）
//   2. map-reduce 分块 + 每次 LLM 调用的输入硬上界（"永不塞爆"断言）
//   3. LLM 失败 → 机械摘要兜底（管线不闩死）
//   4. 窗口不可行 → 纯机械（LLM 零调用）
//   5. 空区域不闩锁（旧永久 stuck bug 回归）
//   6. 摘要飞行中 session 增长 — 折叠点自洽（append-only）
//   7. 摘要飞行中 session 替换 — 折叠结果被丢弃
//   8. 块数超上限 — 最老块机械消化，LLM 调用数封顶

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/agent/tools/define-tool';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
// 钉死摘要模型选择：无 key、无候选 → 永远回退主模型（即 mock provider），
// 测试不受 localStorage 里真实设置污染。
vi.mock('../src/settings', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    loadSettings: () => ({
      activeProvider: 'mock',
      providers: [{ kind: 'openai', name: 'mock', apiKey: '', baseUrl: '', model: 'mock-model' }],
      projectPath: '.',
      agent: { temperature: 0.7, contextWindow: 0 },
      display: { language: 'zh', fontScale: 1 },
    }),
  };
});
vi.mock('../src/provider/catalog', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, getAllModels: () => [] };
});

import type { Agent } from '../src/agent/agent';
import { SUMMARY_OUTPUT_BUDGET, SUMMARY_PROMPT_BUDGET } from '../src/agent/compaction-summarize';
import { createExecState } from '../src/agent/execution-state';
import { countMessages, countText } from '../src/agent/token-counter';
import { ToolRegistry } from '../src/agent/tool';
import type { Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

// ── Helpers ──

interface RecordedCall {
  system: string;
  user: string;
}

function makeSummaryProvider(behavior: {
  onCall?: (c: RecordedCall) => void;
  fail?: boolean;
  gate?: () => Promise<void>;
}): { prov: Provider; callCount: () => number } {
  let n = 0;
  return {
    callCount: () => n,
    prov: {
      name: () => 'mock',
      model: () => 'mock',
      prewarm() {},
      async *stream(_signal: AbortSignal, req: any) {
        n++;
        behavior.onCall?.({ system: req.messages[0].content, user: req.messages[1].content });
        if (behavior.gate) await behavior.gate();
        if (behavior.fail) throw new Error('provider boom');
        yield { type: ChunkType.Text, text: `摘要#${n}` } as any;
        yield { type: ChunkType.Done } as any;
      },
    },
  };
}

function makeAgent(prov: Provider, opts: { contextWindow?: number; events?: any[] } = {}): Agent {
  return createTestAgent(prov, new ToolRegistry(), 'You are a test agent.', {
    contextWindow: opts.contextWindow ?? 100000,
    execState: createExecState(),
    eventSink: opts.events ? (ev) => opts.events!.push(ev) : undefined,
  });
}

function asAny(agent: Agent): any {
  return agent as any;
}

/** 汉字在 cl100k 下 ≈ 1 token/字 — 生成约 tokens 个 token 的填充文本。 */
const pad = (tokens: number) => '汉'.repeat(tokens);

function pushPadMessages(agent: Agent, n: number, tokensEach: number): void {
  const a = asAny(agent);
  for (let i = 0; i < n; i++) {
    a.session.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: pad(tokensEach) });
  }
}

const USAGE_HIGH = {
  prompt_tokens: 90000,
  completion_tokens: 0,
  total_tokens: 90000,
  cache_hit_tokens: 0,
  cache_miss_tokens: 0,
  reasoning_tokens: 0,
  cache_creation_tokens: 0,
  finish_reason: 'stop',
};

// ── Tests ──

describe('compaction pipeline E2E', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('');
  });

  it('1. 单块摘要：折叠视图生效，session 完整历史不变', async () => {
    const { prov } = makeSummaryProvider({});
    const agent = makeAgent(prov);
    pushPadMessages(agent, 12, 200);

    const result = await agent.compactNow(new AbortController().signal);

    expect(result).toBe('摘要#1');
    // session = system + 12 — 完整保留
    expect(agent.getSession()).toHaveLength(13);
    // payload = system + 摘要 + 尾部 4 条
    const payload = asAny(agent).payloadMessages();
    expect(payload).toHaveLength(6);
    expect(payload[1].content).toContain('<compacted-context>');
    expect(payload[1].content).toContain('摘要#1');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('summary');
    expect(asAny(agent).compactStuck).toBe(false);
  });

  it('2. 分块 map-reduce：每次 LLM 调用输入 ≤ chunkCap（永不塞爆）', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const contextWindow = 20000;
    // chunkCap 与实现同源（输入预算 × 0.8）— 与 compaction-summarize.ts 的
    // 单块容量公式一致，避免硬编码漂移（输出预算 2026-09 迭代 2048 → 4096）。
    const chunkCap = Math.floor((contextWindow - SUMMARY_OUTPUT_BUDGET - SUMMARY_PROMPT_BUDGET) * 0.8);
    const agent = makeAgent(prov, { contextWindow });
    pushPadMessages(agent, 24, 2000); // region 多块

    // 用真实计数推导预期块数，不假设每字 token 率
    const a = asAny(agent);
    const region = a.computeCompactRegion()!.region;
    const expectedChunks = Math.ceil(countMessages(region) / chunkCap);
    expect(expectedChunks).toBeGreaterThan(1); // 确认真的分块了

    await agent.compactNow(new AbortController().signal);

    // 调用数 = 块数 + 1 次合并
    expect(calls).toHaveLength(expectedChunks + 1);
    const chunkCalls = calls.slice(0, expectedChunks);
    const mergeCall = calls[expectedChunks];
    // 硬上界断言：每次块调用输入 ≤ chunkCap，合并调用 ≤ chunkCap
    for (const c of chunkCalls) {
      expect(c.system).toContain('只总结本段内容');
      expect(countText(c.user)).toBeLessThanOrEqual(chunkCap + 50); // 50 = 转录格式开销余量
    }
    expect(mergeCall.system).toContain('多份分段简报');
    expect(countText(mergeCall.user)).toBeLessThanOrEqual(chunkCap + 50);
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('summary');
    expect(asAny(agent).compactStuck).toBe(false);
  });

  it('3. LLM 失败 → 机械摘要兜底：管线落地，不闩死', async () => {
    const { prov } = makeSummaryProvider({ fail: true });
    const agent = makeAgent(prov);
    const a = asAny(agent);
    a.session.push(
      { role: 'user', content: '帮我重构 main.ts' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"src/main.ts"}' }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file_content', content: 'export function main() {}' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c2', name: 'write_file', arguments: '{"filePath":"src/main.ts","content":"x"}' }],
      },
      { role: 'tool', tool_call_id: 'c2', name: 'write_file', content: 'ok' },
      { role: 'assistant', content: '重构完成' },
    );
    pushPadMessages(agent, 4, 50); // 尾部

    const result = await agent.compactNow(new AbortController().signal);

    // 机械摘要包含文件操作事实
    expect(result).toContain('src/main.ts');
    expect(result).toContain('文件操作');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('digest');
    // 折叠仍然应用 — 管线没有闩死
    expect(asAny(agent)._compactSummary).toBe(result);
    expect(asAny(agent).compactStuck).toBe(false);
  });

  it('4. 窗口不可行 → 纯机械摘要，LLM 零调用', async () => {
    const { prov, callCount } = makeSummaryProvider({});
    const agent = makeAgent(prov, { contextWindow: 9000 }); // inputBudget < 4000
    pushPadMessages(agent, 12, 200);

    const result = await agent.compactNow(new AbortController().signal);

    expect(callCount()).toBe(0);
    expect(result.length).toBeGreaterThan(0);
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('digest');
    expect(asAny(agent).compactStuck).toBe(false);
  });

  it('5. 空区域不闩锁：增长后自动恢复（旧永久 stuck 回归）', async () => {
    const events: any[] = [];
    const { prov, callCount } = makeSummaryProvider({});
    // 窗口 20000 → 自动尾部保留预算 = 3200 token（retainRatio 0.16）：
    // 第一段 3×100=300 < 3200 → 无可压价值（null，不闩锁设增长门槛）；
    // 第二段累计到 ~3300 ≥ 3200 → 真正触发压缩（窗口也保证 LLM 摘要可行）。
    const agent = makeAgent(prov, { contextWindow: 20000, events });
    const a = asAny(agent);
    pushPadMessages(agent, 3, 100); // system + 3 < 尾部预算 → 无可折叠区域

    a.maybeCompact(USAGE_HIGH);

    // 不闩锁、不告警，只设增长门槛
    expect(a.compactStuck).toBe(false);
    expect(a.compactRetryAfterLen).toBe(4 + 4);
    expect(callCount()).toBe(0);
    expect(events.filter((e) => e.level === 'warn')).toHaveLength(0);

    // 增长足够消息后重试 — 压缩真正执行
    pushPadMessages(agent, 10, 300);
    a.maybeCompact(USAGE_HIGH);
    await vi.waitFor(() => expect(a.compactRunning).toBe(false));

    expect(callCount()).toBe(1);
    expect(a._compactSummary).toBe('摘要#1');
    expect(a.compactStuck).toBe(false);
    expect(a.compactRetryAfterLen).toBe(0);
  });

  it('6. 摘要飞行中 session 增长：折叠点自洽，新消息全部进尾部', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { prov } = makeSummaryProvider({ gate: () => gate });
    // 窗口 20000 → 自动尾部预算 3200 token：12×300 内容足够触发异步管线，
    // 且窗口 ≥ ~12K 让 LLM 摘要可行（不断言 digest 降级）。
    const agent = makeAgent(prov, { contextWindow: 20000 });
    const a = asAny(agent);
    pushPadMessages(agent, 12, 300); // len = 13

    a.maybeCompact(USAGE_HIGH);
    expect(a.compactRunning).toBe(true);

    // 摘要飞行中 — 5 条新消息到达
    pushPadMessages(agent, 5, 100);
    const lastContent = a.session.at(-1).content;
    release();
    await vi.waitFor(() => expect(a.compactRunning).toBe(false));

    // session 完整历史未动
    expect(agent.getSession()).toHaveLength(18);
    // payload = system + 摘要 + tailStart 起的全部尾部（含飞行中新增 5 条）
    const payload = a.payloadMessages();
    const tailStart = a._compactTailStart;
    expect(payload).toHaveLength(1 + 1 + (agent.getSession().length - tailStart));
    expect(payload.at(-1).content).toBe(lastContent);
    expect(payload[1].content).toContain('摘要#1');
  });

  it('7. 摘要飞行中 session 替换：折叠结果被丢弃', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { prov } = makeSummaryProvider({ gate: () => gate });
    const agent = makeAgent(prov, { contextWindow: 20000 });
    const a = asAny(agent);
    pushPadMessages(agent, 12, 300);

    a.maybeCompact(USAGE_HIGH);
    expect(a.compactRunning).toBe(true);

    agent.newSession(); // bumpVersion — 飞行中的折叠必须失效
    release();
    await vi.waitFor(() => expect(a.compactRunning).toBe(false));

    expect(a._compactSummary).toBeNull();
    expect(a._compactTailStart).toBe(-1);
  });

  it('8. 块数超上限：最老块机械消化，LLM 调用数封顶', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const contextWindow = 20000;
    const agent = makeAgent(prov, { contextWindow });
    pushPadMessages(agent, 90, 1500); // region ≈ 129K tokens → ~12 块 > 8 上限

    await agent.compactNow(new AbortController().signal);

    // LLM 块调用封顶 8 + 1 次合并 = 9
    expect(calls).toHaveLength(9);
    // 合并输入包含最老块的机械提取
    expect(calls[8].user).toContain('早期历史（机械提取）');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('digest'); // 部分降级
    expect(asAny(agent).compactStuck).toBe(false);
  });

  it('9. 自动触发链路：step 前 pre-flight 同步压缩（主触发点）经真实 run 路径触发', async () => {
    // 2026-09 迭代：自动压缩主触发从「轮末 maybeCompact(usage)」前移到
    // 「step 前 pre-flight」——发送前估算载荷 ≥ compactRatio(默认 0.8) 即
    // 同步压缩（compactIfNeeded）后再发请求，杜绝超压请求上路。
    // 序列：run → step 0 前 pre-flight 估算达 0.8 → 摘要调用（n=1）→
    // 主循环 tool_calls 轮（n=2）→ 收尾纯文本轮（n=3）。
    const calls: string[] = [];
    let mainCalls = 0;
    const prov: Provider = {
      name: () => 'mock',
      model: () => 'mock',
      prewarm() {},
      async *stream(_signal: AbortSignal, _req: any) {
        // 按请求内容分流：摘要调用的 system prompt 是「对话压缩器」指令，
        // 主循环是测试 agent 的 system。分块 map-reduce 会产生多次摘要调用
        // （块 + 合并），不能靠调用序号区分主循环。
        const system = String(_req.messages?.[0]?.content ?? '');
        if (system.includes('对话压缩器')) {
          calls.push('preflight-summary');
          yield { type: ChunkType.Text, text: '自动触发摘要' } as any;
          yield { type: ChunkType.Done } as any;
          return;
        }
        mainCalls++;
        if (mainCalls === 1) {
          calls.push('main-tool');
          yield { type: ChunkType.ToolCall, tool_call: { id: 'c1', name: 'fake_tool', arguments: '{}' } } as any;
          yield { type: ChunkType.Usage, usage: { ...USAGE_HIGH } } as any;
          yield { type: ChunkType.Done } as any;
        } else {
          calls.push('main-text');
          yield { type: ChunkType.Text, text: '收尾回复' } as any;
          yield { type: ChunkType.Done } as any;
        }
      },
    };

    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'fake_tool',
        description: 'fake',
        schema: z.object({}),
        readOnly: true,
        execute: async () => 'fake output',
      }),
    );
    // 窗口 50000、12×3400 → pre-flight 估算 ≈ 40800/50000 ≈ 0.82 ≥ 0.8 触发；
    // auto 尾部预算 8000 token，压缩区域 ≈ 40800−尾 < 单块上限（chunkCap
    // ≈ (50000−8096)×0.8 ≈ 33523）→ 单次 LLM 摘要（n=1），调用序稳定。
    const agent = createTestAgent(prov, registry, 'You are a test agent.', {
      contextWindow: 50000,
      execState: createExecState(),
    });
    pushPadMessages(agent, 12, 3400);
    const a = asAny(agent);
    const beforePayloadLen = a.payloadMessages().length;
    expect(beforePayloadLen).toBe(13); // system + 12

    await agent.run(new AbortController().signal, '继续干活');

    // pre-flight 触发 → 摘要调用已发生（压缩在发主请求前同步完成）
    expect(calls[0]).toBe('preflight-summary');
    expect(a._compactSummary).toContain('自动触发摘要');

    // 载荷缩小：system + 摘要 + auto 保留尾（完整 user 回合）
    const payload = a.payloadMessages();
    expect(payload.length).toBeLessThan(beforePayloadLen);
    expect(payload[1].content).toContain('<compacted-context>');
    // session 完整无损：system + 12 + 用户消息 + tool 轮（assistant + tool + 收尾 assistant）
    expect(agent.getSession().length).toBeGreaterThan(14);
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('summary');
    expect(a.compactStuck).toBe(false);
  });

  it('10. 单轮工具循环超过尾部预算：退到预算位置压缩，不再永久 stuck（案卷 35 形态）', async () => {
    const { prov, callCount } = makeSummaryProvider({});
    // 窗口 20000 → 自动尾部保留预算 = 3200 token（retainRatio 0.16）。
    // 形态 = 1 条用户消息 + 长工具循环（工具组里没有 user 回合边界）：
    // 从尾部往回扫到预算位置也**遇不到任何 user 消息** ⇒ 旧行为 `autoTailStart`
    // 一路返回 null（region 0 / outcome stuck），每步空转 + 告警直到占用撞窗口。
    // 真机形态（案卷 35）：1 条用户消息 + 54 步工具循环 ≈ 80 万 token，预算 = 16 万。
    const agent = makeAgent(prov, { contextWindow: 20000 });
    const a = asAny(agent);
    a.session.push({ role: 'user', content: 'go' });
    for (let i = 0; i < 40; i++) {
      a.session.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `c${i}`, name: 'fs', arguments: '{}' }],
      });
      a.session.push({ role: 'tool', tool_call_id: `c${i}`, name: 'fs', content: pad(300) });
    }

    a.maybeCompact(USAGE_HIGH);
    await vi.waitFor(() => expect(a.compactRunning).toBe(false));

    // 压缩真落地（旧行为：stuck）
    expect(a.compactStuck).toBe(false);
    expect(callCount()).toBeGreaterThan(0);
    expect(String(a._compactSummary)).toContain('摘要');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).not.toBe('stuck');
    // 尾部不以孤立 tool 结果开头（不拆 tool-call 组——与手动路径同规）
    expect(a.session[a._compactTailStart].role).not.toBe('tool');
    // 近期现场仍按预算保留（≈3200；没有被一并折进摘要）
    expect(countMessages(a.session.slice(a._compactTailStart))).toBeGreaterThanOrEqual(3000);
  });
});
