// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 布局核心域（paper-panel-split C3）——一纸多卷的派生心脏：regions memo
//（translate/adapt/measure/layout/seq/extent/工作单元/节奏档，P2-3 卷级
// 核心缓存 + P2-2 卷级虚拟化）、钉位查找表、孤儿钉族、小地图墨迹快照、
// 横向可见集。性能注释与竞态尸检注释随行——平移帧零重算的整条纪律都在这。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { WorkUnit } from '../../../paper/group-contract';
import type { MinimapRegionInput } from '../../../paper/minimap-core';
import type { FlowGeom, PinnedGeom } from '../../../paper/region-geom-contract';
import { volumeDisplayName } from '../../../state/volume-name';
import { groupWorkUnits, rhythmAssign, sealedMessageIdsOf } from './group';
import type {
  CanvasStore,
  ChatMessage,
  MessageTranslateCache,
  RegionView,
  SourcedBlock,
  StreamRegionState,
} from './host';
import {
  collapseToolGroups,
  createInkCache,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  layoutRegion,
  REGION_CONTENT_MARGIN,
  translateMessagesCached,
  writingBlockIdOf,
} from './host';
import {
  type BlockMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  USER_SHRINK_MIN_W,
} from './measure';
import type { SelectionDragState } from './use-paper-viewport';
import { visibleFlowWindow, visiblePinnedIds } from './virtualize';

/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3）——regions memo
 *  与渲染层 ghost 按钮共用。 */
export const GHOST_H = 32;
/** 块宽兜底（2026-09-03 级联防御）：流区宽脏/NaN 时回落默认版心宽
 *  （与 paper/block-model DEFAULT_BLOCK_WIDTH 同值，本地不引 host）。 */
const FALLBACK_BLOCK_W = 720;
/** 视口虚拟化输入：可见窗口外扩余量（px，世界单位）。 */
const OVERSCAN = 200;

/* ── P2-3 平移零重算（2026-09-02 拖动卡顿专项）── 卷级布局核心缓存条目：
 * inputs = 失效键（消息快照/锚点/钉表/折叠谓词/测量代——全部内容侧输入，
 * 不含视口），core = O(块) 派生物（translate/adapt/measure/layout/seq/
 * extent）。平移/缩放帧 regions memo 仍重跑（flowWindow/visibleIds 是视口
 * 派生），但每卷核心命中复用、内层引用稳定——TocStrip 的 markInputs/hover
 * 索引与 MinimapView 的墨迹重画以 blocks/layout/flowGeom 等内层引用为依赖
 * （见两消费面改造），平移帧零重算。 */
interface RegionCoreCacheEntry {
  msgs: readonly ChatMessage[];
  anchorX: number;
  anchorY: number;
  width: number;
  pinsMap: Record<string, { x: number; y: number; w?: number }>;
  foldedOf: (b: SourcedBlock) => boolean;
  sidecarFoldedOf: (b: SourcedBlock) => boolean;
  sidecarOutOf: (b: SourcedBlock) => boolean;
  paperTick: number;
  measureTick: number;
  core: {
    blocks: SourcedBlock[];
    layout: Map<string, { x: number; y: number }>;
    flowGeom: FlowGeom[];
    pinnedGeom: PinnedGeom[];
    seq: Map<string, string>;
    regionTop: number;
    regionHeight: number;
    folioH: number;
    /** 工作单元（stream-rhythm 刀3 入核心缓存；刀4 目次带阶段导航消费）。 */
    units: WorkUnit[];
    /** 阶段首块（stream-rhythm 刀2：来文块）——渲染层阶段细线消费。 */
    stageLeadIds: ReadonlySet<string>;
    /** 单元界首块（刀5 D）——渲染层单元界短规线消费。 */
    unitLeadIds: ReadonlySet<string>;
    /** 验证链毕块（刀5 C）——渲染层「✓ 阶段完成」锚消费。 */
    verifyDoneIds: ReadonlySet<string>;
    /** 正在书写的块 id（2026-09-06 纸面运行态：writingBlockIdOf 派生）——
     *  渲染层给湿墨尾点 + 落笔点让位判据。 */
    writingBlockId: string | null;
  };
}

