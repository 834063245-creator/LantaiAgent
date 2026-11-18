// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// plugins/builtin/paper-shell/ShelfOverlay — **架阁**（docs/plans/entity-shelf-plan.md B3）
//
// 顶部那枚「架阁」字件点开的浮层：两页（软件型 / 卡片型），用户 2026-12-08 拍板。
//
// 形态纪律：**只取既有标准件**——纸片照 `.pp-toc-card`（纸底 / 强线 / 菜单落影 /
// 宋体位），文字照 `--fs-body` / `--ink-1`，**刻意不透明**（半透明会与底下正文糊字，
// `app/tip/tip.css` 头注已立此判据）。不自造色、不自造动效、不加图标。
//
// 数据纪律：
//   - 软件页读 `plugin-window-store` 的 defs（**零新数据源**，装载即登记）；
//   - 卡片页读 `card_list` RPC——**读失败必须可见**（页面级错误条），不静默成空态；
//   - 两页空态各给一句实话 + 一个出口，不做假数据。

import { useEffect, useState } from 'react';
import { listCards, usePluginWindowStore, useShelfStore } from './host';
import './shelf.css';

const PAGE_LABEL = { app: '软件型', card: '卡片型' } as const;
type Page = keyof typeof PAGE_LABEL;

/** 卡片摘要的最小形状（渲染只用这三样；Rust 侧的完整形状见 card_store.rs）。 */
interface CardRow {
  cardId: string;
  kind: unknown;
  title: unknown;
  shelvedAt: unknown;
}

function formatAt(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ShelfOverlay() {
  const open = useShelfStore((s) => s.open);
  const page = useShelfStore((s) => s.page) as Page;
  const setPage = useShelfStore((s) => s.setPage);
  const closeShelf = useShelfStore((s) => s.closeShelf);
  const defs = usePluginWindowStore((s) => s.defs);
  const windows = usePluginWindowStore((s) => s.windows);
  const openWindow = usePluginWindowStore((s) => s.openWindow);

  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 每次打开都重读（卡片库是盘上的真源，缓存一份就是第二真相）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(null);
    listCards()
      .then((r) => {
        if (alive) setCards(r.cards as CardRow[]);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setCards([]);
        setLoadError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeShelf();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeShelf]);

  if (!open) return null;

  const apps = Object.values(defs);
  const opened = new Set(windows.map((w) => w.pluginName));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背板点击关闭（与命令面板同款）
    <div className="pp-shelf-mask" onPointerDown={closeShelf}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 浮层本体吞掉背板手势 */}
      <div className="pp-shelf" role="dialog" aria-label="架阁" onPointerDown={(e) => e.stopPropagation()}>
        <header className="pp-shelf-head">
          <span className="pp-shelf-title">架阁</span>
          <nav className="pp-shelf-tabs">
            {(Object.keys(PAGE_LABEL) as Page[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`pp-shelf-tab${page === key ? ' is-on' : ''}`}
                onClick={() => setPage(key)}
              >
                {PAGE_LABEL[key]}
              </button>
            ))}
          </nav>
          <button type="button" className="pp-shelf-close" aria-label="关闭" onClick={closeShelf}>
            ×
          </button>
        </header>

        <div className="pp-shelf-body">
          {page === 'app' ? (
            apps.length === 0 ? (
              <p className="pp-shelf-empty">还没有装软件。装进来的软件会住在这里——去「设置 → 插件」安装一个试试。</p>
            ) : (
              <ul className="pp-shelf-list">
                {apps.map((def) => (
                  <li key={def.pluginName}>
                    <button
                      type="button"
                      className="pp-shelf-item"
                      onClick={() => {
                        openWindow(def.pluginName);
                        closeShelf();
                      }}
                    >
                      <span className="pp-shelf-name">{def.title || def.pluginName}</span>
                      <span className="pp-shelf-meta">
                        {def.mode === 'dock' ? '停靠' : def.mode === 'fullscreen' ? '全屏' : '浮动'}
                        {opened.has(def.pluginName) ? ' · 已开' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : loadError ? (
            <p className="pp-shelf-error">卡片库读取失败：{loadError}</p>
          ) : cards === null ? (
            <p className="pp-shelf-empty">正在读卡片库…</p>
          ) : cards.length === 0 ? (
            <p className="pp-shelf-empty">还没有入阁的卡片。把鼠标移到任意一张卡上，点「入阁」就收进来了。</p>
          ) : (
            <ul className="pp-shelf-list">
              {cards.map((c) => (
                <li key={c.cardId}>
                  <div className="pp-shelf-item is-static">
                    <span className="pp-shelf-name">
                      {typeof c.title === 'string' && c.title
                        ? c.title
                        : typeof c.kind === 'string'
                          ? `${c.kind}（未命名）`
                          : '未命名卡片'}
                    </span>
                    <span className="pp-shelf-meta">
                      {typeof c.kind === 'string' ? c.kind : ''}
                      {formatAt(c.shelvedAt) ? ` · ${formatAt(c.shelvedAt)}` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
