# 兰台

兰台是纸壳 · 注疏案卷的桌面 Agent 工作台：会话摊在一张可缩放的纸上，模型经域工具、子 Agent、技能与组合层工作。本词汇表是应用级统一语言，已锁定「模型接入」「会话与聊天」「任务与目标」「状态」「事件」五个簇；`kind` 与 `status` 是重载字段，用词时必须带簇前缀。

## Language

### 模型接入（Provider 域）

**Provider**:
Agent 可用来与模型对话的接入点，由端点、凭据与默认模型构成。代码标识符统一用 Provider；界面中文展示词为「提供方」（2026-08-24 起，「信号源」为观测站时代旧词退役——对齐 DeepSeek Harness 官方中文定译；设置页是技术配置域，用平实词）。
_Avoid_: 信号源（旧展示词，已退役；任何语境）、服务商、backend

**ProviderId**:
Provider 的身份标识，唯一且不可变；同时是系统凭据键与动态模型合并键（三合一）。它是身份，不是显示名。
_Avoid_: name（当身份使用时）、providerName、字符串

**Vendor**:
提供模型 API 的品牌或组织（如 DeepSeek、Anthropic、GLM）。一个 Provider 通常指向一个 Vendor，但 Vendor 是品牌，不是接入配置。
_Avoid_: provider、服务商、公司

**Protocol**:
模型 API 的线上方言：Anthropic Messages 或 OpenAI 兼容。决定请求如何构造与解析；与 Vendor 正交（同一 Vendor 可提供不同 Protocol 的端点）。
_Avoid_: kind、API 类型、厂商协议

**Model**:
Vendor 提供的具体模型，有唯一标识与能力元数据（上下文窗口、思考档位、输入模态 text/image）。
_Avoid_: 模型名、model id、LLM

**ModelId**:
标识具体模型的字符串（如 deepseek-v4-pro）。它是 Model 的身份，不是 Model 本身。
_Avoid_: model、模型名

**ThinkingPolicy**:
用户对「模型作答前推理多少」的配置。统一档位（自动/浅/低/中/高/较深/极限/关闭）是 UI 与
存储形态；每个模型还可声明自己提供哪些档位、每档请求里发送什么 API 参数值
（`ModelOverrides.reasoningEfforts`，对齐 DSH），wire 参数按声明值发送（缺省 = 档位原名；
Anthropic 无声明时走 budget_tokens）。映射唯一事实源在 provider/thinking.ts。
区别于模型能力（是否支持推理）与响应中的思维链内容。
_Avoid_: thinking、深度思考、reasoning（作设置名）

**ConnectionProbe**:
对 Provider 的一次最小连通性验证，产生结果：成功/失败、耗时、时间与消息。它是检查动作及其结果，不是 Provider 配置。
_Avoid_: 测试连接结果、lastTest、testStatus

**Credential**:
与 Provider 关联的 API Key。只存在于系统加密存储，本地持久化中永不明文。
_Avoid_: key、apiKey、密钥

**Catalog**:
内置模型注册表：静态目录条目与运行时从 Vendor 拉取的动态条目合并而成。
_Avoid_: 模型列表、registry

### 会话与聊天（Session & Chat 簇）

**Session**:
一次持久化的对话容器，有唯一 SessionId、消息数组与活动索引。会话与 Provider/Agent 运行周期正交，可切换、可恢复。
_Avoid_: 线程、面板、conversation

**ChatMessage**:
聊天流中的一条记录，按 role 分为用户消息（user）、助手消息（assistant）与通知（notice）。它是不可变记录，流式更新通过替换条目实现。
_Avoid_: 气泡、bubble（代码标识符）

**MessageId**:
ChatMessage 的身份标识，全局单调递增（如 m1、m2），跨会话不重用。
_Avoid_: id（裸用）、序号

**Turn**:
一个「用户消息 → 助手完整回复（可穿插多次工具调用）」的完整回合。工具调用属于 Turn，不单独算回合。
_Avoid_: 轮次、round

