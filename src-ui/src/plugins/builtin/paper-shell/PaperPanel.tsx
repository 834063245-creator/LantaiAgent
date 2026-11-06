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

import { type CSSProperties, Fragment } from 'react';
import { volumeDisplayName } from '../../../state/volume-name';
import { FolioCompositionChip } from './FolioCompositionChip';
import {
  blockFromSnapshot,
  ConfirmDialog,
  Icon,
  onTopbarDoubleClick,
  onTopbarPointerDown,
  PaperDockContext,
  PaperRegionContext,
  PluginBoundary,
  useDockStore,
  WinControls,
} from './host';
import { InkLayer } from './InkLayer';
import { blockHasView, needsObservedHeight, observedKeyOf } from './measure';
import { BlockView, DeskShelf, EMPTY_OPS, folioSubLine } from './paper-panel-parts';
import { type ProvenanceState, provenanceText, provenanceTitle, provenanceTraceable } from './provenance';
import { StatusLine } from './StatusLine';
import { sheetCharacter } from './sheet';
import { ToastHost } from './ToastHost';
import { blockReturnsToFlow } from './use-paper-drag';
import { GHOST_H } from './use-paper-regions';
import './PaperPanel.css';
import { usePaperPanelAssembly } from './use-paper-panel';

export function PaperPanel() {
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
    dockContext,
    regionContext,
    dockTether,
    activateRegion,
    onRegionCornerMouseDown,
    onResizeMouseDown,
    branchGrips,
    onBranchGripMouseDown,
  } = usePaperPanelAssembly();

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

          {/* biome-ignore lint/a11y/noStaticElementInteractions: 无限画布是鼠标平移/缩放交互面 */}
          <div
            ref={canvasRef}
            /* `pp-live-hand` = 手律态（§15）：整区拖动 / 四角缩放中，块体随流区每帧
               重排，让位过渡必须摘掉（带 260ms 缓动即成橡皮筋）。与 `pp-stream-live`
               同族：都是「画布当下处于哪种运动」的声明，由壳层发放、CSS 只管消费。 */
            className={`pp-canvas${panning ? ' pp-panning' : ''}${streamLive ? ' pp-stream-live' : ''}${
              edgeDragPos || regionCornerPos ? ' pp-live-hand' : ''
            }`}
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

              {/* 流区容器（一纸多卷：每会话一块有界流区——边缘拖动移动整区）。
                  2026-10-18 卷开合动效批：本图渲染「活跃卷 + 在窗的离场卷」——
                  离场卷（`data-leaving`）**绕开虚拟化**（否则一卷刚飞出视口就被裁掉，
                  退场动画只看得到半截），且不接活跃/带显形/手势与落纸入场。 */}
              {regionRender.map(({ view: r, leaving, spreading }) => {
                if (!leaving && !visibleRegionIds.has(r.sessionId)) return null;
                const isActive = !leaving && r.sessionId === activeSessionKey;
                /* 落纸入场（纸淡入）：在**落纸窗**内即挂类（窗满由 region-motion 摘）。
                 * 离场卷不挂（它在起纸）。 */
                const isSpread = !leaving && spreading;
                const sheet = sheetCharacter(r.sessionId);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: 流区是可点击交互面（点背景激活流区）
                  <div
                    key={r.sessionId}
                    className={`pp-region${isActive ? ' pp-region-active' : ''}${
                      isSpread ? ' pp-spread' : ''
                    }${!leaving && bandSessionId === r.sessionId ? ' pp-region--band' : ''}`}
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
                    onMouseDown={
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
                          data-tip="拖动边缘——移动整个流区"
                          onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                        />
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: 边缘拖拽面（同左缘——拖右缘移动整个流区） */}
                        <div
                          className="pp-region-edge pp-region-edge--r"
                          data-tip="拖动边缘——移动整个流区"
                          onMouseDown={(e) => onRegionEdgeMouseDown(e, r.sessionId)}
                        />
                        {/* P6 四角横向缩放柄（角落只开放横向——Y 由内容生长） */}
                        {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                          // biome-ignore lint/a11y/noStaticElementInteractions: 角柄是拖拽交互面
                          <div
                            key={c}
                            className={`pp-region-corner pp-region-corner--${c}`}
                            data-tip="拖动角柄——调整流区宽度"
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
                    /* 钉住的公共物：块状态 + 建钉时冻的卷名（抽纸条的「拖出卡片成条」
                      判据与纸条报头都读这两个属性——孤儿钉没有活流区/消息锚，
                      只能从 DOM 上看得出它是钉住的、来自哪一卷）。 */
                    data-block-state="pinned"
                    data-source-label={source?.label}
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
                  墨迹接管），但**钉住块不退**——LOD 不再隐藏钉在画布上的卡片。
                  2026-10-18 卷开合动效批：与流区叶同走 `regionRender`——落纸窗内的块
                  挂 `pp-drop`（墨自 18px 落下，**取代** `pp-enter`：同一属性两条动画
                  是整表替换）；离场卷的块挂 `pp-leaving`（起纸：淡去 + 墨随纸沉 18px），
                  且**不发首见印记**（印记已在卷离场时清掉；离场期若写回，重开卷就再没墨）。 */}
              {regionRender.map(({ view: r, leaving, spreading }) =>
                r.blocks.map((b) => {
                  const slot = r.layout.get(b.id);
                  if (!slot || !r.visibleIds.has(b.id)) return null;
                  if (b.state === 'flow') {
                    if (lod) return null; // P4 缩远墨迹：流块 DOM 退场，InkLayer 接管
                    const firstSeen = !leaving && !seenBlocksRef.current.has(b.id);
                    if (firstSeen) seenBlocksRef.current.add(b.id);
                    /* 落纸窗内的块走 `pp-drop`（墨自 18px 落下，`--m-sheet`/io）——
                     * 与 `pp-enter`（8px/`--m-ink`）二选一：同一属性上两条动画是整表替换。 */
                    const dropping = !leaving && spreading && b.state === 'flow';
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
                        }${inBand ? ' pp-drag-returning' : ''}${r.stageLeadIds.has(b.id) ? ' pp-stage-lead' : ''}${
                          r.verifyDoneIds.has(b.id) ? ' pp-verify-done' : ''
                        }${writing ? ' pp-writing' : ''}`}
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
                          onSidecarPinMouseDown={onSidecarPinMouseDown}
                          sidecarOut={sidecarOutOf(b)}
                          onSidecarRestore={onSidecarRestore}
                          onUnpin={onUnpin}
                          onDragHandleMouseDown={onBlockMouseDown}
                          /* 空间手势立枝的握把：只在**判据通过**的块上（与「立枝」按钮
                             同一张表）——工具卡/通知块/未落定轮不长一个注定被拒的手势。 */
                          onBranchGripMouseDown={branchGrips.has(b.id) ? onBranchGripMouseDown : undefined}
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
          {dockTether && (
            <svg className="pp-tether-layer pp-dock-layer" aria-hidden="true">
              <path className="pp-tether pp-dock-tether" d={dockTether.d} />
              <circle className="pp-tether-origin" cx={dockTether.origin.x} cy={dockTether.origin.y} r={2.2} />
              <circle className="pp-tether-bead" cx={dockTether.bead.x} cy={dockTether.bead.y} r={2.2} />
            </svg>
          )}

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
