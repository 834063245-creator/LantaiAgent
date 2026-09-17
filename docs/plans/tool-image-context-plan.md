# 工具附图通道（agent 眼睛环 P0）

> **状态：P0a 代码已落地（2026-09-17）· 真机验收待跑（owner：用户）**
> 一句话：把「工具产出的截图」接进模型可见的附图通道——模型从此能看见自己的产出（资产卡、界面、窗口），
> 而不是把 PNG 路径交给用户求人看图。
>
> 由来：用户 2026-09-17 判「所有 kind 资产生成视觉上都没好好做，像赶工」「agent 用这些工具也不稳定」。
> 诊断结论：视觉与稳定性各自的**结构性**成因之外，还有一条共用断点——**模型看不见自己的产出**。
> 该断点早在 `docs/plans/paper-shell/taste-ledger.md`（2026-08-22）就被点名为「结构性瓶颈」：
> 「本会话模型无图片输入，agent 看不见自己的产出，眼判类细化只能靠用户眼睛逐轮喂——最便宜的解锁是
> vision 会话做自检循环」。当时条件不具备（无自截图通道、无附图通道）；**2026-09-17 两半都已在位**，
> 只差最后一段接线。

## 0. P0a 落地清单（代码面已毕）

| 面 | 改动 | 文件 |
|---|---|---|
| Rust 口 | 截图转存工作区**内容寻址附件** + 输出加 `image` 引用（`{id,mediaType,bytes,width,height,name}`）与 `attachment`/`imageNote` | `src-tauri/src/commands/browser_cap.rs`（`attach_screenshot_ref` / `png_dim`）、`cdp/session.rs`（`shot_dir` 单一真源）、`Cargo.toml`（`sha2`，与 lock 既有传递依赖同版） |
| 通道旗标 | `Tool.imageChannel` + `defineTool` 透传；`browser_screenshot` 声明 | `src/agent/tool.ts`、`tools/define-tool.ts`、`tools/browser.ts` |
| 解析真源 | `parseToolImageOutput`（`image`/`images` 两形态；sha256 hex + 媒型白名单 + 正整数校验；畸形逐条丢弃不抛） | `src/agent/tool-images.ts` |
| 挂载 | executor 取**截断前**原文解析；旗标按 `guardName` 归实现工具（域门面路径同效）→ `PendingResult.images` → 两处 `tool/result` 消息带 `images` | `src/agent/streaming-executor.ts`、`agent-loop/default-loop.ts` |
| 角色扩档 | `Message.images` 合法角色 = user **+ tool**（事件形状零变更：`tool/result` 存整个 Message） | `src/provider/types.ts` |
| 请求期 | 收集/预算/文本模型投影对 tool 角色与 user 同口径（共用一份请求级预算） | `src/agent/request-images.ts` |
| 三协议 wire | anthropic `tool_result.content` 数组 `[text,image]`；responses `function_call_output.output` 数组 `[input_text,input_image]`；openai chat **tool 组尾**补一条合成 user 消息（tool role 不收图） | `provider/anthropic.ts`、`provider/responses.ts`、`provider/openai.ts` |

**批内已知边界（有意不做，非遗漏）**：
- 嵌套分发（`code_execution` 内调工具）**不挂图**——嵌套结果不回 `tool/result` 消息，图无处可挂；
  要接需让 code_execution 的工具结果承载子调用图（P0c 候选）。
- 桌面截图族（`desktop_screenshot` / `desktop_uia_window_shot`）未接：它们的 PNG 仍落临时目录、
  不产附件。全屏截图是高隐私动作，接图 = 每次把整屏像素送进上下文，须单独裁定（P0b）。

