// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter 压力基准（baseline）钉 — 2026-11-19「以提供方 usage 为锚」批。
//
// 口径真源 = `src/agent/token-meter/types.ts` 文件头。本文件钉四件事：
//   ① 信封签字与锚核验判据（对上 / 前缀增长 / 换模型 / 换工具集 / 载荷改写 / 变短）；
//   ② 账本锚状态机（锚只来自有 usage 的请求、增量带符号、失效退回估算、投影夹零）；
//   ③ `readPressure` 是**判定与 UI 读数的唯一计算口**（两边同一个数字）；
//   ④ 快照往返：签字随锚落盘 ⇒ 恢复后先按估算读，核验通过才归位。

import { describe, expect, it } from 'vitest';
import { countText } from '../src/agent/token-counter';
import {
  anchorVerdict,
  envelopeSignature,
  estimatePayloadTokens,
  measureEnvelope,
} from '../src/agent/token-meter/estimate';
import { SessionTokenMeter } from '../src/agent/token-meter/meter';
import { readPressure } from '../src/agent/token-meter/pressure';
import type { TokenAnchorProbe, TokenRequestRecord } from '../src/agent/token-meter/types';
import type { Message, ToolSchema, Usage } from '../src/provider/types';

const MODEL = 'mock/mock-model';
const SCHEMAS: ToolSchema[] = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }];

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

/** 一份典型载荷：系统提示 + 两轮对话。 */
function payload(): Message[] {
  return [
    msg('system', '你是兰台，一名案卷助手。'),
    msg('user', '帮我看看这段代码'),
    msg('assistant', '看过了，这段代码没有问题。'),
  ];
}

function usage(prompt_tokens: number, completion_tokens = 0): Usage {
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    cache_hit_tokens: 0,
    cache_miss_tokens: prompt_tokens,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    finish_reason: 'stop',
  };
}

/** 信封签字（全量）。 */
function sig(payload: readonly Message[], over: { toolsTokens?: number; model?: string } = {}) {
  return envelopeSignature({
    model: over.model ?? MODEL,
    toolsCount: SCHEMAS.length,
    toolsTokens: over.toolsTokens ?? 0,
    payload,
  });
}

/** 锚核验材料（与签字同源）。 */
function probe(payload: readonly Message[], over: Partial<TokenAnchorProbe> = {}): TokenAnchorProbe {
  return {
    model: MODEL,
    toolsCount: SCHEMAS.length,
    toolsTokens: 0,
    transientTokens: 0,
    payload,
    ...over,
  };
}

/** 全量启发式的期望值（与 `readPressure` 传的 toolsTokens 对齐：0 = 不另计 schema）。 */
function expectedSurface(payload: readonly Message[], reminders: readonly string[] = []): number {
  return measureEnvelope(payload, SCHEMAS, reminders, { toolsTokens: 0 }).surfaceTokens;
}

/** 一条请求记录（锚由 usage + 签字共同构成）。 */
function record(over: Partial<TokenRequestRecord> = {}): TokenRequestRecord {
  const body = over.breakdown ?? { systemTokens: 10, toolsTokens: 20, messageTokens: 30 };
  return {
    turn: 1,
    step: 1,
    breakdown: body,
    surfaceTokens: body.systemTokens + body.toolsTokens + body.messageTokens,
    contextWindow: 200_000,
    transientTokens: 0,
    signature: sig([]),
    ...over,
  };
}

