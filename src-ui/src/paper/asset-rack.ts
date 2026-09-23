// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/asset-rack — **图版架**（资产收纳面，2026-09-23 拍板丙案 §9.5）的判据真源。
//
// 为什么判据在宿主层、而架本体（组件）在产物流：
// 归**产物流**的是「架这件家具」——`plugins/builtin/compose-dock/AssetRack.tsx`
// （与 InkLedger / WorkLedger 同族）。但「**架在否**」有两个消费者，分居两个
// 插件产物：
//   ① 架自己（渲不渲染：架内零张 ⇒ 整条退场）；
//   ② **槽主人** paper-shell 的吸附表（`composer-float.ts`：架在 ⇒ 「最底缘」
//      吸附位 8 → 46，兜底见 D2）。
// 两处各写一遍判据 = 两份真源（迟早漂），故判据上移宿主层，两侧各自 import
// （相对 import = 同一份纯函数，无实例身份问题；同 `paper-shell/dock-tether.ts`
// 取 `paper/measure` 的先例）。**零 faceDeps 新增**——宿主面键集不变。

import type { SourcedBlock } from './block-model';

/** 架容量：至多 6 张 + 「… 另 N 张」（N **只数架内**）。
 *  超出一律不滚不折行——架是家具，不是滚动条。 */
export const RACK_CAP = 6;

/**
 * 入架判据（**一条，零新状态**）：本卷有该资产 **且** 该块未钉。
 *
 * D4（2026-09-23 二次拍板，用户原话「拖出钉住的签条，就不要继续在横架里面了，
 * 拖出来钉住就等于"拿出来"了」）：钉 = 公共物，已属「案上」，不属「匣里」
 * ——不管它是从架上拖出去钉的、还是从流内文类签拖出去钉的，**一律离架**。
 * 连带结论：架上不需要「已钉」记号（它不在架上，记号无处可挂），
 * 架的读数因此是一句诚实的话——**「本卷还有什么没摆出来」**。
 */
export function inRack(b: SourcedBlock): boolean {
  return b.asset != null && b.state !== 'pinned';
}

/** 架内签条（**流转序** = 块序原样，不重排、不排序）。 */
export function rackBlocksOf(blocks: readonly SourcedBlock[]): SourcedBlock[] {
  return blocks.filter(inRack);
}

/** 架在否（吸附表据此取 `[46, 96]` / `[8, 96]`）：有卷 **且** 架内非空
 *  （空态判据 = **架内零张**，不是「本卷零资产」——两者同一条规则：整条退场）。 */
export function rackPresent(blocks: readonly SourcedBlock[] | null | undefined): boolean {
  // 空集/无卷一律 false——`?.some` 对 null/undefined 也短路（可选链即这条判据本身）
  return blocks?.some(inRack) ?? false;
}