## 1. 现状断点（实测证据，非推断）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 应用以 `--remote-debugging-port=9222` 起 WebView2，模型侧有**只读自截图** `browser(action:"screenshot", target:"self")` | `src-tauri/tauri.conf.json:22`、`src-tauri/src/cdp/session.rs:27`、`src-ui/src/agent/tools/domains.ts:370` |
| 2 | 截图落到**系统临时目录**，返回 `{path, bytes}`；`inline:true` 时额外回一个 **PNG data URL** | `src-tauri/src/cdp/actions.rs:1971-2019`、`src-ui/src/agent/tools/browser.ts:198-201,313-314` |
| 3 | 附图（图片）只挂 **user 消息**：`Message.images` 注释写明「仅 user 角色携带」；`collectImageRefs` 只走 user 消息；三个适配器都只在 `m.role==='user'` 时展开图 | `src-ui/src/provider/types.ts:49-53`、`src-ui/src/agent/request-images.ts:35-43`、`anthropic.ts:258-273`、`openai.ts:267-280`、`responses.ts:244-253` |
| 4 | ⇒ **工具产出的图片永远进不了模型上下文**：`inline` 回的是 data URL 文本（模型读不出图），且上限 3MB ⇒ base64 ≈ 4MB 字符 ≈ 百万级 token 的**上下文炸弹**；不回 inline 时模型只拿到一个路径 | 同上 + `actions.rs:2007-2019` |
| 5 | 会话已有完整附图基础设施：内容寻址 `ChatImageRef`（sha256）+ 字节落 `{ws}/.lantai/attachments/{id}.{ext}` + 请求期解析成 wire + 文本模型降级占位 + 请求级预算 | `INVARIANTS.md` #14、`image-intake.ts:145-160`、`request-images.ts` |

**结论**：不是缺能力，是**缺一段接线**——工具结果没有附图通道，附图通道只认 user 角色。

## 2. 目标 / 非目标

**目标**
1. 工具可以产出「附图引用」，随工具结果进入模型上下文（字节永不进卷，沿 #14）。
2. 首个消费者 = 自截图（`browser_screenshot` target=self）与桌面窗口截图族。
3. 模型看不见图时（纯文本模型 / 无 image 声明的模型 / 协议不支持）**优雅降级**：回占位文本，不报错、不炸请求。
4. 用户可见收益：模型能自查视觉产出（P1 的图版定规之后，改卡不再必须靠用户的眼睛逐轮喂）。

**非目标（本批不做）**
- 不新增「视觉审查」专用工具或 prompt 段（先让通用通道可用，别造第二个发现面）。
- 不改资产 kind 的视觉（那是 P1 的事）。
- 不动 `desktop_screenshot` 的隐私语义（每次 Ask 照旧）。

## 3. 我的裁定（工程内部取舍，`CONVENTIONS.md` §0.5 自裁）

**裁定 1：通道形态 = 新增能力位 `imageChannel`（对齐既有 `assetChannel` 先例）。**
工具的 `execute` 仍返回字符串；输出 JSON 里带附图引用描述；executor 在 `tool.imageChannel === true` 时用**单一解析真源**
（`parseToolImageOutput`，对齐 `parseAssetEventOutput` 的位置与纪律）取出引用，挂到该次工具结果上。
理由：不发明新通信方式；工具签名零改动；解析点唯一；解析失败 = 工具异常路径（错误不静默）。

**裁定 2：字节落盘 = 由 Rust 截图口**直接**写进 `{ws}/.lantai/attachments/{sha256}.png`（内容寻址）。**
理由与证据：
- `BrowserGate` 已持有 `state: &State<WorkspaceState>`（`browser_cap.rs:37-39`）⇒ 口内能解析工作区根，无需新参。
- 走 TS 侧搬运是下策：临时目录在工作区外，Agent 通道读会撞权限闸（`resolve_read_dispatch` → `require_read`，
  `path_resolve.rs:257-269`）；用户通道读虽不过规则引擎，但仍要过沙箱 `resolve_read`，且多一次 base64 往返。
- 内容寻址命名与 #14 同义（id = 规整字节 sha256）；`sha2` 已在 `Cargo.lock`（传递依赖）⇒ 新增依赖近乎免费。
- 保留临时目录副本不再是必需（归档/排查可用 attachments 里的内容寻址文件）。

