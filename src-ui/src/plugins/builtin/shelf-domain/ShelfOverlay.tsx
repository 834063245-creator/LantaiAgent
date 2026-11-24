// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// plugins/builtin/shelf-domain/ShelfOverlay — **架阁**（docs/plans/shelf-ui-iteration-plan.md）
//
// v67（2026-11-24）全量迭代：从「会随内容伸缩的下拉框」改成**固定册页**，两页各自回答一个问题：
//   器物（在窗 / 软件 / 面板）——「能不能开、开没开、怎么关」；
//   卡片（目录 + 阅览）——「这张是什么、在哪一版、拿它做什么」。
//
// 法度（§11 层次法 · 模态档）：`--veil` 遮罩 + `--elev-raise` 压印 + 头线 `--rule-head` +
// 入场 `veil-in`/`pop-down`；z 走 `--z-shelf-modal`（485，盖过插件窗 460 / 提示 480，
// 让位于牒卡 500 / 命令面板 510）——旧值 400 在软件窗之下，实测「开着文卷点架阁被压住」。
//
// 交互（2026-11-17 收口批的原语，不再自写）：
//   - focus 圈定 / 初始焦点 / 归还 = `mountDialogFocus`（app/dialog-focus）；
//   - 外点关闭 = `useOutsideClose`，Esc = `useDialogEscape`（app/overlay-hooks ——
//     2026-11-24 从 overlay.tsx 拆出的 hooks 面，产物域可复用而不内联 react-dom）。
//   - ↑↓ 移动 / ↵ 主动作（焦点在搜索框时）/ `/` 聚焦搜索 / Esc 逐层（改名 → 清查询 → 关）。
//
// 数据纪律：软件口径 = `plugin-window-store.defs` ∪ `panelDefs()`（两道过滤：side !== null、
// frame !== 'self'）；卡片 = `card_list` / `card_read`，**读失败必须可见**，坏卡按 skipped 明示。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mountDialogFocus } from '../../../app/dialog-focus';
import { useDialogEscape, useOutsideClose } from '../../../app/overlay-hooks';
import { newRefId, payloadChars, type QuoteCard } from '../../../state/card-quote';
import {
  closePluginWindow,
  deleteCard,
  getCanvasStore,
  getChatStore,
  listCards,
  openPluginWindow,
  panelDefs,
  readCard,
  renameCard,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  usePanelDefsStore,
  usePluginWindowStore,
  useShelfStore,
  useToastStore,
  viewportCenterWorld,
} from './host';
import { ShelfApps } from './shelf-apps';
import { ShelfCards } from './shelf-cards';
import {
  bucketCards,
  type CardDoc,
  type CardEntry,
  cardDocOf,
  cardTitle,
  matches,
  normalizeCard,
  type ShelfRow,
  type ShelfSection,
} from './shelf-model';
import './shelf.css';

/** 页签口径（2026-11-24 用户拍板：软件型/卡片型 → 器物/卡片）。 */
const PAGE_LABEL = { app: '器物', card: '卡片' } as const;

/** 删除两击的确认窗（ms）——业务计时器，不是动画窗。 */
const DELETE_ARM_MS = 3000;

function modeLabel(mode: string): string {
  if (mode === 'dock') return '停靠';
  if (mode === 'fullscreen') return '全屏';
  return '浮动';
}

/** 宿主桥的窗口设施（仅取 openWith）——文件卡的「开」不直接 import 宿主模块。 */
type OpenWithHost = { windows?: { openWith?: (path: string) => boolean } };

function openFileFromShelf(path: string): void {
  const host = (globalThis as { __lantai_plugin_host__?: OpenWithHost }).__lantai_plugin_host__;
  host?.windows?.openWith?.(path);
}

