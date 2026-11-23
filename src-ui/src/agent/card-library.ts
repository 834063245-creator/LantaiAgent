// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// card-library — 卡片库的 TS 门面（架阁存储底座，docs/plans/entity-shelf-plan.md B1）。
//
// 定位：**薄门面**——纯 RPC 直调，无内存缓存（真源在盘上，见 Rust
// `commands/card_store.rs`）。卡片包 = `<cardsRoot>/<cardId>/{card.json,state.json}`。
//
// 纪律（与方案对齐）：
//   - **收进架阁 = 用户手势**，不是模型动作——本模块不接 Agent 工具面（D3）。
//     谁调用它，谁负责「用户点了」这件事（B2 的手势接线）。
//   - **拓印不覆盖**：同 cardId 重复收 = Rust 侧显式拒绝，本模块不吞错
//     （错误必须冒泡给调用方 ⇒ 界面可见，不静默）。
//   - 任意失败（围栏拒绝 / 64 KiB 超限 / 盘满）都走 throw，调用方决定怎么展示。

import { typedJsonRpc } from '../rpc-contract';

/** 卡片摘要（`card_list` 一行）。`kind`/`title`/`shelvedAt` 可能是 null——
 *  旧卡缺字段时诚实给空，不编造。 */
export interface CardSummary {
  cardId: string;
  kind: unknown;
  title: unknown;
  /** 文件卡记的绝对路径（2026-11-23 记文件式）：非空即「这份卡是能再打开的文件」。 */
  file?: unknown;
  shelvedAt: unknown;
  /** state.json 字节数（0 = 还没碰过状态）。 */
  stateBytes: number;
  /** 卡片目录总字节数（card.json + state.json）。 */
  dirBytes: number;
}

/** `card_list` 结果：坏卡不炸全表——逐条进 skipped（错误可见）。 */
export interface CardListResult {
  cards: CardSummary[];
  skipped: { cardId: string; error: string }[];
}

/** `card_read` 结果：card.json 原样 + 状态对象。 */
export interface CardRecord {
  card: unknown;
  state: Record<string, unknown>;
}

/** 收进架阁的输入：`card.json` 的形状由调用方持有（kind/presentation/payload/
 *  source/v），本模块只透传——**不在这里加字段白名单**（卡片 kind 会继续长）。 */
export interface ShelveInput {
  card: Record<string, unknown>;
  /** 当刻状态（html 卡 = `window.lantai.state` 的读回值）。缺省 = 空对象。 */
  state?: Record<string, unknown>;
}

export interface ShelveResult {
  cardId: string;
  dir: string;
}

/** 枚举卡片库（按 `source.shelvedAt` 倒序；坏卡进 skipped）。 */
export async function listCards(): Promise<CardListResult> {
  return typedJsonRpc('card_list', {});
}

/** 读一张卡（card.json + state）。不存在 = throw。 */
export async function readCard(cardId: string): Promise<CardRecord> {
  return typedJsonRpc('card_read', { card_id: cardId });
}

/** 收进架阁（拓印）：同 cardId 已存在 = throw（不覆盖）。 */
export async function shelveCard(input: ShelveInput): Promise<ShelveResult> {
  return typedJsonRpc('card_shelve', {
    card_json: JSON.stringify(input.card),
    state_json: JSON.stringify(input.state ?? {}),
  });
}

/** 浅合并写状态（64 KiB 上限，超限整笔拒绝——Rust 侧兜底）。返回合并后字节数。 */
export async function writeCardState(cardId: string, patch: Record<string, unknown>): Promise<{ bytes: number }> {
  return typedJsonRpc('card_state_write', {
    card_id: cardId,
    patch_json: JSON.stringify(patch),
  });
}

/** 改标题（**只动 title**：卡片身份、payload、状态一律不动——拓印语义下内容归作者，
 *  重命名是宿主允许改的唯一一项）。 */
export async function renameCard(cardId: string, title: string): Promise<{ cardId: string; title: string }> {
  return typedJsonRpc('card_rename', { card_id: cardId, title });
}

/** 删除（挪 `.trash`）。目标本就不存在 = 成功（`trashed` 为 null）。 */
export async function deleteCard(cardId: string): Promise<{ cardId: string; trashed: string | null }> {
  return typedJsonRpc('card_delete', { card_id: cardId });
}
