---
name: officecli
description: 用内置 office 域工具读写 Word/Excel/PPT（.docx/.xlsx/.pptx）——创建、读取、结构化查询、修改、模板批量填充、渲染截图、载入逐格式构建指南。当用户要产出或修改 Office 文档、从既有文档取内容或查格式问题、把研究结果交付成 Office 文件时用。
---

# office 域（OfficeCLI）——兰台一等工具的操作手册

兰台内置 **`office` 域工具**（`office(action, …)`），底层是 OfficeCLI 单二进制 Office 套件
（.docx/.xlsx/.pptx 读写 + 内置渲染/公式/透视引擎）。**执行面在强制层（Rust）**：命令由那边
拼装（二进制定位 + 引号 + 环境钉扎），经 `process_cap` 的 `office_exec` 动作在 os_sandbox 里
spawn；权限**只审你声明的目标文件**（`file` / `out`）——项目内直接放行，项目外或敏感路径才问
用户。plan 模式按动作分读写。

**你不需要写命令行**——动作与参数由工具层交成 argv，引号、路径、二进制定位都不归你管。
本手册讲的是"用哪个动作 + 参数怎么写才不出错"。

## 1. 动作面（12 个）

| 动作 | 干什么 | 关键参数 |
|---|---|---|
| `view` | 读数：`mode` = text / annotated / outline / stats / issues / html / svg / forms | `file` `mode` `page` `json` |
| `get` | 取某元素及其子节点 | `file` `path` `depth` `json` |
| `query` | CSS 式选择器查元素 | `file` `selector` `json` |
| `validate` | OpenXML schema 校验 | `file` |
| `create` | 建空白文件（类型由扩展名决定） | `file` |
| `set` | 改元素属性 | `file` `path` `props` |
| `add` | 加元素（可 `parent`/`type`） | `file` `parent` `type` `props` |
| `remove` | 删元素 | `file` `path` |
| `batch` | **≥3 处改动走它**：一次开关 + 原子回滚 | `file` `items` |
| `merge` | 模板 `{{key}}` 批量填充 | `file` `out` `data` |
| `screenshot` | 渲染成 PNG（页/整册） | `file` `out` `page` 或 `grid` |
| `playbook` | 载入逐格式构建指南（见 §6） | `playbook` |

**路径寻址**（`path`/`selector`）：1-based 本地名路径 `/body/p[2]`、`/slide[1]/shape[@id=2]`、
`/Sheet1/A1`；**优先用稳定形态** `[@id=…]` / `[@paraId=…]`（改完插删不漂）。`file`/`out` 支持
相对路径（按工作区根解析）。

## 2. 兰台侧铁律（违反必出错）

1. **落盘：不要手动 `save`，也不用管常驻进程**——域工具**不起**常驻进程（`OFFICECLI_NO_AUTO_RESIDENT`），每次调用自成一次 open/save，**字节当场写盘**（2026-09-15 实测：外来 resident 在场时本工具的写入也照常落盘、不被覆盖）。判定真源仍是 `office(action:'view')` 复核——不是因为它会丢，而是因为**你自己看不见图**、文案与字节可能不一致。
   · 若该文件早已被一个**外部**常驻进程持有（用户自己起的 `watch`、旧进程残留）：`view`/`set`/`add`/`batch` 都照常工作；只有 **`create` 会被那个进程的文件锁硬拒**（连 `--force` 也无效）——所以 `create` 之前工具会**自动先 close 掉它**，并在结果里告诉你（用户的活预览窗因此需要重新起 watch）。
   · 反过来：**外部程序**（Excel/WPS/兰台媒体回读）在那个 resident 持有期间读同一文件会被锁住——"改完别人看不到"多半是这个，不是你没保存。
2. **你自己看不到图**：`screenshot` 产出的是**盘上 PNG**，工具结果只回文本。要让用户看到效果：
   `office(action:'screenshot', file, out:'<工作区绝对路径>.png')` → 再
   `show_asset(kind:'file', payload={filePath:'<该 png>', ext:'png', label:'第N页'})`。
   **改完重截同一路径 + `update_asset(assetId, …)` 即可原地刷新纸面**（不必新开块）。
   你自己的机械自检走 `validate` + `view issues`（文本面）；视觉效果交人判，别替他下结论。
