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

// ── 2026-11-06 再拆（上帝文件治理 P3）──
// 本文件自此只剩**视图**：装配（use-paper-panel.ts）+ 表现件（paper-panel-parts.tsx）+ 本文件 JSX。
// 改域逻辑去装配根，改单块渲染去表现件，改版面留在这里。

import { type CSSProperties, Fragment, useCallback, useEffect, useState } from 'react';
import { volumeDisplayName } from '../../../state/volume-name';
import { DockTetherLayer } from './DockTetherLayer';
import { DraftSheet } from './DraftSheet';
import { FolioAskBadge } from './FolioAskBadge';
import { FolioCompositionChip } from './FolioCompositionChip';
import {
  agentSessionState,
  blockFromSnapshot,
  ConfirmDialog,
  Icon,
  onTopbarDoubleClick,
  onTopbarPointerDown,
  PaperDockContext,
  PaperRegionContext,
  PluginBoundary,
  setMorphBox,
  useDockStore,
  useDraftSheetStore,
  useShelfStore,
  useWorkLedgerStore,
  WinControls,
} from './host';
import { InkLayer } from './InkLayer';
import { blockHasView, needsObservedHeight, observedKeyOf } from './measure';
import { BlockView, DeskShelf, EMPTY_OPS, folioSubLine } from './paper-panel-parts';
import { type ProvenanceState, provenanceText, provenanceTitle, provenanceTraceable } from './provenance';
import { ShelfOverlay } from './ShelfOverlay';
import { StatusLine } from './StatusLine';
import { sheetCharacter } from './sheet';
import { ToastHost } from './ToastHost';
import { blockReturnsToFlow } from './use-paper-drag';
import { GHOST_H } from './use-paper-regions';
import './PaperPanel.css';
import { usePaperPanelAssembly } from './use-paper-panel';

/** 落笔点（2026-09-06 纸面运行态）：卷在跑而尾部无湿墨时，卷尾石青方点呼吸。
 *
 *  **提笔收束**（2026-11-17 反馈密度批 · 第二批）：跑完不是「凭空消失」——方点
 *  下沉 3px、缩到 0.6、淡尽（一窗 280ms），读作「笔提起来」。为什么收在这里：
 *  用户真机上唯一看得见的运行态信号就是它（原话「靠页面最下面那个呼吸的蓝色
 *  方块」）——屏幕底缘那条呼吸线他从未注意到。**反馈要放在视线所在的位置。** */
function Quill({ live }: { live: boolean }) {
  const [seen, setSeen] = useState(live);
  const [lifting, setLifting] = useState(false);
  useEffect(() => {
    if (live) {
      setSeen(true);
      setLifting(false);
      return;
    }
    if (!seen) return;
    setLifting(true);
    /* 窗长 = --m-sheet（260ms）+ 一拍余量。元素即将消失、没有事件可听，故用钟
     * （motion-end 通则的唯一豁免位）。窗内又开跑 ⇒ cleanup 撤销，方点续呼吸。 */
    const t = window.setTimeout(() => {
      setSeen(false);
      setLifting(false);
    }, 280);
    return () => window.clearTimeout(t);
  }, [live, seen]);
  if (!seen) return null;
  return <div className={`pp-quill${lifting ? ' pp-quill-lift' : ''}`} aria-hidden="true" />;
}