**AssistantPart**:
助手消息内的有序组成部分：推理（reasoning）、文本（text）、工具调用（tool）、子代理（subagent）、计划审查（plan）。
_Avoid_: 气泡、block、section

**Notice**:
系统通知消息，带 level（info/warn/error），展示为横幅或状态提示；不是用户或模型的对话内容。
_Avoid_: toast、log、消息（当指 notice 时）

**ChatImageRef**:
消息内图片的唯一形态：内容寻址引用（id = 规整字节 sha256 + 媒型 + 宽高 + 显示名）。字节永不进消息/会话卷——落 `{ws}/.lantai/attachments/{id}.{ext}`，请求期才解析成 wire 格式（multimodal-image-plan D-1）。
_Avoid_: base64、图片消息、inline image、blob

**附图**:
用户附入卷的图片（输入草稿 `attachedImages` / 用户消息 `images`），区别于**附件**（路径文件引用，模型经 read_file 自取）。采集三入口：粘贴 / 拖放 / 夹选；展示中文一律用「附图」，不用「图片附件」。入口随**生效输入模态**显隐（`modelInput`：per-model 覆盖 ?? 目录声明）——vision 模型才开附图道；选择器徽标展示字恒「视」，设置页补声明开关叫「视觉模型」。
_Avoid_: 图片附件、image attachment、上传图片

**准入规整**:
附图入卷前的验收管线（image-intake.ts）：magic-byte 白名单（png/jpeg/webp/gif）+ EXIF 校正 + 保比降采样（长边 ≤2048 / 编码 ≤4MiB）+ sha256 内容寻址。规整在 TS webview，Rust 只留能力口（write_base64）。
_Avoid_: 压缩（当指规整时）、上传

### 任务与目标（Task & Goal 簇）

**Task**:
Agent 自管理的一次可跟踪工作项（`task(create|get|list|update|stop|board)` 域工具），会话内生效，带 TaskStatus。用于跨轮次追踪多步工作。
_Avoid_: issue、todo、goal

**TaskStatus**:
Task 的状态机：pending → in_progress → completed / cancelled。
_Avoid_: status（裸用）、state

**Goal**:
每卷一个的长期目标（GoalSnapshot）：状态住会话日志（`goal/change` 事件 + 严格折叠，修订 CAS），阶段 active / paused / blocked / complete；`/goal` 命令与 `goal(get/create/update)` 域工具走同一内核服务。
_Avoid_: task、mission、目标（代码标识符）

**GoalStatus**:
Goal 的状态机：active / paused / completed / failed / cancelled。
_Avoid_: status（裸用）

**SubAgent**:
由 Agent 派生的子代理，以 AgentId 标识，可输出独立事件流并在 board 上留痕。
_Avoid_: worker、子进程、agent（当指子代理时）

**SubAgentStatus**:
SubAgent 的生命周期状态：running / completed / failed / stopped。
_Avoid_: status（裸用）

**AgentRunStatus**:
Agent 会话/运行记录的状态。当前代码存在两处值域差异：agent-store 为 idle/running/done/failed，runtime 为 idle/running/paused/completed/failed/stopped——须收敛为单一事实源后锁定。
_Avoid_: status（裸用）、AgentStatus（在需要统一概念时）

**BoardEntry**:
任务板（TaskBoard）上的一条子代理记录，带 BoardStatus 与隔离 worktree 关联。
_Avoid_: task（当指 board 条目时）

**DiscoveryEntry**:
发现板（DiscoveryBoard）上的一条探索发现记录，带 DiscoveryStatus（active/archived）。
_Avoid_: 发现、note

### 状态（Status 簇）

**DesktopGrant**:
窗口级接管授权记录（agent + hwnd 键控、滑动 TTL）。用户批准一次窗口接管后，该 Agent 在该窗口上的 pattern 动作不再逐次确认；敏感目标与物理输入路径仍单独 Ask。
_Avoid_: 授权、permission（泛指）、grant（裸用）

