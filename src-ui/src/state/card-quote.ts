// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/card-quote — **卡片引用（夹签）**的纯数据面（docs/plans/card-quote-plan.md §3/§4）。
//
// 语义（方案 §1「兰台没有搬家，只有拓印」）：引用 = 卡片的一次**拓印**——
//   · 本体（画布/卷里那张卡）**永不动**：可见状态、位置、折叠与否一律不变；
//   · 夹签只带元数据（kind / 标题 / 字节数 / 来源），payload 不进槽；
//   · 发送那一刻才把 payload 快照写到 `{工作区}/.lantai/refs/<refId>.json`，
//     摘要里给的**就是这个绝对路径**——模型要细节、要改，用现成工具（fs read /
//     update_asset）自己去取。**本模块不新增任何模型工具、不新增 RPC**（方案 §0.1）。
//
// 归属：槽是**每卷一份**（方案 §2.3），真源 = input-store 的 `SessionDraft.attachedCards`
// （随卷保存/恢复）。本文件只管「一枚夹签长什么样」与「它落盘成什么」——
// 不碰 store，也不碰 React（纯函数 + 一次 fs 写，可单测）。

import { plateSignOf } from '../paper/plate-sign';

/** 一枚夹签（内存态；方案 §3.1 原样）。**只存元数据，不存 payload**——
 *  payload 可能几百 KB，槽里放不下（附图纪律同源：INVARIANTS #14「字节永不进卷」）。 */
export interface QuoteCard {
  /** `q-<yyyymmdd-hhmmss>-<4 位随机>`（同槽内唯一；见 `newRefId`）。 */
  refId: string;
  /** 来源：本卷里的卡（session）/ 架阁里的一张卡（shelf）。 */
  origin: 'session' | 'shelf';
  /** origin = session：画布/卷里那张卡的身份。 */
  assetId?: string;
  /** origin = shelf：卡片库里的身份。 */
  cardId?: string;
  /** origin = session：来源卷。 */
  sourceSessionId?: string;
  /** 卡片 kind（类型签 = `plateSignOf(kind)`，单一真源在 paper/plate-sign）。 */
  kind: string;
  /** 卡片标题（可空串——未命名卡也允许引用）。 */
  title: string;
  /** payload 序列化字符数（槽与摘要的「规模」同一把尺子）。 */
  bytes: number;
  /** ISO 引用时刻。 */
  at: string;
}

/** 发送期载荷（快照文件里的 `card` 段）。 */
export interface QuotePayloadCard {
  kind: string;
  title: string;
  payload: unknown;
}

/** 来源描述（快照文件里的 `origin` 段——方案 §3.3 原样）。 */
export interface QuoteOrigin {
  kind: 'session' | 'shelf';
  assetId: string | null;
  cardId: string | null;
  sessionId: string | null;
}

/** `refs/<refId>.json` 的整份内容（方案 §3.3）。 */
export interface QuoteSnapshotFile {
  refId: string;
  at: string;
  origin: QuoteOrigin;
  card: QuotePayloadCard;
  /** 用户填写状态：P0 恒 null（「含我的填写」是 P2，方案 §3.3/§10）。 */
  state: Record<string, unknown> | null;
  note: string;
}

/** 快照自带的说明句（**逐字**进盘上文件；方案 §3.3 的原文）。 */
export const QUOTE_SNAPSHOT_NOTE = '引用时快照；原卡此后改动不影响本文件';

/** 摘要分隔行（正文与引卡块之间；方案 §5.1 逐字）。 */
export const QUOTE_SECTION_SEPARATOR = '——以下为引用卡片——';

/** 没有 payload 时的降级文案（方案 §4 规则 3，**逐字**）。 */
export const QUOTE_DEGRADED_SOURCE = '· 原文：未落快照（跨卷引用且未能取到内容）——如需内容，请让用户重新引用';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 同一秒内已发出的 refId（进程级、按秒自清——CONVENTIONS §1.10 第 3 类）。
 *
 *  为什么需要：方案 §3.1 的 4 位随机尾巴在同一秒内只有 36⁴ ≈ 168 万种组合，而 refId
 *  同时是 refs **文件名**——两枚撞上，后写的会覆盖前者（第二个引用静默丢内容）。
 *  同一秒抽 2000 枚时生日碰撞期望已 ≈1.2 次（实测偶发红），必须做重抽。
 *  窗口 = **当前这一秒**（跨秒时间戳本身不同，天然不撞），故不在秒与秒之间攒内存。 */
let issuedStamp = '';
const issuedInSecond = new Set<string>();

/** 夹签身份：`q-<yyyymmdd-hhmmss>-<4 位随机>`（方案 §3.1）。
 *  本地时区（与用户看到的时间一致——它同时是文件名的可读部分）。 */
