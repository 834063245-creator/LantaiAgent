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

import {
  type CSSProperties,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MinimapRegionInput } from '../../../paper/minimap-core';
import type {
  AssistantMessage,
  BlockMeasureCache,
  CanvasStore,
  ChatMessage,
  FlowGeom,
  MaskRect,
  MessageTranslateCache,
  PaperStrip,
  PinnedGeom,
  RegionHitRect,
  RegionView,
  SourcedBlock,
  StreamRegionState,
  TextPart,
  UserMessage,
  WorkUnit,
} from './host';
import {
  ANCHOR,
  activeOverlayContributions,
  activeSpace,
  agentSessionState,
  blockFromSnapshot,
  clampRegionW,
  classifyDropZone,
  clearPaperMeasureCache,
  collapseToolGroups,
  createBlockMeasureCache,
  createFocusFlightScheduler,
  createInkCache,
  createSettleSelector,
  defaultFolded,
  defaultRegionFor,
  foldLabel,
  getCanvasStore,
  getChatStore,
  groupWorkUnits,
  hitRegionAtWorld,
  Icon,
  injectPaperTokens,
  isFoldable,
  layoutRegion,
  lodActive,
  makeStrip,
  measureBlockHeightCached,
  measureFolioHeadHeight,
  mergeSelectionLines,
  msgStoreFor,
  nearestFreeRegion,
  needsObservedHeight,
  PaperDockContext,
  PaperRegionContext,
  PluginBoundary,
  panBy,
  REGION_CONTENT_MARGIN,
  reportObservedBlockHeight,
  resolveAssetBlock,
  resolveRenderer,
  rhythmAssign,
  STREAM_REGION,
  scheduleCanvasSave,
  screenToWorld,
  sealedMessageIdsOf,
  selectionMaskRects,
  selInkPaths,
  selSeedOf,
  sheetCharacter,
  snapshotFromBlock,
  stashStripPositionAt,
  subscribeObservedBlockHeights,
  subscribeOverlayContributions,
  translateMessagesCached,
  USER_SHRINK_MIN_W,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
  useUpdateStore,
  viewFocusRegion,
  viewForAnchor,
  viewportCenterWorld,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
  WinControls,
  wheelFactor,
  writingBlockIdOf,
  zoomAt,
} from './host';
import { InkLayer } from './InkLayer';
import { StatusLine } from './StatusLine';
import { ToastHost } from './ToastHost';
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
};

/** 消息操作项（施工单 #5）：块 hover 出现的操作按钮。
 *  disabled/title：状态类操作（改/重发/重试）在该轮已无法唯一定位撤回时
 *  置灰降级（2026-09-01 重发锚点工程——绝不撤错轮）。 */
interface BlockOp {
  key: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  title?: string;
}