**InputLease**:
物理输入租约（进程级全局唯一）：SetCursorPos/SendInput/剪贴板/抢前台等真实输入注入必须先获取，跨 Agent 串行化；持有者对状态可见，抢不到回 `[UIA_LEASE_BUSY]`。
_Avoid_: 锁、mutex（当指输入租约时）、lease（裸用）

**ProbeOutcome**:
ConnectionProbe 的结果：ok / fail。它是检查动作的产物，不是 Provider 的派生状态。
_Avoid_: status（裸用）、testStatus

**ProviderStatus**:
提供方列表/控制台展示的派生状态：unconfigured（无 Key）/ configured（有 Key 未测或结果丢失）/ ok（最近测试通过）/ fail（最近测试失败）。唯一事实源是 status.ts 的 providerStatus()。
_Avoid_: 状态点、status（裸用）

**ToolRunStatus**:
工具调用部分的执行状态：pending / running / done / error。
_Avoid_: status（裸用）

**MessageStreamStatus**:
助手消息整体的流式状态：streaming / done / error。
_Avoid_: status（裸用）

**PlanApprovalStatus**:
计划审查卡片的审批状态：pending / approved / revise / rejected。
_Avoid_: status（裸用）

`status` 字段重载速查（写代码/对话时带簇前缀，禁止裸用）：

| 载体 | 规范词 | 值域 |
| --- | --- | --- |
| ConnectionProbe.status | ProbeOutcome | ok / fail |
| providerStatus() 派生 | ProviderStatus | unconfigured / configured / ok / fail |
| AgentRecord.status / AgentStatus | AgentRunStatus | 两处值域，待收敛 |
| SubAgentHandle.status | SubAgentStatus | running / completed / failed / stopped |
| ToolCallPart.status | ToolRunStatus | pending / running / done / error |
| AssistantMessage.status | MessageStreamStatus | streaming / done / error |
| PlanPart.status | PlanApprovalStatus | pending / approved / revise / rejected |
| Task.status | TaskStatus | pending / in_progress / completed / cancelled |
| GoalRecord.status | GoalStatus | active / paused / completed / failed / cancelled |
| DiscoveryEntry.status | DiscoveryStatus | active / archived |
| BoardEntry.status | BoardStatus | running / completed / failed / stopped / merged |

HTTP status、git status 等外来状态不属于本项目词汇，不进入本表。

### 事件（Event 簇）

**AgentEvent**:
Agent 输出的事件流条目，以 EventKind 判别；经 EventSink 单向流向 UI。UI 不得反向写 Agent 事件流。
_Avoid_: message（当指事件时）、bus event

**EventKind**:
AgentEvent 的种类：turn_started / reasoning / text / message / tool_dispatch / tool_result / tool_progress / usage / notice / session_changed / plan_review / asset / asset_delta。
_Avoid_: type、kind（裸用）

**Chunk**:
Provider 流式响应中的数据片，以 ChunkType 判别（Text/Reasoning/ToolCall/Usage/Done/Error 等）。
_Avoid_: 流片、stream piece、事件（Chunk 不是 AgentEvent）

`kind` 字段重载速查（四义）：

| 载体 | 规范词 | 值域/说明 |
| --- | --- | --- |
| ProviderSettings.kind / ModelDescriptor.kind / catalog JSON kind | Protocol | anthropic / openai（存储遗留名，改键需迁移） |
| AgentEvent.kind | EventKind | 事件种类（见上） |
| chat-utils diff 行 kind | DiffLineClass | diff-added / diff-removed 等 UI 样式类 |
| LSP CompletionItemKind | （外来词） | 第三方 LSP 枚举，不进入本项目词汇 |

---

## Language — 界面构件（Surface 簇）