export function PaperPanel() {
  /* 待题纸是**瞬态**（设计件 §3.5）：关画布 / 切工作区 = 弃纸——不烧号、不落盘、
   * 不留悬空状态。清理挂在纸视图生命周期上（PaperPanel 卸载即离开本工作区）。 */
  useEffect(() => {
    return () => useDraftSheetStore.getState().dismissAll();
  }, []);

  /* 待题纸摊开 = 出生面已经在场：**空态整块退场**（2026-11-15 用户报「文字和题签重叠」）。
   * 空态判据原本只有 `sessions.length === 0`，而待题纸**不建卷**（这正是立卷 UX 的要害）
   * ⇒ 空态的 kicker/题字/引导句/花押与纸同屏叠着画。两处判据同源：纸在 ⇒ 空态不在。
   * ⚡ 2026-11-15 V2：化卷交接窗（morph）里纸**还在屏上**，故它也算法「纸在」——
   * 判据与装配根（use-paper-panel 的两条同源判据）同一把尺子，两处一起改。 */
  /* **多纸改判（2026-11-17）**：判据从「纸在不在」拆成两条——
   *   ① `draftFocusOn`：**焦点在纸上** ⇒ 坞让位（纸上那枚输入面就是这条通道）；
   *   ② `draftMorphOpen`：有纸正在化卷 ⇒ 坞从屏外升上来（交接那一拍）。
   *  「纸在画布上」本身**不再是**坞的让位判据：纸可以摆在画布上不拿焦点，那时坞照常
   *  对着活跃卷工作（用户报的「不能回头和已有会话交互」正是旧判据把坞整只摁掉）。 */
  const draftFocusOn = useDraftSheetStore((s) => s.focusedId !== null);
  const draftMorphOpen = useDraftSheetStore((s) => Object.keys(s.morphs).length > 0);
  /* **「纸在不在」与「焦点在不在纸上」是两件事**（2026-11-19 真机报「题签态无法正常工作」）：
   * 空态的判据是「出生面有没有在场」，而纸**摆在画布上**就是出生面在场——它失焦也仍然
   * 在画布上等着你去点（焦点只是「谁吃键盘」）。旧判据读了 focus ⇒ 点一下画布空白，空态
   * 整块盖回纸上（LANTAI·BLANK SHEET / CTA / 引导句压着题签），用户读到的是「题签坏了」。
   * 坞槽的让位仍读焦点（那条语义是对的：纸摆着不拿焦点时坞照常对着活跃卷工作）。 */
  const draftSheetPresent = useDraftSheetStore((s) => s.papers.length > 0);
  const draftMorph = useDraftSheetStore((s) => {
    const ids = Object.keys(s.morphs);
    return ids.length > 0 ? s.morphs[ids[0]] : null;
  });

  const {
    core,
    updateAvailable,
    updateVersion,
    projectPath,
    leaveConfirm,
    setLeaveConfirm,
    forceLeave,
    sessions,
    activeSessionKey,
    canvasRef,
    paperRootRef,
    worldRef,
    lod,
    panning,
    stepZoom,
    resetZoom,
    onCanvasPointerDown,
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
    onRegionEdgePointerDown,
    sidecarOutOf,
    orphanPins,
    orphanOps,
    canvasQuoteHold,
    quoteHoldingBlockId,
    beginQuoteHold,
    deadOrphanPinIds,
    visibleRegionIds,
    inkCache,
    opsByBlock,
    regionRender,
    onProvTrace,
    tether,
    branchTethers,
    onBlockPointerDown,
    onUnpin,
    onGhostClick,
    onSidecarRestore,
    onSidecarPinPointerDown,
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
    onStripPointerDown,
    composerOverlays,
    edgeOverlays,
    worldStyle,
    zoomLabel,
    totalBlocks,
    totalPinned,
    totalStrips,
    composer,
    dockContext,
    regionContext,
    dockTether,
    activateRegion,
    onRegionCornerPointerDown,
    onResizePointerDown,
    branchGrips,
    onBranchGripPointerDown,
  } = usePaperPanelAssembly();

  /* 帖签「召回」的写面（2026-11-20 帖批）：停本卷**全部**在办子代理。
   *
   *  为什么是全停而不是单停：池对 UI 只暴露 `stopAll`（单停只有模型工具 agent_kill
   *  那条路），UI 侧没有逐条停的通道。按钮据此如实写「召回」并在 title 里说明
   *  范围——不假装能只停这一帖（错误不静默，也别把能力吹大）。
   *  与坞的「全停子代理」共用同一个写面与同一本账（先落账再等收尾回调，
   *  否则 abort 分支会把「人停的」写成「失败」，见 work-ledger-store 注）。 */
  const onRecallSubAgents = useCallback(
    (sessionNum: string | undefined) => {
      const panelId = core?.panelId;
      const num = sessionNum != null ? Number(sessionNum) : Number.NaN;
      if (!panelId || !Number.isFinite(num)) return;
      const stopped = agentSessionState.getAgent(panelId, num)?.stopAllSubAgents() ?? [];
      useWorkLedgerStore.getState().noteSubAgentStopped(panelId, stopped);
    },
    [core?.panelId],
  );

  /* **交接期：纸只借卷的「左缘与宽」**（2026-11-16 改判；上一版整盒借用已被推翻）。
   *
   * 旧的整盒回填（`top` / `height` 也取卷的）目的曾是「纸与卷严丝合缝」，真机定帧实测的
   * 后果是：卷落进首块后盒高 552、纸实测 490，**盒底相同** ⇒ 换盒那一帧纸的上缘往上跳
   * 62px，天头四行跟着瞬移——正是本轮要消灭的「题签跳了一下」。
   * 现在只回填左缘与宽（两者本该相等，取它是为了与世界变换同源），高与上缘归纸自己。
   * 写在渲染期（不是 effect）：晚一帧纸会先按自己的左缘摆一帧再被拉回；同值不重设
   *（setMorphBox 内判等），不会逐帧抖 store。 */
  /* 多纸（2026-11-17）：`draftMorph` 只取第一张正在交接的纸，回填按它的 `sheetId` 反查
   * ——**同一时刻只可能有一张纸在化卷**（发送是单发的动作），故这一份「唯一在交接的那张」
   * 就是全部交接面。`setMorphBox` 的缺省纸参数按「交接表里唯一那张」反查，多纸不会串。 */
  if (draftMorph) {
    const rising = regionRender.find((e) => !e.leaving && e.view.sessionId === draftMorph.sheetId);
    if (rising) {
      const v = rising.view;
      setMorphBox({
        left: v.anchor.anchorX - v.anchor.width / 2,
        top: null,
        width: v.anchor.width,
        /* 卷的**高**照传：不是拿去改纸的盒（那会让纸的上缘瞬跳，见上注），
         * 而是给纸的天头算「该往上抬多少」——两件盒底相同，故差值 = 卷高 − 纸高。
         * 纸按这个差把天头**平移**到卷首将要去的地方：移的是字，不是纸。 */
        height: v.regionHeight + v.folioH,
      });
    }
  }

  /* 拖拽回流判据（渲染面）：与松手定夺共用 `blockReturnsToFlow`（据来源原位量）
   * ——视觉与规则同一把尺子：预览说「回槽」就必须真的回槽（2026-09-17 修正） */
  return (
    <PaperDockContext.Provider value={dockContext}>
      <PaperRegionContext.Provider value={regionContext}>
        <div className="pp-root" ref={paperRootRef}>
          {/* 钉住可发现性（一次性眉批）：提示长在功能所在处——左缘即文类签列。
           * 视觉走 .pp-eyebrow-hint 族（6s 淡出自散动画）+ .pp-hint-canvas 落位。 */}
          {pinHint && <div className="pp-eyebrow-hint pp-hint-canvas">按住块左侧文类签，可把任意块拖出钉在案上</div>}

          {/* B 选中浮钮：块内有选区时现身（锚点随视口现算），点击成条（落来源流区右侧空地）。
              `onMouseDown` 的 preventDefault 是刻意的：不让按下抢焦点/动选区——浮钮长在
              选区右侧 8px（选区外），原生默认动作会把选区摘掉，这一次点击就白按了。 */}
          {selAnchor && !ghost && fabPos && (
            <button
              type="button"
              className="pp-strip-fab"
              style={fabPos}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStripButton}
            >
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

          <div
            ref={canvasRef}
            /* `pp-live-hand` = 手律态（§15）：整区拖动 / 四角缩放中，块体随流区每帧
               重排，让位过渡必须摘掉（带 260ms 缓动即成橡皮筋）。与 `pp-stream-live`
               同族：都是「画布当下处于哪种运动」的声明，由壳层发放、CSS 只管消费。 */
            className={`pp-canvas${panning ? ' pp-panning' : ''}${streamLive ? ' pp-stream-live' : ''}${
              edgeDragPos || regionCornerPos ? ' pp-live-hand' : ''
            }`}
            onPointerDown={onCanvasPointerDown}
          >
            {sessions.length === 0 && !draftSheetPresent && !draftMorphOpen && (
              <div className="pp-empty">
                <div className="pp-empty-kicker">LANTAI · BLANK SHEET</div>
                <div className="pp-empty-title">案上无卷，落笔即起</div>
                <div className="pp-empty-rule" />
                {/* 空态 CTA（2026-08-31 拍板 A：显式出生入口；2026-09 修复批：
                 * 不再 disabled 依赖 core——onClick 永远走 createNewSession()，
                 * 无 core 时其内部守卫会 toast「需要先有工作区」，点按必有反馈，
                 * 按钮不会出现「点了没反应」。 */}
                {/* 2026-11-14 立卷 UX：CTA 不再直接建卷，而是落一张**待题纸**
                 * （题签 → 开卷才发号；详见 DraftSheet 头注 / 设计件 new-session-ux.md） */}
                <button
                  type="button"
                  className="pp-empty-cta"
                  onClick={() => {
                    const paperId = useDraftSheetStore.getState().openSheet();
                    void core?.focusDraft?.(paperId);
                  }}
                >
                  ＋ 另起一卷
                </button>
                {/* 续写签条架（2026-11-28 搬家）：原挂创作坞下缘、只在零卷时出没；坞在零卷态
                 * 退役后它随空态块走——「上次写到哪」仍在眼前，不必开侧栏。无已存卷 / 无工作区
                 * 时架自己退场（判据在组件内，空态块一字不知）。 */}
                <DeskShelf core={core} />
                <div className="pp-empty-hint">续写旧卷点签条 · 新卷落纸、题签后开卷</div>
                <div className="pp-empty-asterism">⁂</div>
              </div>
            )}

            {/* 世界层 */}
            <div ref={worldRef} className="pp-world" style={worldStyle}>
              {/* 桌垫（材质批修复 2026-09-01 贴纸语义）：世界内巨幅纸面——桌面纹理
                  随拖动/缩放走且只纹理桌面自身，不再乘盖流区/纸条（贴纸有贴纸的
                  纹，见 .pp-region 的 paper-sheet；样式见 .pp-desk） */}
              <div className="pp-desk" />
              {/* 待题纸（2026-11-14 立卷 UX）：**在 world 里**——与流区同一坐标语言，
                  开卷后卷落在同一个锚点（纸不跳位）。它是纸，不是层：不引入模态框。
                  未摊开时组件自身早退（零成本）。 */}
              <DraftSheet core={core} />

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

              {/* 流区容器（一纸多卷：每会话一块有界流区——边缘拖动移动整区）。
                  2026-10-18 卷开合动效批：本图渲染「活跃卷 + 在窗的离场卷」——
                  离场卷（`data-leaving`）**绕开虚拟化**（否则一卷刚飞出视口就被裁掉，
                  退场动画只看得到半截），且不接活跃/带显形/手势与落纸入场。 */}
              {regionRender.map(({ view: r, leaving, spreading, settling, rising }) => {
                if (!leaving && !visibleRegionIds.has(r.sessionId)) return null;
                const isActive = !leaving && r.sessionId === activeSessionKey;
                /* 落纸入场（纸淡入）：在**落纸窗**内即挂类（窗满由 region-motion 摘）。
                 * 离场卷不挂（它在起纸）。**出生即交接**的卷挂 `pp-rise` 而不是 `pp-spread`
                 * ——纸的淡出已经由纸自己那一窗讲完，这里只落墨（见 region-motion.ts 头注）。 */
                const isSpread = !leaving && spreading;
                const isRise = !leaving && rising;
                /* 余波（2026-11-17 判据板批）：纸落定后影子继续坐实 1.6s——只挂伪元素动画，
                 * 不动纸（纸律：整叶只动 opacity，见 paper-base.css 卷开合段）。 */
                const isSettling = !leaving && settling;
                const sheet = sheetCharacter(r.sessionId);
                return (
                  <div
                    key={r.sessionId}
                    className={`pp-region${isActive ? ' pp-region-active' : ''}${isSpread ? ' pp-spread' : ''}${
                      isRise ? ' pp-rise' : ''
                    }${isSettling ? ' pp-settling' : ''}${
                      !leaving && bandSessionId === r.sessionId ? ' pp-region--band' : ''
                    }`}
                    {...(leaving ? ({ 'data-leaving': '', inert: true } as const) : null)}
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
                    /* 2026-11-17 批 C：流区激活与画布平移同面（pointer 事件）——
                     * 两件事都在冒泡面上判，混用鼠标/指针会让「按下就激活」偶发不触发。 */
                    onPointerDown={
                      leaving
                        ? undefined
                        : (e) => {
                            if (e.button !== 0) return;
                            if (e.target === e.currentTarget) activateRegion(r.sessionId);
                          }
                    }
                  >
                    {/* 卷首（folio-head，2026-08-30 自 prototype/lantai.html .folio-head 转录；
                     * 2026-09-16「版心天头」重排，用户拍板 B 案）：玉徽（亭台线稿）居中钤印
                     * 于**版心** + 机读眉行（卷次）+ 题字 + 机读档行（立卷日 · 块数），四行
                     * 同轴居中，底部硬规线 + 左缘朱砂版口钮只画版心宽。
                     * 重排前的病灶：玉徽居中于整张纸（1440 流区中轴）、眉行/题字/档行却左齐
                     * 于纸缘内距 16px，而正文块居中于 720 版心——题字比正文左缘还左 344px
                     * （实测见 prototype/folio-head-ab.html 读数栏）。
                     * 版心盒 = 内层 div（width 50% = 纸半；2026-10-08「墨占纸半」重定——
                     * 原 min(720, 100%) 封顶退役），测高镜像见 measure.ts columnWidthFor。
                     * 框体向上扩展包住卷首（界栏护持）。
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
                           * 重排前眉行 + 题字 fallback + 档行三处都报卷号（同义反复）。
                           * 会话树「枝」：本卷有父卷 ⇒ 眉行缀「枝」（与侧栏/书脊同一枚标；
                           * 血缘读面零 I/O；眉行 line-height 是定值 15px，缀字不改卷首高）。 */}
                          <p className="pp-folio-eyebrow">
                            {r.label ? `案卷 Nº ${r.sessionNum}` : '兰台 · 案卷'}
                            {core?.branchOrigin(r.sessionNum) ? ' · 枝' : ''}
                          </p>
                          <h2 className="pp-folio-title">{volumeDisplayName(r.label, r.sessionNum)}</h2>
                          <p className="pp-folio-sub">{folioSubLine(r)}</p>
                          {/* 组合芯片（S6 P5a）：**本卷**的组合身份与（空白卷的）拨动入口——
                              绝对定位覆盖在版心右上、与眉行同行、不进高度流水
                              （见 FolioCompositionChip 头注）。作用对象 = 本 region 的卷
                              （r.sessionId），不是"当前活跃卷"。 */}
                          <FolioCompositionChip core={core} sessionId={r.sessionId} />
                          {/* 待答角标（2026-11-11 画布多卷审批 UX · A 面）：本卷有卡在等
                              → 版心左上挂「待批 N / 待答 N」，点它跳到本卷。零待答不渲染。 */}
                          <FolioAskBadge core={core} sessionId={r.sessionId} />
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
                    {!lod && <Quill key={r.sessionId} live={runningSessions.has(r.sessionNum) && !r.writingBlockId} />}
                    {/* 边缘拖拽面（Stage-2 定案：无手柄条，hover 即拖拽态）——
                     * 远档退场：亚像素交互柄只剩噪点（P4c）。 */}
                    {!lodFar && (
                      <>
                        <div
                          className="pp-region-edge pp-region-edge--l"
                          data-tip="拖动边缘——移动整个流区"
                          onPointerDown={(e) => onRegionEdgePointerDown(e, r.sessionId)}
                        />
                        <div
                          className="pp-region-edge pp-region-edge--r"
                          data-tip="拖动边缘——移动整个流区"
                          onPointerDown={(e) => onRegionEdgePointerDown(e, r.sessionId)}
                        />
                        {/* P6 四角横向缩放柄（角落只开放横向——Y 由内容生长） */}
                        {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                          <div
                            key={c}
                            className={`pp-region-corner pp-region-corner--${c}`}
                            data-tip="拖动角柄——调整流区宽度"
                            onPointerDown={(e) => onRegionCornerPointerDown(e, r.sessionId, c)}
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
                  <div
                    key={s.id}
                    className={`pp-strip${stripDragged ? ' pp-dragging' : ''}${settleId === s.id ? ' pp-settle' : ''}`}
                    data-strip-id={s.id}
                    style={{ left: stripPos.x, top: stripPos.y, width: stripW }}
                    onPointerDown={(e) => onStripPointerDown(e, s)}
                  >
                    <div className="pp-strip-head">
                      <span className="pp-strip-tag">纸条</span>
                      <button
                        type="button"
                        className={`pp-strip-remove${stripConfirmId === s.id ? ' pp-strip-remove--confirm' : ''}`}
                        data-tip={stripConfirmId === s.id ? '再击一次确认销毁' : '销毁纸条'}
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
                    <div className="pp-resize" onPointerDown={(e) => onResizePointerDown(e, s.id, 'strip', s.w)} />
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
                    /* 钉住的公共物：块状态 + 建钉时冻的卷名（抽纸条的「拖出卡片成条」
                      判据与纸条报头都读这两个属性——孤儿钉没有活流区/消息锚，
                      只能从 DOM 上看得出它是钉住的、来自哪一卷）。 */
                    data-block-state="pinned"
                    data-source-label={source?.label}
                    /* 孤儿钉的长按引用（2026-11-20）：它就是「摊在画布上的库卡」的常态宿主。 */
                    onPointerDown={(e) => beginQuoteHold(e, snapshotBlock, source ? source.sessionId : -1)}
                    data-quote-holding={quoteHoldingBlockId === pinId || undefined}
                    onDragStart={(e) => e.preventDefault()}
                    onMouseEnter={() => setTetherPinId(pinId)}
                    onMouseLeave={() => setTetherPinId((cur) => (cur === pinId ? null : cur))}
                  >
                    <BlockView
                      block={snapshotBlock}
                      /* 状态桥定位（2026-10-07 asset-state）：源卷未删才给会话键——
                         已删卷不写（写了会给已删的卷重建状态文件）；无工作区 = 不传。 */
                      sessionProjectPath={projectPath || undefined}
                      sessionId={source && !deadOrphanPinIds.has(pinId) ? String(source.sessionId) : undefined}
                      seq="PIN"
                      /* 孤儿钉也有资产动作行（2026-11-20 用户报：已经摊开的卡片没有「引用」）——
                         判据与活块同一份（assetOpsOf），只是它的来源是快照而非活消息。 */
                      ops={orphanOps.get(pinId) ?? EMPTY_OPS}
                      folded={foldedOf(snapshotBlock)}
                      sidecarFolded={sidecarFoldedOf(snapshotBlock)}
                      onToggleFold={onToggleFold}
                      onToggleSidecarFold={onToggleSidecarFold}
                      onSidecarPinPointerDown={onSidecarPinPointerDown}
                      onUnpin={onUnpin}
                      onDragHandlePointerDown={onBlockPointerDown}
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
                    <div className="pp-resize" onPointerDown={(e) => onResizePointerDown(e, pinId, 'pin', pin.w)} />
                  </div>
                );
              })}

              {/* 流序列：每流区块按序渲染（视口窗口化——视口外不进 DOM）。
                  2026-09-07 LOD 例外（用户拍板）：远缩档流块 DOM 仍退场（InkLayer
                  墨迹接管），但**钉住块不退**——LOD 不再隐藏钉在画布上的卡片。
                  2026-10-18 卷开合动效批：与流区叶同走 `regionRender`——落纸窗内的块
                  挂 `pp-drop`（墨自 18px 落下，**取代** `pp-enter`：同一属性两条动画
                  是整表替换）；离场卷的块挂 `pp-leaving`（起纸：淡去 + 墨随纸沉 18px），
                  且**不发首见印记**（印记已在卷离场时清掉；离场期若写回，重开卷就再没墨）。 */}
              {regionRender.map(({ view: r, leaving, spreading, rising }) =>
                r.blocks.map((b) => {
                  const slot = r.layout.get(b.id);
                  if (!slot || !r.visibleIds.has(b.id)) return null;
                  if (b.state === 'flow') {
                    if (lod) return null; // P4 缩远墨迹：流块 DOM 退场，InkLayer 接管
                    const firstSeen = !leaving && !seenBlocksRef.current.has(b.id);
                    if (firstSeen) seenBlocksRef.current.add(b.id);
                    /* 落纸窗内的块走 `pp-drop`（墨自 18px 落下，`--m-sheet`/io）——
                     * 与 `pp-enter`（8px/`--m-ink`）二选一：同一属性上两条动画是整表替换。
                     * **出生即交接**的卷（纸化成的）走同一条墨律但**不淡纸**：纸的淡出就是它的
                     * 入场，块只是落墨（见 region-motion.ts 头注「出生即交接」）。 */
                    const dropping = !leaving && (spreading || rising) && b.state === 'flow';
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
                        className={`pp-block pp-${b.kind}${firstSeen && !dropping ? ' pp-enter' : ''}${
                          dropping ? ' pp-drop' : ''
                        }${leaving ? ' pp-leaving' : ''}${
                          isDragged ? ' pp-dragging' : ''
                        }${inBand ? ' pp-drag-returning' : ''}${r.stageLeadIds.has(b.id) ? ' pp-stage-lead' : ''}${writing ? ' pp-writing' : ''}`}
                        style={{ transform: `translate(${dragX}px, ${dragY}px)`, width: b.w }}
                        data-message-id={b.source.messageId}
                        data-session-id={r.sessionId}
                        data-block-id={b.id}
                        data-block-state={b.state}
                        data-block-observed={
                          needsObservedHeight(b.kind, b.asset != null, blockHasView(b))
                            ? observedKeyOf(b, foldedOf(b), sidecarFoldedOf(b), sidecarOutOf(b))
                            : undefined
                        }
                        ref={blockRootRef}
                        /* 长按 320ms = **引用这张卡**（2026-11-20 用户要：摊开状态的卡也能长按）。
                           与块拖拽共存：过 8px 未满 320ms = 拖块/滚动（长按作废），
                           满 320ms 起手 = 引用（此时再移动才是「拖给某卷」）。 */
                        onPointerDown={(e) => beginQuoteHold(e, b, r.sessionNum)}
                        data-quote-holding={quoteHoldingBlockId === b.id || undefined}
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
                          /* 状态桥定位（2026-10-07 asset-state）：本块所属卷的工作区根
                             + 会话号（两个字符串，天然稳定——不新建对象击穿 memo）。 */
                          sessionProjectPath={projectPath || undefined}
                          sessionId={r.sessionId}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          folded={foldedOf(b)}
                          sidecarFolded={sidecarFoldedOf(b)}
                          onToggleFold={onToggleFold}
                          onToggleSidecarFold={onToggleSidecarFold}
                          onSidecarPinPointerDown={onSidecarPinPointerDown}
                          sidecarOut={sidecarOutOf(b)}
                          onSidecarRestore={onSidecarRestore}
                          onUnpin={onUnpin}
                          onRecallSubAgents={onRecallSubAgents}
                          onDragHandlePointerDown={onBlockPointerDown}
                          /* 空间手势立枝的握把：只在**判据通过**的块上（与「立枝」按钮
                             同一张表）——工具卡/通知块/未落定轮不长一个注定被拒的手势。 */
                          onBranchGripPointerDown={branchGrips.has(b.id) ? onBranchGripPointerDown : undefined}
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
                        data-block-state={b.state}
                        data-block-observed={
                          needsObservedHeight(b.kind, b.asset != null, blockHasView(b))
                            ? observedKeyOf(b, foldedOf(b), sidecarFoldedOf(b), sidecarOutOf(b))
                            : undefined
                        }
                        ref={blockRootRef}
                        /* 长按 320ms = **引用这张卡**（2026-11-20 用户要：摊开状态的卡也能长按）。
                           与块拖拽共存：过 8px 未满 320ms = 拖块/滚动（长按作废），
                           满 320ms 起手 = 引用（此时再移动才是「拖给某卷」）。 */
                        onPointerDown={(e) => beginQuoteHold(e, b, r.sessionNum)}
                        data-quote-holding={quoteHoldingBlockId === b.id || undefined}
                        onDragStart={(e) => e.preventDefault()}
                        onMouseEnter={() => setTetherPinId(b.id)}
                        onMouseLeave={() => setTetherPinId((cur) => (cur === b.id ? null : cur))}
                      >
                        <BlockView
                          block={b}
                          /* 状态桥定位（2026-10-07 asset-state）：同流内块。 */
                          sessionProjectPath={projectPath || undefined}
                          sessionId={r.sessionId}
                          seq={r.seq.get(b.id) ?? '000'}
                          ops={opsByBlock.get(b.id) ?? EMPTY_OPS}
                          folded={foldedOf(b)}
                          sidecarFolded={sidecarFoldedOf(b)}
                          onToggleFold={onToggleFold}
                          onToggleSidecarFold={onToggleSidecarFold}
                          onSidecarPinPointerDown={onSidecarPinPointerDown}
                          sidecarOut={sidecarOutOf(b)}
                          onSidecarRestore={onSidecarRestore}
                          onUnpin={onUnpin}
                          onRecallSubAgents={onRecallSubAgents}
                          onDragHandlePointerDown={onBlockPointerDown}
                          prov={provenanceText(volumeDisplayName(r.label, r.sessionNum), 'live')}
                          provTitle={provenanceTitle('live')}
                          provTraceable
                          onProvClick={onProvTrace}
                        />
                        {/* P2b 宽度手调面（右缘拖拽） */}
                        <div className="pp-resize" onPointerDown={(e) => onResizePointerDown(e, b.id, 'pin', b.w)} />
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

            {/* 长按引用·跟手浮签（2026-11-20）：起手后指针旁一枚小签，读作「这张卡现在跟着手」。
                屏幕坐标（本层是画布根，不吃世界变换）；纯视觉，pointer-events 全关。 */}
            {canvasQuoteHold.dragging && (
              <div
                className="pp-quote-ghost"
                style={{ left: canvasQuoteHold.x + 12, top: canvasQuoteHold.y + 12 }}
                aria-hidden="true"
              >
                引
              </div>
            )}
          </div>

          {/* 引线层（2026-09-18 出处引导，同批按用户判「直线直连有点劣质」重做）：
              hover/溯源中的钉 → 其源洞的一丝朱笔——**洞离屏时线照样出屏**，方向即
              来路（这正是「占位不在视口里就起不到引导作用」的答案）。
              层位 = **屏幕坐标**（同 .pp-sel-ink 那一族）：画布内绝对层，锚点在世界
              里定、投到屏上落墨 ⇒ 墨宽不随缩放变（世界 1px 在 zoom .3 下 = .3px，
              等于没画）。z 4：纸与块之上、坞（5）与一切浮件之下——引线不盖家具。 */}
          {tether && (
            <svg className="pp-tether-layer pp-pin-layer" aria-hidden="true">
              <path className="pp-tether" d={tether.d} />
              {/* 两端各一枚朱点（2026-09-22 锚点批）：起笔那枚正压在块缘的常显锚点上，
                  收笔那枚压在洞的锚点上——「线是引，点是落」，现在两头都是落。 */}
              <circle className="pp-tether-origin" cx={tether.origin.x} cy={tether.origin.y} r={2.2} />
              <circle className="pp-tether-bead" cx={tether.bead.x} cy={tether.bead.y} r={2.2} />
            </svg>
          )}

          {/* 枝边层（P3 会话树「枝」）：**常显**的一丝朱砂引线——枝卷卷首 → 父卷那个节点。
              同一支笔（`.pp-tether` 的墨），同一层位（屏幕坐标）。与钉那条腿的差别只有
              「常显（树是结构）」——**线不是控件**（2026-09-24 第二刀，同匣脚那条腿）：
              本层原带受墨带（role=button + tabIndex + 点线飞回父卷节点），账上无用户拍板
              依据（`docs/archive/session-line/session-tree-plan.md` §9 已拍板表里没有它）；用户「我从来也没有拍板过
              引线本体要做成按钮」⇒ 受墨带 / 点击 / 焦点态整批摘除，整层 aria-hidden。
              **代价明账**：屏幕上的「跳回父卷分叉节点」入口随之消失（枝卷卷首眉行那枚
              「枝」缀字是纯文本、无动作）——要恢复须另立一个**真控件**入口，不复活引线按钮。
              节点不在视口内时线照样出屏（同款判据）。 */}
          {branchTethers.length > 0 && (
            <svg className="pp-tether-layer pp-branch-layer" aria-hidden="true">
              {branchTethers.map((t) => (
                <g key={t.childSid}>
                  <path className="pp-tether pp-branch-tether" d={t.d} />
                  <circle className="pp-tether-origin" cx={t.origin.x} cy={t.origin.y} r={2.2} />
                  <circle className="pp-tether-bead" cx={t.bead.x} cy={t.bead.y} r={2.2} />
                </g>
              ))}
            </svg>
          )}

          {/* 匣脚引线（2026-09-22）：**常显**的一丝朱砂——坞的版口钮 → 活卷的纸脚。
              两端都扎在实体上（坞顶左端那枚 56×3 朱短横 / 纸的材料底缘），线只是把
              「这一匣对着这一卷」画出来。坞在 z 6 之上、线在 z 4 ⇒ 线不盖家具，坞端
              起点那枚朱点落在钮上。坞被拖走 / 切卷 / 平移缩放都随几何重算（两端各自
              单一真源）。无活卷 / 案头态 ⇒ 整层不在场。
              **纯指示·不可点**（2026-09-24 归因更正）：本层曾带受墨带（`role="button"`
              + tabIndex + 点线飞到纸脚），账上记为用户拍板，实为 agent 自记——用户原话
              「我从来也没有拍板过引线本体要做成按钮」。线不是控件：不吃指针、不进 Tab 序
              ⇒ 整层 `aria-hidden`（同 `.pp-pin-layer` 那条瞬时腿）。 */}
          {dockTether && <DockTetherLayer geom={dockTether} />}

          {/* 立枝手势的**拖动预览**（P4-①，2026-09-19）：按住「枝」握把拖动时的一丝引线
              ——起笔在原块缘、朱点落在指针上（落点即所见）。同一支笔（.pp-tether 的墨）、
              同一层位（屏幕坐标、不吃指针），与枝边层只差「这是手势不是结构」。
              拖动中不吃事件（.pp-tether-layer pointer-events:none）⇒ mouseup 照常落在纸上。 */}
          {branchDragTether && (
            <svg className="pp-tether-layer pp-branch-drag-layer" aria-hidden="true">
              <path className="pp-tether" d={branchDragTether.d} />
              <circle
                className="pp-tether-origin"
                cx={branchDragTether.origin.x}
                cy={branchDragTether.origin.y}
                r={2.2}
              />
              <circle className="pp-tether-bead" cx={branchDragTether.bead.x} cy={branchDragTether.bead.y} r={2.2} />
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
            <span className="pp-title" data-tip="按住拖动窗口（双击最大化）">
              画布
            </span>
            {/* 缩放控件（2026-09-08 缩放舒适度拍板）：−/+ 阶梯步进（ZOOM_STEPS
                常用档）、点读数回 100%——滚轮平滚模式下缩放的零修饰键落点。
                读数 hover 提示保留画布统计；键盘 +/−/0 同语义。 */}
            <div
              className="pp-zoom-ctl"
              data-tip={`画布读数：${totalBlocks} 块 · 已钉 ${totalPinned} · 纸条 ${totalStrips} · 滚轮平滚 / Ctrl+滚轮缩放`}
            >
              <button
                type="button"
                className="pp-zoom-btn"
                aria-label="缩小一档"
                data-tip="缩小一档（键盘 −）"
                onClick={() => stepZoom(-1)}
              >
                −
              </button>
              <button
                type="button"
                className="pp-zoom-val"
                aria-label="缩放回到 100%"
                data-tip="回到 100%（键盘 0）"
                onClick={resetZoom}
              >
                {/* 读数微动效（§15 批 5）：`key = zoomTick` ⇒ **离散步进**（−/＋ 或键盘）
                    时这个 span 重挂、`pp-readout-tick` 随挂载自动重播一次；滚轮连续缩放
                    不抬计数故不重播（每帧重播会读成抖动）。key 挂在内层 span 而非按钮上
                    ——重挂按钮会丢焦点（键盘用户点它回 100%，焦点必须留在原处）。 */}
                <span key={zoomTick} className="pp-zoom-num">
                  {zoomLabel}
                </span>
              </button>
              <button
                type="button"
                className="pp-zoom-btn"
                aria-label="放大一档"
                data-tip="放大一档（键盘 +）"
                onClick={() => stepZoom(1)}
              >
                ＋
              </button>
            </div>
            <StatusLine running={activeRunning} />
            {/* 架阁（entity-shelf-plan B3，2026-12-08 用户拍板）：顶部浮件一枚两字件，
                与「画布 / 设置 / 回首页」同排同规格；点开是那本两页浮层（软件型 / 卡片型）。
                排在设置左侧——设置是"改配置"，架阁是"看我手上有什么"，后者更常用。 */}
            <button
              type="button"
              className="pp-settings"
              data-tip="架阁：我手上的软件与卡片"
              onClick={() => useShelfStore.getState().openShelf()}
            >
              架阁
            </button>
            <button
              type="button"
              className={`pp-settings${updateAvailable ? ' has-update' : ''}`}
              data-tip={
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
              2026-09-17 浮动化：坞位 state 归 useComposerFloat（style 为 undefined
              = 无覆盖 = CSS 默认居中坐底）；**默认锁定**——点坞顶浮现的锁钮（移/锁，
              桌面歌词式）解锁后整坞才是抓手，双击坞体复位（判据在 composer-float.ts
              的 isComposerDragSurface）。
              ⚡ 2026-11-28 案头态退役：**零卷时坞槽整只不渲染**（见下方条件）。旧形态
              pp-at-desk（退匣直书 + 签条架）是待题纸之前的出生面，与「＋ 另起一卷」落纸
              重复；出生面唯一 = 待题纸，「续写旧卷」签条架搬进空态块（.pp-empty）。 */}
          {/* ⚡ 2026-11-15 V2：纸在场时**坞槽整只不渲染**（不是隐藏输入条）——纸替坞。
              判据已订阅（焦点在纸上），开纸那一刻坞就退场，不留一帧两层叠着。**多纸改判**：
          判据是「焦点在纸上」，不是「纸在画布上」——纸摆在画布上不拿焦点时，坞照常对着
          活跃卷工作（纸在时不许跟已有会话说话，正是用户 2026-11-17 报的那条）。
              **化卷交接（2026-11-16 改判 edge）**：交接窗里坞**从屏幕下缘之外升上来**
              （`pp-composer-rise`）——题签期那条输入面在纸上、坞在屏底，两者差 475px，
              若让坞在终点直接出现，中间没有任何一帧交代「同一个东西挪过去了」，读作跳变。
              升起是连续位移，起点完全在屏外：它没有「出现」的那一帧。 */}
          {sessions.length > 0 && (!draftFocusOn || draftMorphOpen) && (
            // biome-ignore lint/a11y/noStaticElementInteractions: 坞槽承载拖坞手势（拖动面判据在 composer-float.ts 的 isComposerDragSurface——锁定态一律放行）
            <div
              className={`pp-composer-slot${composer.dragging ? ' pp-composer-dragging' : ''}${
                composer.unlocked ? ' pp-composer-unlocked' : ''
              }${draftMorphOpen ? ' pp-composer-rise' : ''}`}
              ref={composer.slotRef}
              style={composer.style}
              data-pop-side={composer.popSide}
              onPointerDown={composer.onPointerDown}
              onDoubleClick={composer.onDoubleClick}
            >
              {composerOverlays.map((def) => (
                /* 保险丝 b：覆盖层贡献行（插件面）包边界——创作坞崩溃不卸整树 */
                <PluginBoundary key={def.id} label={`覆盖层 ${def.id}`}>
                  <def.component />
                </PluginBoundary>
              ))}
              {/* 化卷交接窗的病根**不在这里**（2026-11-15 实测更正）：坞本就随 `open` 转 false 当帧
                  挂上（订阅是同步的），空窗并不存在——原判据「两条订阅错拍」是误诊。真问题是
                  **纸整张盖在坞上**直到窗满（Z 序 + 不透明纸），于是坞那 260ms 的入场看不见。
                  治法在纸那边：纸撤字、后撤纸，两者同窗收尾（见 draft-sheet.css 化卷段）。 */}
              {/* 拖动锁按钮**不在这里**（2026-09-17 二版）：它归坞的书眉工具行，
                由坞本体渲染（`PaperDockContext.composerLock` 能力位——锁态与写面在
                本槽主人手里）。曾试过「槽里浮一枚 hover 小钮」，两个病灶：浮在坞外
                与坞之间有缝、悬停链被掐断（用户「还没挪过去就消失了」），且外观
                与坞的语言不合（用户「太难看了」）。 */}
            </div>
          )}
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
      {/* 架阁浮层（B3）：常挂在纸壳根——开合由 shelf-store 决定，关着 = 零渲染。 */}
      <ShelfOverlay />
    </PaperDockContext.Provider>
  );
}