/** 从消息提取可复制的正文文本（text part 拼接）。 */
function messageCopyText(msg: ChatMessage): string {
  if (msg.role !== 'assistant') return msg.text;
  return msg.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

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

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 空运行集（引用恒定）——runningSessions state 的「无在跑」基值。 */
const NO_RUNNING_SESSIONS: ReadonlySet<number> = new Set<number>();
/** 钉住可发现性一次性眉批的 localStorage 旗标（毒化容忍——读写全包 try，
 * 命名同创作坞 lantai.hint.historySeen 族）。 */
const PIN_HINT_KEY = 'lantai.hint.pinDragSeen';
/** 自动选中命中区向上外扩余量（px，世界单位）：卷首头（folio-head）在
 *  regionTop 之上实测 folioH——命中区再外扩 40px 兜住卷首上缘的呼吸带，
 *  用户常把视口中心对准卷首，不扩会“空白保持当前”不切 */
const REGION_HIT_LABEL_BAND = 40;
/** 手动切换后抑制自动选中的窗口（ms）：显式选会话后给 800ms 喘息，
 * 避免“侧边栏点 A、视口中心还在 B，400ms 后被自动选中拉回 B”的冲突感 */
const MANUAL_GUARD_MS = 800;
/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3） */
const GHOST_H = 32;
/** 块宽兜底（2026-09-03 级联防御）：流区宽脏/NaN 时回落默认版心宽
 *  （与 paper/block-model DEFAULT_BLOCK_WIDTH 同值，本地不引 host）。 */
const FALLBACK_BLOCK_W = 720;
/** 眉批快照钉宽（P5：独立夹注快照落纸宽度） */
const SIDECAR_PIN_W = 320;
/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
const EMPTY_OPS: BlockOp[] = [];

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
 *  = 上一帧产物直接复用（平移帧零重建 + 引用稳定喂给下游 memo 链）。 */
function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 面板核类型（useCoreStore 所持 core 的非空形状）——DeskShelf prop 用。 */
type PaperCore = NonNullable<ReturnType<typeof useCoreStore.getState>['core']>;

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
  const opsCacheRef = useRef<Map<string, { msg: ChatMessage; ops: BlockOp[]; stamp: string; regionMsgs: unknown }>>(
    new Map(),
  );
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

  /* R2 视口持久化（2026-09-05）：view 变化（pan/zoom）→ 防抖落盘 canvas.json
   * （复用 scheduleCanvasSave 500ms 窗口）。平移/缩放是高频写——防抖合并；
   * 恢复视图（restoreView）也触发，但用户不动视口时不会反复写。 */
  useEffect(() => {
    if (!core) return;
    let saveTimerRef = 0;
    const sync = () => {
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
      saveTimerRef = window.setTimeout(() => {
        const pp = useShellStore.getState().projectPath;
        if (pp) void scheduleCanvasSave(core.panelId, pp);
      }, 500);
    };
    sync();
    const un = useCanvasViewStore.subscribe(sync);
    return () => {
      un();
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
    };
  }, [core]);

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

  /* 尺寸变化 = 世界点守恒（2026-09-01 视角抢夺修复）：旧实现任何尺寸变化都把
   * pan 重置回默认锚点——用户视角被暴力抢回原点（模型下拉开合/窗口缩放/侧栏
   * 开合等一切引发画布 1px 尺寸差的场景全中招）。新语义：保持「锚点屏幕位置
   * 下的世界坐标」跨尺寸不动；只有首测（无前尺寸）才落默认锚点 pan。
   * ⚠ 首测读 render 闭包值（挂载时 = store 陈旧值/默认 800×600），RO effect
   * 先跑会同步写入真实尺寸——随后本 effect 二跑守恒从旧锚点 (400,504) 推世界
   * 点。此自洽链路期间**禁止任何其它 effect 抢先改写 pan**（2026-09-02 首挂
   * 视角错位尸检：旧「重挂回锚」effect 用 live 尺寸抢先落锚 (632,613)，守恒
   * 二跑从被改的 pan 反推出虚构世界点 (−232,−109)，把新旧锚差 (+232,+109)
   * 当用户平移补偿回去 → 首次进画布 pan=(864,722) 偏移，重进（store 尺寸已
   * 持久）反而正常——间歇性病灶的来源）。 */
  const prevCanvasSizeRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const cur = { w: canvasSize.w, h: canvasSize.h };
    const prev = prevCanvasSizeRef.current;
    prevCanvasSizeRef.current = cur;
    if (!prev) {
      // R2 冷启动聚焦（2026-09-05）：恢复过视口（canvas.json view 字段 →
      // loadCanvasFromDisk 已 restoreView 写进 store）→ 用恢复值，不落默认锚
      //（restoredView 非空 = 本次恢复的视图尚未被用户动过）；否则照旧落锚。
      const restored = useCanvasViewStore.getState().restoredView;
      if (!restored) {
        const { panX, panY } = viewForAnchor(cur.w, cur.h);
        setView((v) => ({ ...v, panX, panY }));
      }
      return;
    }
    if (prev.w === cur.w && prev.h === cur.h) return;
    const v = useCanvasViewStore.getState().view;
    const a0 = { x: prev.w / 2, y: viewForAnchor(prev.w, prev.h).panY };
    const world = { x: (a0.x - v.panX) / v.zoom, y: (a0.y - v.panY) / v.zoom };
    const a1 = { x: cur.w / 2, y: viewForAnchor(cur.w, cur.h).panY };
    setView((old) => ({ ...old, panX: a1.x - world.x * old.zoom, panY: a1.y - world.y * old.zoom }));
  }, [canvasSize.w, canvasSize.h, setView]);

  /* 画布重挂 = 干净的定位面：清掉上一轮残留定位请求（2026-09-02 修复：原版
   * 还在此处 setView 回锚——与上方守恒 effect 首测分支职责重复，且用 live
   * 尺寸抢先落锚破坏守恒自洽（见上注释尸检）。回锚职责收归守恒 effect：每次
   * 挂载 prevCanvasSizeRef 归 null，首测分支天然落锚（重挂时闭包 = store
   * 持久尺寸，即时回锚，语义等价且无竞态）。
   * R2 冷启动聚焦兜底（2026-09-05）：本工作区画布无恢复视图（旧版 canvas.json
   * 无 view 字段）且摊开卷非空 → 定位到活跃卷（或首个摊开卷）——不裸站原点。
   * 有恢复视图（新数据）→ 视角已在上次视野，只清残留 pending。 */
  useEffect(() => {
    const cvs = useCanvasViewStore.getState();
    if (!cvs.restoredView && core) {
      const canvas = getCanvasStore(core.panelId).getState();
      const spreadKeys = Object.keys(canvas.spread);
      if (spreadKeys.length > 0) {
        const target =
          canvas.activeSessionId && canvas.spread[canvas.activeSessionId] ? canvas.activeSessionId : spreadKeys[0];
        cvs.requestFocus(target);
        return;
      }
    }
    cvs.requestFocus(null);
  }, [core]);

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

  /* ── 拖动渲染态（声明在 regions memo 之前——memo 消费拖拽保活/带显形输入）── */
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
    // （rAF 直读 regionsRef）不因 stub 闪断。活跃卷 + 拖拽/缩放中的卷永不
    // stub（小地图活跃墨迹 / 跟手不缺）。首见卷（extent 未知）全量构建。
    const STUB_MX = 900;
    const STUB_MY = 1200;
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
          anchor,
          ...STUB_EMPTIES,
          regionTop: known.extent.y0,
          regionBottom: anchor.anchorY,
          regionHeight: Math.max(0, anchor.anchorY - known.extent.y0) + 72,
          folioH: 72,
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

        let top = 0;
        for (const g of flowGeom) top = Math.min(top, g.y);
        const regionTop = top;
        // 卷首头高度：标题按流区可用宽实测（folio 头左右内距 16×2，镜像 .pp-folio-head padding）
        const folioH = measureFolioHeadHeight(s.label || `案卷 ${s.id}`, anchor.width - 32);
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
              y0: anchor.anchorY - 200,
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
      coreKey.push(sid, c.blocks);

      out.push({
        sessionId: sid,
        sessionNum: s.id,
        label: s.label,
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
    // （拖块手势等）读 .current 即时值，引用替换语义不变。
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
  ]);

  regionsRef.current = regions;

  /* 小地图墨迹快照（R3 多卷版 2026-09-03）：MinimapView 的 canvas 重画从
   * regions 外层引用（每 pan 帧换）收到窄到本快照——sameKey 复合键缓存
   * （openBlockIds 同款）：仅当内容侧（blocks/layout/extent/flowGeom/…）
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

  /* 公共物 · 纸条（工作区级宿主，Stage-5）：不再随流区归属——独立渲染层 */
  const canvasStrips = canvasState.strips;
  /* 公共物 · 孤儿钉：源会话未摊开/已删除，或源块当前不在摊开会话的转译结果里
   * （消息撤回等）——以快照渲染的独立钉层（公共物不绑会话，钉到拔为止） */
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
      // R1 真位置守卫（2026-09-05，时序竞态修复）：新建/未摊开卷在 spread 无
      // 持久位置时（落位 effect 尚未跑，regions memo 只能拿 defaultRegionFor
      // 网格占位）**不飞**——pending 保持，落位 effect 把卷摆到视口中心后
      // regions 变化触发补飞（下方第二个 effect）。否则视角会飞往原点附近
      // 网格位，而卷实际在视口中心——「定位不到卷上」的病根。
      if (!core) return;
      const spread = getCanvasStore(core.panelId).getState().spread;
      if (!spread[sessionId]) return;
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (region) flyToPoint(sessionId, region.anchor.anchorY);
    },
    [flyToPoint, core],
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
    // R1（2026-09-05）：spread 尚无目标位置 = 落位 effect 未跑（新建/未摊开
    // 卷）→ 不重判（flyToRegion 内部守卫已挡）；位置落定后 regions 变化
    // （canvasState.spread 写入 → regions memo 重算）本 effect 重跑补飞。
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

  /* 消息操作（施工单 #5 → 2026-08-31 修订）：抄恒有；状态类操作（改/重发/
   *  重试）只出现在各卷最新一条对应角色消息上——且 assistant 重试要求它是
   *  全卷最后一条（后面还挂着新来文时回滚语义不可达）。过时块上这些按钮
   *  是无意义的深回滚入口（用户拍板摘除）。ops 按块 id 记忆（opsCacheRef，
   *  stamp 随最新消息判定与可撤态变化失效）——点击时经 regionMsgs 取最新消息 */
  const msgOpsFor = useCallback(
    (msg: ChatMessage, stateOps: boolean, retrace: boolean): BlockOp[] => {
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
      // 可撤态置灰降级（沙盒映射定位失败 = 会话已压缩/上下文已变化——
      // 按钮可留待重派生自愈，但绝不撤错轮）
      const gone = (ok: boolean) => ({
        disabled: !ok,
        title: ok ? undefined : '该轮已不可重发（会话已压缩）',
      });
      if (msg.role === 'user') {
        if (stateOps) {
          const latestUser = (): UserMessage => {
            for (const r of regionsRef.current) {
              const m = regionMsgs[r.sessionNum]?.messages.find((x) => x._id === msg._id);
              if (m && m.role === 'user') return m;
            }
            return msg as UserMessage;
          };
          ops.push({ key: 'edit', label: '改', run: () => core.editUserMessage(latestUser()), ...gone(retrace) });
          ops.push({ key: 'resend', label: '重发', run: () => core.resendUserMessage(latestUser()), ...gone(retrace) });
        }
      } else if (msg.role === 'assistant') {
        if (stateOps) {
          const latestAsst = (): AssistantMessage => {
            for (const r of regionsRef.current) {
              const m = regionMsgs[r.sessionNum]?.messages.find((x) => x._id === msg._id);
              if (m && m.role === 'assistant') return m;
            }
            return msg as AssistantMessage;
          };
          ops.push({ key: 'retry', label: '重试', run: () => core.retryAssistant(latestAsst()), ...gone(retrace) });
        }
      }
      const text = messageCopyText(latestMsg);
      if (text.trim()) ops.push({ key: 'copy', label: '抄', run: () => core.copyText(messageCopyText(latest())) });
      return ops;
    },
    [core, regionMsgs],
  );
  const opsByBlockCacheRef = useRef<{ key: unknown[]; map: Map<string, BlockOp[]> } | null>(null);
  const opsByBlock = useMemo(() => {
    // P2-3：复合键复用——输入不变（平移帧：blocks 引用稳定 + regionMsgs 同一
    // 性）时整 Map 原样复用，O(总块数) 的 byId 建表/最新角色扫尾/缓存比对
    // 全免。retrace 判定只在内容变化时重算（stamp 语义不变）。
    const key: unknown[] = [regionMsgs, core, msgOpsFor];
    for (const r of regions) key.push(r.sessionNum, r.blocks);
    const prev = opsByBlockCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev.map;
    const map = new Map<string, BlockOp[]>();
    if (!core) {
      opsByBlockCacheRef.current = { key, map };
      return map;
    }
    for (const r of regions) {
      const msgs = regionMsgs[r.sessionNum]?.messages ?? [];
      const byId = new Map<string, ChatMessage>();
      for (const m of msgs) byId.set(m._id, m);
      // 各卷最新角色消息（倒序首见）——状态类操作按钮的准入判定
      let lastUser: ChatMessage | undefined;
      let lastAsst: ChatMessage | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!lastUser && m.role === 'user') lastUser = m;
        if (!lastAsst && m.role === 'assistant') lastAsst = m;
        if (lastUser && lastAsst) break;
      }
      const lastId = msgs[msgs.length - 1]?._id;
      for (const b of r.blocks) {
        const msg = byId.get(b.source.messageId);
        if (!msg) continue;
        const stateOps =
          (msg.role === 'user' && lastUser?._id === msg._id) ||
          (msg.role === 'assistant' && lastAsst?._id === msg._id && lastId === msg._id);
        // 可撤态入缓存戳——压缩/漂移后置灰态随渲染刷新（不粘旧判定）
        let retrace = false;
        if (stateOps && msg.role === 'user') retrace = core.canRetraceUserMessage(msg);
        else if (stateOps && msg.role === 'assistant') retrace = core.canRetryAssistant(msg);
        const stamp = stateOps ? (retrace ? '1' : '0') : '';
        const hit = opsCacheRef.current.get(b.id);
        if (hit && hit.msg === msg && hit.stamp === stamp && hit.regionMsgs === regionMsgs) {
          // 2026-09-01 审计：缓存键补 regionMsgs 同一性——ops 闭包捕获建时的
          // regionMsgs，消息表换新而 msg/stamp 未变时旧 ops 的 latest() 会读到
          // 陈旧会话消息表。
          map.set(b.id, hit.ops);
        } else {
          const ops = msgOpsFor(msg, stateOps, retrace);
          opsCacheRef.current.set(b.id, { msg, ops, stamp, regionMsgs });
          map.set(b.id, ops);
        }
      }
    }
    opsByBlockCacheRef.current = { key, map };
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
      // R3.5 浮动 minimap：滚轮在 minimap 上 = 缩放 minimap 本体，不缩放画布
      if (t?.closest('.pp-minimap')) return;
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
    /* 材质批修复（2026-09-01）：平移 setView 按 rAF 帧合并——mousemove 只累计
     * 增量，每帧至多一次 setView。此前鼠标事件频率直接打满同步重渲染，区域
     * 巨大（万级像素高）+ 目次带重渲染时更新嵌套爆 React #185 上限，帧呈现
     * 饿死 = 整窗冻在旧帧（实机打回「流区透明」即此：新样式永远排不上屏）。 */
    let raf = 0;
    let pendX = 0;
    let pendY = 0;
    const flush = () => {
      raf = 0;
      const dx = pendX;
      const dy = pendY;
      pendX = 0;
      pendY = 0;
      if (dx !== 0 || dy !== 0) setView((v) => panBy(v, dx, dy));
    };
    const move = (e: MouseEvent) => {
      const p = panningRef.current;
      if (!p) return;
      pendX += e.clientX - p.lastX;
      pendY += e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      // ⚠ 必须清 panningRef：否则 moving 里 panningRef.current != null 恒 true，
      // 第一次拖画布后自动选中永远被当成“平移中”而取消计时。
      panningRef.current = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush(); // 松手把尾巴增量落完，视角精确停在指针下
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [panning, setView]);

  /* ── 拖块（D-R2-1 拖出钉住，2026-09-05 松手定夺改造）：阈值起纯预览 →
   * 全程跟手 → 松手定夺（带外落钉 / 带内取消回槽）。拖动中 flow 块 state
   * 不变（仍在流分支渲染），transform 覆盖为跟手位；来源流区挂带显形
   * （pp-region--band），落点悬回带内时块影转「回流」态（pp-drag-returning）。
   * Stage-5：钉住块 = 工作区级公共物。源会话未摊开的孤儿钉（快照块）同样
   * 可拖（sessionId 缺省）——拖动更新 canvas.pins 位置，不重新钉。 */
  const dragRef = useRef<{
    id: string;
    sessionId: string | undefined;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    /** instant = 首动即建钉（眉批撕出族——携带预览依赖孤儿钉渲染，纯预览
     *  会全程无像；取消端 = up 里 commitPinned(null) 拔钉还原）。 */
    instant: boolean;
    bw: number;
    offX: number;
    offY: number;
    block: SourcedBlock | null;
  } | null>(null);
  /* 拖动渲染态（draggingId/dragPos/dragSource/bandSessionId/settleId）声明
   * 在 regions memo 之前——memo 消费拖拽保活/带显形输入（声明序约束）。 */

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
      instant: false, // 整块拖出 = 松手定夺（纯预览 → 带外落钉/带内取消）
      bw: block.w,
      offX: w.x - rx,
      offY: w.y - ry,
      block,
    };
  }, []);

  /** 落定钉住：新钉 = 捕获快照 + 活引用源；已钉 = 移位置；pos null = 收回
   *  （眉批 instant 路径的取消端）。源会话缺省（孤儿钉）= 只移动既有钉，不新建。 */
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
        setDragSource({ sessionId: d.sessionId, wasFlow: d.wasFlow });
        setBandSessionId(d.sessionId ?? null);
        // 眉批 instant 族：首动即建钉（携带预览 = 孤儿钉跟手，眉批位同帧
        // 换「已移出」占位）——撕出批注的揭起手感，与抽纸条 lift mask 同族。
        if (d.instant) {
          commitPinned(d.sessionId, d.id, { x: w.x - d.offX, y: w.y - d.offY }, d.block);
        }
      }
      setDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      setDragSource(null);
      setBandSessionId(null);
      setDragPos(null);
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      const fx = w.x - d.offX;
      const fy = w.y - d.offY;
      const region = d.sessionId ? regionsRef.current.find((r) => r.sessionId === d.sessionId) : undefined;
      const bandCenter = region?.anchor.anchorX ?? 0;
      // 松手定夺（2026-09-05）：带外落钉（新钉 = 快照 + 活引用源；已钉 =
      // 移位置）；带内且原为 flow → 取消回槽——非 instant 族纯预览结束，无
      // 状态变更（不建钉、不挖洞、流布局全程未动）；instant 族（眉批）首动
      // 已建钉，取消端 = 拔钉还原占位。孤儿钉无来源带，恒落钉。
      if (d.wasFlow && d.sessionId && Math.abs(fx - bandCenter) <= ANCHOR.bandHalfWidth) {
        if (d.instant) commitPinned(d.sessionId, d.id, null);
        return;
      }
      commitPinned(d.sessionId, d.id, { x: fx, y: fy }, d.block);
      if (!d.instant) {
        setSettleId(d.id);
        window.setTimeout(() => setSettleId((cur) => (cur === d.id ? null : cur)), 400);
      }
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

  /* 眉批恢复（P5 → 2026-08-31 移出语义）：拔掉 `${blockId}:sc` 快照钉——
   * 眉批栏「已移出」占位还原为夹注全文（与流内 ghost 点击恢复同一手势语言） */
  const onSidecarRestore = useCallback((b: SourcedBlock) => onUnpin(`${b.id}:sc`), [onUnpin]);

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

  /* ── 钉住可发现性（一次性眉批，2026-09-05）：有摊开卷且从未提示过 →
   * 浮现 6s（localStorage 旗标，毒化容忍——创作坞历史眉批同款范式）。
   * 提示长在功能所在处：文类签 = 块左缘拖出把手。 ── */
  const [pinHint, setPinHint] = useState(false);
  const pinHintShownRef = useRef(false);
  useEffect(() => {
    if (sessions.length === 0 || pinHintShownRef.current) return;
    pinHintShownRef.current = true;
    let seen = true;
    try {
      seen = localStorage.getItem(PIN_HINT_KEY) === '1';
    } catch {
      seen = true; // 存储不可用 = 不提示（宁缺勿噪）
    }
    if (seen) return;
    try {
      localStorage.setItem(PIN_HINT_KEY, '1');
    } catch {
      // 写不进也照提示一次（ref 兜底本会话不再重复）
    }
    setPinHint(true);
    window.setTimeout(() => setPinHint(false), 6000);
  }, [sessions.length]);

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
   * Stage-5：公共物（纸条 + 孤儿钉快照）同样计入画布范围。
   * P2-3：包围盒只依赖内容侧（几何/纸条/孤儿钉）——复合键缓存，平移帧
   * 零重扫（O(总块数) 降为 O(卷数) 键比较）；视口框随帧轻包装。 */
  const minimapContentCacheRef = useRef<{
    key: unknown[];
    content: { x0: number; y0: number; x1: number; y1: number };
  } | null>(null);
  const minimapContent = useMemo(() => {
    const key: unknown[] = [canvasStrips, orphanPins];
    for (const r of regions) key.push(r.flowGeom, r.pinnedGeom, r.extent);
    const prev = minimapContentCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev.content;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of regions) {
      // P2-2：stub 卷用最近已知包围盒（离屏不增长——回场刷新）
      if (r.stubbed && r.extent) {
        x0 = Math.min(x0, r.extent.x0);
        y0 = Math.min(y0, r.extent.y0);
        x1 = Math.max(x1, r.extent.x1);
        y1 = Math.max(y1, r.extent.y1);
        continue;
      }
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
      // 空画布兜底（无卷/纸条/钉）：不要用极窄固定块（会把视口框 scale 放大
      // 成溢出容器的巨大红框）——以视口为基准外扩一圈，保证比例自然。
      // ⚠ 空兜底不写缓存（viewRect 每帧变——写缓存会让内容侧键命中旧值）。
      const vx0 = viewRect.x0;
      const vy0 = viewRect.y0;
      const vx1 = viewRect.x1;
      const vy1 = viewRect.y1;
      const vw = Math.max(800, vx1 - vx0);
      const vh = Math.max(600, vy1 - vy0);
      return {
        x0: (vx0 + vx1) / 2 - vw,
        y0: (vy0 + vy1) / 2 - vh / 2,
        x1: (vx0 + vx1) / 2 + vw,
        y1: (vy0 + vy1) / 2 + vh / 2,
      };
    }
    const content = { x0, y0, x1, y1 };
    minimapContentCacheRef.current = { key, content };
    return content;
  }, [regions, canvasStrips, orphanPins, viewRect]);

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
      setSettleId(strip.id); // 成条落定「放下」手感（刀3）
      window.setTimeout(() => setSettleId((cur) => (cur === strip.id ? null : cur)), 400);
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

  /* A：拖拽路径（mousedown/mousemove/mouseup 全局通道）。2026-09-05 路径 B
   * 退役（plan：pin-strip-rework §0 用户拍板）：拖选跨带松手不再成条——拖选
   * 只做选择（划大段字复制绝无误触）；抽纸条唯二入口 = 按住已有选区拖出
   * （本路径）+ 选中浮钮（B 段）。拖选幽灵同步效果一并退役（它只服务路径 B）。 */
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
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
      setBandSessionId(snap.sessionId ?? null); // 带显形：揭起即亮来源流区
      sel.removeAllRanges();
      e.preventDefault();
    };

    const move = (e: MouseEvent) => {
      const w = toWorldInCanvas(e.clientX, e.clientY);
      if (!w || !liftRef.current) {
        setGhost(null);
        return;
      }
      const center = bandCenterOf(liftRef.current.sessionId);
      const zone = classifyDropZone(w.x - center, ANCHOR.bandHalfWidth);
      setGhost({ x: w.x, y: w.y, zone });
    };

    const up = (e: MouseEvent) => {
      setGhost(null);
      setBandSessionId(null);
      const lift = liftRef.current;
      liftRef.current = null;
      if (!lift) return;
      const w = toWorldInCanvas(e.clientX, e.clientY);
      const center = bandCenterOf(lift.sessionId);
      if (w && lift.sessionId && classifyDropZone(w.x - center, ANCHOR.bandHalfWidth) === 'strip') {
        spawnStrip(lift.sessionId, lift.text, lift.messageId, w.x, w.y);
        completeLiftMask(); // 成条：原地遮罩淡出（揭走动作完成）
      } else if (lift.rect) {
        restoreSelectionByRect(lift.rect);
        clearLiftMask(); // 取消：选区原样恢复，遮罩即撤（无事发生）
      }
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
  /* 划词朱线（2026-09-02 视觉迭代）：选区在画布内即记录（不限块级——跨块选区也要有线）；
   * Range 存活期随 DOM 变化自刷新矩形，渲染期现取（同 fabPos 范式）。
   * 折叠/画布外（composer、菜单）清线——原生洗底只在流区外保留。 */
  const [selInk, setSelInk] = useState<Range | null>(null);
  useEffect(() => {
    const onSelChange = () => {
      const selAll = window.getSelection();
      const live = selAll && selAll.rangeCount > 0 ? selAll.getRangeAt(0) : null;
      const anc = live?.commonAncestorContainer;
      const ancEl = anc instanceof Element ? anc : (anc?.parentElement ?? null);
      const inCanvas = !!(ancEl && canvasRef.current?.contains(ancEl));
      setSelInk(inCanvas && live && !live.collapsed ? live.cloneRange() : null);
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

  /* 纸条销毁两击确认（2026-09-05，plan §1.2）：快照语义删了即没了——首击
   * 进确认态（按钮变「确认？」），3s 超时回退，再击才真删。 */
  const [stripConfirmId, setStripConfirmId] = useState<string | null>(null);
  const stripConfirmTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(stripConfirmTimerRef.current), []);
  const onRemoveStrip = useCallback(
    (id: string) => {
      if (stripConfirmId !== id) {
        setStripConfirmId(id);
        window.clearTimeout(stripConfirmTimerRef.current);
        stripConfirmTimerRef.current = window.setTimeout(() => setStripConfirmId(null), 3000);
        return;
      }
      window.clearTimeout(stripConfirmTimerRef.current);
      setStripConfirmId(null);
      if (!core) return;
      getCanvasStore(core.panelId).getState().removeStrip(id);
    },
    [stripConfirmId, core],
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

  /* ── 眉批拖出钉画布（P5 → 2026-08-31 移出语义修订）：复用整块拖拽机制
   * （D-R2-1 同款手势语言）——首动即建钉：快照从眉批栏原位跟手揭起（offX/offY
   * 锚在眉批栏世界位），流内眉批位同帧换「已移出」占位（sidecarOutOf），
   * 拖回流带松手 = 取消（占位还原）；快照仍是拷贝语义公共物。
   * 点击（未过阈值）= 无操作，与整块拖拽一致。 ── */
  const onSidecarPinMouseDown = useCallback((e: React.MouseEvent, block: SourcedBlock) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const sidecar = (block.payload as { sidecar?: { text: string } }).sidecar;
    if (!sidecar?.text) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const v = viewRef.current;
    const grab = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
    // 起拖锚点 = 眉批栏左上角世界坐标——快照起拖位与原位重合（「揭起」非跳到光标）
    const asideEl = (e.currentTarget as HTMLElement).closest('.pp-marginalia');
    const anchor = asideEl
      ? screenToWorld(
          v,
          asideEl.getBoundingClientRect().left - rect.left,
          asideEl.getBoundingClientRect().top - rect.top,
        )
      : grab;
    dragRef.current = {
      id: `${block.id}:sc`,
      sessionId: blockSessionRef.current.get(block.id),
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      wasFlow: true, // 回带取消端 = up 拔钉还原占位（见拖块 effect 注）
      instant: true, // 眉批撕出族：携带预览 = 孤儿钉跟手（见拖块 effect 注）
      bw: SIDECAR_PIN_W,
      offX: grab.x - anchor.x,
      offY: grab.y - anchor.y,
      block: {
        id: `${block.id}:sc`,
        kind: 'reasoning',
        payload: { text: sidecar.text },
        state: 'flow',
        x: anchor.x,
        y: anchor.y,
        w: SIDECAR_PIN_W,
        source: block.source,
      },
    };
  }, []);

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

  /* ── 运行态（2026-09-06 纸面运行态升格）：任一摊开卷在跑 → 画布底缘
   *  石青细线呼吸（.pp-canvas.pp-stream-live，机=石青语义）+ 各在跑卷尾
   *  落笔点 + 书眉「行卷中」。订阅面 = subscribeExecAll（exec 实例表变更 →
   *  全部重挂 + 既有实例起停——实例迟到/被换时捕获式订阅指空对象，start()
   *  不可见）+ sess 列表（合卷/改名重算清单）。单一真相 = runningSessions
   *  集合，streamLive（呼吸线）由 size 派生，不再单独持态。 ── */
  const [runningSessions, setRunningSessions] = useState<ReadonlySet<number>>(NO_RUNNING_SESSIONS);
  useEffect(() => {
    if (!core) {
      setRunningSessions(NO_RUNNING_SESSIONS);
      return;
    }
    const sync = () => {
      const st = getChatStore(core.panelId).sess.getState();
      const next = new Set<number>();
      for (const s of st.sessions) {
        if (agentSessionState.getExec(core.panelId, s.id)?.isRunning) next.add(s.id);
      }
      // 引用稳定守卫：rehang 期 sync 每实例表 bump 必发，无变化不动引用——
      // 下游 memo 链（含本 memo 外的 TocStrip 等）不因空转重渲。
      setRunningSessions((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };
    const unExecAll = agentSessionState.subscribeExecAll(core.panelId, sync);
    const unSess = getChatStore(core.panelId).sess.subscribe(sync);
    return () => {
      unExecAll();
      unSess();
    };
  }, [core]);
  const streamLive = runningSessions.size > 0;
  /** 活跃卷在跑——书眉「行卷中」（StatusLine 消费）。 */
  const activeRunning = activeSessionId != null && runningSessions.has(activeSessionId);

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
    [activeSessionKey, inputLocked, flyToPoint, glideViewTo],
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
      inkCache: inkCacheRef.current,
    }),
    [regions, activeSessionKey, viewRect, canvasSize, composerHeight, foldedOf, minimapContent, minimapGeo],
  );

  /* 划词朱线（2026-09-02 视觉迭代）：行合并 + 手写路径渲染期现算——
   * Range 活矩形随视口刷新（同 fabPos 范式）；种子 = 选区文本 hash（同选区恒同线）。
   * 行数封顶 400：超大选区只画前 400 行（SVG 路径量护栏，选区监视不拖垮渲染）。 */
  let selInkArt: { mains: string[]; echoes: string[] } | null = null;
  if (selInk) {
    const inkLines = mergeSelectionLines(selInk.getClientRects());
    if (inkLines.length > 0 && inkLines.length <= 400) selInkArt = selInkPaths(inkLines, selSeedOf(selInk.toString()));
  }

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
                    {/* 落笔点（2026-09-06 纸面运行态）：本卷在跑且尾部无湿墨
                     * （模型思考中/工具执行中——下一块墨将落此处）→ 卷轴线
                     * 锚线下方石青方点呼吸。湿墨尾点在场时让位（书写中的正文
                     * 自带活信号，双点成噪声）。LOD 缩远不画（方点随缩放变
                     * 亚像素）。运行而纸面静止的「死寂窗口」由此被照亮。 */}
                    {!lod && runningSessions.has(r.sessionNum) && !r.writingBlockId && (
                      <div className="pp-quill" aria-hidden="true" />
                    )}
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
                        data-block-observed={needsObservedHeight(b.kind, b.asset != null) ? b.id : undefined}
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
                inkCache={inkCacheRef.current}
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