> **本簇是「你和用户对得上词」的翻译层**：用户嘴里的雅称 → 一句定义 → **代码落点**。
> 前五簇是**数据语言**（英文标识符 + 中文展示词），本簇是**界面语言**（中文雅称，代码里往往没有同名英文词，
> 所以每条给 `落点:` 文件路径，一律相对 `src-ui/src/`）。**落点由 `npm run doc-check` 校验存在性**——
> 移动/删除落点文件必须同改本行，否则门禁红。
> 取词纪律：只收**用户会说 / 界面上看得见**的词；纯视觉细节不立条目（指到 `docs/design/lantai-design-spec.md` 章节即可）。
> 退役词也要收（见末节）——用户仍会说旧词，agent 必须知道它没了、去了哪，而不是去代码里找一个已删的东西。

### 纸面与版式

**纸壳**:
主界面本体——一张可缩放的纸桌，桌上一纸多卷（每卷摊开一张流区纸）。
落点: `plugins/builtin/paper-shell/PaperPanel.tsx`
_Avoid_: 画布（那只指无限空间那一层，不是整个主界面）、canvas、工作台

**流区**（纸）:
画布上一卷正文所占的那张纸（`.pp-region`）。材质是「真纸」：按卷 id 哈希出纸性，带物理包边与接触落影。
落点: `plugins/builtin/paper-shell/sheet.ts`
_Avoid_: 面板、卡片、region（当指视觉上的纸时）

**版心**:
流区里正文的居中栏宽 = 流区宽的一半（「墨占纸半」）。卷首四行、规线、版口钮都对齐它。
落点: `plugins/builtin/paper-shell/measure.ts`
_Avoid_: 内容宽、max-width、container

**界栏**:
正文列左右各 1px 的栏线（`--rule-strong`），页边注在左栏外。
落点: `plugins/builtin/paper-shell/paper-base.css`
_Avoid_: 边框、border、分割线

**正文**（答）:
助手回复的主体文字，居中的「经文」位（17px 起、行距 2.0）。
落点: `plugins/builtin/paper-renderers/renderers.tsx`
_Avoid_: 回复、answer、消息体

**来文**（问）:
用户消息，人的批注位：手迹色 16px + 左侧 2px 朱批线。
落点: `plugins/builtin/paper-renderers/renderers.tsx`
_Avoid_: 用户消息、提问、user message、气泡

**夹注**（思）:
模型的推理过程（reasoning）：缩进 86% 宽、石墨铅笔、小一号、虚线勾边。
落点: `plugins/builtin/paper-renderers/renderers.tsx`
_Avoid_: 思考、思维链、thinking、reasoning（当指界面块时）

**脚注**（器）:
工具调用与结果：贴底小字，上方一道 44px 石青注线引出。
落点: `plugins/builtin/paper-renderers/renderers.tsx`
_Avoid_: 工具卡、tool call、函数调用

**抄录**（码）:
代码块，栏内图版形态（3px 硬左线 + 上下规线 + 米黄底）。
落点: `plugins/builtin/paper-renderers/renderers.tsx`
_Avoid_: 代码块、code block

**卷首**（folio head）:
一卷开头那四行——玉徽 / 眉行 / 题字 / 档行，同轴居中于版心（版心天头）。
落点: `plugins/builtin/paper-shell/paper-folio.css`
_Avoid_: 标题栏、页头、header

**玉徽**:
卷首第一行的亭台图标（`#icon-lantai`，26px）。品牌徽记，不表意。
_Avoid_: logo、图标、icon

**眉行**:
卷首第二行的机读行：有名卷显示卷次「案卷 Nº 12」，无名卷退为「兰台 · 案卷」。
_Avoid_: 副标题、subtitle

**题字**:
卷首第三行的卷名大字（36px / 字重 700）。无名卷兜底显示「案卷 N」。
_Avoid_: 标题、title、heading

**档行**:
卷首第四行的机读注记：立卷日 + 块数。
落点: `plugins/builtin/paper-shell/folio-date.ts`
_Avoid_: 元信息、meta、页脚

**印章**（蘭臺）:
朱砂「蘭臺」二字竖排印，品牌签名（`.sh-seal`）。
_Avoid_: logo、水印、watermark

