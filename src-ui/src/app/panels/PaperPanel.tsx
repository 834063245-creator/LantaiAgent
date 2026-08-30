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
import { resolveAssetBlock, resolveRenderer } from '../../composition/renderer-service';
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
import { createFocusFlightScheduler } from '../../paper/focus-flight';
import { defaultFolded, foldLabel, isFoldable } from '../../paper/fold';
import { createInkCache, type InkCache, inkColorOf, inkForBlock, lodActive } from '../../paper/ink';
import {
  type BlockMeasureCache,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  needsObservedHeight,
  reportObservedBlockHeight,
  subscribeObservedBlockHeights,
  USER_SHRINK_MIN_W,
} from '../../paper/measure';
import { PaperDockContext, PaperRegionContext } from '../../paper/overlay-context';
import type { RegionView } from '../../paper/region-view';
import {
  classifyDropZone,
  type MaskRect,
  makeStrip,
  type PaperStrip,
  selectionMaskRects,
  stashStripPositionAt,
} from '../../paper/selection';
import {
  clampRegionW,
  defaultRegionFor,
  nearestFreeRegion,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
  type StreamRegionState,
} from '../../paper/space';
import { collapseToolGroups, type MessageTranslateCache, translateMessagesCached } from '../../paper/translate';
import { injectPaperTokens } from '../../paper/type-tokens';
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
import { Icon } from '../Icon';
import { useShellStore } from '../shell-store';
import { WinControls } from '../WinControls';
import { InkLayer } from './InkLayer';
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
  toolgroup: '工具组',
  notice: '贴黄',
  // 资产 kind（WO-4 文类签）：未知名仍回退 block.kind 字面。
  table: '表格',
  chart: '图表',
  metric: '指标',
  file: '文件',
  deps_impact: '影响',
  html: '卡片',
  confirm: '确认',
};
const KIND_EN: Record<string, string> = {
  user: 'USER',
  markdown: 'AGENT',
  reasoning: 'THINK',
  diff: 'CODE',
  tool: 'TOOL',
  code: 'CODE',
  plan: 'PLAN',
  toolgroup: 'TOOLS',
  notice: 'NOTE',
  table: 'TABLE',
  chart: 'CHART',
  metric: 'METRIC',
  file: 'FILE',
  deps_impact: 'GRAPH',
  html: 'HTML',
  confirm: 'CONFIRM',
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
  folded,
  sidecarFolded,
  onToggleFold,
  onToggleSidecarFold,
  onSidecarPinMouseDown,
  onUnpin,
  onDragHandleMouseDown,
  unpinLabel = '收回',
}: {
  block: SourcedBlock;
  /** 文类签机读序号（卷内流水号，三位补零） */
  seq: string;
  /** 消息操作（hover 浮现）——user 块编辑/重发，assistant 块重试，全部可抄录（施工单 #5） */
  ops: BlockOp[];
  /** 有效折叠态（壳层：用户覆盖 ?? paper/fold 默认规则）——夹注/脚注/程文消费 */
  folded: boolean;
  /** P5 眉批折叠态（夹注恒折拍板延续——复合 markdown 眉批默认收起） */
  sidecarFolded?: boolean;
  /** 折叠行点击（切换覆盖态） */
  onToggleFold: (b: SourcedBlock) => void;
  /** 眉批折叠切换（壳层 foldOv 持久，key = `${block.id}:sc`） */
  onToggleSidecarFold?: (b: SourcedBlock) => void;
  /** 眉批拖出钉画布（拷贝语义公共物：独立夹注快照） */
  onSidecarPinMouseDown?: (e: React.MouseEvent, block: SourcedBlock) => void;
  onUnpin: (id: string) => void;
  /** 拖拽手柄（文类签 .pp-kind）——V3a 手势分工：签=整块拖出（D-R2-1） */
  onDragHandleMouseDown: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** 孤儿钉按钮文案（2026-08-28 会话管理专项）：源卷已删 = 「删除」，否则「收回」 */
  unpinLabel?: string;
}) {
  const p = block.payload;
  const Body = block.asset
    ? resolveAssetBlock(block.kind, block.asset.presentation)
    : resolveRenderer(block.kind)?.component;
  const foldable = isFoldable(block.kind);
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
      {foldable && (
        <button
          type="button"
          className="pp-fold"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFold(block);
          }}
        >
          {foldLabel(block.kind, p, folded)}
        </button>
      )}
      {Body ? (
        <Body
          block={block}
          folded={folded}
          sidecarFolded={sidecarFolded}
          onToggleSidecarFold={onToggleSidecarFold}
          onSidecarPinMouseDown={onSidecarPinMouseDown}
        />
      ) : (
        <div className="pp-body">{(p as { text?: string }).text ?? ''}</div>
      )}
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
          title={unpinLabel === '删除' ? '删除孤儿钉（源卷已删，无法收回）' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onUnpin(block.id);
          }}
        >
          {unpinLabel}
        </button>
      )}
    </>
  );
});

/* ── 主组件 ── */

/** 小地图（D-R1-1 方位感件——全画布内容包围盒 + 视口框投影，点击跳转）。
 * V3b 欠账接回（2026-08-30）：pointer-events 开启，点击像素反解世界坐标滑过去。 */
