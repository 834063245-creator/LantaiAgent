// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/compose-dock/TocStrip — 目次带 v3（2026-09-14 甲：可点层拆出；
// 同日乙：识别层换装）。四层结构（职责分离，谁也不挤在同一个命中面上——
// 用户拍板「丙：甲 + 乙」，甲已落地、乙本批落地）：
//   - canvas 识别层（**乙**）：paper/toc-ink 把行盒聚成**带内墨桶**——形状 =
//     桶内最宽行右缘（剪影）、墨量 = 桶内墨面积归一的深浅（哪里长/哪里密）、
//     族色 = 定形行的块 kind → inkBarColorOf（墨色真源仍在 paper/ink.ts）、
//     错桶另立 `--fail` 短规（错要最响）。桶是带内唯一诚实的竖向原语：带内
//     缩放比常见 0.005–0.012，行距/缩进/块间留白全在 1px 之下，逐行直画即糊
//     （v2「每块首行一根 1.2px 细条 + 块级降级」实机空行率 0.42–0.81 = 用户
//     读作「滚动条」）。定档见原型 prototype/toc-thumb-ab.html + 规格书 §13；
//   - DOM 滑块：computeSlider/grabOffsetAt/scrubViewTop 纯几何——拖拽 scrub
//     （grab offset 锁采样）、点滑块外即跳对中心再顺势拖、fit 全高不可拖；
//     scrub 直写 canvas-view-store（不走飞行动画——连续 scrub 动画必糊）。
//     夹紧域 = 可见视口（书眉下缘 → 坞上缘）：拖到底 = 内容底边贴坞顶线，
//     最新内容完整可见（2026-09-01 实机返工：全视口夹紧会把尾巴藏进坞后）；
//   - DOM 阶段锚（**带内唯一可点目标**）：buildStageAnchors 消费工作单元
//     （阶段 = user 单元，与流的阶段间距/细线同真源）——朱砂横规 + 28px 命中
//     盒，点击 = flyToPoint 飞到该阶段首块；
//   - DOM 装饰刻痕/活线/未读/hover 卡：deriveMarks 非阶段锚刻痕**退为纯扫读
//     信号**（惰性 div + aria-hidden + CSS pointer-events:none，不参与命中）、
//     流式 writing head（石青呼吸线）、unreadBand 淡朱未读区、hover 纸感卡
//     （指哪读哪；命中盒与卡片同源：卡片所示即点击所得）。
// 病史（2026-09-14 实机实测，本设计的由来）：旧版把 289 枚刻痕全做成 button
// 命中盒（10×8）——tool 刻痕 255 枚把 18 枚阶段锚挤到平均 3.8px 间距，命中盒
// 相互叠压，DOM 后渲染者胜：点自己那枚的比例只有 7.3%（268/289 被相邻刻痕
// 盖住），用户读作「刻痕点不中」；同时 289 个 tab 停靠点也是键盘灾难。
// 现在：可点目标 = 18 枚阶段锚（实测间距 63px，单枚命中盒 28px 高）；装饰层
// 只负责扫读（密集段自然读作密、报错恒在最上）；连续 scrub 归滑块 + 带空白处。
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
import type { SourcedBlock, StageUnitInput, TocInkLine, TocMarkInput, TocRange } from './host';
import {
  agentSessionState,
  buildStageAnchors,
  buildTocInkBuckets,
  computeSlider,
  createInkCache,
  deriveMarks,
  grabOffsetAt,
  INK_FAIL,
  inkBarColorOf,
  inkForBlock,
  jumpViewTopAt,
  scrubViewTop,
  unreadBand,
  useCanvasViewStore,
  useCoreStore,
  usePaperDock,
  usePaperRegion,
} from './host';

/** 书眉（＝窗口标题栏）下缘 = var(--bar-h)=56px——**带体自身的页面起点**
 *  （CSS `.pp-toc { top: var(--bar-h) }`，2026-09-14 整体下移）。此处是字面量
 *  镜像与测试基准：带体坐标 = 页面坐标 − TOC_TOP，带体与标题栏零像素重叠。 */
export const TOC_TOP = 56;
/** 刻痕盒半高（.pp-toc-mark 高 8px、刻位居中）——映射区顶必须再内缩这半高：
 *  刻痕盒 top = stripY − MARK_HALF，不内缩时最上一枚刻痕的盒顶会越出带体顶
 *  （越出即进书眉带：那几像素点在书眉＝拖窗口，点刻痕点不中）。 */
export const MARK_HALF = 4;
/** 映射区顶（**带体坐标**）= 刻痕半高：带体本身已从书眉下缘起，带内一切
 *  （墨迹 canvas / 刻痕 / 阶段锚 / 滑块 / 未读区 / hover 卡）共用此几何真源、
 *  恒 top ≥ 0——「不越进书眉带」由「带体不在那一带」结构性保证。 */
