// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel 的**装配根**（2026-11-06 上帝文件治理 P3：从 PaperPanel.tsx 拆出）。
// 全部 use-* 域的调用序、共享 ref 载体、拖拽渲染态、context 组装都在这里——
// **hook 调用序是挂载契约**（split-plan §3 的三对硬约束），挪动本文件内的调用序 = 改行为。
// 本 hook 只做装配与派生，不画任何东西；JSX 在 PaperPanel.tsx。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rackPresent } from '../../../paper/asset-rack';
import { DOCK_TETHER_PEN, DOCK_TETHER_SEED, regionFootAnchorOf } from './dock-tether';
import type { RegionView } from './host';
import {
  activeOverlayContributions,
  activeSpace,
  agentSessionState,
  getCanvasStore,
  leaveToHome,
  screenToWorld,
  subscribeOverlayContributions,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
  useUpdateStore,
  worldToScreen,
} from './host';
import { sourceBlockIdOf, TETHER_ANCHOR_DY, tetherAnchors, tetherAnchorsAt, tetherPath } from './provenance';
import { createRegionMotionWindow, regionOnScreen, stepRegionMotion } from './region-motion';
import { selSeedOf } from './sel-ink';
import { useBlockMeasure } from './use-block-measure';
import { useBlockOps } from './use-block-ops';
import { useBranchDrag } from './use-branch-drag';
import { useComposerFloat } from './use-composer-float';
import { useFoldState } from './use-fold-state';
import { useJumpKeys } from './use-jump-keys';
import { useMinimapBounds } from './use-minimap-bounds';
import { usePaperDrag } from './use-paper-drag';
import { usePaperFocus } from './use-paper-focus';
import { usePaperRegions } from './use-paper-regions';
import { usePaperSessions } from './use-paper-sessions';
import { usePaperStrips } from './use-paper-strips';
import { usePaperViewport } from './use-paper-viewport';
import { usePinStripResize } from './use-pin-strip-resize';
import { useRegionActivation } from './use-region-activation';
import { useRegionMove } from './use-region-move';
import { useRegionPlacement } from './use-region-placement';
import { useRunningSessions } from './use-running-sessions';