**划词**:
在纸上选中文字后落下的手写朱笔下划线（同选区恒同线）。不是浏览器的蓝底选中。
落点: `plugins/builtin/paper-shell/sel-ink.ts`
_Avoid_: 选中、selection 高亮、高亮

**选中浮钮**:
划词后浮出的动作钮（抽纸条等入口）。
落点: `plugins/builtin/paper-shell/selection.ts`
_Avoid_: 工具条、toolbar、浮动菜单

**物理包边**:
流区纸缘的四层 box-shadow（受光缘 / 背光缘 / 裱边带 / 接触落影）——用材料表达纸的四至，不是画框。
_Avoid_: 边框、border、阴影、shadow

### 卷与案卷

**案卷**:
一次持久化对话的界面词（数据侧叫 Session）。侧栏里的一行、画布上的一张纸都是它。
落点: `app/chat/session/session-registry.ts`
_Avoid_: 会话（数据层用词，界面一律说案卷）、聊天、对话、thread

**卷**:
案卷的同义简称。「摊开一卷」= 把一案卷展开成纸。
_Avoid_: 页、tab、窗口

**档号**:
案卷的编号（「案卷 Nº 12」）。无名卷的显示兜底一律取档号。
_Avoid_: id、序号、编号

**卷名**:
用户给案卷起的名字（卷快照 `label`，空 = 未命名）。
落点: `state/volume-name.ts`
_Avoid_: 标题、title、名字

**待题纸**:
点「＋ 另起一卷」在画布上落的一张会打字的纸；题签 → 首句发送才发号建卷，纸就地长成卷。
落点: `plugins/builtin/paper-shell/draft-sheet.ts`
_Avoid_: 新会话、空白页、草稿、draft

**摊开**:
把案卷放上画布展开成纸（侧栏行点击 = 摊开并定位）。
_Avoid_: 打开、open、展开、加载

**合卷**:
把卷从画布上收起（侧栏 `C` 键）。归档语义，不删除。
_Avoid_: 关闭、close、归档

**活跃卷**:
当前正在读的那一卷。整屏至多一处红——卷首左缘朱砂短横在哪卷，哪卷就是活跃卷。
_Avoid_: 当前会话、active、焦点

**另起一卷**:
新建案卷的唯一主动作（墨底实色 + 硬偏移投影，本屏唯一）。
_Avoid_: 新建会话、新对话、new

### 钉住与摘录

**钉住**:
把流里的一块内容钉到桌面上——脱离流水、成为公共物，不再随正文滚动。
落点: `plugins/builtin/paper-shell/use-paper-strips.ts`
_Avoid_: 收藏、pin、固定、置顶

**洞**:
钉住块原来在流里的位置留下的标记。
_Avoid_: 占位、placeholder、锚

**文类签**:
钉住块页边的分类标签（页边注）。
_Avoid_: 标签、tag、badge

**出处行**:
钉住块页边注第三行「摘自 卷名 · 状态字」，常显，用于溯源。
_Avoid_: 来源、source、引用信息

**引线**:
hover 钉块时，从钉缘引到洞缘的一丝手绘朱笔。
落点: `plugins/builtin/paper-shell/provenance.ts`
_Avoid_: 连接线、connection、连线

**抽纸条**:
把流里的选区拖出成一张纸条。唯二入口 = 按住已有选区拖出 + 选中浮钮。
落点: `plugins/builtin/paper-shell/quote-drop.ts`
_Avoid_: 引用、复制、quote、拖拽

**纸条**:
抽出来的那张便条（可移动、可钉、两击销毁）。
_Avoid_: 便签、卡片、card、便条

**眉批**:
浮在纸面的一次性提示批注（如历史导航提示，6s 自散）。
_Avoid_: 提示、tip、toast、气泡

**溯源**:
点出处行 → 飞到源洞 + 洞点名一拍。
_Avoid_: 定位、跳转、jump


### 创作坞

**创作坞**（坞）:
这一卷的输入面，纸上的案头。**只属于有卷的画布**——零摊开卷时整只不渲染。
落点: `plugins/builtin/compose-dock/ComposerDock.tsx`
_Avoid_: 输入框、聊天框、composer dock、底部输入条、输入栏

