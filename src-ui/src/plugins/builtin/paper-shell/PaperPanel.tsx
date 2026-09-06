// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel — 纸视图壳（paper-shell 走查弹长成的主界面，V5 拆除后唯一视图；
// Stage-2 一纸多卷：一个工作区一张纸，多个会话流区共享同一视口）。
//
// 挂法：纸壳第一方插件贡献（plugins/builtin/paper-shell/index.ts：
// side:null 全屏，unmountOnClose；增补四起产物通道化，本文件为产物域
// 源码——项目内依赖经 './host' 取宿主共享真实例，react 经构建期别名桥）。
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
//
// ── 2026-09-06 paper-panel-split：本文件瘦身为装配根 ──
// 域逻辑按 16 个 use-*.ts hook 文件拆出（会话镜像/落位/视口/焦点飞行/
// 折叠/实测/运行态/流区移位/布局核心/消息操作/拖块/宽度手调/纸条选区/
// 激活/键盘走卷/小地图包围盒）。装配根持有：共享 ref 载体（regionsRef）、
// 拖拽渲染态（regions memo 与拖拽/纸条两域共读共写）、context 组装、
// BlockView/DeskShelf 子组件与全部 JSX。纯行为保持——挂载序硬约束与
// 逐字节保真清单见 docs/plans/paper-shell/paper-panel-split-plan.md §3；
// 行为考官 = tests/perf-paper-pan.test.tsx（挂真实组件穿全层）。

import { type CSSProperties, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RegionView, SourcedBlock } from './host';
import {
  ANCHOR,
  activeOverlayContributions,
  activeSpace,
  blockFromSnapshot,
  foldLabel,
  Icon,
  isFoldable,
  needsObservedHeight,
  PaperDockContext,
  PaperRegionContext,
  PluginBoundary,
  resolveAssetBlock,
  resolveRenderer,
  sheetCharacter,
  subscribeOverlayContributions,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
  useUpdateStore,
  WinControls,
} from './host';
import { InkLayer } from './InkLayer';
import { StatusLine } from './StatusLine';
import { ToastHost } from './ToastHost';
import { useBlockMeasure } from './use-block-measure';
import type { BlockOp } from './use-block-ops';
import { useBlockOps } from './use-block-ops';
import { useFoldState } from './use-fold-state';
import { useJumpKeys } from './use-jump-keys';
import { useMinimapBounds } from './use-minimap-bounds';
import { usePaperDrag } from './use-paper-drag';
import { usePaperFocus } from './use-paper-focus';
import { GHOST_H, usePaperRegions } from './use-paper-regions';
import type { PaperCore } from './use-paper-sessions';
import { usePaperSessions } from './use-paper-sessions';
import { usePaperStrips } from './use-paper-strips';
import { usePaperViewport } from './use-paper-viewport';
import { usePinStripResize } from './use-pin-strip-resize';
import { useRegionActivation } from './use-region-activation';
import { useRegionMove } from './use-region-move';
import { useRegionPlacement } from './use-region-placement';
import { useRunningSessions } from './use-running-sessions';
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
  subagent: '子代理',
  notice: '贴黄',
  'turn-error': '错因',
  // 资产 kind（WO-4 文类签）：未知名仍回退 block.kind 字面。
  table: '表格',
  chart: '图表',
  metric: '指标',
  file: '文件',
  deps_impact: '影响',
  html: '卡片',
  confirm: '确认',
  board: '看板',
  timeline: '时间轴',
  citation: '引用',
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
  subagent: 'SUBAGENT',
  notice: 'NOTE',
  'turn-error': 'FAULT',
  table: 'TABLE',
  chart: 'CHART',
  metric: 'METRIC',
  file: 'FILE',
  deps_impact: 'GRAPH',
  html: 'HTML',
  confirm: 'CONFIRM',
  board: 'BOARD',
  timeline: 'TIMELINE',
  citation: 'CITATION',
};

