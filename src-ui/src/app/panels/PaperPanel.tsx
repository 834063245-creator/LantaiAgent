// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel — 纸视图壳（paper-shell 走查弹长成的主界面，V5 拆除后唯一视图；
// Stage-2 一纸多卷：一个工作区一张纸，多个会话流区共享同一视口）。
//
// 挂法：组合层贡献（paper/paper-plugin.ts：side:null 全屏，unmountOnClose）。
// 数据：真实会话消息（每会话一个消息 store——不 mock，穿全层：
//   ChatMessage[] → paper/translate 转译 → SourcedBlock[] → 注疏渲染）。
// 一纸多卷（Stage-2，docs/plans/canvas-space/stage-2.md）：
//   - 每个摊开的会话 = 一个**流区**（StreamRegion），自锚点向上长；
//     流区位置 = 工作区级持久化（state/canvas-store，随工作区画布状态文件
//     {workspace}/.lantai/canvas.json 落盘，不随会话快照——Stage-5）。
//   - 新会话默认线性排比落位（贴上一个右侧）；拖流区边缘移动整个流区，
//     X 轴吸附网格（宽度+间距 = 2160）。
//   - 平移/缩放全局；虚拟化 = 数据全量、渲染只画视口内可见块。
//   - 活跃流区 = 活跃会话（sess store activeIdx 单一权威），点流区即切换。
// 流锚甲（D-R1-3）：流自视口下缘向上生长，输入条固定底部，最新块贴下缘。
// 钉住（D-R2-1）：按住块拖出流外松手即钉；按钮收回（D-R2-2）。
//
// 书眉：卷名 + 缩放读数 + 设置入口 + 关卷（回案卷首页）+ 窗口控制。
// 输入条：写 input-store（真相源），提交走 core.sendMessage()。

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { activeOverlayContributions, subscribeOverlayContributions } from '../../composition/overlay-service';
import { resolveRenderer } from '../../composition/renderer-service';
import {
  createSettleSelector,
  hitRegionAtWorld,
  type RegionHitRect,
  viewportCenterWorld,
} from '../../paper/active-region';
import type { SourcedBlock } from '../../paper/block-model';
import {
  ANCHOR,
  layoutRegion,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewForAnchor,
  wheelFactor,
  zoomAt,
} from '../../paper/canvas-math';
import {
  type BlockMeasureCache,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
} from '../../paper/measure';
import { PaperDockContext, PaperRegionContext } from '../../paper/overlay-context';
import type { RegionView } from '../../paper/region-view';
import { classifyDropZone, makeStrip, type PaperStrip, stashStripPositionAt } from '../../paper/selection';
import {
  defaultRegionFor,
  nearestFreeRegion,
  STREAM_REGION,
  type StreamRegionState,
  snapRegionX,
} from '../../paper/space';
import { type MessageTranslateCache, translateMessagesCached } from '../../paper/translate';
import {
  type FlowGeom,
  type PinnedGeom,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
} from '../../paper/virtualize';
import {
  blockFromSnapshot,
  type CanvasStore,
  getCanvasStore,
  scheduleCanvasSave,
  snapshotFromBlock,
} from '../../state/canvas-store';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { useDockStore } from '../../state/dock-store';
import { useUpdateStore } from '../../state/update-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
import type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '../../ui/message-model';
import { useCoreStore } from '../chat/core-instance';
import { useShellStore } from '../shell-store';
import { WinControls } from '../WinControls';
import { StatusLine } from './StatusLine';
import './PaperPanel.css';

/* ── 文类签（页边注 rubric）：BlockKind → 注疏文类（docs/design/lantai-design-spec.md §4）── */

const KIND_ZH: Record<string, string> = {
  user: '来文',
  markdown: '正文',
  reasoning: '夹注',
  diff: '抄录',
  tool: '脚注',
  code: '程文',
  plan: '拟策',
  notice: '贴黄',
};
const KIND_EN: Record<string, string> = {
  user: 'USER',
  markdown: 'AGENT',
  reasoning: 'THINK',
  diff: 'CODE',
  tool: 'TOOL',
  code: 'CODE',
  plan: 'PLAN',
  notice: 'NOTE',
};

/** 消息操作项（施工单 #5）：块 hover 出现的操作按钮。 */
interface BlockOp {
  key: string;
  label: string;
  run: () => void;
}

