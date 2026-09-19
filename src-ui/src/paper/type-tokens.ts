// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/type-tokens — 纸面版式数字的单一真源（design tokens，2026-08-30 收口）。
//
// 镜像病治理：此前版式数字在 measure.ts（canvas 测量）与 PaperPanel.css
// （DOM 渲染）各抄一份，改一处漏一处就出幻影间距/压字。此处把全部版式数字
// 收口成结构化 token：measure.ts 从这里派生测量字体/行距/组合 chrome 常量，
// injectPaperTokens() 把原始值注入 .pp-root 的 CSS 自定义属性，CSS 侧一律
// var(--pp-*) 引用。改版式只改本文件一处，测量与渲染自动跟随。
//
// 语义：token 存「CSS 原始值」（CSS 属性怎么写就存什么，border/padding/margin/
// maxHeight 分列）；measure.ts 用 *DERIVED 派生组合 chrome 常量（如
// USER_TEXT_INSET = user.borderL + user.padL）。CSS 引用原始值，measure 引用
// 组合值，同一真源，不镜像。

/* 2026-09-10 三体换代：song/kai/mono 语义键保留（PAPER_TYPE.stack 按文类
 * 寻址不变），值层统一 MiSans 栈——canvas 测量与 DOM 渲染同字体。 */
export const FONT_STACKS = {
  song: '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif',
} as const;

/** CSS 用值量化（LayoutUnit = 1/64 px，2026-09-19 夹注叠字批）。
 *
 *  line-height 无单位时，引擎把 size × lh 存成 LayoutUnit（Chromium 与 WebKit
 *  同为 1/64 px）——13.5 × 1.85 = 24.975 在 DOM 里实为 **24.96875**。测高若按
 *  未量化的浮点乘行数，每行差 −0.00625px：长夹注（真会话实测 1702 行）累积
 *  −10.6px 的**确定性**偏差（真机读数：8 行 pre-wrap 盒 = 199.75 = 8 × 24.96875；
 *  36.3 → 36.296875 同律）。凡由 size × lh 派生的行高常量一律过本函数——
 *  镜像纪律的又一条：测高用的行高必须等于 CSS 的**用值**，不是字面算式值。 */
export const cssUsedPx = (n: number): number => Math.round(n * 64) / 64;

/* ── 块体字号 / 行高系数（CSS 侧 .pp-block.pp-* .pp-body 镜像）── */
export const PAPER_TYPE = {
  user: { size: 22, lh: 1.65, stack: 'kai' as const }, // 来文楷书朱砂深——2026-08-30 标题化：题签居中、正文变大（题 > 正文 17）
  body: { size: 17, lh: 2.0, stack: 'song' as const }, // 正文宋体墨
  reasoning: { size: 13.5, lh: 1.85, stack: 'song' as const }, // 夹注石墨
  notice: { size: 12.5, lh: 1.7, stack: 'song' as const }, // 贴黄
  mono: { size: 12.5, lh: 1.7, stack: 'mono' as const }, // 抄录图版
  tool: { size: 11.5, lh: 1.6, stack: 'mono' as const }, // 脚注石青
  out: { size: 11, lh: 1.5, stack: 'mono' as const }, // 脚注输出/错误
} as const;

/* ── markdown 子版式（CSS 侧 .pp-md-* 镜像）── */
export const MD_TOKENS = {
  pGap: 14, // .pp-md-p margin-bottom
  h: [
    { size: 20, lh: 1.5, pt: 22, pb: 10 }, // h1
    { size: 18, lh: 1.6, pt: 20, pb: 8 }, // h2
    { size: 16.5, lh: 1.7, pt: 16, pb: 6 }, // h3
    { size: 15.5, lh: 1.8, pt: 14, pb: 6 }, // h4
  ] as const,
  listGap: 14, // .pp-md-list margin-bottom
  liGap: 6, // .pp-md-li margin-bottom（末项归零）
  liIndent: 26, // .pp-md-li padding-left（标记列）
  subIndent: 22, // .pp-md-list--sub padding-left
  subTop: 4, // .pp-md-list--sub margin-top
  quoteGap: 14, // .pp-md-quote margin-bottom
  quotePadV: 2, // .pp-md-quote padding 上下
  quotePadL: 16, // .pp-md-quote padding-left
  quoteBorderL: 2, // .pp-md-quote border-left
  codeGap: 14, // .pp-md-code margin-bottom
  codePadV: 10, // .pp-md-code padding 上下
  codePadH: 12, // .pp-md-code padding 左右
  codeBorderL: 3, // .pp-md-code border-left
  checkBorderW: 1.5, // .pp-md-check 任务复选框描边（2026-09 #15）
  hrMargin: 18, // .pp-md-hr margin 上下
  hrBorder: 1, // .pp-md-hr 线
  tableGap: 14, // .pp-md-table margin-bottom
  tableCellPadH: 8, // th/td 左右 padding
  tableCellPadV: 4, // th/td 上下 padding
  tableRowBorder: 1, // th 行底规线
  tableCellBorder: 0.5, // td 行底规线
  tableSize: 11.5,
  tableLh: 1.5,
  ciSizeRatio: 0.82, // 行内码 mono 0.82em
  ciPadH: 5, // 行内码横向 padding
  ciBorder: 1, // 行内码 border
  /* ── 数学（科研 LaTeX，2026-09 scientific-rendering）──
   * 块级公式（.pp-md-math）KaTeX .katex-display 自带上下 margin（KaTeX 内部
   * .katex-display margin 1em 0——此处不再重复加，只用块级 gap 与测量预算）；
   * 行内公式（.pp-md-math-inline）零 chrome（KaTeX 原子随行）。 */
  mathGap: 12, // .pp-md-math margin-bottom（块与下一元素距）
  mathSizeRatio: 1.06, // KaTeX 公式字号 = 正文 17px × 1.06 ≈ 18px（display 略大）
  /* 静态测量预算（虚拟化未挂载窗口期估高——挂载后 RO 实测回写优先）：
   * display 公式单行保守估高 = 正文行高 × 2（KaTeX 上下标/分数线把行撑到
   * 1.5-2 行高；分式/矩阵更高由 RO 纠正）。超长公式溢出横向滚动不增行数。 */
  mathDisplayLineH: 2.2, // 单位 = 正文行高倍数（单行 display 公式预算）
  mathDisplayMaxLines: 3, // 跨行公式预算行数上限（超长不无限膨胀——RO 兜底）
  /* ── 远端图（B4 multimodal-image D-9，2026-09）：固定盒（chem boxH 先例）
   *  ——加载/失败态都不改版面，measure 静态镜像即精确（无需 RO）。 */
  imgBoxH: 160, // .pp-md-imgbox 固定盒高（含 border——box-sizing）
  imgGap: 12, // .pp-md-imgbox margin-bottom（末元素 :last-child 归零）
  imgBorder: 1, // .pp-md-imgbox 周框（加载中/失败的盒界可见）
} as const;

