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
import { newRefId, payloadChars, type QuoteCard } from '../../../state/card-quote';
import {
  deleteCard,
  getCanvasStore,
  getChatStore,
  listCards,
  openPluginWindow,
  readCard,
  renameCard,
  useCanvasViewStore,
  useCoreStore,
  usePluginWindowStore,
  useShelfStore,
  useToastStore,
  viewportCenterWorld,
  writeCardState,
} from './host';
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

  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedCard | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 行内改名（改的是卡片库里的 title，卡片身份与内容不动）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

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

  // 行内改名的聚焦（不用 autoFocus：biome 的 a11y 规则禁裸 autoFocus）。
  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  const toast = useToastStore.getState().showToast;

  const commitRename = (cardId: string) => {
    const title = editValue.trim();
    setEditingId(null);
    renameCard(cardId, title)
      .then(() => {
        setCards((prev) => prev?.map((c) => (c.cardId === cardId ? { ...c, title } : c)) ?? prev);
        toast(`已改名：${title || '（未命名）'}`, 'info', 2200, 'composer');
      })
      .catch((err: unknown) => toast(`改名失败：${String(err)}`, 'error', 4200, 'composer'));
  };

  /** 删除 = 挪进卡片库的 .trash（可找回）——所以不做二次确认，只把后果说清楚。 */
  const removeCard = (cardId: string, title: string) => {
    deleteCard(cardId)
      .then(() => {
        setCards((prev) => prev?.filter((c) => c.cardId !== cardId) ?? prev);
        toast(`已删除「${title || '未命名'}」——卡片库的回收站里可找回`, 'info', 3200, 'composer');
      })
      .catch((err: unknown) => toast(`删除失败：${String(err)}`, 'error', 4200, 'composer'));
  };

  /** **引用**（夹签，docs/plans/card-quote-plan.md §2.1 入口二）：把库里这张卡递进
   *  **当前活跃卷**的夹签槽——引用是「给这一轮的通行证」，与「摊到画布」并列。
   *
   *  只取元数据（card.json 的 kind / title）——payload 不进槽（方案 §3.1）；
   *  真内容在发送那一刻才按 cardId 从卡片库读出来落快照（§3.4）。 */
  const quoteCard = (cardId: string) => {
    const core = useCoreStore.getState().core;
    if (!core) {
      toast('引用失败：画布还没准备好', 'warn', 3200, 'composer');
      return;
    }
    const input = getChatStore(core.panelId).input.getState();
    // 没有归属（既无卷也无纸）= 这枚夹签没有地方可去：如实说清楚，不静默丢弃
    if (!input.liveOwner) {
      toast('先展开一卷或落一张纸', 'warn', 3200, 'composer');
      return;
    }
    readCard(cardId)
      .then((r) => {
        const card = (r.card ?? {}) as { kind?: unknown; title?: unknown; payload?: unknown };
        const quote: QuoteCard = {
          refId: newRefId(),
          origin: 'shelf',
          cardId,
          kind: typeof card.kind === 'string' ? card.kind : 'markdown',
          title: typeof card.title === 'string' ? card.title : '',
          bytes: payloadChars(card.payload),
          at: new Date().toISOString(),
        };
        if (!input.addAttachedCard(quote)) {
          toast('已在夹签槽里', 'info', 2200, 'composer');
          return;
        }
        toast(`已引用：${quote.title || '这张卡'}`, 'info', 2200, 'composer');
      })
      .catch((err: unknown) => toast(`引用失败：${String(err)}`, 'error', 4200, 'composer'));
  };

  /** **摊到画布**（架阁 B6，2026-12-08 用户拍板必做）：把库里的一张卡变成画布上的
   *  一条**无源钉**（pins 容器原生支持——"无源 = 纯公共物快照"），落在视口中心。
   *  摊上去就归画布管：能拖、能缩、能拔钉，坐标进 canvas.json（重开还在）。
   *  内容取 card.json 的快照（拔钉前不依赖磁盘），状态仍走卡片库（见 HtmlBody 的
   *  cardId 分路）——**改的永远是库里那一份**。 */
  const pinToCanvas = (cardId: string) => {
    const core = useCoreStore.getState().core;
    if (!core) {
      toast('摊不上：画布还没准备好', 'warn', 3200, 'composer');
      return;
    }
    readCard(cardId)
      .then((rec) => {
        const card = (rec.card ?? {}) as { kind?: unknown; payload?: unknown; title?: unknown };
        const kind = typeof card.kind === 'string' ? card.kind : 'markdown';
        const payload = (card.payload ?? {}) as Record<string, unknown>;
        const title = typeof card.title === 'string' ? card.title : '';
        const { view, canvasSize } = useCanvasViewStore.getState();
        const center = viewportCenterWorld(view, canvasSize.w, canvasSize.h);
        getCanvasStore(core.panelId)
          .getState()
          .setPin(`pin-card-${cardId}`, {
            x: Math.round(center.x - 210),
            y: Math.round(center.y - 150),
            w: 420,
            snapshot: { kind, payload, cardId },
          });
        closeShelf();
        toast(`已摊到画布：${title || '这张卡'}`, 'info', 2600, 'composer');
      })
      .catch((err: unknown) => toast(`摊到画布失败：${String(err)}`, 'error', 4200, 'composer'));
  };

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
                          /* **必须走窗口设施**（不是裸 store）：设施会通知受治进程
                             治理器，lazy / with-window 档的后端据此才被拉起。
                             2026-12-08 实机事故：裸 store 开窗 ⇒ 窗画出来了、后端没起
                             ⇒ 便签报「port.json 不可读」，关窗也因计数对不上而失灵。 */
                          openPluginWindow(def.pluginName);
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
                {cards.map((c) => {
                  const title = typeof c.title === 'string' ? c.title : '';
                  return (
                    <li key={c.cardId} className="pp-shelf-row">
                      {editingId === c.cardId ? (
                        <input
                          ref={editRef}
                          className="pp-shelf-edit"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => commitRename(c.cardId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(c.cardId);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          aria-label="卡片标题"
                        />
                      ) : (
                        <>
                          <button type="button" className="pp-shelf-item" onClick={() => openCard(c.cardId)}>
                            <span className="pp-shelf-name">
                              {title || (typeof c.kind === 'string' ? `${c.kind}（未命名）` : '未命名卡片')}
                            </span>
                            <span className="pp-shelf-meta">
                              {typeof c.kind === 'string' ? c.kind : ''}
                              {formatAt(c.shelvedAt) ? ` · ${formatAt(c.shelvedAt)}` : ''}
                            </span>
                          </button>
                          <span className="pp-shelf-actions">
                            <button type="button" data-tip="引用到本卷" onClick={() => quoteCard(c.cardId)}>
                              引
                            </button>
                            <button type="button" onClick={() => pinToCanvas(c.cardId)}>
                              摊
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(c.cardId);
                                setEditValue(title);
                              }}
                            >
                              改
                            </button>
                            <button type="button" onClick={() => removeCard(c.cardId, title)}>
                              删
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