3. **不要在 shell 里手跑 `officecli`——本环境 shell 的 PATH 里没有它**（`command not found`）。二进制由**强制层**定位（`$OFFICECLI_PATH` → `~/.lantai/tools/officecli/officecli.exe` → PATH 兜底），这是**有意**的：你自己下 shell 找二进制跑就开了**第二条通道**，两个常驻进程会互相覆盖写入（同上：报零失败、磁盘丢行）。`install` 子命令另会往别的 agent 目录写东西，更不要跑。**需要域工具没有的 CLI 能力时：如实告诉用户"这步本环境不可用"，不要绕路。**
4. **参数不合法时工具会直说**（如"set 需要至少一个 props"）——别硬试，按提示补参数。
5. **≥3 处改动一律 `batch`**：一次开关 + 原子回滚（默认任一失败整批回滚）。**单次别超 100 项 / 12KB**——超了工具会自动分批（批间不原子），而且一次塞太多会被命令行长度上限**静默**截断。
6. **失败就是失败**：工具结果以 `[exit N]` 起头、脚注只在 `exit 0` 时才说"已提交"。看到「未成功」就别当成功继续，按报错修参数。
7. Word/WPS 打开着目标文件时会写失败（文件锁）——请用户先关。

## 3. 三层读法：先大后小

```
office(action:'view',  file, mode:'outline')     # L1：结构（文档/幻灯片大纲）
office(action:'view',  file, mode:'text')        # L1：全文（也用于扫占位符）
office(action:'view',  file, mode:'issues')      # L1：格式/内容/结构问题清单
office(action:'get',   file, path:'/body', depth:1)   # L2：某节点的子节点
office(action:'query', file, selector:'paragraph[style=Heading1]')  # L2：选择器
office(action:'set'|'add'|'remove'|'batch', …)   # L2：改
```

需要裸 XML（`raw`/`raw-set`/`add-part`）时：域工具没有这些动作，**shell 里也没有 officecli** ⇒ 停下来把限制告诉用户（不要去找二进制跑）。

## 4. 交付门槛（报告"做完了"之前逐条过）

1. **Schema**：`validate` 干净；
2. **内容**：`view issues` 无溢出/格式/结构问题；并**必扫** `view mode:'text'` 找残留占位符
   （`xxxx`、`lorem/ipsum`、`<TODO>`、`{{...}}`、空 `()`/`[]`）；
3. **视觉**：布局敏感（幻灯片尤其）出 PNG 交人判（见铁律 2）；渲染不出来就如实说"未经视觉验证"。

### 4.1 `view issues` 抓什么（实测——决定你还要自己查什么）

**抓得到**（可信，别重复劳动）：

| 类 | 实测输出 |
|---|---|
| docx 格式 | `[F1] Body paragraph missing first-line indent` + `Suggestion:`（中文正文默认就报） |
| pptx 几何 | `[O1] … extends 16.1cm past slide right edge`（形状甩出画布） |
| pptx 溢出 | `[O2] text overflow: 39 lines at 40.0pt need 1872pt, usable 21pt. suggest.height=66.3cm`（**连改法都给**） |
| xlsx 公式错 | `[F1] Formula error: #DIV/0!` / `[F2] … #VALUE!`（带 `Context:` 原文） |
| xlsx 未求值 | `[U3] Formula written but not evaluated`——**求值器不认识的函数写了等于没值**（Excel 打开才现算） |

**抓不到**（盲区——**这些必须你自己查或交人判**）：

| 盲区 | 自检动作 |
|---|---|
| **占位符残留**（docx 与 pptx 都不报 `{{x}}`/`<TODO>`/`xxxx`） | 必扫 `view text`——**这一步是承重的**；`merge` 的失败形态就是**静默留下 `{{key}}`** |
| **图片缺 alt 文本** | 域工具没有这个动作、shell 里也没有 officecli ⇒ 如实说"未验证"，交人判 |
| **空白内容**（空文档/空段落/空标题页 → 0 issues，`validate` 也过） | 只能人判；**"干净"不等于"有东西"** |

> 三层分工：机械正确性交给 `validate` + `issues`；内容存在性与占位符残留自己扫；视觉交人判。

## 5. 四条高频工作流