/* ── markdown 子版式组合派生（measure 用；CSS 引用 MD_TOKENS 原始值）──
 * 全部组合公式归一在此：改 MD_TOKENS 原始值，派生自动跟随，measure.ts 零公式。 */
export const MD_DERIVED = {
  quotePadV: MD_TOKENS.quotePadV * 2, // .pp-md-quote padding 上下（单侧×2）
  quoteInset: MD_TOKENS.quotePadL + MD_TOKENS.quoteBorderL, // padding-left 16 + border-left 2
  codePadV: MD_TOKENS.codePadV * 2, // .pp-md-code padding 上下（单侧×2）
  codeInset: MD_TOKENS.codePadH * 2 + MD_TOKENS.codeBorderL, // border-left 3 + padding 左右 12×2
  hrH: MD_TOKENS.hrMargin * 2 + MD_TOKENS.hrBorder, // margin 18 + 线 1 + margin 18
  hrLastH: MD_TOKENS.hrMargin + MD_TOKENS.hrBorder, // 末元素 margin-bottom 归零
  tableCellPadV: MD_TOKENS.tableCellPadV * 2, // th/td 上下 padding 4×2
  ciExtra: MD_TOKENS.ciPadH * 2 + MD_TOKENS.ciBorder * 2, // 行内码横向 chrome
} as const;

/* ── per-kind chrome 原始值（CSS 侧各块 padding/border/margin 镜像）── */
export const CHROME_TOKENS = {
  user: {
    borderL: 0,
    padL: 0,
    kindLabelSize: 15, // 题签「来 文」字号（2026-08-30 标题化）
    kindSeqSize: 10, // 题签小注「USER · 序」字号（乙方案恢复小注）
    kindSeqGap: 5, // 大字 → 小注间距
    kindBarGap: 4, // 小注 → 横线间距（2026-08-30 乙方案横线回归）
    kindBarH: 2, // 横线高
    kindBarW: 24, // 横线宽
    kindGap: 12, // 题签区 → 正文区下距（题签占高 = 上述全合计）
    asterismMarginTop: 30,
    asterismLine: 14,
  },
  userFiles: { lineH: 16, marginTop: 8, borderTop: 1 },
  // 来文附图缩略行（B4 D-9）：64px 方界 tile + wrap 行距 + 上距（measure 镜像
  // 同 token——rows = ceil(n / perRow)，perRow = floor((w+gap)/(thumb+gap))）
  userImages: { thumb: 64, gap: 8, marginTop: 10 },
  reasoning: { borderL: 2, padL: 18 },
  tool: { padTop: 10, noteW: 44, noteH: 1.5 },
  // 载荷段头（2026-09-14 工具卡可读性专项）：参数/输出/错误各一行小字标 + 细规线。
  // 旧 .pp-out 的 marginTop/borderTop/padTop（6/1/6）退役——分隔语义改由段头行
  // 承载（首段不留空档，后续段上距 = marginTop）。
  secHead: { size: 10, lh: 1.4, marginTop: 6 },
  diff: {
    langSize: 10,
    langLh: 1,
    langMarginB: 6,
    preBorderL: 3,
    prePadV: 14,
    prePadL: 20,
    preBorderTb: 1,
    preMaxH: 260,
  },
  plan: {
    borderTop: 2,
    borderBottom: 1,
    // 石青策面（2026-09-10 拟策卡渲染专项）：3px 石青硬左线 + 淡底 + 横向内距
    // ——拟策是机器的正式提案面（石青=机），与来文的朱砂左线（人声）对仗。
    borderL: 3,
    padV: 14,
    padH: 16,
    headGap: 10,
    headSize: 15,
    headLh: 1.8,
    // 选项区数值（options*/option*）与标题字号归 ASSET_TOKENS.plan 单一真源
    // （2026-09-03 双组去重：此前的 optionBorder 1vs2 分歧即双源漂移产物）；
    // CSS 引用 --pp-asset-plan-*，测高派生 ASSET_DERIVED.plan*。
    actionsGap: 8,
    actionsMarginTop: 14,
    actionsSize: 13,
    actionsLh: 1.8,
    actionsPadV: 5,
    actionsBorder: 1,
  },
  notice: { padV: 8, borderBottom: 1, padH: 12 },
  codeSrc: { borderL: 3, padL: 14, padV: 10, maxH: 320 },
  codeOut: { maxH: 200 },
  /* 眉批栏（P5 夹注旁注化）几何。offset/width/borderL/padL 管横向镜像；
   *  top/toggleH/toggleGap 管**纵向**：块高 = max(正文, 眉批 extent)，而 extent
   *  = top + 栏高 —— 栏高 = 展开态的文字高 + 折叠钮行，或折叠态只剩折叠钮行。
   *  2026-09-19（夹注叠字批）补：这三项此前是 CSS 里的裸字面量（`top: 2px`）与
   *  引擎默认行高（按钮 line-height: normal ⇒ 10px 字得 13px 行），测高镜像拿不到
   *  ——真机实测眉批栏越出块高最多 218.75px（长夹注在 228px 窄列里折行分歧被放大），
   *  其中约 15px 是这段 chrome 漏算的确定项。 */
  marginalia: {
    offset: 24,
    width: 240,
    borderL: 2,
    padL: 10,
    top: 2,
    toggleH: 13,
    toggleGap: 4,
    outPadV: 2,
    outBorder: 1,
    outLineH: 13,
  },
  /* 便条（纸内件，2026-09-19 钉纸条便条批）：钉住块与纸条共用一族纸面几何——
   * 纸内白边（墨不再贴纸缘：流内 720 墨借 1440 纸的白边，钉到桌面后那份白边
   * 不存在了，必须由纸自己付）+ 纸内报头（文类签/序号/出处行从纸外 -128px 的
   * 页边注收进纸内，成为剪报的报头）+ 身份方点（D2 方点语言，替 hover 才显形的
   * 竖排签）。数值是测高镜像的一端：钉住块几何高 = padTop + 报头 + 正文
   * （按收窄后的测宽）+ padBottom，见 measure.ts measurePinnedBlockHeightCached
   * 与 CHROME_DERIVED.pinHeadH。 */
  pin: {
    padTop: 34,
    padBottom: 38,
    padH: 44,
    headSize: 13,
    headLh: 1,
    headRule: 1,
    headRuleGap: 10,
    headGap: 16,
    dot: 6,
    dotGap: 8,
  },
  strip: { size: 12.5, lh: 1.7, padV: 18, padH: 20 },
} as const;

