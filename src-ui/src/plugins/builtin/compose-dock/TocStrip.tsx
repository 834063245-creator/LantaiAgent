// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/compose-dock/TocStrip — 目次带 v4.1（2026-10-20：两栏 / 编号 / 纸捻）。
// **v4 的一句话**：左 64 是目次栏（竖脊 + 阶段规 + 编号 + 纸窗滑块），右 40 是
// 书口墨影（右对齐剪影，族色染剪影、错另立 fail 短规）；带体是不透明纸捻。
// 翻案与理由见 paper-shell/PaperPanel.css 带体头注、规格书 §13、taste-ledger 2026-10-20 条。
// **v4.1 实机修订（用户三点反馈）**：① 墨影不见——canvas 是 replaced element，
// CSS `width:auto` 用固有宽 300 而不是解 left/right，墨影全画到屏外；改给死宽 40。
// ② 纸捻读作纯色底——把纸口明度拉开（右缘 78% paper-deep）+ 2px 受光/背光 + 内影。
// ③ 带脚「目次」小签摘除；映射区顶从 4 抬到 56（顶部浮件带高），上下都留空隙。
// **同批修的 bug**：hover 卡旧 CSS 只有 max-width、定位用 right，在 64px 列里
// 算出负可用宽 → 实测塌成 36.1×249.1 的竖条（本文件原型同构复现）；现在卡定宽
// 268 + border-box（CSS），本文件只负责把 eyebrow（阶段 N / 工具 / 正文…）交给它。
//
// 四层结构（v3 起，v4 不变——职责分离，谁也不挤在同一个命中面上）：
//   - canvas 识别层：paper/toc-ink 把行盒聚成**带内墨桶**——形状 =
//     桶内最宽行右缘（剪影）、墨量 = 桶内墨面积归一的深浅（哪里长/哪里密）、
//     族色 = 定形行的块 kind → inkBarColorOf（墨色真源仍在 paper/ink.ts）、
//     错桶另立 `--fail` 短规（错要最响）。v4 的渲染变化：桶画在**右 40**、
//     **右对齐**（参差朝向目次栏）、族色直接染剪影但按族给增益（人最响、
//     工具/程文次之、图表最弱）、不再留 2px/1px 的「页层缝」（1x 下是扫描线）。
//     淘汰案（同尺子判死，勿复活）：缩进剪影、阶段分带、逐行直画——见 §13。
//   - DOM 滑块：computeSlider/grabOffsetAt/scrubViewTop 纯几何——拖拽 scrub
//     （grab offset 锁采样）、点滑块外即跳对中心再顺势拖、fit 全高不可拖；
//     scrub 直写 canvas-view-store（不走飞行动画——连续 scrub 动画必糊）。
//     夹紧域 = 可见视口（画布区顶 → 坞上缘）：拖到底 = 内容底边贴坞顶线，
//     最新内容完整可见（2026-09-01 实机返工：全视口夹紧会把尾巴藏进坞后）；
//     v4 视觉 = 上下两条朱规的「纸窗」+ 右缘纸捻抓手（is-dragging 亮一档）。
//   - DOM 阶段锚（**带内唯一可点目标**）：buildStageAnchors 消费工作单元
//     （阶段 = user 单元，与流的阶段间距/细线同真源）——朱砂横规 + 28px 命中
//     盒，点击 = flyToPoint 飞到该阶段首块；v4 加**阶段编号**（自适应省号，
//     当前阶段朱砂加粗 + 脊上一枚方点）。
//   - DOM 装饰刻痕/活线/未读/hover 卡：deriveMarks 非阶段锚刻痕**退为纯扫读
//     信号**（惰性 div + aria-hidden + CSS pointer-events:none，不参与命中）、
//     流式 writing head（石青呼吸线）、unreadBand 淡青未读区、hover 纸感卡
//     （指哪读哪；命中盒与卡片同源：卡片所示即点击所得；v4 卡有 eyebrow + 语色条）。
// 病史（2026-09-14 实机实测，本设计的由来）：旧版把 289 枚刻痕全做成 button
// 命中盒（10×8）——tool 刻痕 255 枚把 18 枚阶段锚挤到平均 3.8px 间距，命中盒
// 相互叠压，DOM 后渲染者胜：点自己那枚的比例只有 7.3%（268/289 被相邻刻痕
// 盖住），用户读作「刻痕点不中」；同时 289 个 tab 停靠点也是键盘灾难。
// 现在：可点目标 = 18 枚阶段锚（实测间距 63px，单枚命中盒 28px 高）；装饰层
// 只负责扫读（密集段自然读作密、报错恒在最上）；连续 scrub 归滑块 + 带空白处。
// 几何：带体 fixed 通栏（top:0/bottom:0，屏顶起，z 在画布之上、坞槽 z-6 之下）；
// 映射区 = [刻痕半高, 坞上缘]（**带体坐标 = 页面坐标**，2026-09-17 标题栏拆除批
// 起两坐标重合），内容恒在可见带内；带内任何元素（刻痕盒/滑块/墨迹/hover 卡）
// 都不得越出带体顶（2026-09-14 病史：刻痕盒不内缩半高，最上一枚就有 4px 落在
// 当时的书眉拖动带里，点刻痕变成拖窗口）。
// **2026-09-19 加宽批 + 同日甲案**：带体 = 控制列（TOC_COL_W=64）+ 缘滚跑道
// （TOC_RUNWAY_W=40，边缘滚动的右缘感应带落在那里）——导航面整条让开感应带，
// 「用带」与「贴右缘缘滚」不再互为误触。甲案（**agent 自提，用户未验收**——
// 记录曾被写成「用户看像素对照后定」，见 taste-ledger 2026-09-21 更正条）把
// 识别层铺满整条带；**v4 翻案收回右 40**（编号需要位置；满宽墨迹在长卷里读作
// 一堵墙），2026-09-21 摘掉的**界栏线**仍不得复活（v4 无任何分界线）。
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'right-edge'），
// 经 paper/overlay-context 取活跃流区派生数据与折叠态（与主渲染同真源）。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SourcedBlock } from './host';
import {
  agentSessionState,
  createInkCache,
  INK_FAIL,
  inkBarColorOf,
  inkForBlock,
  useCanvasViewStore,
  useCoreStore,
  usePaperDock,
  usePaperRegion,
} from './host';
import type { StageUnitInput, TocMarkInput, TocMarkKind, TocRange } from './toc';
// 批 5a：toc / toc-ink 已归家随包 ⇒ 从包内文件取（host 面只许桥内核）
import {
  buildStageAnchors,
  computeSlider,
  deriveMarks,
  grabOffsetAt,
  jumpViewTopAt,
  scrubViewTop,
  unreadBand,
} from './toc';
import type { TocInkLine } from './toc-ink';
import { buildTocInkBuckets } from './toc-ink';

