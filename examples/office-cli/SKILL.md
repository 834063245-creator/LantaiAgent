---
name: officecli
description: 用 officecli 读写 .docx/.xlsx/.pptx——创建、读取、结构化查询、修改、模板批量填充、渲染截图。当用户要产出或修改 Word/Excel/PPT 文档、要从既有文档里取内容或查格式问题、要把研究结果交付成 Office 文件时用。兰台内经 MCP 工具 mcp__office__officecli 调用。
---

# officecli（兰台版）

officecli 是单二进制 Office 套件（.docx/.xlsx/.pptx 读写 + 内置渲染引擎），无需安装 Office。

## 1. 调用面（兰台）

- 工具名 **`mcp__office__officecli`**，唯一参数 `command`：
  - **argv 数组**（推荐——含空格/引号/括号的值一律用数组形态）；
  - 或字符串命令行（一行 CLI，按 shell 规则切词）。
- 调用示例：

```
{"command": ["create", "报告.docx"]}
{"command": ["add", "报告.docx", "/body", "--type", "paragraph", "--prop", "text=季度总结", "--prop", "style=Heading1"]}
{"command": ["get", "数据.xlsx", "/Sheet1/A1", "--json"]}
{"command": ["view", "汇报.pptx", "screenshot", "-o", "D:/tmp/p1.png", "--page", "1"]}
```

- 二进制缺席时工具会报未就绪/找不到命令：先 `{"command": "--version"}` 自检，别继续猜。
- 路径 **1-based**：`/slide[1]/shape[2]`、`/body/p[3]`、`/Sheet1/A1`。稳定 ID 形态更耐改：`/slide[1]/shape[@id=550950021]`、`/body/p[@paraId=1A2B3C4D]`。

## 2. 兰台特有铁律（违反必出错，先读这段）

1. **落盘边界**：officecli 自己的读（`get`/`query`/`view`）总见最新编辑，但**兰台/别的程序读的是盘上字节**。凡是要让兰台回读（媒体预览、附件、交付、外部打开）或截图前，先 `save <file>`（保 resident）或 `close <file>`（落盘并释放）。
   —— 简单记法：**每次要让别人看见结果之前，先 save。**
2. **模型看不到图**：`view screenshot` 返回的是图片内容块，兰台的工具结果契约只收文本 ⇒ **图会丢**。要看效果只能：
   - 落盘 `{"command": ["view", f, "screenshot", "-o", "<绝对路径>.png", "--page", "N"]}`，再
   - `show_asset(kind='file', payload={filePath: '<该 png 绝对路径>', label: '第 N 页', ext: 'png'})` 给用户看；
   - 自己的自检用文本面：`validate` + `view <file> issues` + `view <file> text`。
3. **不要跑 `officecli install`**（它会往 ~/.claude、Cursor 等目录写技能/配置）；不要开启自动更新（兰台部署已设 `OFFICECLI_SKIP_UPDATE=1`）。
4. **别猜属性名**：不确定就跑 `help`（见 §4），一次 help 胜过多次失败重试。
5. **≥3 处修改用 `batch`**：一次开关、默认**原子回滚**（任一项失败则整批不落盘）。要"尽力而为"加 `--best-effort`。
6. Word/WPS 打开着目标文件时写入会 `file_locked`——请用户先关掉。

## 3. 策略：L1 读 → L2 DOM → L3 裸 XML

优先高层，够用就别下沉：

| 层 | 用途 | 命令 |
|---|---|---|
| **L1 读** | 理解文档结构/内容/问题 | `view`（modes：`text` `annotated` `outline` `stats` `issues` `html` `svg` `screenshot`）、`get`、`query`、`validate` |
| **L2 DOM** | 改元素 | `set`、`add`、`remove`、`move`、`swap`、`batch` |
| **L3 裸 XML** | L2 表达不了时的万能兜底 | `raw`、`raw-set`、`add-part` |

一切读命令加 `--json` 拿结构化输出（别去正则解析文本）。

```bash
view 报告.docx issues --json          # 格式/内容/结构问题清单
view 汇报.pptx outline                # 逐页大纲
get 数据.xlsx /Sheet1/B2 --json       # 单元格（含公式求值结果）
query 报告.docx 'paragraph[style=Heading1]'   # CSS 式选择器，支持 :contains / and / or
```

## 4. help 优先（不许猜）