/* ── 组合 chrome 常量（measure 用；CSS 引用 CHROME_TOKENS 原始值）── */
export const CHROME_DERIVED = {
  userTextInset: CHROME_TOKENS.user.borderL + CHROME_TOKENS.user.padL, // 0——标题化后无左批线
  userKindH:
    CHROME_TOKENS.user.kindLabelSize +
    CHROME_TOKENS.user.kindSeqGap +
    CHROME_TOKENS.user.kindSeqSize +
    CHROME_TOKENS.user.kindBarGap +
    CHROME_TOKENS.user.kindBarH +
    CHROME_TOKENS.user.kindGap, // 题签区总高（大字 + 小注 + 横线间距 + 横线 + 下距）
  userAsterismH: CHROME_TOKENS.user.asterismMarginTop + CHROME_TOKENS.user.asterismLine,
  userFileLineH: CHROME_TOKENS.userFiles.lineH,
  userFilesMarginTop: CHROME_TOKENS.userFiles.marginTop + CHROME_TOKENS.userFiles.borderTop,
  userImageThumb: CHROME_TOKENS.userImages.thumb,
  userImageGap: CHROME_TOKENS.userImages.gap,
  userImagesMarginTop: CHROME_TOKENS.userImages.marginTop,
  reasoningTextInset: CHROME_TOKENS.reasoning.borderL + CHROME_TOKENS.reasoning.padL,
  toolPadTop: CHROME_TOKENS.tool.padTop,
  /** 段头行恒一行（mono size × lh）——参数/输出/错误段共用。 */
  secHeadH: CHROME_TOKENS.secHead.size * CHROME_TOKENS.secHead.lh,
  /** 段头上距（首段不留空档——渲染端 gap 条件与 measure 同判据）。 */
  secHeadGap: CHROME_TOKENS.secHead.marginTop,
  diffLangH: CHROME_TOKENS.diff.langSize * CHROME_TOKENS.diff.langLh + CHROME_TOKENS.diff.langMarginB,
  diffPreChromeH: CHROME_TOKENS.diff.prePadV * 2 + CHROME_TOKENS.diff.preBorderTb * 2,
  diffTextInset: CHROME_TOKENS.diff.preBorderL + CHROME_TOKENS.diff.prePadL,
  planChromeH: CHROME_TOKENS.plan.borderTop + CHROME_TOKENS.plan.borderBottom + CHROME_TOKENS.plan.padV * 2,
  planTextInset: CHROME_TOKENS.plan.borderL + CHROME_TOKENS.plan.padH * 2, // 策面横向内缩（左线 3 + 内距 16×2）——markdown 体测宽/墨迹内缩共用
  planActionsH:
    CHROME_TOKENS.plan.actionsSize * CHROME_TOKENS.plan.actionsLh +
    CHROME_TOKENS.plan.actionsPadV * 2 +
    CHROME_TOKENS.plan.actionsBorder * 2 +
    CHROME_TOKENS.plan.actionsMarginTop,
  noticeChromeH: CHROME_TOKENS.notice.padV * 2 + CHROME_TOKENS.notice.borderBottom,
  noticeTextInset: CHROME_TOKENS.notice.padH * 2,
  codeSrcInset: CHROME_TOKENS.codeSrc.borderL + CHROME_TOKENS.codeSrc.padL,
  codeSrcPadV: CHROME_TOKENS.codeSrc.padV * 2,
  codeSrcMaxH: CHROME_TOKENS.codeSrc.maxH,
  /** 程文输出文本预算 = max-height 全域（2026-09-14：内距/规线归段头，滚动区即文本区）。 */
  codeOutTextMax: CHROME_TOKENS.codeOut.maxH,
  codeOutMaxH: CHROME_TOKENS.codeOut.maxH,
  marginaliaW: CHROME_TOKENS.marginalia.width,
  marginaliaInset: CHROME_TOKENS.marginalia.borderL + CHROME_TOKENS.marginalia.padL,
  /** 眉批栏顶距（.pp-marginalia top）。 */
  marginaliaTop: CHROME_TOKENS.marginalia.top,
  /** 眉批栏折叠钮行总高 = 钮行高 + 钮下距（.pp-marginalia-toggle）。 */
  marginaliaToggleH: CHROME_TOKENS.marginalia.toggleH + CHROME_TOKENS.marginalia.toggleGap,
  /** 眉批已移出占位行高（.pp-marginalia-out：上下内距 + 上下规线 + 行盒）。 */
  marginaliaOutH:
    CHROME_TOKENS.marginalia.outPadV * 2 + CHROME_TOKENS.marginalia.outBorder * 2 + CHROME_TOKENS.marginalia.outLineH,
  /* 钉住块（便条）几何：报头行高（单行 = 字号 × 行高系数）+ 规线间隙 + 规线 +
   * 报头下距；纸内白边 = 上下内距之和；正文测宽要收 padH × 2。 */
  pinHeadH:
    CHROME_TOKENS.pin.headSize * CHROME_TOKENS.pin.headLh +
    CHROME_TOKENS.pin.headRuleGap +
    CHROME_TOKENS.pin.headRule +
    CHROME_TOKENS.pin.headGap,
  pinChromeH: CHROME_TOKENS.pin.padTop + CHROME_TOKENS.pin.padBottom,
  pinTextInset: CHROME_TOKENS.pin.padH * 2,
} as const;

