// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物自动重载守护（landmine H1/H4 收口的第三环，2026-09-20）。
//
// 病灶链（改插件「没生效」的三种读法，前两种是静默的）：
//   ① 只跑构建不镜像 → exe 重载旧文件（H1，构建脚本已自动镜像）；
//   ② 镜像了但入口 URL 无版本号 → 模块图回旧模块（H4，loader 已带 `?v=`）；
//   ③ 镜像+版本号都有了，用户还得记得点「重新加载」——本模块把这一步也自动化：
//      盯 `_rev.json`（构建脚本写的内容指纹表），变了就重载对应插件。
//
// 本文件钉四件事：
//   ① 首轮 = 基线（不重载）；指纹变化 → 只重载变更的那一个；
//   ② 重载走真实 loader 路径（dispose → setup），且**每次 import URL 恒新**（H4 集成面）；
//   ③ 用户禁用的插件不自动重载（plugin-prefs 唯一权威）；
//   ④ 无修订表（旧产物包/第三方）连续缺失即停轮询——退化可见，不空转、不误重载。

import { beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../src/cordis';
import { loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { parseProductRev, startProductWatch } from '../src/plugins/product-watch';
import { usePluginPrefs } from '../src/state/plugin-prefs';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';
const REV_URL = ORIGIN + '/_rev.json';

const MANIFESTS: Record<string, { name: string; version: string; entry: string }> = {
  hello: { name: 'hello', version: '1.0.0', entry: 'entry.js' },
  world: { name: 'world', version: '1.0.0', entry: 'entry.js' },
};

interface Fixture {
  /** 修订表（null = 通道无此文件，即 404）。 */
  rev: Record<string, string> | null;
  /** 每次 import 的 URL（H4：必须恒新）。 */
  imports: string[];
  probe: { events: string[] };
}

function makeFetch(fx: Fixture): (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> {
  const routes: Record<string, unknown> = {
    [ORIGIN + '/']: ['hello', 'world'],
    [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
    [ORIGIN + '/hello/manifest.json']: MANIFESTS.hello,
    [ORIGIN + '/world/manifest.json']: MANIFESTS.world,
  };
  return async (url: string) => {
    if (url === REV_URL) {
      return fx.rev == null ? { ok: false, json: async () => null } : { ok: true, json: async () => fx.rev };
    }
    return url in routes ? { ok: true, json: async () => routes[url] } : { ok: false, json: async () => null };
  };
}

function makeImport(fx: Fixture): (url: string) => Promise<Record<string, unknown>> {
  return async (url: string) => {
    fx.imports.push(url);
    const name = url.includes('/world/') ? 'world' : 'hello';
    return {
      default: {
        name,
        apply(ctx: { effect: (f: () => () => void, label: string) => unknown }) {
          ctx.effect(() => {
            fx.probe.events.push(`${name}:setup`);
            return () => fx.probe.events.push(`${name}:dispose`);
          }, `${name}-probe`);
        },
      },
    };
  };
}

async function bootProducts(fx: Fixture): Promise<Context> {
  const root = new Context();
  await loadExternalPlugins(root, { origin: ORIGIN, fetchImpl: makeFetch(fx), importModule: makeImport(fx) });
  return root;
}

beforeEach(() => {
  resetPluginRuntimeForTests();
  usePluginStore.getState().setPlugins([]);
  usePluginPrefs.getState().resetForTests();
});

describe('产物自动重载（_rev.json → activateExternalPlugin）', () => {
  it('① 首轮 = 基线不重载；指纹变化 → 只重载变更的那一个，且 import URL 恒新', async () => {
    const fx: Fixture = { rev: { hello: 'r1', world: 'r1' }, imports: [], probe: { events: [] } };
    await bootProducts(fx);
    expect(fx.probe.events).toEqual(['hello:setup', 'world:setup']);

    const watch = startProductWatch({ origin: ORIGIN, fetchImpl: makeFetch(fx), intervalMs: 3_600_000 });
    expect(await watch.pollOnce()).toEqual([]); // 首轮建立基线
    expect(fx.probe.events).toEqual(['hello:setup', 'world:setup']);

    fx.rev = { hello: 'r1', world: 'r2' }; // 用户操作：改了插件 → 构建脚本换产物 → 指纹变
    expect(await watch.pollOnce()).toEqual(['world']);
    expect(fx.probe.events).toEqual(['hello:setup', 'world:setup', 'world:dispose', 'world:setup']);
    // H4 集成面：每次装载的入口 URL 都不同（相同 = 模块图回旧模块）
    expect(new Set(fx.imports).size).toBe(fx.imports.length);

    watch.stop();
    expect(await watch.pollOnce()).toEqual([]); // stop 后不再轮询（幂等）
  });

  it('② 用户禁用的插件不自动重载（plugin-prefs 是唯一权威）', async () => {
    const fx: Fixture = { rev: { hello: 'r1', world: 'r1' }, imports: [], probe: { events: [] } };
    await bootProducts(fx);
    const watch = startProductWatch({ origin: ORIGIN, fetchImpl: makeFetch(fx), intervalMs: 3_600_000 });
    await watch.pollOnce();

    usePluginPrefs.getState().setDisabled('world', true);
    fx.rev = { hello: 'r2', world: 'r2' };
    expect(await watch.pollOnce()).toEqual(['hello']); // world 被跳过
    expect(fx.probe.events).not.toContain('world:dispose');
    watch.stop();
  });

  it('③ 修订表新增 = 装载；条目移除 = 停用（`-名字`）', async () => {
    const fx: Fixture = { rev: { hello: 'r1' }, imports: [], probe: { events: [] } };
    await bootProducts(fx);
    const watch = startProductWatch({ origin: ORIGIN, fetchImpl: makeFetch(fx), intervalMs: 3_600_000 });
    await watch.pollOnce();

    fx.rev = { hello: 'r1', world: 'r1' }; // 新产品出现在产物根
    expect(await watch.pollOnce()).toEqual(['world']);
    fx.rev = { world: 'r1' }; // hello 的产物被撤掉
    expect(await watch.pollOnce()).toEqual(['-hello']);
    watch.stop();
  });

  it('④ 无修订表（旧产物包/第三方）：连续缺失即停轮询，之后不再误重载', async () => {
    const fx: Fixture = { rev: null, imports: [], probe: { events: [] } };
    await bootProducts(fx);
    const watch = startProductWatch({ origin: ORIGIN, fetchImpl: makeFetch(fx), intervalMs: 3_600_000 });
    for (let i = 0; i < 5; i++) expect(await watch.pollOnce()).toEqual([]);
    fx.rev = { hello: 'r9', world: 'r9' }; // 通道恢复也不再看（已停）
    expect(await watch.pollOnce()).toEqual([]);
    expect(fx.probe.events).toEqual(['hello:setup', 'world:setup']);
  });

  it('⑤ 修订表形状守卫：坏形状 = 无信号源，空表 = 无产物（不得读成「全删」）', () => {
    expect(parseProductRev(null)).toBeNull();
    expect(parseProductRev('nope')).toBeNull();
    expect(parseProductRev(['a'])).toBeNull();
    expect(parseProductRev({ a: 1, b: 'x', c: '' })).toEqual({ b: 'x' });
  });
});
