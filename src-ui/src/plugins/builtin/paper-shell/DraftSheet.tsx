// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DraftSheet — **待题纸**（新卷出生面，2026-11-14 立项；**2026-11-15 定稿改判 V2**；
// **2026-11-17 多纸改判**）。
//
// 设计件：docs/plans/canvas-space/new-session-ux.md；多纸：multi-draft-sheets.md。
//
// 一句话：点「＋」在画布落一张**会打字的纸**——卷首已具形（玉徽 / 眉行「待题 · 未开卷」/
// 题字「案卷 __」），天头之下**就是这张卷的创作坞**；按发送那一刻才发号建卷，纸化作
// 正常的卷、正常的创作坞冒出来。
//
// 三条纪律（设计件 §2/§4/§8，施工时最容易破的三处）：
//   ① **纸不是层**：出生面是画布世界里的一张纸，不是模态框 / 全屏引导——
//      「整个窗口是一张纸、没有第二层」是纸壳地基（一张纸设计件 §2.1）。
//   ② **纸面只有一个主动作 = 发送**：没有「开卷」按钮（V1 有，V2 删）。开卷的真实
//      含义就是「我说了第一句话」；题签的不可晚定由**第一次发送**这道闸保护。
//   ③ **不复制输入面**：天头之下那张 = 创作坞**同一个组件**（`ComposerSheet`，经
//      `overlays` 的 'draft-sheet' 槽注册，本件只负责给槽）。纸与坞共用同一份实现，
//      但**各有各的草稿槽**（多纸改判：纸不再占用面板那份 live 槽）。
//
// **多纸（2026-11-17）**：画布上可以同时有多张纸。每张纸一条记录（`papers[]`），
// 各自锚点 / 题签 / 失败原因 / 草稿槽。**焦点独占**：只有 `focusedId` 那张纸展开
// 完整输入面（吃键盘），其余只显示「天头 + 题签一行」——点它即拿回焦点。
// 焦点在纸上时坞让位；点任意一卷 / 画布空白 ⇒ 焦点交回坞，纸留在画布上不动。
//
// 落位：纸在 `.pp-world` 里（与流区同一坐标语言），位置 = 流区自动落位同一把尺子
// （nearestFreeRegion + viewportCenterWorld，见 draft-sheet.ts）；开卷时流区写进
// 同一个锚点（`ChatCore.openDraftVolume`）⇒「纸在哪，卷就落哪」，不跳位。
//
// V1 的三条断言留作判据（勿重犯）：题签 = 纸上的三行注疏 / 开卷按钮 / 坞隐藏输入条。
// 前两条已被 V2 推翻，第三条改为「焦点在纸上时坞让位」。