**匣**:
创作坞的**实体框体**——设计规格说坞内方位时全以它作参照：「匣顶」（坞上缘）、「匣脚」（坞下缘）、
「匣下」（图版架挂的位置）、「匣脚引线」（多会话卷的激活态：从卷底边引到匣顶的那条朱线）。
「坞」是这块输入面的总称，「匣」是它的框。落点同创作坞。
_Avoid_: 面板、容器、弹窗、框

**书眉**（坞的书眉行）:
创作坞的**第一行**：左端卷名，右端翰/律/后台卷指示。注意——画布视图的书眉（旧标题栏）已退役，
坞的书眉行仍在，两者不是一回事。
落点: `plugins/builtin/compose-dock/composer-header.tsx`
_Avoid_: 标题栏、顶栏、header（当指画布旧标题栏时）

**三行制**:
创作坞的排布：书眉行（卷名）恒居顶 / 输入行居中 / 设置行（模型·权限·思考）垫底。
落点: `plugins/builtin/compose-dock/composer-rows.tsx`
_Avoid_: 布局、layout、栅格

**拟文**:
**发送动作**。发送钮是一枚墨色实心方章（`.pp-send`），hover 翻朱砂——人 = 朱砂，发送是用户的动作。
用户说「发不出去 / 拟不了文」= 发送链路问题。
落点: `plugins/builtin/compose-dock/surface/use-composer-send.ts`
_Avoid_: 发送、send、提交、回车、submit

**停**:
运行中且输入框为空时，同一枚钮翻成朱印（`.pp-stop`）：中止当前回合。
落点: `plugins/builtin/compose-dock/composer-rows.tsx`
_Avoid_: 取消、停止、cancel、abort、中断

**翰**:
命令面板 / 全局面板的旧入口钮。现入口 = `Ctrl+K` 全局搜索（翰钮 2026-11-09 已撤）。
落点: `app/CommandPalette.tsx`
_退役_: 翰钮（2026-11-09 撤出书眉 → 抽屉 → 2026-11-28 「案」抽屉整只退役，入口只剩 Ctrl+K）

**律**:
快捷键总览。原为坞内 13 行键位册，2026-11-28 变成**应用级帮助页**（`app/HelpSheet.tsx`），
入口 = 全局搜索 / `runAction('shortcuts')`。
落点: `app/HelpSheet.tsx`
_Avoid_: 快捷键、keymap、键盘帮助、键位

**役**:
坞内的**后台工作监视装置**：子代理与后台命令的实时清单（在役 / 已了）。
落点: `plugins/builtin/compose-dock/WorkLedger.tsx`
_Avoid_: 任务列表、后台任务、jobs、进程列表

**墨**（墨量册）:
坞内的 **token 计量装置**：读出本卷占用与构成。触发器 = 书眉「墨 NN%」。
落点: `plugins/builtin/compose-dock/InkLedger.tsx`
_Avoid_: token 统计、用量、usage、额度

**引**:
工作区文件的模糊引用入口（输「引」→ 搜索文件 → 夹签入卷）。
落点: `plugins/builtin/compose-dock/composer-rows.tsx`
_Avoid_: 附件、attach、@文件、文件引用

**夹**:
文件选择器（file picker）的兜底入口。
落点: `plugins/builtin/compose-dock/composer-rows.tsx`
_Avoid_: 上传、open file、浏览

**图版架**:
创作坞下缘外侧那排资产架（「匣下横架」，880×38），收纳图版资产。钉住的资产一律离架。
落点: `plugins/builtin/compose-dock/AssetRack.tsx`
_Avoid_: 图片栏、assets、资产列表、附件区

**目次条**:
坞内的窄条目次带（TocStrip）。
落点: `plugins/builtin/compose-dock/TocStrip.tsx`
_Avoid_: 目录、toc、大纲

