# pretext 排版引擎施工单——从高度计算器到纸面排版引擎

> 立项：2026-08-30 · 状态：**P1-P5 全部竣工（commits `550973c6` / `14fa755c` / `a1d458bf`，门禁全绿）+ P4c 远景三档（2026-09-06，LOD 视觉三次返工终案）· P2a 对齐 A|B 环待实机拍板**
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
  `INK_COLORS` 字面量镜像 tokens.css L17-27（正文=墨/来文=朱砂/夹注=石墨/脚注族=
  石青/贴黄=次级/资产=三级）——canvas 读不了 CSS 变量，字面量测试钉死
  （paper-ink.test.ts，因 paper-visual-decisions.test.ts 当窗被并行在途编辑未加）。
- P4b 小地图真墨：活跃流区行条投影进 minimap（>50 块密度档每块首行）。
- 远缩导航不变：小地图点击 / 书脊定位 / Home 回原点（InkLayer pointer-events none）。

### P4c 远景三档 ✅（2026-09-06 当日落地——用户实机判 v2「纯纯一坨狗屎」第三次返工）

**病史与终案立论**：P4 v1 行条骨架（`14fa755c`）实机打回 → v2 真文字缩微
（`b870ede8`）实机再打回——**两个极端各烂一半**：真文字在 0.35 以下跌破
可读阈成灰噪声（中文 3-6px = 方块噪点，行距 lineH×zoom 坍缩行叠行）；
行条在可读带又丢掉真实纸面质感。诊断四病灶：①字号无下限；②中文小字号
物理特性；③无距离墨量补偿（近景墨色 0.94 alpha 原样搬远景 = 黑墙）；
④半像素对齐 + 卷首头/边缘 DOM 缩糊残影混杂。

**分档制（用户拍板「奔效果最好的方向」）**：
- **文字档**（0.36-0.39 迟滞带内）：真文字缩微原样保留（本档半可读成立）——
  单块降档（字号 × zoom < 5.5px 的块就地转行影，13px 程文族）。
  **2026-09-20 墨迹几何重做后**：文字不再做设备像素对齐（snap 只留矩形）——
  取整让文字位置随缩放逐帧跳格；文字位置改为亚像素直落（Chromium 自带抗锯齿）。
- **行影档**（0.14-0.36）：「文字的影子」——真行宽/真行距墨条（几何全真实
  数据，与小地图同语言）；条面墨色兑水（INK_BAR_COLORS：条面 100% 覆盖 vs
  文字 ~30% 笔画覆盖 → alpha ≈ ×0.45，朱砂 landmark 略提亮）。
- **剪影档**（<0.14）：块级墨影（足迹淡墨）+ 文类色签边（左缘 2-4px 色条
  = 文类签远景化身）——段落节奏可见，不画逐行噪声；纸条只剩外框。
- **DOM 同步退场**（lodFar 旗标，与行影档同边界同迟滞）：卷首头/边缘手柄/
  角柄/落笔点/空卷题字在行影档起退场（缩糊 DOM 文本不如无）；**卷名由
  InkLayer 地志标签接管**（地图标签逻辑：字号下限 11px，ink-1 墨——朱砂=人
  铁律不挪用；canvas ctx.font 不吃 CSS var()，--f-song 字面量镜像进组件）。
- **实现纪律**：档位判定/lodFar/色板全在 `paper/ink.ts` 单一真源
  （lodTierOf 双边界独立迟滞）；InkLayer 帧内直读（不进 React 渲染帧）；
  React 侧只多一个 lodFar 二值订阅。宿主桥三处同步（host/host.aliased/
  faceDeps + face-keys 考官全绿）。
- **接管阈 = 行影档边界**（2026-09-20 下移，用户拍板）：DOM ↔ 墨迹的切轨点
  原在 0.55（文字档中部）——该处正文约 9.3px 仍完全可读，任何几何差都在可读
  区被放大成「文字跳变」；现取 0.36（正文 ≈6.1px，已跌破可读阈），可读区
  整段留给 DOM。见 §3.5 墨迹几何重做。
