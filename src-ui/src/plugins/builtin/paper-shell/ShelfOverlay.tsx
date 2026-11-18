// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// plugins/builtin/paper-shell/ShelfOverlay — **架阁**（docs/plans/entity-shelf-plan.md B3/B4）
//
// 顶部那枚「架阁」字件点开的浮层：两页（软件型 / 卡片型），用户 2026-12-08 拍板。
// 卡片页点一条 = **展开这张卡**（B4）：html 卡在沙箱里真跑，勾选/输入写回**卡片库**
// （`card_state_write`，不是会话级 asset-state——入阁的卡不属任何会话）。
//
// 形态纪律：**只取既有标准件**——纸片照 `.pp-toc-card`（纸底 / 强线 / 菜单落影 /
// 宋体位），文字照 `--fs-body` / `--ink-1`，**刻意不透明**（半透明会与底下正文糊字，
// `app/tip/tip.css` 头注已立此判据）。不自造色、不自造动效、不加图标。
//
// 数据纪律：
//   - 软件页读 `plugin-window-store` 的 defs（**零新数据源**，装载即登记）；
//   - 卡片页读 `card_list` RPC——**读失败必须可见**（页面级错误条），不静默成空态；
//   - 两页空态各给一句实话 + 一个出口，不做假数据。

import { useEffect, useRef, useState } from 'react';
import { listCards, readCard, usePluginWindowStore, useShelfStore, writeCardState } from './host';
import { buildShelfCardDocument, SHELF_CARD_STATE_NS } from './shelf-card-document';
import './shelf.css';

const PAGE_LABEL = { app: '软件型', card: '卡片型' } as const;
type Page = keyof typeof PAGE_LABEL;

/** 卡片摘要的最小形状（列表只用这三样；Rust 侧完整形状见 card_store.rs）。 */
interface CardRow {
  cardId: string;
  kind: unknown;
  title: unknown;
  shelvedAt: unknown;
}

/** 展开中的一张卡（html 卡带 code，其余 kind 暂时只报类型）。 */
interface OpenedCard {
  cardId: string;
  kind: string;
  title: string;
  code: string | null;
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
  const [opened, setOpened] = useState<OpenedCard | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

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

  // 收起浮层 = 收掉展开的那张（下次打开回到列表，不做"上次看到哪张"的记忆）。
  useEffect(() => {
    if (!open) {
      setOpened(null);
      setOpenError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc 先退一层：展开中 → 回列表；列表 → 关浮层。
      if (opened) setOpened(null);
      else closeShelf();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, opened, closeShelf]);

  // 卡片详图的状态桥：iframe 的 get/patch → 卡片库的 card_read / card_state_write。
  // 只认**本 iframe** 的消息（e.source 校验），回执按 req 配对——与 renderers 的
  // HtmlBody 同一套协议，只换了对面（库而非会话）。
  useEffect(() => {
    if (!opened?.code) return;
    const cardId = opened.cardId;
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const data = e.data as { type?: unknown; req?: unknown; op?: unknown; patch?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type !== SHELF_CARD_STATE_NS || typeof data.req !== 'number') return;
      const req = data.req;
      const reply = (payload: { ok: boolean; state?: unknown; error?: string }) => {
        win.postMessage({ type: SHELF_CARD_STATE_NS, req, ...payload }, '*');
      };
      if (data.op === 'get') {
        readCard(cardId)
          .then((r) => reply({ ok: true, state: r.state }))
          .catch((err: unknown) => reply({ ok: false, error: String(err) }));
        return;
      }
      if (data.op === 'patch') {
        const patch = (data.patch ?? {}) as Record<string, unknown>;
        writeCardState(cardId, patch)
          .then(() => reply({ ok: true }))
          .catch((err: unknown) => reply({ ok: false, error: String(err) }));
        return;
      }
      reply({ ok: false, error: `未知状态操作 '${String(data.op)}'` });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [opened]);

  const openCard = (cardId: string) => {
    setOpenError(null);
    readCard(cardId)
      .then((r) => {
        const card = (r.card ?? {}) as { kind?: unknown; title?: unknown; payload?: unknown };
        const kind = typeof card.kind === 'string' ? card.kind : '';
        const payload = (card.payload ?? {}) as { code?: unknown };
        setOpened({
          cardId,
          kind,
          title: typeof card.title === 'string' ? card.title : '',
          code: kind === 'html' && typeof payload.code === 'string' ? payload.code : null,
        });
      })
      .catch((err: unknown) => setOpenError(`打不开这张卡：${String(err)}`));
  };

  if (!open) return null;

  const apps = Object.values(defs);
  const openedSet = new Set(windows.map((w) => w.pluginName));

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
                onClick={() => {
                  setPage(key);
                  setOpened(null);
                }}
              >
                {PAGE_LABEL[key]}
              </button>
            ))}
          </nav>
          <button type="button" className="pp-shelf-close" aria-label="关闭" onClick={closeShelf}>
            ×
          </button>
        </header>

        {opened ? (
          <div className="pp-shelf-detail">
            <div className="pp-shelf-detail-head">
              <button type="button" className="pp-shelf-back" onClick={() => setOpened(null)}>
                返回
              </button>
              <span className="pp-shelf-detail-title">{opened.title || '未命名卡片'}</span>
              <span className="pp-shelf-meta">{opened.kind}</span>
            </div>
            {opened.code ? (
              <iframe
                ref={frameRef}
                className="pp-shelf-card-frame"
                sandbox="allow-scripts"
                srcDoc={buildShelfCardDocument(opened.code)}
                title={opened.title || '卡片'}
              />
            ) : (
              <p className="pp-shelf-empty">
                这一类卡片（{opened.kind || '未知类型'}）没有可交互的界面，暂时还不能在这里展开。
              </p>
            )}
          </div>
        ) : (
          <div className="pp-shelf-body">
            {openError ? <p className="pp-shelf-error">{openError}</p> : null}
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
                          {openedSet.has(def.pluginName) ? ' · 已开' : ''}
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
                    <button type="button" className="pp-shelf-item" onClick={() => openCard(c.cardId)}>
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
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