function MinimapView({
  content,
  viewport,
  bottom,
  onJump,
  activeRegion,
  foldedOf,
  inkCache,
}: {
  content: { x0: number; y0: number; x1: number; y1: number };
  viewport: { x0: number; y0: number; x1: number; y1: number };
  /** 创作坞实际高度（rework P3-1：minimap 底部随它定位，避免被动态变高的坞遮住） */
  bottom: number;
  /** 点击跳转：视口中心滑到对应世界点（保 zoom） */
  onJump: (worldX: number, worldY: number) => void;
  /** P4b 小地图真墨：活跃流区的行条墨迹（摊开整卷见真卷轴） */
  activeRegion?: RegionView;
  foldedOf?: (b: SourcedBlock) => boolean;
  inkCache?: InkCache;
}) {
  const W = 128;
  const H = 96;
  const cw = Math.max(1, content.x1 - content.x0);
  const ch = Math.max(1, content.y1 - content.y0);
  const scale = Math.min((W - 8) / cw, (H - 8) / ch);
  const offX = (W - 8 - cw * scale) / 2;
  const offY = (H - 8 - ch * scale) / 2;
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = inkCanvasRef.current;
    if (!canvas || !activeRegion || !foldedOf || !inkCache) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const flow = activeRegion.blocks.filter((b) => b.state === 'flow');
    // 块数 > 50 = 密度档：每块只画首行（缩略不逐行）
    const density = flow.length > 50;
    for (const b of flow) {
      const slot = activeRegion.layout.get(b.id);
      if (!slot) continue;
      const ink = inkForBlock(b, foldedOf(b), inkCache);
      const bar0 = ink.bars[0];
      if (!bar0) continue;
      ctx.fillStyle = inkColorOf(b.kind);
      if (density) {
        ctx.fillRect(
          4 + (slot.x + bar0.x0 - content.x0) * scale + offX,
          4 + (slot.y - content.y0) * scale + offY,
          Math.max(1, bar0.w * scale),
          1.5,
        );
        continue;
      }
      const h = Math.max(0.5, ink.lineH * scale * 0.5);
      for (const bar of ink.bars) {
        ctx.fillRect(
          4 + (slot.x + bar.x0 - content.x0) * scale + offX,
          4 + (slot.y + bar.dy - content.y0) * scale + offY,
          Math.max(0.5, bar.w * scale),
          h,
        );
      }
    }
  }, [activeRegion, content, foldedOf, inkCache, offX, offY, scale]);
  const toMap = (x: number, y: number) => ({
    left: 4 + (x - content.x0) * scale + offX,
    top: 4 + (y - content.y0) * scale + offY,
  });
  const vp = {
    left: toMap(viewport.x0, viewport.y0).left,
    top: toMap(viewport.x0, viewport.y0).top,
    width: Math.max(2, (viewport.x1 - viewport.x0) * scale),
    height: Math.max(2, (viewport.y1 - viewport.y0) * scale),
  };
  return (
    <div
      className="pp-minimap"
      style={{ bottom: bottom + 18 }}
      title="小地图 · 点击跳转 · Home 键回原点 · Alt+↑↓ 走块 · Alt+←→ 走卷"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left - 4 - offX;
        const my = e.clientY - rect.top - 4 - offY;
        onJump(content.x0 + mx / scale, content.y0 + my / scale);
      }}
    >
      <canvas ref={inkCanvasRef} className="pp-mm-ink" />
      <div className="pp-mm-viewport" style={vp} />
    </div>
  );
}

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 自动选中命中区向上外扩余量（px，世界单位）：卷首头（folio-head）在
 *  regionTop 之上实测 folioH——命中区再外扩 40px 兜住卷首上缘的呼吸带，
 *  用户常把视口中心对准卷首，不扩会“空白保持当前”不切 */
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
  deletedSessionIds: new Set(),
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
  resizePin: () => {},
  unpin: () => {},
  replacePins: () => {},
  addStrip: () => {},
  moveStrip: () => {},
  resizeStrip: () => {},
  removeStrip: () => {},
  replaceStrips: () => {},
  setActiveRegion: () => {},
  markSessionDeleted: () => {},
  replaceDeletedSessionIds: () => {},
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
  /* P4 缩远墨迹：骨架几何缓存（签名命中零重算） */
  const inkCacheRef = useRef(createInkCache());

  /* ── 折叠态（2026-08-30 会话流渲染专项）──
   * 规则态在 paper/fold.ts（夹注恒折；脚注/程文按状态：running/error 展开、
   * 其余收起）。本表只存用户显式覆盖（点折叠行）——覆盖缺席回落规则态，
   * running→done 的状态翻转自动收回的是「没有用户意志的默认态」，不打架。 */
  const [foldOv, setFoldOv] = useState<Record<string, boolean>>({});
  const foldedOf = useCallback(
    (b: SourcedBlock): boolean => foldOv[b.id] ?? defaultFolded(b.kind, b.payload),
    [foldOv],
  );
  const onToggleFold = useCallback((b: SourcedBlock) => {
    setFoldOv((prev) => {
      const cur = prev[b.id] ?? defaultFolded(b.kind, b.payload);
      return { ...prev, [b.id]: !cur };
    });
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

  /* ── 流式生命感（2026-08-30）──
   * seenBlocks：已渲染过的块 id 集——pp-enter 入场类只发首见（无 StrictMode，
   * 渲染期标记安全），虚拟化平移重挂不重放动画。
   * （pp-tail 尾笔已由用户拍板拆除——见 taste-ledger 翻案。） */
  const seenBlocksRef = useRef<Set<string>>(new Set());
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
    const occupied: Array<{ sessionId: string; anchorX: number; width: number }> = Object.entries(canvas.spread).map(
      ([sid, r]) => ({
        sessionId: sid,
        anchorX: r.anchorX,
        width: r.width,
      }),
    );
    for (const s of missing) {
      const sid = String(s.id);
      if (canvas.spread[sid]) continue;
      const region = nearestFreeRegion(occupied, center.x, center.y);
      canvas.ensureRegion(sid, region);
      occupied.push({ sessionId: sid, anchorX: region.anchorX, width: region.width });
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
  /** 纸面根（.pp-root）：挂载时注入版式 token 为 CSS 变量（单一真源 type-tokens）。 */
  const paperRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paperRootRef.current) injectPaperTokens(paperRootRef.current);
  }, []);
  /** 世界层（pp-world）引用：缩放停稳后摘 will-change + 强制 reflow 用。 */
  const worldRef = useRef<HTMLDivElement | null>(null);

  /* ── 缩远墨迹（P4 LOD）：zoom 低于迟滞阈值时块/纸条 DOM 退场，InkLayer 画
   * 真墨行条骨架——远看真卷轴 + 远缩性能防线（阈值间往返不闪烁）。 ── */
  const [lod, setLod] = useState(false);
  const lodRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = lodActive(useCanvasViewStore.getState().view.zoom, lodRef.current);
      if (next !== lodRef.current) {
        lodRef.current = next;
        setLod(next);
      }
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);

  /* ── 文字锐化（2026-08-30）：世界层 will-change 只在交互期挂。
   * 常驻 will-change:transform 会让浏览器固定合成层栅格化分辨率，放大时
   * GPU 拉伸旧位图、文字发虚；只有层内容变 dirty（重排）才按当前档位重新
   * 栅格化。这里订阅 view 变化（wheel/pan/动画全源）：变化中挂 live 保合成
   * 层流畅 + 重置 settle 定时器；停稳 120ms 摘 live + 强制 reflow，逼浏览器
   * 按当前档位重新栅格化。subscribe 模式对齐 LOD effect（不依赖 React 渲染
   * 周期，view 变化在 store 层即触发）。 */
  const rerasterTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const sync = () => {
      const world = worldRef.current;
      if (!world) return;
      world.classList.add('pp-world--live');
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
      rerasterTimerRef.current = window.setTimeout(() => {
        const el = worldRef.current;
        if (!el) return;
        el.classList.remove('pp-world--live');
        void el.offsetHeight; // 强制同步 reflow → 触发重新栅格化
        rerasterTimerRef.current = null;
      }, 120);
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);
  useEffect(
    () => () => {
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
    },
    [],
  );

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

  /* ── 实测回写桥（2026-08-30 溢出修复）──
   * 静态镜像管不了的动态高（媒体图加载 / html 卡 iframe 上报 / 拟策反馈框
   * 展开）由 ResizeObserver 实测兜底：资产/开放/拟策块挂载即观察。
   * 挂载首报（registered）= 校准登记：只写入不重排——滚动虚拟化中逐卡挂载
   * 逐卡立即全局重排会脉冲成整条流抽搐（2026-08-31 修复），改为 120ms 去抖
   * 一次收敛；首报后值再变（changed：媒体图加载等动态高）才即时 bump。
   * RO 读布局盒（transform 缩放不影响）——世界单位与 CSS px 同源。 */
  const blockRoRef = useRef<ResizeObserver | null>(null);
  const blockRoElIds = useRef(new WeakMap<Element, string>());
  /* 首报收敛去抖：滚动中不断有新卡挂载，逐次重排 = 布局脉冲；停下 120ms 后
   * 一次收敛全部登记（媒体图/反馈框等挂载后动态高仍走 changed 即时重排）。 */
  const convergeTimerRef = useRef<number | null>(null);
  const scheduleConverge = useCallback(() => {
    if (convergeTimerRef.current) window.clearTimeout(convergeTimerRef.current);
    convergeTimerRef.current = window.setTimeout(() => {
      convergeTimerRef.current = null;
      setMeasureTick((t) => t + 1);
    }, 120);
  }, []);
  useEffect(
    () => () => {
      if (convergeTimerRef.current) window.clearTimeout(convergeTimerRef.current);
    },
    [],
  );
  const blockRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return; // 卸载清理由 RO 弱目标语义 + WeakMap GC 兜底（记录保留防振荡）
      if (typeof ResizeObserver === 'undefined') return; // jsdom 测试环境无 RO
      const id = el.dataset.blockObserved;
      if (!id) return;
      if (!blockRoRef.current) {
        blockRoRef.current = new ResizeObserver((entries) => {
          for (const e of entries) {
            const eid = blockRoElIds.current.get(e.target);
            if (!eid) continue;
            const box = e.borderBoxSize?.[0];
            const target = e.target as HTMLElement;
            const verdict = reportObservedBlockHeight(
              eid,
              box ? box.inlineSize : target.offsetWidth,
              box ? box.blockSize : target.offsetHeight,
            );
            // 首报校准登记：去抖一次收敛（changed 已由订阅即时重排）
            if (verdict === 'registered') scheduleConverge();
          }
        });
      }
      blockRoElIds.current.set(el, id);
      blockRoRef.current.observe(el);
    },
    [scheduleConverge],
  );
  useEffect(() => subscribeObservedBlockHeights(() => setMeasureTick((t) => t + 1)), []);
  useEffect(
    () => () => {
      blockRoRef.current?.disconnect();
      blockRoRef.current = null;
    },
    [],
  );

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

  /* ── 四角横向缩放（P6 宽度自由）：角落手柄拖拽改宽——东角动右缘、西角动
   * 左缘（对缘锚定），clamp [720, 2160]；Y 不动（流区 Y 由内容生长）。
   * 拖动中流区框跟手（anchor 覆盖），块体重排走 adaptBlocks（measure 缓存
   * w 键失效自动重测——layout 纯算术零 reflow）。 ── */
  const regionCornerRef = useRef<{
    sessionId: string;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    sx: number;
    orig: StreamRegionState;
  } | null>(null);
  const regionCornerLatestRef = useRef<{ sessionId: string; x: number; width: number } | null>(null);
  const [regionCornerPos, setRegionCornerPos] = useState<{ sessionId: string; x: number; width: number } | null>(null);

  const onRegionCornerMouseDown = useCallback(
    (e: React.MouseEvent, sessionId: string, corner: 'nw' | 'ne' | 'sw' | 'se') => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      regionCornerRef.current = { sessionId, corner, sx: e.clientX, orig: { ...region.anchor } };
    },
    [],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = regionCornerRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = (e.clientX - d.sx) / viewRef.current.zoom;
      const east = d.corner === 'ne' || d.corner === 'se';
      const newW = clampRegionW(east ? d.orig.width + dx : d.orig.width - dx);
      // 对缘锚定：东角动 → 左缘固定；西角动 → 右缘固定
      const leftEdge = d.orig.anchorX - d.orig.width / 2;
      const rightEdge = d.orig.anchorX + d.orig.width / 2;
      const anchorX = east ? leftEdge + newW / 2 : rightEdge - newW / 2;
      regionCornerLatestRef.current = { sessionId: d.sessionId, x: anchorX, width: newW };
      setRegionCornerPos({ sessionId: d.sessionId, x: anchorX, width: newW });
    };
    const up = () => {
      const d = regionCornerRef.current;
      const last = regionCornerLatestRef.current;
      regionCornerRef.current = null;
      regionCornerLatestRef.current = null;
      setRegionCornerPos(null);
      if (!d || !last || last.sessionId !== d.sessionId || !core) return;
      const cur = getCanvasStore(core.panelId).getState().spread[d.sessionId];
      getCanvasStore(core.panelId)
        .getState()
        .setRegion(d.sessionId, {
          anchorX: last.x,
          anchorY: cur?.anchorY ?? d.orig.anchorY,
          width: last.width,
        });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── 每流区派生数据（核心：一纸多卷的布局/虚拟化/渲染态）── */
  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，onBlockMouseDown 才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  const regionsRef = useRef<RegionView[]>([]);
  const blockSessionRef = useRef<Map<string, string>>(new Map());

  /* 钉住块位置查找表：引用随 canvasState.pins 引用稳定——不变化时 translate
   * 缓存命中（流式增量铁律：纸面不动的会话零重算）。w 一并入表（P2b 宽度
   * 手调：pin.w 是钉住几何唯一真相，渲染宽经 translate 覆盖块宽）。 */
  const pinsMap = useMemo(() => {
    const m: Record<string, { x: number; y: number; w?: number }> = {};
    for (const [id, pin] of Object.entries(canvasState.pins)) m[id] = { x: pin.x, y: pin.y, w: pin.w };
    return m;
  }, [canvasState.pins]);

  /* P2a+P6 宽度自由：块宽适配流区——先 clamp 到流区内容宽（窄流区压版心，
   * 宽流区不放宽：版心有可读上限 720）。2026-08-30 来文标题化：来文不再收缩
   * 宽（纸条隐喻退役），与其他块同走版心宽——标题居中吃版心。WeakMap 以
   * 「源对象 + 目标宽」记忆——resize 拖动中逐帧换宽不破 React.memo 身份。 */
  const shrinkCopyCacheRef = useRef(new WeakMap<SourcedBlock, { w: number; copy: SourcedBlock }>());
  const adaptBlocks = useCallback((blocks: SourcedBlock[], regionW: number): SourcedBlock[] => {
    const cache = shrinkCopyCacheRef.current;
    const contentW = Math.max(USER_SHRINK_MIN_W, regionW - REGION_CONTENT_MARGIN);
    return blocks.map((b) => {
      const cappedW = Math.min(b.w, contentW);
      const targetW = cappedW;
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
    const blockSession = new Map<string, string>();
    sessions.forEach((s, i) => {
      const sid = String(s.id);
      const msgs = regionMsgs[s.id]?.messages ?? [];
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

      let cache = translateCacheBySession.current.get(s.id) ?? null;
      const res = translateMessagesCached(msgs, pinsMap, cache);
      cache = res.cache;
      translateCacheBySession.current.set(s.id, cache);
      // 工具组收起摘除（2026-08-30 会话流专项）：折叠态组头的子卡不进布局栈
      const blocks = collapseToolGroups(adaptBlocks(res.blocks, anchor.width), foldedOf);

      const stack = blocks.map((b) => ({
        id: b.id,
        h:
          b.state === 'flow'
            ? measureBlockHeightCached(b, measureCacheRef.current, foldedOf(b), sidecarFoldedOf(b))
            : GHOST_H,
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
          h: measureBlockHeightCached(b, measureCacheRef.current, foldedOf(b), sidecarFoldedOf(b)),
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
      // 卷首头高度：标题按流区可用宽实测（folio 头左右内距 16×2，镜像 .pp-folio-head padding）
      const folioH = measureFolioHeadHeight(s.label || `案卷 ${s.id}`, anchor.width - 32);
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
        folioH,
      });
    });
    blockSessionRef.current = blockSession;
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
    adaptBlocks,
  ]);

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
  /** 孤儿钉快照块（P4：远缩墨迹层画它们的行条——公共物不连坐，墨也不连坐） */
  const orphanInkBlocks = useMemo(() => orphanPins.map(([id, pin]) => blockFromSnapshot(id, pin)), [orphanPins]);
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

  /* ── 视口轻动画：飞到指定会话的指定世界 y（书脊定位器/目次带共用）──
   * 复用 viewFocusRegion（锚到流区中轴 + 目标世界 y）；未摊开卷 expand
   * 在途时 pending 保持，流区出现后补飞（regions 依赖的第二个 effect）。 */
  const focusRafRef = useRef(0);
  /** 飞行调度（2026-08-31 视口乱飞修复）：动画在途不重播——见 paper/focus-flight */
  const focusFlightRef = useRef(createFocusFlightScheduler());
  const flyToPoint = useCallback(
    (sessionId: string, worldY: number) => {
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      // 同目标动画在途不再重播（regions 随视口每帧换引用——无守卫会自锁成乱飞）
      if (focusFlightRef.current.begin(sessionId) === 'rejected') return;
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
          focusFlightRef.current.end();
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
  /* 小地图点击跳转（V3b 欠账接回，2026-08-30）：视口中心滑到目标世界点（保 zoom）。
   * 复用 focusRafRef——与 flyToPoint 互斥（后动取消先动），自动选中的
   * 「运动中不判」守卫也随之生效。 */
  const glideViewTo = useCallback(
    (worldX: number, worldY: number) => {
      // glide 也是飞行：进入在途态（无目标卷），阻挡补飞打扰；定位到达后取代
      if (focusFlightRef.current.begin(null) === 'rejected') return;
      const start = useCanvasViewStore.getState().view;
      const target = {
        zoom: start.zoom,
        panX: canvasSize.w / 2 - worldX * start.zoom,
        panY: canvasSize.h / 2 - worldY * start.zoom,
      };
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
          focusFlightRef.current.end();
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h],
  );
  const pendingFocusId = useCanvasViewStore((s) => s.pendingFocusId);
  useEffect(() => {
    if (pendingFocusId) flyToRegion(pendingFocusId);
  }, [pendingFocusId, flyToRegion]);
  useEffect(() => {
    // 未摊开卷 expand 在途：流区出现后补飞（pending 未清且目标已存在）。
    // 动画在途不重启（2026-08-31 视口乱飞修复）：regions 随视口每帧换引用，
    // 无守卫会让补飞每帧 cancel+重播动画 → 动画永不完、pending 永不清。
    void regions;
    const pending = useCanvasViewStore.getState().pendingFocusId;
    if (pending && !focusFlightRef.current.isActive()) flyToRegion(pending);
  }, [regions, flyToRegion]);
  useEffect(
    () => () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      focusFlightRef.current.end();
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
        focusFlightRef.current.end();
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
        focusFlightRef.current.end();
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

  /* ── 键盘走卷（2026-08-30 中期件）：Alt+↑↓ 块间 / Alt+←→ 卷间 ──
   * 画布对键盘党此前是黑洞。块序 = 流序（尾=最新），以「视口中心最近块」为
   * 基准 ±1 飞行（flyToPoint 复用，目次带同款动画）；卷间 = 激活 + 飞到流区。
   * isEditing / 命令面板打开时不抢键；preventDefault 压 WebView 的 Alt+←→ 导航。 */
  const jumpBlock = useCallback(
    (dir: 1 | -1) => {
      if (!core) return;
      const sessSt = getChatStore(core.panelId).sess.getState();
      const active = sessSt.sessions[sessSt.activeIdx];
      if (!active) return;
      const region = regionsRef.current.find((r) => r.sessionId === String(active.id));
      if (!region) return;
      const geomById = new Map<string, FlowGeom>(region.flowGeom.map((g) => [g.id, g]));
      const flow = region.blocks.filter((b) => b.state === 'flow' && geomById.has(b.id));
      if (flow.length === 0) return;
      const view = useCanvasViewStore.getState().view;
      const centerY = viewportCenterWorld(view, canvasSize.w, canvasSize.h).y;
      let cur = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < flow.length; i++) {
        const g = geomById.get(flow[i].id);
        if (!g) continue;
        const d = Math.abs(centerY - (g.y + g.h / 2));
        if (d < best) {
          best = d;
          cur = i;
        }
      }
      const target = flow[Math.min(flow.length - 1, Math.max(0, cur + dir))];
      const g = geomById.get(target.id);
      if (!g) return;
      flyToPoint(region.sessionId, g.y + g.h / 2);
    },
    [core, flyToPoint, canvasSize.w, canvasSize.h],
  );
  const jumpRegion = useCallback(
    (dir: 1 | -1) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      if (st.sessions.length === 0) return;
      const next = Math.min(st.sessions.length - 1, Math.max(0, st.activeIdx + dir));
      if (next === st.activeIdx) return;
      const target = st.sessions[next];
      activateRegion(String(target.id));
      flyToRegion(String(target.id));
    },
    [core, activateRegion, flyToRegion],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (useShellStore.getState().paletteOpen) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        jumpBlock(e.key === 'ArrowDown' ? 1 : -1);
      } else {
        e.preventDefault();
        jumpRegion(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpBlock, jumpRegion]);

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
        // 向上外扩盖住卷首头（卷首在 regionTop 之上实测 folioH）——中心对准卷首也算命中
        y0: r.regionTop - r.folioH - REGION_HIT_LABEL_BAND,
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
      const nx = d.ax + dx;
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
      const x = last && last.sessionId === d.sessionId ? last.x : (cur?.anchorX ?? d.ax);
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
  /* P4b 小地图真墨：活跃流区（自动选中机制同主人） */
  const activeInkRegion = useMemo(
    () => regions.find((r) => r.sessionId === activeSessionKey),
    [regions, activeSessionKey],
  );

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

  /* ── lift 遮罩（P1 抽纸条手感 2026-08-30）：拖出选区时原地「被揭起」占位。
   * rects = 捕获时刻选区的世界矩形快照（世界层渲染，随视口变换跟手）；
   * done = 成条后的淡出态。取消路径即时移除（选区原样恢复 = 无事发生）。 */
  const [liftMask, setLiftMask] = useState<{ rects: MaskRect[]; done: boolean } | null>(null);
  const liftFadeTimerRef = useRef(0);
  const showLiftMask = useCallback((rects: MaskRect[]) => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask({ rects, done: false });
  }, []);
  const completeLiftMask = useCallback(() => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask((prev) => (prev ? { ...prev, done: true } : null));
    liftFadeTimerRef.current = window.setTimeout(() => setLiftMask(null), 220);
  }, []);
  const clearLiftMask = useCallback(() => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask(null);
  }, []);
  useEffect(() => () => window.clearTimeout(liftFadeTimerRef.current), []);

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
      if (dragRef.current || stripDragRef.current || resizeRef.current) {
        liftRef.current = null;
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const range = sel.getRangeAt(0);
      if (!pointInSelectionRects(range, e.clientX, e.clientY)) return;
      // 原地遮罩矩形在清选区前捕获（世界坐标快照——渲染层随视口变换跟手）
      const cr = canvasRef.current?.getBoundingClientRect();
      const worldRects = cr
        ? selectionMaskRects(range.getClientRects(), viewRef.current, { x: cr.left, y: cr.top })
        : [];
      liftRef.current = {
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
        rect: range.getBoundingClientRect(),
      };
      if (worldRects.length > 0) showLiftMask(worldRects);
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
          completeLiftMask(); // 成条：原地遮罩淡出（揭走动作完成）
        } else if (lift.rect) {
          restoreSelectionByRect(lift.rect);
          clearLiftMask(); // 取消：选区原样恢复，遮罩即撤（无事发生）
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
  }, [
    spawnStrip,
    snapshotBlockSelection,
    toWorldInCanvas,
    restoreSelectionByRect,
    bandCenterOf,
    showLiftMask,
    completeLiftMask,
    clearLiftMask,
  ]);

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

  /* ── 宽度手调（P2b）：钉住块/纸条右缘 resize 面——hover 即拖拽态（同流区
   * 边缘范式）。live 预览走本地态，松手一次性写 canvas-store；prepare 与
   * 宽度无关 → 高度重测零 reflow，拖动全程 60fps。钉住块 x 是左缘（世界
   * 坐标唯一真相），右缘拖拽只改宽不改位。 */
  const resizeRef = useRef<{ id: string; kind: 'pin' | 'strip'; startX: number; startW: number } | null>(null);
  const resizeLatestRef = useRef<{ id: string; w: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; w: number } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent, id: string, kind: 'pin' | 'strip', startW: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { id, kind, startX: e.clientX, startW };
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = resizeRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = (e.clientX - d.startX) / viewRef.current.zoom;
      const w = Math.min(STREAM_REGION.width, Math.max(USER_SHRINK_MIN_W, Math.round(d.startW + dx)));
      resizeLatestRef.current = { id: d.id, w };
      setResizePreview({ id: d.id, w });
    };
    const up = () => {
      const d = resizeRef.current;
      const last = resizeLatestRef.current;
      resizeRef.current = null;
      resizeLatestRef.current = null;
      setResizePreview(null);
      if (!d || !last || last.id !== d.id || !core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      if (d.kind === 'pin') canvas.resizePin(d.id, last.w);
      else canvas.resizeStrip(d.id, last.w);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── 眉批拖出钉画布（P5）：眉批栏「钉」手柄按下 → 跟手（body cursor 反馈）
   * → 松手落独立夹注快照钉（拷贝语义公共物，composite 不受影响）。 ── */
  const sidecarPinRef = useRef<{ block: SourcedBlock; sx: number; sy: number } | null>(null);
  const onSidecarPinMouseDown = useCallback((e: React.MouseEvent, block: SourcedBlock) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    sidecarPinRef.current = { block, sx: e.clientX, sy: e.clientY };
  }, []);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = sidecarPinRef.current;
      if (!d) return;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > DRAG_THRESHOLD) {
        document.body.classList.add('pp-pin-grabbing');
      }
    };
    const up = (e: MouseEvent) => {
      const d = sidecarPinRef.current;
      sidecarPinRef.current = null;
      document.body.classList.remove('pp-pin-grabbing');
      if (!d || !core) return;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return; // 点击=无操作
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(viewRef.current, e.clientX - rect.left, e.clientY - rect.top);
      const sidecar = (d.block.payload as { sidecar?: { text: string } }).sidecar;
      if (!sidecar?.text) return;
      getCanvasStore(core.panelId)
        .getState()
        .setPin(`${d.block.id}:sc`, {
          x: w.x,
          y: w.y,
          w: 320,
          snapshot: { kind: 'reasoning', text: sidecar.text },
        });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

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
        <div className="pp-root" ref={paperRootRef}>
          <div className="pp-topbar">
            <span className="pp-title">画布</span>
            <span className="pp-tag">兰台 · CANVAS</span>
            <span className="pp-zoom" title={`画布读数：${totalBlocks} 块 · 已钉 ${totalPinned} · 纸条 ${totalStrips}`}>
              {zoomLabel}
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
                <div className="pp-empty-kicker">LANTAI · BLANK SHEET</div>
                <div className="pp-empty-title">这张纸上还没有案卷</div>
                <div className="pp-empty-rule" />
                {/* 空态 CTA（2026-08-31 拍板 A）：显式出生入口——不再只是文字指路 */}
                <button
                  type="button"
                  className="pp-empty-cta"
                  disabled={!core}
                  onClick={() => void core?.createNewSession()}
                >
                  ＋ 另起一卷
                </button>
                <div className="pp-empty-hint">也可以点左侧「另起一卷」，或直接在下方落笔——开口即开卷</div>
                <div className="pp-empty-asterism">⁂</div>
              </div>
            )}

            {/* 世界层 */}
            <div ref={worldRef} className="pp-world" style={worldStyle}>
              {/* 原点十字（方位感） */}
              <div className="pp-origin" style={{ left: 0, top: 0 }}>
                <span className="pp-origin-label">origin</span>
              </div>

              {/* lift 遮罩（P1 抽纸条手感）：原地「被揭起」占位——世界层随视口变换 */}
              {liftMask?.rects.map((r, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 遮罩片按位静态渲染（选区矩形序），无重排身份
                  key={`lift-${i}`}
                  className={`pp-lift-mask${liftMask.done ? ' pp-lift-mask--done' : ''}`}
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                />
              ))}

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
                      top: r.regionTop - r.folioH,
                      width: r.anchor.width,
                      height: r.regionHeight + r.folioH,
                    }}
                    data-session-id={r.sessionId}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      if (e.target === e.currentTarget) activateRegion(r.sessionId);
                    }}
                  >
                    {/* 卷首（folio-head，2026-08-30 自 prototype/lantai.html .folio-head 转录）：
                     * 玉徽（亭台线稿）居中钤印 + 机读眉行 + 宋体题字 + 机读档行，
                     * 底部硬规线 + 左缘朱砂版口钮。框体向上扩展包住卷首（界栏护持）。
                     * pointer-events none——点击穿透流区背景，激活语义不变；
                     * 原浮动标签带退役（卷首即卷名，不重复播报）。 */}
                    <div className="pp-folio-head">
                      <span className="pp-yuwei">
                        <Icon name="lantai" size={24} />
                      </span>
                      <p className="pp-folio-eyebrow">兰台 · 案卷 Nº {r.sessionNum}</p>
                      <h2 className="pp-folio-title">{r.label || `案卷 ${r.sessionNum}`}</h2>
                      <p className="pp-folio-sub">
                        案卷 #{r.sessionNum} · {r.blocks.length} 块
                      </p>
                    </div>
                    {/* 空卷题字：零块流区的版心竖排占位（pointer-events none——
                     * 点击穿透到流区背景激活） */}
                    {r.blocks.length === 0 && <div className="pp-region-empty">此卷未落墨</div>}
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
                    {/* P6 四角横向缩放柄（角落只开放横向——Y 由内容生长） */}
                    {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                      // biome-ignore lint/a11y/noStaticElementInteractions: 角柄是拖拽交互面
                      <div
                        key={c}
                        className={`pp-region-corner pp-region-corner--${c}`}
                        onMouseDown={(e) => onRegionCornerMouseDown(e, r.sessionId, c)}
                      />
                    ))}
                  </div>
                );
              })}

              {/* 纸条（V3a：拷贝语义快照，可拖动、可销毁；工作区级公共物 Stage-5） */}
              {!lod &&
                canvasStrips.map((s) => {
                  const stripDragged = dragStripId === s.id;
                  const stripPos = stripDragged && stripDragPos ? stripDragPos : { x: s.x, y: s.y };
                  const stripW = resizePreview?.id === s.id ? resizePreview.w : s.w;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: 纸条拖拽面（D-R2-1 手势族）
                    <div
                      key={s.id}
                      className={`pp-strip${stripDragged ? ' pp-dragging' : ''}`}
                      style={{ left: stripPos.x, top: stripPos.y, width: stripW }}
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
                      {/* P2b 宽度手调面（右缘拖拽） */}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                      <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, s.id, 'strip', s.w)} />
                    </div>
                  );
                })}

              {/* 公共物 · 孤儿钉（源会话未摊开/已删除，Stage-5）：以快照独立渲染——
               * 公共物不绑会话、钉到拔为止。源会话摊开时由下方流区 pass 渲染活块。 */}
              {!lod &&
                orphanPins.map(([pinId, pin]) => {
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
                      style={{ left: pos.x, top: pos.y, width: resizePreview?.id === pinId ? resizePreview.w : pin.w }}
                      onDragStart={(e) => e.preventDefault()}
                    >
                      <BlockView
                        block={snapshotBlock}
                        seq="PIN"
                        ops={EMPTY_OPS}
                        folded={foldedOf(snapshotBlock)}
                        sidecarFolded={sidecarFoldedOf(snapshotBlock)}
                        onToggleFold={onToggleFold}
                        onToggleSidecarFold={onToggleSidecarFold}
                        onSidecarPinMouseDown={onSidecarPinMouseDown}
                        onUnpin={onUnpin}
                        onDragHandleMouseDown={onBlockMouseDown}
                        unpinLabel={deadOrphanPinIds.has(pinId) ? '删除' : '收回'}
                      />
                      {/* P2b 宽度手调面（右缘拖拽） */}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                      <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, pinId, 'pin', pin.w)} />
                    </div>
                  );
                })}

              {/* 流序列：每流区 flow 块按序渲染（视口窗口化——视口外不进 DOM） */}
              {regions.map((r) => {
                if (lod) return null; // P4 缩远墨迹：DOM 块树退场，InkLayer 接管
                return r.blocks.map((b) => {
                  const slot = r.layout.get(b.id);
                  if (!slot || !r.visibleIds.has(b.id)) return null;
                  if (b.state === 'flow') {
                    const firstSeen = !seenBlocksRef.current.has(b.id);
                    if (firstSeen) seenBlocksRef.current.add(b.id);
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler
                      <div
                        key={b.id}
                        className={`pp-block pp-${b.kind}${firstSeen ? ' pp-enter' : ''}`}
                        style={{ left: slot.x, top: slot.y, width: b.w }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-observed={needsObservedHeight(b.kind, b.asset != null) ? b.id : undefined}
                        ref={blockRootRef}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <BlockView
                          block={b}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          folded={foldedOf(b)}
                          sidecarFolded={sidecarFoldedOf(b)}
                          onToggleFold={onToggleFold}
                          onToggleSidecarFold={onToggleSidecarFold}
                          onSidecarPinMouseDown={onSidecarPinMouseDown}
                          onUnpin={onUnpin}
                          onDragHandleMouseDown={onBlockMouseDown}
                        />
                      </div>
                    );
                  }
                  const isDragged = draggingId === b.id;
                  const pos = isDragged && dragPos ? dragPos : { x: b.x, y: b.y };
                  const pinW = resizePreview?.id === b.id ? resizePreview.w : b.w;
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
                        style={{ left: pos.x, top: pos.y, width: pinW }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-observed={needsObservedHeight(b.kind, b.asset != null) ? b.id : undefined}
                        ref={blockRootRef}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <BlockView
                          block={b}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          folded={foldedOf(b)}
                          sidecarFolded={sidecarFoldedOf(b)}
                          onToggleFold={onToggleFold}
                          onToggleSidecarFold={onToggleSidecarFold}
                          onSidecarPinMouseDown={onSidecarPinMouseDown}
                          onUnpin={onUnpin}
                          onDragHandleMouseDown={onBlockMouseDown}
                        />
                        {/* P2b 宽度手调面（右缘拖拽） */}
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                        <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, b.id, 'pin', b.w)} />
                      </div>
                    </Fragment>
                  );
                });
              })}
            </div>

            {/* P4 缩远墨迹：远缩档的屏幕空间 canvas 骨架（pointer-events none） */}
            {lod && (
              <InkLayer
                regionsRef={regionsRef}
                foldedOf={foldedOf}
                inkCache={inkCacheRef.current}
                strips={canvasStrips}
                orphanBlocks={orphanInkBlocks}
              />
            )}
          </div>

          {/* 小地图（D-R1-1 方位感：全画布内容聚落 + 视口框 + Home 回原点） */}
          <MinimapView
            content={minimap.content}
            viewport={minimap.viewport}
            bottom={composerHeight}
            onJump={glideViewTo}
            activeRegion={activeInkRegion}
            foldedOf={foldedOf}
            inkCache={inkCacheRef.current}
          />

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
