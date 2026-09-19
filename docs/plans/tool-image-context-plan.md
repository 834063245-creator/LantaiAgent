# 工具附图通道（agent 眼睛环 P0）

> **状态：P0a 代码已落地（2026-09-17）· 2026-09-18 加固批（按路径读图 + 请求期能力戳修复）·
> 2026-09-19 第三断点修复（读盘腰漏接线——§0c，最终根因）·
> 真机验收待跑（owner：用户；需重打包后生效）**
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

## 0b. 2026-09-18 加固批：按路径读图 + 请求期能力戳修复

**由来**：用户实测「视觉模型收不到图」——工具截图落盘成功、引用也挂上了，但请求期被
投影成「图已省略」占位。两层病灶，同批修复：

| 面 | 病灶 / 改动 | 文件 |
|---|---|---|
| **能力戳断线（根因）** | 能力戳只打在内层实例（`createProvider`，随 `stream()` 用完即弃），Agent 持的 live 外壳不暴露该属性 ⇒ `supportsImage` 恒 false ⇒ **一切附图（用户附图 + 工具截图）从多模态线落地（2026-09-09）起就没送出去过**。修 = 外壳补 `inputModalities` 活读 getter（会话覆盖 ?? 行值 → `modelInput` 四层链，请求期现读） | `src-ui/src/provider/live.ts`；回归钉 `tests/provider-live.test.ts`「附图能力戳」组（修前红） |
| **按路径读图（新能力）** | `fs(read)` 一张图片 → 此前 UTF-8 解码失败（二进制读不进来）。修 = Rust 侧字节嗅探（png/jpeg/webp/gif，不信任扩展名）→ 命中则转存内容寻址附件 + 输出附图信封（形态与 browser 截图口一致）；TS 侧 `fs(read)` 声明 `imageChannel`、包装层（`[file:]` 尾缀 / 状态前缀）对信封放行 | `src-tauri/src/image_probe.rs`（嗅探）、`src-tauri/src/attachments.rs`（落盘单一权威，browser 截图口同批换用）、`src-tauri/src/confined_fs.rs`（`read_cap`）、`src-tauri/src/commands/fs_cap.rs`、`src-ui/src/agent/tools/coding.ts`、`tools/domains.ts`、`agent/hooks.ts`、`plugins/builtin/fs-builtin/index.ts` |

**接线纪律（新）**：附图信封是 executor 要 `JSON.parse` 的机器可读体——
**任何输出包装层**（fs 的 `[file:]` 焦点回显、state-read 状态前缀等）必须以
`hasImageRefs()`（`tool-images.ts` 单一判据）放行信封，否则解析失败、图静默丢。

**顺带（不属本计划）**：内置 DeepSeek 目录按官方 2026-09-10 改名刷新
（`deepseek-flash` = V4.1 Flash 全系多模态入目录；出厂默认与模板默认同步；
`guessReasoningFromId` 补 `deepseek-flash` 词）。

**验收**：见 §5 真机项；重打包后 ①贴图/拖图发给声明视觉的模型；②工具截图；
③`fs(read)` 一张图片（三入口同一判据：图进 wire 而非占位文本）。

## 0c. 2026-09-19 第三断点：读盘腰漏接线（**最终根因**，§0b 的修复单独不够）

**由来**：用户重打包后复验「贴图 → 模型仍说看不到」（exe 21:39 构建、21:41 启动、
21:52 实测），且这次**连「图已省略」占位都没有**——与 §0b 修复前的症状（占位在）
不同，说明能力戳已生效、断点挪到了别处。

**实测证据（真机存档 + 日志，非推断）**
- 会话卷 `.lantai/sessions/17.ndjson`：用户消息带 `images`（`b1cc7fee…` 268 878 B PNG
  114×1182），`fs(read)` 同一附件的工具结果也带 `images` ⇒ **会话层与工具层都挂上了**。