describe('token-meter · 锚核验判据（anchorVerdict）', () => {
  it('同构：同一份载荷逐条一致 ⇒ 可复用，增量从锚的条数起算', () => {
    const base = payload();
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(base))).toEqual({ ok: true, cut: 3 });
  });

  it('前缀增长（工具循环里追加消息）⇒ 仍可复用，cut 停在锚的条数', () => {
    const base = payload();
    const grown = [...base, msg('tool', '工具结果'), msg('assistant', '继续')];
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(grown))).toEqual({ ok: true, cut: 3 });
  });

  it('换模型 ⇒ 不可复用（分词器/窗口/价目都换了）', () => {
    const base = payload();
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(base, { model: 'other/model' }))).toEqual({ ok: false, reason: 'model' });
  });

  it('换工具集（条数或满量分词数变）⇒ 不可复用', () => {
    const base = payload();
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(base, { toolsCount: 2 }))).toEqual({ ok: false, reason: 'tools' });
    expect(anchorVerdict(anchor, probe(base, { toolsTokens: 777 }))).toEqual({ ok: false, reason: 'tools' });
  });

  it('载荷前缀被改写（压缩遮蔽 / 撤回 / 会话替换）⇒ 不可复用', () => {
    const base = payload();
    const rewritten = [base[0], msg('user', '<compacted-summary>这是一段完全不同的摘要</compacted-summary>'), base[2]];
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(rewritten))).toEqual({ ok: false, reason: 'history' });
  });

  it('载荷变短 ⇒ 不可复用（锚覆盖的消息已经不在了）', () => {
    const base = payload();
    const anchor = { pressureTokens: 1_000, surfaceTokens: 300, transientTokens: 0, signature: sig(base) };
    expect(anchorVerdict(anchor, probe(base.slice(0, 2)))).toEqual({ ok: false, reason: 'history' });
  });
});

describe('token-meter · 锚式读数（readPressure / 账本）', () => {
  it('无锚：按全量启发式读（baseline=estimated），不编造投影', () => {
    const meter = new SessionTokenMeter();
    meter.setContextWindow(100_000);
    const body = payload();
    const reading = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: body,
      transientReminders: [],
    });
    const expected = expectedSurface(body);
    expect(reading).toEqual({ tokens: expected, basis: 'estimated' });
    const v = meter.measure();
    expect(v.baseline).toEqual({ kind: 'estimated', tokens: expected });
    expect(v.projectedTokens).toBeUndefined();
    expect(v.usedSource).toBe('surface');
  });

  it('有锚且同构：读数 = 锚压力 + 表面增量，且与 UI 读数**同一个数字**', () => {
    const meter = new SessionTokenMeter();
    meter.setContextWindow(100_000);
    const base = payload();
    const surfaceAtAnchor = expectedSurface(base);
    meter.recordRequest(record({ surfaceTokens: surfaceAtAnchor, signature: sig(base), usage: usage(1_000) }));

    // 锚之后又追加两条（工具循环的典型形态）：只有这两条走启发式
    const grown = [...base, msg('tool', '工具结果原样返回'), msg('assistant', '明白了')];
    const reading = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: grown,
      transientReminders: [],
    });
    const tail = estimatePayloadTokens(grown.slice(3));
    expect(reading).toEqual({ tokens: 1_000 + tail, basis: 'usage' });

    const v = meter.measure();
    expect(v.baseline).toEqual({ kind: 'usage', tokens: 1_000 });
    expect(v.surfaceDeltaTokens).toBe(tail);
    expect(v.projectedTokens).toBe(reading.tokens); // 判定与墨量册读数不可能再分裂
    expect(v.usedTokens).toBe(reading.tokens);
    expect(v.usedSource).toBe('projected');
  });

  it('锚对不上（压缩遮蔽）：退回全量估算，投影作废，读数随之掉下来', () => {
    const meter = new SessionTokenMeter();
    meter.setContextWindow(100_000);
    const base = payload();
    meter.recordRequest(record({ surfaceTokens: expectedSurface(base), signature: sig(base), usage: usage(9_000) }));
    expect(meter.measure().projectedTokens).toBe(9_000);

    const compacted = [base[0], msg('user', '<compacted-summary>摘要</compacted-summary>')];
    const reading = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: compacted,
      transientReminders: [],
    });
    const expected = expectedSurface(compacted);
    expect(reading).toEqual({ tokens: expected, basis: 'estimated', rejected: 'history' });
    expect(reading.tokens).toBeLessThan(9_000); // 压缩后读数真的掉下来
    const v = meter.measure();
    expect(v.baseline).toEqual({ kind: 'estimated', tokens: expected });
    expect(v.projectedTokens).toBeUndefined();
    // 上一次的真值仍如实摆着（它只是不再当分子）
    expect(v.pressureTokens).toBe(9_000);
  });

  it('临时提醒换批走差值（不从消息链里猜）', () => {
    const meter = new SessionTokenMeter();
    const base = payload();
    const reminder = '<system-reminder>甲</system-reminder>';
    const extra = '<system-reminder>乙：后台任务完成</system-reminder>';
    meter.recordRequest(
      record({
        surfaceTokens: expectedSurface(base, [reminder]),
        transientTokens: countText(reminder),
        signature: sig(base),
        usage: usage(1_000),
      }),
    );
    // 同一批提醒 ⇒ 增量 0，压力恰为锚值
    const same = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: base,
      transientReminders: [reminder],
    });
    expect(same).toEqual({ tokens: 1_000, basis: 'usage' });
    // 本步多出一条提醒 ⇒ 增量正是那一条的价
    const more = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: base,
      transientReminders: [reminder, extra],
    });
    expect(more).toEqual({ tokens: 1_000 + countText(extra), basis: 'usage' });
  });

  it('失败/中止的请求不产生锚（只计数）', () => {
    const meter = new SessionTokenMeter();
    const base = payload();
    meter.recordRequest(record({ signature: sig(base), usage: undefined }));
    expect(meter.measure().attempts).toBe(1);
    expect(meter.anchor()).toBeUndefined();
    const reading = readPressure(meter, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: base,
      transientReminders: [],
    });
    expect(reading.basis).toBe('estimated');
  });

  it('投影夹零：压缩把表面削到锚之下不出负数', () => {
    const meter = new SessionTokenMeter();
    meter.setContextWindow(100_000);
    const base = payload();
    meter.recordRequest(record({ surfaceTokens: 5_000, signature: sig(base), usage: usage(5_000) }));
    meter.recordAnchoredSurface(1_200);
    expect(meter.measure().projectedTokens).toBe(1_200);
    meter.recordAnchoredSurface(0);
    expect(meter.measure().projectedTokens).toBe(0);
  });
});

