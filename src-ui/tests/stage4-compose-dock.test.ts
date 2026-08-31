// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-4 §4.5 插件化落位：创作坞/目次带以 ctx.overlays 贡献行注册 +
// 消费 ctx.space 对拍；fiber dispose 干净退出。

import { describe, expect, it } from 'vitest';
import { activeOverlayContributions, overlayServicePlugin } from '../src/composition/overlay-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { spaceServicePlugin } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { composeDockPlugin } from '../src/plugins/builtin/compose-dock';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { TocStrip } from '../src/plugins/builtin/compose-dock/TocStrip';

async function bootComposeDock() {
  const root = new Context();
  const f1 = root.plugin(compositionServicesPlugin);
  await f1;
  const f2 = root.plugin(spaceServicePlugin);
  await f2;
  const f3 = root.plugin(overlayServicePlugin);
  await f3;
  const f4 = root.plugin(composeDockPlugin);
  await f4;
  return { root, f1, f2, f3, f4 };
}

describe('composition/overlay-service（覆盖层贡献通道）', () => {
  it('register→list 按槽位过滤；disposer 幂等', async () => {
    const root = new Context();
    const f = root.plugin(overlayServicePlugin);
    await f;
    const d1 = root.overlays.register({ id: 'c1', slot: 'composer', component: ComposerDock });
    const d2 = root.overlays.register({ id: 'e1', slot: 'right-edge', component: TocStrip });
    expect(activeOverlayContributions('composer').map((c) => c.id)).toEqual(['c1']);
    expect(activeOverlayContributions('right-edge').map((c) => c.id)).toEqual(['e1']);
    d1();
    expect(activeOverlayContributions('composer')).toEqual([]);
    d1(); // 幂等：二次调用不炸
    d2();
    await f.dispose();
  });

  it('重名贡献 throw（不静默覆盖）', async () => {
    const root = new Context();
    const f = root.plugin(overlayServicePlugin);
    await f;
    const d1 = root.overlays.register({ id: 'x', slot: 'composer', component: ComposerDock });
    expect(() => root.overlays.register({ id: 'x', slot: 'composer', component: ComposerDock })).toThrow();
    d1();
    await f.dispose();
  });
});

describe('plugins/compose-dock-plugin（贡献行 + 消费对拍）', () => {
  it('注册 composer / right-edge 双覆盖贡献 + 空间消费命令', async () => {
    const { root, f1, f2, f3, f4 } = await bootComposeDock();
    const composers = activeOverlayContributions('composer');
    const edges = activeOverlayContributions('right-edge');
    expect(composers.map((c) => c.id)).toContain('compose-dock');
    expect(composers.find((c) => c.id === 'compose-dock')?.component).toBe(ComposerDock);
    expect(edges.map((c) => c.id)).toContain('toc-strip');
    expect(edges.find((c) => c.id === 'toc-strip')?.component).toBe(TocStrip);
    // 消费 ctx.space 的证据（命令面）
    expect(root.commands.get('compose/space-status')).toBeDefined();
    expect(root.commands.get('compose/space-status')?.group).toBe('画布');
    await f4.dispose();
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  });

  it('fiber dispose → 覆盖贡献与命令干净退出', async () => {
    const { root, f1, f2, f3, f4 } = await bootComposeDock();
    expect(activeOverlayContributions('composer').some((c) => c.id === 'compose-dock')).toBe(true);
    await f4.dispose();
    expect(activeOverlayContributions('composer').some((c) => c.id === 'compose-dock')).toBe(false);
    expect(activeOverlayContributions('right-edge').some((c) => c.id === 'toc-strip')).toBe(false);
    expect(root.commands.get('compose/space-status')).toBeUndefined();
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  });
});