- 同一轮 `llm response` 的 token 账（`.lantai/logs/ui.log`）：`prompt_tokens` 22174 /
  `cache_hit` 22016 / `cache_miss` 158，与当日**纯文本**首轮基线（miss = 145 + 用户
  文本 token 数：153/162/163/195/205 五组）严丝合缝 ⇒ **出站请求里既没有图 token
  也没有占位文本**——图在客户端就没进 wire（不是网关丢图）。
- `provider-live.test.ts` 的「Agent + live 壳 → wire 真带图」用例是绿的：它走
  `createTestAgent`（直接构造 Agent + 假 reader），**恰好绕开本层翻译**。

**根因**：`AgentRuntime._contextFromConfig`（`runtime/runtime.ts`）把 `AgentConfig`
逐键搬进 `AgentAssemblyInputs` 时**漏搬 `imageReader`**。B3（2026-09-09）给两端都加了
这根腰——workspace 传 `config.imageReader`、`_assembleAgent` 读 `inputs.imageReader`——
唯独中间这层白名单没有它，且字段可选 ⇒ TS 不报错 ⇒ Agent 持 `_imageReader = null` ⇒
请求期「有图 + 声明支持图 + 无读取通道」走了旧代码的静默分支：图不进 wire、不留占位、
不落日志。**用户附图 / 工具截图 / `fs(read)` 图片从 B3 落地起一张都没到过模型**
（与 §0b 记忆「多模态线从第一天起就没送出过任何一张图」同一事实，两处独立断点串联）。

**修复（同批三条）**
| 面 | 改动 | 文件 |
|---|---|---|
| 根因 | 翻译层补搬 `imageReader` | `src-ui/src/agent/runtime/runtime.ts` |
| 防复发 | 翻译层改 `satisfies { [K in keyof Required<AgentAssemblyInputs>]: … }`——**新增装配输入键而未在此搬运 = 编译错误**（实测：删键即 TS1360） | 同上 |
| 错误不静默 | 送不出去必须留痕：无读取通道 / 读盘全失败 → `log.error`/`log.warn` + `projectImagesUnsent` 占位（部分失败只落日志） | `src-ui/src/agent/agent.ts`、`agent/request-images.ts` |

**回归钉**：`tests/image-chain-production.test.ts`（新，5 例）——**生产镜像**：
真 `settings` 行（视觉覆盖）→ `createLiveProvider` 壳 → `AgentRuntime.createAgent`
（真翻译层）→ 真 `readAttachmentBase64` + `fs_cap` RPC 桩 → openai adapter → 断言
出站 body 里 `image_url` data URI。修前红在「reader 从未被调用 / body 无图」两条，
修后全绿；另两例钉「无读盘腰 / 读盘全失败 → wire 上必须有占位」。

**教训（测试面）**：三次断点同型——**两个各测各的层之间那一跳没人测**
（2026-09-11 `handle.run` 漏 images 第三参；2026-09-18 live 壳缺能力戳；
2026-09-19 翻译层漏搬 imageReader）。凡「装配面搬运字段」处，要么有编译期护栏，
要么有一条**从设置行到出站 body**的镜像用例，别再用分层用例的绿色代表链路通。

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

### 5.0 判定标准：没有视觉模型也要能闭环（2026-09-17 用户裁定前提）

兰台**不跑视觉模型**（用户 2026-09-17：「就当没有跑任何视觉模型就行」）⇒ 视觉改动
不许依赖「谁的眼睛」，一律落成**可复算读数**。两把尺：

| 尺 | 载体 | 管什么 |
|---|---|---|
| 几何断言 | `tests/chart-geometry.test.ts`（box 定比例组）+ 各原语的纯几何函数 | 宽高是否由版心定、字号是否随数据漂移、标签是否溢出、档位与 token 是否同源 |
| 像素/墨迹读数 | `scripts/visual-probe.ps1 <html>`（headless Edge → 逐带墨迹区间 + ASCII 墨迹图 + **空白带**） | 「声明存在却从未画出来」这类**渲染层**病灶：该有线的位置零墨点即实据（49 处规线就是这么抓到的） |