**裁定 3：`Message.images` 的合法角色从「仅 user」扩到「user | tool」。**
`tool/result` 事件存的是整个 `Message` 对象（`session-log.ts:311-314`）⇒ **事件形状零变更**；
`foldToolResults` 用 `{...m, content}` 展开（`tool-fold.ts:38-41`）⇒ 附加字段天然存活。
`INVARIANTS.md` #14 的**实质**（字节永不进卷、ref 唯一形态、请求期才解析、渲染期才读）逐条不变，
只把「哪些角色可携带引用」扩一档——本设计件即为该措辞变更的依据。

**裁定 4：三协议 wire 映射各按各自合法形态，**不做**统一抽象层。**
| 协议 | 形态 | 理由 |
|---|---|---|
| Anthropic | `tool_result.content` 由字符串改**数组** `[{type:'text'},{type:'image'}]` | 该协议原生支持 tool_result 内放图块 |
| Responses | `function_call_output.output` 数组内加 `input_image` | 同上 |
| OpenAI chat | tool 消息保持纯文本；在该轮**全部 tool 消息之后**补一条合成 `user` 消息携带图 | tool role 不收图；补在组尾最稳（避免 tool 序列中间插 user） |
无图路径**逐字节不变**（沿 multimodal D-6 纪律）。

**裁定 5：本批**不动**工具 schema/描述、不动 `inline` 参数。**
`tool-schemas.full.json` / `tool-schemas.plan.json` 冻结了 `browser*` 工具（各 12 处命中），
改参数或描述 = baseline 变更 = 走 BCR 审批（`docs/archive/agent-core-convergence/baseline-change-request.md`）。
而工具**输出**不在任何 baseline 夹具里（`hook-pipeline.trace.json` / `session-projection.trace.json` 里 browser 命中 0）
⇒ 本批（输出加键 + 内部能力位 + 角色扩档）**免 BCR**。
`inline` 的 data-URL 回退是上下文炸弹、且对新通道冗余——**留到 P0b 与 clip 参数、描述改写一并走 BCR**（破坏性拆除，不兼容保留）。

**裁定 6：预算与折叠纪律沿用既有语义，只扩角色面。**
`collectImageRefs` / `applyImageBudget` / `projectImagesForTextModel` 从「只看 user」改为「看任何带 images 的消息」，
顺序仍按消息序（最旧先弃）。工具附图与用户附图**共用同一个请求级预算**（40 张 / 24MB），不新开第二个预算面。

## 4. 批次切分

| 批 | 内容 | BCR |
|---|---|---|
| **P0a（本批，代码已落地）** | Rust 截图口产附件 + 输出带引用字段；`imageChannel` 能力位 + `parseToolImageOutput`；executor/dfloop 挂引用到 tool 消息；`Message.images` 角色扩档；三协议映射；文本模型降级；测试 | 免 |
| **P0b** | `browser_screenshot` 增元素级 `selector`（精确截某张卡）+ 描述改写（教模型「图会进上下文」）+ **拆掉 `inline` data-URL** + 桌面截图族接线（含整屏隐私裁定） | 需（用户放行） |
| **P0c（可选）** | 工具卡内联显示截图缩略（用户侧收益：不必去翻 tmp 目录）+ 嵌套分发（code_execution）承载子调用图 | 免（纯 UI/内部） |

## 5. 验收

**自动化（本批门禁）**
- `tests/tool-image-channel.test.ts`：能力位门控（非 imageChannel 工具零影响）/ 解析真源（畸形输出 → 空引用不炸）/
  引用挂到 tool 消息 / 文本模型降级占位 / 预算计入工具附图；