- **考官**：`tests/paper-ink.test.ts` 三档迟滞 + 接管阈 = 行影档边界断言 +
  纵向几何用例（段落间距/列表缩进/语言行必须在场）+ INK_BAR_COLORS 字面量钉值；
  `tests/paper-lod-tiers.test.tsx` 行为考官 4 用例（挂真实组件：DOM 退场 /
  通道切换按 fillText 字体签名判别 / 迟滞带 DOM 不抖 / 剪影通道）。
  harness 新坑在册：canvas-view-store app 级单例跨测试残留 → restoreView
  同值短路 → 种子失效 → 挂载飞行没掐——每测前 setState 回初值。
- 真机验收（用户跑）：0.55 缩到 0.1 全程——文字半可读带仍是纸面质感、
  中段是「文字的影子」非灰噪声、极远是卷剪影 + 可读卷名；无黑墙、无闪档。

## 三、P5 夹注眉批化 ✅（方案甲合并块，commit `a1d458bf`——用户拍板「眉批化做吧」当日落地）

**目标**：夹注（reasoning）从流内独占块升级为正文旁的眉批——注疏版式的结构兑现，
聊天框范式外最大的一步。

**方案甲（合并块，已落地）**：
- **配对**：`translate.ts` 将「reasoning part → 紧随的 text part」配对为复合块——
  markdown 块挂 `payload.sidecar = { text: 夹注全文 }`（连续多条 reasoning 合并；
  payload 加可选字段，data 契约只加不改）。复合块 id = text part 的稳定 id。
- **测高**：`measure = max(正文高@全宽, 夹注高@侧栏内容宽 228)`——侧栏恒容于
  正文高内，栈几何零变化（这是合并块对纯布局配对的决定性优势）。常量
  `MARGINALIA_W/INSET` 镜像 `.pp-marginalia`。
- **渲染**：MarkdownBody 出 `.pp-marginalia` aside——块右缘 24px 起、宽 240、
  石墨 13.5px/1.85 + 弱规线起笔；折叠行贴正文块头（复合块无独立折叠行）。
  **自查修正**：设计件原写「左侧 rubric 外侧」，实查左 margin 仅 228px 且被
  文类签列占大半——眉批改**右侧**空 margin（古籍旁批本就「旁侧」不拘左右）。
- **回退**（不丢字铁律）：reasoning 在卷尾无正文跟随 / 后继非 markdown → 保持
  独立块渲染，id 用原夹注 part idx（钉住续命不断）；text 全围栏时眉批未消化 →
  同款回退。
- **已知代价（流式）**：reasoning 流式中先渲染为独立块，text part 到达后重组为
  复合块——若用户在流式中钉了夹注块，其 id（pb:msg:0）消失 → 转孤儿钉（快照
  渲染，钉不断只是降级为拷贝语义）。
- **否决方案乙（纯布局配对）**：块保持扁平、layout 并轨——测量/渲染分裂、栈位
  计算跨块耦合，漂移风险高。
- **P5b 绕排 spike（单列不并入验收）**：`layoutNextLineRange` 逐行变宽、夹注与
  正文共行对齐——真「旁注绕排」，验证手感后再决定是否产品化。
- 测试：tests/paper-marginalia.test.ts 9 用例（配对/合并/回退/围栏回退/max
  测高/签名失效）。

## 三点五、实机验收返工 ✅（commit `b870ede8`——用户三条反馈一次修完）

1. **LOD 观感差 → 真文字缩微**：抽象墨条（灰线）换 `materializeLineRange` 行
   原文 + `字号 × zoom` canvas fillText 直绘——远看是真实的缩小纸面。BlockInk
   增 size/stack（主文字源，多源次源字号差 ≤1.5px 共用主源——LOD 抽象层）；
   折叠/空块桩条走空 text 矩形路径。
