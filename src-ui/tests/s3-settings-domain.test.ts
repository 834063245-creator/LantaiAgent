// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S3 settings 域行化测试 — 面板/命令双贡献 + runAction 别名翻译层。
// 测试纪律（对齐 composition-consumption-wiring.test.ts）：每用例独立
// new Context()、await ctx.plugin() fiber、fiber.dispose() 清理——不碰
// boot 单例。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_CONTRIBUTION_ALIASES, runAction } from '../src/app/actions';
import { PANEL_DEFS, panelDefs } from '../src/app/panels/panel-def';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { paperPlugin } from '../src/paper/paper-plugin';
import { settingsPlugin } from '../src/plugins/settings-plugin';
import { useDockStore } from '../src/state/dock-store';

/** 装载四 service + 待测域插件（S3 后装载序：services → plugin）。 */
async function bootWith(plugin: { name: string; inject: string[]; apply: (ctx: Context) => void }) {
  const root = new Context();
  const f1 = root.plugin(compositionServicesPlugin);
  await f1;
  const f2 = root.plugin(plugin as never);
  await f2;
  return { root, f1, f2 };
}

describe('S3 B1：runAction 别名翻译层（app/actions.ts）', () => {
  it('别名表双键齐全（toggle-settings / toggle-paper → 域贡献 id）', () => {
    expect(ACTION_CONTRIBUTION_ALIASES['toggle-settings']).toBe('settings/toggle');
    expect(ACTION_CONTRIBUTION_ALIASES['toggle-paper']).toBe('paper/toggle');
  });

  it('静态注册命中时别名层不参与（既有动作优先）', async () => {
    const { registerActions } = await import('../src/app/actions');
    let fired = false;
    registerActions([{ id: 'probe-static', group: '测试', label: '静态', run: () => (fired = true) }]);
    runAction('probe-static');
    expect(fired).toBe(true);
  });

  it('无别名 + 未注册 → 静默不炸（启动早期安全语义不变）', () => {
    expect(() => runAction('nonexistent-action')).not.toThrow();
  });

  it('别名 → 贡献桥接全链路：runAction 经翻译执行 local handler（dock 状态翻转）', async () => {
    const { root, f1, f2 } = await bootWith(settingsPlugin);
    const before = useDockStore.getState().open.settings ?? false;
    runAction('toggle-settings'); // 静态注册 miss → 别名 → 贡献 handler
    expect(useDockStore.getState().open.settings).toBe(!before);
    useDockStore.getState().closePanel('settings'); // 复位
    await f2.dispose();
    await f1.dispose();
    void root;
  });

  it('别名存在但贡献缺席（服务未装载/已 dispose）→ 静默不炸', async () => {
    expect(() => runAction('toggle-settings')).not.toThrow(); // 无服务 = 空集
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    expect(() => runAction('toggle-paper')).not.toThrow(); // 有服务无注册
    await fiber.dispose();
  });
});

describe('S3 B2：settingsPlugin 双贡献（面板 + 命令）', () => {
  it('面板贡献逐字段等值迁移（id/side/title/icon/unmountOnClose/component）', async () => {
    const { f1, f2 } = await bootWith(settingsPlugin);
    const p = panelDefs().find((d) => d.id === 'settings');
    expect(p).toBeDefined();
    expect(p?.side).toBeNull();
    expect(p?.title).toBe('设置');
    expect(p?.icon).toBe('settings');
    expect(p?.unmountOnClose).toBe(true);
    expect(p?.component).toBeDefined();
    await f2.dispose();
    await f1.dispose();
  });

  it('命令贡献：id settings/toggle + local 型 handler 翻转 dock', async () => {
    const { root, f1, f2 } = await bootWith(settingsPlugin);
    const cmd = root.commands.get('settings/toggle');
    expect(cmd).toBeDefined();
    expect(cmd?.label).toBe('设置…');
    expect(cmd?.action.type).toBe('local');
    const before = useDockStore.getState().open.settings ?? false;
    if (cmd?.action.type === 'local') cmd.action.handler();
    expect(useDockStore.getState().open.settings).toBe(!before);
    useDockStore.getState().closePanel('settings');
    await f2.dispose();
    await f1.dispose();
  });

  it('fiber dispose → 双贡献干净退出（panelDefs/commands 均无 settings）', async () => {
    const { root, f1, f2 } = await bootWith(settingsPlugin);
    expect(panelDefs().some((d) => d.id === 'settings')).toBe(true);
    await f2.dispose();
    expect(panelDefs().some((d) => d.id === 'settings')).toBe(false);
    expect(root.commands.get('settings/toggle')).toBeUndefined();
    await f1.dispose();
  });
});

describe('S3 B2：paper 域命令补齐（paper/toggle 贡献）', () => {
  it('paperPlugin 命令贡献：id paper/toggle + local 型 handler 翻转 dock', async () => {
    const { root, f1, f2 } = await bootWith(paperPlugin);
    const cmd = root.commands.get('paper/toggle');
    expect(cmd).toBeDefined();
    expect(cmd?.label).toBe('纸视图（开/回案卷首页）');
    expect(cmd?.action.type).toBe('local');
    const before = useDockStore.getState().open.paper ?? false;
    if (cmd?.action.type === 'local') cmd.action.handler();
    expect(useDockStore.getState().open.paper).toBe(!before);
    useDockStore.getState().closePanel('paper');
    await f2.dispose();
    await f1.dispose();
  });

  it("runAction('toggle-paper') 全链路（别名 → 贡献 handler）", async () => {
    const { f1, f2 } = await bootWith(paperPlugin);
    const before = useDockStore.getState().open.paper ?? false;
    runAction('toggle-paper');
    expect(useDockStore.getState().open.paper).toBe(!before);
    useDockStore.getState().closePanel('paper');
    await f2.dispose();
    await f1.dispose();
  });
});

describe('S3 B2：常量面清空 + 壳行迁址对拍（迁移证据）', () => {
  it('PANEL_DEFS 常量面清空（settings 已迁贡献——V3b paper 先例同款证据）', () => {
    expect(PANEL_DEFS).toEqual([]);
    expect(panelDefs()).toEqual([]); // 无服务装载时合流面 = 常量面
  });

  it('壳行 actions 源码断言：面板动作已迁出，留守动作 = open / esc-layer', () => {
    // 对拍迁址后的事实（V5→S3 断言演进；先例：composition-panel-registry.test.ts）
    const src = readFileSync(join(__dirname, '..', 'src', 'shell', 'rows', 'actions.ts'), 'utf8');
    expect(src).toContain("id: 'open',");
    expect(src).toContain("id: 'esc-layer',");
    expect(src).not.toContain("id: 'toggle-settings',"); // 已迁 settings-plugin
    expect(src).not.toContain("id: 'toggle-paper',"); // 已迁 paper-plugin
  });
});