- `tests/request-images.test.ts` 扩：非 user 角色带图的收集、预算、投影（既有 20 例须零改动——行为未变者不动）；
- 三适配器各补一例：anthropic tool_result 数组形态 / responses `function_call_output` 图项 / openai 组尾合成 user；
- 无图路径回归：既有适配器 fixture 逐字节不变；
- 门禁：`npx vitest run` · `npm run build` · `npx biome ci .` · `npm run verify:convergence` · `cd src-tauri && cargo test`（截图口改动）。

**真机（owner：用户，本批代码完成后）**
1. 用**声明了 image 输入的模型**开会话 → 让它 `browser(action:"screenshot", target:"self")` → 它下一条消息能说出画面里的
   具体内容（例如某张资产卡的题名/列数）——**这是本批唯一能证明「眼睛接上了」的判据**；
2. 同一会话把模型临时标成纯文本（设置里去掉 image 声明）→ 工具结果落占位文本、请求不炸；
3. 截一张 3 类柱图的卡 → 模型能否指出「图只占了卡片左边一小块」（即它能自查出 P1 要修的缺陷）。

## 6. 下一批的机械根因（2026-09-17 实测，不需等语汇拍板）

**资产段落设计的规线一条都没画出来**：`tokens.css:57` 的 `--rule-soft` 是**整条 border 简写**
（`1px solid var(--ink-4)`），而 PaperPanel.css 有 17 处把它当**颜色**再拼一次
（`border-top: var(--pp-asset-board-colRule) solid var(--rule-soft)`）⇒ 值替换后成为
`2px solid 1px solid var(--ink-4)` = 非法 ⇒ 整条声明被 CSS 丢弃（含 var() 的声明在
computed-value 阶段失效即回落初始值 = 不画线）。

- 资产段落 9 处：grid 表头线 `4263`/`4291`、metric 卡框 `4468`、form 选项框 `4631`、
  board 列顶线 `4695`、board 卡框 `4705`、timeline 节点轨 `4760`、citation BibTeX 上规线 `4855`、
  chem 结构式外框 `4913`；
- 同族另 8 处在正文/夹注族：md hr `1199`、md 表行线 `1218`、md 行内码 `1240`、md 图框 `1311`、
  diff 上下规线 `1576`/`1577`、notice 上下缘 `1815`/`1828`——**正文族也中招**（用户当年判
  「正文块有层级语言」的那部分墨，有一部分其实没落地）；
- 修法（一次治一片）：tokens.css 加颜色位 `--rule-soft-c: var(--ink-4)`，17 处
  `solid var(--rule-soft)` → `solid var(--rule-soft-c)`；
  `tests/paper-visual-decisions.test.ts:822` 现钉着**带病灶的字面串**（`border: var(--pp-md-imgBorder)
  solid var(--rule-soft)`）⇒ 属本批规格变更，须同批改写（禁「改造后放回原位」）。
- 注意：`PaperPanel.css` / `tokens.css` / `paper-visual-decisions.test.ts` 三档当时**有他窗在途
  未提交改动**，动它们前先确认该窗已收工（避免互相覆盖）。

## 7. 风险与前置条件

- **前置条件（硬）**：真机验收 1 需要用户环境里有声明 `image` 输入的模型。设置面板「输入模态覆盖」
  （`settings.ts:75-78`）可手动补声明（GLM-4V / Qwen-VL 等目录外模型正为此留口）。
  **若用户只有纯文本模型，本批价值≈0**（代码仍正确，但要等换模型）——此事实在开工时即应向用户点明。
- 多模态线自身的真机验收六项**至今仍欠**（`docs/plans/README.md` 真机欠账表）⇒ 本批不得假设该通道已实机验证过，
  验收 1 同时充当多模态线的联合验收。
- 前缀缓存：工具结果里多一张引用的**元数据**（几十字节）不影响无图路径字节；有图路径本就每回合重发，属既有代价。
- 图片体积：截图是 PNG，720×N 的卡约数十~数百 KB；请求级预算（24MB/40 张）足以兜底，
  但 `browser_screenshot` 仍应默认单张、不鼓励连拍（在 P0b 的描述里写清）。