2. **眉批恒折可展开**：延续「夹注恒折」拍板——眉批缺省收起「▸ 思考 N 字」
   （foldLabel 复用），点击展开；壳层 foldOv 持久（key = `${id}:sc`）；测高
   max(正文, 夹注@侧栏) 同步折叠语义（折叠态一行）。
3. **眉批可拖出钉画布**：眉批栏「钉」手柄（hover 现身）→ 拖出 = 独立夹注快照
   钉上画布（`pinId = ${block.id}:sc`，拷贝语义工作区级公共物，composite 不受
   影响）；拖中 body grab 光标反馈。
   **修订（2026-08-31，用户反馈：拖出中原地无反馈；钉出后眉批原文不该留）**：
   拖出改走整块拖拽机制（D-R2-1 同款手势语言）——首动即建钉跟手（快照自眉批
   栏原位「揭起」），眉批栏同帧换「已移出·点击恢复」占位（`.pp-marginalia-out`，
   点击拔 `:sc` 钉还原夹注），拖回流带松手 = 取消；grab 光标反馈随专用通道
   退役。快照本身仍是拷贝语义公共物。

## 三点六、墨迹几何重做 ✅（2026-09-20——用户报「LOD 一直做不好，还是有严重的文字位置跳变」）

**尸检（实机 CDP 对拍：DOM 真实行位 vs 墨迹模型行位，同换算到世界坐标）**：
墨迹是一套**平行排版系统**——`markdownInkSources` 是 `parseMarkdown` 的第二趟
走查，只推行宽与行距、**源间零间距**；而 DOM 的纵向节奏由 `measureMdElement`
的 token 走查驱动。两套走查各自演化，墨迹丢掉了全部纵向 chrome。

实测读数（zoom 1.666，720 版心 markdown 块，同一份内容）：

| 元素 | DOM 顶 | 墨迹顶 | 累计偏移 |
|---|---|---|---|
| p | 0 | 0 | 0 |
| p | 82 | 68 | **14** |
| table | 130 | 102 | **28** |
| p | 274.2 | 240 | **34.2** |
| ul | 322.2 | 274 | **48.2** |
| p | 444.2 | 376 | **68.2** |

DOM 体高 478.2 / 墨迹体高 410——**差 68.2px**，逐项来源 = `p` 的 margin 14、
`liGap` 6、标题 `pt/pb`、引用/代码内距。**误差逐元素累加**，内容越长越离谱。
另两处独立病灶：①**块级 chrome 整体缺席**（来文块题签区 `userKindH`=58 与花押
`userAsterismH`=44 在 DOM 是实体元素，墨迹把正文画在块顶）；②**基线错位**
（受控实验：`textBaseline:'top'` 落的是 em 盒顶，而 DOM 把字形盒居中于行盒——
四种字号实测恒差一个半行距：17px/34 → −6、13.5/24.975 → −3、11.5/18.4 → −1、
22/36.3 → −3）；③`snap()` 把文字屏幕坐标取整到设备像素 → 缩放中逐帧跳格。

**为什么三次返工都没修好**：真源一直存在（`measureMdElement` 算高时用的就是
驱动 DOM 的那套 `MD_TOKENS`），但墨迹走的是**另一条**平行走查；而考官只断言
「有 fillText / 有 fillRect / 行宽正确」，**从没有一条用例断言过墨迹位置**。

**修法（结构上不可能再漂）**：
1. `InkSource` 增必填 `y`（源顶距块顶）——由 `measureMdBlocks` 在算高的**同一趟
   走查**里产出（`measureMdElement` 返回 `{ h, ink }`，游标即 y）；`markdownInkSources`
   退化为该走查的薄封装。墨迹 y 与块高从此同一份代码、同一个 token。