export function ShelfOverlay() {
  const open = useShelfStore((s) => s.open);
  const page = useShelfStore((s) => s.page);
  const setPage = useShelfStore((s) => s.setPage);
  const closeShelf = useShelfStore((s) => s.closeShelf);

  const defs = usePluginWindowStore((s) => s.defs);
  const windows = usePluginWindowStore((s) => s.windows);
  const panelTick = usePanelDefsStore((s) => s.panelDefsTick);
  const dockOpen = useDockStore((s) => s.open);
  const inCanvas = useDockStore((s) => s.open.paper) === true;

  /* ── 搜索 / 键盘游标 ─────────────────────────────────────────
   * 查询两页共用（切页不重置）；**空查询 = 全列**（架阁是查询面不是信息流）。
   * 卡片页的「游标」就是选中那张（见下）——预览跟着走，不给两套选中态。 */
  const [query, setQuery] = useState('');
  const [appCursor, setAppCursor] = useState(-1);

  /* ── 卡片库 ─────────────────────────────────────────────────── */
  const [cards, setCards] = useState<CardEntry[] | null>(null);
  const [skipped, setSkipped] = useState<Array<{ cardId: string; error: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [showSkipped, setShowSkipped] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<CardDoc | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readTick, setReadTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const rowEls = useRef<Array<HTMLButtonElement | null>>([]);

  const toast = useToastStore.getState().showToast;

  /* ── 开合：每次打开重读卡片库（盘上是真源，缓存一份就是第二真相）── */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setAppCursor(-1);
    setDeleteArmedId(null);
    setRenaming(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void reloadTick; // 重试信号：本效应只认「打开」与「重试」两次触发
    let alive = true;
    setLoadError(null);
    listCards()
      .then((r) => {
        if (!alive) return;
        const rows = (Array.isArray(r.cards) ? r.cards : []).map(normalizeCard).filter((c) => c.cardId);
        setCards(rows);
        setSkipped(Array.isArray(r.skipped) ? r.skipped : []);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setCards([]);
        setSkipped([]);
        setLoadError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [open, reloadTick]);

  // 读选中那张（选中即读；切卡/重试都走这一条）。
  useEffect(() => {
    void readTick; // 重试信号（读失败后右栏「重试」重跑这一条）
    if (!open || !selectedId) {
      setDoc(null);
      setDocError(null);
      setReading(false);
      return;
    }
    let alive = true;
    setReading(true);
    setDocError(null);
    readCard(selectedId)
      .then((r) => {
        if (!alive) return;
        setDoc(cardDocOf(r.card));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDoc(null);
        setDocError(String(e));
      })
      .finally(() => {
        if (alive) setReading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, selectedId, readTick]);

  /* ── 焦点圈定 / 外点关闭 / Esc 逐层 ─────────────────────────── */
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    return mountDialogFocus(dialogRef.current, { initial: searchRef.current });
  }, [open]);

  useOutsideClose(
    dialogRef,
    useCallback(() => closeShelf(), [closeShelf]),
    { enabled: open },
  );

  useDialogEscape(
    useCallback(() => {
      if (renaming) {
        setRenaming(false);
        return;
      }
      if (query) {
        setQuery('');
        searchRef.current?.focus();
        return;
      }
      closeShelf();
    }, [renaming, query, closeShelf]),
    { enabled: open },
  );

  /* ── 删除两击的确认窗 ──────────────────────────────────────── */
  useEffect(() => {
    if (!deleteArmedId) return;
    const timer = window.setTimeout(() => setDeleteArmedId(null), DELETE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [deleteArmedId]);

  // 改名输入聚焦（不用 autoFocus：biome 的 a11y 规则禁裸 autoFocus）。
  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  /* ── 器物页清单（窗口 / 软件 / 面板）────────────────────────── */
  const panels = useMemo(() => {
    void panelTick; // 贡献热注册即时重进清单
    /* 两道过滤，各自一条理由（沿用 v66 判例）：
     *   ① side !== null——side:null 的面板（纸/设置）语义是「不上轨道」，不是软件；
     *   ② frame !== 'self'——书脊/案卷是家具，生命周期挂在纸上，列进来会在首页开出空侧栏。 */
    return panelDefs()
      .filter((d) => d.side !== null)
      .filter((d) => d.frame !== 'self');
  }, [panelTick]);

  const openPluginNames = useMemo(() => new Set(windows.map((w) => w.pluginName)), [windows]);

  const appSections = useMemo<ShelfSection[]>(() => {
    const windowRows: ShelfRow[] = windows.map((w) => {
      const def = defs[w.pluginName];
      const title = def?.title || w.pluginName;
      const size = w.mode === 'floating' ? ` · ${Math.round(w.w)} × ${Math.round(w.h)}` : '';
      return {
        id: `window:${w.windowId}`,
        title,
        sub: `${w.pluginName} · ${modeLabel(w.mode)}${size}`,
        on: true,
        run: () => {
          usePluginWindowStore.getState().focusWindow(w.windowId);
          closeShelf();
        },
        acts: [
          {
            label: '聚焦',
            run: () => {
              usePluginWindowStore.getState().focusWindow(w.windowId);
              closeShelf();
            },
          },
          { label: '关', run: () => closePluginWindow(w.windowId), quiet: true },
        ],
      };
    });

    const appRows: ShelfRow[] = Object.values(defs)
      .filter((d) => !openPluginNames.has(d.pluginName))
      .map((d) => ({
        id: `app:${d.pluginName}`,
        title: d.title || d.pluginName,
        sub: `${d.pluginName} · ${modeLabel(d.mode)}`,
        on: false,
        run: () => {
          openPluginWindow(d.pluginName);
          closeShelf();
        },
        acts: [
          {
            label: '开',
            run: () => {
              openPluginWindow(d.pluginName);
              closeShelf();
            },
          },
        ],
      }));

    const panelRows: ShelfRow[] = panels.map((p) => {
      const isOpen = dockOpen[p.id] === true;
      const toggle = () => {
        useDockStore.getState().togglePanel(p.id);
        closeShelf();
      };
      return {
        id: `panel:${p.id}`,
        title: p.title,
        sub: `${p.id} · ${p.side === 'left' ? '左侧面板' : '右侧面板'}`,
        on: isOpen,
        run: toggle,
        acts: isOpen
          ? [{ label: '关', run: () => useDockStore.getState().closePanel(p.id), quiet: true }]
          : [{ label: '开', run: toggle }],
      };
    });

    return [
      { key: 'windows' as const, title: '在窗', rows: windowRows },
      { key: 'apps' as const, title: '软件', rows: appRows },
      { key: 'panels' as const, title: '面板', rows: panelRows },
    ]
      .map((s) => ({ ...s, rows: s.rows.filter((r) => matches(query, r.title, r.sub)) }))
      .filter((s) => s.rows.length > 0);
  }, [windows, defs, panels, openPluginNames, dockOpen, query, closeShelf]);

  const appFlat = useMemo(() => appSections.flatMap((s) => s.rows), [appSections]);
  const appTotal =
    windows.length + Object.values(defs).filter((d) => !openPluginNames.has(d.pluginName)).length + panels.length;

  /* ── 卡片页清单（过滤 → 分桶）────────────────────────────── */
  const filteredCards = useMemo(() => (cards ?? []).filter((c) => matches(query, c.title, c.kind)), [cards, query]);
  const buckets = useMemo(() => bucketCards(filteredCards), [filteredCards]);
  const flatCards = useMemo(() => buckets.flatMap((b) => b.rows), [buckets]);
  const cardTotal = cards?.length ?? 0;
  const selected = useMemo(() => (cards ?? []).find((c) => c.cardId === selectedId) ?? null, [cards, selectedId]);
  const cardIndex = useMemo(() => flatCards.findIndex((c) => c.cardId === selectedId), [flatCards, selectedId]);

  // 选中项必须仍在当前清单里（过滤/删除之后）——否则选中第一张；空清单 = 不选。
  useEffect(() => {
    if (!open || page !== 'card') return;
    if (flatCards.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !flatCards.some((c) => c.cardId === selectedId)) {
      setSelectedId(flatCards[0].cardId);
    }
  }, [open, page, flatCards, selectedId]);

  // 游标越界夹取（过滤后行数变少）。
  useEffect(() => {
    setAppCursor((c) => {
      if (appFlat.length === 0) return -1;
      if (c < 0) return -1;
      return Math.min(c, appFlat.length - 1);
    });
  }, [appFlat.length]);

  // 键盘游标/选中行的滚动可见性（旧架阁的 ↑↓ 只改游标、不出视野）。
  useEffect(() => {
    const index = page === 'app' ? appCursor : cardIndex;
    if (index < 0) return;
    rowEls.current[index]?.scrollIntoView?.({ block: 'nearest' });
  }, [page, appCursor, cardIndex]);

  const rowRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      rowEls.current[index] = el;
    },
    [],
  );

  /* ── 卡片动作（摊 / 引 / 改名 / 删）────────────────────────── */
  const quoteCard = (cardId: string) => {
    const core = useCoreStore.getState().core;
    if (!core) {
      toast('引用失败：画布还没准备好', 'warn', 3200, 'composer');
      return;
    }
    const input = getChatStore(core.panelId).input.getState();
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

  const commitRename = () => {
    if (!selectedId) return;
    const cardId = selectedId;
    const title = renameValue.trim();
    setRenaming(false);
    renameCard(cardId, title)
      .then(() => {
        setCards((prev) => prev?.map((c) => (c.cardId === cardId ? { ...c, title } : c)) ?? prev);
        setDoc((prev) => (prev ? { ...prev, title } : prev));
        toast(`已改名：${title || '（未命名）'}`, 'info', 2200, 'composer');
      })
      .catch((err: unknown) => toast(`改名失败：${String(err)}`, 'error', 4200, 'composer'));
  };

  const requestDelete = (cardId: string) => {
    if (deleteArmedId !== cardId) {
      setDeleteArmedId(cardId);
      return;
    }
    setDeleteArmedId(null);
    const title = cardTitle(cards?.find((c) => c.cardId === cardId) ?? { title: '', kind: '' });
    deleteCard(cardId)
      .then(() => {
        setCards((prev) => (prev ?? []).filter((c) => c.cardId !== cardId));
        if (selectedId === cardId) setSelectedId(null);
        toast(`已删除「${title || '未命名'}」——卡片库的回收站里可找回`, 'info', 3200, 'composer');
      })
      .catch((err: unknown) => toast(`删除失败：${String(err)}`, 'error', 4200, 'composer'));
  };

  /* ── 键盘：↑↓ / ↵ / `/`（Enter 只接管搜索框，免得与行/按钮的原生激活打两次）── */
  const moveCursor = (step: number) => {
    if (page === 'app') {
      if (appFlat.length === 0) return;
      setAppCursor((c) => {
        if (c < 0) return step > 0 ? 0 : appFlat.length - 1;
        return (c + step + appFlat.length) % appFlat.length;
      });
      return;
    }
    if (flatCards.length === 0) return;
    const cur = flatCards.findIndex((c) => c.cardId === selectedId);
    const next = cur < 0 ? (step > 0 ? 0 : flatCards.length - 1) : (cur + step + flatCards.length) % flatCards.length;
    setSelectedId(flatCards[next].cardId);
    setRenaming(false);
    setDeleteArmedId(null);
  };

  const runActive = () => {
    if (page === 'app') {
      appFlat[appCursor]?.run();
      return;
    }
    if (inCanvas && selectedId) pinToCanvas(selectedId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // 改名输入自持按键（Esc 由 document 的逐层关闭处理）。
    if (renaming) return;
    const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (e.key === '/' && !inInput) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && (target === searchRef.current || target.getAttribute('role') === 'listbox')) {
      e.preventDefault();
      runActive();
    }
  };

  if (!open) return null;

  const totalHits = appFlat.length + flatCards.length;
  const appHint = query && flatCards.length > 0 ? `卡片页有 ${flatCards.length} 条命中` : '';
  const cardHint = query && appFlat.length > 0 ? `器物页有 ${appFlat.length} 条命中` : '';

  const appEmpty = (
    <>
      <h2 className="shf-empty-t">{query ? '器物页没有匹配' : '架还是空的'}</h2>
      <p className="shf-empty-d">
        {query ? '换个词试试——卡片页也许有。' : '装进来的软件和面板会住在这里；装一个就有了。'}
      </p>
      {query && flatCards.length > 0 ? (
        <button type="button" className="shf-empty-b" onClick={() => setPage('card')}>
          卡片页有 {flatCards.length} 条命中
        </button>
      ) : null}
      {!query ? (
        <button
          type="button"
          className="shf-empty-b"
          onClick={() => {
            closeShelf();
            useDockStore.getState().openPanel('settings');
          }}
        >
          去「设置 → 插件」装一个
        </button>
      ) : null}
    </>
  );

  const cardEmpty = (
    <>
      <h2 className="shf-empty-t">{query ? '卡片页没有匹配' : '架还是空的'}</h2>
      <p className="shf-empty-d">
        {query
          ? '换个词试试——器物页也许有。'
          : inCanvas
            ? '在会话里的卡片上点「入阁」，就收进来了。'
            : '展开一卷，让兰台先造一张卡；卡片右上角点「入阁」，就收进来了。'}
      </p>
      {query && appFlat.length > 0 ? (
        <button type="button" className="shf-empty-b" onClick={() => setPage('app')}>
          器物页有 {appFlat.length} 条命中
        </button>
      ) : null}
    </>
  );

  const hints = (
    <>
      <span>
        <kbd>↑↓</kbd>
        {page === 'app' ? '选择' : '换一张'}
      </span>
      {page === 'app' ? (
        <span>
          <kbd>↵</kbd>打开
        </span>
      ) : inCanvas ? (
        <span>
          <kbd>↵</kbd>摊到画布
        </span>
      ) : null}
      <span>
        <kbd>/</kbd>搜索
      </span>
      <span>
        <kbd>esc</kbd>
        {query ? '清查询' : '关闭'}
      </span>
    </>
  );

  return (
    <div className="shf-veil">
      <div
        ref={dialogRef}
        className="shf-shelf"
        role="dialog"
        aria-modal="true"
        aria-label="架阁"
        onKeyDown={onKeyDown}
      >
        <header className="shf-head">
          <h1 className="shf-title">架阁</h1>
          <div className="shf-tabs" role="tablist" aria-label="架阁分页">
            {(Object.keys(PAGE_LABEL) as Array<keyof typeof PAGE_LABEL>).map((key) => {
              const count = query
                ? key === 'app'
                  ? appFlat.length
                  : flatCards.length
                : key === 'app'
                  ? appTotal
                  : cardTotal;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={page === key}
                  className={`shf-tab${page === key ? ' is-on' : ''}`}
                  onClick={() => {
                    setPage(key);
                    setRenaming(false);
                    setDeleteArmedId(null);
                    setAppCursor(-1);
                  }}
                >
                  {PAGE_LABEL[key]}
                  <span className="shf-tab-n">{count}</span>
                </button>
              );
            })}
          </div>
          <button type="button" className="shf-x" aria-label="关闭架阁" onClick={closeShelf}>
            ×
          </button>
        </header>

        <div className="shf-search">
          <span className="shf-search-p" aria-hidden="true">
            ❯
          </span>
          <input
            ref={searchRef}
            className="shf-search-input"
            type="search"
            value={query}
            placeholder="搜器物、面板、卡片"
            aria-label="搜索架阁"
            onChange={(e) => {
              setQuery(e.target.value);
              setAppCursor(-1);
            }}
          />
          {query ? <span className="shf-hit">命中 {totalHits}</span> : null}
        </div>

        <div className="shf-body">
          {page === 'app' ? (
            <ShelfApps
              sections={appSections}
              cursor={appCursor}
              onRun={(row) => row.run()}
              rowRef={rowRef}
              empty={appEmpty}
              footnote={
                appHint ? (
                  <div className="shf-elsewhere">
                    <span>{appHint}</span>
                    <button type="button" onClick={() => setPage('card')}>
                      切到卡片页
                    </button>
                  </div>
                ) : null
              }
            />
          ) : loadError ? (
            <>
              <div className="shf-err">
                <span>卡片库读取失败：{loadError}</span>
                <button type="button" className="shf-err-r" onClick={() => setReloadTick((t) => t + 1)}>
                  重试
                </button>
              </div>
              <div className="shf-empty">
                <p className="shf-empty-d">这一页暂时读不出——先修好卡片目录再重试。</p>
              </div>
            </>
          ) : cards === null ? (
            <div className="shf-empty">
              <p className="shf-empty-d">正在读卡片库…</p>
            </div>
          ) : (
            <>
              {skipped.length > 0 ? (
                <div className="shf-skipped">
                  {skipped.length} 张卡片读不出（已跳过，未计入架内）
                  <button type="button" onClick={() => setShowSkipped((v) => !v)}>
                    {showSkipped ? '收起' : '看详情'}
                  </button>
                  {showSkipped ? (
                    <ul>
                      {skipped.map((s) => (
                        <li key={s.cardId}>
                          {s.cardId}：{s.error}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <ShelfCards
                buckets={buckets}
                cursor={cardIndex}
                selectedId={selectedId}
                selected={selected}
                onSelect={(id) => {
                  setSelectedId(id);
                  setRenaming(false);
                  setDeleteArmedId(null);
                }}
                rowRef={rowRef}
                doc={doc}
                docError={docError}
                reading={reading}
                onRetryRead={() => setReadTick((t) => t + 1)}
                inCanvas={inCanvas}
                onPin={() => selectedId && pinToCanvas(selectedId)}
                onQuote={() => selectedId && quoteCard(selectedId)}
                onOpenFile={openFileFromShelf}
                renaming={renaming}
                renameValue={renameValue}
                renameRef={renameRef}
                onRenameStart={() => {
                  setRenameValue(selected ? cardTitle(selected) : '');
                  setRenaming(true);
                }}
                onRenameChange={setRenameValue}
                onRenameCommit={commitRename}
                onRenameCancel={() => setRenaming(false)}
                deleteArmed={deleteArmedId !== null && deleteArmedId === selectedId}
                onDelete={() => selectedId && requestDelete(selectedId)}
                empty={cardEmpty}
                elsewhere={
                  cardHint ? (
                    <div className="shf-elsewhere">
                      <span>{cardHint}</span>
                      <button type="button" onClick={() => setPage('app')}>
                        切到器物页
                      </button>
                    </div>
                  ) : null
                }
              />
            </>
          )}
        </div>

        <footer className="shf-foot">
          {hints}
          <span className="shf-foot-r">
            器物 {appTotal} · 卡片 {cardTotal}
          </span>
        </footer>
      </div>
    </div>
  );
}
