// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// card-quote-of — **一块卡 → 一枚夹签**（docs/plans/card-quote-plan.md §3.1/§3.4）。
//
// 纯函数：入参是纸面上那一块（活块或快照重建的孤儿钉块都一样），出参是进槽的
// 元数据。**不碰 store、不写盘、不量几何**——那些归装配根与发送面。
//
// 关键分路（方案 §3.4 的两条取内容路径）：
//   · 卷内卡：origin='session'，地址 = assetId（发送时从会话资产表取 payload）；
//   · **架阁摊上来的卡**：拿不到会话资产（它的 payload 在卡片库里），故 origin='shelf'、
//     地址 = cardId——写快照时按 cardId 读 card.json。判伪来源会在发送期静默降级成
//     「未落快照」，用户读到的是「引用了却什么都没给模型」。

import type { QuoteCard } from '../../../state/card-quote';
import { newRefId, payloadChars } from '../../../state/card-quote';
import type { SourcedBlock } from './host';

/** 一块资产卡 → 一枚夹签；没有资产身份（正文段 / 工具卡）返回 null。
 *
 *  `sessionNum` = 来源卷号（孤儿钉传 -1：它没有活会话，session 来源也用不上）。 */
export function quoteCardOf(block: SourcedBlock, sessionNum: number, at: Date = new Date()): QuoteCard | null {
  const asset = block.asset;
  if (!asset) return null;
  const shared = {
    refId: newRefId(at),
    // 卡身份取**块的** kind（asset 元数据只带 presentation / 标题——见 BlockAssetMeta）
    kind: block.kind,
    title: asset.title ?? '',
    bytes: payloadChars(block.payload),
    at: at.toISOString(),
  };
  return asset.cardId !== undefined
    ? { ...shared, origin: 'shelf', cardId: asset.cardId }
    : { ...shared, origin: 'session', assetId: asset.assetId, sourceSessionId: String(sessionNum) };
}