2. 块级 chrome 逐 kind 补进 `inkSourcesFor`（来文题签 / reasoning 折叠行 /
   notice·diff·tool·code 的段头与内距 / 拟策标题行），tool·code 多源按
   「段高 + 段头上距」推进游标（与 `measureBlockHeight` 的 argsH/outH/errH 同款）。
3. InkLayer：基线改 **`textBaseline:'alphabetic'` 钉在 DOM 基线上**——
   `baseline = 行盒顶 + 半行距 + fontAscent`，`半行距 = (行高 − (ascent+descent))/2`；
   字体度量经 `measureText().fontBoundingBox*` 读一次、按字体串缓存。实测四种
   字号下基线与 DOM 完全重合（'top' 的 1-6px 系统偏差归零）。行高**逐条**携带
   （`InkBar.lineH`——同块多源行高可以不同，正文 34 / 行内码族 21.25，基线半
   行距与行影条厚都按本条算）。**文字不 snap**（矩形保留）。
4. 接管阈 0.55 → 0.36（见 §P4c 分档制条）。

**考官**（`tests/paper-ink.test.ts` 纵向几何组）：段落间距在场（第二段起笔位 =
首段高 + pGap）、列表缩进在场（`x0 = liIndent`）、语言行 + pre 内距在场、
脚注段头占位（输出段不叠参数段）——旧实现在这四条上全红。

## 三点七、富行内折行 ✅（2026-09-20 同批收尾——用户拍板「要做，我懒得判断」）

**病灶**：含加粗/斜体/行内码/行内公式的段，**测高**走富行内度量
（`measureInlineHeight` → `mdRichItems` + `measureRichItemsHeight`），**墨迹**
却按 `mdPlainText` 纯文本走查——两者字宽不同（粗体更宽、行内码 0.82em 且带
横向 chrome `MD_CI_EXTRA`、行内公式是不可折行原子），折行点可以不同。纵向
**位置**在三点六已同源，此项只影响单源内的折行点。

**修法**：墨源带上富行内片段（`InkSource.rich`，仅当 `mdHasRichInline(inl)`
为真时在场，由 `mdRichItems` 同一构造产出）→ 墨迹改走 pretext 富行内走查
（`walkRichInlineLineRanges` + `materializeRichInlineLineRange`）逐片段落墨：

- 片段横向位置 = 该行前序片段的 `gapBefore + occupiedWidth` 累加（镜像
  pretext 的 `lineWidth` 累加语义：**行首片段不付 gapBefore**，行内片段付
  折叠空白宽）；
- 片段各自字体直绘（`InkBar.frags[].font`），基线用**该源**的度量算（行内码
  字号小一档、行盒与主源同高，同基线才是对的——与 DOM 一致）；
- 折行点与测高**同一份 items、同一把尺子**（`prepareRichInline` 语义同源）。

`InkBar` 随之逐条携带 `fontSize`/`stack`（多源块不再共用块级主源字号），
`text` 在富行内行为空串（逐片段直绘，无单一字符串）。

**考官**：富行内逐片段落墨（片段各自字体——正文 17px 栈 / 行内码 13.94px）、
片段横向累加（行首 x=0、次片段 = 前序 occupiedWidth + gapBefore）、纯文本段
仍走纯文本通道（rich 不在场不启用）。

**真身冒烟（单元 mock 测不出 API 误用，故另跑一次真库）**：无头 Chromium 直接
import 真 `@chenglou/pretext/rich-inline`，跑「正文 + 行内码(extraWidth 12) +
加粗 + 收尾」400px 宽——读数自洽：`itemIndex` 全部落在源 items 下标内、片段 x
累加 == 行宽（383.58/170）、行内码片段确实拿到 13.94px 字体、跨行片段（item 2
被拆成「，后」/「面是」）位置连续。API 用法与几何语义均已实证。

