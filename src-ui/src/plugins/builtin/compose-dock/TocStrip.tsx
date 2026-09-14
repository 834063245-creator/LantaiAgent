// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/compose-dock/TocStrip — 目次带 v2（2026-09-01 minimap 换血）。
//
// 底子 = minimap（对齐 VSCode 交互语义），超越 = 语义刻痕/活线/未读区
// （拍板 10「关键时刻不同标记」后置债一并清偿）。三层结构：
//   - canvas 内容指纹：paper/ink inkForBlock 行盒骨架 → bar 直绘（镜像
//     InkLayer/MinimapView 画法；带内缩放比下一行常亚像素，bar 是唯一诚实
//     原语——真字形 fillText 亚像素不可辨），墨色走 inkColorOf 单一真源；
//   - DOM 滑块：computeSlider/grabOffsetAt/scrubViewTop 纯几何——拖拽 scrub
//     （grab offset 锁采样）、点滑块外即跳对中心再顺势拖、fit 全高不可拖；
//     scrub 直写 canvas-view-store（不走飞行动画——连续 scrub 动画必糊）。
//     夹紧域 = 可见视口（书眉下缘 → 坞上缘）：拖到底 = 内容底边贴坞顶线，
//     最新内容完整可见（2026-09-01 实机返工：全视口夹紧会把尾巴藏进坞后）；
//   - DOM 刻痕/活线/未读/hover 卡：deriveMarks 语义刻痕（点击 = flyToPoint
//     飞到该轮）、流式 writing head（石青呼吸线）、unreadBand 淡朱未读区、
//     hover 纸感卡（指哪读哪——行盒原文直出，刻痕/轮次次之）。
// 几何：带体 fixed 通栏（top:0/bottom:0，z 压书眉 z-30 与坞槽 z-6 之下）；
// 映射区 = [书眉下缘 + 刻痕半高, 坞上缘]（元素坐标 = 页面坐标），内容恒在
// 可见带内；映射区**永不与书眉（＝窗口标题栏，-webkit-app-region: drag）
// 重叠**——带内任何元素（刻痕盒/滑块/墨迹）都不得越界到 y < 书眉下缘
// （2026-09-14：刻痕盒不内缩半高，最上一枚就有 4px 落在书眉拖动带里，
// 点刻痕变成拖窗口）。
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'right-edge'），
// 经 paper/overlay-context 取活跃流区派生数据与折叠态（与主渲染同真源）。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SourcedBlock, StageUnitInput, TocMarkInput, TocRange } from './host';
import {
  agentSessionState,
  buildStageAnchors,
  computeSlider,
  createInkCache,
  deriveMarks,
  grabOffsetAt,
  inkColorOf,
  inkForBlock,
  jumpViewTopAt,
  nearestAnchorAt,
  scrubViewTop,
  unreadBand,
  useCanvasViewStore,
  useCoreStore,
  usePaperDock,
  usePaperRegion,
} from './host';

/** 书眉（＝窗口标题栏）下缘 = var(--bar-h)=56px（页面坐标）。 */
export const TOC_TOP = 56;
/** 刻痕盒半高（.pp-toc-mark 高 8px、刻位居中）——映射区顶必须再内缩这半高：
 *  刻痕盒 top = stripY − MARK_HALF，不内缩时最上一枚刻痕的盒顶会越过书眉
 *  下缘，那几像素点在书眉（命中归标题栏＝拖窗口），点刻痕点不中。 */
export const MARK_HALF = 4;
/** 映射区顶（页面坐标）= 书眉下缘 + 刻痕半高：带内一切（墨迹 canvas / 刻痕 /
 *  滑块 / 未读区 / hover 索引）共用此几何真源，无一元素越界到书眉带。 */
export const STRIP_TOP = TOC_TOP + MARK_HALF;
/** 创作坞槽的坐底抬高（.pp-composer-slot bottom:var(--composer-rise)=96px——
 *  坞顶线 = 页底 −96 −坞高；2026-09-02 拍板 C：两态同位，固定值不随窗口高浮动，
 *  与 tokens.css --composer-rise 同源镜像）。 */