export function usePaperPanelAssembly() {
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

  /** 缩放离散步进计数（§15 批 5）：只作读数 span 的 React key——值一变即重挂重播
   *  微动效。滚轮连续缩放不抬计数（见 canvas-view-store 的字段注），故不抖。 */
  const zoomTick = useCanvasViewStore((s) => s.zoomTick);

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
   * （pp-tail 尾笔已由用户拍板拆除——见 taste-ledger 翻案。）
   * 2026-10-18 卷开合动效批：卷**离场**时把它那些块的印记清掉 ⇒ 重开卷重播墨律；
   * 卷自己的「落纸」不入本集合而走**窗**（`region-motion.ts` 的落纸窗——单帧发类会被
   * 同帧后续重渲染摘掉，等于没发）。 */
  const seenBlocksRef = useRef<Set<string>>(new Set());
  /* 域间共享 ref 载体（晚绑定跨域读——原文件内既有范式：viewRef 同族）。 */
  const regionsRef = useRef<RegionView[]>([]);

  const { measureTick, blockRootRef } = useBlockMeasure();
  const { foldedOf, onToggleFold, expandBlock, sidecarFoldedOf, onToggleSidecarFold } = useFoldState();
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

  const { opsByBlock, branchGrips } = useBlockOps({ core, regions, regionsRef, regionMsgs });

  /* ── 卷**开合两窗**（2026-10-18 卷开合动效批；机制与三条纪律见 region-motion.ts 头注）──
   * 渲染期收敛：本帧消失的卷**当帧**进退场窗、新出场的卷当帧开落纸窗（挪进 effect =
   * 先拆一帧再挂回来，退场窗里重播入场——DockPanel 相位机 2026-10-16 那条实测判据）。
   * 离场卷只进**渲染两图**（流区叶 + 块层），不进任何测量/读数面（`regions` 保持活跃卷
   * 语义不动）。 */
  const motionWin = useRef(createRegionMotionWindow<RegionView>());
  const [motionTick, setMotionTick] = useState(0);
  /* 「真在视口里」= 横向（渲染虚拟化口径 `visibleRegionIds`）+ **纵向**（那个口径只看 x）
   * ——落纸要给**用户看得见**的那一刻发（见 region-motion.ts 头注：远卷的摊开带着 260ms
   * 飞行，按「首次活跃」发类会在屏外播完，镜头到了纸已稳稳摊着 = 读作还是闪现）。 */
  const onScreenIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of regions) {
      if (!visibleRegionIds.has(r.sessionId)) continue;
      if (!regionOnScreen(r.regionTop - r.folioH, r.regionTop + r.regionHeight, viewRect.y0, viewRect.y1)) continue;
      s.add(r.sessionId);
    }
    return s;
  }, [regions, visibleRegionIds, viewRect]);
  const { entered: justLeft, nextExpiry: motionExpiry } = stepRegionMotion(
    motionWin.current,
    regions,
    onScreenIds,
    Date.now(),
  );
  for (const gone of justLeft) {
    /* 首见印记随卷一并清掉 ⇒ 重开卷重播墨律（不清 = 重开无墨，`seenBlocksRef` 老病）。 */
    for (const b of gone.blocks) seenBlocksRef.current.delete(b.id);
  }
  /** 渲染序（流区叶与块层共用同一条）：活跃卷 + 在窗的离场卷（全量快照）。
   *  `spreading` = 在**落纸窗**内（纸淡入 + 墨自 18px 落下，见 PaperPanel.css 卷开合段）。 */
  const regionRender = [
    ...regions.map((view) => ({
      view,
      leaving: false,
      spreading: motionWin.current.spread.has(view.sessionId),
    })),
    ...[...motionWin.current.leaving.values()].map((e) => ({ view: e.view, leaving: true, spreading: false })),
  ];
  useEffect(() => {
    void motionTick; // 只作重渲染扳机（依赖声明与闭包语义一致——同既有范式）
    if (motionExpiry == null) return;
    const t = window.setTimeout(() => setMotionTick((n) => n + 1), Math.max(0, motionExpiry - Date.now()) + 8);
    return () => window.clearTimeout(t);
  }, [motionExpiry, motionTick]);

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

  /* 句柄就绪信号（2026-09-19，真机报的「重启后引线消失」）：枝边读面落在**卷句柄**上，
   *  而冷启动的批量恢复刻意不造句柄、参与枝边的卷由后台水合补上 ⇒ 句柄是**迟到**的。
   *  订阅 `agentSessionState`（setAgent/exec 变更即 bump）驱动枝边重算——见下方 branchEdges 注。 */
  const [agentsTick, setAgentsTick] = useState(0);
  useEffect(() => agentSessionState.subscribe(() => setAgentsTick((t) => t + 1)), []);

  /* ── 会话树「枝」的画布承接（P3，2026-09-18）──
   * 边 = 一丝朱砂引线：**枝卷卷首 → 父卷的那个节点**（不是「父卷」这个整体）。
   * 与出处引导**同一支笔**（`tetherAnchorsAt` + `tetherPath`：屏幕坐标 / 恒定墨宽 /
   * 定种子相位 / 起笔留白 + 收笔朱点）——一屏一语言，不新造一种线。
   * 与钉那条腿的一处不同（记理由）：**常显**——树是结构不是瞬时手势。
   * **2026-09-24 第二刀：纯指示·不可点**——原实现另有一处不同（受墨带承接点击、点线飞回
   * 父卷分叉节点），账上无用户拍板依据（`docs/archive/session-line/session-tree-plan.md` §9「已拍板」表里没有它）
   * ⇒ 连同受墨带 / role / tabIndex / 焦点态整批摘除。**这条腿的「常显」理由原本写着
   * 「线要能点着溯源（hover 才出现的线点不到）」——该理由随第二刀作废**；常显仍成立，
   * 因为血缘是结构读数（一屏几枝时线是底噪，读的是「谁从谁来」）。
   * 父节点不在视口内时线照样出屏（同款判据：锚点在世界里定、投到屏上落墨）。
   * 数据来自 `core.branchEdge`（**零 I/O**：血缘在卷日志头行里，attach 时已带入内存）。
   *
   * ⚠ **句柄就绪信号**（2026-09-19，真机报的「重启后引线消失」）：该读面落在**卷句柄**上
   * （血缘在子卷的日志写面里、父卷那个节点要走父卷的投影与定位桥），而冷启动的批量恢复
   * 刻意不造句柄（只有活跃卷惰性补建）——参与枝边的卷由冷启动后台水合补上
   * （`chat-core.restoreCanvasSpread`）⇒ 句柄**迟到**。故本 memo 吃 `agentsTick`
   * （`agentSessionState.subscribe`：setAgent 即 bump），句柄一到就重算，引线随之出现。
   * 刻意**不**吃 `regionMsgs`：父卷锚点要走一整段 fold（O(事件数)），逐流式 tick 重跑会拖帧。 */
  const branchEdges = useMemo(() => {
    void agentsTick; // 依赖信号（句柄迟到——见上注）
    if (!core) return [];
    const out: Array<{ childSid: number; parentSid: number; nodeMessageId: string }> = [];
    for (const s of sessions) {
      const edge = core.branchEdge(s.id);
      if (edge) out.push({ childSid: s.id, ...edge });
    }
    return out;
  }, [core, sessions, agentsTick]);
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
  /** 引线笔道（屏幕坐标）+ **两端锚点**：**卷首中线 → 节点锚点**。种子取枝卷号：同枝恒同线。 */
  const branchTethers = useMemo(() => {
    const out: Array<{
      childSid: number;
      parentSid: number;
      blockId: string;
      d: string;
      origin: { x: number; y: number };
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
      out.push({ ...t, d: art.d, origin: art.origin, bead: art.bead });
    }
    return out;
  }, [branchTargets, regions, view]);

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

  const {
    dragRef,
    onBlockMouseDown,
    onUnpin,
    onGhostClick,
    onSidecarRestore,
    onSidecarPinMouseDown,
    onRackPinMouseDown,
    pinHint,
  } = usePaperDrag({
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

  /* ── 空间手势立枝（P4-①，2026-09-19）──
   * 按住块上的「枝」握把拖出一条引线、松手落在纸上 = 就地立枝（枝卷落在落点）。
   * 判据与弃案见 plan §5；手势域本体见 use-branch-drag。预览线与枝边层同一支笔、
   * 同一层位（屏幕坐标）：起笔 = 原块缘（世界矩形投到屏上），收笔 = 指针（朱点即
   * 落点——「线是引，点是落」）。 */
  const { branchDrag, onBranchGripMouseDown } = useBranchDrag({
    core,
    canvasRef,
    blockSessionRef,
    regionMsgs,
    takeOverViewport,
  });
  const branchDragTether = useMemo(() => {
    if (!branchDrag) return null;
    const region = regions.find((r) => r.sessionNum === Number(branchDrag.sessionId));
    const block = region?.flowGeom.find((g) => g.id === branchDrag.blockId);
    if (!block) return null;
    const at = screenToWorld(view, branchDrag.screen.x, branchDrag.screen.y);
    // 起笔 = 块缘锚点（与引线同一套）；落点 = 指针**本身**（「落点即所见」）——指针不是块、
    // 没有块锚点，故先把锚点偏移减掉，让 tetherAnchorsAt 算出的 to 正好落在指针上。
    const world = tetherAnchorsAt(
      { x: block.x, y: block.y + TETHER_ANCHOR_DY, w: block.w },
      { x: at.x, y: at.y - TETHER_ANCHOR_DY, w: 0, h: 0 },
    );
    return tetherPath(
      worldToScreen(view, world.from.x, world.from.y),
      worldToScreen(view, world.to.x, world.to.y),
      selSeedOf(`branch-drag-${branchDrag.blockId}`),
    );
  }, [branchDrag, regions, view]);

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
  /** **架在否**（2026-09-23 图版架丙案 D2）：架挂在坞下缘，屏缘要留给它 ⇒ 架在时
   *  「最底缘」吸附位与夹紧下限顺延架高（8 → 46）。判据真源 = `paper/asset-rack.ts`
   *  的 `rackPresent`——**与架自己同一句**（架内零张 = 整条退场，两侧同时为假）。 */
  const rackOn = rackPresent(
    activeSessionKey != null ? regions.find((r) => r.sessionId === activeSessionKey)?.blocks : null,
  );
  const composer = useComposerFloat({ rackOn });
  /** 坞几何（引用稳定，见 use-composer-float）——下发给覆盖层消费面。 */
  const composerDock = composer.dock;
  /** 拖动锁能力位：坞在书眉工具行渲染那枚单字工具（移/锁）。引用必须稳定——
   *  dockContext 一变，坞就随平移帧重渲（低频 context 纪律）。 */
  const composerLock = useMemo(
    () => ({ unlocked: composer.unlocked, toggle: composer.toggleUnlocked }),
    [composer.unlocked, composer.toggleUnlocked],
  );
  /** 图版架手势能力位之①「收起态连展开」（2026-09-23 丙案 §9.5）：架归**产物流**
   *  （compose-dock），而折叠覆盖表在槽主人手里——架不自己碰折叠态（同一个动作一个
   *  实现）。读 `regionsRef`（帧内最新，非 `regions` state）：本回调引用必须稳定，
   *  否则 dockContext 每平移帧换新 ⇒ 坞随平移帧重渲（低频 context 纪律）。
   *  块找不到（钉出/撤回竞态）= 不动作：宁可什么都不展开，也不展开错块。 */
  const expandBlockById = useCallback(
    (blockId: string) => {
      for (const r of regionsRef.current) {
        const b = r.blocks.find((x) => x.id === blockId);
        if (b) {
          expandBlock(b);
          return;
        }
      }
    },
    [expandBlock],
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
      expandBlock: expandBlockById,
      dragBlockOut: onRackPinMouseDown,
    }),
    [activeSessionKey, flyToPoint, glideViewTo, composerLock, expandBlockById, onRackPinMouseDown],
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

  /* ── 匣脚引线（2026-09-22）：**坞的版口钮 → 活卷的纸脚** ──
   * 病灶（用户）：「多会话卷的激活态一直没做好」——活卷的信号全在纸上，而坞与纸上任何
   * 一卷之间没有任何可见联系；坞浮动化之后两边各自在屏上走，「坞报的卷名指哪一张纸」
   * 只能靠读者自己连线。
   * 卷端落点**二版改档**（用户当场打回一版：「你这个引线能挂在页尾吗……你挂在第一条
   * 用户输入那不是乱了套了」）：一版接在**卷首规线左端那枚版口钮**上——那枚钮是
   * 「哪一卷活跃」的标记，位置又正好压在标题与第一条来文的接缝上，线读起来像在指第一
   * 条来文。二版改接**纸脚**（版心左缘 × 卷底边）：纸的材料缘、没有任何字，且它才是
   * 「这一卷写到哪儿」的那一端（人在读尾时它就在坞上方几十像素）。坞端不变：坞顶左端
   * 那枚版口钮（匣口）。
   * 两端各在既有单一真源：坞侧 = `composer.anchor`（槽主人实测坞位与尺寸），
   * 卷侧 = `regionFootAnchorOf`（世界坐标 → 投到屏上落墨，同枝边那条腿）。
   * 笔 = 同一支（`.pp-tether` 的墨）；与既有两条腿两处不同（各记理由）：
   *   ① 锚面外法向（匣顶朝上 / 卷底边朝下——判例原文就是「锚面法向」，前两条腿因锚面
   *      皆竖面才写死水平）+ 臂长下限（防近水平时笔道退化成贴着弦的一条直线）；
   *   ② **常显·纯指示**（结构不是瞬时手势，同枝边那一条）。
   * **归因更正（2026-09-24）**：本线落地时被做成**可点**（透明受墨带 + `role="button"` +
   * `tabIndex` + 点线飞到纸脚），账上记为「同日拍板 可点溯源」——用户 2026-09-24 否认：
   * 「我从来也没有拍板过引线本体要做成按钮」。线只负责指示「这一匣对着这一卷」，
   * 指针与键盘都不该选中它 ⇒ 受墨带 / 点击 / 焦点态同批摘除（账本订正见 taste-ledger
   * 同日条）。**同族两条腿一并收口**：枝边那条腿（P3 会话树）原也带受墨带，2026-09-24
   * 第二刀同样摘除——引线一律「指示不是控件」（代价：屏幕上的「跳回父卷分叉节点」入口
   * 随之消失，见该层注释）。
   * 无活卷 / 案头态（匣退、钮本就不画）⇒ **不画线**；「活卷在场上但流区还没落位」
   * （新卷出生后落位 effect 之前那一帧）同样不画——宁可没有线，也不指错（锚点批同款判据）。 */
  const dockTether = useMemo(() => {
    if (activeSessionKey === null) return null;
    const region = regions.find((r) => r.sessionId === activeSessionKey);
    if (!region) return null;
    const foot = regionFootAnchorOf({
      anchorX: region.anchor.anchorX,
      width: region.anchor.width,
      regionTop: region.regionTop,
      regionHeight: region.regionHeight,
    });
    return tetherPath(
      composer.anchor,
      worldToScreen(view, foot.x, foot.y),
      selSeedOf(`${DOCK_TETHER_SEED}-${activeSessionKey}`),
      DOCK_TETHER_PEN,
    );
  }, [activeSessionKey, regions, view, composer.anchor]);

  return {
    core,
    updateAvailable,
    updateVersion,
    projectPath,
    leaveConfirm,
    setLeaveConfirm,
    forceLeave,
    sessions,
    activeSessionKey,
    view,
    canvasRef,
    paperRootRef,
    worldRef,
    lod,
    panning,
    stepZoom,
    resetZoom,
    onCanvasMouseDown,
    lodFar,
    zoomTick,
    draggingId,
    dragPos,
    dragSource,
    bandSessionId,
    settleId,
    setTetherPinId,
    tracedPinId,
    seenBlocksRef,
    regionsRef,
    blockRootRef,
    foldedOf,
    onToggleFold,
    sidecarFoldedOf,
    onToggleSidecarFold,
    runningSessions,
    streamLive,
    activeRunning,
    edgeDragPos,
    regionCornerPos,
    onRegionEdgeMouseDown,
    sidecarOutOf,
    orphanPins,
    deadOrphanPinIds,
    visibleRegionIds,
    inkCache,
    opsByBlock,
    regionRender,
    onProvTrace,
    tether,
    branchTethers,
    onBlockMouseDown,
    onUnpin,
    onGhostClick,
    onSidecarRestore,
    onSidecarPinMouseDown,
    pinHint,
    resizePreview,
    branchDragTether,
    canvasStrips,
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
    composerOverlays,
    edgeOverlays,
    desk,
    worldStyle,
    zoomLabel,
    totalBlocks,
    totalPinned,
    totalStrips,
    composer,
    composerLock,
    dockContext,
    regionContext,
    dockTether,
    activateRegion,
    onRegionCornerMouseDown,
    onResizeMouseDown,
    branchGrips,
    onBranchGripMouseDown,
  };
}