**组合芯片**:
卷首上显示本卷组合名的芯片：空白卷可拨，跑过一轮 = 只读标签。
落点: `plugins/builtin/paper-shell/FolioCompositionChip.tsx`
_Avoid_: 标签、badge、preset 选择器、combo

### 侧栏与书脊

**案卷侧边栏**:
左缘的案卷列表（240–420px 可拖宽）。与书脊列**互斥**：左缘任一时刻只留一个。
落点: `plugins/builtin/canvas-nav/SessionSidebar.tsx`
_Avoid_: 会话列表、sidebar、左边栏、导航栏

**书脊列**:
侧边栏的**收起态**：一列竖着的脊块，形如书架上的书脊。
落点: `plugins/builtin/canvas-nav/SpineRack.tsx`
_Avoid_: 缩略栏、小列表、mini 侧栏

**书脊**:
书脊列里的一枚脊块（一个案卷）。活跃卷整脊（3–6 行），其余出 32px **书口**。
_Avoid_: 行、item、缩略图、条目

**书口**:
非活跃脊块的窄形态（32px 一条）。写题名不写编号（用户口径：「编号写了跟没写一样」）。
_Avoid_: 折叠行、collapsed、折叠态

**题签**:
贴在脊身上的一枚亮纸标签（39px 宽，写卷名）。
_Avoid_: 标签、label、badge

**函套**:
书脊列的底板（`.sr-rack`），与侧栏同色——两态是**同一块板换宽度**，不是两个东西。
_Avoid_: 背景、container、底板

**整理模式**:
侧栏的批量删除模式（书眉「整理」进入，整栏换装，删除所选两击确认）。
_Avoid_: 多选、批量、选择模式、delete mode

**分桶**:
侧栏已合卷的分组：今天 / 7 天内 / 更早（更早默认收起 = 归档语义）。
_Avoid_: 分组、group、分区、分类

### 导航与浮件

**目次带**:
右缘那条 104px 的导航带 = 控制列 64 + 缘滚跑道 40。
落点: `plugins/builtin/paper-shell/paper-toc.css`
_Avoid_: 滚动条、scrollbar、minimap、右侧栏

**刻痕**:
目次带上的语义刻痕（tool / plan / error 与无阶段单元），**装饰层、不可点**。
_Avoid_: 标记、marker、刻度

**阶段锚**:
目次带上**唯一可点**的朱砂横规——点到该阶段首块。
_Avoid_: 锚点、anchor、书签

**识别层**:
目次带里的墨迹缩略（canvas），携带形状 / 族色 / 墨量 / 错旗四个通道。
落点: `plugins/builtin/compose-dock/toc-ink.ts`（design-spec 里写的 `paper/toc-ink.ts` 是旧位，已搬家）
_Avoid_: 缩略图、thumbnail、预览

**缘滚跑道**:
目次带右 40px 那条**惰性跑道**——它让「贴屏最右照旧缘滚」与「带内可点件」不互相误触。
_Avoid_: 感应区、热区、空白区

**边缘滚动**（缘滚）:
指针甩到屏缘即平移/缩放画布的手势。四缘对称（浮件占位那段 x 区间除外）。
落点: `plugins/builtin/paper-shell/edge-scroll.ts`
_Avoid_: 自动滚动、auto scroll、滚屏、拖屏

**顶部浮件**:
右上角那枚浮件（画布抓手 + 缩放 + 状态字 + 设置 + 回首页 + 窗口钮）。
2026-09-17 标题栏拆除后由书眉变来。
落点: `plugins/builtin/paper-shell/paper-panel-parts.tsx`
_Avoid_: 标题栏、titlebar、顶栏、header

**状态字**:
浮件里的运行状态短句（StatusLine）。
落点: `plugins/builtin/paper-shell/StatusLine.tsx`
_Avoid_: 状态栏、status bar、进度条

**小地图**:
画布角落的缩略总览，可拖动定位。
落点: `plugins/builtin/paper-minimap/MinimapView.tsx`
_Avoid_: minimap、缩略图、导航图