/* ── 资产款（CSS 侧 .pp-json / .pp-media / .pp-chart 等镜像）── */
export const ASSET_TOKENS = {
  json: {
    padTop: 10,
    padBottom: 2,
    headSize: 10,
    headMarginB: 6,
    prePadV: 10,
    preBorderL: 3,
    prePadH: 12,
    preMaxH: 360,
    preSize: 11,
    preLh: 1.6,
  },
  media: { padV: 2, labelSize: 13, labelMarginB: 4, imgMaxH: 320, rowSize: 11 },
  // interactiveBoxH（科研渲染 #16）：ECharts 交互图固定盒高（canvas 自绘，
  // 盒高恒定——measure 静态镜像精确，RO 恒挂仅兜底）
  //
  // 静态图几何（D4-D8，2026-09-16）：以下数值是**几何真源**——CSS 走
  // --pp-asset-chart-* 变量，measure 派生 ASSET_DERIVED.chart*，渲染组件
  // （plugins/builtin/renderers/components.tsx）因插件产物域不 import paper
  // 层而**硬编码镜像**（GRID_VIRTUAL_ROW_H 先例），一致性由
  // tests/chart-geometry.test.ts 钉住。
  // vbH/leftPad/rightPad/topPad/bottomPad/barSlot/barW/scatterVbW 共同决定
  // SVG viewBox —— 实际高度 = w × vbH / viewBoxW（measure 同款公式）。
  chart: {
    padV: 4,
    typeSize: 9,
    typeMarginB: 4,
    pieH: 180,
    labelMarginTop: 6,
    labelSize: 9,
    interactiveBoxH: 260,
    // titleSize/titleMarginB：config.title 行（静态版此前完全忽略 config）
    titleSize: 11,
    titleMarginB: 6,
    // ── 盒定比例（2026-09-17 P1「图版语汇」批，替代原「比例由数据条数决定」）──
    // 旧模型：viewBox 宽 = 30 + 柱数×40 + 10、高恒 180，CSS width:100%/height:auto
    // ⇒ 3 根柱的图在 720 版心里被 meet 缩成约 213×240 居中、两侧各空 253px；20 根柱
    // 又是另一比例、8px 字被缩到 6.5px（同一 kind 只换条数，字号差 39%）。实测读数见
    // docs/plans/tool-image-context-plan.md §6 与 prototype/asset-cards-ab.NOTES.md。
    // 新模型：**宽高都由版心定**——SVG 的 viewBox 宽 = 卡片内容宽（用户单位 == CSS px，
    // 故任何文字都不再被缩放），高按类目数分三档（少/中/多），柱槽宽由「版心宽 ÷ 条数」
    // 反推（条数少则柱更宽，而不是图更小）。
    /** 三档高度：≤4 类 / ≤10 类 / 更多（宽高皆版心定，与条数解耦）。
     *  渲染器镜像同一组数值（components.tsx CHART_GEO），对拍在 chart-geometry 测试。 */
    svgHByCount: [180, 210, 240] as const,
    /** 档位分界（类目数），与 svgHByCount 一一对应 */
    countTiers: [4, 10] as const,
    // SVG 坐标系内距（用户单位 = CSS px）
    leftPad: 30,
    rightPad: 10,
    topPad: 14,
    bottomPad: 20,
    axisSize: 8,
    valueSize: 8,
    /** 数值标注上限（超过则省略，防重叠——纯性能/可读性语义常量） */
    valueMaxItems: 20,
  },
  metric: {
    padV: 2,
    captionSize: 13,
    captionMarginB: 6,
    cardBorder: 2,
    cardPad: 16,
    cardLabelSize: 11,
    cardValueSize: 20,
    cardValueLh: 1.2,
    gap: 8,
    minCol: 120,
  },
  grid: {
    padV: 2,
    captionSize: 13,
    captionMarginB: 6,
    cellPadV: 4,
    cellPadH: 8,
    rowSize: 11,
    headBorder: 1,
    rowBorder: 0.5,
    measureRowCap: 50,
    // 大表虚拟滚动（科研渲染 #11，2026-09）：>1000 行触发（阈值是组件常量）。
    // virtualRowH = 虚拟滚动单行固定高（cellPadV×2 + rowSize×1.8 + rowBorder，
    // 取整 29——CSS .pp-grid-virtual td 单行截断 + 该行高，measure 同值）；
    // virtualViewportH = 可视区固定高（滚动容器，表头在外固定）。
    virtualRowH: 29,
    virtualViewportH: 240,
  },
  // ── 图版题签（B 图版签主干，2026-09-17）──
  // 物类签（汉字）+ 题名同行，其下极弱规线。**高度中性**：题签行吃掉原题注行的
  // captionMarginB（6px = 5px 下距 + 1px 规线）⇒ measure 两侧镜像零改动。
  // 签尺寸与题注字号解耦（签是机器语汇的边注，比题名小一档）。
  plate: { signSize: 9, signBorder: 1, signPadH: 4, signPadV: 1, gap: 6, ruleW: 1, gapBelow: 2 },
  // graph（2026-09-17 盒定比例）：列宽/原点/最小尺寸/svg 封顶随「宽高由版心定」整批退役——
  // 渲染侧的框宽改由标签实测宽定（components.tsx GRAPH_GEO），图高只随行数变。
  graph: { padV: 4, rowH: 52 },
  html: { padV: 2, frameDefaultH: 240 },
  form: {
    padV: 2,
    titleSize: 15,
    titleMarginB: 4,
    bodySize: 13,
    bodyLh: 1.7,
    bodyMarginB: 8,
    optPadV: 6,
    optBorder: 2,
    optLabelSize: 13,
    optDescSize: 11,
    optDescPadH: 10,
    optGap: 4,
    sectionGap: 8,
    // 操作区（确认/修改/拒绝 + 反馈框 + 已处理）2026-09-06 起复用拟策卡钤印
    // 语言（.pp-pc-actions/.pp-pc-btn 族）——确认卡 = plan 审批模式泛化，
    // 同为人手决策同一钮面；操作行测高改由 CHROME_DERIVED.planActionsH 承载，
    // 本组不再持钮面数值。
  },
  board: {
    padV: 2,
    colGap: 10,
    colMinW: 140,
    colRule: 2,
    colTitleSize: 13,
    colTitleMarginB: 6,
    cardBorder: 1,
    cardPadV: 6,
    cardGap: 6,
    cardLabelSize: 13,
    cardBodySize: 11,
  },
  timeline: {
    padV: 2,
    railW: 18,
    railMid: 8,
    tsW: 96,
    colGap: 10,
    itemGap: 10,
    ruleW: 1,
    nodeSize: 9,
    nodeBorder: 2,
    nodeOffset: 2,
    tsSize: 10,
    titleSize: 13,
    bodySize: 12,
  },
  // 学术引用卡（scientific-rendering 4B，2026-09）。行高全用**显式 px 行高 token**
  // （titleLine 等）而非单位系数——CSS ↔ measure 行高严格同值，故存显式 px。
  // measure 侧 ASSET_DERIVED 同名派生。（2026-09 注入单位修复后，asset 组
  // *Lh 后缀键已按 chromeFlat 同款约定注入无单位系数——本组保持显式 px
  // *Line 命名不受影响，行为不变。）
  citation: {
    padV: 2,
    titleSize: 14,
    titleLine: 21,
    authorSize: 12,
    authorLine: 19,
    authorGap: 3, // .pp-citation-authors margin-top
    venueSize: 11,
    venueLine: 17,
    venueGap: 3, // .pp-citation-venue margin-top
    idsSize: 11,
    idsLine: 17,
    idsMarginTop: 6,
    summarySize: 10,
    summaryLine: 18,
    bibMarginTop: 8,
    bibBorderTop: 1, // .pp-citation-bib border-top（折叠区上规线）
    bibPadTop: 4, // .pp-citation-bib padding-top
    bibPreMarginTop: 4, // .pp-citation-bibtex margin-top
    bibSize: 11,
    bibLine: 18,
    bibPadV: 6,
    bibPadH: 10,
    bibMaxH: 240,
  },
  // 化学式/反应卡（scientific-rendering #10，2026-09）。行高沿用 citation 的
  // 显式 px 做法（asset 组 token 注入全带 px 后缀）。结构区（.pp-chem-box）为
  // **固定盒**（boxH）——smiles-drawer SVG 只写 viewBox 不写 width/height，
  // 盒内 svg 100%×100% + meet 居中 → 盒高恒定、测量镜像精确（不像媒体图
  // 有加载态/自然高差），RO 恒挂仅兜底。
  chem: {
    padV: 2,
    nameSize: 13,
    nameLine: 20,
    nameMarginB: 6, // .pp-chem-name margin-bottom
    boxH: 180, // .pp-chem-box 固定盒高（结构渲染区）
    boxBorder: 1, // .pp-chem-box border（周框）
    boxMarginB: 6, // .pp-chem-box margin-bottom
    metaSize: 11,
    metaLine: 17, // formula / err 共用行高
    metaMarginB: 2, // .pp-chem-formula + .pp-chem-err 间距
  },
  plan: {
    titleSize: 15,
    titleLh: 1.8,
    headMarginB: 12,
    optionsMarginTop: 14,
    optionsBorderTop: 1,
    optionsPadTop: 10,
    optionPadV: 7,
    optionBorder: 2,
    optionSize: 13,
    optionDescSize: 12,
    optionDescMarginTop: 2,
    optionPadH: 10,
    optionGap: 6,
  },
} as const;

