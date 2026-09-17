// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 墨量册组件钉（2026-09-13；同日二版按用户「不好看，文字排版搞一下」重排）——
// 创作坞 token 计量装置的显示面：
//   ① 触发器读数（占用百分比 / 无读数 / 近满转警态）；
//   ② 册页排印结构（读数题字 + 副行 + 占用条 + 构成图例 + 两个段题 + 账目）；
//   ③ 事实齐备（压力/投影/四桶/命中率/请求次数/逐轮）与诚实的估算标注。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenMeasurement } from '../src/agent/token-meter/types';
import { InkLedger } from '../src/plugins/builtin/compose-dock/InkLedger';

function stats(over: Partial<TokenMeasurement> = {}): TokenMeasurement {
  return {
    pressureTokens: 24_000,
    projectedTokens: 25_000,
    surfaceTokens: 25_000,
    contextWindow: 200_000,
    usedTokens: 25_000,
    usedSource: 'projected',
    percent: 13,
    breakdown: { systemTokens: 8_000, toolsTokens: 6_000, messageTokens: 11_000 },
    totals: {
      uncachedInputTokens: 96_000,
      cacheReadTokens: 1_100_000,
      cacheWriteTokens: 12_000,
      outputTokens: 34_200,
    },
    attempts: 27,
    turns: [
      {
        turn: 1,
        steps: 2,
        peakPressureTokens: 20_000,
        totalTokens: 21_000,
        uncachedInputTokens: 4_000,
        cacheReadTokens: 16_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
      },
      {
        turn: 2,
        steps: 3,
        peakPressureTokens: 24_000,
        totalTokens: 25_000,
        uncachedInputTokens: 5_000,
        cacheReadTokens: 19_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
      },
    ],
    cacheHitPercent: '92.5',
    last: {
      turn: 2,
      step: 3,
      buckets: { uncachedInputTokens: 5_000, cacheReadTokens: 19_000, cacheWriteTokens: 0, outputTokens: 1_000 },
    },
    ...over,
  };
}

