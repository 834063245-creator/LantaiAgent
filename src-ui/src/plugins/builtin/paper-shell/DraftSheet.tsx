// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DraftSheet — **待题纸**（新卷出生面，2026-11-14 立项；**2026-11-15 定稿改判 V2**）。
//
// 设计件：docs/plans/canvas-space/new-session-ux.md（V2 = 纸即输入面，发送即开卷）。
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
//      `overlays` 的 'draft-sheet' 槽注册，本件只负责给槽）。纸与坞共用同一个
//      input store（设计件 §2 原则 8）——复制一份就是把「一套设置摆两处」换成
//      「一套输入摆两处」，负债更重。
//
// 落位：纸在 `.pp-world` 里（与流区同一坐标语言），位置 = 流区自动落位同一把尺子
// （nearestFreeRegion + viewportCenterWorld，见 draft-sheet.ts）；开卷时流区写进
// 同一个锚点（`ChatCore.openDraftVolume`）⇒「纸在哪，卷就落哪」，不跳位。
//
// V1 的三条断言留作判据（勿重犯）：题签 = 纸上的三行注疏 / 开卷按钮 / 坞隐藏输入条。
// 前两条已被 V2 推翻，第三条改为「坞整只不渲染」（见 `ComposerSurface` 开头的早退）。

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { type DraftSheetCore, draftPlacement, draftScale } from './draft-sheet';
import {
  activeOverlayContributions,
  draftSheetSeed,
  EMPTY_REGION_CONTENT_H,
  Icon,
  PluginBoundary,
  REGION_FOOT_GAP,
  resolveNewSessionDefault,
  STREAM_REGION,
  subscribeOverlayContributions,
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

export function DraftSheet({ core }: { core: DraftSheetCore | null }) {
  const open = useDraftSheetStore((s) => s.open);
  /* **化卷交接**（V2-P3）：发送成功后 open 转 false、morph 在场——纸上还在屏上，
   * 与新卷的落纸同一窗（窗长 DRAFT_MORPH_MS = --m-sheet，store 自己收尾）。
   * 张力上仍渲染 = 「纸没被一刀砍掉」，坞则已可以出现（它属于新卷）。 */
  const morph = useDraftSheetStore((s) => s.morph);
  const anchor = useDraftSheetStore((s) => s.anchor);
  const presetSeed = useDraftSheetStore((s) => s.presetId);
  // 题签（picks）不住本件：纸上的输入面（ComposerSheet）自己读它填出厂值，
  // 发送面（ChatCore）读它去起卷——本件只要「预选组合」这一个种子。

  const notice = useDraftSheetStore((s) => s.notice);
  const setAnchor = useDraftSheetStore((s) => s.setAnchor);
  const dismiss = useDraftSheetStore((s) => s.dismiss);
  const setPicks = useDraftSheetStore((s) => s.setPicks);

  const presetSelected = usePresetStore((s) => s.selected);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  /* 纸高实测（V2：纸高随内容长——输入面多行/附件 rail/失败行都会变）。
   * 纸以**下缘锚点**向上长：top = 锚点 − 实测高。用 ResizeObserver 而不是量一次：
   * 输入面自己会随打字增高，量一次会在第一个换行处露馅（纸脚被内容顶穿）。
   * jsdom 无 RO：退回量首帧（测试自铺桩，与 use-composer-float 同款纪律）。 */
  const [sheetH, setSheetH] = useState(0);
  const measureSheet = useCallback((el: HTMLDivElement | null) => {
    sheetRef.current = el;
    if (!el) return;
    const measure = () => setSheetH((prev) => (prev === el.offsetHeight ? prev : el.offsetHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 纸上那张输入面：经 overlays 的 'draft-sheet' 槽取（热注册即时重取）──
   * 纸替坞：本槽是**同一个** ComposerDock 的另一次挂载（见该文件 ComposerSheet 头注）。 */
  const [, setOverlayTick] = useState(0);
  useEffect(() => subscribeOverlayContributions(() => setOverlayTick((t) => t + 1)), []);
  const sheetOverlays = activeOverlayContributions('draft-sheet');

  /* ── 交接期纸**停止实测**（2026-11-15 定帧实测的真病灶：抖）──
   * 化卷那一刻发号 + 落位 + 首条来文一起进来：纸的 RO 仍按内容量高，而盒又已锁到卷的几何，
   * 两条高在几帧内互相追（实测 552 → 425 → 552 的来回），读作「整页纸在地上抖两下」。
   * 交接期盒由卷**单方面**决定（store 的 morph.box），RO 不再回写。 */
  useEffect(() => {
    if (!morph) return;
    setSheetH(0); // 交出去：本件的实测高不再参与盒
  }, [morph]);

  /* ── 落纸：首帧算锚点（视口中心最近的空位——与流区落位同一把尺子）── */
  useEffect(() => {
    if (!open || anchor !== null || !core) return;
    setAnchor(draftPlacement(core));
  }, [open, anchor, core, setAnchor]);

  /* ── 每次开纸重置题签（预选组合 = 造模式入口传进来的；其余取出厂默认）──
   * 题签住 store（不在此组件态）：**发送面要读它**（ChatCore.sendMessage 的纸在场分支
   * 起卷时登记组合、写会话覆盖）。放组件态 = 两处真源。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: open/presetSeed 是刻意的重置扳机（重新落纸 = 一份新题签），presetSelected 刻意不在依赖里（否则开纸途中改全局默认会把用户刚题的签冲掉）
  useEffect(() => {
    if (!open) return;
    useDraftSheetStore.getState().setNotice(null);
    // 出厂题签的模型/思考 = 此刻的「新卷出生默认」（settings 活跃行）；组合 = 预选 ?? 全局默认。
    const base = resolveNewSessionDefault();
    setPicks({
      presetId: presetSeed ?? presetSelected,
      providerName: base.providerName,
      model: base.model,
      thinking: base.thinking,
    });
  }, [open, presetSeed, setPicks]);

  /* ── Esc = 弃纸（不烧号、不落盘、画布无残留）──
   * 注意：纸上那张输入面自己也听 Esc（斜杠面板先吃）。本监听在 **capture** 阶段、
   * 且只在输入面之外生效——判据 = 事件源不在纸内输入件上时才算弃纸。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 事件源可能是 Document/window（测试与合成事件），不保证有 closest。
      const el = e.target as HTMLElement | null;
      const inField = typeof el?.closest === 'function' && el.closest('textarea, input, [role="listbox"]') !== null;
      if (inField) return; // 输入面自己处理（斜杠面板 / 弹层）
      if (e.defaultPrevented) return;
      e.stopPropagation();
      dismiss();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dismiss]);

  if (!open && morph === null) return null;

  const folioH = measureFolioHeadHeight('案卷', STREAM_REGION.width);
  /* 纸性（2026-11-15 化卷批）：纸与卷**同一张纸**——同一张 paper-sheet 纹、同一套水洗。
   * 出生面期 = 固定种子；交接期 = 新卷 id（store 的 draftSheetSeed）。 */
  const sheet = sheetCharacter(draftSheetSeed(SHEET_SEED));
  const scale = draftScale(anchor?.width ?? STREAM_REGION.width);
  /* **纸高垫到「卷的最小盒高」**（2026-11-15 用户报「文字冲出题签背景」）：
   * 病灶 = 纸高由内容实测（输入面多高纸就多高），而卷的盒高恒 ≥
   * `EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP`（零块卷也有 200 + 72 的纸面）。
   * 纸一旦比这个矮，交接那一拍就是「小纸 → 大卷」的跳变；而且纸脚离题签太近时，
   * 输入面下方那条硬线看起来像被切掉了。
   * ⇒ 只垫**下限**（内容真的更高时按内容走），与卷同一把尺子，不另编数字。
   *
   * ⚠ 天头的让位在 **CSS** 里（.pp-draft-stack 的 padding-top 读 --draft-folio-h）：
   * 纸高由纸栈实测撑出来，而 .pp-folio-head 是绝对定位、不吃流——栈不从天头下面起，
   * 纸就比内容矮一个天头（用户报的「文字冲出题签背景」正是这一条）。这里因此**不再**
   * 往 boxH 上补贴 folioH（那是同一笔钱数两遍）。 */
  const regionMinH = EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP + folioH;
  const boxH = Math.max(sheetH, regionMinH);
  /* **纸盒 = 卷盒**（2026-11-15 用户报「题签到真实卷没有好的动画过渡」的根因）：
   * 卷的盒底恒在 `锚点 + REGION_FOOT_GAP`（流区几何：regionHeight 已含底距），
   * 而纸原先以**锚点**为底线 —— 于是化卷那一拍纸是「往上跳 72px 再淡出」。
   * ⇒ 纸也以 `锚点 + REGION_FOOT_GAP` 为底：两件同一个盒，淡出/淡入就地重叠，
   * 读作「这张纸成了那一卷」而不是「纸没了、别处冒出个卷」。
   * 宽的同一性由 draftPlacement 保证（都用 STREAM_REGION.width 与同一锚点）。 */
  const boxBottom = (anchor?.anchorY ?? 0) + REGION_FOOT_GAP;
  /* **交接期：盒一帧都不动**（2026-11-16 改判）。
   *
   * 上一版（2026-11-15）在交接窗里把纸的盒**整块换成卷的盒**（store 的 morph.box）——
   * 目的是「纸与卷严丝合缝」。真机定帧实测：卷落进首块后是 552、纸实测 490，两条盒的
   * **盒底相同**（都是锚点 + 底距），于是换盒那一帧纸的上缘**往上跳 62px**，天头四行跟着瞬移
   * ——用户读到的就是「题签跳了一下」。这恰恰是本轮要消灭的东西。
   *
   * 现在的口径：**纸的盒归纸自己**（RO 在交接期已停，故它冻结在发送那一刻的值），
   * 只有左缘与宽度取自卷（同宽同锚点，本来相等，取它是为了与世界变换同源）。
   * 高度差 62px 是**卷多了一行正文**这件事的几何后果，不是纸该跟着跳的理由：
   * 纸的天头按这个差升到卷首将落的位置再退，卷的字在自己的位上落下——两页字换手，
   * 谁都不瞬移。 */
  const morphBox = morph?.box ?? null;
  /* **天头要抬多高**（2026-11-16）：卷的盒比纸高（多一行正文），两件盒底相同 ⇒ 卷首比纸的
   * 天头高出这个差。纸的天头按它升到卷首将落的位置再退场——交接那一帧是「原位交接」，
   * 不是两个位置的互换。卷高还没量到（box 未回填 / height 为 null）时差为 0：
   * 此时纸的天头原地淡出，与上一版行为一致。
   * 差值**夹在 [0, 96px]**：负数没有意义（纸比卷高时不必往下沉），上界防止窗口极窄时
   * 卷被超长正文撑得极高、天头飞出画布。 */
  const folioRise = Math.max(0, Math.min(96, (morphBox?.height ?? boxH) - boxH));

  /* 交接期 = 纸**正在化卷**：嘴上仍是这张纸，但输入面已撤（不能再打字——那句已经发出去了），
   * 天头保留（Title/玉徽还在，读作「这张纸正在变成卷」而不是「纸没了」）。 */
  const morphing = morph !== null;

  return (
    <div
      className={`pp-region pp-draft-sheet${morphing ? ' pp-draft-morph' : ''}`}
      data-draft-sheet
      data-morph={morphing ? 'out' : undefined}
      data-body-state={notice ? 'rejected' : 'ready'}
      ref={measureSheet}
      style={
        anchor
          ? ({
              /* 左缘与宽度取自卷的盒（同宽同锚点，本该相等；取它是为了与世界变换同源，
                 免得纸与卷的锚点各自更新一帧时左缘错开半格）。高度/上缘不取——见上注。 */
              left: morphBox ? morphBox.left : anchor.anchorX - anchor.width / 2,
              width: morphBox ? morphBox.width : anchor.width,
              /* 纸以**锚点**为底线向上长（内容高随输入面变化，不写死）：
                 top = 锚点 − 实测高。首帧未测（sheetH=0）= 只画在锚点下方，
                 RO 一到即回填——**绝不用 translate: -100% 代替**：那会参与层叠/
                 纸纹对位（纸律：整叶不得声明 transform，见 base.css 注）。 */
              // 盒底 = 锚点 + 底距（与卷的纸脚同一个尺子）；盒高取「内容实测 vs 卷的最小盒高」
              /* ⚠ 高度与上缘**一律归纸自己**（见上注）：交接期换成卷的盒 = 天头瞬跳 62px。 */
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

      {/* 天头之下 = **这张卷的创作坞**（同一个组件，另一次挂载）。
          纸栈走流式、纸高随内容长——v1 按「绝对定位 + 手算每段 top」排，卷首一改高就压线。
          ⚡ 交接期（morph）：**留着它、让它跟着纸一起退**（`.pp-draft-morph`，显形档），
          而不是当帧撤掉——当帧撤 = 发送那一瞬输入面凭空消失，纸却还整张在那儿（真机帧上
          读作「啪一下」）。退场期 `pointer-events: none`（见 CSS）：那一句已经发出去了，
          它不能再被点、也不该吃焦点，但它**不该凭空不见**。 */}
      <div className="pp-draft-stack">
        {sheetOverlays.map((def) => (
          <PluginBoundary key={def.id} label={`待题纸 ${def.id}`}>
            <def.component />
          </PluginBoundary>
        ))}
        {notice && (
          <div className="pp-draft-error" role="alert">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