/** 带体自身的页面起点 = **屏顶 0**（2026-09-17 标题栏拆除批：书眉退役，
 *  2026-09-14 那次「整体下移 56px」随之取消）。此处是字面量镜像与测试基准：
 *  带体坐标 = 页面坐标 − TOC_TOP，本批之后两者重合。 */
export const TOC_TOP = 0;
/** **控制列宽**（px）= 带内唯一可交互区：刻痕 / 阶段锚 / 滑块 / hover 卡全在这一列
 *  里，交互判据也夹在这一列里（`insideCol`）。**与旧带体逐字同宽**（2026-09-19
 *  加宽批刻意不动它）⇒ 控制层几何零漂移；识别层那半在同日甲案里改铺满整条带
 *  （见 TOC_W）。
 *  CSS 镜像 = `.pp-toc-col` 的 width（paper-shell/PaperPanel.css，同文件里
 *  `.pp-toc` 的 width = 本值 + TOC_RUNWAY_W）
 *  ——改一处必红（tests/stage4-toc-top-band）。 */
export const TOC_COL_W = 64;
/** **缘滚跑道宽**（px）= 带体右缘那一条（2026-09-19 加宽批）：贴屏最右的
 *  **边缘滚动感应带**（基准 `EDGE_SCROLL.band` = 36，见 paper-shell/edge-scroll.ts）
 *  落在这里，故带内导航与缘滚零重叠——这就是加宽的全部理由。跑道本体惰性：
 *  交互判据不认它（点击只被吞掉）、悬停照旧算画布（`HOVER_ALLOW_DOCKS`）；
 *  v4 起**墨影就画在这 40px 里**（识别层不再铺满，见 TOC_W）。
 *  ⚠ 恒 ≥ 基准带宽（钉值）；灵敏度拉满时带宽 ≈51px，会吃掉控制列**右缘的
 *  scrub 余量**（锚/刻痕只占左 26px，任何档位都不在感应带内）。 */
