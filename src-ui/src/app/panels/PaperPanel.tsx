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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { clearPaperMeasureCache, measureBlockHeight } from '../../paper/measure';
import { moveStrip, type PaperStrip, tryMakeStripFromSelection } from '../../paper/selection';
import { translateMessages } from '../../paper/translate';
import {
  type FlowGeom,
  type PinnedGeom,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
} from '../../paper/virtualize';
import { useDockStore } from '../../state/dock-store';
import { getChatStore, msgStoreForActive } from '../../ui/chat-store';
import { useCoreStore } from '../chat/core-instance';
import { WinControls } from '../WinControls';
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
  plan: '拟策',
  notice: '贴黄',
};
const KIND_EN: Record<string, string> = {
  user: 'USER',
  markdown: 'AGENT',
  reasoning: 'THINK',
  diff: 'CODE',
  tool: 'TOOL',
  plan: 'PLAN',
  notice: 'NOTE',
};

/** 灰框块渲染器（V3b：体渲染经第五贡献通道解析——ctx.renderers） */

function BlockView({
  block,
  seq,
  onUnpin,
  onDragHandleMouseDown,
}: {
  block: SourcedBlock;
  /** 文类签机读序号（卷内流水号，三位补零） */
  seq: string;
  onUnpin: (id: string) => void;
  /** 拖拽手柄（文类签 .pp-kind）——V3a 手势分工：签=整块拖出（D-R2-1），
   * 文本区=原生选择（待定 #10 抽纸条的前提：选中文字拖离流出纸条） */
  onDragHandleMouseDown: (e: React.MouseEvent) => void;
}) {
  const p = block.payload;
  // 体渲染器：注册表按 kind 解析（内置注疏行 + 插件贡献——后注册胜）；
  // 无服务/无行时直渲文本（纸壳永不裸奔的兜底）。
  const renderer = resolveRenderer(block.kind);
  const Body = renderer?.component;
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖拽手柄（D-R2-1 拖出钉住）；收回有原生按钮 */}
      <div className="pp-kind pp-drag-handle" onMouseDown={onDragHandleMouseDown}>
        <span className="pp-zh">{KIND_ZH[block.kind] ?? block.kind}</span>
        <span className="pp-en">
          {KIND_EN[block.kind] ?? 'NOTE'} · {seq}
        </span>
        {block.kind === 'tool' && (
          <span className={`pp-status pp-${(p as { status: string }).status}`}>{(p as { status: string }).status}</span>
        )}
      </div>
      {Body ? <Body block={block} /> : <div className="pp-body">{(p as { text?: string }).text ?? ''}</div>}
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
}

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
    <div className="pp-minimap" title="小地图 · Home 回原点">
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