/** 从消息提取可复制的正文文本（text part 拼接）。 */
function messageCopyText(msg: ChatMessage): string {
  if (msg.role !== 'assistant') return msg.text;
  return msg.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

const BlockView = memo(function BlockView({
  block,
  seq,
  ops,
  onUnpin,
  onDragHandleMouseDown,
}: {
  block: SourcedBlock;
  /** 文类签机读序号（卷内流水号，三位补零） */
  seq: string;
  /** 消息操作（hover 浮现）——user 块编辑/重发，assistant 块重试，全部可抄录（施工单 #5） */
  ops: BlockOp[];
  onUnpin: (id: string) => void;
  /** 拖拽手柄（文类签 .pp-kind）——V3a 手势分工：签=整块拖出（D-R2-1） */
  onDragHandleMouseDown: (e: React.MouseEvent, block: SourcedBlock) => void;
}) {
  const p = block.payload;
  const renderer = resolveRenderer(block.kind);
  const Body = renderer?.component;
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖拽手柄（D-R2-1 拖出钉住）；收回有原生按钮 */}
      <div className="pp-kind pp-drag-handle" onMouseDown={(e) => onDragHandleMouseDown(e, block)}>
        <span className="pp-zh">{KIND_ZH[block.kind] ?? block.kind}</span>
        <span className="pp-en">
          {KIND_EN[block.kind] ?? 'NOTE'} · {seq}
        </span>
        {block.kind === 'tool' && (
          <span className={`pp-status pp-${(p as { status: string }).status}`}>{(p as { status: string }).status}</span>
        )}
        {block.kind === 'code' && (
          <span className={`pp-status pp-${(p as { status: string }).status}`}>{(p as { status: string }).status}</span>
        )}
      </div>
      {Body ? <Body block={block} /> : <div className="pp-body">{(p as { text?: string }).text ?? ''}</div>}
      {ops.length > 0 && (
        <div className="pp-msg-ops">
          {ops.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                o.run();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {block.state === 'pinned' && (
        <button
          type="button"
          className="pp-unpin"
          onClick={(e) => {
            e.stopPropagation();
            onUnpin(block.id);
          }}
        >
          收回
        </button>
      )}
    </>
  );
});

/* ── 主组件 ── */

/** 小地图（D-R1-1 方位感件——全画布内容包围盒 + 视口框投影，点击跳转中心） */
function MinimapView({
  content,
  viewport,
  bottom,
}: {
  content: { x0: number; y0: number; x1: number; y1: number };
  viewport: { x0: number; y0: number; x1: number; y1: number };
  /** 创作坞实际高度（rework P3-1：minimap 底部随它定位，避免被动态变高的坞遮住） */
  bottom: number;
}) {
  const W = 128;
  const H = 96;
  const cw = Math.max(1, content.x1 - content.x0);
  const ch = Math.max(1, content.y1 - content.y0);
  const scale = Math.min((W - 8) / cw, (H - 8) / ch);
  const toMap = (x: number, y: number) => ({
    left: 4 + (x - content.x0) * scale + (W - 8 - cw * scale) / 2,
    top: 4 + (y - content.y0) * scale + (H - 8 - ch * scale) / 2,
  });
  const vp = {
    left: toMap(viewport.x0, viewport.y0).left,
    top: toMap(viewport.x0, viewport.y0).top,
    width: Math.max(2, (viewport.x1 - viewport.x0) * scale),
    height: Math.max(2, (viewport.y1 - viewport.y0) * scale),
  };
  return (
    <div className="pp-minimap" style={{ bottom: bottom + 18 }} title="小地图 · Home 键回原点">
      <div className="pp-mm-viewport" style={vp} />
    </div>
  );
}

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 自动选中命中区向上外扩（px，世界单位）：流区标签带在 regionTop 之上
 *  ~38px——用户常把视口中心对准会话标题，不扩会“空白保持当前”不切 */
const REGION_HIT_LABEL_BAND = 40;
/** 手动切换后抑制自动选中的窗口（ms）：显式选会话后给 800ms 喘息，
 * 避免“侧边栏点 A、视口中心还在 B，400ms 后被自动选中拉回 B”的冲突感 */
const MANUAL_GUARD_MS = 800;
/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3） */
const GHOST_H = 32;
/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
const EMPTY_OPS: BlockOp[] = [];

/** 稳定空画布——core 缺席时 useSyncExternalStore 读面（无核心面板 = 空态，方法 no-op） */
const EMPTY_CANVAS: CanvasStore = {
  spread: {},
  pins: {},
  strips: [],
  activeSessionId: null,
  getRegion: () => undefined,
  getPin: () => undefined,
  getPins: () => ({}),
  getStrips: () => [],
  setRegion: () => {},
  moveRegion: () => {},
  ensureRegion: () => {},
  removeRegion: () => {},
  setPin: () => {},
  movePin: () => {},
  unpin: () => {},
  replacePins: () => {},
  addStrip: () => {},
  moveStrip: () => {},
  removeStrip: () => {},
  replaceStrips: () => {},
  setActiveRegion: () => {},
  loadCanvas: () => {},
  clearCanvas: () => {},
};

/** 按点是否落在选区几何矩形内（±4px 容差盖住行间边缘）。 */
function pointInSelectionRects(range: Range, x: number, y: number): boolean {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return true;
  }
  return false;
}

export function PaperPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  const core = useCoreStore((s) => s.core);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  /* ── 会话集（一纸多卷：全部摊开会话 = 全部流区）──
   * sess store 订阅：列表 + 活跃 idx（活跃流区单一权威 = sess activeIdx） */
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  useEffect(() => {
    if (!core) return;
    const sess = getChatStore(core.panelId).sess;
    const sync = () => {
      const st = sess.getState();
      setSessions(st.sessions.map((s) => ({ id: s.id, label: s.label })));
      const active = st.sessions[st.activeIdx];
      setActiveSessionId(active ? active.id : null);
    };
    sync();
    return sess.subscribe(sync);
  }, [core]);

  /* ── 每会话消息快照（流式只动自己流区的消息 → 只重算该流区）── */
  const [regionMsgs, setRegionMsgs] = useState<Record<string, { messages: readonly ChatMessage[]; tick: number }>>({});
  useEffect(() => {
    if (!core) return;
    const unsubs: Array<() => void> = [];
    for (const s of sessions) {
      const store = msgStoreFor(core.panelId, s.id);
      const sync = () => {
        const messages = store.getState().messages;
        setRegionMsgs((prev) => {
          const cur = prev[s.id];
          if (cur && cur.messages === messages) return prev; // 引用未变 = 无新内容
          return { ...prev, [s.id]: { messages, tick: (cur?.tick ?? 0) + 1 } };
        });
      };
      unsubs.push(store.subscribe(sync));
      sync();
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [core, sessions]);

  /* 会话合卷后修剪无主消息快照（防内存残留） */
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    setRegionMsgs((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const stale = keys.some((k) => !ids.has(Number(k)));
      if (!stale) return prev;
      const next = { ...prev };
      for (const k of keys) if (!ids.has(Number(k))) delete next[k];
      return next;
    });
  }, [sessions]);

  /* 活跃流区镜像：canvas-store.activeSessionId 跟随 sess activeIdx（单一权威），
   * setActiveRegion 引用短路——同值不触发订阅（不产生无谓画布保存）。 */
  useEffect(() => {
    if (!core) return;
    getCanvasStore(core.panelId)
      .getState()
      .setActiveRegion(activeSessionId != null ? String(activeSessionId) : null);
  }, [core, activeSessionId]);

  /* 画布状态响应式读面（Stage-5：state/canvas-store 工作区级唯一真相）。
   * useSyncExternalStore——zustand 原生 subscribe/getState，引用稳定
   * （pins/spread/strips 对象引用不变 = 无重渲染 + translate 缓存命中）。 */
  const canvasStoreId = core?.panelId ?? null;
  const canvasState = useSyncExternalStore<CanvasStore>(
    useCallback(
      (cb: () => void) => (canvasStoreId ? getCanvasStore(canvasStoreId).subscribe(cb) : () => {}),
      [canvasStoreId],
    ),
    useCallback(() => (canvasStoreId ? getCanvasStore(canvasStoreId).getState() : EMPTY_CANVAS), [canvasStoreId]),
  );

  /* 画布状态变更 → 防抖落盘（工作区画布状态文件）。Stage-5：布局/公共物
   * 不再随会话快照落盘，独立走 {workspace}/.lantai/canvas.json。 */
  const [paperTick, setPaperTick] = useState(0);
  useEffect(() => {
    if (!core) return;
    const canvas = getCanvasStore(core.panelId);
    return canvas.subscribe(() => {
      setPaperTick((t) => t + 1);
      const pp = useShellStore.getState().projectPath;
      if (pp) scheduleCanvasSave(core.panelId, pp);
    });
  }, [core]);

  /* 性能专项缓存（流式增量）——按会话隔离：
   *  - translateCacheBySession：消息引用增量转译（流式只重译被触碰消息的块）
   *  - measureCache：块 id + 内容签名记忆高度（签名未变零重测，全画布共享）
   *  - opsCache：按块 id 记忆消息操作数组 */
  const translateCacheBySession = useRef(new Map<number, MessageTranslateCache | null>());
  const measureCacheRef = useRef<BlockMeasureCache>(createBlockMeasureCache());
  const opsCacheRef = useRef<Map<string, { msg: ChatMessage; ops: BlockOp[] }>>(new Map());
  // 会话合卷/新增后修剪无主缓存
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const k of translateCacheBySession.current.keys()) {
      if (!ids.has(k)) translateCacheBySession.current.delete(k);
    }
  }, [sessions]);

  /* 新会话默认落位（Stage-5 用户拍板改：X 线性 → 最近空位，不分栏）：
   * 未落位的流区落在「当前视口中心」最近的空列（X 吸附栅格，Y 取视口中心）。
   * 展开绑定视角聚焦（调用方 requestFocus）——落点可预期且一定看得到。
   * ensureRegion 幂等——只补缺，不覆盖已摆放位置（重启恢复的位置不碰）。 */
  useEffect(() => {
    if (!core) return;
    const canvas = getCanvasStore(core.panelId).getState();
    const missing = sessions.filter((s) => !canvas.spread[String(s.id)]);
    if (missing.length === 0) return;
    const v = useCanvasViewStore.getState();
    const center = viewportCenterWorld(v.view, v.canvasSize.w, v.canvasSize.h);
    const occupied: Array<{ sessionId: string; anchorX: number }> = Object.entries(canvas.spread).map(([sid, r]) => ({
      sessionId: sid,
      anchorX: r.anchorX,
    }));
    for (const s of missing) {
      const sid = String(s.id);
      if (canvas.spread[sid]) continue;
      const region = nearestFreeRegion(occupied, center.x, center.y);
      canvas.ensureRegion(sid, region);
      occupied.push({ sessionId: sid, anchorX: region.anchorX });
    }
  }, [core, sessions]);

  const activeSessionKey = activeSessionId != null ? String(activeSessionId) : null;
  // paperTick 显式消费：订阅变化 = 重渲染重读
  void paperTick;

  /* 视口状态（Stage-3：书脊定位器共享真源——canvas-view-store app 级单例，
   * PaperPanel 读写；书脊/侧边栏经 requestFocus 驱动摄像机） */
  const view = useCanvasViewStore((s) => s.view);
  const setView = useCanvasViewStore((s) => s.setView);
  const canvasSize = useCanvasViewStore((s) => s.canvasSize);
  const setCanvasSize = useCanvasViewStore((s) => s.setCanvasSize);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  /* 初始视口：锚点对视口下缘（D-R1-3）。画布尺寸变化时保持锚点关系 */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    setCanvasSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, [setCanvasSize]);

  useEffect(() => {
    const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
    setView((v) => ({ ...v, panX, panY }));
  }, [canvasSize.w, canvasSize.h, setView]);

  /* 画布重挂 = 干净的初始视角：清掉上一轮残留定位请求，回到锚点视口
   * （不许跨开合残留旧 pan——否则实机「进来视角不知在哪/拖不动」）。
   * 只用稳定的 store 动作，刻意只在挂载跑一次（空依赖数组）。 */
  useEffect(() => {
    useCanvasViewStore.getState().requestFocus(null);
    const { panX, panY } = viewForAnchor(
      useCanvasViewStore.getState().canvasSize.w,
      useCanvasViewStore.getState().canvasSize.h,
    );
    useCanvasViewStore.getState().setView((v) => ({ ...v, panX, panY }));
  }, []);

  /* 字体加载后重测：webfont 到位前 canvas 量的是回退字体宽度 */
  const [measureTick, setMeasureTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => {
      if (!alive) return;
      clearPaperMeasureCache();
      setMeasureTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 视口虚拟化输入 */
  const OVERSCAN = 200;
  const viewRect = useMemo(
    () => viewportWorldRect(view, canvasSize.w, canvasSize.h),
    [view, canvasSize.w, canvasSize.h],
  );

  /* ── 边缘拖动（Stage-2：拖流区边缘移动整个流区）──
   * 拖动中 local state 覆盖锚点（不逐帧写 store）；松手一次性落定。 */
  const edgeDragRef = useRef<{ sessionId: string; sx: number; sy: number; ax: number; ay: number } | null>(null);
  const edgeDragLatestRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const [edgeDragPos, setEdgeDragPos] = useState<{ sessionId: string; x: number; y: number } | null>(null);

  /* ── 每流区派生数据（核心：一纸多卷的布局/虚拟化/渲染态）── */
  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，onBlockMouseDown 才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  const regionsRef = useRef<RegionView[]>([]);
  const blockSessionRef = useRef<Map<string, string>>(new Map());

  /* 钉住块位置查找表：引用随 canvasState.pins 引用稳定——不变化时 translate
   * 缓存命中（流式增量铁律：纸面不动的会话零重算）。 */
  const pinsMap = useMemo(() => {
    const m: Record<string, { x: number; y: number }> = {};
    for (const [id, pin] of Object.entries(canvasState.pins)) m[id] = { x: pin.x, y: pin.y };
    return m;
  }, [canvasState.pins]);

  const regions: RegionView[] = useMemo(() => {
    // paperTick/measureTick 是显式失效信号：测量缓存清空后必须重算本 memo——
    // void 引用使依赖声明与闭包语义一致（canvasState 变化本身就是触发源）。
    void paperTick;
    void measureTick;
    const out: RegionView[] = [];
    const blockSession = new Map<string, string>();
    sessions.forEach((s, i) => {
      const sid = String(s.id);
      const msgs = regionMsgs[s.id]?.messages ?? [];
      const persisted = canvasState.spread[sid];
      const baseAnchor = persisted ?? defaultRegionFor(i);
      // 边缘拖动中：用拖动态锚点覆盖（块/纸条随流区整体平移）
      const dragging = edgeDragPos && edgeDragPos.sessionId === sid;
      const anchor: StreamRegionState = dragging
        ? { anchorX: edgeDragPos.x, anchorY: edgeDragPos.y, width: baseAnchor.width }
        : baseAnchor;

      let cache = translateCacheBySession.current.get(s.id) ?? null;
      const res = translateMessagesCached(msgs, pinsMap, cache);
      cache = res.cache;
      translateCacheBySession.current.set(s.id, cache);
      const blocks = res.blocks;

      const stack = blocks.map((b) => ({
        id: b.id,
        h: b.state === 'flow' ? measureBlockHeightCached(b, measureCacheRef.current) : GHOST_H,
        w: b.w,
        kind: b.kind,
      }));
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
          h: measureBlockHeightCached(b, measureCacheRef.current),
        }));
      const flowWindow = visibleFlowWindow(flowGeom, viewRect, OVERSCAN);
      const visiblePinnedSet = new Set(visiblePinnedIds(pinnedGeom, viewRect, OVERSCAN));
      const visibleIds = new Set(visiblePinnedSet);
      for (let j = flowWindow.first; j < flowWindow.lastExcl; j++) visibleIds.add(flowGeom[j].id);

      const seq = new Map<string, string>();
      for (let bi = 0; bi < blocks.length; bi++) {
        seq.set(blocks[bi].id, String(bi + 1).padStart(3, '0'));
      }
      for (const b of blocks) blockSession.set(b.id, sid);

      let top = 0;
      for (const g of flowGeom) top = Math.min(top, g.y);
      const regionTop = top;
      const regionBottom = anchor.anchorY;
      out.push({
        sessionId: sid,
        sessionNum: s.id,
        label: s.label,
        anchor,
        blocks,
        layout,
        flowGeom,
        pinnedGeom,
        flowWindow,
        visibleIds,
        seq,
        regionTop,
        regionBottom,
        regionHeight: Math.max(0, regionBottom - regionTop) + 72,
      });
    });
    blockSessionRef.current = blockSession;
    return out;
  }, [sessions, regionMsgs, paperTick, viewRect, edgeDragPos, measureTick, canvasState, pinsMap]);

  regionsRef.current = regions;

  /* 公共物 · 纸条（工作区级宿主，Stage-5）：不再随流区归属——独立渲染层 */
  const canvasStrips = canvasState.strips;
  /* 公共物 · 孤儿钉：源会话未摊开/已删除，或源块当前不在摊开会话的转译结果里
   * （消息撤回等）——以快照渲染的独立钉层（公共物不绑会话，钉到拔为止） */
  const openSessionIds = useMemo(() => new Set(sessions.map((s) => String(s.id))), [sessions]);
  const openBlockIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of regions) for (const b of r.blocks) s.add(b.id);
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

  /* ── 视口轻动画：飞到指定会话的指定世界 y（书脊定位器/目次带共用）──
   * 复用 viewFocusRegion（锚到流区中轴 + 目标世界 y）；未摊开卷 expand
   * 在途时 pending 保持，流区出现后补飞（regions 依赖的第二个 effect）。 */
  const focusRafRef = useRef(0);
  const flyToPoint = useCallback(
    (sessionId: string, worldY: number) => {
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      const start = useCanvasViewStore.getState().view;
      const target = viewFocusRegion(start, canvasSize.w, canvasSize.h, {
        x: region.anchor.anchorX,
        y: worldY,
      });
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      const DURATION = 240;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / DURATION);
        const ease = 1 - (1 - t) ** 3;
        useCanvasViewStore.getState().setView({
          zoom: start.zoom,
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
        });
        if (t < 1) {
          focusRafRef.current = requestAnimationFrame(tick);
        } else {
          focusRafRef.current = 0;
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h],
  );
  const flyToRegion = useCallback(
    (sessionId: string) => {
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (region) flyToPoint(sessionId, region.anchor.anchorY);
    },
    [flyToPoint],
  );
  const pendingFocusId = useCanvasViewStore((s) => s.pendingFocusId);
  useEffect(() => {
    if (pendingFocusId) flyToRegion(pendingFocusId);
  }, [pendingFocusId, flyToRegion]);
  useEffect(() => {
    // 未摊开卷 expand 在途：流区出现后补飞（pending 未清且目标已存在）
    void regions;
    const pending = useCanvasViewStore.getState().pendingFocusId;
    if (pending) flyToRegion(pending);
  }, [regions, flyToRegion]);
  useEffect(
    () => () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
    },
    [],
  );

  /* 消息操作（施工单 #5）：按来源消息构造 user 编辑/重发、assistant 重试、全部抄录。
   *  ops 按块 id 记忆（opsCacheRef）——点击时经 regionMsgs 取最新消息 */
  const msgOpsFor = useCallback(
    (msg: ChatMessage): BlockOp[] => {
      if (!core) return [];
      const latest = (): ChatMessage => {
        // 在来源会话的消息流里找最新版本
        for (const r of regionsRef.current) {
          const found = regionMsgs[r.sessionNum]?.messages.find((m) => m._id === msg._id);
          if (found) return found;
        }
        return msg;
      };
      const latestMsg = latest();
      const ops: BlockOp[] = [];
      if (msg.role === 'user') {
        const latestUser = (): UserMessage => {
          for (const r of regionsRef.current) {
            const m = regionMsgs[r.sessionNum]?.messages.find((x) => x._id === msg._id);
            if (m && m.role === 'user') return m;
          }
          return msg as UserMessage;
        };
        ops.push({ key: 'edit', label: '改', run: () => core.editUserMessage(latestUser()) });
        ops.push({ key: 'resend', label: '重发', run: () => core.resendUserMessage(latestUser()) });
      } else if (msg.role === 'assistant') {
        const latestAsst = (): AssistantMessage => {
          for (const r of regionsRef.current) {
            const m = regionMsgs[r.sessionNum]?.messages.find((x) => x._id === msg._id);
            if (m && m.role === 'assistant') return m;
          }
          return msg as AssistantMessage;
        };
        ops.push({ key: 'retry', label: '重试', run: () => core.retryAssistant(latestAsst()) });
      }
      const text = messageCopyText(latestMsg);
      if (text.trim()) ops.push({ key: 'copy', label: '抄', run: () => core.copyText(messageCopyText(latest())) });
      return ops;
    },
    [core, regionMsgs],
  );
  const opsByBlock = useMemo(() => {
    const map = new Map<string, BlockOp[]>();
    if (!core) return map;
    for (const r of regions) {
      const byId = new Map<string, ChatMessage>();
      for (const m of regionMsgs[r.sessionNum]?.messages ?? []) byId.set(m._id, m);
      for (const b of r.blocks) {
        const msg = byId.get(b.source.messageId);
        if (!msg) continue;
        const hit = opsCacheRef.current.get(b.id);
        if (hit && hit.msg === msg) {
          map.set(b.id, hit.ops);
        } else {
          const ops = msgOpsFor(msg);
          opsCacheRef.current.set(b.id, { msg, ops });
          map.set(b.id, ops);
        }
      }
    }
    return map;
  }, [regions, regionMsgs, core, msgOpsFor]);

  /* ── 交互：平移 / 缩放 ── */
  const panningRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /* rework P1-1：缩放守卫——滚轮缩放期间/刚停（600ms）不判自动选中（缩放是读细节不改归属） */
  const zoomGuardUntilRef = useRef(0);
  /* rework P1-1：手动切换守卫——显式切会话后 800ms 内不判自动选中（防“切完被拉回”） */
  const manualGuardUntilRef = useRef(0);

  /* 缩放：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!e.ctrlKey && t?.closest('pre, .pp-out')) return;
      e.preventDefault();
      // 用户缩放 = 手动接管视口：取消在途定位动画（否则动画会跟手抢 pan）
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
      }
      useCanvasViewStore.getState().requestFocus(null);
      // 缩放守卫：记录「最近一次缩放」时刻，自动选中在其后 600ms 内不判
      zoomGuardUntilRef.current = performance.now() + 600;
      const rect = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [setView]);

  /* 回原点快捷键（D-R1-1 方位感）：Home → 视口回锚点几何 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Home' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
      setView((v) => ({ ...v, panX, panY }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvasSize.w, canvasSize.h, setView]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // 空白处按下 → 开始平移（块/流区有自己的处理，不落到这里）
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pp-world')) {
      if (e.button !== 0) return;
      e.preventDefault();
      // 用户拖拽 = 手动接管视口：取消在途定位动画（否则动画会跟手抢 pan）
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
      }
      useCanvasViewStore.getState().requestFocus(null);
      panningRef.current = { lastX: e.clientX, lastY: e.clientY };
      setPanning(true);
    }
  }, []);

  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const p = panningRef.current;
      if (!p) return;
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (dx !== 0 || dy !== 0) setView((v) => panBy(v, dx, dy));
    };
    const up = () => {
      // ⚠ 必须清 panningRef：否则 moving 里 panningRef.current != null 恒 true，
      // 第一次拖画布后自动选中永远被当成“平移中”而取消计时。
      panningRef.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [panning, setView]);

  /* ── 拖块（D-R2-1 拖出钉住）：阈值即脱流 → 全程跟手 → 松手判位 ──
   * Stage-5：钉住块 = 工作区级公共物。源会话未摊开的孤儿钉（快照块）同样
   * 可拖（sessionId 缺省）——拖动更新 canvas.pins 位置，不重新钉。 */
  const dragRef = useRef<{
    id: string;
    sessionId: string | undefined;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    bw: number;
    offX: number;
    offY: number;
    block: SourcedBlock | null;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  const onBlockMouseDown = useCallback((e: React.MouseEvent, block: SourcedBlock) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 不触发画布平移/流区激活
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sessionId = blockSessionRef.current.get(block.id);
    const region = sessionId ? regionsRef.current.find((r) => r.sessionId === sessionId) : undefined;
    const v = viewRef.current;
    const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
    const lay = region?.layout;
    const rx = block.state === 'flow' ? (lay?.get(block.id)?.x ?? block.x) : block.x;
    const ry = block.state === 'flow' ? (lay?.get(block.id)?.y ?? block.y) : block.y;
    dragRef.current = {
      id: block.id,
      sessionId,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      wasFlow: block.state === 'flow',
      bw: block.w,
      offX: w.x - rx,
      offY: w.y - ry,
      block,
    };
  }, []);

  /** 落定钉住：新钉 = 捕获快照 + 活引用源；已钉 = 移位置；pos null = 收回。
   *  源会话缺省（孤儿钉）= 只移动既有钉，不新建。 */
  const commitPinned = useCallback(
    (
      sessionId: string | undefined,
      blockId: string,
      pos: { x: number; y: number } | null,
      block?: SourcedBlock | null,
    ) => {
      if (!core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      if (!pos) {
        canvas.unpin(blockId);
        return;
      }
      const existing = canvas.pins[blockId];
      if (existing) {
        canvas.movePin(blockId, pos.x, pos.y);
        return;
      }
      if (!block) return;
      canvas.setPin(blockId, {
        x: pos.x,
        y: pos.y,
        w: block.w,
        source: sessionId ? { sessionId: Number(sessionId), blockId } : undefined,
        snapshot: snapshotFromBlock(block),
      });
    },
    [core],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      if (!d.moved) {
        d.moved = true;
        setDraggingId(d.id);
        if (d.wasFlow) {
          commitPinned(d.sessionId, d.id, { x: w.x - d.offX, y: w.y - d.offY }, d.block);
        }
      }
      setDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      const fx = w.x - d.offX;
      const fy = w.y - d.offY;
      const region = d.sessionId ? regionsRef.current.find((r) => r.sessionId === d.sessionId) : undefined;
      const bandCenter = region?.anchor.anchorX ?? 0;
      // 松手判位：落在来源流区窄带内且原为 flow → 回流（不钉）；孤儿钉不回流
      if (d.wasFlow && d.sessionId && Math.abs(fx - bandCenter) <= ANCHOR.bandHalfWidth) {
        commitPinned(d.sessionId, d.id, null);
      } else {
        commitPinned(d.sessionId, d.id, { x: fx, y: fy }, d.block);
      }
      setDragPos(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view, commitPinned]);

  /* 收回（即时手势，双向对称）：钉从纸上拔掉（回到流/或孤儿钉直接消失） */
  const onUnpin = useCallback(
    (id: string) => {
      if (!core) return;
      getCanvasStore(core.panelId).getState().unpin(id);
    },
    [core],
  );
  const onGhostClick = onUnpin;

  /* ── 自动选中（Stage-4 §4.1）：三道闸停留控制器 ──
   * 活跃会话是有记忆的状态，非每帧重算：视口中心命中流区 + 连续停留
   * 400ms 才切；平移/缩放/输入锁存折叠成 moving 喂进控制器。
   * 显式动作（点流区/书脊/侧边栏/边缘拖拽）走 activateRegion 并 adopt，
   * 防止自动选中在用户显式切换后立刻把它拉回去。 */
  const [inputLocked, setInputLocked] = useState(false);
  const activateRegionRef = useRef<(sessionId: string) => void>(() => {});
  const settleRef = useRef(
    createSettleSelector({
      delayMs: 400,
      onChange: (sessionId) => activateRegionRef.current(sessionId),
    }),
  );
  useEffect(() => () => settleRef.current.dispose(), []);

  /* ── 流区激活（点流区背景 = 显式动作立即切；自动选中也经此落定）── */
  const activateRegion = useCallback(
    (sessionId: string) => {
      if (!core) return;
      settleRef.current.adopt(sessionId);
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => String(s.id) === sessionId);
      if (idx < 0) return;
      if (idx !== st.activeIdx) core.switchSession(idx);
      getCanvasStore(core.panelId).getState().setActiveRegion(sessionId);
    },
    [core],
  );
  activateRegionRef.current = activateRegion;

  // 任何路径使活跃会话变化（显式点击/新建/摊开/恢复/自动选中）都把它登记为「最近落定值」，
  // 防止自动选中在状态刚切换后立刻拉回旧流区；同时给 800ms 手动守卫，
  // 避免“侧边栏点 A、视口中心还在 B，400ms 后被自动选中拉回 B”的冲突感。
  useEffect(() => {
    settleRef.current.adopt(activeSessionKey);
    manualGuardUntilRef.current = performance.now() + MANUAL_GUARD_MS;
  }, [activeSessionKey]);

  /* ── 自动选中效果：视口中心 → 命中判定 → 停留控制器 ── */
  useEffect(() => {
    const settle = settleRef.current;
    const panningRefLocal = panningRef; // 平移中不判（随 view 变化每帧喂）
    const tick = () => {
      // 读 store 实时 view：订阅回调在 React 重渲染前同步触发，viewRef 会滞后一帧
      const v = useCanvasViewStore.getState().view;
      const center = viewportCenterWorld(v, canvasSize.w, canvasSize.h);
      const rects: RegionHitRect[] = regionsRef.current.map((r) => ({
        sessionId: r.sessionId,
        x0: r.anchor.anchorX - r.anchor.width / 2,
        x1: r.anchor.anchorX + r.anchor.width / 2,
        // 向上外扩盖住标签带（标题在 regionTop 之上）——中心对准会话标题也算命中
        y0: r.regionTop - REGION_HIT_LABEL_BAND,
        y1: r.regionBottom,
      }));
      const hit = hitRegionAtWorld(center.x, center.y, rects);
      // 运动中不判：平移/边缘拖/定位动画 + 拖块/拖纸条（用户正握着东西，别抢活跃会话）
      // + 输入锁存 + 缩放守卫 + 手动切换守卫
      const moving =
        panningRefLocal.current != null ||
        edgeDragRef.current != null ||
        dragRef.current != null ||
        stripDragRef.current != null ||
        focusRafRef.current > 0 ||
        inputLocked ||
        performance.now() < zoomGuardUntilRef.current ||
        performance.now() < manualGuardUntilRef.current;
      settle.push(hit, moving);
    };
    tick();
    // view 每帧变化（平移/缩放/动画）即时喂（运动中快速取消）；
    // 200ms 间隔兜底「停住」后的最终判定（停止后不再有 view 变更事件）。
    const iv = window.setInterval(tick, 200);
    const unsub = useCanvasViewStore.subscribe(tick);
    return () => {
      window.clearInterval(iv);
      unsub();
    };
  }, [canvasSize.w, canvasSize.h, inputLocked]);

  /* ── 流区边缘拖动（Stage-2 定案：悬停边缘即拖拽态，无显式手柄条）── */
  const onRegionEdgeMouseDown = useCallback((e: React.MouseEvent, sessionId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const region = regionsRef.current.find((r) => r.sessionId === sessionId);
    if (!region) return;
    edgeDragRef.current = {
      sessionId,
      sx: e.clientX,
      sy: e.clientY,
      ax: region.anchor.anchorX,
      ay: region.anchor.anchorY,
    };
  }, []);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = edgeDragRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const v = viewRef.current;
      const dx = (e.clientX - d.sx) / v.zoom;
      const dy = (e.clientY - d.sy) / v.zoom;
      const nx = snapRegionX(d.ax + dx);
      const ny = d.ay + dy;
      edgeDragLatestRef.current = { sessionId: d.sessionId, x: nx, y: ny };
      setEdgeDragPos({ sessionId: d.sessionId, x: nx, y: ny });
    };
    const up = () => {
      const d = edgeDragRef.current;
      const last = edgeDragLatestRef.current;
      edgeDragRef.current = null;
      edgeDragLatestRef.current = null;
      setEdgeDragPos(null);
      if (!d || !core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      const cur = canvas.spread[d.sessionId];
      const x = last && last.sessionId === d.sessionId ? last.x : snapRegionX(cur?.anchorX ?? d.ax);
      const y = last && last.sessionId === d.sessionId ? last.y : (cur?.anchorY ?? d.ay);
      canvas.setRegion(d.sessionId, {
        anchorX: x,
        anchorY: y,
        width: cur?.width ?? STREAM_REGION.width,
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* 小地图（D-R1-1 方位感：全画布内容聚落 + 视口框）——跨流区包围盒。
   * Stage-5：公共物（纸条 + 孤儿钉快照）同样计入画布范围。 */
  const minimap = useMemo(() => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of regions) {
      for (const g of r.flowGeom) {
        x0 = Math.min(x0, g.x);
        y0 = Math.min(y0, g.y);
        x1 = Math.max(x1, g.x + g.w);
        y1 = Math.max(y1, g.y + g.h);
      }
      for (const g of r.pinnedGeom) {
        x0 = Math.min(x0, g.x);
        y0 = Math.min(y0, g.y);
        x1 = Math.max(x1, g.x + g.w);
        y1 = Math.max(y1, g.y + g.h);
      }
    }
    for (const s of canvasStrips) {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w);
      y1 = Math.max(y1, s.y + 96);
    }
    for (const [, pin] of orphanPins) {
      x0 = Math.min(x0, pin.x);
      y0 = Math.min(y0, pin.y);
      x1 = Math.max(x1, pin.x + pin.w);
      y1 = Math.max(y1, pin.y + 96);
    }
    if (!Number.isFinite(x0)) {
      x0 = -400;
      x1 = 400;
      y0 = -200;
      y1 = 0;
    }
    return { content: { x0, y0, x1, y1 }, viewport: viewRect };
  }, [regions, viewRect, canvasStrips, orphanPins]);

  /* ── 抽纸条交互（A 拖拽做正 + B 选中浮钮）──
   * Stage-5：纸条 = 工作区级公共物（拷贝语义快照，独立宿主，不挂会话）——
   * 落点相对来源流区计算，但数据本身不再随流区归属。 */
  const stripDragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    moved: boolean;
    offX: number;
    offY: number;
  } | null>(null);
  const liftRef = useRef<{
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
    rect: DOMRect | null;
  } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; zone: 'flow' | 'strip' } | null>(null);
  const pressStartRef = useRef<{
    sx: number;
    sy: number;
    sessionId: string | undefined;
    blockEl: Element | null;
  } | null>(null);

  const spawnStrip = useCallback(
    (sessionId: string, text: string, messageId: string | undefined, x: number, y: number) => {
      const trimmed = text.trim();
      if (!trimmed || !core) return;
      void sessionId; // 纸条 = 工作区级公共物（Stage-5），源会话只作溯源展示
      const strip = makeStrip(trimmed, x, y, 480, messageId ? { messageId } : undefined);
      getCanvasStore(core.panelId).getState().addStrip(strip);
    },
    [core],
  );

  const toWorldInCanvas = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return null;
      return screenToWorld(view, sx, sy);
    },
    [view],
  );

  /** 选区快照（块内才认）：{ 文本, 来源块 messageId, 来源流区 sessionId } | null。 */
  const snapshotBlockSelection = useCallback((): {
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
  } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
    const blockEl = anchorEl?.closest('.pp-block') ?? null;
    if (!blockEl) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    return {
      text,
      messageId: blockEl.getAttribute('data-message-id') ?? undefined,
      sessionId: blockEl.getAttribute('data-session-id') ?? undefined,
    };
  }, []);

  const ghostRef = useRef<{ x: number; y: number; zone: 'flow' | 'strip' } | null>(null);
  useEffect(() => {
    ghostRef.current = ghost;
  }, [ghost]);

  const restoreSelectionByRect = useCallback((rect: DOMRect) => {
    if (rect.width === 0 || rect.height === 0) return;
    const lineProbe = Math.min(rect.height, 22) / 2;
    const a = document.caretRangeFromPoint(rect.left + 1, rect.top + lineProbe);
    const b = document.caretRangeFromPoint(rect.right - 1, rect.bottom - lineProbe);
    if (!a || !b) return;
    const range = document.createRange();
    try {
      if (a.compareBoundaryPoints(Range.START_TO_START, b) <= 0) {
        range.setStart(a.startContainer, a.startOffset);
        range.setEnd(b.startContainer, b.startOffset);
      } else {
        range.setStart(b.startContainer, b.startOffset);
        range.setEnd(a.startContainer, a.startOffset);
      }
    } catch {
      return;
    }
    if (range.collapsed) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  /* 流区窄带中心（幽灵/落点判据的带中心 = 来源流区中轴） */
  const bandCenterOf = useCallback((sessionId: string | undefined): number => {
    if (sessionId == null) return 0;
    return regionsRef.current.find((r) => r.sessionId === sessionId)?.anchor.anchorX ?? 0;
  }, []);

  /* A：拖拽路径（mousedown/mousemove/mouseup 全局通道） */
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const blockEl = e.target instanceof Element ? e.target.closest('.pp-block') : null;
      pressStartRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        sessionId: blockEl?.getAttribute('data-session-id') ?? undefined,
        blockEl,
      };
      if (dragRef.current || stripDragRef.current) {
        liftRef.current = null;
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const range = sel.getRangeAt(0);
      if (!pointInSelectionRects(range, e.clientX, e.clientY)) return;
      liftRef.current = {
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
        rect: range.getBoundingClientRect(),
      };
      sel.removeAllRanges();
      e.preventDefault();
    };

    const move = (e: MouseEvent) => {
      const w = toWorldInCanvas(e.clientX, e.clientY);
      if (!w) {
        setGhost(null);
        return;
      }
      const center = bandCenterOf(liftRef.current?.sessionId ?? pressStartRef.current?.sessionId);
      const zone = classifyDropZone(w.x - center, ANCHOR.bandHalfWidth);
      if (liftRef.current) {
        setGhost({ x: w.x, y: w.y, zone });
        return;
      }
      const start = pressStartRef.current;
      if (!start?.blockEl || Math.hypot(e.clientX - start.sx, e.clientY - start.sy) < DRAG_THRESHOLD) return;
      if (zone === 'flow') {
        setGhost(null);
        return;
      }
      const snap = snapshotBlockSelection();
      if (!snap) return;
      setGhost({ x: w.x, y: w.y, zone });
    };

    const up = (e: MouseEvent) => {
      const start = pressStartRef.current;
      pressStartRef.current = null;
      const g = ghostRef.current;
      setGhost(null);
      const lift = liftRef.current;
      liftRef.current = null;
      if (lift) {
        const w = toWorldInCanvas(e.clientX, e.clientY);
        const center = bandCenterOf(lift.sessionId);
        if (w && lift.sessionId && classifyDropZone(w.x - center, ANCHOR.bandHalfWidth) === 'strip') {
          spawnStrip(lift.sessionId, lift.text, lift.messageId, w.x, w.y);
        } else if (lift.rect) {
          restoreSelectionByRect(lift.rect);
        }
        return;
      }
      if (g?.zone !== 'strip' || !start?.blockEl || !start.sessionId) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const w = toWorldInCanvas(e.clientX, e.clientY);
      const center = bandCenterOf(start.sessionId);
      if (!w || classifyDropZone(w.x - center, ANCHOR.bandHalfWidth) !== 'strip') return;
      window.getSelection()?.removeAllRanges();
      spawnStrip(start.sessionId, snap.text, snap.messageId, w.x, w.y);
    };

    window.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [spawnStrip, snapshotBlockSelection, toWorldInCanvas, restoreSelectionByRect, bandCenterOf]);

  /* B：选中浮钮（selectionchange 监听——选区出现在块内时浮钮现身） */
  const [selAnchor, setSelAnchor] = useState<{
    range: Range;
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
  } | null>(null);
  useEffect(() => {
    const onSelChange = () => {
      const snap = snapshotBlockSelection();
      if (!snap) {
        setSelAnchor(null);
        return;
      }
      const sel = window.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (!range || !rect || rect.width === 0) {
        setSelAnchor(null);
        return;
      }
      setSelAnchor({
        range: range.cloneRange(),
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
      });
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [snapshotBlockSelection]);

  let fabPos: { left: number; top: number } | null = null;
  if (selAnchor) {
    const fr = selAnchor.range.getBoundingClientRect();
    if (fr.width > 0) fabPos = { left: fr.right + 8, top: fr.top - 30 };
  }

  const onStripButton = useCallback(() => {
    if (!selAnchor?.sessionId) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const selRect = selAnchor.range.getBoundingClientRect();
    if (!rect || selRect.width === 0) {
      setSelAnchor(null);
      return;
    }
    const worldMidY = screenToWorld(view, 0, selRect.top + selRect.height / 2 - rect.top).y;
    const region = regionsRef.current.find((r) => r.sessionId === selAnchor.sessionId);
    const centerX = region?.anchor.anchorX ?? 0;
    const pos = stashStripPositionAt(worldMidY, canvasStrips, ANCHOR.bandHalfWidth, centerX);
    spawnStrip(selAnchor.sessionId, selAnchor.text, selAnchor.messageId, pos.x, pos.y);
    window.getSelection()?.removeAllRanges();
    setSelAnchor(null);
  }, [selAnchor, view, spawnStrip, canvasStrips]);

  /* 拖纸条：与拖块同款阈值手势——超阈才跟动，松手一次性写 canvas-store */
  const [dragStripId, setDragStripId] = useState<string | null>(null);
  const [stripDragPos, setStripDragPos] = useState<{ x: number; y: number } | null>(null);
  const onStripMouseDown = useCallback(
    (e: React.MouseEvent, s: PaperStrip) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      stripDragRef.current = {
        id: s.id,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        offX: w.x - s.x,
        offY: w.y - s.y,
      };
    },
    [view],
  );
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = stripDragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      if (!d.moved) {
        d.moved = true;
        setDragStripId(d.id);
      }
      setStripDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const up = (e: MouseEvent) => {
      const d = stripDragRef.current;
      stripDragRef.current = null;
      setDragStripId(null);
      setStripDragPos(null);
      if (!d?.moved || !core) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      getCanvasStore(core.panelId)
        .getState()
        .moveStrip(d.id, w.x - d.offX, w.y - d.offY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view, core]);

  const onRemoveStrip = useCallback(
    (id: string) => {
      if (!core) return;
      getCanvasStore(core.panelId).getState().removeStrip(id);
    },
    [core],
  );

  /* 世界层 transform */
  const worldStyle = useMemo(
    () => ({ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }),
    [view],
  );

  const zoomLabel = Math.round(view.zoom * 100) + '%';
  const totalBlocks = regions.reduce((n, r) => n + r.blocks.length, 0);
  const totalPinned = Object.keys(canvasState.pins).length;
  const totalStrips = canvasState.strips.length;

  /* 流区容器横向可见性（虚拟化：眼睛看不到的流区不进 DOM） */
  const visibleRegionIds = useMemo(() => {
    const s = new Set<string>();
    const x0 = viewRect.x0 - OVERSCAN;
    const x1 = viewRect.x1 + OVERSCAN;
    for (const r of regions) {
      const half = r.anchor.width / 2;
      if (r.anchor.anchorX + half >= x0 && r.anchor.anchorX - half <= x1) s.add(r.sessionId);
    }
    return s;
  }, [regions, viewRect]);

  /* ── 覆盖层贡献（Stage-4 插件化落位：创作坞/目次带 = 贡献行）──
   * 订阅贡献变更：插件热注册/卸载时即时重取渲染面（对齐 panels 的 bump 信号）。 */
  const [, setOverlayTick] = useState(0);
  useEffect(() => subscribeOverlayContributions(() => setOverlayTick((t) => t + 1)), []);
  const composerOverlays = activeOverlayContributions('composer');
  const edgeOverlays = activeOverlayContributions('right-edge');

  /* rework P3-1：创作坞实际高度（动态——思考展开/附件/yolo 都会变高）驱动
   * 目次带/小地图的底部定位，避免硬编码 gap 导致重叠。
   * 用 callback ref（React 19 支持清理）替代 effect+dep，避免 lint 对
   * composerOverlays.length 依赖的误报，同时正确响应槽挂载/卸载。 */
  const [composerHeight, setComposerHeight] = useState(96);
  const composerSlotRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    setComposerHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  /* ── 覆盖层上下文（Stage-4）：创作坞消费低频（动作/活跃/锁存），
   * 目次带消费高频（流区几何）。拆两 context 避免创作坞随平移重渲。 ── */
  const dockContext = useMemo(
    () => ({
      activeSessionId: activeSessionKey,
      inputLocked,
      setInputLocked,
      flyToPoint,
    }),
    [activeSessionKey, inputLocked, flyToPoint],
  );
  const regionContext = useMemo(
    () => ({
      regions,
      activeSessionId: activeSessionKey,
      viewRect,
      canvasSize,
      composerHeight,
    }),
    [regions, activeSessionKey, viewRect, canvasSize, composerHeight],
  );

  return (
    <PaperDockContext.Provider value={dockContext}>
      <PaperRegionContext.Provider value={regionContext}>
        <div className="pp-root">
          <div className="pp-topbar">
            <span className="pp-title">画布</span>
            <span className="pp-tag">兰台 · CANVAS</span>
            <span className="pp-zoom">
              {zoomLabel} · {totalBlocks} 块 · 已钉 {totalPinned} · 纸条 {totalStrips}
            </span>
            <StatusLine />
            <button
              type="button"
              className={`pp-settings${updateAvailable ? ' has-update' : ''}`}
              title={
                updateAvailable && updateVersion ? `设置 (Ctrl+,) · 新版本 ${updateVersion} 可用` : '设置 (Ctrl+,)'
              }
              onClick={() => useDockStore.getState().togglePanel('settings')}
            >
              设置
            </button>
            <button type="button" className="pp-close" onClick={() => closePanel('paper')}>
              回首页
            </button>
            <WinControls />
          </div>

          {/* B 选中浮钮：块内有选区时现身（锚点随视口现算），点击成条（落来源流区右侧空地） */}
          {selAnchor && !ghost && fabPos && (
            <button type="button" className="pp-strip-fab" style={fabPos} onClick={onStripButton}>
              抽纸条
            </button>
          )}

          {/* biome-ignore lint/a11y/noStaticElementInteractions: 无限画布是鼠标平移/缩放交互面 */}
          <div ref={canvasRef} className={`pp-canvas${panning ? ' pp-panning' : ''}`} onMouseDown={onCanvasMouseDown}>
            {sessions.length === 0 && (
              <div className="pp-empty">
                这张纸上还没有案卷。
                <br />
                点左侧「另起一卷」开始，新卷会自动落到右侧。
              </div>
            )}

            {/* 世界层 */}
            <div className="pp-world" style={worldStyle}>
              {/* 原点十字（方位感） */}
              <div className="pp-origin" style={{ left: 0, top: 0 }}>
                <span className="pp-origin-label">origin</span>
              </div>

              {/* 幽灵预览（抽纸条拖拽过程反馈） */}
              {ghost && (
                <div
                  className={`pp-strip-ghost${ghost.zone === 'strip' ? ' pp-strip-ghost--ok' : ''}`}
                  style={{ left: ghost.x + 12, top: ghost.y + 12 }}
                >
                  <span className="pp-strip-ghost-tag">纸条</span>
                  <span className="pp-strip-ghost-text">{ghost.zone === 'strip' ? '松手成条' : '拖出流带成条'}</span>
                </div>
              )}

              {/* 流区容器（一纸多卷：每会话一块有界流区——边缘拖动移动整区） */}
              {regions.map((r) => {
                if (!visibleRegionIds.has(r.sessionId)) return null;
                const isActive = r.sessionId === activeSessionKey;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: 流区是可点击交互面（点背景激活流区）
                  <div
                    key={r.sessionId}
                    className={`pp-region${isActive ? ' pp-region-active' : ''}`}
                    style={{
                      left: r.anchor.anchorX - r.anchor.width / 2,
                      top: r.regionTop,
                      width: r.anchor.width,
                      height: r.regionHeight,
                    }}
                    data-session-id={r.sessionId}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      if (e.target === e.currentTarget) activateRegion(r.sessionId);
                    }}
                  >
                    <div
                      className="pp-region-label"
                      title={`案卷 ${r.sessionNum}${isActive ? ' · 活跃' : ' · 点击激活'}`}
                    >
                      <span className="pp-region-label-zh">{r.label || `案卷 ${r.sessionNum}`}</span>
                      <span className="pp-region-label-meta">
                        {isActive ? '活跃' : '点击激活'} · {r.blocks.length} 块
                      </span>
                    </div>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: 边缘拖拽面（Stage-2 定案：无手柄条，hover 即拖拽态） */}
                    <div
                      className="pp-region-edge pp-region-edge--l"
                      onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                    />
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: 边缘拖拽面（同左缘——拖右缘移动整个流区） */}
                    <div
                      className="pp-region-edge pp-region-edge--r"
                      onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                    />
                  </div>
                );
              })}

              {/* 纸条（V3a：拷贝语义快照，可拖动、可销毁；工作区级公共物 Stage-5） */}
              {canvasStrips.map((s) => {
                const stripDragged = dragStripId === s.id;
                const stripPos = stripDragged && stripDragPos ? stripDragPos : { x: s.x, y: s.y };
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: 纸条拖拽面（D-R2-1 手势族）
                  <div
                    key={s.id}
                    className={`pp-strip${stripDragged ? ' pp-dragging' : ''}`}
                    style={{ left: stripPos.x, top: stripPos.y, width: s.w }}
                    onMouseDown={(e) => onStripMouseDown(e, s)}
                  >
                    <div className="pp-strip-head">
                      <span className="pp-strip-tag">纸条</span>
                      <button
                        type="button"
                        className="pp-strip-remove"
                        title="销毁纸条"
                        aria-label="销毁纸条"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveStrip(s.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="pp-strip-body">{s.text}</div>
                  </div>
                );
              })}

              {/* 公共物 · 孤儿钉（源会话未摊开/已删除，Stage-5）：以快照独立渲染——
               * 公共物不绑会话、钉到拔为止。源会话摊开时由下方流区 pass 渲染活块。 */}
              {orphanPins.map(([pinId, pin]) => {
                const snapshotBlock = blockFromSnapshot(pinId, pin);
                const isDragged = draggingId === pinId;
                const pos = isDragged && dragPos ? dragPos : { x: pin.x, y: pin.y };
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler
                  <div
                    key={pinId}
                    className={[
                      'pp-block',
                      `pp-${snapshotBlock.kind}`,
                      'pp-pinned',
                      isDragged ? 'pp-dragging' : '',
                    ].join(' ')}
                    style={{ left: pos.x, top: pos.y, width: pin.w }}
                    onDragStart={(e) => e.preventDefault()}
                  >
                    <BlockView
                      block={snapshotBlock}
                      seq="PIN"
                      ops={EMPTY_OPS}
                      onUnpin={onUnpin}
                      onDragHandleMouseDown={onBlockMouseDown}
                    />
                  </div>
                );
              })}

              {/* 流序列：每流区 flow 块按序渲染（视口窗口化——视口外不进 DOM） */}
              {regions.map((r) =>
                r.blocks.map((b) => {
                  const slot = r.layout.get(b.id);
                  if (!slot || !r.visibleIds.has(b.id)) return null;
                  if (b.state === 'flow') {
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler
                      <div
                        key={b.id}
                        className={`pp-block pp-${b.kind}`}
                        style={{ left: slot.x, top: slot.y, width: b.w }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <BlockView
                          block={b}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          onUnpin={onUnpin}
                          onDragHandleMouseDown={onBlockMouseDown}
                        />
                      </div>
                    );
                  }
                  const isDragged = draggingId === b.id;
                  const pos = isDragged && dragPos ? dragPos : { x: b.x, y: b.y };
                  return (
                    <Fragment key={b.id}>
                      <button
                        type="button"
                        className="pp-ghost"
                        style={{ left: slot.x, top: slot.y, width: b.w, height: GHOST_H }}
                        onClick={() => onGhostClick(b.id)}
                      >
                        已移出 · 点击恢复
                      </button>
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler */}
                      <div
                        className={['pp-block', `pp-${b.kind}`, 'pp-pinned', isDragged ? 'pp-dragging' : ''].join(' ')}
                        style={{ left: pos.x, top: pos.y, width: b.w }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <BlockView
                          block={b}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          onUnpin={onUnpin}
                          onDragHandleMouseDown={onBlockMouseDown}
                        />
                      </div>
                    </Fragment>
                  );
                }),
              )}
            </div>
          </div>

          {/* 小地图（D-R1-1 方位感：全画布内容聚落 + 视口框 + Home 回原点） */}
          <MinimapView content={minimap.content} viewport={minimap.viewport} bottom={composerHeight} />

          {/* 覆盖层贡献行（Stage-4）：创作坞（composer 槽）在底栏，目次带（right-edge 槽）在右缘 */}
          <div className="pp-composer-slot" ref={composerSlotRef}>
            {composerOverlays.map((def) => (
              <def.component key={def.id} />
            ))}
          </div>
          {edgeOverlays.map((def) => (
            <def.component key={def.id} />
          ))}
        </div>
      </PaperRegionContext.Provider>
    </PaperDockContext.Provider>
  );
}