describe('墨量册（创作坞 token 计量装置）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const mount = (props: Parameters<typeof InkLedger>[0]) => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(InkLedger, props));
    });
  };

  it('触发器报占用百分比；点开前不渲染账本', () => {
    mount({ stats: stats(), sessionLabel: '案卷一', open: false, onToggle: vi.fn() });
    const trigger = container.querySelector('.pp-ink-trigger')!;
    expect(trigger.textContent).toContain('墨 13%');
    expect(container.querySelector('.pp-ink-panel')).toBeNull();
  });

  it('近满（>80%）触发器与读数题字同转警态（全册唯一朱字）', () => {
    mount({ stats: stats({ percent: 91 }), sessionLabel: '案卷四', open: true, onToggle: vi.fn() });
    expect(container.querySelector('.pp-ink-trigger')!.className).toContain('full');
    const percent = container.querySelector('.pp-ink-percent')!;
    expect(percent.className).toContain('full');
    expect(percent.textContent).toBe('91%');
  });

  it('册页排印结构：书眉 → 读数题字 + 副行 → 占用条 → 构成图例 → 两段账目', () => {
    mount({ stats: stats(), sessionLabel: '案卷一', open: true, onToggle: vi.fn() });
    const panel = container.querySelector('.pp-ink-panel')!;
    const order = [...panel.children].map((el) => el.className);
    expect(order[0]).toBe('pp-ink-head');
    expect(order[1]).toBe('pp-ink-reading');
    expect(order[2]).toBe('pp-ink-note');
    expect(order[3]).toBe('pp-ink-bar');
    expect(order[4]).toBe('pp-ink-legend');
    expect(order[5]).toBe('pp-ink-section');
    expect(order[6]).toBe('pp-ink-ledger');
    expect(order[7]).toBe('pp-ink-section');
    expect(order[8]).toBe('pp-ink-ledger');
    expect(order[9]).toBe('pp-ink-foot');
    // 读数题字有一枚小字距标签陪衬（不是裸数字）
    expect(container.querySelector('.pp-ink-reading-label')?.textContent).toBe('上下文已用');
    // 段题 = 方墨锚点 + 题字（浸墨⑤：节题墨块）
    const sections = [...container.querySelectorAll('.pp-ink-section')];
    expect(sections.map((s) => s.querySelector('.pp-ink-section-title')?.textContent)).toEqual(['账目', '本轮']);
    expect(sections.every((s) => s.querySelector('.pp-ink-section-mark') !== null)).toBe(true);
  });

  it('账目：四桶 + 合计 + 命中率，逐行 dt/dd 两列（数值右对齐靠 CSS 网格）', () => {
    mount({ stats: stats(), sessionLabel: '案卷一', open: true, onToggle: vi.fn() });
    const lines = [...container.querySelectorAll('.pp-ink-line')];
    const read = (label: string) => {
      const hit = lines.find((l) => l.querySelector('dt')?.textContent === label)!;
      return hit.querySelector('dd')!.textContent;
    };
    expect(read('未缓存输入')).toBe('96,000');
    expect(read('缓存读')).toBe('1,100,000');
    expect(read('缓存写')).toBe('12,000');
    expect(read('输出')).toBe('34,200');
    expect(read('合计')).toBe('1,242,200');
    expect(read('缓存命中')).toBe('92.5%');
    expect(read('请求')).toBe('27 次');
    expect(read('第 2 轮')).toBe('25,000');
    // 合计行是唯一 strong（账目收口）
    expect(lines.filter((l) => l.className.includes('strong'))).toHaveLength(1);
    expect(lines.find((l) => l.className.includes('strong'))?.querySelector('dt')?.textContent).toBe('合计');
    // 每行都是 dt/dd 对（两列网格：数值列右对齐）
    for (const line of lines) {
      expect(line.querySelector('dt')).not.toBeNull();
      expect(line.querySelector('dd')).not.toBeNull();
    }
  });

  it('副行 = 分子/分母 + 下一请求预计；来源徽记在书眉（回报 / 估算）', () => {
    mount({ stats: stats(), sessionLabel: '案卷一', open: true, onToggle: vi.fn() });
    expect(container.querySelector('.pp-ink-note')?.textContent).toContain('25k / 200k tok');
    expect(container.querySelector('.pp-ink-note')?.textContent).toContain('下一请求预计 ~25k');
    expect(container.querySelector('.pp-ink-head-figures')?.textContent).toBe('回报');

    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    mount({
      stats: stats({ pressureTokens: undefined, projectedTokens: undefined, usedSource: 'surface' }),
      sessionLabel: '案卷二',
      open: true,
      onToggle: vi.fn(),
    });
    expect(container.querySelector('.pp-ink-head-figures')?.textContent).toBe('估算');
    expect(container.querySelector('.pp-ink-note')?.textContent).toContain('~25k / 200k tok');
    expect(container.querySelector('.pp-ink-note')?.textContent).not.toContain('下一请求预计');
  });

  it('构成图例三格与占用条同序同色相；无构成数据时退单段条 + 无图例', () => {
    mount({ stats: stats(), sessionLabel: '案卷一', open: true, onToggle: vi.fn() });
    const legend = [...container.querySelectorAll('.pp-ink-legend > li')];
    expect(legend.map((li) => li.querySelector('.pp-ink-legend-label')?.textContent)).toEqual(['系统', '工具', '对话']);
    expect(legend.map((li) => li.querySelector('.pp-ink-legend-value')?.textContent)).toEqual(['~8k', '~6k', '~11k']);
    expect(legend[0]?.querySelector('.pp-ink-swatch')?.className).toContain('pp-ink-seg-system');
    expect(container.querySelectorAll('.pp-ink-bar .pp-ink-seg')).toHaveLength(3);

    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    mount({
      stats: stats({ breakdown: undefined }),
      sessionLabel: '案卷一',
      open: true,
      onToggle: vi.fn(),
    });
    expect(container.querySelector('.pp-ink-legend')).toBeNull();
    const single = container.querySelectorAll('.pp-ink-bar .pp-ink-seg');
    expect(single).toHaveLength(1);
    expect(single[0]?.className).toContain('pp-ink-seg-total');
  });

  it('无句柄/无账本：触发器给「—」，读数给「—」并说明窗口未知（不编造）', () => {
    mount({ stats: null, sessionLabel: '案卷三', fallbackTotal: 12_345, open: true, onToggle: vi.fn() });
    expect(container.querySelector('.pp-ink-trigger')!.textContent).toContain('墨 —');
    expect(container.querySelector('.pp-ink-percent')?.textContent).toBe('—');
    expect(container.querySelector('.pp-ink-note')?.textContent).toContain('窗口未知');
    // 兜底总量仍如实给（卷文件里的旧值）
    const lines = [...container.querySelectorAll('.pp-ink-line')];
    const read = (label: string) =>
      lines.find((l) => l.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
    expect(read('合计')).toBe('12,345');
    expect(read('缓存命中')).toBe('—');
  });
});
