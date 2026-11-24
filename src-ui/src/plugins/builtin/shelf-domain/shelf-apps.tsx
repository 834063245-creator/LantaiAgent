// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shelf-apps — 器物页（名册）：在窗 / 软件 / 面板 三段。
//
// 形态纪律（2026-11-24 全量迭代）：
//   - 一行 = 方点（朱砂实心 = 已开）+ 名 + 机读副行（插件名 · 形制 · 尺寸）+ 常显动作；
//     动作不再 hover 才出（触屏与键盘都够不着 hover 那一档——旧架阁的实机病灶）。
//   - 判据与原来的两道过滤逐字一致：`side !== null`（side:null 不上轨道，不是软件）、
//     `frame !== 'self'`（书脊/案卷是家具，生命周期挂纸上，列进来会在首页开出空侧栏）。
//   - 点行与按 ↵ 同一条路（`run`），行尾动作不抢主路。
//
// 键盘/ARIA：列表容器 `role=listbox` 持焦点（`aria-activedescendant` 指向当前行），
// 行本身 `tabIndex=-1`（同一时刻只有一个键盘停点），行尾动作各自是独立按钮（可 Tab 到）。

import type { ReactNode, RefCallback } from 'react';
import type { ShelfRow, ShelfSection } from './shelf-model';

export interface ShelfAppsProps {
  sections: ShelfSection[];
  /** 当前键盘游标（全页扁平行序；-1 = 未选）。 */
  cursor: number;
  onRun: (row: ShelfRow) => void;
  /** 扁平下标 → 行按钮 ref（滚动进视野用；单一真源与渲染同序）。 */
  rowRef: (index: number) => RefCallback<HTMLButtonElement>;
  /** 搜索另一页有命中时的出口（由壳层给）。 */
  footnote?: ReactNode;
  empty?: ReactNode;
}

export function ShelfApps({ sections, cursor, onRun, rowRef, footnote, empty }: ShelfAppsProps) {
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  if (total === 0) {
    return <div className="shf-empty">{empty}</div>;
  }
  let index = -1;
  return (
    <div className="shf-apps-wrap">
      <div
        className="shf-apps"
        role="listbox"
        aria-label="器物（窗口、软件、面板）"
        aria-activedescendant={cursor >= 0 ? `shf-row-${cursor}` : undefined}
        tabIndex={0}
      >
        {sections.map((sec) => (
          // biome-ignore lint/a11y/useSemanticElements: listbox 内的分段必须是 role=group（fieldset 不能出现在 listbox 里）
          <div key={sec.key} role="group" aria-label={sec.title}>
            <h2 className="shf-sec">
              {sec.title}
              <span className="shf-sec-n">{sec.rows.length}</span>
            </h2>
            <ul className="shf-list">
              {sec.rows.map((row) => {
                index += 1;
                const i = index;
                return (
                  <li key={row.id} className="shf-row-li">
                    <button
                      type="button"
                      id={`shf-row-${i}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === cursor}
                      data-cursor={i === cursor ? 'on' : undefined}
                      className="shf-row"
                      ref={rowRef(i)}
                      onClick={() => onRun(row)}
                    >
                      <span className="shf-dot" data-on={row.on ? 'on' : undefined} />
                      <span className="shf-row-main">
                        <span className="shf-name">{row.title}</span>
                        <span className="shf-sub">{row.sub}</span>
                      </span>
                    </button>
                    {row.acts.length > 0 ? (
                      <span className="shf-acts">
                        {row.acts.map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            className={`shf-act${a.quiet ? ' is-quiet' : ''}`}
                            onClick={a.run}
                          >
                            {a.label}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {footnote}
    </div>
  );
}