```bash
help                       # 全部命令与全局选项
help docx                  # 该格式可用的元素类型
help pptx set shape        # 某元素的全部可设属性（动词过滤）
help docx paragraph --json # 机器可读 schema
```

## 5. 交付门槛（delivery gate —— 报告"做完了"之前逐条过）

1. **Schema**：`validate <file>` 干净；
2. **内容**：`view <file> issues` 无溢出/格式/结构问题；并用 `view <file> text` 扫残留占位符（`xxxx`、`lorem/ipsum`、`<TODO>`、`{{...}}`、`$VAR$`、空 `()`/`[]`）；
3. **视觉**：布局敏感（幻灯片尤其）要出图——按兰台铁律 2 落盘 PNG + `show_asset` 交给用户判；图渲染不出来就如实说"未经视觉验证"；
4. **落盘**：`save <file>`（收尾必做，永不丢失、永不出错）。

**validate 通过 ≠ 可交付。** 逐格式的权威门槛在专项技能里（§6）。

### 5.1 `view issues` 到底抓什么（逐类实测——这决定你还要自己查什么）

**抓得到**（可信，别重复劳动）：

| 类 | 实测输出 |
|---|---|
| docx 格式 | `[F1] Body paragraph missing first-line indent` + `Suggestion: …`（中文正文默认就报） |
| pptx 几何 | `[O1] … extends 16.1cm past slide right edge`（形状甩出画布） |
| pptx 溢出 | `[O2] text overflow: 39 lines at 40.0pt need 1872pt, usable 21pt. suggest.height=66.3cm`（**连改法都给**） |
| xlsx 公式错 | `[F1] Formula error: #DIV/0!` / `[F2] Formula error: #VALUE!`（带 `Context:` 原文） |
| xlsx 未求值 | `[U3] Formula written but not evaluated (no cachedValue, evaluator unsupported)`——写了求值器不认识的函数时，**单元格没有值**（Excel 打开才现算），别以为写进去了 |

**抓不到**（实测盲区——**这些必须你自己查或交人判**）：

| 盲区 | 自检动作 |
|---|---|
| **占位符残留**（docx 与 pptx 都不报 `{{x}}`/`<TODO>`/`xxxx`） | 必扫 `view <f> text`——**这一步是承重的，不是保险**；`merge` 的失败形态就是静默留下 `{{key}}` |
| **图片缺 alt 文本**（issues 不报） | `query <f> 'picture:no-alt'`（docx 也可 `image:no-alt`）——命中即无 alt，自己补 |
| **空白内容**（空文档/空段落/空标题页 → 0 issues，`validate` 也过） | 只能靠人判（截图 + `view outline`/`text` 看有没有内容）；**"干净"不等于"有东西"** |

> 结论：**机械正确性交给 validate + issues；内容存在性与占位符残留必须自己扫；视觉效果交人判。** 三层各管一段，谁都替代不了谁。

## 6. 专项技能（按需加载，一次一个，别叠加）

```
{"command": ["load_skill", "word"]}          # 或 pptx / excel / academic-paper / ...
{"command": ["load_skill"]}                  # 不带名 = 列出全部
```

| 场景 | 加载 |
|---|---|
| 研报 / 论文 / 学术报告（引用、公式、交叉引用、多栏） | `academic-paper` |
| 通用 Word（报告、信函、备忘录、方案） | `word` |
| **可填写表单**（内容控件 SDT / 表单域 / 邮件合并 / 文档保护） | `word-form` |
| 通用幻灯片（汇报、评审、发布） | `pptx` |
| 融资路演 | `pitch-deck` |
| 动效 / Morph / 3D 演示 | `morph-ppt` / `morph-ppt-3d` |
| 通用表格、公式、透视 | `excel` |
| 财务模型 / 预测 | `financial-model` |
| 数据看板（CSV → KPI/图表） | `data-dashboard` |

**实测体量（本机逐个量过）**：25–65 KB —— `morph-ppt-3d` 25.2 / `data-dashboard` 28.7 / `excel` 34.4 /
`word` 41.8 / `pptx` 43.6 / `academic-paper` 44.4 / `word-form` 46.1 / `financial-model` 46.7 /
`morph-ppt` 47.8 / **`pitch-deck` 64.9（最大，≈1.6 万 token）**。
⇒ **一件产物只加载一个**（规则加载后持续有效，别每轮重载）；`pitch-deck` 这类大件尤其别顺手多载。
部分技能**自带参考文件**（`morph-ppt` 实测带 7 个）：正文末尾会给清单，
用 `{"command": ["load_skill", "<名>", "--path", "<relpath>"]}` 单独取一份——比整篇重载省得多。

