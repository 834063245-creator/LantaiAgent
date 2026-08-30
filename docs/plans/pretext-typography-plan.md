# pretext 排版引擎施工单——从高度计算器到纸面排版引擎

> 立项：2026-08-30 · 状态：**P1-P4 竣工（commit `550973c6` / `14fa755c`，门禁全绿）· P5 设计件待用户方向确认 · P2a 对齐 A|B 环待实机拍板**
> 源起：pretext 引入的本意 = 让会话流脱离聊天框范式；施工前只用了 `prepare()+layout().height` 一个数字面。
> 自查模式：设计件 agent 自查 + 白话简报；用户面只留批次简报与个别拍板点（文字回复为准）。

## 一、技术根基（全批立论）

pretext 的 `prepare()` 是纯横向工作、**与宽度无关**——宽度变化只需重跑 `layout()`（纯算术）。
这使「块宽随意改、高度即时精确重排、resize 全程零 DOM reflow」成立；`measureLineStats/
measureNaturalWidth/layoutWithLines/walkLineRanges`（use-case 2）与 `./rich-inline` 子路径是
未开发面。装的是 `@chenglou/pretext@0.0.8`（exports 已核实含 `./rich-inline`）。

## 二、阶段落账

### P1 抽纸条手感：lift 遮罩 + 原地占位 ✅（550973c6）

拖出选区时原地「被揭起」：lift 时刻捕获 `range.getClientRects()` → 世界矩形快照
（`selectionMaskRects` 纯函数，paper/selection），世界层渲染 `.pp-lift-mask` 遮罩片
（纸色面 + 朱砂虚线，随视口变换跟手）；成条淡出（0.18s）、取消恢复选区即撤。
CSS 常量镜像 `.pp-strip` 族。测试：paper-v3a（矩形换算 + 跨行多矩形）。

### P3 富行内精确测量 ✅（550973c6）

- 有富标志（粗/斜/删/行内码/链接）的行内序列走 `prepareRichInline` +
  `measureRichInlineStats` 逐片段字体：strong `600` / em `italic` / 行内码
  mono `0.82em` + 横向 chrome 12（`.pp-md-ci` padding 5×2 + border 1×2）——
  「纯文本 ×0.96 偏窄」补偿系数 `MD_RICH_BIAS` **退役**。
- 圈点（C7）改精确：`parseCircledSegments` → 圈点段 = 原子件（`break:'never'`）+
  椭圆横向 chrome **11**（`.pp-circled` padding 4×2 + border 1.5×2，600 楷体）；
  来文按 pre-wrap 硬换行逐行拆解，空行占一行。旧「括号保守覆盖」路径删除。
- 纯文本序列保持 `prepare+layout` 旧路（pre-wrap 语义，存量测试零改动）。
- `PreparedRichInline` FIFO 缓存（同 prepareCache 纪律）。

### P2 宽度自由 ✅（550973c6）

**P2a 来文收缩（变宽纸条）**：user flow 块按内容取宽——`shrinkWrapUserWidth`
（有【】走逐行 rich 的 maxLineWidth；纯文本走 `prepareWithSegments` +
`measureNaturalWidth` 最宽强制行；附件行「附 · name」mono 同法参与），加左内缩
20，clamp `[320, 全宽]`；折行/触顶不收缩。布局零改动（`layoutFlow` 本就按每块
w 居中）。WeakMap 以源块对象为 key 的身份保持拷贝——translate 缓存与
React.memo 不逐帧失效。
**P2b 宽度手调**：钉住块/纸条右缘 resize 面（6px hover 即拖拽态，同流区边缘范式），
clamp `[320, 1440]`；`canvas-store` 增 `resizePin/resizeStrip`（canvas.json 形状
不变——pin/strip 本就存 w）；**pin.w 经 pinsMap 进 translate 成钉住几何唯一真相**
（孤儿钉/活钉渲染宽统一，旧 canvas.json 无 w 字段回落 kind 缺省宽）；测量签名加
`|w=` 尾缀——改宽必重测。流内块不提供手调（流是机器排的，钉住/纸条是用户物件）。
**拍板边界**：画布模型拍板 #2「统一宽度」指流区宽 1440 不变；块级变宽是新维度。
taste-ledger 立账**待补**（该文件当窗被并行窗口在途编辑，避免混提——本节即立账
载体，下窗迁移）。
**对齐 A|B 环待实机**：A = 居中（当前实现，asterism 本就居中）/ B = 左贴界栏
（`layoutFlow` 的 `x = -w/2` 改一行可翻）。