const COMPOSER_RISE = 96;
/** 密度档阈值：块数超过后每块只画首行（MinimapView 同款策略）。 */
const DENSITY_BLOCKS = 80;
/** 刻痕 hover 命中半径（带内像素）——贴刻痕视觉足迹。 */
const MARK_HIT_R = 5;
/** user 轮 hover 命中半径（带内像素）——行盒原文未命中时的兜底。 */
const TURN_HIT_R = 14;
/** hover 卡单行原文截断。 */
const HOVER_TEXT_MAX = 120;

/** 未读账本（进程级瞬态 UI 态，键控自清理语义——不持久化，重启即全读）。 */
const lastReadBySession = new Map<string, number>();

/** SourcedBlock → 标记派生输入（payload 摘取；组状态 = 子项聚合）。 */
function markInputOf(b: SourcedBlock): TocMarkInput {
  const p = b.payload as {
    text?: string;
    status?: string;
    level?: string;
    label?: string;
    name?: string;
    description?: string;
    title?: string;
    items?: Array<{ status?: string }>;
  };
  let status = p.status;
  let preview = p.text ?? p.label ?? p.name ?? p.description ?? p.title ?? '';
  if (b.kind === 'toolgroup' && Array.isArray(p.items)) {
    status = p.items.some((it) => it?.status === 'error') ? 'error' : 'done';
    preview = `工具组 ×${p.items.length}`;
  }
  return {
    id: b.id,
    kind: b.kind,
    status,
    level: p.level,
    worldY: 0, // 由几何槽位回填（layout 是块位置唯一真相）
    worldH: 0,
    preview: preview.split('\n')[0] ?? '',
  };
}

/** hover 索引：单行原文（带内 y 区间 → 行文）——「指哪读哪」的查找结构。 */
interface HoverLine {
  y0: number;
  y1: number;
  text: string;
}
interface HoverBlock {
  top: number;
  bottom: number;
  lines: HoverLine[];
}