## 7. 三条高频工作流（兰台场景）
### 7.1 卷/研究结果 → 交付物

**新建的 .docx 里只有 `Normal` 一个样式**（实测）——直接在段落上写 `style=Heading1` 会有警告
`style 'Heading1' not found in styles part`。要用的样式**先定义再加**，一次 `batch` 建骨架：

```
{"command": ["create", "报告.docx"]}
{"command": ["batch", "报告.docx", "--commands", "[{\"command\":\"add\",\"parent\":\"/styles\",\"type\":\"style\",\"props\":{\"id\":\"Heading1\",\"name\":\"heading 1\",\"type\":\"paragraph\",\"basedOn\":\"Normal\"}},{\"command\":\"add\",\"parent\":\"/body\",\"type\":\"paragraph\",\"props\":{\"text\":\"季度研究报告\",\"style\":\"Heading1\"}},{\"command\":\"add\",\"parent\":\"/body\",\"type\":\"paragraph\",\"props\":{\"text\":\"本季度收入同比增长 25%。\"}}]", "--json"]}
{"command": ["validate", "报告.docx"]}
{"command": ["view", "报告.docx", "issues"]}
```

- **中文正文必须设首行缩进**：默认 `view issues` 会报
  `[F1] Body paragraph missing first-line indent`（validate 却是干净的——**validate 通过 ≠ 可交付**）。
  修复：`{"command": ["set", f, "/body/p[2]", "--prop", "firstLineChars=200"]}`（`firstLineChars` 是
  **1/100 字符**单位，200 = 2 字符；也可用 `firstLineIndent=0.85cm`）。
- `batch` 的 `--commands` 参数是一整串 JSON——**必须用 argv 数组形态**传，字符串形态会被引号地狱撕碎。
- 回执里读 `data.summary.succeeded/failed` 判成败（默认原子：任一项失败整批回滚）。
- `save` 幂等，回执两种形态：`Saved x` / `x is already saved to disk.`（命令间隙可能已自动落盘）。

### 7.2 模板 → 批量交付（先学样张，再灌数据）

```bash
dump 用户给的样张.docx -o blueprint.json     # 结构化蓝图（不是裸 XML），可读可改
batch 新件.docx --input blueprint.json        # 回放；失败默认整批回滚
merge 发票模板.docx 出-001.docx --data '{"client":"Acme","total":"¥5,200"}'
```

**实测口径（可当验收判据）**：一份「样式 + 标题 + 正文 + 表格」的 docx，`dump` 出来是**细粒度项集**
（本机实测 16 项，非 4 项），回放到新件 `succeeded: 16 / failed: 0`，`view text` 三处内容与表格都在、
`validate` 干净；`merge` 回执带 `Replaced keys: N`（本例 2），成品里不再有 `{{`。
→ 模板流的正确姿势：**样式与版式设计一次（贵）→ dump 存蓝图 → 数据灌 N 次（便宜、确定性）**。
⚠️ **`merge` 的失败形态是静默的**：`{{key}}` 没被替换时工具不报错、`view issues` 也不报（见 §5.1 盲区）
——**灌完必须扫一遍 `view <f> text` 确认没有 `{{`**，否则交付物里会带着模板记号出门。

### 7.3 既有文档注疏 → 回写（Word 原生批注 + 修订痕迹）

```
{"command": ["view", "来文.docx", "text"]}                                  # 先读（或 annotated 带格式读）
{"command": ["add", "来文.docx", "/body/p[1]", "--type", "comment", "--prop", "text=口径需与附件核对"]}
{"command": ["set", "来文.docx", "/body/p[2]/r[1]", "--prop", "revision.type=ins", "--prop", "revision.author=兰台"]}
{"command": ["get", "来文.docx", "/comments", "--json"]}                     # 批注读回（锚点/作者/时间都在）
{"command": ["query", "来文.docx", "revision", "--json"]}                    # 修订读回（含 nativePath）
{"command": ["set", "来文.docx", "/body/p[2]/ins[1]", "--prop", "revision.action=accept"]}
```

- **批注**锚在段落/元素上；读回用 `get /comments` 或 `query <f> comment`（`query comment[@author=…]` 可筛）。
  ⚠️ `view annotated` **不显示批注**（实测只给正文 + 格式），别用它验批注。
