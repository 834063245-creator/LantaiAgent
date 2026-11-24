// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shelf-cards — 卡片页（阅览）：左目录按入阁时分桶，右阅览即见内容。
//
// 为什么是「目录 + 阅览」而不是「列表 + 点开」（2026-11-24 全量迭代）：
// 卡片的价值就是内容本身；旧架阁一行只有 题/kind/日期，点开才知道是什么，而点开那条路
// 的详情样式根本没写（iframe 落回 300×150）。现在选中即读（`card_read`），右栏按 kind
// 分别给：html 真跑（沙箱 + 状态桥回卡片库）、table 真排、file 给路径与「开」、
// 其余文本类读 payload 里那段字；**没有预览的 kind 落一句实话**，不摆假缩略图。
//
// 数据纪律：读失败必须可见（右栏一行 + 重试），不静默成空白。

import type { ReactNode, RefCallback, RefObject } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { readCard, writeCardState } from './host';
import { buildShelfCardDocument, SHELF_CARD_STATE_NS } from './shelf-card-document';
import {
  bytesLabel,
  type CardBucket,
  type CardDoc,
  type CardEntry,
  cardTitle,
  fmtStamp,
  payloadText,
  tableOf,
} from './shelf-model';

export interface ShelfCardsProps {
  buckets: CardBucket[];
  /** 键盘游标 = 选中行（全页扁平行序；-1 = 未选）。 */
  cursor: number;
  selectedId: string | null;
  selected: CardEntry | null;
  onSelect: (cardId: string) => void;
  rowRef: (index: number) => RefCallback<HTMLButtonElement>;
  doc: CardDoc | null;
  docError: string | null;
  reading: boolean;
  onRetryRead: () => void;
  /** 纸在 = 「摊到画布」「引用到本卷」成立（首页没有落点，不摆无效操作）。 */
  inCanvas: boolean;
  onPin: () => void;
  onQuote: () => void;
  onOpenFile: (path: string) => void;
  renaming: boolean;
  renameValue: string;
  renameRef: RefObject<HTMLInputElement | null>;
  onRenameStart: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  /** 删除两击（第一击只换文案，第二击才落）。 */
  deleteArmed: boolean;
  onDelete: () => void;
  empty?: ReactNode;
  /** 搜索时另一页仍有命中：一句话 + 切页出口（不静默丢）。 */
  elsewhere?: ReactNode;
}

/** 预览头右端的机读注记：kind · 入阁时间 · 字节 · 来源卷。 */
function metaLine(selected: CardEntry | null, doc: CardDoc | null): string {
  if (!selected) return '';
  const bits: string[] = [];
  if (selected.kind) bits.push(selected.kind);
  const stamp = fmtStamp(selected.shelvedAt);
  if (stamp) bits.push(`入阁 ${stamp}`);
  const bytes = bytesLabel(selected.dirBytes);
  if (bytes) bits.push(bytes);
  const sessionId = doc?.source?.sessionId;
  if (typeof sessionId === 'string' && /^\d+$/.test(sessionId)) bits.push(`来自 案卷 Nº ${sessionId}`);
  return bits.join(' · ');
}

