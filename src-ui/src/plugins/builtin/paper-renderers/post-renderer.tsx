// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理**帖**的体渲染（2026-11-20 帖批；2026-11-21 内页批）。
//
// 从 renderers.tsx 拆出（上帝文件体量门禁：renderers.tsx 已到 1400 档）。拆的理由不只是
// 行数——帖是**一族独立的块**，它的体（内页 + 复命段）与「十一 kind 全谱」那种体不是
// 同一种东西：它要套别的 kind 的体渲染器（内页），还要按折叠态收敛。放在同一个文件里，
// 读者会以为它只是又一个 kind 的壳。
//
// 依赖纪律：本文件只用**本产物内**的导出（builtinRendererDefs 在本文件之外、JsonBody 在
// renderers.tsx）——体渲染器查表走注入的 resolve 回调，避免与 renderers.tsx 成环。

import type { ComponentType } from 'react';
import type { BlockRendererProps } from '../../../composition/renderer-service';
import type { SourcedBlock } from '../../../paper/block-model';

/** 兄弟 kind 的体渲染器解析器（由 renderers.tsx 注入，避开循环 import）。 */
export type BodyResolver = (kind: string) => ComponentType<BlockRendererProps> | undefined;
/** 子代理**帖**的体（2026-11-20 帖批；2026-11-21 帖内页批重写）。
 *
 *  **壳层与体怎么分工**：帖签行与活体行是**纸面读数**，由壳层承担（PostHead）；
 *  本组件画**体**——两段：
 *    ① **内页**（.pp-post-inner）：子代理自己的思考/工具/正文，按序已译成块
 *       （payload.inner，每块的 source.ownerPostId = 本帖）——**它们不属于父卷**，
 *       父卷的块数/流水号/单元/立枝/引用全都不认它们（见 use-paper-regions 分界点）；
 *       这里复用各 kind 的体渲染器，但不复发父卷的块壳（无文类签、无拖拽、无钉住）。
 *    ② **复命段**（.pp-post-report）：收尾后那一段回文 / 未办原因。
 *
 *  内页**默认收起**（用户 2026-11-21 拍板「思考放父卷里干嘛」）：帖签 + 活体行已经
 *  说清「谁 · 在干什么 · 多久」，内页是「我要查它到底做了什么」时才打开的抽屉。
 *  收起/展开走壳层折叠态（与工具族同一套手势与持久化），本组件按 folded 收敛。
 *
 *  ⚠ 判据必须与 post-metrics.ts 的 measurePostHeight 逐字同源：那边按
 *  「folded ? 不出内页；有 report/error 才加复命段」算高，这里同条件出 DOM。 */
export function SubagentPostBody({ block, folded, resolve }: BlockRendererProps & { resolve: BodyResolver }) {
  const p = block.payload as { status?: string; report?: string; error?: string; inner?: SourcedBlock[] };
  const inner = p.inner ?? [];
  const text = p.report || p.error || '';
  const failed = !p.report && !!p.error;
  return (
    <>
      {inner.length > 0 && <PostInner blocks={inner} folded={folded} resolve={resolve} />}
      {text && (
        <div className={`pp-post-report${failed ? ' pp-post-report--failed' : ''}`}>
          <div className="pp-post-report-lab">
            <span>复命</span>
            <span className={`pp-post-report-res ${failed ? 'pp-post-report-res--bad' : 'pp-post-report-res--ok'}`}>
              {failed ? '未办' : '已办'}
            </span>
          </div>
          <p className="pp-post-report-text">{text}</p>
        </div>
      )}
    </>
  );
}

/** 内页用的体渲染器查表：本文件就是出厂全谱，直接查自己的行——
 *  不走 composition 的 resolveRenderer（产物域不通那条通道，且内页要的是**出厂**
 *  体渲染，不是插件覆盖后的）。未知 kind 回落 JsonBody（保信息、不崩）。 */
/** 帖的内页：子代理自己的产出，逐块套各 kind 的**体**渲染器。
 *
 *  为什么复用体渲染器而不是另写一套：思考就是思考、工具卡就是工具卡、正文就是正文——
 *  语义投影（presentTool / markdown 解析）已经是一份，第二套必然漂。差别只在**壳**：
 *  内页没有文类签、没有拖拽/钉住/立枝、编号是局部的（1/7 而不是父卷的 ·021）。
 *
 *  折叠：内页整体跟着帖的折叠态走（folded = 收）。壳层默认折叠（fold.ts），故内页
 *  默认不开——与「父卷纸面要干净」同一条取向。 */
function PostInner({ blocks, folded, resolve }: { blocks: SourcedBlock[]; folded?: boolean; resolve: BodyResolver }) {
  if (folded) return null;
  return (
    <div className="pp-post-inner">
      {blocks.map((b, i) => {
        const Body = resolve(b.kind);
        return (
          <div className={`pp-post-inner-step pp-post-inner-step--${b.kind}`} key={b.id}>
            <span className="pp-post-inner-no">
              {i + 1}/{blocks.length}
            </span>
            <div className="pp-post-inner-body">
              {Body ? (
                <Body block={b} folded={false} />
              ) : (
                <div className="pp-json-fallback">{String((b.payload as { text?: string }).text ?? '')}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
