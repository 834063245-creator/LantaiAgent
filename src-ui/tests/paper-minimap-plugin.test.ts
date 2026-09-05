// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-minimap-plugin — 小地图插件化（2026-09-05）守护测试。
// 覆盖：
//   - 插件对象形状（name/apply/inject——WO-S0B 契约）
//   - apply 后经 ctx.overlays 注册到 right-edge 槽（mock overlays service）
//   - manifest.json 与插件 name 一致（产物域寻址契约）
//   - 四大登记点完备（factory-products 表 + first-party-manifest 清单）

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paperMinimapPlugin } from '../src/plugins/builtin/paper-minimap';
import { FIRST_PARTY_MANIFEST } from '../src/plugins/first-party-manifest';

const PLUGIN = paperMinimapPlugin;

describe('paper-minimap 插件对象形状（WO-S0B 契约）', () => {
  it('name / apply / default 导出齐备', () => {
    expect(PLUGIN.name).toBe('hologram/paper-minimap');
    expect(typeof PLUGIN.apply).toBe('function');
    expect(PLUGIN.inject).toEqual(['overlays']);
  });

  it('manifest.json 与插件 name 一致（产物域寻址契约）', () => {
    const manifestPath = resolve(__dirname, '../src/plugins/builtin/paper-minimap/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; inject: string[] };
    expect(manifest.name).toBe(PLUGIN.name);
    expect(manifest.inject).toEqual(['overlays']);
  });
});

describe('paper-minimap 登记完备性（四大登记点）', () => {
  it('factory-products.ts 表含 paper-minimap（源码断言——避免循环 import loader 链）', () => {
    const src = readFileSync(resolve(__dirname, '../src/plugins/factory-products.ts'), 'utf8');
    expect(src).toContain("from './builtin/paper-minimap'");
    expect(src).toContain('paperMinimapPlugin,');
  });

  it('build-builtin-plugins.mjs UI_FACES 含 paper-minimap（产物域装载面）', () => {
    const src = readFileSync(resolve(__dirname, '../../scripts/build-builtin-plugins.mjs'), 'utf8');
    expect(src).toContain("'paper-minimap'");
  });

  it('first-party-manifest 清单含 paper-minimap（feature 可禁用）', () => {
    const meta = FIRST_PARTY_MANIFEST['hologram/paper-minimap'];
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe('feature');
    expect(meta?.description.length).toBeGreaterThan(0);
  });

  it('Rust plugin_assets 回退白名单含 paper-minimap（打包态资产回退第五登记点）', () => {
    // 2026-09-06 事故立法：前端四处登记点（factory-products / build UI_FACES /
    // first-party-manifest / host-modules）齐备但 Rust BUILTIN_PLUGIN_NAMES 漏加
    // → 产物通道 manifest fetch 404 → 装载 error → 小地图整体消失。
    // 守护：白名单 ↔ 源码 manifest 全量对拍在 Rust 侧（builtin_whitelist_matches_
    // source_manifests），此处钉住本插件名已在白名单内。
    const src = readFileSync(resolve(__dirname, '../../src-tauri/src/plugin_assets.rs'), 'utf8');
    const whitelistMatch = src.match(/const BUILTIN_PLUGIN_NAMES: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(whitelistMatch).not.toBeNull();
    expect(whitelistMatch![1]).toContain('"hologram/paper-minimap"');
  });
});

describe('paper-minimap apply 注册到 overlays right-edge 槽', () => {
  it('apply 经 ctx.overlays.register 贡献 MinimapView（right-edge）', () => {
    const registered: Array<{ id: string; slot: string }> = [];
    const fakeCtx = {
      // cordis effect：fiber 装配时同步执行注册（返回 disposer）
      effect: (fn: () => unknown, _label: string) => {
        fn();
      },
      overlays: {
        register: (def: { id: string; slot: string }) => {
          registered.push(def);
          return () => {};
        },
      },
    };
    PLUGIN.apply(fakeCtx as never);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe('paper-minimap');
    expect(registered[0]!.slot).toBe('right-edge');
  });
});
