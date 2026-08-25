// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel — 纸视图壳（paper-shell 走查弹长成的主界面，V5 拆除后唯一视图）。
//
// 挂法：组合层贡献（paper/paper-plugin.ts：side:null 全屏，unmountOnClose）。
// 数据：真实会话消息（msgStoreForActive(core.panelId)——不 mock，穿全层：
//   ChatMessage[] → paper/translate 转译 → SourcedBlock[] → 注疏渲染）。
// 流锚甲（D-R1-3）：流自视口下缘向上生长，输入条固定底部，最新块贴下缘。
// 无限画布（D-R1-1）：平移/缩放 + 原点十字方位感。
// 钉住（D-R2-1）：按住块拖出流外松手即钉；按钮收回（D-R2-2）。
//
// 书眉（V5 拆除后）：卷名 + 缩放读数 + 设置入口 + 关卷（回案卷首页）+
// 窗口控制（decorations:false 的标题栏职责自 CommandBar 迁来）。
//
// 输入条：写 input-store（真相源），提交走 core.sendMessage()
// ——agent 层零改动，消息追加后经 version 订阅自动重转译。

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import { resolveRenderer } from '../../composition/renderer-service';
import type { SourcedBlock } from '../../paper/block-model';
import {
  ANCHOR,
  identityView,
  layoutFlow,
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
import { classifyDropZone, makeStrip, type PaperStrip, stashStripPosition } from '../../paper/selection';
import { type MessageTranslateCache, translateMessagesCached } from '../../paper/translate';
import {
  type FlowGeom,
  type PinnedGeom,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
} from '../../paper/virtualize';
import { useDockStore } from '../../state/dock-store';
import { getPaperStore } from '../../state/paper-store';
import { useUpdateStore } from '../../state/update-store';
import { getChatStore, msgStoreForActive } from '../../ui/chat-store';
import { CommandRegistry } from '../../ui/command-registry';
import type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '../../ui/message-model';
import { useCoreStore } from '../chat/core-instance';
import { useShellStore } from '../shell-store';
import { WinControls } from '../WinControls';
import { ModeIndicator } from './ModeIndicator';
import { SpineRack } from './SpineRack';
import { StatusLine } from './StatusLine';
import './PaperPanel.css';

/* ── 块高测量（V3a：走查弹的估算+实测反馈环已拆，真测量走
 *    paper/measure——@chenglou/pretext Canvas measureText，不触发 DOM 重排）── */

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

/** 灰框块渲染器（V3b：体渲染经第五贡献通道解析——ctx.renderers） */

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
  /** 拖拽手柄（文类签 .pp-kind）——V3a 手势分工：签=整块拖出（D-R2-1），
   * 文本区=原生选择（待定 #10 抽纸条的前提：选中文字拖离流出纸条）
   * 签名带 block：调用方直接传稳定 onBlockMouseDown（memo 友好——不逐帧重建闭包） */
  onDragHandleMouseDown: (e: React.MouseEvent, block: SourcedBlock) => void;
}) {
  const p = block.payload;
  // 体渲染器：注册表按 kind 解析（内置注疏行 + 插件贡献——后注册胜）；
  // 无服务/无行时直渲文本（纸壳永不裸奔的兜底）。
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

/** 小地图（D-R1-1 方位感件——内容包围盒 + 视口框投影，点击跳转中心） */
function MinimapView({
  content,
  viewport,
}: {
  content: { x0: number; y0: number; x1: number; y1: number };
  viewport: { x0: number; y0: number; x1: number; y1: number };
}) {
  const W = 128;
  const H = 96;
  // 内容包围盒 → 缩略图坐标（等比缩放，居中，留 4px 边距）
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
  // 内容流带（窄带投影——聚落感）
  const band = {
    left: toMap(-ANCHOR.bandHalfWidth, content.y0).left,
    top: toMap(0, content.y0).top,
    width: Math.max(2, ANCHOR.bandHalfWidth * 2 * scale),
    height: Math.max(2, (content.y1 - content.y0) * scale),
  };
  return (
    <div className="pp-minimap" title="小地图 · Home 键回原点">
      <div className="pp-mm-band" style={band} />
      <div className="pp-mm-viewport" style={vp} />
    </div>
  );
}

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3） */
const GHOST_H = 32;
/** 纸条高度（抽纸条默认块高——同族灰框结构高度） */
const STRIP_H = 96;
/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
const EMPTY_PINNED: Record<string, { x: number; y: number }> = {};
const EMPTY_STRIPS: PaperStrip[] = [];
const EMPTY_OPS: BlockOp[] = [];

/** 按点是否落在选区几何矩形内（±4px 容差盖住行间边缘）。
 *  A2「拎起」命中判据——旧 isPointInRange(target, 0) 对单元素选区恒 false
 *  （元素 offset 0 边界点在 range 之前），主设计路径大面积失效；按点在
 *  选区矩形内才是「按在选区上」的本义。 */
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

  /* 真实消息（穿全层第一段：消息 store → 转译）。
   * tick 是重转译触发器：消息原位变更时 messages 引用不变（touchMessage 语义），
   * version bump / 会话切换 / 钉位变化都走 tick+1。 */
  const [msgState, setMsgState] = useState<{
    messages: readonly import('../../ui/message-model').ChatMessage[];
    tick: number;
  }>({ messages: [], tick: 0 });

  /* 活跃会话 id（paper-store 按会话隔离钉住/纸条） */
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  /* Agent 运行态（停止按钮）：exec store 订阅——运行中才显示「停」。
   * 照 SpineRack 模式：agentSessionState.getExec + exec.onChange（施工单 #4）。 */
  const [running, setRunning] = useState(false);
  /* paper-store 订阅 tick：钉住/纸条变更触发本组件重渲染 */
  const [paperTick, setPaperTick] = useState(0);

  const syncMessages = useCallback(() => {
    if (!core) return;
    const sess = getChatStore(core.panelId).sess.getState();
    const sid = sess.sessions[sess.activeIdx]?.id ?? null;
    setActiveSessionId((prev) => (prev === sid ? prev : sid));
    const store = msgStoreForActive(core.panelId);
    if (!store) {
      setMsgState((s) => (s.messages.length === 0 ? s : { messages: [], tick: s.tick + 1 }));
      return;
    }
    const st = store.getState();
    setMsgState((s) => ({ messages: st.messages, tick: s.tick + 1 }));
  }, [core]);

  useEffect(() => {
    if (!core) return;
    syncMessages();
    // 订阅链：① 直订活跃会话的消息 store（流式 part.text += chunk + touchMessage →
    // version bump → syncMessages 重转译）；② sess 变化（会话切换）→ 重解析活跃
    // store 并重订（msgStoreForActive 换实例）。
    let unsub: (() => void) | undefined;
    const resub = () => {
      unsub?.();
      const store = msgStoreForActive(core.panelId);
      unsub = store?.subscribe(syncMessages);
      syncMessages();
    };
    const sessStore = getChatStore(core.panelId).sess;
    const unSess = sessStore.subscribe(resub);
    resub();
    return () => {
      unSess();
      unsub?.();
    };
  }, [core, syncMessages]);

  /* paper-store 响应式订阅：钉住/纸条变化不再需要手动 bump 消息 tick；
   * 纸面状态变化同时触发会话防抖自动保存（摆放落盘不依赖「恰好来了条新消息」） */
  useEffect(() => {
    if (!core) return;
    const paper = getPaperStore(core.panelId);
    return paper.subscribe(() => {
      setPaperTick((t) => t + 1);
      const pp = useShellStore.getState().projectPath;
      if (pp) core.scheduleAutoSave(pp);
    });
  }, [core]);

  /* Agent 运行态（停止按钮）：订阅活跃会话 exec.isRunning。
   * 照 SpineRack：agentSessionState.getExec + exec.onChange（施工单 #4）。 */
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

  const paperStore = core ? getPaperStore(core.panelId) : null;
  const sessionKey = activeSessionId != null ? String(activeSessionId) : null;
  // paperTick 显式消费：订阅 tick 变化 = store 变化 = 本组件重渲染重读
  void paperTick;

  /* 性能专项第一刀缓存（流式增量）：
   *  - translateCache：按消息引用增量转译（流式只重译最后一条消息的块）
   *  - measureCache：按块 id + 内容签名记忆高度（签名未变零重测）
   *  - opsCache：按块 id 记忆消息操作数组（memo 友好——未变块 ops 引用稳定）
   * 会话切换时三缓存一并重置，防跨卷串味/无界增长。 */
  const translateCacheRef = useRef<MessageTranslateCache | null>(null);
  const measureCacheRef = useRef<BlockMeasureCache>(createBlockMeasureCache());
  const opsCacheRef = useRef<Map<string, { msg: ChatMessage; ops: BlockOp[] }>>(new Map());
  const lastSessionKeyRef = useRef<string | null>(null);
  if (lastSessionKeyRef.current !== sessionKey) {
    lastSessionKeyRef.current = sessionKey;
    translateCacheRef.current = null;
    measureCacheRef.current = createBlockMeasureCache();
    opsCacheRef.current = new Map();
  }
  const pinnedRecord = paperStore && sessionKey ? paperStore.getState().getPinned(sessionKey) : EMPTY_PINNED;
  const strips = paperStore && sessionKey ? paperStore.getState().getStrips(sessionKey) : EMPTY_STRIPS;

  /* 转译（穿全层第二段）——msgState.tick 驱动重算；
   * pinnedRecord 来自 paper-store，钉住变化经订阅触发重转译。
   * 增量缓存：消息引用未变（touchMessage 只浅拷贝被触碰那条）→ 块对象引用稳定，
   * 未变块在流式/平移中跳过重渲染（React.memo(BlockView) 前提）。 */
  const blocks = useMemo(() => {
    const res = translateMessagesCached(msgState.messages, pinnedRecord, translateCacheRef.current);
    translateCacheRef.current = res.cache;
    return res.blocks;
  }, [msgState, pinnedRecord]);

  /* 消息操作（施工单 #5）：按来源消息构造 user 编辑/重发、assistant 重试、全部抄录。
   * ops 按块 id 记忆（opsCacheRef）——点击时经 messagesRef 取最新消息（流式中
   * 缓存块也能抄到最新文本），memo 友好的稳定 ops 引用由此成立。 */
  const messagesRef = useRef<readonly ChatMessage[]>([]);
  messagesRef.current = msgState.messages;
  const msgOpsFor = useCallback(
    (msg: ChatMessage): BlockOp[] => {
      if (!core) return [];
      const latest = (): ChatMessage => messagesRef.current.find((m) => m._id === msg._id) ?? msg;
      const latestMsg = latest();
      const ops: BlockOp[] = [];
      if (msg.role === 'user') {
        const latestUser = (): UserMessage => {
          const m = messagesRef.current.find((x) => x._id === msg._id);
          return m && m.role === 'user' ? m : msg;
        };
        ops.push({ key: 'edit', label: '改', run: () => core.editUserMessage(latestUser()) });
        ops.push({ key: 'resend', label: '重发', run: () => core.resendUserMessage(latestUser()) });
      } else if (msg.role === 'assistant') {
        const latestAsst = (): AssistantMessage => {
          const m = messagesRef.current.find((x) => x._id === msg._id);
          return m && m.role === 'assistant' ? m : msg;
        };
        ops.push({ key: 'retry', label: '重试', run: () => core.retryAssistant(latestAsst()) });
      }
      const text = messageCopyText(latestMsg);
      if (text.trim()) ops.push({ key: 'copy', label: '抄', run: () => core.copyText(messageCopyText(latest())) });
      return ops;
    },
    [core],
  );
  /* ops 按块 id 缓存：消息引用未变 → 复用同一 ops 数组（memo 生效）；
   * 消息引用变（touchMessage 新拷贝）→ 该块重算 ops，其余块引用稳定。 */
  const opsByBlock = useMemo(() => {
    const map = new Map<string, BlockOp[]>();
    if (!core) return map;
    const byId = new Map<string, ChatMessage>();
    for (const m of msgState.messages) byId.set(m._id, m);
    for (const b of blocks) {
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
    return map;
  }, [blocks, msgState.messages, core, msgOpsFor]);

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
    // 流锚：世界 (0,0)（最新块底边）对到屏幕 (w/2, h - margin)
    const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
    setView((v) => ({ ...v, panX, panY }));
    // 仅在画布首次出现/尺寸变化时对锚（用户平移后不打扰——走查弹简化：
    // 尺寸变化即回锚，可接受）
  }, [canvasSize.w, canvasSize.h]);

  /* 流布局（穿全层第三段：块 → 世界坐标）。
   * 走完整序列栈：flow 块占真测量高度（paper/measure），pinned 块在原序位
   * 留占位符（ghost）——设计文档 §2.3「原位置留占位符」+ D-R2-2 的可验证基础。
   * V3a：实测反馈环已拆——测量是唯一真相（chrome 常量镜像 CSS，改样式两处同步）。 */
  const stack = useMemo(
    () =>
      blocks.map((b) => ({
        id: b.id,
        h: b.state === 'flow' ? measureBlockHeightCached(b, measureCacheRef.current) : GHOST_H,
        w: b.w,
        kind: b.kind,
      })),
    [blocks],
  );
  const layout = useMemo(() => layoutFlow(stack), [stack]);

  /* 字体加载后重测：webfont 到位前 canvas 量的是回退字体宽度，
   * document.fonts.ready 时清测量缓存重转译一轮（一次性布局收敛）。 */
  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => {
      if (!alive) return;
      clearPaperMeasureCache();
      setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 视口虚拟化（V3a：数据全量、渲染窗口化——设计文档 §2.3）。
   * flow 窗口二分 + pinned 矩形相交；overscan 缓冲一屏，平移不逐帧抖。 */
  const OVERSCAN = 200;
  const flowGeom = useMemo(
    () =>
      stack.map((s) => ({
        id: s.id,
        y: layout.get(s.id)?.y ?? 0,
        h: s.h,
        x: layout.get(s.id)?.x ?? 0,
        w: s.w,
      })) satisfies FlowGeom[],
    [stack, layout],
  );
  const pinnedGeom = useMemo(
    () =>
      blocks
        .filter((b) => b.state === 'pinned')
        .map((b) => ({
          id: b.id,
          x: b.x,
          y: b.y,
          w: b.w,
          h: measureBlockHeightCached(b, measureCacheRef.current),
        })) satisfies PinnedGeom[],
    [blocks],
  );
  const viewRect = useMemo(
    () => viewportWorldRect(view, canvasSize.w, canvasSize.h),
    [view, canvasSize.w, canvasSize.h],
  );
  const flowWindow = useMemo(() => visibleFlowWindow(flowGeom, viewRect, OVERSCAN), [flowGeom, viewRect]);
  const visiblePinned = useMemo(
    () => new Set(visiblePinnedIds(pinnedGeom, viewRect, OVERSCAN)),
    [pinnedGeom, viewRect],
  );
  const visibleIds = useMemo(() => {
    const s = new Set(visiblePinned);
    for (let i = flowWindow.first; i < flowWindow.lastExcl; i++) s.add(flowGeom[i].id);
    return s;
  }, [flowWindow, flowGeom, visiblePinned]);

  /* ── 交互：平移 / 缩放 / 拖块 ── */
  const panningRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);

  /* 缩放：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      // 块内滚动区让路（工具输出/程文/抄录 overflow:auto）：普通滚轮先滚内容，
      // 不劫持成缩放；Ctrl+滚轮（触控板捏合同款信号）仍是全局缩放——平台惯例分流。
      const t = e.target instanceof Element ? e.target : null;
      if (!e.ctrlKey && t?.closest('pre, .pp-out')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  /* 回原点快捷键（D-R1-1 方位感：无限画布 + 回原点快捷键）。
   * Home：视口回锚点几何（最新块贴下缘）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Home' || e.defaultPrevented) return;
      // 输入条聚焦时不抢 Home（文本编辑语义优先——IME/光标行为不受干扰）
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
    // 空白处按下 → 开始平移（块/占位符有自己的处理，不落到这里）
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pp-world')) {
      if (e.button !== 0) return; // 平移专属左键——右键留上下文菜单、中键留 autoscroll
      // 不启动原生扫选（画布 user-select:none 是第一道，这里掐掉默认动作：
      // 幻影扫选曾把平移手势喂进抽纸条通道——平移与选择从此分家）
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

  /* 拖块（D-R2-1 拖出钉住）：阈值即脱流（钉在当前渲染位，无瞬跳）→
   * 全程跟手（dragPos 覆盖渲染，不逐帧重转译）→ 松手判位：带外=钉住落位，
   * 带内且原为 flow=回流（占位符处复活）。 */
  const dragRef = useRef<{
    id: string;
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

  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，onBlockMouseDown 才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const onBlockMouseDown = useCallback((e: React.MouseEvent, block: SourcedBlock) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 不触发画布平移
    e.preventDefault(); // 手柄拖拽不启动原生文本选择（文本区选择不经过这里）
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const v = viewRef.current;
    const lay = layoutRef.current;
    const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
    // 偏移基于「当前渲染位」：flow 块取流布局位（block.x 是默认值 0，非渲染位）
    const rx = block.state === 'flow' ? (lay.get(block.id)?.x ?? block.x) : block.x;
    const ry = block.state === 'flow' ? (lay.get(block.id)?.y ?? block.y) : block.y;
    dragRef.current = {
      id: block.id,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      wasFlow: block.state === 'flow',
      bw: block.w,
      offX: w.x - rx,
      offY: w.y - ry,
    };
  }, []);

  /* 钉住/收回写入 paper-store（辅助函数——必须先于拖块 effect 定义，
   * 并进其依赖：sessionKey 切卷变化时拖拽监听需重建闭包，否则写错卷） */
  const commitPinned = useCallback(
    (blockId: string, pos: { x: number; y: number } | null) => {
      if (!core || sessionKey == null) return;
      getPaperStore(core.panelId).getState().setPinned(sessionKey, blockId, pos);
    },
    [core, sessionKey],
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
          // 脱流：钉在当前渲染位（视觉无跳变），流内该序位出现占位符
          commitPinned(d.id, { x: w.x - d.offX, y: w.y - d.offY });
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
      // 松手判位：流锚窄带外 → 钉住落位；带内且原为 flow → 回流（不钉）
      if (d.wasFlow && Math.abs(fx + d.bw / 2) <= ANCHOR.bandHalfWidth) {
        commitPinned(d.id, null);
      } else {
        commitPinned(d.id, { x: fx, y: fy });
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

  /* 收回（D-R2-2）：直接收回——占位符点击恢复已是即时手势（双向对称），
   * 原生 confirm 与纸面语言断层（2026-08 UI 大清扫移除；收回非破坏性，
   * 再拖出即可复钉）。 */
  const onUnpin = useCallback(
    (id: string) => {
      if (!core || sessionKey == null) return;
      getPaperStore(core.panelId).getState().setPinned(sessionKey, id, null);
    },
    [core, sessionKey],
  );

  /* 占位符点击恢复（原型同款等价手势，即时——R2 注记「走查弹验证哪种顺手」） */
  const onGhostClick = useCallback(
    (id: string) => {
      if (!core || sessionKey == null) return;
      getPaperStore(core.panelId).getState().setPinned(sessionKey, id, null);
    },
    [core, sessionKey],
  );

  /* ── 输入条：真相走 input-store，提交走 core.sendMessage（agent 层零改动）──
   * 多行 textarea + 输入历史（↑ 取上一条——input-store 的 inputHistory 由
   * chat-core sendMessage 落账，此处只读；光标在首行且非多行编辑态才拦）。 */
  const [inputText, setInputText] = useState('');
  /* 斜杠命令补全（施工单 #7）：行首/空格后 '/' 时弹可用命令列表（点击执行）。
   * 命令解析与执行仍在 chat-core（sendMessage / executeCommand），这里只补发现性。 */
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
  /* textarea 自适应高（min 1 行 max ~6 行）；发送清空后回 1 行 */
  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }, []);
  useEffect(() => {
    void inputText; // 触发依赖（输入变化即重算高度——CommandPalette void tick 同款惯例）
    autoGrow();
  }, [inputText, autoGrow]);
  /* 待发附件（C10 拾遗）：订阅 input-store.attachedFiles——拾遗按钮拾取、
   * 发送时随来文入卷，可逐个移除。 */
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
  /* 冷启动死路防护：无活跃会话时 chat-core 的 addNotice 会被
   * _resolveSessionTarget 丢弃（返回 null）——纸面零反馈 = 假阴性。
   * 发送前置检查：无会话 → 纸面本地提示块（不入消息 store，UI 层直示）。 */
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

  /* 小地图（D-R1-1 方位感：内容聚落 + 视口框）——世界包围盒投影到 128×96 缩略。
   * 全量块几何（不用可见窗口——地图的意义就是看见视口外）。 */
  const minimap = useMemo(() => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const g of flowGeom) {
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w);
      y1 = Math.max(y1, g.y + g.h);
    }
    for (const g of pinnedGeom) {
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w);
      y1 = Math.max(y1, g.y + g.h);
    }
    for (const s of strips) {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w);
      y1 = Math.max(y1, s.y + STRIP_H);
    }
    if (!Number.isFinite(x0)) {
      x0 = -400;
      x1 = 400;
      y0 = -200;
      y1 = 0;
    }
    // 视口框
    const vp = viewportWorldRect(view, canvasSize.w, canvasSize.h);
    return { content: { x0, y0, x1, y1 }, viewport: vp };
  }, [flowGeom, pinnedGeom, strips, view, canvasSize.w, canvasSize.h]);

  /* ── 抽纸条交互（收尾批 II 2026-08-24：A 拖拽做正 + B 选中浮钮）──
   * 三条成条路径，共用「带外判据 + 幽灵预览」：
   *   A1 一步拖：按下→拖选文字→继续拖出流带→带外松手成条。
   *      拖选中途光标出带即幽灵亮起（隐形悬崖消除——带边界可视）。
   *   A2 两步拎起：按住已有选区拖动 = 拎起（拦截原生文字拖放，
   *      选区高亮暂清、幽灵跟光标）；带外松手成条，带内松手恢复选区无感。
   *   B 浮钮：块内有选区时选区旁浮「抽纸条」钮，点击落流带右侧空地
   *      （stashStripPosition 自动找空档，不压已有纸条）。
   * 通道纪律：拖块/拖纸条/画布平移让路；书眉/composer 选区不抢。 */
  const stripDragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    moved: boolean;
    offX: number;
    offY: number;
  } | null>(null);
  /* 拎起态快照：A2 清选区高亮前存住文本+来源，松手据此成条/恢复 */
  const liftRef = useRef<{ text: string; messageId: string | undefined; rect: DOMRect | null } | null>(null);
  /* 幽灵预览：{ 世界坐标, 分区 }——null = 不显示 */
  const [ghost, setGhost] = useState<{ x: number; y: number; zone: 'flow' | 'strip' } | null>(null);
  /* A1 拖选路径的按下起点（判拖 + 出带时机 + 起点归属守卫：blockEl 非空才许进成条判定） */
  const pressStartRef = useRef<{ sx: number; sy: number; blockEl: Element | null } | null>(null);

  /** 成条动作（三路径共用）：文本 + 来源 + 世界落点 → paper-store。 */
  const spawnStrip = useCallback(
    (text: string, messageId: string | undefined, x: number, y: number) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!core || sessionKey == null) return;
      const strip = makeStrip(trimmed, x, y, 480, messageId ? { messageId } : undefined);
      getPaperStore(core.panelId).getState().addStrip(sessionKey, strip);
    },
    [core, sessionKey],
  );

  /** 屏幕坐标 → 世界坐标（画布 rect 内换算；画布外返回 null）。 */
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

  /** 选区快照（块内才认）：{ 文本, 来源块 messageId } | null。 */
  const snapshotBlockSelection = useCallback((): {
    text: string;
    messageId: string | undefined;
  } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
    const blockEl = anchorEl?.closest('.pp-block') ?? null;
    if (!blockEl) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    return { text, messageId: blockEl.getAttribute('data-message-id') ?? undefined };
  }, []);

  /* ghost 的 ref 镜像（mouseup 闭包读最新值，不依赖 effect 重挂） */
  const ghostRef = useRef<{ x: number; y: number; zone: 'flow' | 'strip' } | null>(null);
  useEffect(() => {
    ghostRef.current = ghost;
  }, [ghost]);

  /* 带内松手恢复选区（A2）：原选区包围盒首末行端点做 caret 探测重建近似 range。
   * 旧实现「probe 找节点后整节全选」会把一句话恢复成整段高亮；端点定位更贴近
   * 原选区。探测失败/端点非法即放弃——无感路径，用户预期本就是「没拎起来」。 */
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
      return; // 端点不可连成 range（跨树等）——放弃恢复
    }
    if (range.collapsed) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  /* ── A：拖拽路径（mousedown/mousemove/mouseup 全局通道）──
   * 起点归属守卫：只有按下起点落在 .pp-block 内的手势才可进入成条判定——
   * 否则书脊/topbar/画布平移起手的拖拽会借道活选区误成条（通道串台）。 */
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      pressStartRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        blockEl: e.target instanceof Element ? e.target.closest('.pp-block') : null,
      };
      // 拖块/拖纸条通道让路
      if (dragRef.current || stripDragRef.current) {
        liftRef.current = null;
        return;
      }
      // A2 拎起判定：已有块内选区 + 按点落在选区几何矩形内
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const range = sel.getRangeAt(0);
      if (!pointInSelectionRects(range, e.clientX, e.clientY)) return;
      // 拎起：清视觉高亮（存快照），进入幽灵预览态
      liftRef.current = {
        text: snap.text,
        messageId: snap.messageId,
        rect: range.getBoundingClientRect(),
      };
      sel.removeAllRanges();
      e.preventDefault(); // 拦截原生文字拖放/再选
    };

    const move = (e: MouseEvent) => {
      const w = toWorldInCanvas(e.clientX, e.clientY);
      if (!w) {
        setGhost(null);
        return;
      }
      const zone = classifyDropZone(w.x, ANCHOR.bandHalfWidth);
      // A2 拎起中：幽灵全程跟光标（带内灰/带外亮）
      if (liftRef.current) {
        setGhost({ x: w.x, y: w.y, zone });
        return;
      }
      // A1 拖选中：起点须在块内（守卫见上）+ 位移过阈值 + 当前有块内选区 +
      // 光标已出带 → 幽灵亮起；回带即灭（与 up 的二次校验对称，不留假「松手成条」）
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
      // A2 拎起松手：带外成条；带内恢复选区（无感）
      const lift = liftRef.current;
      liftRef.current = null;
      if (lift) {
        const w = toWorldInCanvas(e.clientX, e.clientY);
        if (w && classifyDropZone(w.x, ANCHOR.bandHalfWidth) === 'strip') {
          spawnStrip(lift.text, lift.messageId, w.x, w.y);
        } else if (lift.rect) {
          restoreSelectionByRect(lift.rect);
        }
        return;
      }
      // A1 拖选松手（起点在块内 + 幽灵曾亮起 = 光标曾出带）：带外成条
      if (g?.zone !== 'strip' || !start?.blockEl) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const w = toWorldInCanvas(e.clientX, e.clientY);
      if (!w || classifyDropZone(w.x, ANCHOR.bandHalfWidth) !== 'strip') return;
      window.getSelection()?.removeAllRanges();
      spawnStrip(snap.text, snap.messageId, w.x, w.y);
    };

    window.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [spawnStrip, snapshotBlockSelection, toWorldInCanvas, restoreSelectionByRect]);

  /* ── B：选中浮钮（selectionchange 监听——选区出现在块内时浮钮现身）──
   * 存 live Range 快照而非屏幕坐标：平移/缩放/流布局变化都会触发本组件重渲染，
   * 浮钮锚点每次渲染现算（旧实现坐标钉死，视口一动钮就与选区脱节）。 */
  const [selAnchor, setSelAnchor] = useState<{
    range: Range;
    text: string;
    messageId: string | undefined;
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
      setSelAnchor({ range: range.cloneRange(), text: snap.text, messageId: snap.messageId });
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [snapshotBlockSelection]);

  /* 浮钮锚点（渲染期现算）：Range 已随源节点卸载失效（虚拟化出窗/重转译替换）
   * 时 rect 归零 → 收钮。 */
  let fabPos: { left: number; top: number } | null = null;
  if (selAnchor) {
    const fr = selAnchor.range.getBoundingClientRect();
    if (fr.width > 0) fabPos = { left: fr.right + 8, top: fr.top - 30 };
  }

  /* 浮钮点击：落流带右侧空地（stashStripPosition 找空档），清选区 */
  const onStripButton = useCallback(() => {
    if (!selAnchor) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const selRect = selAnchor.range.getBoundingClientRect();
    if (!rect || selRect.width === 0) {
      setSelAnchor(null);
      return;
    }
    // 选区中点的世界 y（x 固定 0——只用纵坐标换算）
    const worldMidY = screenToWorld(view, 0, selRect.top + selRect.height / 2 - rect.top).y;
    const pos = stashStripPosition(worldMidY, strips, ANCHOR.bandHalfWidth);
    spawnStrip(selAnchor.text, selAnchor.messageId, pos.x, pos.y);
    window.getSelection()?.removeAllRanges();
    setSelAnchor(null);
  }, [selAnchor, view, strips, spawnStrip]);

  /* 拖纸条：与拖块同款阈值手势（DRAG_THRESHOLD）——超阈才跟动，过程渲染走本地
   * stripDragPos，松手一次性写 paper-store（切卷/持久化由此承接）。旧实现逐帧
   * 写 store：点击即落账 + autosave 抖动 + 每帧全量重渲染；两套拖拽模式自此对齐。 */
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
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !core || sessionKey == null) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      getPaperStore(core.panelId)
        .getState()
        .moveStrip(sessionKey, d.id, w.x - d.offX, w.y - d.offY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view, core, sessionKey]);

  /* 纸条销毁（收尾 2026-08-24：纸条可移除——用户层物件的完整生命周期） */
  const onRemoveStrip = useCallback(
    (id: string) => {
      if (!core || sessionKey == null) return;
      getPaperStore(core.panelId).getState().removeStrip(sessionKey, id);
    },
    [core, sessionKey],
  );

  /* 世界层 transform */
  const worldStyle = useMemo(
    () => ({ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }),
    [view],
  );

  const zoomLabel = Math.round(view.zoom * 100) + '%';

  /* 文类签机读序号（卷内流水号——转译序即卷次，重转译稳定） */
  const seqOf = useMemo(() => {
    const m = new Map<string, string>();
    blocks.forEach((b, i) => {
      m.set(b.id, String(i + 1).padStart(3, '0'));
    });
    return m;
  }, [blocks]);

  return (
    <div className="pp-root">
      <div className="pp-topbar">
        <span className="pp-title">案卷</span>
        <span className="pp-tag">兰台 · DOSSIER</span>
        <span className="pp-zoom">
          {zoomLabel} · {blocks.length} 块 · 已钉 {Object.keys(pinnedRecord).length} · 纸条 {strips.length}
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
          关卷
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

      {/* B 选中浮钮：块内有选区时现身（锚点随视口现算），点击成条（落流带右侧空地） */}
      {selAnchor && !ghost && fabPos && (
        <button type="button" className="pp-strip-fab" style={fabPos} onClick={onStripButton}>
          抽纸条
        </button>
      )}

      {/* 书脊列（C8 多卷切换）：左缘恒显——点脊换卷/列尾另起一卷/双击题签改名 */}
      <SpineRack core={core} />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 无限画布是鼠标平移/缩放交互面（缩放走原生非被动监听，平移在这里）；键盘可达性属走查弹范围外 */}
      <div ref={canvasRef} className={`pp-canvas${panning ? ' pp-panning' : ''}`} onMouseDown={onCanvasMouseDown}>
        {blocks.length === 0 && (
          <div className="pp-empty">
            当前案卷还没有内容。
            <br />
            直接在下面拟文开始。
          </div>
        )}

        {/* 世界层 */}
        <div className="pp-world" style={worldStyle}>
          {/* 原点十字（方位感） */}
          <div className="pp-origin" style={{ left: 0, top: 0 }}>
            <span className="pp-origin-label">origin</span>
          </div>

          {/* 幽灵预览（抽纸条拖拽过程反馈）：带内灰（不成条）/ 带外亮朱砂（松手成条） */}
          {ghost && (
            <div
              className={`pp-strip-ghost${ghost.zone === 'strip' ? ' pp-strip-ghost--ok' : ''}`}
              style={{ left: ghost.x + 12, top: ghost.y + 12 }}
            >
              <span className="pp-strip-ghost-tag">纸条</span>
              <span className="pp-strip-ghost-text">{ghost.zone === 'strip' ? '松手成条' : '拖出流带成条'}</span>
            </div>
          )}

          {/* 纸条（V3a 抽纸条：拷贝语义快照，可拖动、可销毁——收尾 2026-08-24） */}
          {strips.map((s) => {
            const stripDragged = dragStripId === s.id;
            const stripPos = stripDragged && stripDragPos ? stripDragPos : { x: s.x, y: s.y };
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: 纸条拖拽面（同块拖拽 D-R2-1 手势族）
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

          {/* 流序列：flow 块按序渲染（V3a 视口窗口化——视口外不进 DOM）；
           * pinned 块渲染占位符（原序位，随窗口化）+ 钉住实体（矩形相交测试） */}
          {blocks.map((b) => {
            const slot = layout.get(b.id);
            if (!slot || !visibleIds.has(b.id)) return null;
            if (b.state === 'flow') {
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler，非交互入口
                <div
                  key={b.id}
                  className={`pp-block pp-${b.kind}`}
                  style={{ left: slot.x, top: slot.y, width: b.w }}
                  data-message-id={b.source.messageId}
                  onDragStart={(e) => e.preventDefault()}
                >
                  <BlockView
                    block={b}
                    seq={seqOf.get(b.id) ?? '000'}
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
                {/* 占位符：流原序位的洞，点击即时恢复（D-R2-2 等价手势，原生 button 免 a11y ignore） */}
                <button
                  type="button"
                  className="pp-ghost"
                  style={{ left: slot.x, top: slot.y, width: b.w, height: GHOST_H }}
                  onClick={() => onGhostClick(b.id)}
                >
                  已移出 · 点击恢复
                </button>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler，非交互入口 */}
                <div
                  className={['pp-block', `pp-${b.kind}`, 'pp-pinned', isDragged ? 'pp-dragging' : ''].join(' ')}
                  style={{ left: pos.x, top: pos.y, width: b.w }}
                  data-message-id={b.source.messageId}
                  onDragStart={(e) => e.preventDefault()}
                >
                  <BlockView
                    block={b}
                    seq={seqOf.get(b.id) ?? '000'}
                    ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                    onUnpin={onUnpin}
                    onDragHandleMouseDown={onBlockMouseDown}
                  />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* 小地图（D-R1-1 方位感：内容聚落 + 视口框 + Home 回原点） */}
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
          placeholder="拟文…（Enter 发送 · Shift+Enter 换行 · ↑ 取历史；拖住任意块可移出钉住）"
          onChange={(e) => {
            setInputText(e.target.value);
          }}
          onKeyDown={(e) => {
            // IME 安全谓词（paper/ime）：合成中的 Enter 是候选确认，不发送
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing)) {
              e.preventDefault();
              onSend();
              return;
            }
            // ↑ 取上一条历史（光标在首行时；正在浏览历史或输入为空即可触发）
            if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              const atFirstLine = el.selectionStart === 0 || !el.value.includes('\n');
              const history = core ? getChatStore(core.panelId).input.getState().inputHistory : [];
              if (atFirstLine && history.length > 0) {
                e.preventDefault();
                const next = history[history.length - 1] ?? '';
                setInputText(next);
                // 光标落末尾（单步回溯最后一条——多步翻页交互留待走查弹反馈）
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
