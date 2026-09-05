// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// builtin-roster — 第一方内置产物名册（单一真源，2026-09-06 事故立法）。
//
// 数据本体在 builtin-roster.json（31 个 feature 产物的清单事实：dir /
// buildOrder / description / entry / hostModule / inject / face / define）；
// 本文件是薄类型包装 + 派生 helper——TS 侧经 resolveJsonModule import JSON，
// Node 构建脚本直读同一 JSON（零 loader，无双格式漂移）。
//
// 职责边界（不双轨铁律）：
//   - 名册记「清单事实」：哪些目录算内置产物、装载序（buildOrder）、怎么打包
//     （entry/hostModule/face/define）、依赖哪些 service（inject）、UI 展示
//     （description）。各 builtin/index.ts 的插件对象 inject 必须与名册一致
//     （守卫测试对拍——名册权威，源码违反即红）。
//   - name（= "hologram/" + dir）派生，不在名册手写。
//   - service（14 内核，无目录非产物）不进本名册，仍留 first-party-manifest。

import roster from './builtin-roster.json';

/** 名册条目（JSON 事实——加字段时同步更新本类型 + gen-builtin-manifests.mjs）。 */
export interface BuiltinRosterEntry {
  dir: string;
  /** 装载序（字节契约真源——消费方按此排序，防隐式数组序误插）。 */
  buildOrder: number;
  /** UI 展示文案（first-party-manifest feature 段从此读，勿双写）。 */
  description: string;
  /** esbuild 入口文件名（相对 dir；默认 index.ts，renderers 特例 index.tsx）。 */
  entry: string;
  /** host.aliased 桥模块名（默认 host，renderers 特例 renderer-host）。 */
  hostModule: string;
  /** 依赖的 ctx service 名（cordis 注入面——各 builtin/index.ts 插件对象的
   *  inject 必须与此对拍；产物 manifest 的 inject 由此生成）。 */
  inject: string[];
  /** UI 面（产物需注入 entry.css 产物标记；仅 canvas-nav/paper-shell/
   *  settings-domain/compose-dock/paper-minimap 五面）。 */
  face?: boolean;
  /** esbuild define 注入（仅 renderers 特例：ROW_PREFIX）。 */
  define?: Record<string, string>;
}

/** 名册条目数组（buildOrder 升序——装载/构建/清单共用的唯一序）。 */
export const BUILTIN_ROSTER: readonly BuiltinRosterEntry[] = [...roster].sort((a, b) => a.buildOrder - b.buildOrder);

/** 名册条目按 dir 索引（守卫/生成器 O(1) 寻址）。 */
export const BUILTIN_ROSTER_BY_DIR: ReadonlyMap<string, BuiltinRosterEntry> = new Map(
  BUILTIN_ROSTER.map((e) => [e.dir, e]),
);

/** scope 名派生（唯一派生处——禁止任何地方手写 "hologram/<dir>"）。 */
export function builtinScopeName(dir: string): string {
  return 'hologram/' + dir;
}

/** 名册覆盖的 dir 集合（守卫测试对拍磁盘目录集用）。 */
export function rosterDirs(): ReadonlySet<string> {
  return new Set(BUILTIN_ROSTER.map((e) => e.dir));
}

/** 名册覆盖的 scope 名集合（守卫测试对拍 factory-products 集用）。 */
export function rosterScopeNames(): ReadonlySet<string> {
  return new Set(BUILTIN_ROSTER.map((e) => builtinScopeName(e.dir)));
}