### 5.1 卷 / 研究结果 → 交付物

```
office(create, file:'报告.docx')
office(batch, file:'报告.docx', items:[
  { command:'add', parent:'/styles', type:'style',
    props:{ id:'Heading1', name:'heading 1', type:'paragraph', basedOn:'Normal' } },
  { command:'add', parent:'/body', type:'paragraph', props:{ text:'季度研究报告', style:'Heading1' } },
  { command:'add', parent:'/body', type:'paragraph', props:{ text:'本季度收入同比增长 25%。' } },
  { command:'add', parent:'/body', type:'table', props:{ rows:'3', cols:'3' } }
])
office(validate, file:'报告.docx')
office(view, file:'报告.docx', mode:'issues')
```

- **新建 .docx 里只有 `Normal` 一个样式**（实测）——要用的样式**先定义**（上面 batch 第一项），
  否则 `style=Heading1` 会警告 `not found in styles part`。
- **中文正文必须设首行缩进**：默认 `view issues` 会报 `[F1] Body paragraph missing first-line indent`
  （而 `validate` 是干净的——**validate 通过 ≠ 可交付**）。修：
  `office(set, file, path:'/body/p[2]', props:{ firstLineChars:'200' })`（1/100 字符单位 = 2 字符）。

### 5.2 模板 → 批量交付（设计一次，灌 N 次）

```
office(batch, file:'模板.docx', items:[{ command:'add', parent:'/body', type:'paragraph',
  props:{ text:'客户：{{client}}' } }])
office(merge, file:'模板.docx', out:'成品-001.docx', data:{ client:'Acme', total:'5,200' })
```

- `merge` 回执带 `Replaced keys: N`（实测：2 个键 → `Replaced keys: 2`）。
- **灌完必扫 `view text` 确认没有残留 `{{`**——失败了它不报错（见 §4.1 盲区）。
- 想拿现成版式当模板：officecli 的 `dump` 蓝图流 + `batch --input` 回放**本环境用不了**（域工具无此动作、shell 无二进制）⇒ 手写 `batch` 复刻版式，或如实说明受此限制。

### 5.3 既有文档注疏 → 回写

```
office(view,  file:'来文.docx', mode:'annotated')     # 带格式标注地读
office(add,   file:'来文.docx', parent:'/body/p[1]', type:'comment', props:{ text:'口径需与附件核对' })
office(set,   file:'来文.docx', path:'/body/p[2]/r[1]',
            props:{ 'revision.type':'ins', 'revision.author':'兰台' })
office(query, file:'来文.docx', selector:'revision', json:true)   # 读回（含 nativePath）
```

- **批注不能用 `view annotated` 验**——它只给正文 + 格式；批注走 `office(action:'get', path:'/comments')` 或 `office(action:'query', selector:'comment')`。
- **一个 run 同时只能挂一个修订**：叠第二个会报 `run is already inside a track-change wrapper`。
- **⚠️ 读数陷阱（实测）**：**待决删除的文本在 `view text` 里不出现**（那段看起来是空的），
  而 `view annotated` 里**照常显示、且不标注**它处于修订态 ⇒ **判定修订状态只有一个真源：
  `office(action:'query', selector:'revision')`**。
  读带修订的来文时先跑它，否则你会以为某段不存在、或以为某段是原文。

### 5.4 幻灯片

```
office(create, file:'汇报.pptx')
office(add, file:'汇报.pptx', parent:'/', type:'slide', props:{ title:'季度汇报', background:'1A1A2E' })
office(add, file:'汇报.pptx', parent:'/slide[1]', type:'shape',
       props:{ text:'收入增长 25%', x:'2cm', y:'5cm', size:'24', color:'FFFFFF' })
office(screenshot, file:'汇报.pptx', out:'<绝对路径>-第1页.png', page:1)
office(screenshot, file:'汇报.pptx', out:'<绝对路径>-全册.png', grid:true)   # 整册联系表
```

标题是**占位符**（`isTitle=true`，positional `shape[1]`）；改标题请用稳定寻址 `shape[@id=…]`。

## 6. 专项构建指南（`playbook` 动作——按需载一个）

