// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/panels/TocStrip — 目次带（会话内 minimap，Stage-4 §4.4）。
// （增补四起源码落位 plugins/builtin/compose-dock/——产物通道化。）
//
// 拍板（canvas-space-model-notes.md §5 拍板 10）：右缘窄条、屏幕固定、内容
// 跟随活跃会话。骨架 = 轮次锚点（每个 user 输入一个刻度，位置映射相对高度）
// + 点击跳转（视口飞到该轮）+ 位置指示（当前视口在带上的刻度）+ hover 首句
// 预览。锚点 = 先纯 user 轮次（stage-4 §8 拍板 4）。
//
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'right-edge'），
// 由 PaperPanel 渲染在右缘；经 paper/overlay-context 取活跃流区派生数据与
// flyToPoint 动作。几何计算在 paper/toc（纯函数，单测覆盖）。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { memo, useMemo } from 'react';
import type { TocRange } from './host';
import { buildTurnAnchors, nearestAnchorAt, usePaperDock, usePaperRegion, viewportMarker } from './host';

/** 带上界 = 书眉高 var(--bar-h)=56px。 */
const TOC_TOP = 56;

export const TocStrip = memo(function TocStrip() {
  const { regions, activeSessionId, viewRect, canvasSize, composerHeight } = usePaperRegion();
  const { flyToPoint } = usePaperDock();

  const activeRegion = useMemo(
    () => (activeSessionId != null ? (regions.find((r) => r.sessionId === activeSessionId) ?? null) : null),
    [regions, activeSessionId],
  );

  const range: TocRange | null = useMemo(() => {
    if (!activeRegion) return null;
    // 带内坐标用相对容器的 y；容器 bottom = 创作坞实际高度（rework P3-1）
    return {
      regionTop: activeRegion.regionTop,
      regionBottom: activeRegion.regionBottom,
      stripTop: 0,
      stripBottom: Math.max(0, canvasSize.h - TOC_TOP - composerHeight),
    };
  }, [activeRegion, canvasSize.h, composerHeight]);

  const anchors = useMemo(() => {
    if (!activeRegion || !range) return [];
    // 一次建块索引（O(n)），避免每块 find 造成 O(n²)——目次带随平移高频重渲
    const byId = new Map(activeRegion.blocks.map((b) => [b.id, b]));
    const inputs = activeRegion.flowGeom.map((g) => {
      const block = byId.get(g.id);
      const text =
        block?.kind === 'user' && typeof (block.payload as { text?: string }).text === 'string'
          ? ((block.payload as { text: string }).text ?? '')
          : '';
      return {
        blockId: g.id,
        kind: block?.kind ?? 'markdown',
        worldY: g.y,
        worldH: g.h,
        preview: text,
      };
    });
    return buildTurnAnchors(inputs, range);
  }, [activeRegion, range]);

  const marker = useMemo(
    () => (range ? viewportMarker(viewRect.y0, viewRect.y1, range) : null),
    [range, viewRect.y0, viewRect.y1],
  );

  const onStripClick = (clientY: number) => {
    if (!activeSessionId || anchors.length === 0) return;
    const anchor = nearestAnchorAt(clientY, anchors);
    if (anchor) flyToPoint(activeSessionId, anchor.worldY);
  };

  if (!activeRegion || anchors.length === 0) return null;

  return (
    <nav
      className="pp-toc"
      style={{ bottom: composerHeight + 8 }}
      aria-label="目次带（卷内导航）"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onStripClick(e.clientY - rect.top);
      }}
    >
      {marker && (
        <div
          className="pp-toc-viewport"
          style={{ top: marker.top, bottom: undefined, height: Math.max(2, marker.bottom - marker.top) }}
        />
      )}
      {anchors.map((a) => (
        <button
          key={a.blockId}
          type="button"
          className="pp-toc-anchor"
          style={{ top: a.stripY - 3 }}
          title={a.preview}
          aria-label={`跳到轮次：${a.preview}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (activeSessionId) flyToPoint(activeSessionId, a.worldY);
          }}
        />
      ))}
    </nav>
  );
});