export const STRIP_TOP = MARK_HALF;
/** hover 卡翻转阈（带体坐标）：hover.y 低于此值时卡片改「挂在红线下方」、
 *  不再上下居中——卡片最大半高（约 4 行 ≈ 36px）+ 余量。否则贴顶 hover 时
 *  卡片上半会越出带体（进书眉带，压住标题栏的设置/回首页/窗口钮）。 */
export const TOC_CARD_FLIP_Y = 40;
/** 翻转态卡片与红线的间隙（px）。 */
const TOC_CARD_GAP = 12;
/** 创作坞槽的坐底抬高（.pp-composer-slot bottom:var(--composer-rise)=96px——
 *  坞顶线 = 页底 −96 −坞高；2026-09-02 拍板 C：两态同位，固定值不随窗口高浮动，
 *  与 tokens.css --composer-rise 同源镜像）。 */
const COMPOSER_RISE = 96;
/** 错桶短规宽（带内 px）——错是语义状态，不走族色深浅（最响的一档）。 */
const INK_FAIL_RULE_W = 4;
/** 阶段锚命中盒高（px）= CSS .pp-toc-anchor 的 height（单一真源：热区 ≥24px
 *  纪律；卡片判定半径 = 其半高——**卡片所示即点击所得**）。 */
export const STAGE_HIT_H = 28;
const STAGE_HIT_HALF = STAGE_HIT_H / 2;
/** 装饰刻痕 hover 判定半径（带内像素）——贴着那枚才读它（视觉足迹 3×6，
 *  两侧各让 1px）。它不再参与命中：刻痕层是扫读信号，不是点击靶。 */
const TICK_HIT_R = 4;
/** hover 卡单行原文截断。 */
const HOVER_TEXT_MAX = 120;

/** 未读账本（进程级瞬态 UI 态，键控自清理语义——不持久化，重启即全读）。 */
const lastReadBySession = new Map<string, number>();

/** hover 卡的锚点（纯函数，带体坐标入/出）：默认上下居中（跟随红线）；
 *  贴顶时翻转到红线下方——**卡片任何位置都不得越出带体顶**（越出即进书眉带，
 *  压住标题栏的设置/回首页/窗口钮，2026-09-14 用户报「还是打架」的第二处）。 */
