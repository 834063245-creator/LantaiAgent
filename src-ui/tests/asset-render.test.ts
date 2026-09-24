// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-render — Agent 资产块 WO-4 判据：
//   未知 kind / 资产 kind 未接表现原语时，兜底 '*' 渲染漂亮 JSON 不崩；
//   PaperPanel 文类签映射（KIND_ZH/KIND_EN）已补首发资产 kind。
// 协议：docs/archive/agent-asset-blocks.md §2.7/§2.11/§3（WO-4）。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rendererServicePlugin, resolveRenderer } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { paperRenderersPlugin } from '../src/plugins/builtin/paper-renderers';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  // P1：资产表现原语由内置渲染器插件注册（service 不再构造期注册资产行）
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  // 批 8b：出厂十一 kind 全谱 + '*' 兜底由 paper-renderers 产物注册（service 已回归纯通道）
  const f4 = ctx.plugin(paperRenderersPlugin);
  await f4;
  await fn();
  await f4.dispose();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function assetBlock(kind: string, payload: unknown, presentation = ''): SourcedBlock {
  return {
    ...createBlock(kind, payload as never, { messageId: 'm1', part: null }),
    id: `pb:m1:0`,
    asset: { assetId: 'as_1', presentation, title: 'q4', finalised: true },
  };
}

describe('composition/renderer-service — 资产块兜底 JSON（WO-4）', () => {
  it('未知 kind 解析到 builtin/*；已注册资产表现原语直连表现组件', async () => {
    await withRenderers(() => {
      for (const kind of ['future_custom', 'nope_xyz']) {
        const r = resolveRenderer(kind);
        expect(r?.id).toBe('builtin/*');
        expect(r?.component).toBeTypeOf('function');
      }
      expect(resolveRenderer('chart')?.id).toBe('builtin/chart');
      expect(resolveRenderer('metric')?.id).toBe('builtin/metric');
    });
  });

  it('JsonBody 渲染漂亮 JSON：含 kind 与 payload 原文，不崩', async () => {
    await withRenderers(() => {
      const fallback = resolveRenderer('future_custom');
      expect(fallback).toBeDefined();
      const html = renderToStaticMarkup(
        createElement(fallback!.component, { block: assetBlock('future_custom', { type: 'bar', data: [1, 2] }, '') }),
      );
      expect(html).toContain('future_custom');
      expect(html).toContain('&quot;type&quot;');
      expect(html).toContain('&quot;data&quot;');
      expect(html).toContain('q4');
    });
  });

  it('非资产未知 kind 也走兜底 JSON（历史/退化数据不裸奔）', async () => {
    await withRenderers(() => {
      const fallback = resolveRenderer('unknown_historic');
      expect(fallback?.id).toBe('builtin/*');
      const html = renderToStaticMarkup(
        createElement(fallback!.component, {
          block: createBlock('unknown_historic', { x: 1 }, { messageId: 'm', part: null }),
        }),
      );
      expect(html).toContain('unknown_historic');
      expect(html).toContain('&quot;x&quot;');
    });
  });
});

describe('PaperPanel 文类签 — 首发资产 kind 有中文签（WO-4）', () => {
  it('KIND_ZH/KIND_EN 常量覆盖首发资产 kind（防签破版）', async () => {
    // 常量未导出，但通过源码断言保证回归面；若未来迁出此处同步更新。
    const src = await import('../src/plugins/builtin/paper-shell/PaperPanel.tsx?raw');
    expect(src.default).toContain("table: '表格'");
    expect(src.default).toContain("chart: '图表'");
    expect(src.default).toContain("metric: '指标'");
    expect(src.default).toContain("deps_impact: '影响'");
    expect(src.default).toContain("html: '卡片'");
    expect(src.default).toContain("confirm: '确认'");
  });
});