- **修订**：run 宿主上 `revision.author` **必须与 `revision.type=ins|del|format|moveFrom|moveTo` 成对**
  （只有 author 会被拒——那会写出空快照 `rPrChange`，等于记录了一个不存在的改动）。
- **接受/拒绝修订**用 **native path**（`/body/p[N]/ins[1]`，`query revision --json` 的
  `format.revision.nativePath` 给出宿主位置），**不是** `set <f> /revision[@id=…]`，也不是 `set <f> /`
  （后者对 revision.action 会报 `Malformed path '/'`）。按作者批量：`set <f> '/revision[@author=兰台]' …`。
- 批注与修订是两条互不干扰的通道：接受修订不动批注。
- **一个 run 同时只能挂一个修订**：重复挂会报
  `run is already inside a track-change wrapper; accept/reject the existing revision first`
  ——要同时表达"改前→改后"，用 `revision.type=format` 或分别落在不同 run 上（实测）。
- **⚠️ 读数陷阱（实测，容易误判整篇文档）**：**待决删除的文本在 `view <f> text` 里不出现**
  （那一段看起来是空的），而在 `view <f> annotated` 里**照常显示、且不标注**它处于修订态
  ——两个读数面都不告诉你"这里有未决修订"。**判定修订状态只有一个真源：`query <f> revision`**
  （回 `revision.type` / `revision.author` / `nativePath`）。读一份带修订的来文时先跑它，
  否则你会以为某段不存在（其实是待决删除）、或以为某段是原文（其实挂着修订）。

### 7.4 xlsx 数据面（公式 / 透视 / CSV 进表）

```
{"command": ["create", "数据.xlsx"]}
{"command": ["set", "数据.xlsx", "/Sheet1/A1", "--prop", "value=Region", "--prop", "bold=true"]}
{"command": ["set", "数据.xlsx", "/Sheet1/B4", "--prop", "value==SUM(B2:B3)"]}
{"command": ["add", "数据.xlsx", "/Sheet1", "--type", "pivottable", "--prop", "source=Sheet1!A1:B3", "--prop", "rows=Region", "--prop", "values=Revenue:sum"]}
{"command": ["get", "数据.xlsx", "/Sheet1/B4", "--json"]}
```

- **公式要写 `value==SUM(B2:B3)`（两个 `=`）**——`--prop key=value` 的第一个 `=` 是分隔符，值本身以 `=` 开头
  才被当公式；漏掉前导 `=` 会**静默存成字符串**（`evaluated: false`，看不出来）。
- 求值结果直接读：`get --json` 的 `format.computedValue` / `evaluated` / `formula`（写入即算，无需 Excel 回环）。
- 透视表一条命令落 OOXML；`view <f> text` 能看到透视输出区（含 `Grand Total`）。

### 7.5 纸面活预览（截图刷新路——兰台当前无"环回 URL 窗口"平台件时的正式形态）

要点：**同一份文档固定用同一个 PNG 路径**，靠 `update_asset` 原地刷新资产块（不新开块、不刷屏）。

1. **首次**：`{"command": ["view", f, "screenshot", "-o", "<绝对路径>/<文档名>-第N页.png", "--page", "N"]}`
   → `show_asset(kind='file', title='<文档名> 预览', payload={filePath: <该 png>, label: '第N页', ext: 'png'})`
   → **记下返回的 `assetId`**。
2. **每次改完**：`save <f>`（**必做**）→ 重新截到**同一路径** →
   `update_asset(assetId, payload={filePath: <同一路径>, label: '第N页', ext: 'png'})`。
3. **多页**：`--page N` 一页一张（每页一个块/一次 update）；想一眼看全册用 `--grid auto` 出联系表。
4. **判据**：内容改了、图必须跟着变。**实测已证**：Save 后重截同一路径，PNG 字节确实不同
   （`src-ui/tests/office-cli-e2e.test.ts` ⑨ 用字节差钉死这条语义）；图没变先怀疑漏了 `save`。
   —— 这是"活预览"在兰台的最小可用形态；`officecli watch` 的活刷新页已有一条真机验证过的通路
   （平台件：窗入口二态 + 环回 URL，`office_preview_open` 开窗；实测帧内 SSE `readyState=OPEN`、页面真渲染），
   但**在技能里不必自己内嵌**——开窗是插件工具的事，技能只管产出与自检。
