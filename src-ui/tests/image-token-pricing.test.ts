// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 附图 token 记账回归（2026-09-22 补账：读图挂起事故的后续）。
//
// 病灶：构成测量只走文本分词器，**附图一颗 token 都不计**——有图时本地估算
// 系统性小于提供方回报（实测会话 20 那轮 20,457 vs `api_reported.prompt` 22,404），
// 于是占用读数与压缩压力判定（tokenCountWithEstimation）在有图时都少算。
//
// 口径真源 = 提供方**发布**的视觉网格（DSH `llm-deepseek/src/common/image-tokens.ts`
// 逐字移植；本仓 image-tokens.ts）。下面第一组用例逐条锚 DSH 自己的发布算法
// 测试值（`packages/llm/llm-deepseek/tests/request-pricing.spec.ts`）——口径
// 「沿 DSH，禁漂移」的机器化判据：这些数字对不上就是移植漂了，不是「差不多」。

import { describe, expect, it } from 'vitest';
import { estimatePayloadTokens, measureEnvelope } from '../src/agent/token-meter/estimate';
import { countImageTokens, deepSeekImageTokens } from '../src/agent/token-meter/image-tokens';
import type { ChatImageRef, Message, ToolSchema } from '../src/provider/types';

function ref(id: string, width: number, height: number, name?: string): ChatImageRef {
  return { id: id.padEnd(64, '0'), mediaType: 'image/png', bytes: 40_000, width, height, ...(name ? { name } : {}) };
}

function userMsg(content: string, images?: ChatImageRef[]): Message {
  return { role: 'user', content, ...(images ? { images } : {}) };
}

describe('deepSeekImageTokens — 提供方发布算法（锚 DSH 发布测试值）', () => {
  it.each([
    [800, 800, 422],
    [1708, 961, 968],
    [4096, 1, 832],
    [1, 4096, 1024],
    [1187, 1386, 992],
  ])('%sx%s → %s token', (w, h, tokens) => {
    expect(deepSeekImageTokens(w, h)).toBe(tokens);
  });

  it('单图封顶 1024：事故那张 2560×1400（6.46MB）只值 991 token', () => {
    // 事故图（会话 26，21:15:22）：字节 6.46MB、像素 3.58MP——但按发布算法，
    // 保比投影进 1024 token 预算后是 991。**字节不是上下文**，这条用例把它钉住。
    expect(deepSeekImageTokens(2560, 1400)).toBe(991);
    expect(deepSeekImageTokens(2560, 1400)).toBeLessThanOrEqual(1024);
  });

  it('会话 20 那张"读图链路通了"的图（739×578）→ 268 token', () => {
    expect(deepSeekImageTokens(739, 578)).toBe(268);
  });

  it('像素下限内的小图先放大（不因"图小"而白送）', () => {
    // 100×100 = 10k 像素 < 544² 下限 → 放大后再投影
    expect(deepSeekImageTokens(100, 100)).toBeGreaterThan(0);
    expect(deepSeekImageTokens(100, 100)).toBe(deepSeekImageTokens(544, 544));
  });
});

describe('countImageTokens — 载荷侧计价', () => {
  it('user / tool 两侧都计（契约 v40），assistant 不计', () => {
    const msgs: Message[] = [
      userMsg('看图', [ref('a', 739, 578)]),
      { role: 'assistant', content: '嗯' },
      { role: 'tool', content: '截图', tool_call_id: 'c1', name: 'browser', images: [ref('b', 800, 800)] },
      { role: 'user', content: '无图' },
    ];
    expect(countImageTokens(msgs)).toEqual({ tokens: 268 + 422, images: 2 });
  });

  it('无图载荷 → 零（纯文本路径零开销）', () => {
    expect(countImageTokens([userMsg('纯文本')])).toEqual({ tokens: 0, images: 0 });
  });

  it('定价可注入（换非 DeepSeek 血统路由时的口子）', () => {
    const msgs: Message[] = [userMsg('看图', [ref('a', 1000, 1000)])];
    expect(countImageTokens(msgs, (w, h) => w + h).tokens).toBe(2000);
  });
});

describe('measureEnvelope — 附图并入对话段（不新开第四段）', () => {
  const schemas: ToolSchema[] = [];

  it('图计入 messageTokens 与 surfaceTokens，细目单列', () => {
    const withImage = measureEnvelope([userMsg('看图', [ref('a', 739, 578)])], schemas);
    const withoutImage = measureEnvelope([userMsg('看图')], schemas);
    expect(withImage.imageTokens).toBe(268);
    expect(withImage.imageCount).toBe(1);
    expect(withImage.breakdown.messageTokens - withoutImage.breakdown.messageTokens).toBe(268);
    expect(withImage.surfaceTokens - withoutImage.surfaceTokens).toBe(268);
    // 三段加总恒等不变（构成的三项之和 = 载荷估算量）
    const b = withImage.breakdown;
    expect(b.systemTokens + b.toolsTokens + b.messageTokens).toBe(withImage.surfaceTokens);
  });

  it('无图载荷零漂移：imageTokens=0 且三段口径与旧行为逐值相同', () => {
    const env = measureEnvelope([userMsg('纯文本一轮')], schemas, ['提醒']);
    expect(env.imageTokens).toBe(0);
    expect(env.imageCount).toBe(0);
    expect(env.breakdown).toEqual({
      systemTokens: 0,
      toolsTokens: 0,
      messageTokens: env.userTokens + env.transientTokens,
    });
  });

  it('estimatePayloadTokens（坞底墨量线的轻量口径）同样计入附图', () => {
    expect(estimatePayloadTokens([userMsg('看图', [ref('a', 800, 800)])])).toBe(
      estimatePayloadTokens([userMsg('看图')]) + 422,
    );
  });
});