纪律：改视觉 → 先跑尺拿 before/after 读数 → 读数进 NOTES/设计件；用户只在**真机真卡**上做终审，
不再评审样板页（样板评审这条路 2026-08 已触发过一次止损条款）。

**自动化（本批门禁）**
- `tests/tool-image-channel.test.ts`：能力位门控（非 imageChannel 工具零影响）/ 解析真源（畸形输出 → 空引用不炸）/
  引用挂到 tool 消息 / 文本模型降级占位 / 预算计入工具附图；
- `tests/request-images.test.ts` 扩：非 user 角色带图的收集、预算、投影（既有 20 例须零改动——行为未变者不动）；
- 三适配器各补一例：anthropic tool_result 数组形态 / responses `function_call_output` 图项 / openai 组尾合成 user；
- **生产镜像（§0c 新增）**：`tests/image-chain-production.test.ts`——settings 行 →
  live 壳 → `AgentRuntime.createAgent` → 真读盘腰 → 出站 body 断言 `image_url`
  （分层用例的绿色不代表链路通，本文件是本链路的唯一端到端钉）；
- 无图路径回归：既有适配器 fixture 逐字节不变；
- 门禁：`npx vitest run` · `npm run build` · `npx biome ci .` · `npm run verify:convergence` · `cd src-tauri && cargo test`（截图口改动）。

**真机（owner：用户，本批代码完成后）**
1. 用**声明了 image 输入的模型**开会话 → 让它 `browser(action:"screenshot", target:"self")` → 它下一条消息能说出画面里的
   具体内容（例如某张资产卡的题名/列数）——**这是本批唯一能证明「眼睛接上了」的判据**；
2. 同一会话把模型临时标成纯文本（设置里去掉 image 声明）→ 工具结果落占位文本、请求不炸；
3. 截一张 3 类柱图的卡 → 模型能否指出「图只占了卡片左边一小块」（即它能自查出 P1 要修的缺陷）。

## 6. 下一批的机械根因（2026-09-17 实测，不需等语汇拍板）

### 6.0 B 图版签落地的进度账（box 定比例 + 题签 + 信息面）

| 原语 / 面 | 状态 | 关键改动（commit） |
|---|---|---|
| chart 盒定比例 | ✅ | viewBox 宽 = 版心宽（用户单位 == CSS px）；高按类目数三档；柱宽由槽宽反推；散点独立坐标系退役；4 个死 token 清除（`d6c28d80`） |
| graph / tree | ✅ | viewBox 宽 = 版心宽；列宽由版心反推；**节点框宽由标签实测宽定**（截断 + 全名进 `<title>`）；图高只随行数；graph 组 5 个死 token 清除（`ae83ca53`） |
| 图版题签行 | ✅ | `plateSignOf(kind)` 物类签 + `PlateHead`；接入 grid 两表体与 metric；签走 mono + 极弱线框 + 石青；规线走 `--rule-soft-ink` 颜色位（有测试钉住不得回退成拼坏的简写）（`789043fd`） |
| 题签恒在 | ✅ | 无题名也出签；题签行**严格高度中性**（下内距 = captionMarginB − 规线 − gapBelow ⇒ 文本下总间距不变，修正上一批 1px 漂移）；`ASSET_DERIVED.plateHeadH` 承载测高；两个死 caption 常量删除（`114c1e87`） |
| chart 信息面 | ✅ | schema 增可选 `unit` / `source`；渲染挂在既有类型行内（零测高改动）；口径用石青；旧 payload markup 零漂移（`67f2dbc1`） |
| metric 信息面（compare） | ✅ | schema 增可选 `compare`（一个字符串承载「与谁比/目标/阈值」）；渲染在数值同行右侧（石青小字 + nowrap）⇒ 零测高；卡片加 `overflow:hidden` 防自由文本溢到邻卡（`9d170356`） |
| grid 信息面（emphasis） | ✅ | 可选 `emphasis.rows`（0-based）：重点行出石青左条 + 极淡洗底；两个表体都接；纯样式 ⇒ 零测高（`dcfa14b1`） |
| board / timeline 题签 | ✅ | 签「板」/「序」，题名可选（schema 各增可选 caption）；测高 +plateHeadH（fba6b4d） |
| citation / chem / media / html 题签 | ✅ | 签「引/式/图/页」；四个镜像 +plateHeadH ⇒ **十二原语题签铺满**（`47546a56`） |
| D 墨阶分层 | ⬜ | 重墨-中墨-淡墨三级主次（弱数据卡的轻/重问题） |
| P0b（BCR 批） | 📋 **申请书已提交待放行** | 只拆 `browser_screenshot` 的 `inline` data-URL 上下文炸弹（3MB base64 ≈ 百万 token）；元素级截图与描述改写**冻结**（无视觉模型买了没用）。资产 kind 的 payload 扩展**不经 BCR**（运行时经 list_block_kinds 暴露，不动 tool-schemas 基线——`67f2dbc1` 已证） |

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

