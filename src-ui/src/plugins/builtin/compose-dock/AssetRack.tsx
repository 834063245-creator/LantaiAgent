// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/compose-dock/AssetRack — **图版架**（资产收纳面，2026-09-23 拍板丙案）。
//
// 一句话：在创作坞下缘挂一条 880×38 的横架，收本卷全部 kind 资产（物类签 + 题名）；
// 点 = 飞到流里那一块、拖出 = 钉到纸上（随即离架）、hover = 认脸。
//
// ── 落位（丙 · 匣下横架，设计真源 = 规格书 §9.5）──────────────────────────
// 本组件由 ComposerDock 渲染，**DOM 上是 `.pp-composer` 的兄弟**（同一坞槽
// `.pp-composer-slot` 内），CSS 里 `position: absolute; top: 100%` ⇒ 绝对定位不进
// 槽主人的量高盒 ⇒ **让位带恒 227**（小地图/递牒卡/插件坞/目次带映射区零让位）。
// 架吃的是流锚以下那 96px 空白页边（一个字不盖）——三案对照见 §9.5 表。
// 归**产物流**（与 InkLedger / WorkLedger 同族）；样式住 paper-shell 的
// PaperPanel.css（`.pp-rack*` 段，同役册/墨量册的先例）。
//
// ── 数据面（零新通道、零 faceDeps 新增）────────────────────────────────
//   ① 本卷块与资产元数据：`usePaperRegion().regions`（**容缺读**——宿主不给本
//      context（旧宿主/单件测试桩）⇒ 架不渲染，同 token 三能力位的纪律）；
//   ② 钉出/移出的块 `state === 'pinned'`（translate.withPin 的投影）⇒ 入架判据
//      一条：`b.asset != null && b.state !== 'pinned'`（真源 = `paper/asset-rack.ts`，
//      槽主人的吸附表同用这一句）；
//   ③ 跳转 = `usePaperDock().flyToPoint`；展开收起态 = 能力位（宿主不给 = 只飞不展）；
//   ④ 拖出钉 = `usePaperDock().dragBlockOut`（**复用既有钉手势** use-paper-drag，
//      能力位同 ③）。
//   频度（P2-3 纪律）：流区 context 的外层引用**每平移帧换新** ⇒ 本组件随之重渲
//   （目次带/小地图同族）。贵的那半（对账 + 建 entries）关在 useMemo 里，依赖只有
//   内容侧两块（blocks/seq，平移帧引用稳定）⇒ 平移帧只重渲 ≤7 枚按钮，零重算。
//
// ── D4「拿出来」语义（2026-09-23 二次拍板，用户原话）──────────────────────
// 「拖出钉住的签条，就不要继续在横架里面了，拖出来钉住就等于"拿出来"了」——
// 钉 = 公共物（属「案上」），故钉住的资产**一律离架**（从架上拖出去的、从流内
// 文类签拖出去的，同一条判据）；连带：架上**不需要「已钉」记号**，拔钉收回 ⇒
// 签条回架（原位、序归位），架内零张 ⇒ **整条退场**。架的读数因此是一句诚实的
// 话——「本卷还有什么没摆出来」。
//
// ── 更新点（石青 5px 圆）与 hover 的「时间」口径（诚实栏）────────────────
// 资产的更新在数据面上就是 `update_asset` 广播 → chat-stream 的
// `applyAssetUpdateToExistingParts` **原位置换** BlockPart（payload 换新对象）
// → touchMessage → 流区重算 → 本组件重渲。故「更新」判据 = **同一 assetId 的
// 资产签名/载荷引用变了**（首见不算更新——那是「新摆上架」）。观察账是**组件内
// 纯内存**（`useRef`，不落盘、不跨卷）：架上每次重渲对一遍账，离架的划掉。
// 点一下 = 「去流里看它」这个动作本身 ⇒ 更新点随之散（点不散会变成一句过期的
// 谎）；再更新则重新亮。
// **时间不是资产自身的时刻**：块与消息都不带时间戳（数据面无此字段，本批也不
// 新增通道），故 hover 报的是**架上观察时刻**（到架 / 最近一次看到它变），
// 走役册同款的机读小字（`formatElapsed`）——不编造一个不存在的「资产时间」。