**首页**:
案卷的入口页（SessionsHome）。
落点: `plugins/builtin/sessions-home/SessionsHome.tsx`
_Avoid_: 主页、home page、启动页

### 视觉法则（改视觉必读，细则在 design-spec）

**浸墨法则**:
全局视觉立宪（2026-08-31）。同内容同栅格，只改墨量即换血。五法则 = 墨阶锚点 / 字重极端 / 句读点朱 / 纸层次 / 完工动作。
落点: `app/tokens.css`
_Avoid_: 设计规范、style guide、主题

**墨阶锚点**:
重墨全产品**只许三处**：页缘版框 / 每屏唯一主动作 / 屏级分区线。余处禁 2px 硬线。
落点: `app/tokens.css`
_Avoid_: 主色调、primary color

**字重极端**:
四级字重（900 / 700 / 600 / 400），四级之外禁盘（500 为违例已清零）。
落点: `app/tokens.css`
_Avoid_: 字重、font-weight、粗细

**句读点朱**:
题字句号落朱砂——古籍句读遗意，**每屏至多一处红字**。
落点: `app/tokens.css`
_Avoid_: 强调色、accent、红色

**纸层次**:
纸从「底色」变「材料」：纹理 / 光照 / 帘纹 / 物理包边。纹理必须**随纸走**，视口固定的纹理是「不动之纹」。
_Avoid_: 背景、background、纹理图

**层次法**:
三轴模型（海拔 / 选中 / 变形）。判「这东西归哪一档」用它。
落点: `plugins/builtin/paper-shell/paper-base.css`
_Avoid_: 层级、z-index、阴影层级

**动效法**:
动效的纸感烈度（用户拍板「乙 · 纸感」）。快起慢收、退场对称。
落点: `plugins/builtin/paper-shell/paper-motion.css`
_Avoid_: 动画、animation、过渡

**悬停提示**（tooltip）:
悬停提示的纸片形态（用户拍板「甲 · 纸片」）。
落点: `app/interaction/`
_Avoid_: 气泡、tooltip 样式、浮层

### 退役词（用户仍可能说——agent 别再去找它们）

> 这些词曾是一等公民，已被拆掉。用户说它们时，**先按本表解释「已退役 / 去哪了」，不要 grep 代码找实现**。

| 退役词 | 退役日 | 现状 / 去处 |
|---|---|---|
| 案头态（`pp-at-desk`） | 2026-11-28 | 第二条建卷路径，与「＋ 另起一卷」重复 ⇒ 整只退役。出生面唯一 = **待题纸** |
| 「案」抽屉 | 2026-11-28 | 整只退役。组合 → 卷首芯片 / 纸上题签；图版 → 坞下那排架；翰 → Ctrl+K；律 → `app/HelpSheet.tsx` |
| 翰钮（坞内） | 2026-11-09 | 撤出书眉 → 抽屉 → 随「案」抽屉退役。入口只剩 `Ctrl+K` |
| 画布书眉 / 标题栏（`--bar-h`） | 2026-09-17 | 布局行整条退役 ⇒ **顶部浮件**；画布顶缘 = 屏缘（四缘感应带对称） |
| 墨线（坞底 2px） | 2026-11-08 | 与书眉「墨 NN%」同源同判据、重复画两遍 ⇒ 整条删除；近满态抬到触发器本体 |
| 界栏双线框 / 流区四边版框 | 2026-09-02 | 翻案：「版框是印在纸上的墨」，流区这张「叶」不印框 ⇒ 改**物理包边** |
| 竖排「钉住」签 | 2026-09-19 | 钉住是常驻状态、不该靠 hover 才现身 ⇒ 身份改常显方墨点 |
| 贴底输入条 | 2026-08-31 | 升格为**创作坞**（案头） |
| 信号源 | 2026-08-24 | ⇒ **提供方**（对齐 DSH 官方中文定译） |
| 星图 / 依赖图 | — | 退役，不再作为用户可见卖点 |
| 工作台 | 2026-08-22 | ⇒ **兰台** |