## 8. 真机判定单（用户侧最小判定面，2026-09-17）

> **为什么是判定单而不是样板页**：本仓库的样板评审走过一次并触发止损条款（2026-08-22 生成到
> 第十一张变体、用户视觉疲劳）；有效的判定历来发生在**真机、真内容**下。兰台不跑视觉模型
> ⇒ 判定分两层：**可测量的部分由 agent 用 `scripts/visual-probe.ps1` 自闭环**，你只需要看三张
> 真卡并回答三个**信息面**问题（不是审美题）。

### 判定 1 · 一张有题名的表

- 怎么造：让 agent `show_asset` 一个 `table`（8 列左右、带 `caption`）。
- 看什么（机械）：题签行应在场——`表` 签 + 题名，其下**一条极弱规线**。
  这条线在 2026-09-17 之前**从未画出来过**（`--rule-soft` 整条简写被拼坏，全仓 49 处）；
  若你在别的卡上也看到「该有线却没有」，把那张卡的样子告诉我，我用尺量。
- 一句话问题：**这张表你第一眼要读到什么？**（最小的那一句，比如「哪一行最贵」）

### 判定 2 · 一张三类的柱图（带单位与来源）

- 怎么造：让 agent `show_asset` 一个 `chart`：`{type:"bar", data:{labels:[…3项], values:[…]}, unit:"次", source:"…"}`。
- 看什么（机械）：图应**铺满版心**（此前 3 类柱图被缩成约 213px 居中、两侧各空 253px）；
  类型行应显示 `bar · 单位 次 · 来源 …`；三条柱应明显比 20 类图的柱更宽。
- 一句话问题：**「单位 + 来源」这两项够你判断这张图能不能信吗？**（不够的话还缺什么）

### 判定 3 · 一张含长路径标签的依赖图

- 怎么造：让 agent 用 `deps_impact` 出一张图，节点里带一条长路径（如
  `src/app/chat/session-composition.ts#createSessionWithPreset`）。
- 看什么（机械）：节点框应**随标签长短收放**（不再恒 72px 宽）、长标签以 `…` 截断、
  悬停能看到全名；同一张图里字号应恒定（不再被 viewBox 缩放）。
- 一句话问题：**截断到几个汉字你还认得出这是哪个模块？**（我据此调截断策略）

### 若发现「该有墨却零墨」

跑这一条，把输出贴给我即可（无需你判断原因）：

```powershell
pwsh -File scripts/visual-probe.ps1 -Html <出问题的页面或原型> -Width 780 -Height 1200
```

读数里出现「空白带 y：…」，或某卡片宽 720 而墨迹段只有 ~213，就是病灶所在——
agent 没有视觉模型也能据此定位并修（这正是 49 处规线与 letterbox 被找出来的方式）。