## 三点八、远档卷名标签落位 ✅（2026-09-20——用户报「LOD 拉到最远，卷名文字直接跳出会话流区」）

**尸检（实机 CDP 捕获 fillText → 世界坐标 vs 纸面边界）**：远档卷名标签
（地志标签语义：字号有下限 `INK_LABEL_MIN_PX`，不随 zoom 缩到看不见）的落位是
**「卷首头位置之上再减一个屏幕空间偏移 `labelPx × 1.6`」**——屏幕偏移当世界偏移
用，于是世界偏移量 = 17.6 / zoom，**随缩远无界增长**。实机读数（摆视口让纸顶落在
屏幕 y=300，捕获一帧 ink fillText）：

| zoom | 标签顶（世界） | 纸顶（世界） | 标签在纸顶之上 |
|---|---|---|---|
| 0.35 | −37159.4 | −37107.3 | **52.1** |
| 0.30 | −37167.0 | −37107.3 | **59.7** |
| 0.35（另一卷） | −37948.0 | −37895.2 | **52.8** |

——墨落在**纸外的桌面**上（纸是 `.pp-region` 那张 1440 宽的纸，标签落它上缘之外），
正是用户看到的现象。卷首区高实测约 190 世界单位，而偏移随 zoom 无界增长，
zoom < 0.1 后偏移本身就能超过整个卷首区。

**修法（纯几何抽成可考函数）**：`regionLabelTopWorld(regionTop, folioH, labelPx)`
（`paper/ink.ts`）——标签顶 = 纸顶（`regionTop − folioH`）+ **世界**偏移，且整体
钳在卷首区高内：`offset = min(标签字形盒高, max(0, folioH × 0.35 − 标签高 / 2))`。
任何 zoom 下标签都在纸面内；极小卷首（窄流区题字多行撑高、异常值）也不出纸。
InkLayer 经纯函数直连真身取用（**不进宿主面**——宿主面是封印指纹，加键会迫使重建
exe；与 `volumeDisplayName` 同款例外）。同时去掉 `tier === 'text'` 早退：卷首头的
真实退场旗标是 `lodFar`（与 `lod` 同边界同迟滞），而 InkLayer 只在 `lod` 为真时
挂载 ⇒ 标签在场即意味着卷首头已退场，tier 早退只会在迟滞带（0.36-0.39）把标签
误吞。

**考官**（`tests/paper-ink.test.ts` 标签落位组）：标签顶 ≥ 纸顶（十档 zoom 全扫，
旧实现在 0.35 档红）、标签整体留在卷首区内不压正文、极小卷首 offset 非负、
缩远不再漂移（0.35 与 0.05 两档落点差 < 1 世界单位；旧实现差 176）。

**已知边界（在册）**：标签横向不做钳制——卷名是用户自撰文本，极长卷名在窄流区
理论上可超纸宽。实测量级：11px 下限下 24 个汉字 ≈ 288px，纸宽 1440 ⇒ 余量充足。

## 四、遗留与待办

| 项 | 说明 |
|---|---|
| 卷名标签横向钳制 | 见 §三点八 已知边界：卷名极长时可超纸宽（当前量级余量充足，未做） |
| P2a 对齐 A\|B 环 | 实机截图并排（A 居中现状 / B 左贴界栏），用户文字拍板 |
| P2 taste-ledger 立账迁移 | 本文档 §二 P2 节为暂载体；taste-ledger 并行在途编辑结束后迁入 |
| INK_COLORS 镜像断言迁移 | 现钉 paper-ink.test.ts；paper-visual-decisions 空闲后并入 |
| 实机验收 | ①lift 遮罩手势手感；②来文收缩观感；③resize 60fps；④远缩骨架与 DOM 行数对拍、阈值往返无闪烁；⑤小地图真墨；⑥**眉批栏**（夹注吸附右侧、长夹注块长高是否可接受——不可接受则做侧栏高度封顶+渐隐变体） |