/** 卡片页。 */
export function ShelfCards(props: ShelfCardsProps) {
  const {
    buckets,
    cursor,
    selectedId,
    selected,
    onSelect,
    rowRef,
    doc,
    docError,
    reading,
    onRetryRead,
    inCanvas,
    onPin,
    onQuote,
    onOpenFile,
    renaming,
    renameValue,
    renameRef,
    onRenameStart,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    deleteArmed,
    onDelete,
    empty,
    elsewhere,
  } = props;

  const total = buckets.reduce((n, b) => n + b.rows.length, 0);
  if (total === 0) {
    return <div className="shf-empty">{empty}</div>;
  }

  // 扁平行序（渲染与键盘同序的单一真源）：一次算好，不在渲染里逐行线性找。
  const indexOf = new Map<string, number>();
  {
    let i = -1;
    for (const bucket of buckets) {
      for (const row of bucket.rows) {
        i += 1;
        indexOf.set(row.cardId, i);
      }
    }
  }

  return (
    <div className="shf-cards">
      <div className="shf-cat-wrap">
        <div
          className="shf-cat"
          role="listbox"
          aria-label="卡片目录"
          aria-activedescendant={cursor >= 0 ? `shf-card-${cursor}` : undefined}
          tabIndex={0}
        >
          {buckets.map((bucket) => (
            // biome-ignore lint/a11y/useSemanticElements: listbox 内的分桶必须是 role=group（fieldset 不能出现在 listbox 里）
            <div key={bucket.key} role="group" aria-label={bucket.title}>
              <h2 className="shf-bucket">{bucket.title}</h2>
              <ul className="shf-list">
                {bucket.rows.map((card) => {
                  const i = indexOf.get(card.cardId) ?? -1;
                  return (
                    <li key={card.cardId}>
                      <button
                        type="button"
                        id={`shf-card-${i}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={card.cardId === selectedId}
                        className="shf-crow"
                        ref={rowRef(i)}
                        onClick={() => onSelect(card.cardId)}
                      >
                        <span className="shf-crow-t">{cardTitle(card)}</span>
                        <span className="shf-crow-m">
                          {[card.kind, fmtStamp(card.shelvedAt)].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        {elsewhere}
      </div>

      <div className="shf-pane">
        <header className="shf-pane-head">
          {renaming ? (
            <input
              ref={renameRef}
              className="shf-rename"
              value={renameValue}
              aria-label="卡片标题"
              onChange={(e) => onRenameChange(e.target.value)}
              onBlur={onRenameCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRenameCommit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRenameCancel();
                }
              }}
            />
          ) : (
            <h2 className="shf-pane-title">{selected ? cardTitle(selected) : ''}</h2>
          )}
          <span className="shf-pane-meta">{metaLine(selected, doc)}</span>
        </header>

        <div className="shf-pane-body">
          {docError ? (
            <div className="shf-fallback">
              <p>这张卡读不出：{docError}</p>
              <button type="button" className="shf-k" onClick={onRetryRead}>
                重试
              </button>
            </div>
          ) : reading || !doc ? (
            <p className="shf-fallback">正在读卡片…</p>
          ) : (
            <CardBody
              doc={doc}
              cardId={selectedId}
              title={selected ? cardTitle(selected) : ''}
              onOpenFile={onOpenFile}
            />
          )}
        </div>

        <div className="shf-pane-acts">
          {inCanvas ? (
            <>
              <button type="button" className="shf-k" onClick={onPin}>
                摊到画布
              </button>
              <button type="button" className="shf-k" onClick={onQuote}>
                引用到本卷
              </button>
            </>
          ) : null}
          <button type="button" className="shf-k" onClick={onRenameStart}>
            改名
          </button>
          <button
            type="button"
            className="shf-k is-danger"
            data-armed={deleteArmed ? 'on' : undefined}
            onClick={onDelete}
          >
            {deleteArmed ? '再按一次删除' : '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 预览体：按 kind 分派；每种都只画自己真有的东西。 */
function CardBody({
  doc,
  cardId,
  title,
  onOpenFile,
}: {
  doc: CardDoc;
  cardId: string | null;
  title: string;
  onOpenFile: (path: string) => void;
}) {
  const code = typeof doc.payload.code === 'string' ? doc.payload.code : '';
  const srcDoc = useMemo(() => (doc.kind === 'html' && code ? buildShelfCardDocument(code) : ''), [doc.kind, code]);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // 状态桥：iframe 的 get/patch → 卡片库（与旧架阁同一协议，只换了宿主组件的位置）。
  useEffect(() => {
    if (!srcDoc || !cardId) return;
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const data = e.data as { type?: unknown; req?: unknown; op?: unknown; patch?: unknown } | null;
      if (!data || typeof data !== 'object' || data.type !== SHELF_CARD_STATE_NS || typeof data.req !== 'number')
        return;
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
  }, [srcDoc, cardId]);

  if (doc.kind === 'html' && srcDoc) {
    return (
      <iframe
        ref={frameRef}
        key={cardId ?? 'html'}
        className="shf-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={title || '卡片'}
      />
    );
  }

  if (doc.kind === 'table') {
    const table = tableOf(doc.payload);
    if (table) {
      return (
        <div className="shf-scroll">
          <table className="shf-table">
            {table.caption ? <caption>{table.caption}</caption> : null}
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                // 表格是静态读数，行本身没有身份——按下标作键即可。
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态表格行
                <tr key={ri}>
                  {table.columns.map((_, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 静态表格单元格
                    <td key={ci}>{row[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }

  if (doc.kind === 'file' && doc.file) {
    return (
      <div className="shf-file">
        <span>{doc.file}</span>
        <button type="button" className="shf-k" onClick={() => onOpenFile(doc.file)}>
          开
        </button>
      </div>
    );
  }

  const text = payloadText(doc.payload);
  if (text) {
    return <pre className="shf-text">{text}</pre>;
  }

  return (
    <div className="shf-fallback">
      <p>这类卡片（{doc.kind || '未知类型'}）在架上没有预览。</p>
      <p>摊到画布去看。</p>
    </div>
  );
}
