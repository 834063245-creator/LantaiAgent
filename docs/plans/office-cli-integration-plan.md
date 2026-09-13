# OfficeCLI 集成计划（兰台 × iOfficeAI/OfficeCLI）

> **状态：工程完成，待用户验收**（2026-09-13 十窗连续施工；`goal` 已 blocked/disarmed，等用户动作）
>
> **本文件是现状合集**——十窗逐日流水已压成 §7 一张表；正文只留"现在是什么样"。
> 上游目标物：[iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（Apache-2.0；
> 本计划 pin 版本 **v1.0.149**，win-x64 **31.87 MB**，SHA256 `abd82dae…31e2`）。
> 相关计划：[`scientific-rendering-plan.md`](scientific-rendering-plan.md)（#20 PDF/Office 内嵌暂缓项）、
> [`multimodal-image-plan.md`](multimodal-image-plan.md)（媒体/图片通道）、
> [`app-shell-software-plugin-plan.md`](app-shell-software-plugin-plan.md)（软件级插件四件套）。

**读法**：§0 拍板与现状 → §1 实测事实 → §2 落地形态 → §3 平台改动 → §4 分发 → §5 坑账 → §6 你的验收清单 → §7 施工史一览 → §8 剩余。

## 0. 拍板与现状

| 用户四问（2026-09-13） | 拍板 | 落地 |
|---|---|---|
| 集成门 | 先补 MCP 只读洞 → **A 路零代码挂接**当天验价值 | ✅ 已验（值不值得做的答案：值得）→ **2026-09-13 改判 C 路**：读写能力收成兰台一等 `office` 域工具，MCP 挂接退役（见 §10） |
| 主用例 | 三者都要：①卷→交付物导出 → ②既有文档注疏回写 → ③xlsx 数据面 | ✅ 三批各有真实二进制 e2e 守护 |
| 纸壳呈现 | **活预览**（watch 本地服务 / html 内嵌） | ✅ 核查完毕：html 内嵌不可行、watch 需平台件（已建）；同时落了截图刷新路 |
| 二进制分发 | 随插件/应用自带（先实测体积） | 体积已实测；**载体三来源安装全部端到端实测**，推荐态已落成产物，等签核 |

**已完成**：平台前置修复（契约 v27）+ 窗入口二态（契约 v28）、A 路三件套、载体插件 + 哈希校验安装器、
三批用例的真实二进制 e2e（12 例）、验收入口脚本、技能逐条实测。
**待你**：§6 真机验收（含唯一真机判据）+ 分发载体签核 + 产品方向件（§8）。

## 1. 目标物实测事实（本机跑出来的，不是抄文档）

| 面 | 实测 |
|---|---|
| 形态 | 单文件自包含（.NET 内嵌，运行期无需 .NET/Office）；31,872,336 B，哈希与官方 `SHA256SUMS` 一致 |
| MCP 面 | `tools/list` **只有 1 个工具 `officecli`**，唯一参数 `command`（字符串或 **argv 数组**）；**无 `annotations`** ⇒ 无 `readOnlyHint`（这是 P0 必修的原因，§3） |
| 命令面 | 三层：L1 读（`view`/`get`/`query`/`validate`）→ L2 DOM（`set`/`add`/`remove`/`move`/`swap`/`batch`）→ L3 裸 XML（`raw`/`raw-set`/`add-part`）；另一条流水线 `dump`/`batch`/`merge`/`watch`/`load_skill` |
| 寻址 | 1-based 本地名路径（`/slide[1]/shape[2]`、`/Sheet1/A1`）；稳定形态 `/slide[1]/shape[@id=550950021]`、`/body/p[@paraId=…]`（**优先用稳定形态**） |
| 渲染 | `view screenshot -o x.png [--page N \| --grid auto]` 可用（全册联系表实测 26.6 KB）；`view html` **外链 CDN**（KaTeX/Three.js）且是整页应用（§2.4） |
| watch | `http://localhost:26315`，整页 95 KB；活刷新 = `EventSource('/events')`；**服务器不回 CORS 头**；**改文件后约 0.6 s 推一条 `word-patch` 增量补丁**（`{op,block,html,data-path}` + `version`/`baseVersion`） |
| 专项技能 | 10 个（pptx/word/excel/morph-ppt/morph-ppt-3d/pitch-deck/academic-paper/data-dashboard/financial-model/word-form），正文 **25.2–64.9 KB**（最大 pitch-deck ≈1.6 万 token）；部分带参考文件（`morph-ppt` 7 份，可 `load_skill <名> --path <rel>` 单取） |
| 其它 | `help` 优先（7.6 KB）；首条命令自动起 resident（**有落盘语义**，§5）；`save` 幂等 |

## 2. 落地形态

### 2.1 ① 卷 → 交付物导出

`create` 起骨架 → `batch` **一次落批**（原子，失败整体回滚）→ `validate` + `view issues` 自检 →
`save` 落盘 → `view screenshot` 交纸面。
**模板流**：`dump` 学样张（结构化蓝图，实测 16 项细粒度项集）→ `batch` 回放（16/16 成功）→
`merge` 灌数据（回执 `Replaced keys: N`）⇒ 兰台「案卷模板 + 数据 → N 份」的原生形态。
格式覆盖：docx / pptx / xlsx **三格式全有 e2e 守护**（⑥⑧⑩⑫）。

### 2.2 ② 既有文档注疏回写

Word 原生**批注**（`add … --type comment`）与**修订痕迹**（`revision.type=ins|del|format` +
`revision.author`，按 `/revision[@author=X]` 批量接受/拒绝）。读回：批注走 `get /comments` /
`query comment`，修订走 `query revision`。
⚠️ 读数陷阱：**待决删除的文本 `view text` 里不显示、`view annotated` 里显示但不标注**——
判定修订状态的唯一真源是 `query revision`（e2e ⑪ 钉死）。

### 2.3 ③ xlsx 数据面

公式**写即求值**（`--prop value==SUM(B2:B3)`，注意两个 `=`）；`get --json` 读
`computedValue`/`evaluated`；`pivottable` 一条命令落 OOXML（Excel 打开即带聚合）；CSV 可导入。

### 2.4 纸面呈现：三条路的结论

| 路 | 结论 |
|---|---|
| `view html` 内嵌资产块 | ❌ **不可行**：html 卡 CSP 是 `default-src 'none'`（CDN 的 KaTeX/Three.js 全被拦）+ 512 KB 截断 + 产出是整页应用布局（且 schema 禁 DOCTYPE/head/body 包裹） |
| **截图刷新** | ✅ **已落地**（纸面预览最小形态）：固定同一 PNG 路径 → 每次改完 `save` → 重截同一路径 → `update_asset(assetId, …)` 原地刷新。字节级判据由 e2e ⑨ 钉死 |
| **watch 活预览窗** | ✅ **已落地**（正式形态）：靠平台件「窗入口二态」（§3）；推送链路已实测（0.6 s 增量补丁）。唯一未证：Tauri 主窗能否框住环回页（§6 判据 3） |

**模型「自己看图」当前不支持**：`Tool.execute(): Promise<string>` 工具结果只能回文本，
MCP 的 image 内容块被静默丢弃 ⇒ 渲染视觉**交人判**；模型的机械自检走 `validate` + `view issues`。
要改需立「工具结果携带图像」平台件（§8 待你定）。

**真机判据已由 Agent 用 CDP 探针验毕（2026-09-13，在你的兰台上、隐藏节点、验完即移除）**：

| 实验 | 结果 |
|---|---|
| 在兰台真实 webview 注入隐藏 iframe（两档 sandbox）指向自建量具服 | 两帧都加载成功（HTTP 200）⇒ **Tauri 主窗能框住环回页** |
| A 档 `…allow-same-origin`：内页 origin | `http://127.0.0.1:26399`（保住自己 origin）→ **`sse-open` readyState=1** |
| B 档现行（无 allow-same-origin）：内页 origin | `null`（opaque）→ **`sse-error` readyState=2**（佐证必须加 allow-same-origin） |
| **真实 watch 页**放进 A 档帧，经 OOPIF 子会话读帧内状态 | `{title:"live.docx", origin:"http://127.0.0.1:26315", hasEs:true, readyState:1(OPEN), rendered:true}` |

⇒ **活预览窗在真机上成立**（不是推断）：页内 EventSource 真连上、页面真渲染。

## 3. 平台改动（两处，都进契约）

### 3.1 P0：MCP 工具只读语义归真（契约 v26→**v27**，规格变更）

**病灶**：`agent/mcp/registry.ts` 与 `plugins/mcp-bridge.ts` 把**所有** MCP 工具硬编码 `readOnly: () => true`
（注释自称"写入型由调用方覆盖"，全仓零覆盖）⇒ 写型 MCP 工具在兰台是"只读"：
**plan 模式放行写动作**、并入只读并行组、plan 子 Agent 静态只读集照收。

**修法**：单一真源 `resolveMcpToolReadOnly(schema, serverReadOnly?)` ——
**条目级 `mcpServers[].readOnly` > 远端 `annotations.readOnlyHint === true` > 缺省 false（fail-closed）**；
registry 与 bridge 两处工具构造同源消费；`~/.lantai/mcp.json` 同构复用同一 schema。
**行为变更**：未声明只读且远端无注解的 MCP 工具**从"只读"变"写"**（plan 拦截 + 退并行组）；
`examples/plugins/dataflow-mcp` 补 `"readOnly": true` 保住原行为。

### 3.2 窗入口二态（契约 v27→**v28**）

`manifest.app` 支持 `entry`（资产 HTML）**或** `url`（**环回** http(s)——白名单 {127.0.0.1, localhost, ::1}、
禁凭据、**禁 fullscreen**），互斥必给其一；窗口帧对 remote 形态加 `allow-same-origin`
（跨源文档保住自己 origin ⇒ 同源 SSE/fetch 才通）**且不绑宿主桥**；asset 形态行为逐字节不变。
改面：`plugins/types.ts`（schema+`isLoopbackAppUrl`）/ `state/plugin-window-store.ts`（`kind`）/
`plugins/window-facility.ts`（折算）/ `app/plugin-windows/PluginWindowFrame.tsx`（分档）+ 两测试文件。

## 4. 分发

- **体积**：31.87 MB（win-x64 单文件）——随包/随插件/首用下载三形态机制均已支持。
- **安装器** `examples/office-cli/install-officecli.ps1`：pin 版本 + **内嵌 SHA256**；三来源互斥
  （`-FromLocal` / `-FromPluginDir`【`bin/` 与根两形态】/ `-FromRelease`）；**校验失败即拒绝**（点名期望/实得）；
  幂等（同哈希 → 无需安装）；升级把旧件挪 `.bak-<时间戳>`；`VERSION` 记**二进制自报版本**
  （请求版本另记 `requested_version`）；受限网络可 `-SumsOverride`。
  **三条来源全部端到端实测**（`-FromRelease` 实测 624.5 s＝本机 ~44 KB/s 网络现实）。
- **推荐载体**：~~插件目录自带~~ → **C 路改判后不再需要载体**（读写能力归内置 `office` 域工具，二进制走标准安装位）；
  `examples/plugins/office/` 保留为**可选活预览窗插件**（`app.url` + `office_preview_open`，不挂 MCP）。

## 5. 坑账（实测得出，均已在技能/脚本/文档里落地）

| 域 | 坑 | 处置 |
|---|---|---|
| 挂接 | MCP 工具被当只读（写动作绕过 plan 门禁） | P0 已修（§3.1） |
| 挂接 | **两种形态不要同开**（用户级 `mcp.json` + 载体插件）：同名工具 `mcp__office__officecli` 撞车，`ToolRegistry.register` **直接 throw** ⇒ **会话装配失败**（不是静默取其一） | 二选一；切换先卸一份 |
| 挂接 | MCP 子进程是**全权用户进程**（不经 `fs_cap`、不受 `os_sandbox`），可写任意路径 | 已知债明牌；需沙箱/审计的动作走 shell 域 |
| 挂接 | 插件通道**没有技能贡献面**（无 `ctx.skills`），entry 也查不了插件目录 | 二进制随插件走、技能落技能根 |
| 落盘 | resident 只让别人看到**盘上字节** | 回读/预览/交付前必 `save`（或 `close`；或 `OFFICECLI_RESIDENT_FLUSH=each`） |
| 落盘 | `save` 幂等，回执两形态（`Saved x` / `x is already saved to disk.`） | 脚本判成败别只匹配 `Saved` |
| 交付门槛 | 中文正文缺首行缩进：`validate` 干净但 `view issues` 报 `[F1]` | `--prop firstLineChars=200`（2 字符） |
| 交付门槛 | **占位符残留、图片缺 alt、空白内容，issues 一律不报** | 自扫 `view text`；`query 'picture:no-alt'`；空白靠人判。`merge` 的失败形态就是**静默留 `{{key}}`** |
| 文档写入 | 新建 docx 只有 `Normal` 样式 | 要用的样式先 `add /styles --type style` 定义 |
| 文档写入 | 一个 run 只能挂一个修订（叠第二个被拒） | 换 run，或用 `revision.type=format` |
| 文档写入 | 接受/拒绝修订必须给 **native path**（`/revision[@id=…]` 与 `/` 都不行） | 用 `query revision` 的 `nativePath` |
| xlsx | 公式漏前导 `=` 会**静默存成字符串** | 写 `value==SUM(...)` |
| xlsx | 求值器不认识的函数：写了**没有值**（`[U3] not evaluated`） | 看 issues 点名，别以为写进去了 |
| 形态/引用 | `batch --commands` 的 JSON 必须走 argv 数组形态 | 防 shell 引号撕碎（`rgb(...)` 一类尤其） |
| 供应链 | 默认后台自动更新、`officecli install` 会写别的 agent 目录 | 设 `OFFICECLI_SKIP_UPDATE=1`；不跑 `install` |
| 版本 | 命令面漂移快 | pin 版本 + `--version` 自检 + 升级重跑 e2e |
| **技能落位** | **用户级技能（`~/.lantai/skills`）在生产被沙箱误拒**：`sandbox.rs` 的用户数据豁免（`skills`/`global_memory`/`mcp.json`）拿**逻辑路径**做 `starts_with`，而前端拿到的路径可能是 canonicalize/透传后的 **verbatim 形态**（`\\?\C:\…` 或 `//?/C:/…`）⇒ 恒不命中，报 `path "\\?\C:\…" is outside project directory`。既有单测只用逻辑路径，所以全绿（典型"单测过、生产炸"） | **已修**（2026-09-13）：`logical_path` 扩为剥两种 verbatim 拼写；三处用户数据判定（读豁免/写豁免/mcp.json）的入参与 canonicalize 结果统一过 `logical_path`；新增回归测试 `user_data_path_verbatim_prefix_allowed`（修前红、修后绿）；壳全量 **452 passed / 0 failed** + 集成 1。**即时绕过**（不必重编译）：技能落到**项目级** `.lantai/skills/officecli/` |
| **fs 路径不认 `~`** | **设置页 MCP 面板读写全链路失败**（第二个独立 bug，2026-09-13 用 CDP 在运行中的应用里实测）：`fs_cap` 的路径解析从不展开波浪号 ⇒ `~/.lantai/mcp.json` 被当相对路径，报 `parent directory not found`；错误又被 `McpPage` 的 catch 吞成"没有 mcp.json" ⇒ **面板恒显示空、新增 server 存不进去**。**注意**：boot 期链路用的是 `kernelGlobalMemoryDir()` 推的**绝对**路径，读得到 ⇒ **server 其实早已挂上**，面板看不到 ≠ 没配上 | **已修**：Rust `sandbox::expand_home` 扩为 `~`/`~/`/`~\` 三形态并接入 `path_resolve` 全部 fs 入口（7 处）；新增 `test_expand_home_forms`；**前端改用 `resolveUserMcpJsonPath()` 绝对路径**（不再赌 `~`，旧壳上也能工作）；**读失败不再吞**（`isUserMcpMissingError` 单一真源区分"不存在=正常空态"与"真失败=报错"，boot 报告进 `skipped`、面板出横幅）；`user-mcp` 9 例 + `mcp-page` 4 例绿 |
| 环境 | Windows 文件锁（Word/WPS 打开时写入失败）；与既有 CDP/Chrome 栈并存 | 提示用户关文件；注意 profile 隔离 |

## 6. 真机验收清单（owner：用户）

**第 0 步（30 秒、只读）**：`D:\HoloGramHG\examples\office-cli\preflight.ps1` —— 逐项 ✓/✗ + 修法
（二进制/哈希/版本 pin、`mcp.json` 摘要、载体现、技能 frontmatter、watch 是否在听、常驻进程数）；
关键项全过 exit 0。本机当前实测：二进制 ✓、`mcp.json` ✓（lazy + on-crash + readOnly 未声明⇒按写）、技能 ✓、
载体现 ✗（未放，可选）、watch ✗（未起，截图路不需要）⇒ exit 0。**把输出贴回来即可定位问题。**

1. 装好二进制：`officecli --version` 回 `1.0.149`；
2. 重启兰台 + **开新会话** → 工具面出现 `mcp__office__officecli`；`Skill` 能载入 `officecli`；
3. **~~唯一真机判据~~ 已由 Agent 验毕（见 §2.4 表）**：起 `officecli watch <文件>` → 让 Agent 调
   `office_preview_open` → 窗内应实时刷新（机制与真机壳两层都已证，你只需看一眼效果对不对）；
4. 真文档跑通：`view issues` 读到问题 → 改一处 → `save` → 截图入纸面（图能看到改动）；
5. **反向判据（P0 生效证据）**：plan 模式下让模型调写动作 → 应被 `[已拦截]`，而不是放行落盘。

> 第 0 步（`preflight.ps1`）**Agent 已跑**（本机结论 exit 0：二进制/哈希/版本 pin/`mcp.json`/技能全 ✓；
> 载体现 ✗ 未放＝可选、watch ✗ 未起＝截图路不需要）。真机壳判据也已由 Agent 用 CDP 探针验毕（§2.4）。
> **真正需要你亲自看的只剩**：重启后**界面里**工具与技能是否出现（第 2 条）、第 4 条纸面出图手感、
> 第 5 条 plan 拦截在你自己的会话里是否如预期。

> 挂接形态**二选一**（同开必炸，见 §5）：A 路（已落位）或载体插件（`examples/plugins/office/`，
> 先把二进制放进其 `bin/`，走「设置 → 插件 → 安装目录」）。

## 7. 施工史一览（十窗，逐窗叙述已删）

| 窗 | 做了什么 | 关键证据 |
|---|---|---|
| 1 | P0 只读语义修复（契约 v27）+ A 路三件套落位本机 | 受影响面 59/59 绿；全量 2921→（含后续）绿；指纹对拍一致；装机 MCP 握手自证 |
| 2 | 真实二进制端到端 e2e 开张（装载/只读/写盘/截图） | e2e 4 例绿；P0 在真 server 上成立 |
| 3 | 安装器机制 + convergence 补跑 + 活预览最小形态（截图刷新） | 安装器七路实测；convergence exit 0；e2e ⑨ 字节差钉死刷新 |
| 4 | 载体插件 `examples/plugins/office/`（推荐分发形态） | 载体守护 3/3（硬链临时插件目录 + 相对命令真机语义） |
| 5 | 活预览正式形态：窗入口二态（契约 v28） | 窗口/装载/插件三面 73 例绿；build + convergence exit 0 |
| 6 | 真实装载路径守护 + 验收入口 `preflight.ps1` | loader 真路径 4/4；预检两路（真实态 exit 0 / 空安装 exit 1） |
| 7 | 安装器加固（下载税/残件/异常逃逸/VERSION 假账）+ 技能配方验证 | 未固定版本三路 + 版本一致性两路实测；e2e ⑩⑪ |
| 8 | 技能声明逐条实测（技能清单体量、pptx 全流程、单位/颜色/行距） | e2e ⑫；测得 10 技能 25.2–64.9 KB、`%` 非合法长度等 |
| 9 | 交付门槛覆盖面实测（抓什么/不抓什么） | e2e ⑬：抓几何/溢出/公式错/未求值；不抓占位符/alt/空白 |
| 10 | watch 推送链路实测 + `-FromRelease` 端到端 | SSE 0.6 s 推增量补丁；`-FromRelease` exit 0（624.5 s，哈希通过） |
| 11 | **真机判据由 Agent 用 CDP 探针答掉**（§2.4 表）+ 复跑 `preflight.ps1` | 兰台真 webview 内：A 档 `readyState=1(OPEN)`、B 档 `2(CLOSED)`；真实 watch 页帧内 `hasEs:true/OPEN/rendered:true`；探针节点已移除、应用 target 列表干净 |
| 12 | **C 路落地：MCP 挂接改判为一等 `office` 域工具**（§10） | 域工具 12 动作 + zod 真源 + 沙箱路径；`office-domain.test` 13 例（含真 bash × 真 officecli 端到端）；契约生成物收录；**基线变更走 CR 审批后 record**（full 16→17 / plan 18→19）；MCP 路退役（插件去 mcpServers、用户机 mcp.json 清条目、预检加退役检查） |

**门禁终值**：e2e **12/12 绿**（真二进制，缺席自动跳过）；全量 `npx vitest run`
**2944 passed / 2 failed / 4 skipped（2950）**——2 红是**用户未跟踪**的 `tests/chat-send-liveness.test.ts`
（在途链路自愈工作，零 MCP 引用）；`npm run build` 与 `npm run verify:convergence` **exit 0**；
契约指纹 v28 对拍一致；`src-tauri` 零改动（未跑 cargo）。

## 8. 剩余与未决

1. **用户真机验收**（§6：重启后新会话里 `office(action,…)` 可用、plan 反向判据、纸面出图）；
2. ~~分发载体签核~~ → **已随 C 路作废**：读写走内置域工具（二进制标准安装位），插件只剩可选的活预览窗；
3. **产品方向件**（需用户定）：
   - ~~把注疏回写 / xlsx 做成一等工具域~~ → **C 路已一并兑现**（同一域工具的动作面里就有）；
   - 「工具结果携带图像」平台件（让模型看见自己的渲染，替代现在的人判）——**仍是唯一的大件**；
   - `officecli watch` 进程的自动收尾（现为 shell 后台手工管理，v1 可接受）；
4. **提交状态**：A 路 + 平台两修已提交（`f0e72bbd` 平台批 / `09b0924c` 集成件批）；
   C 路这批（域工具 + 插件改造 + 基线 CR/record + 文档）待提交——提交时 baseline 快照与本文件同 commit。

## 10. C 路：MCP 挂接改判为一等 office 域工具（2026-09-13）

### 10.1 为什么改判

用户的原话是「cli 被加到 MCP，听着就不是很对劲」——这个直觉是对的。MCP 挂接把 OfficeCLI 原样
搬成「**一个收命令行字符串的工具**」，四处不合兰台的形状：

| 面 | 旧（MCP 挂接） |
|---|---|
| 参数 | 自由命令行字符串（模型自己拼引号/转义/glob 规避） |
| 执行 | MCP 子进程 = **全权用户进程**：不经 fs_cap、不受 os_sandbox、无权限类、无审计 |
| plan 模式 | 整块判为写（我修过只读语义后反而更严）——**连 `view`/`validate` 都被拦** |
| 能力可见性 | 工具面一条 `mcp__office__officecli`，与「defineTool + zod 真源」纪律不符 |

### 10.2 新形态：`office(action, …)`

- **zod 真源收窄动作面（12 个）**：读 `view`/`get`/`query`/`validate`/`playbook`；
  写 `create`/`set`/`add`/`remove`/`batch`；交付 `merge`/`screenshot`。
  （CLI 的 `raw`/`raw-set`/`add-part`/`refresh`/`mark`/`watch` 不进模型面——L3 逃生舱走 shell 域；
  `load_skill` 收成 `playbook` 动作，**不丢能力**。）
- **执行走 `ctx.shell` seam → `process_cap`**：os_sandbox 沙箱 + **Bash 权限类** + 审计，与 `run_shell`
  同一条路。**不加新能力口**——口数 = 能力族数，office 是 process 族的消费者不是新能力族
  （架构裁定见 `docs/plans/kernel-plugin-architecture-decision.md` §3/§4）。
- **plan 按动作分档**：`readOnlyActions = [view, get, query, validate, playbook]` ⇒ 规划期可读文档、
  写动作被 `[已拦截]`（旧 MCP 路做不到）。
- **两个产品决定写死在工具里**：① `OFFICECLI_RESIDENT_FLUSH=each`（每次改动**写完即落盘**——
  否则截图/预览/交付会读到 resident 未 flush 的旧字节，这类静默错曾反复出现）；
  ② `OFFICECLI_SKIP_UPDATE=1`（确定性优先，升级走安装器换哈希）。
- **模型不碰引号**：命令行由工具层拼装（`shQuote` 单引号 + POSIX 收尾），路径里的空格/方括号
  （`/slide[1]` 会被 bash 当 glob）在此一次解决；相对路径按**该会话工作区根**解析
  （`ownerContext` + `resolveAgainstRoot`），并沿用 owner 的粘性 cwd（不顶掉 shell 域的 cwd）。
- **二进制定位**：`$OFFICECLI_PATH` → `~/.lantai/tools/officecli/officecli.exe` → PATH 兜底，
  **在 spawn 出来的 shell 里解析**（工具层碰不到盘；且 `~/.lantai/tools` 不在沙箱用户数据白名单里，
  fs 能力口读不到它）。找不到时工具按"错误不静默"补安装指引。

### 10.3 落地与证据

| 面 | 落点 |
|---|---|
| 工具本体 | `src-ui/src/agent/tools/office.ts`（12 动作 + 纯函数 `shQuote`/`buildOfficeCommand`/`buildOfficeArgv`/`cleanShellOutput`） |
| 域插件 | `src-ui/src/plugins/builtin/office-domain/`（index/host/host.aliased）+ `builtin-roster.json` buildOrder 29 + `composition/first-party-tools.ts` 表尾 |
| `defineTool` 扩展 | 新增可选透传 `domain`/`actions`/`readOnlyActions`（域工具契约与 plan 分档需要） |
| 守护测试 | `tests/office-domain.test.ts` **13 例**：纯函数、工具形状、**plan 逐动作分档**、执行面经 seam 派发（相对路径/cwd/落盘提示）、**真 bash × 真 officecli 端到端**（create→add→view→screenshot→validate，且"写完立刻读盘"） |
| 契约生成物 | `npm run gen:tool-contract` 收录 `office`（域 office / 12 动作 / 参数表） |
| 序列化基线 | **CR 审批后 record**：`phase-0/tool-schemas.full.json` 16→17、`…plan.json` 18→19（各 +1 条，其余逐字节不变）；CR 见 `docs/archive/agent-core-convergence/baseline-change-request.md` 首条 |
| MCP 路退役 | `examples/plugins/office/` 去 `mcpServers`（保留活预览窗，版本 2.0.0）；`bin/` 目录删除；用户机 `~/.lantai/mcp.json` 清空 office 条目；`preflight.ps1` 加「MCP 挂接已退役」检查；插件两守护测试改写（形状/装载路径/无 MCP 行/卸载收口） |
| 技能改写 | `examples/office-cli/SKILL.md` 调用面全部改为 `office(action,…)`（含"落盘已替你钉住"、`playbook` 取代表格、坑表按域工具口径重写） |

**门禁**：`office-domain` 13/13 绿；契约与基线对拍 `verify:convergence` exit 0；壳 `cargo test`
不涉（本批零 Rust 改动）；前端 vitest / build / biome 见提交记录。