### P4 缩远墨迹 ✅（14fa755c）

zoom 跌破迟滞阈值时 DOM 块树/纸条/孤儿钉整体退场，屏幕空间 canvas（`InkLayer`，
rAF 直读 canvas-view-store 不进 React 渲染帧——「分层渲染」支柱）按每行真实行宽画
「真墨」行条骨架：远看真卷轴全景，近看无缝回 DOM。远缩渲染成本从 O(可见块 DOM)
降为 O(可见行条 fill)——百卷 × 两百块基准场景的远缩性能防线。
- `measure.inkSourcesFor`：墨迹文类分派单一真源（与测高同一份 payload 语义；
  markdown 走 parseMarkdown 同源走查；tool/code/diff 封顶行数镜像 cappedH 语义）。
- `paper/ink.ts`：`walkLineRanges` 无字符串分配路径；`InkCache`（签名+宽 key）；
  `INK_COLORS` 字面量镜像 tokens.css L17-27（正文=墨/来文=朱砂/夹注=赭石/脚注族=
  石青/贴黄=次级/资产=三级）——canvas 读不了 CSS 变量，字面量测试钉死
  （paper-ink.test.ts，因 paper-visual-decisions.test.ts 当窗被并行在途编辑未加）。
- P4b 小地图真墨：活跃流区行条投影进 minimap（>50 块密度档每块首行）。
- 远缩导航不变：小地图点击 / 书脊定位 / Home 回原点（InkLayer pointer-events none）。

## 三、P5 设计件：夹注眉批化（待用户方向确认——一句话即可）

**目标**：夹注（reasoning）从流内独占块升级为正文旁的眉批——注疏版式的结构兑现，
聊天框范式外最大的一步。

**方案甲（合并块，自查推荐）**：
- **配对**：`translate.ts` 将「reasoning part → 紧随的 text part」配对为复合块——
  markdown 块挂 `payload.sidecar = { text: 夹注全文 }`（连续多条 reasoning 合并；
  payload 加可选字段，data 契约只加不改）。
- **测高**：`measure = max(正文高@全宽, 夹注高@侧栏宽)`——侧栏恒容于正文高内，
  栈几何零变化（这是合并块对纯布局配对的决定性优势）。
- **渲染**：正文原样；夹注落左侧眉批栏（rubric 列外侧，~240px 宽，13.5px 石墨），
  绝对定位锚块顶；折叠行贴正文块头。
- **回退**（不丢字铁律）：reasoning 在卷尾无正文跟随 / 后继非 markdown → 保持
  独立块渲染（现状）。
- **已知代价（流式）**：reasoning 流式中先渲染为独立块，text part 到达后重组为
  复合块——若用户在流式中钉了夹注块，其 id（pb:msg:0）消失 → 转孤儿钉（快照
  渲染，钉不断只是降级为拷贝语义）。
- **否决方案乙（纯布局配对）**：块保持扁平、layout 并轨——测量/渲染分裂、栈位
  计算跨块耦合，漂移风险高。
- **P5b 绕排 spike（单列不并入验收）**：`layoutNextLineRange` 逐行变宽、夹注与
  正文共行对齐——真「旁注绕排」，验证手感后再决定是否产品化。
- 成本：2-3 天（含测试与镜像注释）。

**用户确认点（一句话）**：眉批化方向是否开工？开工则侧栏宽默认 240px（可调）。

## 四、遗留与待办

| 项 | 说明 |
|---|---|
| P2a 对齐 A|B 环 | 实机截图并排（A 居中现状 / B 左贴界栏），用户文字拍板 |
| P2 taste-ledger 立账迁移 | 本文档 §二 P2 节为暂载体；taste-ledger 并行在途编辑结束后迁入 |
| INK_COLORS 镜像断言迁移 | 现钉 paper-ink.test.ts；paper-visual-decisions 空闲后并入 |
| P5 开工确认 | §三 一句话拍板 |
| 实机验收 | ①lift 遮罩手势手感；②来文收缩观感；③resize 60fps；④远缩骨架与 DOM 行数对拍、阈值往返无闪烁；⑤小地图真墨 |