export const TocStrip = memo(function TocStrip() {
  const { regions, activeSessionId, viewRect, canvasSize, composerHeight, foldedOf } = usePaperRegion();
  const { flyToPoint } = usePaperDock();
  const core = useCoreStore((s) => s.core);
  const zoom = useCanvasViewStore((s) => s.view.zoom);

  const activeRegion = useMemo(
    () => (activeSessionId != null ? (regions.find((r) => r.sessionId === activeSessionId) ?? null) : null),
    [regions, activeSessionId],
  );

  /* 带体通栏（top:0/bottom:0），映射区 = [书眉下缘 + 刻痕半高, 坞上缘]
   * （元素坐标 = 页面坐标）。底 = 坞顶线（画布区底 − 抬高 − 坞高），不随顶内缩。 */
  const mappedBottom = Math.max(STRIP_TOP + 1, TOC_TOP + canvasSize.h - COMPOSER_RISE - composerHeight);
  /* ── 标记/锚点派生（几何槽位回填 worldY/worldH；一次建索引防 O(n²)）──
   * P2-3（2026-09-02 拖动卡顿专项）：依赖收窄到内容侧原语/稳定内层引用——
   * 原实现挂 activeRegion 对象引用，regions memo 每 pan 帧换引用 → 全部
   * O(块) 派生（markInputs/marks/turnAnchors/hover 索引/带体 canvas 重画）
   * 每帧重算。平移不改内容：regionTop/Bottom、blocks、flowGeom 在 P2-3
   * 布局核心缓存下引用稳定 = 平移帧零重算；内容/几何变化仍即时重算。 */
  const activeRegionTop = activeRegion?.regionTop;
  const activeRegionBottom = activeRegion?.regionBottom;
  const range: TocRange | null = useMemo(() => {
    if (activeRegionTop == null || activeRegionBottom == null) return null;
    return {
      regionTop: activeRegionTop,
      regionBottom: activeRegionBottom,
      stripTop: STRIP_TOP,
      stripBottom: mappedBottom,
    };
  }, [activeRegionTop, activeRegionBottom, mappedBottom]);

  const activeBlocks = activeRegion?.blocks;
  const activeFlowGeom = activeRegion?.flowGeom;
  const markInputs = useMemo<TocMarkInput[]>(() => {
    if (!activeBlocks || !activeFlowGeom) return [];
    const byId = new Map(activeBlocks.map((b) => [b.id, b]));
    const out: TocMarkInput[] = [];
    for (const g of activeFlowGeom) {
      const block = byId.get(g.id);
      if (!block) continue;
      const input = markInputOf(block);
      input.worldY = g.y;
      input.worldH = g.h;
      out.push(input);
    }
    return out;
  }, [activeBlocks, activeFlowGeom]);
  const marks = useMemo(() => (range ? deriveMarks(markInputs, range) : []), [markInputs, range]);
  /* ── 阶段导航锚（stream-rhythm 刀4）：目次带消费工作单元——阶段 = user 单元，
   *  与流的阶段间距/阶段细线同真源（group.WorkUnit）。markInputs 供几何槽位
   *  （worldY/worldH），单元供身份（unitId/阶段界）。P2-3 依赖收窄：activeUnits
   *  是核心缓存下的稳定内层引用，平移帧零重算。 */
  const activeUnits = activeRegion?.units;
  const stageAnchors = useMemo(() => {
    if (!range || !activeUnits) return [];
    const geomById = new Map(markInputs.map((m) => [m.id, m]));
    const inputs: StageUnitInput[] = [];
    for (const u of activeUnits) {
      if (u.kind !== 'user') continue;
      const m = geomById.get(u.memberIds[0]);
      if (!m) continue;
      inputs.push({
        unitId: u.id,
        kind: u.kind,
        blockId: m.id,
        worldY: m.worldY,
        worldH: m.worldH,
        preview: m.preview,
      });
    }
    return buildStageAnchors(inputs, range);
  }, [activeUnits, markInputs, range]);

  /* ── 滑块（可见视口 → 带上区间；VSCode 语义）──
   * 可见视口 = 书眉下缘 → 坞上缘：visY0 = 画布区顶，visY1 = 画布区底 − 坞高。 */
  const visY0 = viewRect.y0;
  const visY1 = viewRect.y1 - (COMPOSER_RISE + composerHeight) / Math.max(0.05, zoom);
  const visH = visY1 - visY0;
  const slider = useMemo(() => (range ? computeSlider(range, visY0, visY1) : null), [range, visY0, visY1]);

  /* ── 未读区：lastRead = 已看过的最大视口底（min 可见底封顶）；
   *  追流时可见底 ≥ regionBottom（流锚留白）→ 自动消化；上翻则欠账累积。 ── */
  const [, setReadTick] = useState(0);
  useEffect(() => {
    if (!activeSessionId || !range) return;
    const next = Math.min(visY1, range.regionBottom);
    const cur = lastReadBySession.get(activeSessionId);
    if (cur !== undefined && next <= cur) return;
    lastReadBySession.set(activeSessionId, cur === undefined ? next : Math.max(cur, next));
    setReadTick((t) => t + 1);
  }, [activeSessionId, range, visY1]);
  const unread =
    range && activeSessionId && lastReadBySession.has(activeSessionId)
      ? unreadBand(lastReadBySession.get(activeSessionId) as number, range)
      : null;

  /* ── 活线：活跃卷流式运行 → 坞顶线处石青呼吸 writing head ──
   *  P2-3：依赖收窄到卷号原语——activeRegion 引用每 pan 帧换，exec 订阅
   *  不随平移重挂。运行态同步根治（2026-09-06）：捕获式单实例订阅在 exec
   *  迟到/被换（惰性水合/拟文 getOrCreateExec）时指空对象——改
   *  subscribeExecAll（实例表变更全部重挂），sync 每次现读活跃卷 exec。 */
  const [streaming, setStreaming] = useState(false);
  const activeSessionNum = activeRegion?.sessionNum;
  useEffect(() => {
    if (!core || activeSessionNum == null) {
      setStreaming(false);
      return;
    }
    const sync = () => setStreaming(agentSessionState.getExec(core.panelId, activeSessionNum)?.isRunning ?? false);
    const un = agentSessionState.subscribeExecAll(core.panelId, sync);
    return () => un();
  }, [core, activeSessionNum]);

  /* ── canvas 内容指纹（镜像 MinimapView 画法：inkForBlock → bar fillRect）──
   *  P2-3（2026-09-02 拖动卡顿专项）：依赖收窄到稳定内层引用 + 几何原语——
   *  平移帧不重画（regions memo P2-3 核心缓存下 blocks/layout 引用稳定、
   *  anchor 原语不变）；内容/挪卷/改宽仍即时重画。 */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inkCacheRef = useRef(createInkCache());
  const activeLayout = activeRegion?.layout;
  const activeAnchorX = activeRegion?.anchor.anchorX;
  const activeAnchorW = activeRegion?.anchor.width;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeBlocks || !activeLayout || activeAnchorX == null || activeAnchorW == null || !range) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, canvas.clientWidth);
    const H = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const contentH = Math.max(1, range.regionBottom - range.regionTop);
    const ys = (range.stripBottom - range.stripTop) / contentH;
    const regionW = Math.max(1, activeAnchorW);
    const xs = W / regionW;
    const left = activeAnchorX - regionW / 2;
    const flow = activeBlocks.filter((b) => b.state === 'flow');
    const density = flow.length > DENSITY_BLOCKS;
    for (const b of flow) {
      const slot = activeLayout.get(b.id);
      if (!slot) continue;
      const ink = inkForBlock(b, foldedOf(b), inkCacheRef.current);
      const bar0 = ink.bars[0];
      if (!bar0) continue;
      ctx.fillStyle = inkColorOf(b.kind);
      if (density) {
        ctx.fillRect(
          (slot.x + bar0.x0 - left) * xs,
          range.stripTop + (slot.y - range.regionTop) * ys,
          Math.max(1, bar0.w * xs),
          1.2,
        );
        continue;
      }
      const h = Math.max(0.6, ink.lineH * ys * 0.55);
      for (const bar of ink.bars) {
        ctx.fillRect(
          (slot.x + bar.x0 - left) * xs,
          range.stripTop + (slot.y + bar.dy - range.regionTop) * ys,
          Math.max(0.5, bar.w * xs),
          h,
        );
      }
    }
  }, [activeBlocks, activeLayout, activeAnchorX, activeAnchorW, range, foldedOf]);

  /* ── hover 索引：行盒原文 → 带内 y 区间（与画笔同一几何、同一缓存）── */
  const hoverIndex = useMemo<HoverBlock[]>(() => {
    if (!activeBlocks || !activeLayout || !range) return [];
    const ys = (range.stripBottom - range.stripTop) / Math.max(1, range.regionBottom - range.regionTop);
    const out: HoverBlock[] = [];
    for (const b of activeBlocks) {
      if (b.state !== 'flow') continue;
      const slot = activeLayout.get(b.id);
      if (!slot) continue;
      const ink = inkForBlock(b, foldedOf(b), inkCacheRef.current);
      const lines: HoverLine[] = [];
      for (const bar of ink.bars) {
        const y0 = range.stripTop + (slot.y + bar.dy - range.regionTop) * ys;
        const h = Math.max(0.6, ink.lineH * ys * 0.55);
        if (bar.text) lines.push({ y0, y1: y0 + h, text: bar.text });
      }
      if (lines.length === 0) continue;
      const lastBar = ink.bars[ink.bars.length - 1];
      out.push({
        top: range.stripTop + (slot.y - range.regionTop) * ys,
        bottom: range.stripTop + (slot.y + lastBar.dy + ink.lineH - range.regionTop) * ys,
        lines,
      });
    }
    return out;
  }, [activeBlocks, activeLayout, range, foldedOf]);

  /* ── 指针交互：滑块拖拽 scrub / 点带即跳（夹紧域 = 可见视口）── */
  const dragRef = useRef<{ offset: number } | null>(null);
  const applyVisTop = (visTop: number): void => {
    useCanvasViewStore.getState().setView((v) => ({ ...v, panY: -visTop * v.zoom }));
  };
  const stripYOf = (clientY: number, el: HTMLElement): number => clientY - el.getBoundingClientRect().top;

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || !range || !slider) return;
    const stripY = stripYOf(e.clientY, e.currentTarget);
    /* 带外一律不响应（2026-09-14 行为变更）：元素框是通栏 fixed（top:0/bottom:0），
     * 但映射区只有 [书眉下缘 + 刻痕半高, 坞上缘]——书眉带归标题栏（拖动/窗口钮），
     * 坞下装饰带无语义。此前这两处按下仍会 scrub，视口被顺手拽走（实测坞下
     * 一点：画布从 panY 1580 跳到 90285）。 */
    if (stripY < range.stripTop || stripY > range.stripBottom) return;
    if (slider.draggable) {
      const inSlider = stripY >= slider.top && stripY <= slider.top + slider.height;
      const offset = inSlider ? grabOffsetAt(stripY, slider) : slider.height / 2;
      if (!inSlider) applyVisTop(scrubViewTop(stripY, offset, range, visH)); // 点外即跳（对中心）再顺势拖
      dragRef.current = { offset };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      // fit（内容不满可见区）：点击对中心，无可拖
      applyVisTop(jumpViewTopAt(stripY, range, visH));
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || !range) return;
    applyVisTop(scrubViewTop(stripYOf(e.clientY, e.currentTarget), drag.offset, range, visH));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  /* ── hover 预览卡：行盒原文（指哪读哪）> 刻痕 > 最近 user 轮 ── */
  const [hover, setHover] = useState<{ y: number; text: string } | null>(null);
  const onMouseMove = (e: React.MouseEvent<HTMLElement>): void => {
    if (dragRef.current || !range) return;
    const stripY = stripYOf(e.clientY, e.currentTarget);
    let text: string | null = null;
    // 1) 刻痕（贴足迹命中——语义优先于原文）
    for (const m of marks) {
      if (Math.abs(m.stripY - stripY) <= MARK_HIT_R) {
        text = m.preview;
        break;
      }
    }
    // 2) 光标下的行盒原文（指哪读哪）
    if (text === null) {
      for (const hb of hoverIndex) {
        if (stripY < hb.top || stripY > hb.bottom) continue;
        let best: HoverLine | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const line of hb.lines) {
          if (stripY >= line.y0 && stripY <= line.y1) {
            best = line;
            break;
          }
          const d = Math.min(Math.abs(stripY - line.y0), Math.abs(stripY - line.y1));
          if (d < bestD) {
            bestD = d;
            best = line;
          }
        }
        if (best) text = best.text;
        break;
      }
    }
    // 3) 最近阶段锚（行盒间隙兜底）——带阶段序（stream-rhythm 刀4）
    if (text === null) {
      const a = nearestAnchorAt(stripY, stageAnchors);
      if (a && Math.abs(a.stripY - stripY) <= TURN_HIT_R) text = `阶段 ${a.stageIndex} · ${a.preview}`;
    }
    text = text === null ? null : text.slice(0, HOVER_TEXT_MAX);
    setHover((prev) => {
      if (text === null) return prev === null ? prev : null;
      return prev && prev.text === text ? prev : { y: stripY, text };
    });
  };
  const onMouseLeave = (): void => setHover(null);

  if (!activeRegion || !range || activeRegion.blocks.length === 0) return null;

  return (
    <nav
      className="pp-toc"
      aria-label="目次带（卷内导航）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <canvas ref={canvasRef} className="pp-toc-ink" />
      {unread && <div className="pp-toc-unread" style={{ top: unread.top, height: unread.height }} />}
      {slider && (
        <div
          className={`pp-toc-slider${slider.draggable ? '' : ' is-fit'}`}
          style={{ top: slider.top, height: slider.height }}
        />
      )}
      {marks.map((m) => (
        <button
          key={m.blockId}
          type="button"
          className={`pp-toc-mark is-${m.kind}`}
          style={{ top: m.stripY - MARK_HALF }}
          title={m.preview}
          aria-label={`跳到：${m.preview}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (activeSessionId) flyToPoint(activeSessionId, m.worldY);
          }}
        />
      ))}
      {streaming && <div className="pp-toc-head" style={{ top: mappedBottom - 2 }} />}
      {hover && (
        <div className="pp-toc-card" style={{ top: hover.y }} role="tooltip">
          {hover.text}
        </div>
      )}
    </nav>
  );
});
