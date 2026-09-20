// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 案卷侧栏**双视角**（案卷 ⇄ 枝）的纯模型面（立项件 `docs/plans/sidebar-two-views-plan.md` §3 P1）：
//   ① 族（`familyForest`）：一族 = 根卷 + 整棵子树；族序 = 族内最新 savedAt 倒序；无子根卷 = 独立卷；
//   ② 折角素材（`treeRows` 补 `lastAt` / `kids`）：逐层「是否末子」+ 直系子行数；
//   ③ 检索保祖先链（`withAncestorContext`）：命中行 + 其祖先上下文行（`contextOnly`，幂等）。
//
// 纯函数面直测（不走渲染）；渲染面见 tests/session-sidebar-tree.test.tsx 与
// tests/session-sidebar-views.test.tsx。

import { describe, expect, it } from 'vitest';
import {
  familyForest,
  type SidebarRow,
  treeRows,
  withAncestorContext,
} from '../src/plugins/builtin/canvas-nav/session-sidebar-model';

const T = (n: number) => `2026-01-0${n}T00:00:00Z`;

function row(id: number, extra: Partial<SidebarRow> = {}): SidebarRow {
  return { id, label: `卷${id}`, savedAt: T(1), open: false, msgCount: 1, status: 'idle', ...extra };
}

describe('族（familyForest）——枝视图的呈现单位', () => {
  it('一族 = 根卷 + 整棵子树（跨摊开/已合卷，族不拆）；族序按族内最新 savedAt 倒序', () => {
    const rows = [
      row(1, { savedAt: T(1) }), // 甲族根（旧）
      row(2, { parentId: 1, savedAt: T(2), open: true }), // 甲族子（新 → 整族算 2 的时间）
      row(3, { parentId: 2, savedAt: T(2) }), // 孙
      row(9, { savedAt: T(3) }), // 乙族根（更新 → 排前）
      row(10, { parentId: 9, savedAt: T(1) }),
    ];
    const { families, solo } = familyForest(rows);
    expect(families.map((f) => f.root.id)).toEqual([9, 1]); // 乙族(3) 在 甲族(2) 前
    expect(families[1].rows.map((r) => [r.id, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(solo).toEqual([]);
  });

  it('无子根卷 = 独立卷（单独成组）；有子但父不在场（悬空）仍成族', () => {
    const { families, solo } = familyForest([
      row(1), // 独立卷
      row(4, { parentId: 99 }), // 悬空根（父不在场）
      row(5, { parentId: 4 }), // 悬空根的子 → 与它同族
      row(6), // 独立卷
    ]);
    expect(solo.map((r) => r.id)).toEqual([1, 6]);
    expect(families).toHaveLength(1);
    expect(families[0].rows.map((r) => [r.id, r.depth])).toEqual([
      [4, 0],
      [5, 1],
    ]);
  });

  it('坏血缘（环）绝不吞行：成环的行仍各自出场，不递归死循环', () => {
    const { families, solo } = familyForest([row(1, { parentId: 2 }), row(2, { parentId: 1 })]);
    expect(
      [...families.flatMap((f) => f.rows.map((r) => r.id)), ...solo.map((r) => r.id)].sort((a, b) => a - b),
    ).toEqual([1, 2]);
  });
});

describe('折角素材（treeRows 补 kids / lastAt）', () => {
  it('kids = 直系子行数；lastAt 逐层标记「是否末子」（引线 ├ / └ 的判据）', () => {
    const rows = [
      row(1), // 根：两子（也是唯一的根 ⇒ 第 0 层恒 true）
      row(2, { parentId: 1 }), // 长子（非末）
      row(3, { parentId: 1 }), // 末子
      row(4, { parentId: 3 }), // 末子之子（末）
    ];
    const tree = treeRows(rows, new Set([1, 2, 3, 4]));
    // lastAt[i] = 第 i 层那个节点**是否为末子**（0 = 根层；引线只读第 1..depth 层）
    expect(tree.map((r) => [r.id, r.depth, r.kids, r.lastAt])).toEqual([
      [1, 0, 2, [true]],
      [2, 1, 0, [true, false]],
      [3, 1, 1, [true, true]],
      [4, 2, 0, [true, true, true]],
    ]);
  });
});

describe('检索保祖先链（withAncestorContext）', () => {
  const all = [
    row(1), // 根（未命中）
    row(2, { parentId: 1 }), // 中（未命中）
    row(3, { parentId: 2 }), // 命中
    row(7), // 另一根
  ];

  it('命中行前补齐根→父的祖先链，标 contextOnly；顺序为 根→父→命中', () => {
    const out = withAncestorContext([all[2]], all);
    expect(out.map((r) => [r.id, r.contextOnly ?? false])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it('祖先本身是命中行 ⇒ 不重复补（幂等）；无父的命中行原样留下', () => {
    const out = withAncestorContext([all[0], all[1], all[2]], all);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.every((r) => r.contextOnly === undefined)).toBe(true);
    const only = withAncestorContext([all[3]], all);
    expect(only.map((r) => r.id)).toEqual([7]);
  });

  it('两处命中共享祖先：祖先只补一次（不因命中数重复）', () => {
    const rows2 = [row(1), row(2, { parentId: 1 }), row(5, { parentId: 1 })];
    const out = withAncestorContext([rows2[1], rows2[2]], rows2);
    expect(out.map((r) => [r.id, r.contextOnly ?? false])).toEqual([
      [1, true],
      [2, false],
      [5, false],
    ]);
  });
});
