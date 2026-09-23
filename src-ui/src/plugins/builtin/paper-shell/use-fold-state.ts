// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 折叠态域（paper-panel-split C1）——用户显式折叠覆盖表 + 四个判定/切换回调。
// 规则态在 paper/fold.ts（夹注恒折；脚注/程文按状态：running/error 展开、其余
// 收起）。本表只存用户显式覆盖（点折叠行）——覆盖缺席回落规则态，running→done
// 的状态翻转自动收回的是「没有用户意志的默认态」，不打架。

import { useCallback, useState } from 'react';
import type { SourcedBlock } from './host';
import { defaultFolded } from './host';

/** 折叠覆盖表（paper-panel-split C1，自 PaperPanel 668-695 域内原样搬入）。
 *  P5 眉批折叠（夹注恒折拍板延续）：key = `${block.id}:sc`，缺省收起。 */
export function useFoldState() {
  const [foldOv, setFoldOv] = useState<Record<string, boolean>>({});
  const foldedOf = useCallback(
    (b: SourcedBlock): boolean => foldOv[b.id] ?? defaultFolded(b.kind, b.payload, b),
    [foldOv],
  );
  const onToggleFold = useCallback((b: SourcedBlock) => {
    setFoldOv((prev) => {
      const cur = prev[b.id] ?? defaultFolded(b.kind, b.payload, b);
      return { ...prev, [b.id]: !cur };
    });
  }, []);
  /** 显式**展开**（幂等，非翻转）：架上签条单击后「连展开」用——图版卡默认收起
   *  （paper/fold 规则），架上报的块若还收着，飞过去看到的只是一行签条，等于没到。
   *  写的是**用户覆盖**（与点折叠行同一条路）⇒ 之后不会被状态翻转自动收回。 */
  const expandBlock = useCallback((b: SourcedBlock) => {
    setFoldOv((prev) => (prev[b.id] === false ? prev : { ...prev, [b.id]: false }));
  }, []);
  /* P5 眉批折叠（夹注恒折拍板延续）：key = `${block.id}:sc`，缺省收起。 */
  const sidecarFoldedOf = useCallback((b: SourcedBlock): boolean => foldOv[`${b.id}:sc`] ?? true, [foldOv]);
  const onToggleSidecarFold = useCallback((b: SourcedBlock) => {
    setFoldOv((prev) => {
      const key = `${b.id}:sc`;
      const cur = prev[key] ?? true;
      return { ...prev, [key]: !cur };
    });
  }, []);
  return { foldedOf, onToggleFold, expandBlock, sidecarFoldedOf, onToggleSidecarFold };
}
