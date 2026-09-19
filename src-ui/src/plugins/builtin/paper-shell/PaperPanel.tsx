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
// 顶部浮件（2026-09-17 标题栏拆除批）：缩放读数 + 状态字 + 设置入口 + 回首页
// （关卷）+ 窗口控制——书眉布局行退役，画布铺满整窗（顶缘 = 屏缘），浮件是
// 覆盖件并兼任窗口拖动热区。见 .pp-chrome 头注。
// 输入条：写 input-store（真相源），提交走 core.sendMessage()。
//
// ── 2026-09-06 paper-panel-split：本文件瘦身为装配根 ──
// 域逻辑按 16 个 use-*.ts hook 文件拆出（会话镜像/落位/视口/焦点飞行/
// 折叠/实测/运行态/流区移位/布局核心/消息操作/拖块/宽度手调/纸条选区/
// 激活/键盘走卷/小地图包围盒）。装配根持有：共享 ref 载体（regionsRef）、
// 拖拽渲染态（regions memo 与拖拽/纸条两域共读共写）、context 组装、
// BlockView/DeskShelf 子组件与全部 JSX。纯行为保持——挂载序硬约束与
// 逐字节保真清单见 docs/archive/paper-shell/paper-panel-split-plan.md §3；
// 行为考官 = tests/perf-paper-pan.test.tsx（挂真实组件穿全层）。