export function newRefId(at: Date = new Date()): string {
  const stamp =
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
  // 换秒即清（上一秒的号不可能与本秒相同——时间戳段已经不同）
  if (issuedStamp !== stamp) {
    issuedStamp = stamp;
    issuedInSecond.clear();
  }
  for (let attempt = 0; attempt < 4096; attempt++) {
    const tail = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    const id = `q-${stamp}-${tail}`;
    if (issuedInSecond.has(id)) continue; // 同秒撞号 = 重抽（格式不变）
    issuedInSecond.add(id);
    return id;
  }
  // 极端情况（同秒连发数千枚仍未抽中）：退回时间戳兜底——宁可长一点，
  // 也不覆盖别人已经写下的 refs 文件。
  const fallback = `q-${stamp}-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
  issuedInSecond.add(fallback);
  return fallback;
}

/** 去重键（方案 §2.5）：同一张卡（同一 assetId **或**同一 cardId）在同一槽内只允许一枚。 */
export function quoteKeyOf(card: Pick<QuoteCard, 'origin' | 'assetId' | 'cardId'>): string {
  return card.origin === 'shelf' ? `shelf:${card.cardId ?? ''}` : `session:${card.assetId ?? ''}`;
}

/** payload 的序列化字符数（摘要里「规模」的读数）。
 *  序列化失败（环 / BigInt）如实给 0——规模读数不因此炸掉整条引用。 */
export function payloadChars(payload: unknown): number {
  try {
    return JSON.stringify(payload ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** `1234567` → `1,234,567`（方案 §4 规则 1：规模用千分位，一眼看出是不是大件）。 */
export function formatThousands(n: number): string {
  return String(Math.max(0, Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `2026-11-19 10:52`（本地时区，摘要里的「快照」行）。 */
export function formatQuoteStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 摘要里的一行「来源」（方案 §4：`本卷第 N 张` / `架阁 card-xxxxx`）。
 *  卷号在场就给卷号（跨卷引用时「哪一卷的第几张」才是可核对的地址），缺席如实留空。 */
export function quoteSourceLine(card: QuoteCard): string {
  if (card.origin === 'shelf') return `· 来源：架阁 ${card.cardId ?? '（未知）'}`;
  const where = card.sourceSessionId ? `本卷第 ${card.sourceSessionId} 张` : '本卷';
  return `· 来源：${where} ${card.assetId ?? '（未知）'}`;
}

/** 一枚夹签的摘要块（方案 §4 模板，**逐字**）。
 *
 *  `refPath` = 快照的绝对路径（模型不知道 home 在哪，方案 §4 规则 2）；
 *  `null` = 取不到 payload ⇒ 走降级文案（规则 3），绝不假装成功。 */
export function renderQuoteBlock(card: QuoteCard, refPath: string | null): string {
  const lines = [
    `〔引卡〕${plateSignOf(card.kind)}《${card.title || '未命名'}》`,
    `· 快照：${formatQuoteStamp(card.at)}（此后原卡改动不影响本次引用）`,
    quoteSourceLine(card),
    `· 规模：payload ${formatThousands(card.bytes)} 字符`,
  ];
  if (refPath) {
    lines.push(`· 原文：${refPath}（用 fs read 取）`);
    if (card.origin === 'session' && card.assetId) {
      lines.push(`· 改本体：update_asset({"assetId":"${card.assetId}"})`);
    }
  } else {
    lines.push(QUOTE_DEGRADED_SOURCE);
  }
  return lines.join('\n');
}

/** 多枚夹签的整段（方案 §4 规则 4：**空行分隔、不编号**——编号会让模型误以为有顺序语义）。 */
export function renderQuoteSection(blocks: ReadonlyArray<{ card: QuoteCard; refPath: string | null }>): string {
  return blocks.map((b) => renderQuoteBlock(b.card, b.refPath)).join('\n\n');
}

/** 拼进 user message 的完整引用段（方案 §5.1 逐字形态）：
 *  `<正文>\n\n——以下为引用卡片——\n\n〔引卡〕…`。空清单 = 正文原样（零改动）。 */
export function composeQuotedText(
  body: string,
  blocks: ReadonlyArray<{ card: QuoteCard; refPath: string | null }>,
): string {
  if (blocks.length === 0) return body;
  // 纯引用轮（正文为空）不留前导空行——分隔行自己就是段的开头。
  const head = body.trim() === '' ? '' : `${body}\n\n`;
  return `${head}${QUOTE_SECTION_SEPARATOR}\n\n${renderQuoteSection(blocks)}`;
}

/** 快照落盘路径：`{工作区}/.lantai/refs/<refId>.json`（根反斜杠归一为正斜杠，
 *  与附图道同一口径——见 `app/chat/image-intake.ts` 的 `attachmentFilePath`）。 */
export function quoteSnapshotPath(root: string, refId: string): string {
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${cleanRoot}/.lantai/refs/${refId}.json`;
}

/** 一份快照的内容 + 落盘路径（**不发 IO**——本模块是不带状态的共享件，产物包会内联
 *  它；写盘归宿主发送面 `chat-core`，那里才有 fs_cap 能力口）。
 *
 *  内容形状 = 方案 §3.3 逐字；`state` 恒 null（「含我的填写」是 P2）。 */
export function buildQuoteSnapshot(
  root: string,
  card: QuoteCard,
  payload: unknown,
  sessionId: string | null = card.sourceSessionId ?? null,
): { path: string; content: string } {
  const file: QuoteSnapshotFile = {
    refId: card.refId,
    at: card.at,
    origin: {
      kind: card.origin,
      assetId: card.assetId ?? null,
      cardId: card.cardId ?? null,
      sessionId: card.origin === 'session' ? sessionId : null,
    },
    card: { kind: card.kind, title: card.title, payload: payload ?? null },
    state: null,
    note: QUOTE_SNAPSHOT_NOTE,
  };
  return { path: quoteSnapshotPath(root, card.refId), content: `${JSON.stringify(file, null, 2)}\n` };
}