/** stub 卷共享空容器（P2-3：只读消费——渲染/孤儿钉/页脚计数只读不写，零分配）。 */
const STUB_EMPTIES = {
  blocks: [] as SourcedBlock[],
  layout: new Map<string, { x: number; y: number }>(),
  flowGeom: [] as FlowGeom[],
  pinnedGeom: [] as PinnedGeom[],
  flowWindow: { first: 0, lastExcl: 0 },
  visibleIds: new Set<string>(),
  seq: new Map<string, string>(),
  units: [] as WorkUnit[],
  stageLeadIds: new Set<string>() as ReadonlySet<string>,
  unitLeadIds: new Set<string>() as ReadonlySet<string>,
  verifyDoneIds: new Set<string>() as ReadonlySet<string>,
  writingBlockId: null as string | null,
} as const;

/** P2-3 复合键等价比较（引用级）——键元素全部引用相同 = 缓存可复用。
 *  消费面：每帧 O(块) 的派生 Map/Set（opsByBlock / blockSession /
 *  openBlockIds / minimap 包围盒）以「内容侧引用清单」为键——regions 包装
 *  每帧换引用，但内层 blocks/flowGeom 引用在 P2-3 核心缓存下稳定，键不变
 *  = 上一帧产物直接复用（平移帧零重建 + 引用稳定喂给下游 memo 链）。
 *  导出消费面：use-block-ops（opsByBlock）/ use-minimap-bounds（content 键）。 */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 布局核心域（paper-panel-split C3，自 PaperPanel 1051-1475 + 2706-2719
 *  域内原样搬入）。穿参输入全部为内容侧/拖动态值——edgeDragPos/regionCornerPos
 *  来自 use-region-move，draggingId/dragSource 来自装配根的拖拽渲染态。
 *  ⚠ regionsRef 是装配根持有的共享载体经穿参进来（单一 owner——本 hook 每帧
 *  写 regionsRef.current = regions，InkLayer/拖块/飞行/键盘走卷等晚绑定读方
 *  都拿同一个实例；2026-09-06 拆解首版漏穿参自建了第二个实例，装配根手里
 *  那个恒空——真机症状即此，已根治）。 */