import { type CSSProperties, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ProvenanceState,
  provenanceText,
  provenanceTitle,
  provenanceTraceable,
  sourceBlockIdOf,
  tetherAnchors,
  tetherAnchorsAt,
  tetherPath,
} from '../../../paper/provenance';
import { volumeDisplayName } from '../../../state/volume-name';
import { FolioCompositionChip } from './FolioCompositionChip';
import { formatCNDate } from './folio-date';
import type { RegionView, SourcedBlock } from './host';
import {
  activeOverlayContributions,
  activeSpace,
  blockFromSnapshot,
  ConfirmDialog,
  foldLabel,
  getCanvasStore,
  Icon,
  isFoldable,
  leaveToHome,
  needsObservedHeight,
  onTopbarDoubleClick,
  onTopbarPointerDown,
  PaperDockContext,
  PaperRegionContext,
  PluginBoundary,
  resolveAssetBlock,
  resolveRenderer,
  selSeedOf,
  sheetCharacter,
  subscribeOverlayContributions,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
  useUpdateStore,
  WinControls,
  worldToScreen,
} from './host';
import { InkLayer } from './InkLayer';
import { StatusLine } from './StatusLine';
import { ToastHost } from './ToastHost';
import { useBlockMeasure } from './use-block-measure';
import type { BlockOp } from './use-block-ops';
import { useBlockOps } from './use-block-ops';
import { useComposerFloat } from './use-composer-float';
import { useFoldState } from './use-fold-state';
import { useJumpKeys } from './use-jump-keys';
import { useMinimapBounds } from './use-minimap-bounds';
import { blockReturnsToFlow, usePaperDrag } from './use-paper-drag';
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
  prov,
  provTitle,
  provTraceable = false,
  onProvClick,
}: {
  block: SourcedBlock;
  /** 文类签机读序号（卷内流水号，三位补零） */
  seq: string;
  /** 消息操作（hover 浮现）——user 块编辑/重发，全部可抄录（施工单 #5） */
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
  /** 出处行文本（**仅钉住块**，paper/provenance.provenanceText 产出）——页边注
   *  第三行：常显的「从哪来」，不依赖任何视口内目标（引线是 hover 期的空间面）。 */
  prov?: string;
  /** 出处行 hover 说明（provenanceTitle 产出）。 */
  provTitle?: string;
  /** 出处行可点（未删卷）；false = 只读注记（已删卷不发起必落空的定位）。 */
  provTraceable?: boolean;
  /** 出处行点击（A 溯源手势）：参数 = 本块 id（钉 id 与块 id 同空间）。
   *  **传稳定回调 + 由本组件回传 id**——调用点若传内联箭头会击穿 memo
   *  （平移/流式帧全块重渲，§1.9 性能纪律）。 */
  onProvClick?: (id: string) => void;
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
        {/* 出处行（2026-09-18 出处引导批）：页边注第三行——「摘自 卷名」常显，
            点行溯源。mousedown 停传：页边注是拖拽把手（整块拖出），而出处行是
            行内的点击件——不停传则「点一下」变成「起拖」（松手无位移才回到
            点击，手感与语义都不对）。 */}
        {prov !== undefined && (
          <button
            type="button"
            className={`pp-prov${provTraceable ? ' pp-prov--trace' : ''}`}
            title={provTitle}
            aria-disabled={!provTraceable}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (provTraceable) onProvClick?.(block.id);
            }}
          >
            {prov}
          </button>
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

/** 卷首档行（2026-09-16 版心天头重排）：`立卷日 · N 块`。
 *  立卷日取自卷级 createdAt（真源 = 卷日志头行，见 state/session-store
 *  ChatSessionMeta.createdAt）；**旧卷无此字段 = 只显块数**，不编造日期。
 *  重排前档行是「案卷 #N · M 块」——卷号与眉行重复，且原型原有的日期在移植时
 *  丢了（当时 RegionView 根本拿不到时间字段）。 */
function folioSubLine(r: RegionView): string {
  const date = formatCNDate(r.createdAt);
  return date ? `${date} · ${r.blocks.length} 块` : `${r.blocks.length} 块`;
}

/* ── 案头签条架（创作坞 v2 2026-08-31）──
 * 空态三件套之一：最近三卷「续写」签条（手迹位批注字，hover 朱砂——样式见
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
        setRecent(sorted.map((r) => ({ id: r.id, label: volumeDisplayName(r.label, r.id) })));
      })
      .catch(() => {
        if (alive) setRecent([]);
      });
    return () => {
      alive = false;
    };
  }, [core, projectPath]);
  /** 续写签条：expand 自带定位（读盘成功才 requestFocus——签条来自磁盘列表，
   *  点它时卷可能已被删；失败不留悬空定位请求，2026-09-10 收口）。 */
  const onResume = useCallback((sid: string) => {
    activeSpace()?.expand(sid);
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
  const core = useCoreStore((s) => s.core);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  /* ── 回首页确认守卫（2026-09-08 生命周期修复：回首页 = 真关工作区）──
   * 历史：关 paper 面板只翻 dock-store 布尔，工作区（watcher/引擎/Agent）
   * 后台常驻。用户拍板：回首页是有副作用的离开操作 → 需确认 → 确认后真
   * deactivate（leaveToHome：停 watcher/引擎/Agent + 清 projectPath）。
   * 守卫拦截所有 closePanel('paper')（回首页按钮 / Ctrl+P 命令都过这里）；
   * ESC 已从 escLayer 移除（不关 paper）。无活动工作区也确认（用户拍板）。
   * 确认后 forceLeave 先摘守卫再 leaveToHome（防二次拦截死循环，SettingsPanel
   * forceClose 同款）。 */
  const projectPath = useShellStore((s) => s.projectPath);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const forceLeave = useCallback(() => {
    useDockStore.getState().unregisterCloseGuard('paper');
    void leaveToHome();
  }, []);
  useEffect(() => {
    useDockStore.getState().registerCloseGuard('paper', () => {
      setLeaveConfirm(true);
      return false; // 拦截：确认弹层已在路上
    });
    return () => {
      useDockStore.getState().unregisterCloseGuard('paper');
    };
  }, []);

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
    selDragRef,
    stepZoom,
    resetZoom,
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

  /* ── 出处引导（2026-09-18）──
   * 病灶：钉块与源块之间只剩流内占位一个**视口内**的记号——流自锚点向上生长，
   * 洞随新墨越漂越远，视口一离开线索归零（用户报「不知道这东西从哪来的」）。
   * tetherPinId = hover 中的钉：世界层引线（钉缘 → 洞缘）只为它亮起（一屏一线，
   *   防面条；洞离屏时线照样出屏 = 方向即来路）；
   * tracedPinId = 刚溯源过的钉：飞到洞后洞点名一拍（1.6s 自散），且飞行途中引线
   *   继续在场（镜头一动指针就离开钉，hover 态守不住）。
   * 常显那条腿在页边注（.pp-prov 出处行）——不依赖任何视口内目标。 */
  const [tetherPinId, setTetherPinId] = useState<string | null>(null);
  const [tracedPinId, setTracedPinId] = useState<string | null>(null);

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
  const { edgeDragPos, regionCornerPos, onRegionEdgeMouseDown, onRegionCornerMouseDown } = useRegionMove({
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
    selDragRef,
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

  /* 溯源（出处行点击）：飞到源洞；源卷摊开而源块不在流内 → 飞到该卷；源卷未
   * 摊开 → expand（**自带定位**，先例 = 案头签条架「续写」；已删卷不给点，
   * 见 provenanceTraceable——不发起必然落空的请求）。 */
  const onProvTrace = useCallback(
    (blockId: string) => {
      if (!core) return;
      const pin = getCanvasStore(core.panelId).getState().getPin(blockId);
      const source = pin?.source;
      if (!source) return;
      const sid = String(source.sessionId);
      const region = regionsRef.current.find((r) => r.sessionId === sid);
      const hole = region?.flowGeom.find((g) => g.id === sourceBlockIdOf(source.blockId));
      if (region && hole) {
        setTracedPinId(blockId);
        flyToPoint(sid, hole.y + hole.h / 2, region.anchor.anchorX);
        return;
      }
      if (region) {
        flyToRegion(sid);
        return;
      }
      activeSpace()?.expand(sid);
    },
    [core, flyToPoint, flyToRegion],
  );

  /* 洞点名自散：溯源后洞位闪一拍即收（常显会变成一个持续的信号源）。 */
  useEffect(() => {
    if (tracedPinId === null) return;
    const t = window.setTimeout(() => setTracedPinId(null), 1600);
    return () => window.clearTimeout(t);
  }, [tracedPinId]);

  /* 引线几何：hover 中的钉（或刚溯源过的钉）→ 其源洞。
   * 拖动中读跟手位（线随块走——拖回洞位的手感依据）；源卷未摊开/源块不在流内
   * = 无洞可指，引线不画（出处行仍在，那是常显那条腿）。
   * 层 = **屏幕坐标**（同 .pp-sel-ink）：锚点在世界里定，投到屏上落墨——墨宽不随
   * 缩放变（世界 1px 在 zoom .3 下 = .3px，等于没画）。种子取钉 id：**同钉恒同线**，
   * 平移/重渲染不闪（划词朱线的 selSeedOf 同款纪律）。 */
  const tether = useMemo(() => {
    const id = tetherPinId ?? tracedPinId;
    if (id === null) return null;
    const pin = canvasState.pins[id];
    const source = pin?.source;
    if (!pin || !source) return null;
    const region = regions.find((r) => r.sessionId === String(source.sessionId));
    const hole = region?.flowGeom.find((g) => g.id === sourceBlockIdOf(source.blockId));
    if (!hole) return null;
    const at = draggingId === id && dragPos ? dragPos : { x: pin.x, y: pin.y };
    const world = tetherAnchors({ x: at.x, y: at.y, w: pin.w }, hole);
    return tetherPath(
      worldToScreen(view, world.from.x, world.from.y),
      worldToScreen(view, world.to.x, world.to.y),
      selSeedOf(id),
    );
  }, [tetherPinId, tracedPinId, canvasState.pins, regions, draggingId, dragPos, view]);

  /* ── 会话树「枝」的画布承接（P3，2026-09-18）──
   * 边 = 一丝朱砂引线：**枝卷卷首 → 父卷的那个节点**（不是「父卷」这个整体）。
   * 与出处引导**同一支笔**（`tetherAnchorsAt` + `tetherPath`：屏幕坐标 / 恒定墨宽 /
   * 定种子相位 / 起笔留白 + 收笔朱点）——一屏一语言，不新造一种线。
   * 与钉那条腿的两处不同（各记理由）：
   *   ① **常显**——树是结构不是瞬时手势，且线要能点着溯源（hover 才出现的线点不到）；
   *   ② **可点**——命中的是一条加粗透明「受墨带」，墨仍是那一丝（见 CSS 注）。
   * 父节点不在视口内时线照样出屏（同款判据：锚点在世界里定、投到屏上落墨）。
   * 数据来自 `core.branchEdge`（**零 I/O**：血缘在卷日志头行里，attach 时已带入内存）。 */
  const branchEdges = useMemo(() => {
    if (!core) return [];
    const out: Array<{ childSid: number; parentSid: number; nodeMessageId: string }> = [];
    for (const s of sessions) {
      const edge = core.branchEdge(s.id);
      if (edge) out.push({ childSid: s.id, ...edge });
    }
    return out;
  }, [core, sessions]);
  /** 枝边 → 父卷那个节点的**流位**（块 id）。父卷锚点要走一整段 fold（O(事件数)），
   *  故与 `view` 解耦单列一层——平移帧不重跑，只有引线几何那一层吃 view。 */
  const branchTargets = useMemo(() => {
    const out: Array<{ childSid: number; parentSid: number; blockId: string }> = [];
    for (const e of branchEdges) {
      const parent = regions.find((r) => r.sessionNum === e.parentSid);
      const block = parent?.blocks.find((b) => b.source.messageId === e.nodeMessageId);
      if (block) out.push({ childSid: e.childSid, parentSid: e.parentSid, blockId: block.id });
    }
    return out;
  }, [branchEdges, regions]);
  /** 引线笔道（屏幕坐标）+ 落点：**卷首中线 → 节点缘**。种子取枝卷号：同枝恒同线。 */
  const branchTethers = useMemo(() => {
    const out: Array<{
      childSid: number;
      parentSid: number;
      blockId: string;
      d: string;
      bead: { x: number; y: number };
    }> = [];
    for (const t of branchTargets) {
      const child = regions.find((r) => r.sessionNum === t.childSid);
      const parent = regions.find((r) => r.sessionNum === t.parentSid);
      const hole = parent?.flowGeom.find((g) => g.id === t.blockId);
      // 节点被折叠摘出流栈 / 卷不在场 = 无洞可指（同钉那条腿：宁可没有线，也不指错）
      if (!child || !hole) continue;
      const world = tetherAnchorsAt(
        {
          x: child.anchor.anchorX - child.anchor.width / 2,
          y: child.regionTop - child.folioH / 2,
          w: child.anchor.width,
        },
        hole,
      );
      const art = tetherPath(
        worldToScreen(view, world.from.x, world.from.y),
        worldToScreen(view, world.to.x, world.to.y),
        selSeedOf(`branch-${t.childSid}`),
      );
      out.push({ ...t, d: art.d, bead: art.bead });
    }
    return out;
  }, [branchTargets, regions, view]);

  /** 点引线 = 溯源：飞到父卷那个节点（落节点中线）+ 节点点名一拍（同钉那条腿）。 */
  const onBranchTrace = useCallback(
    (parentSid: number, blockId: string) => {
      const parent = regionsRef.current.find((r) => r.sessionNum === parentSid);
      const hole = parent?.flowGeom.find((g) => g.id === blockId);
      if (!parent || !hole) return;
      setTracedPinId(blockId);
      flyToPoint(String(parentSid), hole.y + hole.h / 2, parent.anchor.anchorX);
    },
    [flyToPoint],
  );

  /* 手动接管视口（拖块用）：取消在途定位飞行 + 清挂起定位——与滚轮/拖画布/
   *  缩放同纪律（use-paper-viewport 内联同款三行）。拖块时指针贴缘自动滚屏，
   *  在途飞行会跟手抢 pan → 块影与落点漂移。 */
  const takeOverViewport = useCallback(() => {
    if (focusRafRef.current) {
      cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = 0;
      focusFlightRef.current.end();
    }
    useCanvasViewStore.getState().requestFocus(null);
  }, [focusRafRef, focusFlightRef]);

  const { dragRef, onBlockMouseDown, onUnpin, onGhostClick, onSidecarRestore, onSidecarPinMouseDown, pinHint } =
    usePaperDrag({
      core,
      canvasRef,
      viewRef,
      regionsRef,
      blockSessionRef,
      sessionsCount: sessions.length,
      takeOverViewport,
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

  const { activateRegion } = useRegionActivation({ core });

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

  /* rework P3-1 → 2026-09-17 浮动化：创作坞几何（坞位 + 坞实测高）驱动让位件重算
   * （口径分家：目次带只按出厂底带；小地图与 CSS 让位件按坞的实际位置——见
   * paper/overlay-context.ts 的 composerDock 注释）。坞位/拖动锁/实测尺寸全归
   * useComposerFloat（槽主人持有；坞本体一字不知）。 */
  const composer = useComposerFloat();
  /** 坞几何（引用稳定，见 use-composer-float）——下发给覆盖层消费面。 */
  const composerDock = composer.dock;
  /** 拖动锁能力位：坞在书眉工具行渲染那枚单字工具（移/锁）。引用必须稳定——
   *  dockContext 一变，坞就随平移帧重渲（低频 context 纪律）。 */
  const composerLock = useMemo(
    () => ({ unlocked: composer.unlocked, toggle: composer.toggleUnlocked }),
    [composer.unlocked, composer.toggleUnlocked],
  );

  /* ── 覆盖层上下文（Stage-4）：创作坞消费低频（动作/活跃），
   * 目次带消费高频（流区几何）。拆两 context 避免创作坞随平移重渲。
   * 2026-09-05 插件化：小地图（paper-minimap）经 minimap 数据面 + glideTo
   * 消费（P2-3 缓存原样下发——引用稳定纪律不破）。 ── */
  const dockContext = useMemo(
    () => ({
      activeSessionId: activeSessionKey,
      flyToPoint,
      glideTo: glideViewTo,
      composerLock,
    }),
    [activeSessionKey, flyToPoint, glideViewTo, composerLock],
  );
  const regionContext = useMemo(
    () => ({
      regions,
      activeSessionId: activeSessionKey,
      viewRect,
      canvasSize,
      composerDock: composerDock,
      foldedOf,
      minimap: { content: minimapContent, geo: minimapGeo },
      inkCache: inkCache.current,
    }),
    [regions, activeSessionKey, viewRect, canvasSize, composerDock, foldedOf, minimapContent, minimapGeo, inkCache],
  );

  /* 拖拽回流判据（渲染面）：与松手定夺共用 `blockReturnsToFlow`（据来源原位量）
   * ——视觉与规则同一把尺子：预览说「回槽」就必须真的回槽（2026-09-17 修正） */

  return (
    <PaperDockContext.Provider value={dockContext}>
      <PaperRegionContext.Provider value={regionContext}>
        <div className="pp-root" ref={paperRootRef}>
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
                    {/* 卷首（folio-head，2026-08-30 自 prototype/lantai.html .folio-head 转录；
                     * 2026-09-16「版心天头」重排，用户拍板 B 案）：玉徽（亭台线稿）居中钤印
                     * 于**版心** + 机读眉行（卷次）+ 题字 + 机读档行（立卷日 · 块数），四行
                     * 同轴居中，底部硬规线 + 左缘朱砂版口钮只画版心宽。
                     * 重排前的病灶：玉徽居中于整张纸（1440 流区中轴）、眉行/题字/档行却左齐
                     * 于纸缘内距 16px，而正文块居中于 720 版心——题字比正文左缘还左 344px
                     * （实测见 prototype/folio-head-ab.html 读数栏）。
                     * 版心盒 = 内层 div（width min(720, 100%)），测高镜像见 measure.ts
                     * folioHeadWidthFor。框体向上扩展包住卷首（界栏护持）。
                     * pointer-events none——点击穿透流区背景，激活语义不变；
                     * 原浮动标签带退役（卷首即卷名，不重复播报）。
                     * 远档（P4c 三档）退场：缩糊的 DOM 卷首不如无——卷名由
                     * InkLayer 地志标签接管（地图标签逻辑，字号有下限）。 */}
                    {!lodFar && (
                      <div className="pp-folio-head">
                        <div className="pp-folio-inner">
                          <span className="pp-yuwei">
                            <Icon name="lantai" size={26} />
                          </span>
                          {/* 卷号**恰出现一次**：有名卷 → 眉行（题字只放卷名）；无名卷 →
                           * 题字落「案卷 N」fallback，眉行退为「兰台 · 案卷」文类行。
                           * 重排前眉行 + 题字 fallback + 档行三处都报卷号（同义反复）。 */}
                          <p className="pp-folio-eyebrow">{r.label ? `案卷 Nº ${r.sessionNum}` : '兰台 · 案卷'}</p>
                          <h2 className="pp-folio-title">{volumeDisplayName(r.label, r.sessionNum)}</h2>
                          <p className="pp-folio-sub">{folioSubLine(r)}</p>
                          {/* 组合芯片（S6 P5a）：**本卷**的组合身份与（空白卷的）拨动入口——
                              绝对定位覆盖在版心右上、与眉行同行、不进高度流水
                              （见 FolioCompositionChip 头注）。作用对象 = 本 region 的卷
                              （r.sessionId），不是"当前活跃卷"。 */}
                          <FolioCompositionChip core={core} sessionId={r.sessionId} />
                        </div>
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

              {/* 纸条（V3a：拷贝语义快照，可拖动、可销毁；工作区级公共物 Stage-5）。
                  LOD 不退场（2026-09-07 用户拍板：LOD 不再隐藏钉在画布上的卡片
                  ——纸条同属钉在纸面的公共物，远缩仍是真纸片，InkLayer 不接管）。 */}
              {canvasStrips.map((s) => {
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
                    {/* 来源行（2026-09-19 便条批）：纸条的报头——抽取那一刻的
                        卷名快照（拷贝语义：源卷改名不追改；旧存档无此字段整行
                        不渲染，不编造来路）。 */}
                    {s.source?.label && <div className="pp-strip-src">摘自 {s.source.label}</div>}
                    {/* P2b 宽度手调面（右缘拖拽） */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                    <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, s.id, 'strip', s.w)} />
                  </div>
                );
              })}

              {/* 公共物 · 孤儿钉（源会话未摊开/已删除，Stage-5）：以快照独立渲染——
               * 公共物不绑会话、钉到拔为止。源会话摊开时由下方流区 pass 渲染活块。
               * LOD 不退场（2026-09-07）：钉在画布上的卡片远缩仍可见可取用。 */}
              {orphanPins.map(([pinId, pin]) => {
                const snapshotBlock = blockFromSnapshot(pinId, pin);
                const isDragged = draggingId === pinId;
                const pos = isDragged && dragPos ? dragPos : { x: pin.x, y: pin.y };
                /* 出处行状态（2026-09-18）：孤儿钉 = 源未在场——已删 / 卷摊开而
                 * 源块不在流内（撤回、压缩）/ 卷未摊开。卷名活卷优先（权威）、
                 * 冻结卷名兜底（pin.source.label，旧存档无此字段 → 档号兜底）。 */
                const source = pin.source;
                const liveSession = source
                  ? sessions.find((s) => String(s.id) === String(source.sessionId))
                  : undefined;
                const provState: ProvenanceState = !source
                  ? 'unspread'
                  : deadOrphanPinIds.has(pinId)
                    ? 'deleted'
                    : liveSession
                      ? 'absent'
                      : 'unspread';
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
                    data-block-id={pinId}
                    onDragStart={(e) => e.preventDefault()}
                    onMouseEnter={() => setTetherPinId(pinId)}
                    onMouseLeave={() => setTetherPinId((cur) => (cur === pinId ? null : cur))}
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
                      prov={
                        source
                          ? provenanceText(
                              volumeDisplayName(liveSession?.label ?? source.label, source.sessionId),
                              provState,
                            )
                          : undefined
                      }
                      provTitle={provenanceTitle(provState)}
                      provTraceable={source != null && provenanceTraceable(provState)}
                      onProvClick={onProvTrace}
                    />
                    {/* P2b 宽度手调面（右缘拖拽） */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                    <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, pinId, 'pin', pin.w)} />
                  </div>
                );
              })}

              {/* 流序列：每流区块按序渲染（视口窗口化——视口外不进 DOM）。
                  2026-09-07 LOD 例外（用户拍板）：远缩档流块 DOM 仍退场（InkLayer
                  墨迹接管），但**钉住块不退**——LOD 不再隐藏钉在画布上的卡片。 */}
              {regions.map((r) =>
                r.blocks.map((b) => {
                  const slot = r.layout.get(b.id);
                  if (!slot || !r.visibleIds.has(b.id)) return null;
                  if (b.state === 'flow') {
                    if (lod) return null; // P4 缩远墨迹：流块 DOM 退场，InkLayer 接管
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
                      blockReturnsToFlow({ x: dragX, y: dragY, w: b.w }, slot);
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
                        data-block-id={b.id}
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
                      {/* 流内占位钮（「已移出 · 点击恢复」）随流块退场——远缩不点它；
                          钉住的块本体照常渲染（见下）。 */}
                      {!lod && (
                        <button
                          type="button"
                          className={`pp-ghost${tracedPinId === b.id ? ' pp-ghost--traced' : ''}`}
                          style={{ left: slot.x, top: slot.y, width: b.w, height: GHOST_H }}
                          onClick={() => onGhostClick(b.id)}
                        >
                          已移出 · 点击恢复
                        </button>
                      )}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: onDragStart 是阻断原生拖拽的防御性 handler */}
                      <div
                        className={`pp-block pp-${b.kind} pp-pinned${isDragged ? ' pp-dragging' : ''}${
                          settleId === b.id ? ' pp-settle' : ''
                        }${r.writingBlockId === b.id ? ' pp-writing' : ''}`}
                        style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: pinW }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-id={b.id}
                        data-block-observed={
                          needsObservedHeight(b.kind, b.asset != null, (b.payload as { text?: string }).text)
                            ? b.id
                            : undefined
                        }
                        ref={blockRootRef}
                        onDragStart={(e) => e.preventDefault()}
                        onMouseEnter={() => setTetherPinId(b.id)}
                        onMouseLeave={() => setTetherPinId((cur) => (cur === b.id ? null : cur))}
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
                          prov={provenanceText(volumeDisplayName(r.label, r.sessionNum), 'live')}
                          provTitle={provenanceTitle('live')}
                          provTraceable
                          onProvClick={onProvTrace}
                        />
                        {/* P2b 宽度手调面（右缘拖拽） */}
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: resize 是拖拽交互面 */}
                        <div className="pp-resize" onMouseDown={(e) => onResizeMouseDown(e, b.id, 'pin', b.w)} />
                      </div>
                    </Fragment>
                  );
                }),
              )}
            </div>

            {/* P4 缩远墨迹：远缩档的屏幕空间 canvas 骨架（pointer-events none）。
                只接管流块墨迹——钉住块/纸条/孤儿钉 DOM 恒在场（2026-09-07 用户
                拍板：LOD 不再隐藏钉在画布上的卡片），本层不画它们（不叠墨）。 */}
            {lod && <InkLayer regionsRef={regionsRef} foldedOf={foldedOf} inkCache={inkCache.current} />}
          </div>

          {/* 引线层（2026-09-18 出处引导，同批按用户判「直线直连有点劣质」重做）：
              hover/溯源中的钉 → 其源洞的一丝朱笔——**洞离屏时线照样出屏**，方向即
              来路（这正是「占位不在视口里就起不到引导作用」的答案）。
              层位 = **屏幕坐标**（同 .pp-sel-ink 那一族）：画布内绝对层，锚点在世界
              里定、投到屏上落墨 ⇒ 墨宽不随缩放变（世界 1px 在 zoom .3 下 = .3px，
              等于没画）。z 4：纸与块之上、坞（5）与一切浮件之下——引线不盖家具。 */}
          {tether && (
            <svg className="pp-tether-layer" aria-hidden="true">
              <path className="pp-tether" d={tether.d} />
              {/* 落点朱点（句读点朱遗意）：线是引，点是落 */}
              <circle className="pp-tether-bead" cx={tether.bead.x} cy={tether.bead.y} r={2.2} />
            </svg>
          )}

          {/* 枝边层（P3 会话树「枝」）：**常显**的一丝朱砂引线——枝卷卷首 → 父卷那个节点。
              同一支笔（.pp-tether 的墨），同一层位（屏幕坐标）。与钉那条腿的差别只有两点：
              ① 常显（树是结构）；② 可点——墨仍是那一丝，命中的是叠在其上的加粗透明
              「受墨带」（.pp-tether-hit，见 CSS 注：不给墨本身加粗，一屏一语言）。
              节点不在视口内时线照样出屏（同款判据）。 */}
          {branchTethers.length > 0 && (
            <svg className="pp-tether-layer pp-branch-layer" aria-label="会话树的枝（引线连回父卷的分叉节点）">
              {branchTethers.map((t) => (
                <g key={t.childSid}>
                  {/* 受墨带：命中的是它，墨仍是那一丝（.pp-tether-hit 注） */}
                  {/* biome-ignore lint/a11y/useSemanticElements: 引线是 SVG 笔道——<button> 进不了 SVG 坐标系（受墨带必须与墨同形）；role/tabIndex/Enter 已补 */}
                  <path
                    className="pp-tether-hit"
                    d={t.d}
                    role="button"
                    tabIndex={0}
                    aria-label={`回到案卷 ${t.childSid} 这一枝的来处：父卷的分叉节点`}
                    onClick={() => onBranchTrace(t.parentSid, t.blockId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onBranchTrace(t.parentSid, t.blockId);
                      }
                    }}
                  />
                  <path className="pp-tether pp-branch-tether" d={t.d} />
                  <circle className="pp-tether-bead" cx={t.bead.x} cy={t.bead.y} r={2.2} />
                </g>
              ))}
            </svg>
          )}

          {/* ── 顶部浮件（2026-09-17 标题栏拆除批）──
              旧书眉（.pp-topbar）是 56px **布局行**，把画布顶缘从窗口顶推开 ⇒
              边缘滚动最自然的动作（指针甩到屏顶）永远落在书眉上（不在画布内，
              悬停档判据直接否掉）——上缘在用户视角里等于没有边缘滚动。现在
              控制件落成右上一枚**覆盖件**（`.pp-canvas` 的兄弟：不属画布 DOM，
              故悬停其上不滚，与目次带同族），画布铺满整窗、顶缘 = 屏缘。
              浮件兼任窗口拖动热区（decorations:false 的标题栏职责）——
              `画布` 二字是浮件上唯一的非交互件，即抓手（另有系统级移动通道）。
              常显、无悬停揭示（见 CSS 头注与 taste-ledger 拖动锁二版教训）。 */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 窗口拖拽热区（decorations:false 的标题栏） */}
          <div className="pp-chrome" onPointerDown={onTopbarPointerDown} onDoubleClick={onTopbarDoubleClick}>
            <span className="pp-title" title="按住拖动窗口（双击最大化）">
              画布
            </span>
            {/* 缩放控件（2026-09-08 缩放舒适度拍板）：−/+ 阶梯步进（ZOOM_STEPS
                常用档）、点读数回 100%——滚轮平滚模式下缩放的零修饰键落点。
                读数 hover 提示保留画布统计；键盘 +/−/0 同语义。 */}
            <div
              className="pp-zoom-ctl"
              title={`画布读数：${totalBlocks} 块 · 已钉 ${totalPinned} · 纸条 ${totalStrips} · 滚轮平滚 / Ctrl+滚轮缩放`}
            >
              <button
                type="button"
                className="pp-zoom-btn"
                aria-label="缩小一档"
                title="缩小一档（键盘 −）"
                onClick={() => stepZoom(-1)}
              >
                −
              </button>
              <button
                type="button"
                className="pp-zoom-val"
                aria-label="缩放回到 100%"
                title="回到 100%（键盘 0）"
                onClick={resetZoom}
              >
                {zoomLabel}
              </button>
              <button
                type="button"
                className="pp-zoom-btn"
                aria-label="放大一档"
                title="放大一档（键盘 +）"
                onClick={() => stepZoom(1)}
              >
                ＋
              </button>
            </div>
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
            <button type="button" className="pp-close" onClick={() => setLeaveConfirm(true)}>
              回首页
            </button>
            <WinControls />
          </div>

          {/* 小地图已插件化（2026-09-05）：paper-minimap 插件经 overlays right-edge 槽贡献，
              本处不再渲染——见 plugins/builtin/paper-minimap/ */}

          {/* 覆盖层贡献行（Stage-4）：创作坞（composer 槽）在底栏，目次带（right-edge 槽）在右缘。
              案头态（v2 + 2026-09-02 拍板 C）：位置两态恒同，只换形态（退匣直书）；
              坞下方出流悬挂签条架（最近三卷续写——出没不推坞位）。
              ⚠ 形态类刻意叫 pp-at-desk 不叫 pp-desk——与世界层桌垫 .pp-desk
              同名会撞车（桌垫 top/height ±200000 接管槽，坞射出屏外，CSS 注释有案）。
              2026-09-17 浮动化：坞位 state 归 useComposerFloat（style 为 undefined
              = 无覆盖 = CSS 默认居中坐底）；**默认锁定**——点坞顶浮现的锁钮（移/锁，
              桌面歌词式）解锁后整坞才是抓手，双击坞体复位（判据在 composer-float.ts
              的 isComposerDragSurface）。 */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 坞槽承载拖坞手势（拖动面判据在 composer-float.ts 的 isComposerDragSurface——锁定态一律放行） */}
          <div
            className={`pp-composer-slot${desk ? ' pp-at-desk' : ''}${
              composer.dragging ? ' pp-composer-dragging' : ''
            }${composer.unlocked ? ' pp-composer-unlocked' : ''}`}
            ref={composer.slotRef}
            style={composer.style}
            onPointerDown={composer.onPointerDown}
            onDoubleClick={composer.onDoubleClick}
          >
            {composerOverlays.map((def) => (
              /* 保险丝 b：覆盖层贡献行（插件面）包边界——创作坞崩溃不卸整树 */
              <PluginBoundary key={def.id} label={`覆盖层 ${def.id}`}>
                <def.component />
              </PluginBoundary>
            ))}
            {desk && <DeskShelf core={core} />}
            {/* 拖动锁按钮**不在这里**（2026-09-17 二版）：它归坞的书眉工具行，
                由坞本体渲染（`PaperDockContext.composerLock` 能力位——锁态与写面在
                本槽主人手里）。曾试过「槽里浮一枚 hover 小钮」，两个病灶：浮在坞外
                与坞之间有缝、悬停链被掐断（用户「还没挪过去就消失了」），且外观
                与坞的语言不合（用户「太难看了」）。 */}
          </div>
          {edgeOverlays.map((def) => (
            <PluginBoundary key={def.id} label={`边缘层 ${def.id}`}>
              <def.component />
            </PluginBoundary>
          ))}
          {/* 回首页确认（2026-09-08）：回首页 = 真关工作区（停 watcher/引擎/Agent），
           * 有副作用的离开操作——确认后才执行 leaveToHome。无活动工作区同样确认
           * （用户拍板），文案区分两种情形。放 pp-root 内——.cd-overlay 的
           * absolute 遮罩以 pp-root（fixed）为定位父，且样式随本产物 CSS 注入。 */}
          <ConfirmDialog
            open={leaveConfirm}
            title="回首页？"
            message={
              projectPath
                ? '离开将关闭当前工作区的图谱引擎与后台分析（会话与画布会自动保存）。确定回首页？'
                : '确定回首页？'
            }
            confirmLabel="回首页并关闭工作区"
            cancelLabel="留在画布"
            tone="danger"
            onConfirm={forceLeave}
            onCancel={() => setLeaveConfirm(false)}
          />
        </div>
      </PaperRegionContext.Provider>
      <ToastHost />
    </PaperDockContext.Provider>
  );
}
