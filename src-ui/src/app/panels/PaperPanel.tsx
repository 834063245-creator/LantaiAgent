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
//     流区位置 = 工作区级持久化（state/paper-store，随会话快照落盘）。
//   - 新会话默认线性排比落位（贴上一个右侧）；拖流区边缘移动整个流区，
//     X 轴吸附网格（宽度+间距 = 2160）。
//   - 平移/缩放全局；虚拟化 = 数据全量、渲染只画视口内可见块。
//   - 活跃流区 = 活跃会话（sess store activeIdx 单一权威），点流区即切换。
// 流锚甲（D-R1-3）：流自视口下缘向上生长，输入条固定底部，最新块贴下缘。
// 钉住（D-R2-1）：按住块拖出流外松手即钉；按钮收回（D-R2-2）。
//
// 书眉：卷名 + 缩放读数 + 设置入口 + 关卷（回案卷首页）+ 窗口控制。
// 输入条：写 input-store（真相源），提交走 core.sendMessage()。

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import { resolveRenderer } from '../../composition/renderer-service';
import type { SourcedBlock } from '../../paper/block-model';
import {
  ANCHOR,
  identityView,
  layoutRegion,
  panBy,
  screenToWorld,
  viewForAnchor,
  wheelFactor,
  zoomAt,
} from '../../paper/canvas-math';
import { composerSubmitOnKey } from '../../paper/ime';
import {
  type BlockMeasureCache,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeightCached,
} from '../../paper/measure';
import { classifyDropZone, makeStrip, type PaperStrip, stashStripPositionAt } from '../../paper/selection';
import { defaultRegionFor, STREAM_REGION, type StreamRegionState, snapRegionX } from '../../paper/space';
import { type MessageTranslateCache, translateMessagesCached } from '../../paper/translate';
import {
  type FlowGeom,
  type PinnedGeom,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
} from '../../paper/virtualize';
import { useDockStore } from '../../state/dock-store';
import { getPaperStore, type PaperPinnedState } from '../../state/paper-store';
import { useUpdateStore } from '../../state/update-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
import { CommandRegistry } from '../../ui/command-registry';
import type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '../../ui/message-model';
import { useCoreStore } from '../chat/core-instance';
import { useShellStore } from '../shell-store';
import { WinControls } from '../WinControls';
import { ModeIndicator } from './ModeIndicator';
import { SpineRack } from './SpineRack';
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
}: {
  content: { x0: number; y0: number; x1: number; y1: number };
  viewport: { x0: number; y0: number; x1: number; y1: number };
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
    <div className="pp-minimap" title="小地图 · Home 键回原点">
      <div className="pp-mm-viewport" style={vp} />
    </div>
  );
}

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3） */
const GHOST_H = 32;
/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
const EMPTY_OPS: BlockOp[] = [];

/** 单会话（流区）的完整渲染态——派生计算的最小隔离单元：
 *  一个会话吐字只重算它自己的栈（"单流区更新=常数"铁律）。 */