export function cardAnchorFor(hoverY: number): { top: number; transform: string } {
  if (hoverY < TOC_CARD_FLIP_Y) return { top: hoverY + TOC_CARD_GAP, transform: 'none' };
  return { top: hoverY, transform: 'translateY(-50%)' };
}

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
  /* 带体从书眉下缘起（CSS top: var(--bar-h)），映射区 = [刻痕半高, 坞顶线]
   * ——**带体坐标**（= 页面坐标 − TOC_TOP）。坞顶线 = 画布区底 − 抬高 − 坞高。 */
  const mappedBottom = Math.max(STRIP_TOP + 1, canvasSize.h - COMPOSER_RISE - composerHeight);
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

  /* ── 可点层 / 装饰层分家（2026-09-14 甲）──
   * 装饰层 = 非阶段锚的一切刻痕（tool/plan/error 全部，外加**没有对应单元的
   * 用户块**——没有阶段就没有可点目标，此处不撒谎，让它以刻痕形态留个印子）。
   * 装饰层不参与命中（惰性 div + aria-hidden + CSS pointer-events:none）。 */
  const anchorBlockIds = useMemo(() => new Set(stageAnchors.map((a) => a.blockId)), [stageAnchors]);
  const decorations = useMemo(
    () => marks.filter((m) => m.kind !== 'user' || !anchorBlockIds.has(m.blockId)),
    [marks, anchorBlockIds],
  );

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
  /* 报错块集（deriveMarks 的 error 族）——识别层的「错」通道与刻痕层同源：
     两处都从同一份 marks 派生，不另立判据。 */
  const errorBlockIds = useMemo(() => new Set(marks.filter((m) => m.kind === 'error').map((m) => m.blockId)), [marks]);
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
    /* 行盒 → 桶输入（识别层唯一数据面：形状右缘 / 墨面积 / 族 kind / 错旗）。
       逐行喂进去，聚合交给 paper/toc-ink 纯函数——绘制只认桶。 */
    const lines: TocInkLine[] = [];
    for (const b of activeBlocks) {
      if (b.state !== 'flow') continue;
      const slot = activeLayout.get(b.id);
      if (!slot) continue;
      const ink = inkForBlock(b, foldedOf(b), inkCacheRef.current);
      if (ink.bars.length === 0) continue;
      const err = errorBlockIds.has(b.id);
      for (const bar of ink.bars) {
        lines.push({
          rel: (slot.y + bar.dy - range.regionTop) * ys,
          right: Math.min(W, Math.max(0, (slot.x + bar.x0 + bar.w - left) * xs)),
          area: Math.max(0, bar.w * xs),
          kind: b.kind,
          err,
        });
      }
    }
    for (const bucket of buildTocInkBuckets(lines, range)) {
      ctx.globalAlpha = bucket.alpha; // 墨量档：哪里长／哪里密
      ctx.fillStyle = inkBarColorOf(bucket.kind); // 族色：这是什么（墨色真源）
      ctx.fillRect(0, bucket.top, Math.max(0.6, bucket.width), bucket.height);
      if (bucket.err) {
        ctx.globalAlpha = 1; // 错：最响的一档，不参与墨量深浅
        ctx.fillStyle = INK_FAIL;
        ctx.fillRect(0, bucket.top, INK_FAIL_RULE_W, bucket.height);
      }
    }
    ctx.globalAlpha = 1;
  }, [activeBlocks, activeLayout, activeAnchorX, activeAnchorW, range, foldedOf, errorBlockIds]);

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
    /* 阶段锚自己接手势（onClick = 飞到该阶段）——按下它不启动 scrub：
     * 否则同一按既 scrub 又飞（两个落点抢同一根指针）。 */
    if ((e.target as Element | null)?.closest('.pp-toc-anchor')) return;
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

  /* ── hover 预览卡：命中盒与卡片**同源**（卡片所示即点击所得）──
   * 顺序 = 可点层优先：① 阶段锚命中盒内（|Δ| ≤ STAGE_HIT_HALF）→「阶段 N · 首句」，
   * 按下就是飞到它；② 贴着装饰刻痕（|Δ| ≤ TICK_HIT_R）→ 那枚的语义预览（按下 =
   * scrub 到该 y；那枚同时提墨一档，卡片所示即高亮所在）；③ 光标下的行盒原文
   * （指哪读哪——按下 = scrub 到该 y）。 */
  const [hover, setHover] = useState<{ y: number; text: string; tickId: string | null } | null>(null);
  const onMouseMove = (e: React.MouseEvent<HTMLElement>): void => {
    if (dragRef.current || !range) return;
    const stripY = stripYOf(e.clientY, e.currentTarget);
    let text: string | null = null;
    let tickId: string | null = null;
    // 1) 阶段锚（可点层优先——导航是第一用途）
    for (const a of stageAnchors) {
      if (Math.abs(a.stripY - stripY) <= STAGE_HIT_HALF) {
        text = `阶段 ${a.stageIndex} · ${a.preview}`;
        break;
      }
    }
    // 2) 贴着装饰刻痕（扫读信号）
    if (text === null) {
      for (const m of decorations) {
        if (Math.abs(m.stripY - stripY) <= TICK_HIT_R) {
          text = m.preview;
          tickId = m.blockId;
          break;
        }
      }
    }
    // 3) 光标下的行盒原文（指哪读哪）
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
    text = text === null ? null : text.slice(0, HOVER_TEXT_MAX);
    setHover((prev) => {
      if (text === null) return prev === null ? prev : null;
      if (prev && prev.text === text && prev.tickId === tickId) return prev;
      return { y: stripY, text, tickId };
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
      {/* 装饰刻痕（扫读层）：惰性 div + aria-hidden + CSS pointer-events:none——
          不是点击靶（点它们 = 点带空白 = scrub 到该 y），也不再是 289 个 tab 停靠点。 */}
      {decorations.map((m) => (
        <div
          key={m.blockId}
          className={`pp-toc-mark is-${m.kind}${hover?.tickId === m.blockId ? ' is-hover' : ''}`}
          style={{ top: m.stripY - MARK_HALF }}
          aria-hidden="true"
        />
      ))}
      {/* 阶段锚（可点层）：带内唯一可点的离散目标——28px 命中盒（热区纪律），
          点击 = 飞到该阶段首块。 */}
      {stageAnchors.map((a) => (
        <button
          key={a.unitId}
          type="button"
          className="pp-toc-anchor"
          style={{ top: a.stripY - STAGE_HIT_HALF }}
          aria-label={`跳到阶段 ${a.stageIndex}：${a.preview}`}
          onClick={() => {
            if (activeSessionId) flyToPoint(activeSessionId, a.worldY);
          }}
        />
      ))}
      {streaming && <div className="pp-toc-head" style={{ top: mappedBottom - 2 }} />}
      {hover && (
        <div
          className="pp-toc-card"
          style={{ top: cardAnchorFor(hover.y).top, transform: cardAnchorFor(hover.y).transform }}
          role="tooltip"
        >
          {hover.text}
        </div>
      )}
    </nav>
  );
});
