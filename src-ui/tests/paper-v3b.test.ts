// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// paper V3b 无头测试 — 第五贡献通道（块渲染器注册表）+ 纸壳组合层挂载。
// 测试纪律（对齐 cordis-kernel.test.ts）：每用例独立 new Context()、
// await ctx.plugin() fiber、fiber.dispose() 清理——不碰 boot 单例。

import { describe, expect, it } from 'vitest';
import {
  activeRendererContributions,
  type BlockRendererContribution,
  builtinRendererDefs,
  type RenderersService,
  rendererServicePlugin,
  resolveRenderer,
} from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import type { BlockKind } from '../src/paper/block-model';

/** 每用例：装载第五 service 并等 fiber 就绪，返回可清理的 root。 */
async function withRenderers(fn: (svc: RenderersService) => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const fiber = ctx.plugin(rendererServicePlugin);
  await fiber;
  await fn(ctx.renderers);
  await fiber.dispose();
}

/* ═══ 第五贡献通道：RenderersService ═══ */

describe('composition/renderer-service（V3b 第五通道）', () => {
  it('内置灰框渲染器行齐备（十一 kind 全谱，id 惯例 builtin/）', () => {
    const defs = builtinRendererDefs();
    expect(defs.map((d) => d.kind)).toEqual([
      'user',
      'markdown',
      'reasoning',
      'notice',
      'diff',
      'plan',
      'tool',
      'code',
      'toolgroup',
      'subagent',
      'turn-error',
    ]);
    expect(defs.every((d) => d.id.startsWith('builtin/'))).toBe(true);
    expect(defs.every((d) => d.component != null)).toBe(true);
  });

  it('服务装载期注册内置行：八个 kind 全可解析到 builtin/<kind>', async () => {
    await withRenderers(() => {
      for (const kind of ['user', 'markdown', 'diff', 'tool', 'plan', 'reasoning', 'notice', 'code'] as BlockKind[]) {
        const r = resolveRenderer(kind);
        expect(r, kind + ' 应有内置渲染器').toBeDefined();
        expect(r?.id).toBe('builtin/' + kind);
      }
    });
  });

  it('贡献覆盖：后注册的行胜（插件换 markdown 渲染器），不殃及别 kind', async () => {
    await withRenderers((svc) => {
      svc.register({ id: 'custom/markdown', kind: 'markdown', component: () => null });
      expect(resolveRenderer('markdown')?.id).toBe('custom/markdown'); // 后写胜
      expect(resolveRenderer('diff')?.id).toBe('builtin/diff');
    });
  });

  it('重名 id 装载期拒绝（throw，不静默覆盖）', async () => {
    await withRenderers((svc) => {
      expect(() => svc.register({ id: 'custom/x', kind: 'markdown', component: () => null })).not.toThrow();
      expect(() => svc.register({ id: 'custom/x', kind: 'diff', component: () => null })).toThrow(/duplicate/);
    });
  });

  it('disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 dispose 不误删）', async () => {
    await withRenderers((svc) => {
      const a: BlockRendererContribution = { id: 'custom/a', kind: 'markdown', component: () => null };
      const disp1 = svc.register(a);
      disp1();
      disp1(); // 幂等
      expect(activeRendererContributions().find((r) => r.id === 'custom/a')).toBeUndefined();
      svc.register(a); // 重注册（新 disposer）
      disp1(); // 陈旧 disposer 不误删新行
      expect(activeRendererContributions().find((r) => r.id === 'custom/a')).toBeDefined();
    });
  });

  it('兜底行语义：* 行不劫持有专行的 kind（专行优先）', async () => {
    await withRenderers((svc) => {
      svc.register({ id: 'custom/fallback', kind: '*', component: () => null });
      expect(resolveRenderer('plan')?.id).toBe('builtin/plan'); // 专行胜
      expect(resolveRenderer('tool')?.id).toBe('builtin/tool');
    });
  });

  it('服务随挂载 fiber dispose 注销（provide 语义——对齐四 service 测试）', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(rendererServicePlugin);
    await fiber;
    expect(ctx.reflect.get('renderers')).toBeDefined();
    await fiber.dispose();
    expect(ctx.reflect.get('renderers')).toBeUndefined();
  });
});

/* ═══ 纸壳挂载（paperPlugin：组合层面板贡献）═══ */

describe('paper/paper-plugin（V3b 壳装配）', () => {
  async function withServices(fn: (ctx: Context) => void | Promise<void>): Promise<void> {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const { paperPlugin } = await import('../src/plugins/builtin/paper-shell');
    const f2 = ctx.plugin(paperPlugin);
    await f2;
    await fn(ctx);
    await f2.dispose();
    await f1.dispose();
  }

  it('注册面板贡献：id=paper、全屏覆盖、关即卸载', async () => {
    await withServices((ctx) => {
      const paper = ctx.panels.list().find((p) => p.id === 'paper');
      expect(paper).toBeDefined();
      expect(paper?.side).toBeNull(); // 全屏覆盖（遮主视图拍板沿用）
      expect(paper?.unmountOnClose).toBe(true);
      expect(paper?.component).toBeDefined();
    });
  }, 15_000);

  it('panelDefs() 合流含 paper 贡献；常量面零 paper 行（迁出证据）', async () => {
    await withServices(async () => {
      const mod = await import('../src/app/panels/panel-def');
      expect(mod.panelDefs().find((p) => p.id === 'paper')).toBeDefined(); // 经贡献合流
      expect(mod.PANEL_DEFS.find((p) => p.id === 'paper')).toBeUndefined(); // 常量面已迁出
    });
  }, 15_000);

  it('paperPlugin 的 disposer 登记（ctx.effect——fiber dispose 即干净退出）', async () => {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const { paperPlugin } = await import('../src/plugins/builtin/paper-shell');
    const f2 = ctx.plugin(paperPlugin);
    await f2;
    expect(ctx.panels.get('paper')).toBeDefined();
    await f2.dispose(); // paperPlugin fiber 释放 → 面板贡献消失
    expect(ctx.panels.get('paper')).toBeUndefined();
    await f1.dispose();
  }, 15_000);
});