/* ── 资产/拟策组合派生（measure 用；CSS 引用 ASSET_TOKENS 原始值）──
 * 全部组合公式归一在此：改 ASSET_TOKENS 原始值，派生自动跟随，measure.ts 零公式。
 * 命名 = measure 侧导出常量名（JSON_VIEW_PAD_V 等），逐行对应原 measure 镜像。 */
export const ASSET_DERIVED = {
  jsonViewPadV: ASSET_TOKENS.json.padTop + ASSET_TOKENS.json.padBottom, // .pp-json padding 10 + 2
  jsonViewHeadH: ASSET_TOKENS.json.headSize * 1.8 + ASSET_TOKENS.json.headMarginB, // .pp-json-head + margin 6
  jsonPrePadV: ASSET_TOKENS.json.prePadV * 2, // .pp-json-pre padding 10×2
  jsonPreInset: ASSET_TOKENS.json.preBorderL + ASSET_TOKENS.json.prePadH * 2, // border-left 3 + padding 左右 12×2
  jsonPreMaxH: ASSET_TOKENS.json.preMaxH,
  jsonPreSize: ASSET_TOKENS.json.preSize,
  jsonPreLh: ASSET_TOKENS.json.preLh,

  mediaPadV: ASSET_TOKENS.media.padV * 2, // .pp-media padding 2×2
  mediaLabelH: ASSET_TOKENS.media.labelSize * 1.8 + ASSET_TOKENS.media.labelMarginB,
  mediaImgMaxH: ASSET_TOKENS.media.imgMaxH,
  mediaRowSize: ASSET_TOKENS.media.rowSize,

  /** 图版题签行总高（严格等于原题注行高：题注字号行高 + 题注下距；题签行内部
   *  把该下距拆成「下内距 + 1px 规线 + 规线下间距」⇒ 换装不动测高）。 */
  plateHeadH: ASSET_TOKENS.grid.captionSize * 1.8 + ASSET_TOKENS.grid.captionMarginB,

  chartPadV: ASSET_TOKENS.chart.padV * 2, // .pp-chart padding 4×2
  chartTypeH: ASSET_TOKENS.chart.typeSize * 1.8 + ASSET_TOKENS.chart.typeMarginB,
  chartPieH: ASSET_TOKENS.chart.pieH,
  chartLabelGap: ASSET_TOKENS.chart.labelMarginTop,
  chartLabelSize: ASSET_TOKENS.chart.labelSize,
  chartInteractiveBoxH: ASSET_TOKENS.chart.interactiveBoxH, // .pp-chart-interactive-box 固定盒高（#16）
  // chart 静态图几何（D4-D9，2026-09-16；2026-09-17 改盒定比例）——measure 与渲染
  // 组件共用同一套坐标系；渲染侧因插件产物域不 import paper 层而镜像同一组数值
  // （components.tsx CHART_GEO），一致性由 tests/chart-geometry.test.ts 钉住。
  chartTitleH: ASSET_TOKENS.chart.titleSize * 1.8 + ASSET_TOKENS.chart.titleMarginB, // .pp-chart-title + margin
  chartAxisNamesH: ASSET_TOKENS.chart.axisSize * 1.8 + 2, // .pp-chart-axis-names + margin-top 2
  chartLeftPad: ASSET_TOKENS.chart.leftPad,
  chartRightPad: ASSET_TOKENS.chart.rightPad,
  /** 行数 → graph SVG 盒高（盒定比例：行高 52 + 上下各 8 内距，与列数解耦）。
   *  渲染侧镜像同一组数值（components.tsx GRAPH_GEO），对拍钉在几何测试里。 */
  graphViewH: (rows: number): number => Math.max(44, Math.max(1, rows) * ASSET_TOKENS.graph.rowH + 16),
  /** 类目数 → SVG 盒高（盒定比例：宽高皆由版心/档位定，与坐标系宽度解耦）。 */
  chartSvgH: (type: string, count: number): number => {
    if (type === 'pie') return ASSET_TOKENS.chart.pieH;
    const [t1, t2] = ASSET_TOKENS.chart.countTiers;
    const [h1, h2, h3] = ASSET_TOKENS.chart.svgHByCount;
    if (count <= t1) return h1;
    if (count <= t2) return h2;
    return h3;
  },

  metricPadV: ASSET_TOKENS.metric.padV * 2, // .pp-metric padding 2×2
  metricCaptionH: ASSET_TOKENS.metric.captionSize * 1.8 + ASSET_TOKENS.metric.captionMarginB,
  metricCardH:
    ASSET_TOKENS.metric.cardBorder +
    ASSET_TOKENS.metric.cardPad +
    ASSET_TOKENS.metric.cardLabelSize * 1.8 +
    ASSET_TOKENS.metric.cardValueSize * ASSET_TOKENS.metric.cardValueLh,
  metricGap: ASSET_TOKENS.metric.gap,
  metricMinCol: ASSET_TOKENS.metric.minCol,

  gridPadV: ASSET_TOKENS.grid.padV * 2, // .pp-grid padding 2×2
  gridCaptionH: ASSET_TOKENS.grid.captionSize * 1.8 + ASSET_TOKENS.grid.captionMarginB,
  gridCellPadV: ASSET_TOKENS.grid.cellPadV * 2,
  gridRowLine: ASSET_TOKENS.grid.rowSize * 1.8,
  gridHeadBorder: ASSET_TOKENS.grid.headBorder,
  gridRowBorder: ASSET_TOKENS.grid.rowBorder,
  gridMeasureRowCap: ASSET_TOKENS.grid.measureRowCap,
  gridVirtualRowH: ASSET_TOKENS.grid.virtualRowH, // .pp-grid-virtual td 固定行高（#11）
  gridVirtualViewportH: ASSET_TOKENS.grid.virtualViewportH, // .pp-grid-virtual 可视区高（#11）
  gridSize: ASSET_TOKENS.grid.rowSize,

  graphPadV: ASSET_TOKENS.graph.padV * 2, // .pp-graph padding 4×2
  graphRowH: ASSET_TOKENS.graph.rowH,

  htmlPadV: ASSET_TOKENS.html.padV * 2, // .pp-html padding 2×2
  htmlFrameDefaultH: ASSET_TOKENS.html.frameDefaultH,

  formPadV: ASSET_TOKENS.form.padV * 2, // .pp-form padding 2×2
  formTitleH: ASSET_TOKENS.form.titleSize * 1.8 + ASSET_TOKENS.form.titleMarginB,
  formBodyLine: ASSET_TOKENS.form.bodySize * ASSET_TOKENS.form.bodyLh,
  formBodyGap: ASSET_TOKENS.form.bodyMarginB,
  formOptPadV: ASSET_TOKENS.form.optPadV * 2, // .pp-form-option padding 6×2
  formOptBorder: ASSET_TOKENS.form.optBorder,
  formOptLabelH: ASSET_TOKENS.form.optLabelSize * 1.8,
  formOptDescLine: ASSET_TOKENS.form.optDescSize * 1.8,
  formOptDescInset: ASSET_TOKENS.form.optDescPadH * 2, // padding 左右 10×2
  formOptGap: ASSET_TOKENS.form.optGap,
  formSectionGap: ASSET_TOKENS.form.sectionGap,
  // 操作行 = 拟策卡钤印钮面（.pp-pc-btn 族）——高度同源 CHROME_TOKENS.plan
  formActionsH:
    CHROME_TOKENS.plan.actionsSize * CHROME_TOKENS.plan.actionsLh +
    CHROME_TOKENS.plan.actionsPadV * 2 +
    CHROME_TOKENS.plan.actionsBorder * 2 +
    CHROME_TOKENS.plan.actionsMarginTop,
  formBodySize: ASSET_TOKENS.form.bodySize,
  formDescSize: ASSET_TOKENS.form.optDescSize,

  boardPadV: ASSET_TOKENS.board.padV * 2, // .pp-board padding 2×2
  boardColGap: ASSET_TOKENS.board.colGap,
  boardColMinW: ASSET_TOKENS.board.colMinW,
  boardColRule: ASSET_TOKENS.board.colRule, // 列顶规线 + padding-top 6
  boardColTitleH: ASSET_TOKENS.board.colTitleSize * 1.8 + ASSET_TOKENS.board.colTitleMarginB,
  boardCardBorder: ASSET_TOKENS.board.cardBorder,
  boardCardPadV: ASSET_TOKENS.board.cardPadV * 2,
  boardCardGap: ASSET_TOKENS.board.cardGap,
  boardCardLabelH: ASSET_TOKENS.board.cardLabelSize * 1.8,
  boardCardBodyH: ASSET_TOKENS.board.cardBodySize * 1.8,

  timelinePadV: ASSET_TOKENS.timeline.padV * 2, // .pp-timeline padding 2×2
  timelineInset: ASSET_TOKENS.timeline.railW + ASSET_TOKENS.timeline.tsW + ASSET_TOKENS.timeline.colGap * 2, // 节点轨+时标+两道列距
  timelineItemGap: ASSET_TOKENS.timeline.itemGap,
  timelineNodeH: ASSET_TOKENS.timeline.nodeSize + ASSET_TOKENS.timeline.nodeBorder * 2,
  timelineTsLine: ASSET_TOKENS.timeline.tsSize * 1.8,
  timelineTitleLine: ASSET_TOKENS.timeline.titleSize * 1.8,
  timelineBodyLine: ASSET_TOKENS.timeline.bodySize * 1.7,
  timelineTsW: ASSET_TOKENS.timeline.tsW,
  timelineTsFont: `${ASSET_TOKENS.timeline.tsSize}px ${FONT_STACKS.mono}`,
  timelineTitleFont: `${ASSET_TOKENS.timeline.titleSize}px ${FONT_STACKS.song}`,
  timelineBodyFont: `${ASSET_TOKENS.timeline.bodySize}px ${FONT_STACKS.song}`,

  citationPadV: ASSET_TOKENS.citation.padV * 2, // .pp-citation padding 2×2
  citationTitleFont: `${ASSET_TOKENS.citation.titleSize}px ${FONT_STACKS.song}`,
  citationTitleLine: ASSET_TOKENS.citation.titleLine, // 显式 px 行高（token 注入即 px）
  citationAuthorFont: `${ASSET_TOKENS.citation.authorSize}px ${FONT_STACKS.song}`,
  citationAuthorLine: ASSET_TOKENS.citation.authorLine,
  citationAuthorGap: ASSET_TOKENS.citation.authorGap, // .pp-citation-authors margin-top
  citationVenueFont: `${ASSET_TOKENS.citation.venueSize}px ${FONT_STACKS.song}`,
  citationVenueLine: ASSET_TOKENS.citation.venueLine,
  citationVenueGap: ASSET_TOKENS.citation.venueGap, // .pp-citation-venue margin-top
  citationIdsFont: `${ASSET_TOKENS.citation.idsSize}px ${FONT_STACKS.mono}`,
  citationIdsLine: ASSET_TOKENS.citation.idsLine,
  citationIdsMarginTop: ASSET_TOKENS.citation.idsMarginTop,
  citationSummaryLine: ASSET_TOKENS.citation.summaryLine, // BibTeX summary 恒单行（字号不入测高）
  citationBibMarginTop: ASSET_TOKENS.citation.bibMarginTop,
  citationBibTopChrome: ASSET_TOKENS.citation.bibBorderTop + ASSET_TOKENS.citation.bibPadTop, // .pp-citation-bib border-top + padding-top（默认折叠态计入）

  chemPadV: ASSET_TOKENS.chem.padV * 2, // .pp-chem padding 2×2
  chemNameFont: `${ASSET_TOKENS.chem.nameSize}px ${FONT_STACKS.song}`,
  chemNameLine: ASSET_TOKENS.chem.nameLine,
  chemNameMarginB: ASSET_TOKENS.chem.nameMarginB, // .pp-chem-name margin-bottom
  chemBoxH: ASSET_TOKENS.chem.boxH, // .pp-chem-box 固定盒高（含 border——box-sizing）
  chemBoxMarginB: ASSET_TOKENS.chem.boxMarginB, // .pp-chem-box margin-bottom
  chemMetaFont: `${ASSET_TOKENS.chem.metaSize}px ${FONT_STACKS.mono}`,
  chemMetaLine: ASSET_TOKENS.chem.metaLine,

  planTitleSize: ASSET_TOKENS.plan.titleSize,
  planTitleLh: ASSET_TOKENS.plan.titleLh,
  planHeadMargin: ASSET_TOKENS.plan.headMarginB,
  planOptionsChromeH:
    ASSET_TOKENS.plan.optionsMarginTop + ASSET_TOKENS.plan.optionsBorderTop + ASSET_TOKENS.plan.optionsPadTop,
  planOptionPadV: ASSET_TOKENS.plan.optionPadV * 2, // .pp-pc-option padding 7×2
  planOptionBorder: ASSET_TOKENS.plan.optionBorder,
  planOptionSize: ASSET_TOKENS.plan.optionSize,
  planOptionDescSize: ASSET_TOKENS.plan.optionDescSize,
  planOptionDescGap: ASSET_TOKENS.plan.optionDescMarginTop,
  planOptionDescLine: ASSET_TOKENS.plan.optionDescSize * 1.8,
  planOptionDescInset: ASSET_TOKENS.plan.optionPadH * 2,
  planOptionGap: ASSET_TOKENS.plan.optionGap,
} as const;