export const TOC_RUNWAY_W = 40;
/** 带体总宽（px）= 控制列 + 缘滚跑道。v4：**识别层只占右 40**（= 跑道），不按
 *  本值铺满；本值仍是带体总宽 / 顶部浮件右距的本钱。CSS 镜像 = `.pp-toc` 的
 *  width，顶部浮件右距 = 本值 + 16（.pp-chrome）；`.pp-toc-ink` 的 width = 40。 */
export const TOC_W = TOC_COL_W + TOC_RUNWAY_W;
/** 刻痕盒半高（.pp-toc-mark 高 8px、刻位居中）——刻痕盒 top = stripY − MARK_HALF；
 *  映射区顶已留出 56px 空隙（见 STRIP_TOP），本值不再兼任「带体顶留白」。 */
export const MARK_HALF = 4;
/** 映射区顶（**带体坐标**）= **顶部浮件带高 56**（2026-10-20 实机修订）：
 *  用户「底部留了空位，顶部也应该留出一定的空隙」——映射区不再顶到屏顶，
 *  与底（坞顶线）对称留白；56 = `.pp-chrome` 的 8 + 40 + 8（顶部浮件带高）。
 *  带内一切（墨迹 canvas / 刻痕 / 阶段锚 / 滑块 / 未读区 / hover 卡）共用此几何
 *  真源、恒 top ≥ 0——「不越出带体」由「带内元素都在映射区里」结构性保证。
 *  ⚠ 三处同源：`.pp-chrome` 的 8+40+8、`TOP_CHROME_BAND`（测试）、本值。 */
export const STRIP_TOP = 56;
/** hover 卡翻转阈（带体坐标）：hover.y 低于此值时卡片改「挂在红线下方」、
 *  不再上下居中——卡片最大半高（v4：eyebrow + 7 行正文 ≈ 90px）+ 余量。
 *  否则贴顶 hover 时卡片上半会越出带体（旧版越进书眉、压住标题栏按钮；书眉
 *  退役后仍是带体内部的自持纪律：卡片不该越出带体跑到画布上）。 */
export const TOC_CARD_FLIP_Y = 96;
/** 翻转态卡片与红线的间隙（px）。 */
const TOC_CARD_GAP = 12;
/** 阶段编号的最小竖向落差（px）：与上一枚**已显示**的编号不足此值就省号，
 *  免得长卷里 9px 的数字叠成一团；当前阶段恒显示。 */
const TOC_NUM_MIN_GAP = 12;
/** 剪影的族增益（v4）：同一墨量下「人最响、工具/程文次之、图表最弱」。
 *  族色仍走 inkBarColorOf（真源在 paper/ink.ts），这里只调深浅、不另立颜色。 */