interface RegionView {
  sessionId: string;
  sessionNum: number;
  label: string;
  anchor: StreamRegionState;
  blocks: SourcedBlock[];
  layout: Map<string, { x: number; y: number }>;
  flowGeom: FlowGeom[];
  pinnedGeom: PinnedGeom[];
  flowWindow: { first: number; lastExcl: number };
  visibleIds: Set<string>;
  seq: Map<string, string>;
  strips: PaperStrip[];
  pinned: PaperPinnedState;
  /** 流区内容顶（世界 y——最旧块顶） */
  regionTop: number;
  /** 流区内容底（世界 y = 锚点 y——最新块底边） */
  regionBottom: number;
  /** 流区容器高（世界单位，含头部留白） */
  regionHeight: number;
}

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

  /* 活跃流区镜像：paper-store.activeRegionId 跟随 sess activeIdx（单一权威），
   * setActiveRegion 引用短路——同值不触发订阅（不产生无谓自动保存）。 */
  useEffect(() => {
    if (!core) return;
    getPaperStore(core.panelId)
      .getState()
      .setActiveRegion(activeSessionId != null ? String(activeSessionId) : null);
  }, [core, activeSessionId]);

  /* Agent 运行态（停止按钮）：订阅活跃会话 exec.isRunning */
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!core || activeSessionId == null) {
      setRunning(false);
      return;
    }
    const exec = agentSessionState.getExec(core.panelId, activeSessionId);
    if (!exec) {
      setRunning(false);
      return;
    }
    setRunning(exec.isRunning);
    return exec.onChange(() => setRunning(exec.isRunning));
  }, [core, activeSessionId]);

  /* paper-store 订阅 tick：钉住/纸条/流区位置变更触发重渲染 + 防抖自动保存 */
  const [paperTick, setPaperTick] = useState(0);
  useEffect(() => {
    if (!core) return;
    const paper = getPaperStore(core.panelId);
    return paper.subscribe(() => {
      setPaperTick((t) => t + 1);
      const pp = useShellStore.getState().projectPath;
      if (pp) core.scheduleAutoSave(pp);
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

  /* 新会话默认线性排比落位（Stage-2 定案）：未落位的流区按序补默认位置并持久化。
   * ensureRegion 幂等——只补缺，不覆盖已摆放位置；落位变化随 paper-store
   * 订阅触发自动保存（位置随工作区走）。 */
  useEffect(() => {
    if (!core) return;
    const paper = getPaperStore(core.panelId).getState();
    sessions.forEach((s, i) => {
      const sid = String(s.id);
      if (!paper.getRegion(sid)) paper.ensureRegion(sid, defaultRegionFor(i));
    });
  }, [core, sessions]);

  const activeSessionKey = activeSessionId != null ? String(activeSessionId) : null;
  // paperTick 显式消费：订阅变化 = 重渲染重读
  void paperTick;

  /* 视口状态 */
  const [view, setView] = useState(identityView());
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  /* 初始视口：锚点对视口下缘（D-R1-3）。画布尺寸变化时保持锚点关系 */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
    setView((v) => ({ ...v, panX, panY }));
  }, [canvasSize.w, canvasSize.h]);

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
  const paperStoreRef = useRef(core ? getPaperStore(core.panelId) : null);
  paperStoreRef.current = core ? getPaperStore(core.panelId) : null;
  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，onBlockMouseDown 才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  const regionsRef = useRef<RegionView[]>([]);
  const blockSessionRef = useRef<Map<string, string>>(new Map());

  const regions: RegionView[] = useMemo(() => {
    // paperTick/measureTick 是显式失效信号：纸面状态（钉住/纸条/流区位置）或
    // 测量缓存清空后必须重算本 memo——void 引用使依赖声明与闭包语义一致。
    void paperTick;
    void measureTick;
    const paper = paperStoreRef.current?.getState() ?? null;
    const out: RegionView[] = [];
    const blockSession = new Map<string, string>();
    sessions.forEach((s, i) => {
      const sid = String(s.id);
      const msgs = regionMsgs[s.id]?.messages ?? [];
      const pinned = paper?.getPinned(sid) ?? {};
      const strips = paper?.getStrips(sid) ?? [];
      const persisted = paper?.getRegion(sid);
      const baseAnchor = persisted ?? defaultRegionFor(i);
      // 边缘拖动中：用拖动态锚点覆盖（块/纸条随流区整体平移）
      const dragging = edgeDragPos && edgeDragPos.sessionId === sid;
      const anchor: StreamRegionState = dragging
        ? { anchorX: edgeDragPos.x, anchorY: edgeDragPos.y, width: baseAnchor.width }
        : baseAnchor;

      let cache = translateCacheBySession.current.get(s.id) ?? null;
      const res = translateMessagesCached(msgs, pinned, cache);
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
        strips,
        pinned,
        regionTop,
        regionBottom,
        regionHeight: Math.max(0, regionBottom - regionTop) + 72,
      });
    });
    blockSessionRef.current = blockSession;
    return out;
  }, [sessions, regionMsgs, paperTick, viewRect, edgeDragPos, measureTick]);

  regionsRef.current = regions;

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

  /* 缩放：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!e.ctrlKey && t?.closest('pre, .pp-out')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

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
  }, [canvasSize.w, canvasSize.h]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // 空白处按下 → 开始平移（块/流区有自己的处理，不落到这里）
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pp-world')) {
      if (e.button !== 0) return;
      e.preventDefault();
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
    const up = () => setPanning(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [panning]);

  /* ── 拖块（D-R2-1 拖出钉住）：阈值即脱流 → 全程跟手 → 松手判位 ── */
  const dragRef = useRef<{
    id: string;
    sessionId: string;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    bw: number;
    offX: number;
    offY: number;
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
    if (sessionId == null) return;
    const region = regionsRef.current.find((r) => r.sessionId === sessionId);
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
    };
  }, []);

  const commitPinned = useCallback(
    (sessionId: string, blockId: string, pos: { x: number; y: number } | null) => {
      if (!core) return;
      getPaperStore(core.panelId).getState().setPinned(sessionId, blockId, pos);
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
          commitPinned(d.sessionId, d.id, { x: w.x - d.offX, y: w.y - d.offY });
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
      const region = regionsRef.current.find((r) => r.sessionId === d.sessionId);
      const bandCenter = region?.anchor.anchorX ?? 0;
      // 松手判位：落在来源流区窄带内且原为 flow → 回流（不钉）
      if (d.wasFlow && Math.abs(fx - bandCenter) <= ANCHOR.bandHalfWidth) {
        commitPinned(d.sessionId, d.id, null);
      } else {
        commitPinned(d.sessionId, d.id, { x: fx, y: fy });
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

  /* 收回/占位符点击恢复（即时手势，双向对称） */
  const onUnpin = useCallback(
    (sessionId: string, id: string) => {
      if (!core) return;
      getPaperStore(core.panelId).getState().setPinned(sessionId, id, null);
    },
    [core],
  );
  const onGhostClick = onUnpin;

  /* ── 流区激活（点流区背景 = 显式动作立即切）── */
  const activateRegion = useCallback(
    (sessionId: string) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => String(s.id) === sessionId);
      if (idx < 0) return;
      if (idx !== st.activeIdx) core.switchSession(idx);
      getPaperStore(core.panelId).getState().setActiveRegion(sessionId);
    },
    [core],
  );

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
      const paper = getPaperStore(core.panelId).getState();
      const cur = paper.getRegion(d.sessionId);
      const x = last && last.sessionId === d.sessionId ? last.x : snapRegionX(cur?.anchorX ?? d.ax);
      const y = last && last.sessionId === d.sessionId ? last.y : (cur?.anchorY ?? d.ay);
      paper.setRegion(d.sessionId, {
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

  /* ── 输入条：真相走 input-store，提交走 core.sendMessage（agent 层零改动）── */
  const [inputText, setInputText] = useState('');
  const slashQuery = useMemo(() => {
    const v = inputText;
    if (!v) return null;
    const last = v.lastIndexOf('/');
    if (last < 0) return null;
    if (last > 0 && v[last - 1] !== ' ' && v[last - 1] !== '\n') return null;
    return v.slice(last + 1);
  }, [inputText]);
  const slashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return CommandRegistry.instance
      .getAll()
      .filter((c) => c.shortcut.toLowerCase().includes(q) || c.label.toLowerCase().includes(q));
  }, [slashQuery]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }, []);
  useEffect(() => {
    void inputText;
    autoGrow();
  }, [inputText, autoGrow]);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ path: string; name: string; size: number }>>([]);
  useEffect(() => {
    if (!core) {
      setAttachedFiles([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    setAttachedFiles(input.getState().attachedFiles);
    const unsub = input.subscribe((s) => setAttachedFiles(s.attachedFiles));
    return () => unsub();
  }, [core]);
  const onAttach = useCallback(() => {
    void core?.openFilePicker();
  }, [core]);
  const onRemoveAttached = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedFile(idx);
    },
    [core],
  );
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const onSend = useCallback(async () => {
    const t = inputText.trim();
    if (!t || !core) return;
    const sess = getChatStore(core.panelId).sess.getState();
    if (sess.activeIdx < 0 || !sess.sessions[sess.activeIdx]) {
      setLocalNotice('当前没有活跃会话——请在设置中配置 API Key（书眉「设置」→ Provider）后保存，保存后即可直接使用。');
      return;
    }
    setLocalNotice(null);
    getChatStore(core.panelId).input.getState().setInputText(t);
    setInputText('');
    await core.sendMessage();
  }, [inputText, core]);

  /* 小地图（D-R1-1 方位感：全画布内容聚落 + 视口框）——跨流区包围盒 */
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
      for (const s of r.strips) {
        x0 = Math.min(x0, s.x);
        y0 = Math.min(y0, s.y);
        x1 = Math.max(x1, s.x + s.w);
        y1 = Math.max(y1, s.y + 96);
      }
    }
    if (!Number.isFinite(x0)) {
      x0 = -400;
      x1 = 400;
      y0 = -200;
      y1 = 0;
    }
    return { content: { x0, y0, x1, y1 }, viewport: viewRect };
  }, [regions, viewRect]);

  /* ── 抽纸条交互（A 拖拽做正 + B 选中浮钮）──
   * 一纸多卷：纸条按来源会话归属（data-session-id），落点相对来源流区 */
  const stripDragRef = useRef<{
    id: string;
    sessionId: string;
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
      const strip = makeStrip(trimmed, x, y, 480, messageId ? { messageId } : undefined);
      getPaperStore(core.panelId).getState().addStrip(sessionId, strip);
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
    const strips = region?.strips ?? [];
    const centerX = region?.anchor.anchorX ?? 0;
    const pos = stashStripPositionAt(worldMidY, strips, ANCHOR.bandHalfWidth, centerX);
    spawnStrip(selAnchor.sessionId, selAnchor.text, selAnchor.messageId, pos.x, pos.y);
    window.getSelection()?.removeAllRanges();
    setSelAnchor(null);
  }, [selAnchor, view, spawnStrip]);

  /* 拖纸条：与拖块同款阈值手势——超阈才跟动，松手一次性写 paper-store */
  const [dragStripId, setDragStripId] = useState<string | null>(null);
  const [stripDragPos, setStripDragPos] = useState<{ x: number; y: number } | null>(null);
  const onStripMouseDown = useCallback(
    (e: React.MouseEvent, sessionId: string, s: PaperStrip) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      stripDragRef.current = {
        id: s.id,
        sessionId,
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
      getPaperStore(core.panelId)
        .getState()
        .moveStrip(d.sessionId, d.id, w.x - d.offX, w.y - d.offY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view, core]);

  const onRemoveStrip = useCallback(
    (sessionId: string, id: string) => {
      if (!core) return;
      getPaperStore(core.panelId).getState().removeStrip(sessionId, id);
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
  const totalPinned = regions.reduce((n, r) => n + Object.keys(r.pinned).length, 0);
  const totalStrips = regions.reduce((n, r) => n + r.strips.length, 0);

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

  return (
    <div className="pp-root">
      <div className="pp-topbar">
        <span className="pp-title">画布</span>
        <span className="pp-tag">兰台 · CANVAS</span>
        <span className="pp-zoom">
          {zoomLabel} · {totalBlocks} 块 · 已钉 {totalPinned} · 纸条 {totalStrips}
        </span>
        <StatusLine />
        <ModeIndicator />
        <button
          type="button"
          className={`pp-settings${updateAvailable ? ' has-update' : ''}`}
          title={updateAvailable && updateVersion ? `设置 (Ctrl+,) · 新版本 ${updateVersion} 可用` : '设置 (Ctrl+,)'}
          onClick={() => useDockStore.getState().togglePanel('settings')}
        >
          设置
        </button>
        <button type="button" className="pp-close" onClick={() => closePanel('paper')}>
          回首页
        </button>
        <WinControls />
      </div>

      {localNotice && (
        <div className="pp-local-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* B 选中浮钮：块内有选区时现身（锚点随视口现算），点击成条（落来源流区右侧空地） */}
      {selAnchor && !ghost && fabPos && (
        <button type="button" className="pp-strip-fab" style={fabPos} onClick={onStripButton}>
          抽纸条
        </button>
      )}

      {/* 书脊列（多卷管理：另起一卷 + 卷目目录——Stage-2 最小侧边栏） */}
      <SpineRack core={core} />

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
                <div className="pp-region-label" title={`案卷 ${r.sessionNum}${isActive ? ' · 活跃' : ' · 点击激活'}`}>
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

          {/* 纸条（V3a：拷贝语义快照，可拖动、可销毁；按来源流区渲染） */}
          {regions.map((r) =>
            r.strips.map((s) => {
              const stripDragged = dragStripId === s.id;
              const stripPos = stripDragged && stripDragPos ? stripDragPos : { x: s.x, y: s.y };
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: 纸条拖拽面（D-R2-1 手势族）
                <div
                  key={s.id}
                  className={`pp-strip${stripDragged ? ' pp-dragging' : ''}`}
                  style={{ left: stripPos.x, top: stripPos.y, width: s.w }}
                  onMouseDown={(e) => onStripMouseDown(e, r.sessionId, s)}
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
                        onRemoveStrip(r.sessionId, s.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="pp-strip-body">{s.text}</div>
                </div>
              );
            }),
          )}

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
                      onUnpin={(id) => onUnpin(r.sessionId, id)}
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
                    onClick={() => onGhostClick(r.sessionId, b.id)}
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
                      onUnpin={(id) => onUnpin(r.sessionId, id)}
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
      <MinimapView content={minimap.content} viewport={minimap.viewport} />

      <div className="pp-composer">
        {slashCommands.length > 0 && (
          <div className="pp-slash">
            {slashCommands.map((c) => (
              <button key={c.id} type="button" className="pp-slash-item" onClick={() => core?.executeCommand(c)}>
                <span className="pp-slash-shortcut">{c.shortcut}</span>
                <span className="pp-slash-label">{c.label}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="pp-attach"
          title="拾遗——附文件入卷"
          aria-label="拾遗：附加文件"
          onClick={onAttach}
        >
          夹
        </button>
        {attachedFiles.length > 0 && (
          <div className="pp-attach-list">
            {attachedFiles.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className="pp-attach-chip"
                title={`${f.path}（点击移除）`}
                onClick={() => onRemoveAttached(i)}
              >
                {f.name} ✕
              </button>
            ))}
            {attachedFiles.length > 3 && <span className="pp-attach-count">共 {attachedFiles.length} 件</span>}
          </div>
        )}
        <textarea
          ref={composerRef}
          rows={1}
          value={inputText}
          placeholder="拟文…（Enter 发送 · Shift+Enter 换行 · ↑ 取历史；拖住任意块可移出钉住；拖流区边缘可移动流区）"
          onChange={(e) => {
            setInputText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing)) {
              e.preventDefault();
              onSend();
              return;
            }
            if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              const atFirstLine = el.selectionStart === 0 || !el.value.includes('\n');
              const history = core ? getChatStore(core.panelId).input.getState().inputHistory : [];
              if (atFirstLine && history.length > 0) {
                e.preventDefault();
                const next = history[history.length - 1] ?? '';
                setInputText(next);
                requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
              }
            }
          }}
        />
        {running && (
          <button
            type="button"
            className="pp-stop"
            title="停止当前回合（级联子 Agent）"
            aria-label="停止"
            onClick={() => core?.abort()}
          >
            停
          </button>
        )}
        <button type="button" onClick={onSend}>
          拟文
        </button>
      </div>
    </div>
  );
}