export function usePaperRegions(params: {
  regionsRef: MutableRefObject<RegionView[]>;
  sessions: Array<{ id: number; label: string; createdAt?: string }>;
  regionMsgs: Record<string, { messages: readonly ChatMessage[]; tick: number }>;
  paperTick: number;
  measureTick: number;
  viewRect: { x0: number; y0: number; x1: number; y1: number };
  canvasState: CanvasStore;
  foldedOf: (b: SourcedBlock) => boolean;
  sidecarFoldedOf: (b: SourcedBlock) => boolean;
  activeSessionKey: string | null;
  edgeDragPos: { sessionId: string; x: number; y: number } | null;
  regionCornerPos: { sessionId: string; x: number; width: number } | null;
  draggingId: string | null;
  dragSource: { sessionId: string | undefined; wasFlow: boolean } | null;
  /** 拖选自动滚屏手势（use-paper-viewport 产出）：keepAlive 锚点块保活——
   *  虚拟化滑出窗口不卸锚块（原生选区锚点死则选区从顶部截），到手势松开。 */
  selDragRef: MutableRefObject<SelectionDragState | null>;
}) {
  const {
    regionsRef,
    sessions,
    regionMsgs,
    paperTick,
    measureTick,
    viewRect,
    canvasState,
    foldedOf,
    sidecarFoldedOf,
    activeSessionKey,
    edgeDragPos,
    regionCornerPos,
    draggingId,
    dragSource,
    selDragRef,
  } = params;

  /* 性能专项缓存（流式增量）——按会话隔离：
   *  - translateCacheBySession：消息引用增量转译（流式只重译被触碰消息的块）
   *  - measureCache：块 id + 内容签名记忆高度（签名未变零重测，全画布共享） */
  const translateCacheBySession = useRef(new Map<number, MessageTranslateCache | null>());
  const measureCacheRef = useRef<BlockMeasureCache>(createBlockMeasureCache());
  /* P4 缩远墨迹：骨架几何缓存（签名命中零重算） */
  const inkCacheRef = useRef(createInkCache());
  // 会话合卷/新增后修剪无主缓存
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const k of translateCacheBySession.current.keys()) {
      if (!ids.has(k)) translateCacheBySession.current.delete(k);
    }
  }, [sessions]);

  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，onBlockMouseDown 才可零依赖稳定（memo 友好，不逐帧重建闭包）。
   * regionsRef 经穿参进来（装配根持有）——见 hook 头注的单一 owner 说明。 */
  const blockSessionRef = useRef<Map<string, string>>(new Map());
  /* P2-3：块→卷索引的复合键缓存——O(块) 合并只在核心集变化时发生（平移帧零重建）。 */
  const blockSessionCacheRef = useRef<{ key: unknown[]; map: Map<string, string> } | null>(null);
  /* P2-3：卷级布局核心缓存（per panel，挂载期存活——卷关闭由 memo 尾部修剪）。 */
  const regionCoreCacheRef = useRef(new Map<number, RegionCoreCacheEntry>());
  /** P2-2 卷级虚拟化：每卷最近一次全量构建的包围盒/块 id 集/块数——
   *  stub 判定的输入 + stub 消费面（小地图 extent / 孤儿钉 openBlockIds /
   *  页脚块数）的最近已知值真源。离屏后台流增长在回场时刷新。 */
  const regionExtentRef = useRef<
    Map<
      string,
      { extent: { x0: number; y0: number; x1: number; y1: number }; blockIds: Set<string>; blockCount: number }
    >
  >(new Map());

  /* 钉住块位置查找表：引用随 canvasState.pins 引用稳定——不变化时 translate
   * 缓存命中（流式增量铁律：纸面不动的会话零重算）。w 一并入表（P2b 宽度
   * 手调：pin.w 是钉住几何唯一真相，渲染宽经 translate 覆盖块宽）。 */
  const pinsMap = useMemo(() => {
    const m: Record<string, { x: number; y: number; w?: number }> = {};
    for (const [id, pin] of Object.entries(canvasState.pins)) m[id] = { x: pin.x, y: pin.y, w: pin.w };
    return m;
  }, [canvasState.pins]);

  /* 眉批已钉出检测（P5 → 2026-08-31 移出语义）：`${blockId}:sc` 快照钉存在 =
   * 眉批栏渲染「已移出·点击恢复」占位（渲染器 + 测高镜像共同消费）。
   * pinsMap 引用随 canvasState.pins 稳定——regions memo 已依赖 pinsMap，
   * 建钉/拔钉时占位切换与块高重测同帧生效。 */
  const sidecarOutOf = useCallback((b: SourcedBlock) => pinsMap[`${b.id}:sc`] != null, [pinsMap]);

  /* P2a+P6 宽度自由：块宽适配流区——先 clamp 到流区内容宽（窄流区压版心，
   * 宽流区不放宽：版心有可读上限 720）。2026-08-30 来文标题化：来文不再收缩
   * 宽（纸条隐喻退役），与其他块同走版心宽——标题居中吃版心。WeakMap 以
   * 「源对象 + 目标宽」记忆——resize 拖动中逐帧换宽不破 React.memo 身份。 */
  const shrinkCopyCacheRef = useRef(new WeakMap<SourcedBlock, { w: number; copy: SourcedBlock }>());
  const adaptBlocks = useCallback((blocks: SourcedBlock[], regionW: number): SourcedBlock[] => {
    const cache = shrinkCopyCacheRef.current;
    // ⚠ 防御（2026-09-03 级联排查）：regionW 非有限数（流区宽脏/NaN）会让本卷
    // 全部块宽变 NaN → 测高 NaN → 布局级联打碎。实测优先无签名守卫，宁可回落
    // 默认版心宽，也不让 NaN 进测量链。
    const safeRegionW = Number.isFinite(regionW) && regionW > 0 ? regionW : FALLBACK_BLOCK_W + REGION_CONTENT_MARGIN;
    const contentW = Math.max(USER_SHRINK_MIN_W, safeRegionW - REGION_CONTENT_MARGIN);
    return blocks.map((b) => {
      const cappedW = Math.min(b.w, contentW);
      const targetW = Number.isFinite(cappedW) && cappedW > 0 ? cappedW : FALLBACK_BLOCK_W;
      if (targetW === b.w) return b;
      const hit = cache.get(b);
      if (hit && hit.w === targetW) return hit.copy;
      const copy = { ...b, w: targetW };
      cache.set(b, { w: targetW, copy });
      return copy;
    });
  }, []);

  const regions: RegionView[] = useMemo(() => {
    // paperTick/measureTick 是显式失效信号：测量缓存清空后必须重算本 memo——
    // void 引用使依赖声明与闭包语义一致（canvasState 变化本身就是触发源）。
    void paperTick;
    void measureTick;
    const out: RegionView[] = [];
    // P2-3：非 stub 卷的 (sid, blocks) 引用清单——blockSession 复合键（见尾部）。
    const coreKey: unknown[] = [];
    // P2-2 卷级虚拟化（2026-09-02，审批通过）：视口外（含 stub margin）的卷
    // 跳过全量派生——translate/adapt/measure/layout 是每帧 O(块) 主消耗，
    // 100 卷摊开时 memo 重算（pan/zoom 每帧）被全部卷平摊。stub 只带锚点 +
    // 最近一次全量构建的包围盒/块 id 集。回场恢复全量：translate 缓存增量 +
    // measure 缓存命中，单次回场成本低。
    // stub margin 必须大于 InkLayer 的绘制 margin（600/800）——远缩墨迹
    //（rAF 直读 regionsRef）不因 stub 闪断。活跃卷 + 拖拽/缩放中的卷永不
    // stub（小地图活跃墨迹 / 跟手不缺）。首见卷（extent 未知）全量构建。
    const STUB_MX = 900;
    const STUB_MY = 1200;
    // 拖选锚点保活（2026-09-07）：选区锚点所在卷不 stub——锚块一卸，原生
    // 选区从顶部截断（keepAlive 随手势起止，ref 在 memo 体内现读：保活登记
    // 与首帧平移同拍，平移必触 viewRect 变化重跑本 memo，读到的一直是现值）。
    const selKeep = selDragRef.current?.keepAlive ?? null;
    sessions.forEach((s, i) => {
      const sid = String(s.id);
      const persisted = canvasState.spread[sid];
      const baseAnchor = persisted ?? defaultRegionFor(i);
      // 边缘拖动中：用拖动态锚点覆盖（块/纸条随流区整体平移）；
      // 四角缩放中：宽/中轴用预览值（块体重排随 adaptBlocks 跟手）
      const dragging = edgeDragPos && edgeDragPos.sessionId === sid;
      const resizing = regionCornerPos && regionCornerPos.sessionId === sid;
      const anchor: StreamRegionState = resizing
        ? { anchorX: regionCornerPos.x, anchorY: baseAnchor.anchorY, width: regionCornerPos.width }
        : dragging
          ? { anchorX: edgeDragPos.x, anchorY: edgeDragPos.y, width: baseAnchor.width }
          : baseAnchor;

      const known = regionExtentRef.current.get(sid);
      const inStubRange =
        !!known &&
        !dragging &&
        !resizing &&
        activeSessionKey !== sid &&
        dragSource?.sessionId !== sid &&
        selKeep?.sessionId !== sid &&
        (known.extent.x1 + STUB_MX < viewRect.x0 ||
          known.extent.x0 - STUB_MX > viewRect.x1 ||
          known.extent.y1 + STUB_MY < viewRect.y0 ||
          known.extent.y0 - STUB_MY > viewRect.y1);
      if (known && inStubRange) {
        // stub：锚点 + 最近已知派生值。render 面（visibleRegionIds 之后）不
        // 渲染 stub；小地图/孤儿钉/页脚计数消费最近已知值。空容器走共享只读
        // 常量（P2-3——零分配）。
        out.push({
          sessionId: sid,
          sessionNum: s.id,
          label: s.label,
          createdAt: s.createdAt,
          anchor,
          ...STUB_EMPTIES,
          regionTop: known.extent.y0,
          regionBottom: anchor.anchorY,
          regionHeight: Math.max(0, anchor.anchorY - known.extent.y0) + 72,
          // 卷首高用真测高（2026-09-16 连带清理：原为魔数 72——卷首实测约 190，
          // 缩到视口外的卷回场时纸的上缘会跳一下，且远档地志标签的锚点
          // （InkLayer 的 regionTop − folioH）在 stub 与非 stub 卷之间不一致。
          // label 与 width 都在手，测高无额外依赖）
          folioH: measureFolioHeadHeight(volumeDisplayName(s.label, s.id), anchor.width),
          stubbed: true,
          extent: known.extent,
          lastBlockIds: known.blockIds,
          lastBlockCount: known.blockCount,
        });
        return;
      }

      // P2-3 布局核心命中判定：内容输入全同 = 复用（平移/缩放帧只重算视口
      // 派生 flowWindow/visibleIds）。布局核心（translate/adapt/measure/
      // layout/seq/extent）是 O(块) 主消耗——原实现对每个非 stub 卷每帧重跑。
      const msgs = regionMsgs[s.id]?.messages ?? [];
      let entry = regionCoreCacheRef.current.get(s.id);
      if (
        !entry ||
        entry.msgs !== msgs ||
        entry.anchorX !== anchor.anchorX ||
        entry.anchorY !== anchor.anchorY ||
        entry.width !== anchor.width ||
        entry.pinsMap !== pinsMap ||
        entry.foldedOf !== foldedOf ||
        entry.sidecarFoldedOf !== sidecarFoldedOf ||
        entry.sidecarOutOf !== sidecarOutOf ||
        entry.paperTick !== paperTick ||
        entry.measureTick !== measureTick
      ) {
        const translateCache = translateCacheBySession.current.get(s.id) ?? null;
        const res = translateMessagesCached(msgs, pinsMap, translateCache);
        translateCacheBySession.current.set(s.id, res.cache);
        // stream-rhythm 刀2（2026-09-03）：工作单元封套 pass——折叠摘除前的全块列
        // 分组（组头子块强制归组），节奏档喂布局栈（intra 32 / unit 64 / recovery 96
        // / stage 96）；来文块进 stageLeadIds（阶段细线渲染面）。刀3：分派走
        // rhythmAssign 单一真源（与布局级封口测试共用），units 进核心缓存（刀4
        // 目次带阶段导航消费）。
        const sealedIds = sealedMessageIdsOf(msgs);
        const units = groupWorkUnits(res.blocks, { isSealedMessage: (id) => sealedIds.has(id) });
        // 工具组收起摘除（2026-08-30 会话流专项）：折叠态组头的子卡不进布局栈
        const blocks = collapseToolGroups(adaptBlocks(res.blocks, anchor.width), foldedOf);
        // stream-rhythm 刀5：族边界切单元（读→写→验证→落款是不同的工作行为）
        // + 单元界短规线 / 验证链毕锚的派生——单一真源（与布局级封口测试共用）
        const { rhythmOf, stageLeadIds, unitLeadIds, verifyDoneIds } = rhythmAssign(blocks, units);
        const stack = blocks.map((b) => {
          return {
            id: b.id,
            h:
              b.state === 'flow'
                ? measureBlockHeightCached(b, measureCacheRef.current, foldedOf(b), sidecarFoldedOf(b), sidecarOutOf(b))
                : GHOST_H,
            w: b.w,
            kind: b.kind,
            rhythm: rhythmOf.get(b.id),
          };
        });
        const layout = layoutRegion(stack, { x: anchor.anchorX, y: anchor.anchorY });
        const flowGeom: FlowGeom[] = stack.map((sx) => ({
          id: sx.id,
          y: layout.get(sx.id)?.y ?? 0,
          h: sx.h,
          x: layout.get(sx.id)?.x ?? 0,
          w: sx.w,
        }));
        const pinnedGeom: PinnedGeom[] = blocks
          .filter((b) => b.state === 'pinned')
          .map((b) => ({
            id: b.id,
            x: b.x,
            y: b.y,
            w: b.w,
            h: measureBlockHeightCached(b, measureCacheRef.current, foldedOf(b), sidecarFoldedOf(b), sidecarOutOf(b)),
          }));

        const seq = new Map<string, string>();
        for (let bi = 0; bi < blocks.length; bi++) {
          seq.set(blocks[bi].id, String(bi + 1).padStart(3, '0'));
        }

        let top = Number.POSITIVE_INFINITY;
        for (const g of flowGeom) top = Math.min(top, g.y);
        // 零块卷（新建即摊开、未落墨）：没有「最旧块顶」——regionTop 取锚点上溯
        // EMPTY_REGION_CONTENT_H（虚拟内容顶）。旧实现以 0 为 Math.min 初值 =
        // 空卷纸面钉在世界原点（新建卷的纸画在别处、首句落墨才跳回锚点：
        // 2026-09-10 用户两问之二）。
        if (!Number.isFinite(top)) top = anchor.anchorY - EMPTY_REGION_CONTENT_H;
        const regionTop = top;
        // 卷首头高度：题字按**流区宽**实测（左右内距 16×2 与 720 版心封顶都在
        // measureFolioHeadHeight 内一次算清——2026-09-16 前此处手写 `anchor.width - 32`，
        // 宽流区下漏掉版心封顶，实测值与渲染的换行不符）
        const folioH = measureFolioHeadHeight(volumeDisplayName(s.label, s.id), anchor.width);
        // P2-2：全量构建后登记包围盒/块 id 集——stub 判定与 stub 消费面的
        // 最近已知值真源。空卷（无块）用锚点框兜底（stub 判定不至于盲区）。
        if (blocks.length > 0) {
          let ex0 = Infinity;
          let ey0 = Infinity;
          let ex1 = -Infinity;
          let ey1 = -Infinity;
          for (const g of flowGeom) {
            ex0 = Math.min(ex0, g.x);
            ey0 = Math.min(ey0, g.y);
            ex1 = Math.max(ex1, g.x + g.w);
            ey1 = Math.max(ey1, g.y + g.h);
          }
          for (const g of pinnedGeom) {
            ex0 = Math.min(ex0, g.x);
            ey0 = Math.min(ey0, g.y);
            ex1 = Math.max(ex1, g.x + g.w);
            ey1 = Math.max(ey1, g.y + g.h);
          }
          regionExtentRef.current.set(sid, {
            extent: { x0: ex0, y0: ey0, x1: ex1, y1: ey1 },
            blockIds: new Set(blocks.map((b) => b.id)),
            blockCount: blocks.length,
          });
        } else {
          regionExtentRef.current.set(sid, {
            extent: {
              x0: anchor.anchorX - anchor.width / 2,
              x1: anchor.anchorX + anchor.width / 2,
              y0: anchor.anchorY - EMPTY_REGION_CONTENT_H,
              y1: anchor.anchorY + 72,
            },
            blockIds: new Set(),
            blockCount: 0,
          });
        }
        entry = {
          msgs,
          anchorX: anchor.anchorX,
          anchorY: anchor.anchorY,
          width: anchor.width,
          pinsMap,
          foldedOf,
          sidecarFoldedOf,
          sidecarOutOf,
          paperTick,
          measureTick,
          core: {
            blocks,
            layout,
            flowGeom,
            pinnedGeom,
            seq,
            regionTop,
            regionHeight: Math.max(0, anchor.anchorY - regionTop) + 72,
            folioH,
            units,
            stageLeadIds,
            unitLeadIds,
            verifyDoneIds,
            writingBlockId: writingBlockIdOf(blocks),
          },
        };
        regionCoreCacheRef.current.set(s.id, entry);
      }
      const c = entry.core;
      // 视口派生（每帧必要）：flow 块是单调栈 → 二分窗口 O(log n)+O(可见)。
      const flowWindow = visibleFlowWindow(c.flowGeom, viewRect, OVERSCAN);
      const visibleIds = new Set(visiblePinnedIds(c.pinnedGeom, viewRect, OVERSCAN));
      for (let j = flowWindow.first; j < flowWindow.lastExcl; j++) visibleIds.add(c.flowGeom[j].id);
      // 拖拽保活（松手定夺改造 2026-09-05）：拖动中的块 slot 可能滑出视口窗口，
      // 但块影必须全程跟手不闪断——拖拽期间强制进可见集。
      if (draggingId != null) visibleIds.add(draggingId);
      // 拖选锚点保活（2026-09-07）：锚块滑出视口窗口也不卸——原生选区锚点
      // 死则选区截顶；保活到手势松开（keepAlive 随 selDragRef 起止）。
      if (selKeep?.sessionId === sid) visibleIds.add(selKeep.blockId);
      coreKey.push(sid, c.blocks);

      out.push({
        sessionId: sid,
        sessionNum: s.id,
        label: s.label,
        createdAt: s.createdAt,
        anchor,
        blocks: c.blocks,
        layout: c.layout,
        flowGeom: c.flowGeom,
        pinnedGeom: c.pinnedGeom,
        flowWindow,
        visibleIds,
        seq: c.seq,
        regionTop: c.regionTop,
        regionBottom: anchor.anchorY,
        regionHeight: c.regionHeight,
        folioH: c.folioH,
        units: c.units,
        stageLeadIds: c.stageLeadIds,
        unitLeadIds: c.unitLeadIds,
        verifyDoneIds: c.verifyDoneIds,
        writingBlockId: c.writingBlockId,
      });
    });
    // 合卷/切换后修剪无主核心（与 translateCacheBySession 同款纪律）
    if (regionCoreCacheRef.current.size !== sessions.length) {
      const live = new Set(sessions.map((s) => s.id));
      for (const k of regionCoreCacheRef.current.keys()) {
        if (!live.has(k)) regionCoreCacheRef.current.delete(k);
      }
    }
    // P2-3：块→卷索引复合键复用——核心集不变（平移帧）零重建零分配；消费面
    //（拖块手势等）读 .current 即时值，引用替换语义不变。
    const prevBS = blockSessionCacheRef.current;
    if (prevBS && sameKey(prevBS.key, coreKey)) {
      blockSessionRef.current = prevBS.map;
      return out;
    }
    const merged = new Map<string, string>();
    for (const r of out) {
      if (r.stubbed) continue;
      for (const b of r.blocks) merged.set(b.id, r.sessionId);
    }
    blockSessionCacheRef.current = { key: coreKey, map: merged };
    blockSessionRef.current = merged;
    return out;
  }, [
    sessions,
    regionMsgs,
    paperTick,
    viewRect,
    edgeDragPos,
    regionCornerPos,
    measureTick,
    canvasState,
    pinsMap,
    foldedOf,
    sidecarFoldedOf,
    sidecarOutOf,
    activeSessionKey,
    adaptBlocks,
    draggingId,
    dragSource,
    selDragRef,
  ]);

  regionsRef.current = regions;

  /* 小地图墨迹快照（R3 多卷版 2026-09-03）：MinimapView 的 canvas 重画从
   * regions 外层引用（每 pan 帧换）收到窄到本快照——sameKey 复合键缓存
   *（openBlockIds 同款）：仅当内容侧（blocks/layout/extent/flowGeom/…）
   * 或 stub 集合（卷进出视口）变化才重建新引用；pan 连续帧（内容不变）
   * 命中返回旧引用 → 墨迹 effect 零重画，stub 切换/流式/挪卷/改宽仍即时。 */
  const minimapGeoCacheRef = useRef<{ key: unknown[]; geo: MinimapRegionInput[] } | null>(null);
  const minimapGeo = useMemo(() => {
    const key: unknown[] = [];
    for (const r of regions) {
      key.push(r.sessionId, r.stubbed, r.extent, r.blocks, r.layout, r.flowGeom, r.pinnedGeom, r.lastBlockCount);
    }
    const prev = minimapGeoCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev.geo;
    const geo: MinimapRegionInput[] = regions.map((r) => ({
      sessionId: r.sessionId,
      stubbed: r.stubbed,
      extent: r.extent,
      blocks: r.blocks,
      layout: r.layout,
      flowGeom: r.flowGeom,
      pinnedGeom: r.pinnedGeom,
      lastBlockCount: r.lastBlockCount,
    }));
    minimapGeoCacheRef.current = { key, geo };
    return geo;
  }, [regions]);

  /* 公共物 · 孤儿钉：源会话未摊开/已删除，或源块当前不在摊开会话的转译结果里
   *（消息撤回等）——以快照渲染的独立钉层（公共物不绑会话，钉到拔为止） */
  const openSessionIds = useMemo(() => new Set(sessions.map((s) => String(s.id))), [sessions]);
  const openBlockIdsCacheRef = useRef<{ key: unknown[]; set: Set<string> } | null>(null);
  const openBlockIds = useMemo(() => {
    // P2-3：复合键复用——blocks/lastBlockIds 引用在核心缓存下稳定，平移帧
    // 零重建；引用稳定喂给 orphanPins → orphanInkBlocks → minimap 整条链。
    const key: unknown[] = [];
    for (const r of regions) key.push(r.blocks, r.lastBlockIds);
    const prev = openBlockIdsCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev.set;
    const s = new Set<string>();
    // P2-2：stub 卷用最近已知块 id 集（孤儿钉判定不因离屏误判——
    // 钉的源块在钉创建时刻必在最近已知集内）
    for (const r of regions) {
      if (r.stubbed) {
        for (const id of r.lastBlockIds ?? []) s.add(id);
      } else {
        for (const b of r.blocks) s.add(b.id);
      }
    }
    openBlockIdsCacheRef.current = { key, set: s };
    return s;
  }, [regions]);
  const orphanPins = useMemo(() => {
    const out: Array<[string, (typeof canvasState.pins)[string]]> = [];
    for (const [id, pin] of Object.entries(canvasState.pins)) {
      const srcOpen = pin.source ? openSessionIds.has(String(pin.source.sessionId)) : false;
      const present = pin.source ? openBlockIds.has(pin.source.blockId) : false;
      if (!srcOpen || !present) out.push([id, pin]);
    }
    return out;
  }, [canvasState.pins, openSessionIds, openBlockIds]);
  /** 孤儿钉的源卷已删（2026-08-28 会话管理专项）：源卷被删除后「收回」语义
   *  失效——按钮应显示「删除」。来自 deletedSessionIds（deleteSessionFile 标记
   *  + restoreCanvasSpread 播种）。 */
  const deadOrphanPinIds = useMemo(() => {
    if (canvasState.deletedSessionIds.size === 0) return new Set<string>();
    const dead = new Set<string>();
    for (const [id, pin] of orphanPins) {
      if (pin.source && canvasState.deletedSessionIds.has(pin.source.sessionId)) dead.add(id);
    }
    return dead;
  }, [orphanPins, canvasState.deletedSessionIds]);

  /* 流区容器横向可见性（虚拟化：眼睛看不到的流区不进 DOM）。
   *  P2-2：stub 卷不进 DOM（其 margin 大于可见 margin——回场先恢复全量）。 */
  const visibleRegionIds = useMemo(() => {
    const s = new Set<string>();
    const x0 = viewRect.x0 - OVERSCAN;
    const x1 = viewRect.x1 + OVERSCAN;
    for (const r of regions) {
      if (r.stubbed) continue;
      const half = r.anchor.width / 2;
      if (r.anchor.anchorX + half >= x0 && r.anchor.anchorX - half <= x1) s.add(r.sessionId);
    }
    return s;
  }, [regions, viewRect]);

  return {
    regions,
    blockSessionRef,
    sidecarOutOf,
    minimapGeo,
    orphanPins,
    deadOrphanPinIds,
    visibleRegionIds,
    inkCache: inkCacheRef,
  };
}