const TOC_FAMILY_GAIN: Record<string, number> = {
  user: 1,
  tool: 0.62,
  code: 0.62,
  plan: 0.62,
  diff: 0.62,
  table: 0.42,
  figure: 0.42,
  image: 0.42,
};
const TOC_FAMILY_GAIN_DEFAULT = 0.62;
/** 墨量 → 带内透明度：最疏桶 0.2、最密桶 1，再乘族增益（见上）。 */
const TOC_DENSITY_BASE = 0.2;
const TOC_DENSITY_SPAN = 0.8;
/** 创作坞槽的坐底抬高（.pp-composer-slot bottom:var(--composer-rise)=96px——
 *  坞**出厂位**顶线 = 页底 −96 −坞高；2026-09-02 拍板 C：两态同位，固定值不随窗口高浮动，
 *  与 tokens.css --composer-rise 同源镜像）。
 *  **2026-09-17 用户裁定：目次带不随坞浮动让位**——坞被拖到哪是用户自己摆的浮窗，
 *  目次带只按出厂底带（本条 + 坞实测高）算映射区/可见域，坞浮起来时不压缩导航带
 *  （「内容尾不藏进坞后」那条 2026-09-01 实机整改照旧成立——坞在底带时口径未变）。 */
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

/** 阶段锚命中盒顶（纯函数，带体坐标）：盒以刻位为中心（高 STAGE_HIT_H），但
 *  **恒夹在带体内**（≥ 0）——最上一枚阶段锚原本盒顶 = stripY − 14 会越出带体
 *  （旧版那半截点击归书眉＝拖窗口；锚是主要导航靶，与刻痕同族病灶，
 *  2026-09-14 实机验收当场量到 top=47 < 56；书眉退役后这仍是不越出带体的纪律）。
 *  贴顶时盒下压、规线在盒内居中（最多 14px 视觉偏差——位置读数本就由墨迹缩略承担）。 */
export function anchorBoxTop(stripY: number): number {
  return Math.max(0, stripY - STAGE_HIT_HALF);
}

/** hover 卡的锚点（纯函数，带体坐标入/出）：默认上下居中（跟随红线）；
 *  贴顶时翻转到红线下方——**卡片任何位置都不得越出带体顶**（不越出带体是
 *  自持纪律：卡片飘到画布上会盖住正文与浮件，2026-09-14 用户报「还是打架」）。 */
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
  /** 块 kind（v4：卡片的 eyebrow 用它区分正文/程文/工具…） */
  kind: string;
  lines: HoverLine[];
}

/** hover 卡的语色（左侧 2px 条 + eyebrow 颜色）：阶段 / 来文 / 工具 / 计划 /
 *  报错 / 正文。CSS 侧对应 `.pp-toc-card.is-tone-*`（两处同改）。 */
type HoverTone = 'stage' | 'human' | 'tool' | 'plan' | 'error' | 'text';
interface HoverState {
  y: number;
  text: string;
  tickId: string | null;
  /** 命中的阶段锚（v4：让锚的编号/规线与卡片同步提墨——编号在 34px 盒外）。 */
  anchorUnitId: string | null;
  tone: HoverTone;
  eyebrow: string;
}
/** 装饰刻痕 kind → 卡片语色。 */
const MARK_TONE: Record<TocMarkKind, HoverTone> = {
  user: 'human',
  tool: 'tool',
  plan: 'plan',
  error: 'error',
};
/** 装饰刻痕 kind → eyebrow 文案。 */
const MARK_LABEL: Record<TocMarkKind, string> = {
  user: '来文',
  tool: '工具',
  plan: '计划',
  error: '报错',
};
/** 块 kind → eyebrow 文案（行盒原文那一档）。未知 kind 回「正文」。 */
const KIND_LABEL: Record<string, string> = {
  markdown: '正文',
  reasoning: '思考',
  code: '程文',
  tool: '工具',
  toolgroup: '工具',
  subagent: '子代理',
  plan: '计划',
  notice: '注记',
  user: '来文',
  diff: '改动',
  'turn-error': '报错',
};

