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
//   9. step 前 pre-flight 同步压缩（自动触发主链路）
//  10. 单轮工具循环超过尾部预算 — 退到预算位置，不再永久 stuck
//  11. 摘要 cap 缺省 8192（对齐 DSH）且 host 字段即 wire 的 max_tokens
//  12. 摘要调用 usage 入账（发出的 cap + 提供方回报，含 reasoning_tokens）
//  13. 空摘要（思考吃满 cap）→ 明说原因 + 机械提取兜底 + 事件账留归因
//  14. 压缩过程可见：首拍块数 → 每块完成（含用时）→ 收尾带压前→压后
//  15. 撞 cap 但仍有文本 → 截断残稿不许当摘要用（fail-closed）
//  16. 摘要回放（E）：请求 = 主请求真前缀 + 指令，tools 与主请求同一份
//  17. 二次压缩：回放前缀含 <compacted-context> 头，区域接在其后
//  18. 区域含附图 → 不走回放（附图 wire 形态需重解析），退转录口径

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
import { COMPACTION_NOTICE_MARK } from '../src/agent/agent-compaction';
import { SUMMARY_OUTPUT_BUDGET, SUMMARY_PROMPT_BUDGET } from '../src/agent/compaction-summarize';
import { createExecState } from '../src/agent/execution-state';
import { countMessages, countText } from '../src/agent/token-counter';
import { ToolRegistry } from '../src/agent/tool';
import type { Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

// ── Helpers ──

interface RecordedCall {
  /** messages[0] 的内容（回放口径下 = 会话自己的 system 提示） */
  system: string;
  /** messages[1] 的内容（回放口径下 = 区域首条；转录口径下 = 转录稿） */
  user: string;
  /** 完整请求消息数组（回放对齐断言用） */
  messages: any[];
  /** 本次请求带上的工具 schema（回放口径 = 与主请求同一份） */
  tools: any[];
  /** 本次请求写进 wire 的输出上限（= 摘要 cap） */
  maxTokens: number;
  /** 请求形状：回放（真前缀 + 指令）/ 转录（system 即压缩器指令） */
  shape: 'replay' | 'transcript';
}

/** 压缩指令判据：末条 user 消息即指令（两种口径共用同一句开场）。 */
function isSummaryInstruction(m?: { role?: string; content?: string }): boolean {
  return m?.role === 'user' && String(m.content ?? '').startsWith('你是对话压缩器');
}

/** 摘要**族**判据（2026-09-24 E 后有三形）：块调用回放形（末条 = 指令）、块调用转录形与
 *  合并调用（system = 压缩/合并器指令）。主循环两条都不满足 ⇒ 可据此分流。 */
function isSummaryFamily(messages: any[]): boolean {
  return (
    isSummaryInstruction(messages[messages.length - 1]) ||
    String(messages[0]?.content ?? '').startsWith('你是对话压缩器')
  );
}

function makeSummaryProvider(behavior: {
  onCall?: (c: RecordedCall) => void;
  fail?: boolean;
  gate?: () => Promise<void>;
  /** 摘要调用产出的文本（缺省 `摘要#n`；返回 '' = 空返回形态） */
  text?: (n: number) => string;
  /** 每次摘要调用回报的 usage（缺省 = 不回报 —— 真机形态之一） */
  usage?: () => any;
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
        const messages = req.messages as any[];
        const last = messages[messages.length - 1];
        behavior.onCall?.({
          system: messages[0].content,
          user: messages[1]?.content ?? '',
          messages,
          tools: (req.tools ?? []) as any[],
          maxTokens: req.max_tokens,
          shape: isSummaryInstruction(last) ? 'replay' : 'transcript',
        });
        if (behavior.gate) await behavior.gate();
        if (behavior.fail) throw new Error('provider boom');
        const text = behavior.text ? behavior.text(n) : `摘要#${n}`;
        if (text) yield { type: ChunkType.Text, text } as any;
        if (behavior.usage) yield { type: ChunkType.Usage, usage: behavior.usage() } as any;
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

  it('2. 分块 map-reduce：每次 LLM 调用（含回放前缀）装进输入预算（永不塞爆）', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const contextWindow = 20000;
    const inputBudget = contextWindow - SUMMARY_OUTPUT_BUDGET - SUMMARY_PROMPT_BUDGET;
    // chunkCap 与实现同源（输入预算 × 0.8）— 与 compaction-summarize.ts 的
    // 单块容量公式一致，避免硬编码漂移（输出预算 2026-09 迭代 2048 → 4096 → 8192）。
    const chunkCap = Math.floor(inputBudget * 0.8);
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
    // 硬上界断言（规格变更 2026-09-24 E）：输入不再是「转录稿」，而是**回放前缀 + 指令**
    // —— 故按消息数组量：整条调用必须装进输入预算（回放前缀随块号增长，故这条是真守门人）。
    for (const c of chunkCalls) {
      expect(countMessages(c.messages)).toBeLessThanOrEqual(inputBudget);
      // 两种口径之一，不许有第三种：回放（末条 = 指令）/ 转录（system = 压缩器指令）
      const transcript = String(c.system).startsWith('你是对话压缩器');
      expect(c.shape === 'replay' || transcript).toBe(true);
    }
    // 首块前缀最短 ⇒ 必然回放；末块前缀≈全区 ⇒ 本窗口装不下 ⇒ 必退转录（护栏④实证）
    expect(chunkCalls[0].shape).toBe('replay');
    expect(chunkCalls.at(-1)?.shape).toBe('transcript');
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
        // 按请求内容分流：**摘要族** = 回放形（末条 = 压缩指令）/ 转录形 / 合并调用
        // （2026-09-24 E 规格变更：回放口径下 system 就是会话自己的提示，旧判据
        // 「system 含压缩器指令」只对转录口径成立）。分块 map-reduce 会产生多次摘要
        // 调用（块 + 合并），不能靠调用序号区分主循环。
        const msgs = (_req.messages ?? []) as any[];
        if (isSummaryFamily(msgs)) {
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

  it('11. 摘要 cap：缺省 8192（对齐 DSH maxTokens），host 字段即 wire 的 max_tokens', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const agent = makeAgent(prov, { contextWindow: 100000 });
    pushPadMessages(agent, 12, 200);

    await agent.compactNow(new AbortController().signal);

    // 4096 时代的病：思考与摘要共用同一份输出预算，思考吃光 → 空摘要。
    expect(SUMMARY_OUTPUT_BUDGET).toBe(8192);
    expect(calls[0].maxTokens).toBe(8192);

    // 配置面（host.summaryMaxTokens）就是 wire 值 —— 不留第二处真源
    asAny(agent).summaryMaxTokens = 2048;
    pushPadMessages(agent, 8, 200);
    await agent.compactNow(new AbortController().signal);

    expect(calls.at(-1)?.maxTokens).toBe(2048);
  });

  it('12. 摘要调用 usage 入账：事件账记下发出的 cap 与提供方回报（含 reasoning）', async () => {
    const { prov } = makeSummaryProvider({
      usage: () => ({
        prompt_tokens: 1234,
        completion_tokens: 567,
        total_tokens: 1801,
        cache_hit_tokens: 900,
        cache_miss_tokens: 334,
        cache_creation_tokens: 0,
        reasoning_tokens: 89,
        finish_reason: 'stop',
      }),
    });
    const agent = makeAgent(prov, { contextWindow: 100000 });
    pushPadMessages(agent, 12, 200);

    await agent.compactNow(new AbortController().signal);

    const ev = agent.getCompactionStats().events.at(-1)!;
    expect(ev.outcome).toBe('summary');
    expect(ev.summaryCalls).toBe(1);
    expect(ev.summaryMaxTokens).toBe(8192);
    // 真 usage 单独入账（不冒充本地估算的 summaryInput/OutputTokens）
    expect(ev.summaryUsage).toEqual({
      calls: 1,
      promptTokens: 1234,
      completionTokens: 567,
      reasoningTokens: 89,
      cacheHitTokens: 900,
    });
    expect(ev.summaryError).toBeUndefined();
  });

  it('13. 空摘要（思考吃满 cap）→ 明说原因 + 机械提取兜底 + 事件账留归因', async () => {
    const events: any[] = [];
    // 真机形态（案卷 35）：思考吃光输出预算 → 零文本；usage 里有答案。
    const { prov } = makeSummaryProvider({
      text: () => '',
      usage: () => ({
        prompt_tokens: 5000,
        completion_tokens: 8192,
        total_tokens: 13192,
        cache_hit_tokens: 0,
        cache_miss_tokens: 5000,
        cache_creation_tokens: 0,
        reasoning_tokens: 8192,
        finish_reason: 'length',
      }),
    });
    const agent = makeAgent(prov, { contextWindow: 100000, events });
    const a = asAny(agent);
    // 机械提取兜底要抓得到事实（被折区域里的读文件记录）
    a.session.push(
      { role: 'user', content: '帮我改 main.ts' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"src/main.ts"}' }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file_content', content: 'export function main() {}' },
    );
    pushPadMessages(agent, 12, 200);

    const result = await agent.compactNow(new AbortController().signal);

    const ev = agent.getCompactionStats().events.at(-1)!;
    // 管线不闩死：机械提取落地，且真含事实
    expect(ev.outcome).toBe('digest');
    expect(result).toContain('src/main.ts');
    // 归因落账：撞 cap + 发出的 cap + 思考吃掉的量
    expect(ev.summaryError).toContain('truncated at the token cap');
    expect(ev.summaryError).toContain('max_tokens=8192');
    expect(ev.summaryError).toContain('reasoning=8192');
    expect(ev.summaryUsage?.reasoningTokens).toBe(8192);
    // 降级不静默：UI 上有一条 warn 说清原因
    const warns = events.filter((e) => e.level === 'warn' && String(e.text).includes('压缩降级'));
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('truncated at the token cap');
    expect(warns[0].text).toContain('机械提取');
    // 降级通知同样要带标记 —— 这正是用户最需要看见的那条（走 UI 卷内贴黄）
    expect(warns[0].text.startsWith(COMPACTION_NOTICE_MARK)).toBe(true);
  });

  it('14. 压缩过程可见：首拍块数 → 每块完成（含用时）→ 收尾带压前→压后', async () => {
    const events: any[] = [];
    const { prov } = makeSummaryProvider({});
    const contextWindow = 20000;
    const agent = makeAgent(prov, { contextWindow, events });
    pushPadMessages(agent, 24, 2000);

    await agent.compactNow(new AbortController().signal);

    const texts = events.map((e) => String(e.text ?? ''));
    // 首拍：块数 + 区域规模（压缩期间此前 1–3 分钟毫无提示，像挂死）。
    // 标记前缀 = UI 落「卷内贴黄」的判据（COMPACTION_NOTICE_MARK）：不带它，info 级
    // 通知会被 chat-stream 的通知政策整条丢弃（2026-09-24 真机事故：压缩成功、界面无痕）。
    expect(texts[0].startsWith(COMPACTION_NOTICE_MARK)).toBe(true);
    const head = /共 (\d+) 块（约 [\d.]+ 万 token）$/.exec(texts[0]);
    expect(head).not.toBeNull();
    const total = Number(head![1]);
    expect(total).toBeGreaterThan(1);
    // 逐块完成（长杆唯一可读的真进度：第 i/N 块 + 已用秒数）
    const seq = texts
      .map((t) => /第 (\d+)\/(\d+) 块完成（用时 \d+s）$/.exec(t))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [Number(m[1]), Number(m[2])]);
    expect(seq.length).toBeGreaterThan(1);
    expect(seq.map(([i]) => i)).toEqual(seq.map((_, k) => k + 1)); // 1,2,3…N 不漏拍
    expect(new Set(seq.map(([, n]) => n))).toEqual(new Set([total])); // 与首拍同一个 N
    // 收尾：压前 → 压后（同口径千分位；压前读数取自折叠**之前**）
    const final = texts.at(-1)!;
    expect(final.startsWith(COMPACTION_NOTICE_MARK)).toBe(true);
    expect(final).toContain('上下文已压缩');
    const nums = /压前 ([\d,]+) → 压后 ([\d,]+)/.exec(final);
    expect(nums).not.toBeNull();
    const asNumber = (s: string) => Number(s.replace(/,/g, ''));
    expect(asNumber(nums![1])).toBeGreaterThan(asNumber(nums![2]));
    // 事件账同一读数（旧实现两次都在折叠后取 → 两个读数恒等）
    const ev = agent.getCompactionStats().events.at(-1)!;
    expect(ev.preTokens).toBeGreaterThan(ev.postTokens);
  });

  it('15. 撞 cap 但仍有文本：截断残稿不许当摘要用（fail-closed），退机械提取并说明', async () => {
    const events: any[] = [];
    const { prov } = makeSummaryProvider({
      text: () => '## 目标\n半截摘要（写到这里被 cap 砍断）',
      usage: () => ({
        prompt_tokens: 5000,
        completion_tokens: 8192,
        total_tokens: 13192,
        cache_hit_tokens: 0,
        cache_miss_tokens: 5000,
        cache_creation_tokens: 0,
        reasoning_tokens: 8000,
        finish_reason: 'length',
      }),
    });
    const agent = makeAgent(prov, { contextWindow: 100000, events });
    const a = asAny(agent);
    a.session.push(
      { role: 'user', content: '帮我改 main.ts' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"src/main.ts"}' }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file_content', content: 'export function main() {}' },
    );
    pushPadMessages(agent, 12, 200);

    const result = await agent.compactNow(new AbortController().signal);

    const ev = agent.getCompactionStats().events.at(-1)!;
    expect(result).not.toContain('半截摘要'); // 残稿没被采用
    expect(ev.outcome).toBe('digest');
    expect(ev.summaryError).toContain('truncated at the token cap');
    expect(events.some((e) => e.level === 'warn' && String(e.text).includes('truncated at the token cap'))).toBe(true);
  });

  it('16. 摘要回放（E）：请求 = 主请求真前缀 + 指令，tools 与主请求同一份', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
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
    const agent = createTestAgent(prov, registry, 'You are a test agent.', {
      contextWindow: 100000,
      execState: createExecState(),
    });
    pushPadMessages(agent, 12, 200);
    const a = asAny(agent);
    const region = a.computeCompactRegion()!.region;

    await agent.compactNow(new AbortController().signal);

    const call = calls[0];
    // 回放口径：前缀 = 真载荷的前段（同一批消息对象 ⇒ 逐字节一致），不是渲染稿
    expect(call.shape).toBe('replay');
    expect(call.messages.slice(0, -1)).toEqual([a.session[0], ...region]);
    expect(call.messages.slice(0, -1)).toHaveLength(1 + region.length);
    expect(isSummaryInstruction(call.messages.at(-1))).toBe(true);
    // tools 与主请求同一份（前缀对齐的另一半：tools 在 wire 上先于 messages）
    expect(call.tools.length).toBeGreaterThan(0);
    expect(call.tools).toEqual(a.requestToolSchemas());
  });

  it('17. 二次压缩：回放前缀含 <compacted-context> 头，区域接在其后', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const agent = makeAgent(prov, { contextWindow: 100000 });
    pushPadMessages(agent, 12, 200);
    const a = asAny(agent);

    await agent.compactNow(new AbortController().signal);
    pushPadMessages(agent, 8, 200);
    const region = a.computeCompactRegion()!.region;
    await agent.compactNow(new AbortController().signal);

    const call = calls.at(-1)!;
    expect(call.shape).toBe('replay');
    // 载荷头 = system + <compacted-context> 摘要消息 —— 回放必须原样带上它，
    // 否则前缀在第二条就分叉（也让模型天然看到上一轮简报，不再需要 <previous-summary> 注入）
    expect(String(call.messages[1].content)).toContain('<compacted-context>');
    expect(call.messages.slice(2, -1)).toEqual(region);
    expect(isSummaryInstruction(call.messages.at(-1))).toBe(true);
  });

  it('18. 区域含附图 → 不走回放（附图的 wire 形态要重解析），退转录口径且仍出摘要', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    const agent = makeAgent(prov, { contextWindow: 100000 });
    const a = asAny(agent);
    a.session.push({
      role: 'user',
      content: '看这张图',
      images: [{ id: 'img-1', mediaType: 'image/png', width: 10, height: 10, name: 'x.png' }],
    });
    pushPadMessages(agent, 12, 200);

    await agent.compactNow(new AbortController().signal);

    expect(calls[0].shape).toBe('transcript');
    expect(String(calls[0].system)).toContain('对话压缩器');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).toBe('summary');
  });

  it('19. 工具结果折叠开启 → 载荷里是占位符，回放会看不到真输出 ⇒ 退转录口径', async () => {
    const calls: RecordedCall[] = [];
    const { prov } = makeSummaryProvider({ onCall: (c) => calls.push(c) });
    // toolResultWindow > 0 ⇒ payloadMessages() 把窗口外的旧工具结果换成占位符
    const agent = createTestAgent(prov, new ToolRegistry(), 'You are a test agent.', {
      contextWindow: 100000,
      execState: createExecState(),
      toolResultWindow: 2,
    });
    const a = asAny(agent);
    a.session.push({ role: 'user', content: '跑几个命令' });
    for (let i = 0; i < 6; i++) {
      a.session.push(
        { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'fs', arguments: '{}' }] },
        { role: 'tool', tool_call_id: `c${i}`, name: 'fs', content: pad(200) },
      );
    }
    pushPadMessages(agent, 6, 200);

    // 前置事实：折叠确实改了载荷（旧工具结果被换成 `[工具结果已折叠: …]` 占位）
    // —— 注意必须在压缩**之前**看载荷：压完区域被折进摘要，载荷里就没有 tool 消息了。
    const payloadTools = a.payloadMessages().filter((m: any) => m.role === 'tool');
    expect(payloadTools.length).toBeGreaterThan(0);
    expect(payloadTools.some((m: any) => String(m.content).includes('工具结果已折叠'))).toBe(true);

    await agent.compactNow(new AbortController().signal);

    // 逐条身份比较不过 ⇒ 回放会看不到真工具输出 ⇒ 退转录口径（今天的形状）
    expect(calls[0].shape).toBe('transcript');
    expect(agent.getCompactionStats().events.at(-1)?.outcome).not.toBe('stuck');
  });
});