import { memo, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { RACK_CAP, rackBlocksOf } from '../../../paper/asset-rack';
import { plateSignOf } from '../../../paper/plate-sign';
import type { SourcedBlock } from './host';
import { PaperRegionContext, usePaperDock } from './host';
import { formatElapsed } from './WorkLedger';

/** 单条签条的渲染数据面（观察账的当前读数）。 */
interface RackEntry {
  block: SourcedBlock;
  assetId: string;
  /** 物类签（`paper/plate-sign` 单一真源）。 */
  sign: string;
  /** 题名（空串 = 该图版无题名——签恒在，标题位空着，不编造）。 */
  title: string;
  /** 表现形态（认脸用；空串 = 渲染层回落 default）。 */
  pres: string;
  /** 卷内文类签机读序号（与流里那块页边注上的同一个号——认脸的第一依据）。 */
  seq: string;
  /** 到架时刻（本组件的观察时刻）。 */
  at: number;
  /** 最近一次「内容变了」的时刻（null = 自到架以来没变过）。 */
  updatedAt: number | null;
}

/** 观察账条目：同一 assetId 上次见到的形状（签名 + 载荷引用）。 */
interface SeenAsset {
  sig: string;
  payload: unknown;
  at: number;
  updatedAt: number | null;
}

/** 资产签名：题名/表现/终值化任一变化都该被读成「变了」。
 *  payload 不进签名——按**引用**比（translate 原样透传 BlockPart.payload，
 *  更新时换新对象；同内容重建不换引用，故平移帧零误报）。 */
function assetSigOf(b: SourcedBlock): string {
  const a = b.asset;
  return `${b.kind}|${a?.presentation ?? ''}|${a?.title ?? ''}|${a?.finalised ? 1 : 0}`;
}

/** 机读钟（hover 用）：到架/更新的**观察时刻**，`HH:MM`。 */
function clockOf(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const AssetRack = memo(function AssetRack() {
  /* 流区数据面（**容缺读**：宿主未提供本 context 时架整条不渲染——同「能力位
   * 不实现 = 无读数，不炸链路」纪律，也让只挂坞岛的单件测试桩不必铺全 context）。 */
  const regionCtx = useContext(PaperRegionContext);
  const { activeSessionId, flyToPoint, expandBlock, dragBlockOut } = usePaperDock();
  /** 观察账（组件内纯内存，见文件头注）。 */
  const seenRef = useRef(new Map<string, SeenAsset>());
  /** 已「去看过」的更新代（assetId → 已认账的 updatedAt）——点一下即散点。 */
  const [acked, setAcked] = useState<Record<string, number>>({});

  const active =
    regionCtx && activeSessionId != null
      ? (regionCtx.regions.find((r) => r.sessionId === activeSessionId) ?? null)
      : null;
  const blocks = active?.blocks;
  const seq = active?.seq;

  /* 架内签条 + 观察账对账（**渲染期写 ref**：本仓无 StrictMode，同 PaperPanel 的
   * seenBlocksRef 先例——首见标记必须与本次渲染同帧生效，不能晚一帧到 effect）。
   * 依赖只有内容侧两块（blocks / seq）：平移帧引用稳定 ⇒ 零重算（P2-3 纪律）。 */
  const entries = useMemo<RackEntry[]>(() => {
    if (!blocks) return [];
    const seen = seenRef.current;
    const live = new Set<string>();
    const now = Date.now();
    const out: RackEntry[] = [];
    for (const b of rackBlocksOf(blocks)) {
      const asset = b.asset;
      if (!asset) continue; // rackBlocksOf 已判（类型面收窄）
      live.add(asset.assetId);
      const sig = assetSigOf(b);
      const prev = seen.get(asset.assetId);
      let rec: SeenAsset;
      if (!prev) rec = { sig, payload: b.payload, at: now, updatedAt: null };
      else if (prev.sig !== sig || prev.payload !== b.payload) {
        rec = { sig, payload: b.payload, at: prev.at, updatedAt: now };
      } else rec = prev;
      seen.set(asset.assetId, rec);
      out.push({
        block: b,
        assetId: asset.assetId,
        sign: plateSignOf(b.kind),
        title: asset.title ?? '',
        pres: asset.presentation,
        seq: seq?.get(b.id) ?? '',
        at: rec.at,
        updatedAt: rec.updatedAt,
      });
    }
    // 离架（钉出去 / 本卷没了）的划出观察账：拔钉收回 = **回架**（原位、序归位），
    // 不是「更新」——回来时按首见处理（D4）。
    for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    return out;
  }, [blocks, seq]);

  /* 点 = 飞到流里那一块（**layout 是块位置唯一真相**；取不到 = 退到流区内容底
   * ——「宁可飞得粗，也不空跳」）+ 收起态连展开 + 更新点散。 */
  const onChipClick = useCallback(
    (entry: RackEntry) => {
      if (!active || activeSessionId == null) return;
      const worldY = active.layout.get(entry.block.id)?.y ?? active.regionBottom;
      flyToPoint(activeSessionId, worldY);
      expandBlock?.(entry.block.id);
      const at = entry.updatedAt;
      if (at != null) setAcked((prev) => (prev[entry.assetId] === at ? prev : { ...prev, [entry.assetId]: at }));
    },
    [active, activeSessionId, flyToPoint, expandBlock],
  );

  // 空态判据 = **架内零张**（全钉出 / 本卷零资产同一条规则）⇒ 整条退场；
  // 无活跃卷 / 宿主未给流区 context ⇒ 同样不渲染（无主待命纪律）。
  if (!active || entries.length === 0) return null;

  const now = Date.now();
  const shown = entries.slice(0, RACK_CAP);
  const rest = entries.length - shown.length;

  return (
    /* biome-ignore lint/a11y/useSemanticElements: 架子是「一排签条」的容器，不是表单/列表语义——用 group + aria-label 给出读面名字 */
    <div className="pp-rack" role="group" aria-label={`图版架 · 本卷还有 ${entries.length} 张没摆出来`}>
      {shown.map((e) => {
        const fresh = e.updatedAt != null && acked[e.assetId] !== e.updatedAt;
        const when =
          e.updatedAt != null
            ? `更新于 ${formatElapsed(now - e.updatedAt)} 前（${clockOf(e.updatedAt)}）`
            : `架上 ${formatElapsed(now - e.at)}（${clockOf(e.at)} 到架）`;
        const title = [
          e.title || '（无题名）',
          `${e.block.kind}${e.pres ? ` · ${e.pres}` : ''}${e.seq ? ` · 序 ${e.seq}` : ''}`,
          when,
          '点＝飞到流里那一块 · 拖出＝钉到纸上（随即离架）',
        ].join('\n');
        return (
          <button
            key={e.block.id}
            type="button"
            className="pp-rack-chip"
            data-block-id={e.block.id}
            data-asset-id={e.assetId}
            title={title}
            aria-label={`${e.sign}${e.title ? ` ${e.title}` : ''}${fresh ? '（有更新）' : ''}`}
            onMouseDown={(ev) => dragBlockOut?.(ev, e.block)}
            onClick={() => onChipClick(e)}
          >
            <span className="pp-rack-sign" aria-hidden="true">
              {e.sign}
            </span>
            {e.title && <span className="pp-rack-title">{e.title}</span>}
            {fresh && <span className="pp-rack-upd" aria-hidden="true" />}
          </button>
        );
      })}
      {rest > 0 && <span className="pp-rack-more">… 另 {rest} 张</span>}
    </div>
  );
});