| 场景 | playbook |
|---|---|
| 研报 / 论文 / 学术报告（引用、公式、交叉引用、多栏） | `academic-paper` |
| 通用 Word（报告、信函、备忘录、方案） | `word` |
| 可填写表单（内容控件/表单域/邮件合并/文档保护） | `word-form` |
| 通用幻灯片（汇报、评审、发布） | `pptx` |
| 融资路演 | `pitch-deck` |
| 动效 / Morph / 3D 演示 | `morph-ppt` / `morph-ppt-3d` |
| 通用表格、公式、透视 | `excel` |
| 财务模型 / 预测 | `financial-model` |
| 数据看板（CSV → KPI/图表） | `data-dashboard` |

**实测体量 25–65 KB**（`morph-ppt-3d` 25.2 / `data-dashboard` 28.7 / `excel` 34.4 / `word` 41.8 /
`pptx` 43.6 / `academic-paper` 44.4 / `word-form` 46.1 / `financial-model` 46.7 / `morph-ppt` 47.8 /
**`pitch-deck` 64.9，最大**）。
⇒ **一件产物只载一个**（载入后规则持续有效，别每轮重载）；没把握时先载再动手，比试错便宜。

⚠️ **正文是 officecli 自带的命令行指南**（488 行里 101 条 `officecli …` 命令，含强制的
"Help-First Rule: 先查 help 再动手"）。**那些命令行在本环境一律不可执行**——工具返回时会
前置一段护栏头，照它把每条命令**翻译**成 `office(action,…)`；正文要你查 help 时，改用
**一条最小 batch（1 项）**试探属性名，**不要**下 shell。

## 7. 常见坑（实测/读码得出）

| 坑 | 正解 |
|---|---|
| 新建 docx 里 `style=Heading1` 报警告 | 新建文档只有 `Normal`，先 `add /styles --type style` 定义（§5.1） |
| `view issues` 报中文正文缺首行缩进 | `props:{ firstLineChars:'200' }`（2 字符） |
| 同一 run 上叠第二个修订被拒 | 一 run 一修订；换 run，或用 `revision.type=format` |
| 带修订的文档"少了一段" / 看不出哪段有修订 | `view text` 隐藏待决删除、`annotated` 不标注——真源是 `query revision` |
| 占位符残留没人报 | 自己扫 `view text`（§4.1） |
| 图片缺 alt 没人报 | 域工具无此动作、shell 无 officecli ⇒ 如实说"未验证" |
| 改完看不到效果 | `screenshot` 出 PNG + `show_asset` 给用户看（你看不到图） |
| xlsx 公式没有值 | 求值器不认识的函数写了等于没值——看 `issues` 的 `[U3] not evaluated` |
| 单位写成 `%` 被拒 | 长度只收 cm/mm/in/pt/pc/px/Q/裸 EMU；`%` 只在行距有效（§8） |
| Windows 文件锁 | Word/WPS 打开着目标文件时写失败——请用户先关 |
| 版本漂移 | 二进制按 pin（1.0.149）装；升级走安装器换哈希，别让工具自动更新 |

## 8. 单位与颜色（值一律写在 `props` 的字符串里）

**长度**：`cm` / `mm` / `in` / `pt` / `pc` / `px` / `Q` / **裸 EMU**（`914400` = 1 英寸）。
⚠️ **`%` 不是合法长度**——只在**行距**上有意义。

**颜色**：6 位 hex（`FF0000`）/ 3 位简写（`F00`）/ 8 位含 alpha（`80FF0000` = AARRGGBB）/
4 位简写（`#F00A`）/ 命名色（`red`）/ `rgb()` `rgba()` `hsl()` / `transparent` / 主题色 `accent1`..`accent6`。
回执会带归一化结果（`rgb(255,0,0) → applied #FF0000`；带 alpha 读回是 `#RRGGBBAA`）。

**行距**：倍数 `1.5x` / 百分比 `150%`（→ `1.5x`）/ 定值 `18pt` / 长度 `0.5cm`（→ 14.15pt）/ `1in`（→ 72pt）。
**字号**：`14` 或 `14pt`。

## 9. 活预览（可选，看纸面效果）

**本环境起不了 watch**（shell 里没有 officecli）⇒ 用 §5 的截图路：改完 → `screenshot` 出 PNG →
`show_asset` 给用户看。若用户想边改边看实时刷新，如实说明这一版还不支持。