export const TocStrip = memo(function TocStrip() {
  const { regions, activeSessionId, viewRect, canvasSize, composerDock, foldedOf } = usePaperRegion();
  const { flyToPoint } = usePaperDock();
  const core = useCoreStore((s) => s.core);
  const zoom = useCanvasViewStore((s) => s.view.zoom);

  const activeRegion = useMemo(
    () => (activeSessionId != null ? (regions.find((r) => r.sessionId === activeSessionId) ?? null) : null),
    [regions, activeSessionId],
  );

  /* 带体从屏顶起（CSS .pp-toc top: 0——书眉退役后带体坐标 = 页面坐标），
   * 映射区 = [刻痕半高, 坞顶线]（**带体坐标** = 页面坐标 − TOC_TOP = 0）。
   * 底 = 坞顶线（画布区底 − 出厂底带），不随顶内缩；坞顶线 = 抬高 96 + 坞实测高
   *（不读坞的实际位置——2026-09-17 用户裁定见上）。 */
  const mappedBottom = Math.max(STRIP_TOP + 1, canvasSize.h - COMPOSER_RISE - composerDock.height);
  /* ── 可见视口（世界 y）——滑块、未读区、当前阶段共用同一把尺子 ──
   * 画布区顶 → 坞上缘：visY1 = 画布区底 − 出厂底带（与映射区同一口径：只认
   * 出厂位，不随坞浮动而变）。v4 把它提到前面：当前阶段（编号加粗）要用
   * 视口中心，编号派生又排在锚点派生之后。 */
  const visY0 = viewRect.y0;
  const visY1 = viewRect.y1 - (COMPOSER_RISE + composerDock.height) / Math.max(0.05, zoom);
  const visH = visY1 - visY0;
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

  /* ── 当前阶段（v4 编号的「你在哪」）：视口中心落在哪个 user 单元之后。
   * 阶段按 worldY 升序；视口中心在首枚之前 → 取首枚（恒有一个「当前」，
   * 编号不会因为刚滚到顶而整条失去强调）。 */
  const viewCenterWorld = (visY0 + visY1) / 2;
  const activeStageUnitId = useMemo(() => {
    let cur: string | null = null;
    for (const a of stageAnchors) if (a.worldY <= viewCenterWorld) cur = a.unitId;
    return cur ?? stageAnchors[0]?.unitId ?? null;
  }, [stageAnchors, viewCenterWorld]);
  /* ── 编号的自适应（v4）：与上一枚**已显示**的编号不足 TOC_NUM_MIN_GAP 就省；
   * 当前阶段恒显示（哪怕与上一枚挤在一起——它是读数，不是装饰）。 */
  const numeralByUnit = useMemo(() => {
    const out = new Map<string, string>();
    let lastY = Number.NEGATIVE_INFINITY;
    for (const a of stageAnchors) {
      if (a.unitId === activeStageUnitId || a.stripY - lastY >= TOC_NUM_MIN_GAP) {
        out.set(a.unitId, String(a.stageIndex));
        lastY = a.stripY;
      }
    }
    return out;
  }, [stageAnchors, activeStageUnitId]);

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
   * 可见视口在带体几何那段已算好（visY0/visY1/visH）——与映射区同一把尺子。 */
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
    const sync = () => setStreaming(agentSessionState.runStateOf(core.panelId, activeSessionNum).running);
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
      /* v4 剪影：**右对齐**（参差朝向目次栏）、族色染整桶、墨量管深浅。
       * 族增益只调深浅（人最响、工具/程文次之、图表最弱）——族色真源仍是
       * inkBarColorOf；不再按桶画族色缘线（会读作 2026-09-21 摘掉的界栏线）。 */
      const w = Math.min(W, Math.max(0.6, bucket.width));
      ctx.globalAlpha =
        (TOC_DENSITY_BASE + TOC_DENSITY_SPAN * bucket.density) *
        (TOC_FAMILY_GAIN[bucket.kind] ?? TOC_FAMILY_GAIN_DEFAULT);
      ctx.fillStyle = inkBarColorOf(bucket.kind); // 族色：这是什么（墨色真源）
      ctx.fillRect(W - w, bucket.top, w, bucket.height);
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
        kind: b.kind,
        lines,
      });
    }
    return out;
  }, [activeBlocks, activeLayout, range, foldedOf]);

  /* ── 指针交互：滑块拖拽 scrub / 点带即跳（夹紧域 = 可见视口）── */
  const dragRef = useRef<{ offset: number } | null>(null);
  /** 拖拽在途（v4：只驱动抓手亮一档；不参与几何）。 */
  const [dragging, setDragging] = useState(false);
  const applyVisTop = (visTop: number): void => {
    useCanvasViewStore.getState().setView((v) => ({ ...v, panY: -visTop * v.zoom }));
  };
  const stripYOf = (clientY: number, el: HTMLElement): number => clientY - el.getBoundingClientRect().top;
  /** 指针是否落在**内容列**内（带体坐标；带体左缘 = 内容列左缘）：带体右
   *  `TOC_RUNWAY_W` 那条是**缘滚跑道**，带内交互一律不认它——否则「指针甩到屏
   *  右缘缘滚」会顺带 scrub / 弹 hover 卡，这正是 2026-09-19 加宽批要买的。
   *  拖拽在途（dragRef）不受此判据约束：抓到手就是连续手势，可一路拖过跑道。 */
  const insideCol = (clientX: number, el: HTMLElement): boolean =>
    clientX - el.getBoundingClientRect().left <= TOC_COL_W;

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || !range || !slider) return;
    if (!insideCol(e.clientX, e.currentTarget)) return; // 缘滚跑道：不 scrub（点击只被吞掉）
    const stripY = stripYOf(e.clientY, e.currentTarget);
    /* 带外一律不响应（2026-09-14 行为变更）：元素框是通栏 fixed（top:0/bottom:0），
     * 但映射区只有 [刻痕半高, 坞上缘]——带顶那半高是带体自身留白（旧版归书眉＝
     * 拖窗口），坞下装饰带无语义。此前这两处按下仍会 scrub，视口被顺手拽走（实测坞下
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
      setDragging(true);
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
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  /* ── hover 预览卡：命中盒与卡片**同源**（卡片所示即点击所得）──
   * 顺序 = 可点层优先：① 阶段锚命中盒内（|Δ| ≤ STAGE_HIT_HALF）→「阶段 N」+ 首句，
   * 按下就是飞到它；② 贴着装饰刻痕（|Δ| ≤ TICK_HIT_R）→ 那枚的语义预览（按下 =
   * scrub 到该 y；那枚同时提墨一档，卡片所示即高亮所在）；③ 光标下的行盒原文
   * （指哪读哪——按下 = scrub 到该 y）。v4：卡片带 eyebrow（阶段/工具/正文…）
   * 与语色条；锚命中的 anchorUnitId 同时驱动锚编号/规线提墨（编号在 34px 盒外）。 */
  const [hover, setHover] = useState<HoverState | null>(null);
  const onMouseMove = (e: React.MouseEvent<HTMLElement>): void => {
    if (dragRef.current || !range) return;
    if (!insideCol(e.clientX, e.currentTarget)) {
      setHover(null); // 指针在跑道上（多半正在缘滚）：不读带、不留卡
      return;
    }
    const stripY = stripYOf(e.clientY, e.currentTarget);
    let text: string | null = null;
    let tickId: string | null = null;
    let anchorUnitId: string | null = null;
    let tone: HoverTone = 'text';
    let eyebrow = '';
    // 1) 阶段锚（可点层优先——导航是第一用途）
    for (const a of stageAnchors) {
      if (Math.abs(a.stripY - stripY) <= STAGE_HIT_HALF) {
        text = a.preview;
        anchorUnitId = a.unitId;
        tone = 'stage';
        eyebrow = `阶段 ${a.stageIndex}`;
        break;
      }
    }
    // 2) 贴着装饰刻痕（扫读信号）
    if (text === null) {
      for (const m of decorations) {
        if (Math.abs(m.stripY - stripY) <= TICK_HIT_R) {
          text = m.preview;
          tickId = m.blockId;
          tone = MARK_TONE[m.kind];
          eyebrow = MARK_LABEL[m.kind];
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
        if (best) {
          text = best.text;
          tone = 'text';
          eyebrow = KIND_LABEL[hb.kind] ?? '正文';
        }
        break;
      }
    }
    const body = text === null ? null : text.slice(0, HOVER_TEXT_MAX);
    setHover((prev) => {
      if (body === null) return prev === null ? prev : null;
      if (prev && prev.text === body && prev.tickId === tickId && prev.anchorUnitId === anchorUnitId) return prev;
      return { y: stripY, text: body, tickId, anchorUnitId, tone, eyebrow };
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
      {/* 识别层（v4：**只占右 40**，= 缘滚跑道）——书口墨影 / 未读区 / 活线。
          三者都是 pointer-events:none 的纯识别面；画布 clientWidth = 40（CSS
          .pp-toc-ink 的 left:64/right:0），剪影右对齐贴屏幕缘、参差朝向目次栏。 */}
      <canvas ref={canvasRef} className="pp-toc-ink" />
      {unread && <div className="pp-toc-unread" style={{ top: unread.top, height: unread.height }} />}
      {streaming && <div className="pp-toc-head" style={{ top: mappedBottom - 2 }} />}
      {/* 控制列（左 TOC_COL_W）：竖脊 / 端规 / 编号 / 滑块 / 刻痕 / 锚 / 卡——
          带内**唯一可交互区**（判据 = insideCol，夹在本列宽内；列右那条缘滚跑道
          惰性）。竖脊/端规都是惰性装饰，不参与命中；带脚「目次」小签已摘。 */}
      <div className="pp-toc-col">
        <div
          className="pp-toc-rail"
          aria-hidden="true"
          style={{ top: range.stripTop, height: Math.max(0, range.stripBottom - range.stripTop) }}
        />
        <div className="pp-toc-cap" aria-hidden="true" style={{ top: range.stripTop }} />
        <div className="pp-toc-cap" aria-hidden="true" style={{ top: range.stripBottom }} />
        {slider && (
          <div
            className={`pp-toc-slider${slider.draggable ? '' : ' is-fit'}${dragging ? ' is-dragging' : ''}`}
            style={{ top: slider.top, height: slider.height }}
          >
            {slider.draggable && <i className="pp-toc-grip" />}
          </div>
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
            点击 = 飞到该阶段首块。v4：编号在锚的 34px 盒外（x=36），`is-hover` 由
            组件的 hover.y 下发，让编号与卡片同步提墨；`is-active` = 视口中心所在阶段。 */}
        {stageAnchors.map((a) => {
          const num = numeralByUnit.get(a.unitId);
          const isActive = a.unitId === activeStageUnitId;
          const isHover = hover?.anchorUnitId === a.unitId;
          return (
            <button
              key={a.unitId}
              type="button"
              className={`pp-toc-anchor${isActive ? ' is-active' : ''}${isHover ? ' is-hover' : ''}`}
              style={{ top: anchorBoxTop(a.stripY) }}
              aria-label={`跳到阶段 ${a.stageIndex}：${a.preview}`}
              aria-current={isActive ? 'step' : undefined}
              onClick={() => {
                if (activeSessionId) flyToPoint(activeSessionId, a.worldY);
              }}
            >
              {num !== undefined && (
                <span className="pp-toc-num" aria-hidden="true">
                  {num}
                </span>
              )}
            </button>
          );
        })}
        {hover && (
          <div
            className={`pp-toc-card is-tone-${hover.tone}`}
            style={{ top: cardAnchorFor(hover.y).top, transform: cardAnchorFor(hover.y).transform }}
            role="tooltip"
          >
            {hover.eyebrow !== '' && <span className="pp-toc-eyebrow">{hover.eyebrow}</span>}
            {hover.text}
          </div>
        )}
      </div>
    </nav>
  );
});
