// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-minimap-plugin — 小地图插件化（2026-09-05）守护测试。
// 覆盖：
//   - 插件对象形状（name/apply/inject——WO-S0B 契约）
//   - apply 后经 ctx.overlays 注册到 right-edge 槽（mock overlays service）
//   - 登记点完备（名册 + factory-products + first-party-manifest；2026-09-06
//     名册单一真源后，源目录 manifest.json 已退役——旧「manifest 一致」断言
//     由 builtin-roster.test.ts 的「名册 === index.ts 对象」守护取代）

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
});

describe('paper-minimap 登记完备性', () => {
  it('factory-products.ts 装配面含 paper-minimap（源码断言——避免循环 import loader 链）', () => {
    const src = readFileSync(resolve(__dirname, '../src/plugins/factory-products.ts'), 'utf8');
    expect(src).toContain("from './builtin/paper-minimap'");
    expect(src).toContain('paperMinimapPlugin,');
  });

  it('builtin-roster 名册含 paper-minimap（产物域装载面——2026-09-06 起 build 规格从名册派生）', () => {
    const roster = JSON.parse(readFileSync(resolve(__dirname, '../src/plugins/builtin-roster.json'), 'utf8')) as Array<{
      dir: string;
      face?: boolean;
    }>;
    const entry = roster.find((e) => e.dir === 'paper-minimap');
    expect(entry).toBeDefined();
    expect(entry?.face).toBe(true); // UI 面——产物需 entry.css
  });

  it('first-party-manifest 清单含 paper-minimap（feature 可禁用）', () => {
    const meta = FIRST_PARTY_MANIFEST['hologram/paper-minimap'];
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe('feature');
    expect(meta?.description.length).toBeGreaterThan(0);
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