/** 工具/程文卡状态签（2026-09-06 纸面运行态）：running = 石青「行」+行走秒
 *  ——秒数读 part 起跑戳（startedAt，part-mutator 首转 running 落戳）现算，
 *  虚拟化卸挂不丢时长；无戳历史卡降级纯「行」。1s 心跳自持在本签——
 *  走秒只重渲这几颗字，不惊动块体。 */
const ToolStatusChip = memo(function ToolStatusChip({ status, startedAt }: { status: string; startedAt?: number }) {
  const running = status === 'running';
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  let label: string;
  if (!running) label = status;
  else if (startedAt == null) label = '行';
  else {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    label = s < 60 ? `行 ${s}s` : `行 ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }
  return <span className={`pp-status pp-${status}${running ? ' pp-status--live' : ''}`}>{label}</span>;
});

const BlockView = memo(function BlockView({
  block,
  seq,
  ops,
  folded,
  sidecarFolded,
  onToggleFold,
  onToggleSidecarFold,
  onSidecarPinMouseDown,
  sidecarOut,
  onSidecarRestore,
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
  /** 眉批拖出钉画布（移出语义：首动建钉跟手，快照从眉批栏原位揭起） */
  onSidecarPinMouseDown?: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** 眉批已钉出（`:sc` 快照钉在画布）——眉批栏渲染「已移出·点击恢复」占位 */
  sidecarOut?: boolean;
  /** 眉批恢复（拔 `:sc` 快照钉，夹注回眉批栏——占位点击手势的语义端） */
  onSidecarRestore?: (b: SourcedBlock) => void;
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
  /* 折叠行在跑呼吸（2026-09-06 纸面运行态）：被收起的运行中卡片/组头——行内
   * 已有「N 在跑」字样（foldLabel），再给整行石青呼吸让静止的折叠行活
   * 起来。在跑口径与 foldLabel 对齐：running + pending。 */
  const foldBusy =
    foldable &&
    folded &&
    (block.kind === 'tool' || block.kind === 'code'
      ? (p as { status?: string }).status === 'running'
      : block.kind === 'toolgroup' || block.kind === 'subagent'
        ? (block.kind === 'subagent' && (p as { status?: string }).status === 'running') ||
          ((p as { items?: Array<{ status?: string }> }).items ?? []).some(
            (it) => it.status === 'running' || it.status === 'pending',
          )
        : false);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖拽手柄（D-R2-1 拖出钉住）；收回有原生按钮 */}
      <div className="pp-kind pp-drag-handle" onMouseDown={(e) => onDragHandleMouseDown(e, block)}>
        <span className="pp-zh">{KIND_ZH[block.kind] ?? block.kind}</span>
        <span className="pp-en">
          {KIND_EN[block.kind] ?? 'NOTE'} · {seq}
        </span>
        {(block.kind === 'tool' || block.kind === 'code') && (
          <ToolStatusChip
            status={(p as { status: string }).status}
            startedAt={(p as { startedAt?: number }).startedAt}
          />
        )}
      </div>
      {foldable && (
        <button
          type="button"
          className={`pp-fold${foldBusy ? ' pp-fold--busy' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFold(block);
          }}
        >
          {foldLabel(block.kind, p, folded)}
        </button>
      )}
      {Body ? (
        /* 保险丝 b（2026-09-03）：块渲染器（内置 + 资产/插件贡献面）包边界——
         * 单块渲染崩溃只死该块，纸壳与整树永生。 */
        <PluginBoundary label={`块 ${block.kind}`}>
          <Body
            block={block}
            folded={folded}
            sidecarFolded={sidecarFolded}
            onToggleSidecarFold={onToggleSidecarFold}
            onSidecarPinMouseDown={onSidecarPinMouseDown}
            sidecarOut={sidecarOut}
            onSidecarRestore={onSidecarRestore}
          />
        </PluginBoundary>
      ) : (
        <div className="pp-body">{(p as { text?: string }).text ?? ''}</div>
      )}
      {ops.length > 0 && (
        <div className="pp-msg-ops">
          {ops.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={o.disabled}
              title={o.title}
              style={o.disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (o.disabled) return;
                o.run();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {block.state === 'pinned' && (
        <span className="pp-pin-hint" aria-hidden="true">
          钉住
        </span>
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

/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
const EMPTY_OPS: BlockOp[] = [];

/* ── 案头签条架（创作坞 v2 2026-08-31）──
 * 空态三件套之一：最近三卷「续写」签条（楷体批注字，hover 朱砂——样式见
 * .pp-desk-shelf）。数据 = listSavedSessions（savedAt 倒序取三）；点击 =
 * activeSpace().expand 摊开 + requestFocus 定位（SessionSidebar 同款手势）。
 * 只在案头态（零摊开卷）渲染；无已存卷/无工作区 = 架空。 */
function DeskShelf({ core }: { core: PaperCore | null }) {
  const [recent, setRecent] = useState<Array<{ id: number; label: string }>>([]);
  // 工作区路径（响应式）：进入画布时 projectPath 晚于本组件挂载——路径变化必须重拉
  // （SessionSidebar P4-1 同款教训）
  const projectPath = useShellStore((s) => s.projectPath);
  useEffect(() => {
    if (!core || !projectPath) {
      setRecent([]);
      return;
    }
    let alive = true;
    void core
      .listSavedSessions(projectPath)
      .then((rows) => {
        if (!alive) return;
        const sorted = [...rows].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, 3);
        setRecent(sorted.map((r) => ({ id: r.id, label: r.label || `案卷 ${r.id}` })));
      })
      .catch(() => {
        if (alive) setRecent([]);
      });
    return () => {
      alive = false;
    };
  }, [core, projectPath]);
  const onResume = useCallback((sid: string) => {
    activeSpace()?.expand(sid);
    useCanvasViewStore.getState().requestFocus(sid);
  }, []);
  if (recent.length === 0) return null;
  return (
    <div className="pp-desk-shelf">
      {recent.map((r) => (
        <button
          key={r.id}
          type="button"
          className="pp-desk-tag"
          title={`续写「${r.label}」——摊开并定位`}
          onClick={() => onResume(String(r.id))}
        >
          续 · {r.label}
        </button>
      ))}
    </div>
  );
}

export function PaperPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  const core = useCoreStore((s) => s.core);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  /* ── 域装配（2026-09-06 paper-panel-split）──
   * 挂载序三对硬约束（split-plan §3）：sessionsMirror（activeRegion 镜像先
   * 落）→ placement（最近空位落位）→ viewport（重挂清除/R2 冷启动兜底要
   * 读到落位后的 spread + 镜像后的 activeSessionId）。其余域序 = 原文件
   * 内序；焦点飞行晚于布局核心（补飞 effect 依赖 regions 值）。 */
  const { sessions, activeSessionId, activeSessionKey, regionMsgs, canvasState, paperTick } = usePaperSessions(core);
  useRegionPlacement(core, sessions);
  const {
    view,
    canvasSize,
    canvasRef,
    paperRootRef,
    worldRef,
    lod,
    viewRect,
    viewRef,
    panning,
    panningRef,
    zoomGuardUntilRef,
    focusRafRef,
    focusFlightRef,
    onCanvasMouseDown,
    lodFar,
  } = usePaperViewport(core);

  /* ── 拖拽渲染态（声明在 usePaperRegions 之前——regions memo 消费拖拽
   *  保活/带显形输入；拖拽/纸条两域经穿参共读共写，装配根是唯一 owner）── */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  /* 拖拽语义（渲染面消费）：来源卷（带显形/回流判据）+ 是否自流内拖出——
   * 「回流」预览只对 wasFlow 有意义（已钉块移位不存在取消语义）。 */
  const [dragSource, setDragSource] = useState<{ sessionId: string | undefined; wasFlow: boolean } | null>(null);
  /* 带显形（拖拽中来源流区边界信号）：块拖出与选区揭起共用；纸条拖动是
   * 纯公共物移位，无带语义不挂。 */
  const [bandSessionId, setBandSessionId] = useState<string | null>(null);
  /* 落定 settle 标记（手感批）：commit 后一帧挂 pp-settle 播放「按下/放下」 */
  const [settleId, setSettleId] = useState<string | null>(null);

  /* ── 流式生命感（2026-08-30）──
   * seenBlocks：已渲染过的块 id 集——pp-enter 入场类只发首见（无 StrictMode，
   * 渲染期标记安全），虚拟化平移重挂不重放动画。
   * （pp-tail 尾笔已由用户拍板拆除——见 taste-ledger 翻案。） */
  const seenBlocksRef = useRef<Set<string>>(new Set());
  /* 域间共享 ref 载体（晚绑定跨域读——原文件内既有范式：viewRef 同族）。 */
  const regionsRef = useRef<RegionView[]>([]);

  const { measureTick, blockRootRef } = useBlockMeasure();
  const { foldedOf, onToggleFold, sidecarFoldedOf, onToggleSidecarFold } = useFoldState();
  const { runningSessions, streamLive, activeRunning } = useRunningSessions(core, activeSessionId);
  const { edgeDragPos, regionCornerPos, edgeDragRef, onRegionEdgeMouseDown, onRegionCornerMouseDown } = useRegionMove({
    core,
    canvasRef,
    viewRef,
    regionsRef,
  });

  const {
    regions,
    blockSessionRef,
    sidecarOutOf,
    minimapGeo,
    orphanPins,
    orphanInkBlocks,
    deadOrphanPinIds,
    visibleRegionIds,
    inkCache,
  } = usePaperRegions({
    /* regionsRef：装配根持有的共享载体（本 hook 每帧写，InkLayer/拖拽/自动
     * 选中/飞行等晚绑定读方共用同一实例——单一 owner 见 hook 头注）。 */
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
  });

  const { opsByBlock } = useBlockOps({ core, regions, regionsRef, regionMsgs });

  const { flyToPoint, flyToRegion, glideViewTo } = usePaperFocus({
    core,
    canvasSize,
    regions,
    regionsRef,
    focusRafRef,
    focusFlightRef,
  });

  const { dragRef, onBlockMouseDown, onUnpin, onGhostClick, onSidecarRestore, onSidecarPinMouseDown, pinHint } =
    usePaperDrag({
      core,
      view,
      canvasRef,
      viewRef,
      regionsRef,
      blockSessionRef,
      sessionsCount: sessions.length,
      draggingId,
      setDraggingId,
      setDragPos,
      setDragSource,
      setBandSessionId,
      setSettleId,
    });

  const { resizeRef, resizePreview, onResizeMouseDown } = usePinStripResize({ core, canvasRef, viewRef });

  /* 公共物 · 纸条（工作区级宿主，Stage-5）：不再随流区归属——独立渲染层 */
  const canvasStrips = canvasState.strips;
  const {
    ghost,
    liftMask,
    selAnchor,
    selInkArt,
    fabPos,
    onStripButton,
    dragStripId,
    stripDragPos,
    stripConfirmId,
    onRemoveStrip,
    onStripMouseDown,
    stripDragRef,
  } = usePaperStrips({
    core,
    view,
    canvasRef,
    viewRef,
    regionsRef,
    canvasStrips,
    setBandSessionId,
    setSettleId,
    dragRef,
    resizeRef,
  });

  const { activateRegion, inputLocked, setInputLocked } = useRegionActivation({
    core,
    canvasSize,
    regionsRef,
    activeSessionKey,
    panningRef,
    edgeDragRef,
    dragRef,
    stripDragRef,
    focusRafRef,
    zoomGuardUntilRef,
  });

  useJumpKeys({ core, canvasSize, regionsRef, flyToPoint, flyToRegion, activateRegion });

  const { minimapContent } = useMinimapBounds({ regions, canvasStrips, orphanPins, viewRect });

  /* ── 覆盖层贡献（Stage-4 插件化落位：创作坞/目次带 = 贡献行）──
   * 订阅贡献变更：插件热注册/卸载时即时重取渲染面（对齐 panels 的 bump 信号）。 */
  const [, setOverlayTick] = useState(0);
  useEffect(() => subscribeOverlayContributions(() => setOverlayTick((t) => t + 1)), []);
  const composerOverlays = activeOverlayContributions('composer');
  const edgeOverlays = activeOverlayContributions('right-edge');

  /* ── 案头态（创作坞 v2 2026-08-31）：零摊开卷——退匣直书 + 签条架陪衬。
   * 2026-09-02 拍板 C：两态同位（--composer-rise 恒定抬高）——落笔发出
   * 首句后坞不再沉降，只换装常驻匣；desk 只再管形态面（退匣/签条架/题字）。 ── */
  const desk = sessions.length === 0;

  /* 世界层 transform */
  const worldStyle = useMemo(
    () => ({ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }),
    [view],
  );

  const zoomLabel = Math.round(view.zoom * 100) + '%';
  // P2-2：stub 卷用最近已知块数（离屏后台流增长回场刷新）
  const totalBlocks = regions.reduce((n, r) => n + (r.stubbed ? (r.lastBlockCount ?? 0) : r.blocks.length), 0);
  const totalPinned = Object.keys(canvasState.pins).length;
  const totalStrips = canvasState.strips.length;

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
   * 目次带消费高频（流区几何）。拆两 context 避免创作坞随平移重渲。
   * 2026-09-05 插件化：小地图（paper-minimap）经 minimap 数据面 + glideTo
   * 消费（P2-3 缓存原样下发——引用稳定纪律不破）。 ── */
  const dockContext = useMemo(
    () => ({
      activeSessionId: activeSessionKey,
      inputLocked,
      setInputLocked,
      flyToPoint,
      glideTo: glideViewTo,
    }),
    [activeSessionKey, inputLocked, setInputLocked, flyToPoint, glideViewTo],
  );
  const regionContext = useMemo(
    () => ({
      regions,
      activeSessionId: activeSessionKey,
      viewRect,
      canvasSize,
      composerHeight,
      foldedOf,
      minimap: { content: minimapContent, geo: minimapGeo },
      inkCache: inkCache.current,
    }),
    [regions, activeSessionKey, viewRect, canvasSize, composerHeight, foldedOf, minimapContent, minimapGeo, inkCache],
  );

  /* 拖拽回流判据（渲染面）：来源流区中轴——dragPos 悬回带内且 wasFlow = 松手取消 */
  const dragBandCenter =
    dragSource?.sessionId != null
      ? (regions.find((r) => r.sessionId === dragSource.sessionId)?.anchor.anchorX ?? null)
      : null;

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
            <StatusLine running={activeRunning} />
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

          {/* 钉住可发现性（一次性眉批）：提示长在功能所在处——左缘即文类签列。
           * 视觉走 .pp-eyebrow-hint 族（6s 淡出自散动画）+ .pp-hint-canvas 落位。 */}
          {pinHint && <div className="pp-eyebrow-hint pp-hint-canvas">按住块左侧文类签，可把任意块拖出钉在案上</div>}

          {/* B 选中浮钮：块内有选区时现身（锚点随视口现算），点击成条（落来源流区右侧空地） */}
          {selAnchor && !ghost && fabPos && (
            <button type="button" className="pp-strip-fab" style={fabPos} onClick={onStripButton}>
              抽纸条
            </button>
          )}

          {/* 划词朱线（2026-09-02 视觉迭代）：流区选区的手写朱笔下划线——纸不动、只落墨；
           * 原生 ::selection 洗底在 .pp-region 内退役（CSS 侧）。固定视口层 client 坐标
           * （Range 活矩形，重渲染即刷新）；朱砂=人——被人手划过的字落朱线，不刷颜料。 */}
          {selInkArt && (
            <svg className="pp-sel-ink" aria-hidden="true">
              {selInkArt.mains.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 笔画按位静态渲染（行序稳定），无重排身份
                <path key={`m${i}`} d={d} />
              ))}
              {selInkArt.echoes.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上（echo 淡墨第二笔）
                <path key={`e${i}`} d={d} className="pp-sel-ink-echo" />
              ))}
            </svg>
          )}

          {/* biome-ignore lint/a11y/noStaticElementInteractions: 无限画布是鼠标平移/缩放交互面 */}
          <div
            ref={canvasRef}
            className={`pp-canvas${panning ? ' pp-panning' : ''}${streamLive ? ' pp-stream-live' : ''}`}
            onMouseDown={onCanvasMouseDown}
          >
            {sessions.length === 0 && (
              <div className="pp-empty">
                <div className="pp-empty-kicker">LANTAI · BLANK SHEET</div>
                <div className="pp-empty-title">案上无卷，落笔即起</div>
                <div className="pp-empty-rule" />
                {/* 空态 CTA（2026-08-31 拍板 A：显式出生入口；2026-09 修复批：
                 * 不再 disabled 依赖 core——onClick 永远走 createNewSession()，
                 * 无 core 时其内部守卫会 toast「需要先有工作区」，点按必有反馈，
                 * 按钮不会出现「点了没反应」。 */}
                <button type="button" className="pp-empty-cta" onClick={() => void core?.createNewSession()}>
                  ＋ 另起一卷
                </button>
                <div className="pp-empty-hint">点签条可续写旧卷，或直接在下方案头落笔——开口即开卷</div>
                <div className="pp-empty-asterism">⁂</div>
              </div>
            )}

            {/* 世界层 */}
            <div ref={worldRef} className="pp-world" style={worldStyle}>
              {/* 桌垫（材质批修复 2026-09-01 贴纸语义）：世界内巨幅纸面——桌面纹理
                  随拖动/缩放走且只纹理桌面自身，不再乘盖流区/纸条（贴纸有贴纸的
                  纹，见 .pp-region 的 paper-sheet；样式见 .pp-desk） */}
              <div className="pp-desk" />
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
                const sheet = sheetCharacter(r.sessionId);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: 流区是可点击交互面（点背景激活流区）
                  <div
                    key={r.sessionId}
                    className={`pp-region${isActive ? ' pp-region-active' : ''}${
                      bandSessionId === r.sessionId ? ' pp-region--band' : ''
                    }`}
                    style={
                      {
                        left: r.anchor.anchorX - r.anchor.width / 2,
                        top: r.regionTop - r.folioH,
                        width: r.anchor.width,
                        height: r.regionHeight + r.folioH,
                        '--sheet-ox': `${sheet.ox}px`,
                        '--sheet-oy': `${sheet.oy}px`,
                        '--sheet-j': `${sheet.j}`,
                      } as CSSProperties
                    }
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
                     * 原浮动标签带退役（卷首即卷名，不重复播报）。
                     * 远档（P4c 三档）退场：缩糊的 DOM 卷首不如无——卷名由
                     * InkLayer 地志标签接管（地图标签逻辑，字号有下限）。 */}
                    {!lodFar && (
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
                    )}
                    {/* 空卷题字：零块流区的版心竖排占位（pointer-events none——
                     * 点击穿透到流区背景激活） */}
                    {!lodFar && r.blocks.length === 0 && <div className="pp-region-empty">此卷未落墨</div>}
                    {/* 落笔点（2026-09-06 纸面运行态）：本卷在跑且尾部无湿墨
                     * （模型思考中/工具执行中——下一块墨将落此处）→ 卷轴线
                     * 锚线下方石青方点呼吸。湿墨尾点在场时让位（书写中的正文
                     * 自带活信号，双点成噪声）。LOD 缩远不画（方点随缩放变
                     * 亚像素）。运行而纸面静止的「死寂窗口」由此被照亮。 */}
                    {!lod && runningSessions.has(r.sessionNum) && !r.writingBlockId && (
                      <div className="pp-quill" aria-hidden="true" />
                    )}
                    {/* 边缘拖拽面（Stage-2 定案：无手柄条，hover 即拖拽态）——
                     * 远档退场：亚像素交互柄只剩噪点（P4c）。 */}
                    {!lodFar && (
                      <>
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: 边缘拖拽面（Stage-2 定案：无手柄条，hover 即拖拽态） */}
                        <div
                          className="pp-region-edge pp-region-edge--l"
                          title="拖动边缘——移动整个流区"
                          onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                        />
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: 边缘拖拽面（同左缘——拖右缘移动整个流区） */}
                        <div
                          className="pp-region-edge pp-region-edge--r"
                          title="拖动边缘——移动整个流区"
                          onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                        />
                        {/* P6 四角横向缩放柄（角落只开放横向——Y 由内容生长） */}
                        {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                          // biome-ignore lint/a11y/noStaticElementInteractions: 角柄是拖拽交互面
                          <div
                            key={c}
                            className={`pp-region-corner pp-region-corner--${c}`}
                            title="拖动角柄——调整流区宽度"
                            onMouseDown={(e) => onRegionCornerMouseDown(e, r.sessionId, c)}
                          />
                        ))}
                      </>
                    )}
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
                      className={`pp-strip${stripDragged ? ' pp-dragging' : ''}${settleId === s.id ? ' pp-settle' : ''}`}
                      style={{ left: stripPos.x, top: stripPos.y, width: stripW }}
                      onMouseDown={(e) => onStripMouseDown(e, s)}
                    >
                      <div className="pp-strip-head">
                        <span className="pp-strip-tag">纸条</span>
                        <button
                          type="button"
                          className={`pp-strip-remove${stripConfirmId === s.id ? ' pp-strip-remove--confirm' : ''}`}
                          title={stripConfirmId === s.id ? '再击一次确认销毁' : '销毁纸条'}
                          aria-label={stripConfirmId === s.id ? '再击一次确认销毁纸条' : '销毁纸条'}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveStrip(s.id);
                          }}
                        >
                          {stripConfirmId === s.id ? '确认？' : '✕'}
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
                      style={{
                        transform: `translate(${pos.x}px, ${pos.y}px)`,
                        width: resizePreview?.id === pinId ? resizePreview.w : pin.w,
                      }}
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
                    /* 湿墨尾点（2026-09-06）：正在书写的块（writingBlockIdOf
                     * 派生——source part 未干墨）挂 pp-writing，::after 落
                     * 石青方点在续墨行位。 */
                    const writing = r.writingBlockId === b.id;
                    /* 松手定夺（2026-09-05）：拖动中的 flow 块 state 不变——仍在流
                     * 分支渲染，transform 覆盖为跟手位（slot 布局全程不动）；悬回
                     * 带内时块影转「回流」预览态（松手 = 取消回槽）。 */
                    const isDragged = draggingId === b.id;
                    const dragX = isDragged && dragPos ? dragPos.x : slot.x;
                    const dragY = isDragged && dragPos ? dragPos.y : slot.y;
                    const inBand =
                      isDragged &&
                      dragSource?.wasFlow === true &&
                      dragBandCenter != null &&
                      Math.abs(dragX - dragBandCenter) <= ANCHOR.bandHalfWidth;
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler
                      <div
                        key={b.id}
                        className={`pp-block pp-${b.kind}${firstSeen ? ' pp-enter' : ''}${
                          isDragged ? ' pp-dragging' : ''
                        }${inBand ? ' pp-drag-returning' : ''}${r.stageLeadIds.has(b.id) ? ' pp-stage-lead' : ''}${
                          r.verifyDoneIds.has(b.id) ? ' pp-verify-done' : ''
                        }${writing ? ' pp-writing' : ''}`}
                        style={{ transform: `translate(${dragX}px, ${dragY}px)`, width: b.w }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-observed={
                          needsObservedHeight(b.kind, b.asset != null, (b.payload as { text?: string }).text)
                            ? b.id
                            : undefined
                        }
                        ref={blockRootRef}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        {/* 单元界短规线（2026-09-06 尸检改实元素）：原块级 ::before
                         * 与脚注族注线（.pp-tool::before 等）同槽同特异性，源序落败
                         * 被静默顶掉——线在工具族单元首块上整体消失。机理与
                         * 钉值见 CSS .pp-unit-rule 注 + paper-visual-decisions 槽位
                         * 独立性回归。 */}
                        {r.unitLeadIds.has(b.id) && <span className="pp-unit-rule" aria-hidden="true" />}
                        <BlockView
                          block={b}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          folded={foldedOf(b)}
                          sidecarFolded={sidecarFoldedOf(b)}
                          onToggleFold={onToggleFold}
                          onToggleSidecarFold={onToggleSidecarFold}
                          onSidecarPinMouseDown={onSidecarPinMouseDown}
                          sidecarOut={sidecarOutOf(b)}
                          onSidecarRestore={onSidecarRestore}
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
                        className={`pp-block pp-${b.kind} pp-pinned${isDragged ? ' pp-dragging' : ''}${
                          settleId === b.id ? ' pp-settle' : ''
                        }${r.writingBlockId === b.id ? ' pp-writing' : ''}`}
                        style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: pinW }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-observed={
                          needsObservedHeight(b.kind, b.asset != null, (b.payload as { text?: string }).text)
                            ? b.id
                            : undefined
                        }
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
                          sidecarOut={sidecarOutOf(b)}
                          onSidecarRestore={onSidecarRestore}
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
                inkCache={inkCache.current}
                strips={canvasStrips}
                orphanBlocks={orphanInkBlocks}
              />
            )}
          </div>

          {/* 小地图已插件化（2026-09-05）：paper-minimap 插件经 overlays right-edge 槽贡献，
              本处不再渲染——见 plugins/builtin/paper-minimap/ */}

          {/* 覆盖层贡献行（Stage-4）：创作坞（composer 槽）在底栏，目次带（right-edge 槽）在右缘。
              案头态（v2 + 2026-09-02 拍板 C）：位置两态恒同，只换形态（退匣直书）；
              坞下方出流悬挂签条架（最近三卷续写——出没不推坞位）。
              ⚠ 形态类刻意叫 pp-at-desk 不叫 pp-desk——与世界层桌垫 .pp-desk
              同名会撞车（桌垫 top/height ±200000 接管槽，坞射出屏外，CSS 注释有案）。 */}
          <div className={`pp-composer-slot${desk ? ' pp-at-desk' : ''}`} ref={composerSlotRef}>
            {composerOverlays.map((def) => (
              /* 保险丝 b：覆盖层贡献行（插件面）包边界——创作坞崩溃不卸整树 */
              <PluginBoundary key={def.id} label={`覆盖层 ${def.id}`}>
                <def.component />
              </PluginBoundary>
            ))}
            {desk && <DeskShelf core={core} />}
          </div>
          {edgeOverlays.map((def) => (
            <PluginBoundary key={def.id} label={`边缘层 ${def.id}`}>
              <def.component />
            </PluginBoundary>
          ))}
        </div>
      </PaperRegionContext.Provider>
      <ToastHost />
    </PaperDockContext.Provider>
  );
}