/* ── 折叠 / 滚动上限 ── */
export const LIMIT_TOKENS = {
  foldRowH: 20, // 折叠行高（mono 10px + margin-bottom 6）
  preMaxH: 260, // 渲染端 pre/输出 max-height（tool/diff 共用）
  outMaxH: 160,
} as const;

/* ── 卷首（folio-head）──
 * 2026-09-16「版心天头」重排（用户拍板 B 案）：卷首收进 720 版心与正文同轴——
 * 原先玉徽居中于**整张纸**（1440 宽流区的中轴）、眉行/题字/档行却左齐于纸缘内距
 * 16px，与居中的 720 版心错开 344px（实测），一块卷首三个轴。现在四行全部居中
 * 于版心，硬规线也只画版心宽。
 * 字号随族换代重校（2026-09-10 三体换代后 song/kai/mono 同值 = MiSans 单族，
 * 原型的「等宽小字 vs 宋体大字」族对比消失，层级只剩字号/字重/字距）：
 * 眉行/档行 10→11px、字距收窄，题字 32→36px。 */
export const FOLIO_TOKENS = {
  titleSize: 36,
  titleLh: 1.22,
  eyebrowH: 15, // 机读眉行 11px × line-height 15px
  subH: 15, // 机读档行 11px × line-height 15px
  padTop: 24,
  padBottom: 24, // inner padding-bottom 22 + rule-hard 2
  yuweiH: 40, // 26px 玉徽 + margin-bottom 14
  titleMarginTop: 14,
  subMarginTop: 14,
  headGap: 28, // 卷头与首块呼吸距
  /** 卷首版心宽（与正文块同轴同宽——正文版心上限见 use-paper-regions 的 720）。
   *  窄流区下版心自动收为「流区宽 − 左右内距 32」，见 measure.ts folioHeadWidthFor。 */
  colW: 720,
} as const;