describe('token-meter · 锚的快照往返', () => {
  it('签字随锚落盘：恢复后先按估算读，核验通过才归位', () => {
    const meter = new SessionTokenMeter();
    meter.setContextWindow(200_000);
    const base = payload();
    meter.recordRequest(record({ surfaceTokens: expectedSurface(base), signature: sig(base), usage: usage(1_500) }));
    const snap = meter.snapshot();
    expect(snap?.anchor?.pressureTokens).toBe(1_500);
    expect(snap?.version).toBe(2);

    const revived = SessionTokenMeter.restore(snap);
    expect(revived.anchor()?.signature.chain).toBe(sig(base).chain);
    // 恢复后不拿没核验过的锚当分子
    expect(revived.measure().baseline.kind).toBe('estimated');
    expect(revived.measure().projectedTokens).toBeUndefined();

    // 载荷与锚同构 ⇒ 下一次读数核验通过、归位到 usage
    const reading = readPressure(revived, {
      model: MODEL,
      toolSchemas: SCHEMAS,
      toolsTokens: 0,
      payload: base,
      transientReminders: [],
    });
    expect(reading).toEqual({ tokens: 1_500, basis: 'usage' });
    expect(revived.measure().projectedTokens).toBe(1_500);
  });

  it('旧存档（无锚字段）⇒ 无锚，按估算读（不迁移、不假装）', () => {
    const meter = SessionTokenMeter.restore({
      version: 1,
      totals: {},
      attempts: 3,
      turns: [],
      surfaceTokens: 800,
    } as never);
    expect(meter.anchor()).toBeUndefined();
    expect(meter.measure().baseline).toEqual({ kind: 'estimated', tokens: 800 });
  });
});