export function PaperPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  const core = useCoreStore((s) => s.core);

  /* 真实消息（穿全层第一段：消息 store → 转译）。
   * tick 是重转译触发器：消息原位变更时 messages 引用不变（touchMessage 语义），
   * version bump / 会话切换 / 钉位变化都走 tick+1。 */
  const [msgState, setMsgState] = useState<{
    messages: readonly import('../../ui/message-model').ChatMessage[];
    tick: number;
  }>({ messages: [], tick: 0 });

  const syncMessages = useCallback(() => {
    if (!core) return;
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

  /* 钉住位置表（活引用续命：重转译时经 pinnedPositions 传回 translate） */
  const pinnedRef = useRef(new Map<string, { x: number; y: number }>());

  /* 纸条（V3a 抽纸条·待定 #10：选区拖出 = 拷贝语义的用户层物件） */
  const [strips, setStrips] = useState<PaperStrip[]>([]);

  /* 转译（穿全层第二段）——msgState.tick 驱动重算（pinnedRef 是可变 ref，
   * 位置表读取发生在 translate 内——ref 身份恒定，无需进依赖） */
  const blocks = useMemo(
    () => translateMessages(msgState.messages, { pinnedPositions: pinnedRef.current }),
    [msgState],
  );

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
    () => blocks.map((b) => ({ id: b.id, h: b.state === 'flow' ? measureBlockHeight(b) : GHOST_H, w: b.w })),
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
      blocks.map((b) => ({
        id: b.id,
        y: layout.get(b.id)?.y ?? 0,
        h: b.state === 'flow' ? measureBlockHeight(b) : GHOST_H,
        x: layout.get(b.id)?.x ?? 0,
        w: b.w,
      })) satisfies FlowGeom[],
    [blocks, layout],
  );
  const pinnedGeom = useMemo(
    () =>
      blocks
        .filter((b) => b.state === 'pinned')
        .map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: measureBlockHeight(b) })) satisfies PinnedGeom[],
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

  const onBlockMouseDown = useCallback(
    (e: React.MouseEvent, block: SourcedBlock) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // 不触发画布平移
      e.preventDefault(); // 手柄拖拽不启动原生文本选择（文本区选择不经过这里）
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      // 偏移基于「当前渲染位」：flow 块取流布局位（block.x 是默认值 0，非渲染位）
      const rx = block.state === 'flow' ? (layout.get(block.id)?.x ?? block.x) : block.x;
      const ry = block.state === 'flow' ? (layout.get(block.id)?.y ?? block.y) : block.y;
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
    },
    [view, layout],
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
          pinnedRef.current.set(d.id, { x: w.x - d.offX, y: w.y - d.offY });
          setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
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
        pinnedRef.current.delete(d.id);
      } else {
        pinnedRef.current.set(d.id, { x: fx, y: fy });
      }
      setDragPos(null);
      setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view]);

  /* 收回（D-R2-2 按钮+确认主通道） */
  const onUnpin = useCallback((id: string) => {
    if (window.confirm('收回该块到卷中原位？')) {
      pinnedRef.current.delete(id);
      setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
    }
  }, []);

  /* 占位符点击恢复（原型同款等价手势，即时——R2 注记「走查弹验证哪种顺手」） */
  const onGhostClick = useCallback((id: string) => {
    pinnedRef.current.delete(id);
    setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
  }, []);

  /* ── 输入条：真相走 input-store，提交走 core.sendMessage（agent 层零改动）── */
  const [inputText, setInputText] = useState('');
  /* 冷启动死路防护：无活跃会话时 chat-core 的 addNotice 会被
   * _resolveSessionTarget 丢弃（返回 null）——纸面零反馈 = 假阴性。
   * 发送前置检查：无会话 → 纸面本地提示块（不入消息 store，UI 层直示）。 */
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const onSend = useCallback(async () => {
    const t = inputText.trim();
    if (!t || !core) return;
    const sess = getChatStore(core.panelId).sess.getState();
    if (sess.activeIdx < 0 || !sess.sessions[sess.activeIdx]) {
      setLocalNotice('当前没有活跃会话——请在设置中配置 API Key（书眉「设置」→ Provider）后重开应用。');
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

  /* ── 抽纸条手势（待定 #10：选中文字拖离流 = 拷贝语义纸条）──
   * mouseup 时读 window.getSelection()：非空且落点在流锚窄带外 → 抽纸条；
   * 落点在带内 = 普通选择（不抢）。拖纸条与拖块共用 dragRef 之外的独立通道。 */
  const stripDragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  useEffect(() => {
    const up = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return; // 画布外松手不管
      const w = screenToWorld(view, sx, sy);
      // 带外落点才抽（带内 = 普通选择/阅读行为）
      if (Math.abs(w.x) <= ANCHOR.bandHalfWidth) return;
      const strip = tryMakeStripFromSelection(text, 0, text.length, w.x, w.y);
      if (strip) {
        sel.removeAllRanges(); // 手势完成，清选区
        setStrips((arr) => [...arr, strip]);
      }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [view]);

  /* 拖纸条（世界坐标跟手） */
  const [dragStripId, setDragStripId] = useState<string | null>(null);
  const onStripMouseDown = useCallback(
    (e: React.MouseEvent, s: PaperStrip) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      stripDragRef.current = { id: s.id, offX: w.x - s.x, offY: w.y - s.y };
      setDragStripId(s.id);
    },
    [view],
  );
  useEffect(() => {
    if (!dragStripId) return;
    const move = (e: MouseEvent) => {
      const d = stripDragRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      setStrips((arr) => arr.map((s) => (s.id === d.id ? moveStrip(s, w.x - d.offX, w.y - d.offY) : s)));
    };
    const up = () => {
      stripDragRef.current = null;
      setDragStripId(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragStripId, view]);

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
          {zoomLabel} · {blocks.length} 块 · 已钉 {pinnedRef.current.size}
        </span>
        <button
          type="button"
          className="pp-settings"
          title="设置 (Ctrl+,)"
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

          {/* 纸条（V3a 抽纸条：拷贝语义快照，可拖动） */}
          {strips.map((s) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: 纸条拖拽面（同块拖拽 D-R2-1 手势族）
            <div
              key={s.id}
              className={`pp-strip${dragStripId === s.id ? ' pp-dragging' : ''}`}
              style={{ left: s.x, top: s.y, width: s.w }}
              onMouseDown={(e) => onStripMouseDown(e, s)}
            >
              <div className="pp-strip-tag">纸条</div>
              <div>{s.text}</div>
            </div>
          ))}

          {/* 流序列：flow 块按序渲染（V3a 视口窗口化——视口外不进 DOM）；
           * pinned 块渲染占位符（原序位，随窗口化）+ 钉住实体（矩形相交测试） */}
          {blocks.map((b) => {
            const slot = layout.get(b.id);
            if (!slot || !visibleIds.has(b.id)) return null;
            if (b.state === 'flow') {
              return (
                <div key={b.id} className={`pp-block pp-${b.kind}`} style={{ left: slot.x, top: slot.y, width: b.w }}>
                  <BlockView
                    block={b}
                    seq={seqOf.get(b.id) ?? '000'}
                    onUnpin={onUnpin}
                    onDragHandleMouseDown={(e) => onBlockMouseDown(e, b)}
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
                <div
                  className={['pp-block', `pp-${b.kind}`, 'pp-pinned', isDragged ? 'pp-dragging' : ''].join(' ')}
                  style={{ left: pos.x, top: pos.y, width: b.w }}
                >
                  <BlockView
                    block={b}
                    seq={seqOf.get(b.id) ?? '000'}
                    onUnpin={onUnpin}
                    onDragHandleMouseDown={(e) => onBlockMouseDown(e, b)}
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
        <input
          type="text"
          value={inputText}
          placeholder="向 Agent 拟文…（拖住任意块可移出到纸上钉住）"
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            // IME 安全谓词（paper/ime）：合成中的 Enter 是候选确认，不发送
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing)) onSend();
          }}
        />
        <button type="button" onClick={onSend}>
          拟文
        </button>
      </div>
    </div>
  );
}