import type React from 'react';
import { type CSSProperties, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { type DraftSheetCore, draftBoxInSight, draftFocusPoint, draftPlacement, draftScale } from './draft-sheet';
import {
  activeOverlayContributions,
  type DraftSheetAnchor,
  draftSheetSeed,
  EMPTY_REGION_CONTENT_H,
  Icon,
  PaperDockContext,
  PluginBoundary,
  REGION_FOOT_GAP,
  resolveNewSessionDefault,
  STREAM_REGION,
  subscribeOverlayContributions,
  useCanvasViewStore,
  useDraftSheetStore,
  usePresetStore,
} from './host';
import { measureFolioHeadHeight } from './measure';
import { sheetCharacter } from './sheet';
import './draft-sheet.css';

/** 纸的纸性种子（出生面期）。**必须固定**：纸还不是卷，没有卷 id——用常量串取一套纹理，
 *  开卷那一刻换成新卷 id（见 store 的 `draftSheetSeed`），交接窗里纸与卷就是同一张纸。
 *  （随机种子会让每次开纸都是另一张纸——纸纹是材料身份，不是装饰。） */
const SHEET_SEED = 'draft-sheet';

/** 待题纸群（画布上可以有多张；每张一条记录，各自一份草稿槽）。 */
export function DraftSheet({ core }: { core: DraftSheetCore | null }) {
  const papers = useDraftSheetStore((s) => s.papers);
  const morphs = useDraftSheetStore((s) => s.morphs);
  const focusedId = useDraftSheetStore((s) => s.focusedId);

  /* ── 纸上那张输入面：经 overlays 的 'draft-sheet' 槽取（热注册即时重取）──
   * 纸替坞：本槽是**同一个** ComposerDock 的另一次挂载（见该文件 ComposerSheet 头注）。
   * 多纸：**只给焦点那张纸挂**——两处 textarea 同屏会抢输入（焦点独占）。 */
  const [, setOverlayTick] = useState(0);
  useEffect(() => subscribeOverlayContributions(() => setOverlayTick((t) => t + 1)), []);
  const sheetOverlays = activeOverlayContributions('draft-sheet');

  /* ── Esc = 弃纸（不烧号、不落盘、画布无残留）──
   * 多纸：**只弃焦点那张**（焦点不在纸上时 Esc 不归本件管）。
   * 注意：纸上那张输入面自己也听 Esc（斜杠面板先吃）。本监听在 **capture** 阶段、
   * 且只在输入面之外生效——判据 = 事件源不在纸内输入件上时才算弃纸。 */
  useEffect(() => {
    if (focusedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 事件源可能是 Document/window（测试与合成事件），不保证有 closest。
      const el = e.target as HTMLElement | null;
      const inField = typeof el?.closest === 'function' && el.closest('textarea, input, [role="listbox"]') !== null;
      if (inField) return; // 输入面自己处理（斜杠面板 / 弹层）
      if (e.defaultPrevented) return;
      e.stopPropagation();
      core?.dismissDraft?.(focusedId);
      useDraftSheetStore.getState().dismissOne(focusedId);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [focusedId, core]);

  if (papers.length === 0 && Object.keys(morphs).length === 0) return null;

  return (
    <>
      {papers.map((paper) => (
        <PaperView
          key={paper.id}
          paperId={paper.id}
          anchor={paper.anchor}
          presetSeed={paper.presetId}
          notice={paper.notice}
          focused={paper.id === focusedId}
          overlays={sheetOverlays}
          core={core}
        />
      ))}
      {Object.entries(morphs).map(([paperId, morph]) => (
        <MorphView key={paperId} paperId={paperId} morph={morph} />
      ))}
    </>
  );
}

/** 一张**在办**的纸（还没开卷）：自己量高、自己落位、焦点那张自己跟镜头。 */
function PaperView({
  paperId,
  anchor,
  presetSeed,
  notice,
  focused,
  overlays,
  core,
}: {
  paperId: string;
  anchor: DraftSheetAnchor | null;
  presetSeed: string | null;
  notice: string | null;
  focused: boolean;
  overlays: ReadonlyArray<{ id: string; component: React.ComponentType }>;
  core: DraftSheetCore | null;
}) {
  const presetSelected = usePresetStore((s) => s.selected);
  const picks = useDraftSheetStore((s) => s.papers.find((p) => p.id === paperId)?.picks ?? null);
  const setAnchor = useDraftSheetStore((s) => s.setAnchor);
  const setPicks = useDraftSheetStore((s) => s.setPicks);
  const setNotice = useDraftSheetStore((s) => s.setNotice);
  /* 盒高回写（化卷那一刻 `beginMorph` 取快照——交接期纸盒一帧都不动）。 */
  const setBoxH = useDraftSheetStore((s) => s.setBoxH);
  const landNonce = useDraftSheetStore((s) => s.landNonce);
  /* 画布尺寸只作**重试扳机**（首测尺寸为 0 时本拍跳过，尺寸一到再来一次）；
   * 落点与镜头目标仍从 getState() 现取，不吃渲染期快照。 */
  const canvasSize = useCanvasViewStore((s) => s.canvasSize);

  /* ── 落位 = 落纸 + 把镜头带过去（2026-11-16 用户报「点了新建视角不跟过去」）──
   *  落点是**视口中心最近的空位**：画布上卷一多，最近空位就在屏外。只写 anchor 不飞
   *  ⇒ 用户按下「＋」后画面纹丝不动，还得满画布找那张纸。故两件事同一拍：
   *    ① 算锚点（`draftPlacement`，与卷的自动落位同一把尺子）；
   *    ② 把镜头带到这张纸（`draftFocusPoint` → 槽主人的 `glideTo`）。
   *  聚焦走 `PaperDockContext` 的**能力位**（缺席 = 不飞，纸照常落位）——待题纸不是卷、
   *  没有 sessionId，`requestFocus` 那条通道对它不成立；本组件在 PaperPanel 的 provider
   *  之内（同树见 PaperPanel 的 <DraftSheet />），故 `useContext` 直接取，不经 usePaperDock
   *  （那个钩子在 provider 外会抛，而测试可以单独挂这张纸）。
   *  代数 `landNonce`：点某张纸 = 把镜头带回它，几何可能一字未变，仍要回镜头。 */
  const dockCtx = useContext(PaperDockContext);
  const glideToRef = useRef(dockCtx?.glideTo ?? null);
  glideToRef.current = dockCtx?.glideTo ?? null;
  const landedNonce = useRef(0);

  /* ── 纸高实测（V2：纸高随内容长——输入面多行/附件 rail/失败行都会变）──
   * 纸以**下缘锚点**向上长：top = 锚点 − 实测高。
   *
   * ⚠ **量的是天头之下那块栈（`.pp-draft-stack`），不是纸自己**（2026-11-18 化卷
   * 错位批）：纸的盒高（inline `height`）正是由本状态算出来的——量纸自己 = 自指，
   * `offsetHeight` 恒等于 inline height，RO 永远读到同一个数。旧实现因此让
   * 「纸高随内容长」成了死代码：输入面一多写几行就冲出纸脚（用户报的「文字冲出题签
   * 背景」的下半截；天头那半截 2026-11-15 已修）。
   * 栈是定高 flex 容器里的 `flex: none` 项（见 draft-sheet.css）⇒ 量到的是内容真高。
   * 用 RO 而不是量一次：输入面自己会随打字增高，量一次会在第一个换行处露馅。
   * jsdom 无 RO：退回量首帧（测试自铺桩，与 use-composer-float 同款纪律）。 */
  const [contentH, setContentH] = useState(0);
  const measureStack = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setContentH((prev) => (prev === el.offsetHeight ? prev : el.offsetHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 首帧落位（视口中心最近的空位——与流区落位同一把尺子）── */
  useEffect(() => {
    if (anchor !== null || !core) return;
    setAnchor(draftPlacement(core), paperId);
  }, [anchor, core, paperId, setAnchor]);

  /* ── 首帧填出厂题签（预选组合 = 造模式入口传进来的；其余取出厂默认）──
   * 题签住 store（不在此组件态）：**发送面要读它**（`ChatCore.sendMessage` 起卷时登记
   * 组合、写会话覆盖）。放组件态 = 两处真源。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这张纸的 picks 一旦写下就不该被重设（presetSelected 刻意不在依赖里——开纸途中改全局默认不许冲掉用户刚题的签）
  useEffect(() => {
    if (picks !== null) return;
    setNotice(null, paperId);
    // 出厂题签的模型/思考 = 此刻的「新卷出生默认」（settings 活跃行）；组合 = 预选 ?? 全局默认。
    const base = resolveNewSessionDefault();
    setPicks(
      {
        presetId: presetSeed ?? presetSelected,
        providerName: base.providerName,
        model: base.model,
        thinking: base.thinking,
      },
      paperId,
    );
  }, [paperId, presetSeed, picks, setPicks, setNotice]);

  /* ── 卷首实测高（FOLIO_TOKENS 契约；题字按流区宽实测行数）──
   * 纸与卷**同一个数**：纸这里的题字恒是「案卷 Nº」（纸还没有名字），卷那边是
   * volumeDisplayName（可能是长题名、换行更多）。两边各自算各自的，交接靠
   * MorphView 的 `--draft-rise` 抹平差值——不要在这里改成猜卷的名字。 */
  const folioH = measureFolioHeadHeight('案卷', STREAM_REGION.width);
  /* **纸高垫到「卷的最小盒高」**（2026-11-15 用户报「文字冲出题签背景」）：
   * 病灶 = 纸高由内容实测（输入面多高纸就多高），而卷的盒高恒 ≥
   * `EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP`（零块卷也有 200 + 72 的纸面）。
   * 纸一旦比这个矮，交接那一拍就是「小纸 → 大卷」的跳变。
   * ⚠ 2026-11-18：这个下限**卷侧也按同一个数夹了**（use-paper-regions 的 regionTop
   * 下限）——此前只有纸垫到下限，卷一旦落进一条短来文就比纸矮，天头跟着往下掉。
   * 两边同值，才是真的「同一个盒」。
   *
   * ⚠ 天头的让位在 **CSS** 里（.pp-draft-stack 的 padding-top 读 --draft-folio-h）：
   * 纸高由纸栈实测撑出来，而 .pp-folio-head 是绝对定位、不吃流——栈不从天头下面起，
   * 纸就比内容矮一个天头（用户报的「文字冲出题签背景」正是这一条）。这里因此**不再**
   * 往 boxH 上补贴 folioH（那是同一笔钱数两遍）。 */
  const regionMinH = EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP + folioH;
  /* **合上的纸按内容收高**（2026-11-17 用户报「无焦点状态 UI 太难看」的第二半）：
   * 焦点那张必须垫到「卷的最小盒高」（化卷那一拍盒底/盒高要与卷对得上），而**合上的**
   * 那张没有输入面、也不参与交接——再垫到 272 + 天头就是**下半截全空**的一页白纸。
   * 故无焦点时只垫到「天头 + 合口 + 注记 + 去处」这一小段（页高随内容走，实测撑）。 */
  const boxH = focused ? Math.max(contentH, regionMinH) : Math.max(contentH, folioH + 96);

  /* ── 焦点那张纸：落位那一拍把镜头带过去（只在**要不要动镜头**上做判断）── */
  useEffect(() => {
    void canvasSize; // 只作重试扳机（同 use-paper-panel 的 motionTick 范式）：真值仍从 getState 现取
    if (!focused || !core || anchor === null) return;
    if (landedNonce.current === landNonce) return;
    const view = useCanvasViewStore.getState();
    /* 画布还没量到尺寸（挂载首帧之前）：无从判可见、也无从算「该飞到哪」——
     * 这一拍整只跳过，**且不消耗代数**（尺寸一到，下一次依赖变化会重跑本 effect）。 */
    if (view.canvasSize.w <= 0 || view.canvasSize.h <= 0) return;
    landedNonce.current = landNonce;
    /* 盒高 = **纸实际渲染的那个盒**（`boxH`：含天头）。
     * ⚠ 2026-11-18 前这里另算了一个「零块卷最小盒高」（少了 folioH 那 ~218px）——
     * 于是镜头按一个矮 218 的盒把纸对到视口正中，纸落下来天头被推出屏外。 */
    /* 纸已经整块在视口里 ⇒ **一动不动**：视角是用户的，自动动作只在「你按了＋却看不见」
     * 这一种情形里才配动它（同 2026-09-01 视角抢夺修复的口径）。
     * 能力位缺席 = 不飞，纸照常落位（纸面不炸——与 FolioCompositionChip 同款纪律）。 */
    if (draftBoxInSight(anchor, view.view, view.canvasSize, boxH)) return;
    const focus = draftFocusPoint(anchor, boxH);
    glideToRef.current?.(focus.x, focus.y);
  }, [focused, core, anchor, landNonce, canvasSize, boxH]);

  /* 纸性（2026-11-15 化卷批）：纸与卷**同一张纸**——同一张 paper-sheet 纹、同一套水洗。
   * 出生面期 = 固定种子；交接期 = 新卷 id（store 的 draftSheetSeed）。 */
  const sheet = sheetCharacter(draftSheetSeed(paperId, SHEET_SEED));
  const scale = draftScale(anchor?.width ?? STREAM_REGION.width);
  /* **纸盒 = 卷盒**（2026-11-15 用户报「题签到真实卷没有好的动画过渡」的根因）：
   * 卷的盒底恒在 `锚点 + REGION_FOOT_GAP`（流区几何：regionHeight 已含底距），
   * 而纸原先以**锚点**为底线 —— 于是化卷那一拍纸是「往上跳 72px 再淡出」。
   * ⇒ 纸也以 `锚点 + REGION_FOOT_GAP` 为底：两件同一个盒，淡出/淡入就地重叠，
   * 读作「这张纸成了那一卷」而不是「纸没了、别处冒出个卷」。
   * 宽的同一性由 draftPlacement 保证（都用 STREAM_REGION.width 与同一锚点）。 */
  const boxBottom = (anchor?.anchorY ?? 0) + REGION_FOOT_GAP;

  /* 实测盒高回写 store：交接期（记录已离开 `papers`）纸面量不到了，只能由快照接手。 */
  useEffect(() => {
    if (anchor === null || boxH <= 0) return;
    setBoxH(boxH, paperId);
  }, [anchor, boxH, paperId, setBoxH]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 纸是画布上的一件「物件」（同 .pp-region 的 mousedown 激活语义——点纸张即拿到它）；键盘路径见下方 tabIndex/onKeyDown 那两条腿。
    <div
      className={`pp-region pp-draft-sheet${focused ? ' pp-draft-focused' : ' pp-draft-idle'}`}
      data-draft-sheet
      data-paper-id={paperId}
      data-body-state={notice ? 'rejected' : 'ready'}
      data-focused={focused ? 'true' : undefined}
      /* 合上的纸是**可达的**（2026-11-17）：无焦点时它整张就是那句「点这张纸继续题签」
       * 的落点——鼠标走 mousedown，键盘走 tabIndex + Enter/Space（同一件事两条腿）。 */
      {...(focused
        ? null
        : {
            role: 'button' as const,
            tabIndex: 0,
            'aria-label': '点这张纸继续题签',
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              core?.focusDraft?.(paperId);
            },
          })}
      /* 2026-11-17 批 C3：纸内换焦点与「点纸外交回焦点」必须**同一事件面**——
       * 画布侧已改 pointerdown，这里若留 mousedown，点非焦点纸会先交回卷、再换回纸。 */
      onPointerDown={() => {
        if (!focused) core?.focusDraft?.(paperId);
      }}
      style={
        anchor
          ? ({
              left: anchor.anchorX - anchor.width / 2,
              width: anchor.width,
              /* 纸以**锚点**为底线向上长（内容高随输入面变化，不写死）：
                 top = 锚点 − 实测高。首帧未测（contentH=0）= 取卷的最小盒高，
                 RO 一到即回填——**绝不用 translate: -100% 代替**：那会参与层叠/
                 纸纹对位（纸律：整叶不得声明 transform，见 base.css 注）。 */
              // 盒底 = 锚点 + 底距（与卷的纸脚同一个尺子）；盒高取「内容实测 vs 卷的最小盒高」
              top: boxBottom - boxH,
              height: boxH,
              // 卷首实测高（FOLIO_TOKENS 契约）——正文区按它下移，禁在 CSS 里手写数字
              '--draft-folio-h': `${folioH}px`,
              // 纸性三参（真源 = sheet.ts）：与流区叶同名同义（见 .pp-region）
              '--sheet-ox': `${sheet.ox}px`,
              '--sheet-oy': `${sheet.oy}px`,
              '--sheet-j': `${sheet.j}`,
            } as CSSProperties)
          : { visibility: 'hidden' }
      }
    >
      <div className="pp-folio-head">
        <div className="pp-folio-inner">
          {/* 玉徽照常实印（V1 判据 ④ 保留）：卷首本身是成立的，待题靠**眉行 + 卷号空位**说。 */}
          <span className="pp-yuwei" style={{ transform: `scale(${scale})` }}>
            <Icon name="lantai" size={26} />
          </span>
          {/* 眉行「待题」而不是卷次：**卷号还没发**——这一行就是「纸还没成立」的机读断言 */}
          <p className="pp-folio-eyebrow">{focused ? '待题 · 未开卷' : '待题 · 另有一纸'}</p>
          <h2 className="pp-folio-title">
            案卷<span className="pp-draft-num">Nº</span>
          </h2>
          <p className="pp-folio-sub">题签随首句落账 · 卷号于发送时发出</p>
        </div>
      </div>

      {/* 天头之下 = **这张卷的创作坞**（同一个组件，另一次挂载）。
          多纸：**只有焦点那张纸展开输入面**——两处 textarea 同屏会抢输入；其余纸只留
          题签一行 + 一句去处（点它就换焦点），纸本身仍是完整的纸（天头/纸纹/落影）。
          `ref` = 纸高的实测点（量本栈、不量纸自己——见 measureStack 头注）。 */}
      <div className="pp-draft-stack" ref={measureStack}>
        {focused ? (
          <>
            {overlays.map((def) => (
              <PluginBoundary key={def.id} label={`待题纸 ${def.id}`}>
                <def.component />
              </PluginBoundary>
            ))}
            {notice && (
              <div className="pp-draft-error" role="alert">
                {notice}
              </div>
            )}
          </>
        ) : (
          /* **合上的纸**（2026-11-17 用户报「无焦点状态 UI 太难看」）：天头以下不是空白，
           * 是一条合口 + 三笔题签注记 + 一句去处。整张纸可点（点击判据在纸壳的 onMouseDown 上），
           * 故这里**不挂第二枚按钮**——纸自己就是那个入口，键盘路径由纸壳的 tabIndex 承担。 */
          <>
            <div className="pp-draft-seal" aria-hidden="true">
              <span className="pp-draft-seal-mark">合</span>
            </div>
            <div className="pp-draft-note">
              <span className="pp-draft-note-cell">
                <span className="pp-draft-note-k">组合</span>
                <span className="pp-draft-note-v">{picks?.presetId ?? presetSeed ?? presetSelected}</span>
              </span>
              <span className="pp-draft-note-cell">
                <span className="pp-draft-note-k">模型</span>
                <span className="pp-draft-note-v">{picks?.model ?? '出生默认'}</span>
              </span>
            </div>
            <div className="pp-draft-idle-hint">点这张纸继续题签</div>
          </>
        )}
      </div>
    </div>
  );
}

/** 一张**正在化卷**的纸（已从 papers 摘出，只等窗满消失）。
 *
 *  盒一帧都不动（2026-11-16 改判）：纸的盒归纸自己（RO 在交接期冻结），只有左缘与宽度
 *  取自卷（同宽同锚点，本来相等，取它是为了与世界变换同源）。
 *  天头按「卷高 − 纸高」升到卷首将落的位置再退（`--draft-rise`，见 draft-sheet.css）。 */
function MorphView({
  paperId,
  morph,
}: {
  paperId: string;
  morph: {
    sheetId: string;
    box: { left: number; width: number; height: number | null } | null;
    anchor: DraftSheetAnchor;
    /** 纸**发送那一刻**的盒高（`beginMorph` 从纸面记录里带过来的快照）。 */
    paperH: number;
  };
}) {
  const folioH = measureFolioHeadHeight('案卷', STREAM_REGION.width);
  const regionMinH = EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP + folioH;
  /* 交接期纸盒**一帧都不动**（2026-11-16 改判）——所以这里必须是发送那一刻的**快照**，
   * 不是现量（2026-11-18 化卷错位批：旧实现量的是纸自己，而纸的 inline height 正是它
   * 自己算出来的 ⇒ 量到的是「最小盒高」而不是发送时那个更高的盒，纸在交接第一帧就矮一截）。
   * 快照缺席（旧记录 / 0）= 回落到最小盒高。 */
  const boxH = morph.paperH > 0 ? morph.paperH : regionMinH;
  const sheet = sheetCharacter(morph.sheetId);
  const scale = draftScale(morph.anchor.width);
  const morphBox = morph.box;
  /* **天头要抬多高**（2026-11-16）：两件盒底相同（锚点 + 底距）⇒ 卷首将落的位置比纸的天头
   * 高出「卷高 − 纸高」。纸的天头按这个差升到卷首将落的位置再退场——交接那一帧是
   * 「原位交接」，不是两个位置的互换。
   *
   * ⚠ 2026-11-18 化卷错位批：**差值不再夹 [0, 96px]**。
   *   · 上界 96 是错位的直接制造者：首句一长（块高 400+），真实差 200+，被夹到 96 ⇒
   *     旧字只升到半路就淡掉、新字在更高处落——正是「交接那一下错一格」。
   *   · 下界 0 同理：卷比纸矮时（输入面写得多、首句很短）旧字该**往下沉**到卷首的新位置；
   *     夹成 0 = 旧字原地淡、新字在下面落，两颗字在不同高度上各走各的。
   *   位移量现在是真差值（可正可负），纸的盒本身不动——移的只是那四行字。 */
  const folioRise = morphBox?.height != null ? morphBox.height - boxH : 0;
  const boxBottom = morph.anchor.anchorY + REGION_FOOT_GAP;

  return (
    <div
      className="pp-region pp-draft-sheet pp-draft-morph"
      data-draft-sheet
      data-paper-id={paperId}
      data-morph="out"
      style={
        {
          /* 左缘与宽度取自卷的盒（同宽同锚点，本该相等；取它是为了与世界变换同源）。 */
          left: morphBox ? morphBox.left : morph.anchor.anchorX - morph.anchor.width / 2,
          width: morphBox ? morphBox.width : morph.anchor.width,
          /* ⚠ 高度与上缘**一律归纸自己**：交接期换成卷的盒 = 天头瞬跳 62px。 */
          top: boxBottom - boxH,
          height: boxH,
          // 卷首实测高（FOLIO_TOKENS 契约）——正文区按它下移，禁在 CSS 里手写数字
          '--draft-folio-h': `${folioH}px`,
          // 交接期天头抬升量（见上注）：0 = 卷高未量到，天头原地退
          '--draft-rise': `${folioRise}px`,
          // 纸性三参（真源 = sheet.ts）：与流区叶同名同义（见 .pp-region）
          '--sheet-ox': `${sheet.ox}px`,
          '--sheet-oy': `${sheet.oy}px`,
          '--sheet-j': `${sheet.j}`,
        } as CSSProperties
      }
    >
      <div className="pp-folio-head">
        <div className="pp-folio-inner">
          <span className="pp-yuwei" style={{ transform: `scale(${scale})` }}>
            <Icon name="lantai" size={26} />
          </span>
          {/* 交接期**不改口**（2026-11-15 定帧实测）：改口 = 发送那一瞬天头一个字换成另一个字，
              而整窗只有 260ms——字一换就落进「啪一下」那一类观感。纸照旧说「待题 · 未开卷」
              到淡完为止：它表达的是**这张纸从没变过身份**，只是成了卷。 */}
          <p className="pp-folio-eyebrow">待题 · 未开卷</p>
          <h2 className="pp-folio-title">
            案卷<span className="pp-draft-num">Nº</span>
          </h2>
          <p className="pp-folio-sub">题签随首句落账 · 卷号于发送时发出</p>
        </div>
      </div>
      {/* 交接期：纸**正在化卷**——嘴上仍是这张纸，但输入面已撤（不能再打字，那句已经发出去了）。
          留着这条空栈是为了让纸的高度与发送那一刻一致（盒一帧都不动，见上注）。 */}
      <div className="pp-draft-stack" />
    </div>
  );
}