/* ── CSS 变量注入（必须带单位：字号/间距/上限 px，行高系数无单位）── */

type VarSpec = { key: string; value: string };
const px = (n: number): string => `${n}px`;

function collectCssVars(): VarSpec[] {
  const out: VarSpec[] = [];
  const push = (key: string, value: string): void => {
    out.push({ key, value });
  };

  for (const [k, v] of Object.entries(PAPER_TYPE)) {
    push(`type-${k}-size`, px(v.size));
    push(`type-${k}-lh`, String(v.lh));
  }
  push('md-p-gap', px(MD_TOKENS.pGap));
  for (const [i, h] of MD_TOKENS.h.entries()) {
    const n = i + 1;
    push(`md-h${n}-size`, px(h.size));
    push(`md-h${n}-lh`, String(h.lh));
    push(`md-h${n}-pt`, px(h.pt));
    push(`md-h${n}-pb`, px(h.pb));
  }
  const mdFlat: Array<[string, number]> = [
    ['md-listGap', MD_TOKENS.listGap],
    ['md-liGap', MD_TOKENS.liGap],
    ['md-liIndent', MD_TOKENS.liIndent],
    ['md-subIndent', MD_TOKENS.subIndent],
    ['md-subTop', MD_TOKENS.subTop],
    ['md-quoteGap', MD_TOKENS.quoteGap],
    ['md-quotePadV', MD_TOKENS.quotePadV],
    ['md-quotePadL', MD_TOKENS.quotePadL],
    ['md-quoteBorderL', MD_TOKENS.quoteBorderL],
    ['md-codeGap', MD_TOKENS.codeGap],
    ['md-codePadV', MD_TOKENS.codePadV],
    ['md-codePadH', MD_TOKENS.codePadH],
    ['md-codeBorderL', MD_TOKENS.codeBorderL],
    ['md-checkBorderW', MD_TOKENS.checkBorderW],
    ['md-hrMargin', MD_TOKENS.hrMargin],
    ['md-hrBorder', MD_TOKENS.hrBorder],
    ['md-tableGap', MD_TOKENS.tableGap],
    ['md-tableCellPadH', MD_TOKENS.tableCellPadH],
    ['md-tableCellPadV', MD_TOKENS.tableCellPadV],
    ['md-tableRowBorder', MD_TOKENS.tableRowBorder],
    ['md-tableCellBorder', MD_TOKENS.tableCellBorder],
    ['md-tableSize', MD_TOKENS.tableSize],
    ['md-tableLh', MD_TOKENS.tableLh],
    ['md-ciPadH', MD_TOKENS.ciPadH],
    ['md-ciBorder', MD_TOKENS.ciBorder],
    ['md-mathGap', MD_TOKENS.mathGap],
    ['md-mathSizeRatio', MD_TOKENS.mathSizeRatio],
    ['md-mathDisplayLineH', MD_TOKENS.mathDisplayLineH],
    ['md-mathDisplayMaxLines', MD_TOKENS.mathDisplayMaxLines],
    ['md-imgBoxH', MD_TOKENS.imgBoxH],
    ['md-imgGap', MD_TOKENS.imgGap],
    ['md-imgBorder', MD_TOKENS.imgBorder],
  ];
  for (const [key, v] of mdFlat) {
    // 行高系数（*lh 后缀——chromeFlat 同款约定）与 math 系数（sizeRatio/
    // lineH/maxLines）无单位；其余 px。md-tableLh 曾误带 px（1.5px——表格
    // 每行行盒 1.5px，多行单元格文字全部叠印，2026-09 表格叠字根因）。
    const unitless = /lh$/i.test(key) || (key.startsWith('md-math') && !key.endsWith('Gap'));
    push(key, unitless ? String(v) : px(v));
  }

  const chromeFlat: Array<[string, string]> = [];
  for (const [group, obj] of Object.entries(CHROME_TOKENS)) {
    for (const [prop, v] of Object.entries(obj)) {
      // 行高系数无单位（*lh 后缀），其余 px
      const value = /lh$/i.test(prop) ? String(v) : px(v as number);
      chromeFlat.push([`ch-${group}-${prop}`, value]);
    }
  }
  for (const [key, value] of chromeFlat) push(key, value);

  const assetFlat: Array<[string, string]> = [];
  for (const [group, obj] of Object.entries(ASSET_TOKENS)) {
    for (const [prop, v] of Object.entries(obj)) {
      // 行高系数无单位（*lh 后缀，与 chromeFlat 同款约定；citation/chem 的
      // 显式 px 行高键是 *Line 命名不受影响）——2026-09 修复：此前 asset 组
      // 全部 px 化，json.preLh/metric.cardValueLh/form.bodyLh 以 1.6px/1.2px/
      // 1.7px 落进 line-height，多行文本行盒塌缩叠字（与 md-tableLh 同族）。
      const value = /lh$/i.test(prop) ? String(v) : px(v as number);
      assetFlat.push([`asset-${group}-${prop}`, value]);
    }
  }
  for (const [key, value] of assetFlat) push(key, value);

  for (const [k, v] of Object.entries(LIMIT_TOKENS)) push(`lim-${k}`, px(v));
  for (const [k, v] of Object.entries(FOLIO_TOKENS)) push(`folio-${k}`, k === 'titleLh' ? String(v) : px(v));
  return out;
}

let cssVarCache: VarSpec[] | null = null;

/** CSS 变量注入：挂 .pp-root，只注入版式数字，不碰颜色（颜色走 tokens.css）。 */
export function injectPaperTokens(root: HTMLElement): void {
  cssVarCache ??= collectCssVars();
  const style = root.style;
  for (const { key, value } of cssVarCache) {
    style.setProperty(`--pp-${key}`, value);
  }
}