### 7.6 幻灯片（pptx）最小工作流（逐条实测）

```
{"command": ["create", "汇报.pptx"]}
{"command": ["add", "汇报.pptx", "/", "--type", "slide", "--prop", "title=季度汇报", "--prop", "background=1A1A2E"]}
{"command": ["add", "汇报.pptx", "/slide[1]", "--type", "shape", "--prop", "text=收入增长 25%", "--prop", "x=2cm", "--prop", "y=5cm", "--prop", "size=24", "--prop", "color=FFFFFF"]}
{"command": ["view", "汇报.pptx", "outline"]}
{"command": ["view", "汇报.pptx", "issues"]}
{"command": ["view", "汇报.pptx", "screenshot", "-o", "<绝对路径>-第1页.png", "--page", "1"]}
{"command": ["view", "汇报.pptx", "screenshot", "-o", "<绝对路径>-全册.png", "--grid", "auto"]}
{"command": ["validate", "汇报.pptx"]}
{"command": ["save", "汇报.pptx"]}
```

**实测口径**：`add / --type slide` 建页（`title` 与 `background` 同时给）；`add /slide[N] --type shape`
加文本框，四类属性一次到位（文本/坐标/字号/颜色）；`view outline` 出一页一行的大纲；
`view issues` 本机干净（0 条）；`screenshot --page N` 出单页 PNG，**`--grid auto` 出全册联系表**
（2 页 deck 实测 26.6 KB）——两者都能直接喂纸面资产块；`validate` 干净。
标题是**占位符**（`isTitle=true`），新加的 shape 是普通文本框——改标题请寻址 `shape[@id=2]` 那类稳定 id，
别用 positional `shape[1]`。



**长度**：`cm` / `mm` / `in` / `pt` / `pc` / `px` / `Q` / **裸 EMU**（如 `914400` = 1 英寸）。
⚠️ **`%` 不是合法长度**（`x=10%` 会被拒：`Invalid length value '10%'`）——百分比只在**行距**上有意义。

**颜色**：6 位 hex（`FF0000`）/ 3 位简写（`F00`）/ 8 位含 alpha（`80FF0000` = AARRGGBB）/
4 位简写（`#F00A`）/ 命名色（`red`）/ `rgb()` `rgba()` `hsl()` `hsla()` / `transparent` /
主题色 `accent1`..`accent6`。
回执会带**归一化结果**（`color=rgb(255,0,0) (applied: color=#FF0000)`；带 alpha 的读回是 `#RRGGBBAA` 形态）。

**行距（lineSpacing）**：倍数 `1.5x` / 百分比 `150%`（→ applied `1.5x`）/ 定值 `18pt` /
长度 `0.5cm`（→ 14.15pt）/ `1in`（→ 72pt）——五形态全通。
**字号**：`14` 或 `14pt`；**坐标**：`x=2cm` / `y=5cm`（幻灯片绝对定位）或 `anchor=x,y,w,h` 简写。

## 9. 常见坑

| 坑 | 正解 |
|---|---|
| `--name "foo"` | 属性一律 `--prop name="foo"` |
| shell 里 `/slide[1]` 被 glob 展开 | 用 argv 数组形态（兰台推荐）或加引号 |
| PPT 里 `shape[1]` 改了标题 | `shape[1]`（positional）通常是**标题占位符**（`isTitle=true`、`zorder=1`），正文从 `shape[2]` 起；**优先用稳定寻址 `shape[@id=N]` / `shape[@name=X]`**（实测：新建的 shape 拿到 `shape[@id=100000]`，改完插删不会漂） |
| 猜属性名 | 跑 `help <format> <element>` |
| 新建 docx 里 `style=Heading1` 报警告 | 新建文档只有 `Normal`，先 `add /styles --type style` 定义（§7.1） |
| `view issues` 报中文正文缺首行缩进 | `--prop firstLineChars=200`（2 字符） |
| 同一 run 上叠第二个修订被拒 | 一 run 一修订；换个 run，或用 `revision.type=format`（§7.3） |
| 带修订的文档"少了一段" / 看不出哪段有修订 | `view text` 隐藏待决删除、`annotated` 不标注——真源是 `query revision`（§7.3） |
| 改了但兰台/别的程序看不到 | 没 `save`（铁律 1） |
| 想看效果却"看不到图" | 工具结果里的图会丢——落盘 PNG + `show_asset`（铁律 2） |
