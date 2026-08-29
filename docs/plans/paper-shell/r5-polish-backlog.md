# R5 打磨待办（polish backlog）

> 生成：2026-08-22 · 人判「骨架可以，缺细打磨」后的逐项化清单
> 规则：A 段是转录缺口（对照风格源 `prototype/style-source-direction-b-print.html` 的保真项，无需人判直接补）；B 段是真审美开放项（V4 式单维循环，一环一维 A|B 对照，每维 ≤3 环，对照反馈）。
> 用户补充的痛点随时插入清单并标来源。
>
> **A 段已全部清账（同日）**——截图 `prototype/preview/refs/ours-r5.png` 已刷新，JS 干净、书眉「纸」、原点/流锚带在位。
>
> **⚠️ 2026-08-22 风格源升级**：用户侧设计线定稿「兰台注疏」并交付 handoff 全量落地（见 taste-ledger 同日条目）。风格源自本日起以 **`prototype/lantai.html`**（＋契约 `docs/design/lantai-design-spec.md`）为准绳，direction-b 存档不再当判据；B 段各维对照对象随之切换。产品代码已换装（tokens/PaperPanel/首页/术语），产品化打磨项涌出为 C 段。
>
> **2026-08-22 深夜 R5 首轮自检（V5 拆除后，DOM 计算样式对拍代偿）**：本会话模型无图片输入（read_image 拒绝）——vision 自检以 headless Edge 提取黄金样本与产品的计算样式逐项对拍代行。结论：书眉（56px/0 24px/ink-4 底线/纸色）、composer（66px/纸深底/同 placeholder）、纸面（#F6F1E7/EB Garamond Variable+Noto Serif SC/15px/27px 行高/ink-1）、文类块样式链（来文楷书朱砂批线/正文宋体/夹注石墨虚线/脚注石青注线）全部一致；两处合理差异：产品书眉多 WinControls+关卷（拆除新增）、发送键「拟文」是 §5 术语（原型「发送」为旧词）。**渲染面无回归**。B 段单维审美循环（真图片对照）留给 vision 能力会话。

## C 段 · 注疏落地涌出项（2026-08-22 handoff 落地新增；V5 拆除欠账 C8+ 同日立账）

| # | 项 | 状态 |
|---|---|---|
| C1 | ~~旧观测台 chrome 去圆角~~ **随 V5 拆除消解**（chrome 全族已删；残余圆角清点并入 C13 休眠层 sweep） | ✅ 消解 |
| C2 | SettingsPanel 注疏化重排（本轮只继承 token 翻纸，版式未按 set-frame 重排）——**已毕 2026-08-22 自主段**：settings-panel.css 整卷按 .set-frame 语法转录（序号分节/双列注疏行/下划线输入件/seg 标签组/圆角恒 0/硬偏移投影）；vision 会话 headless Edge 截图与原型三轮对拍收敛；biome 存量 1e1w→0 | ✅ |
| C3 | 夹注（reasoning）86% 收窄列宽（本轮块宽由世界坐标决定，未收窄）——**已毕 2026-08-22**：REASONING_BLOCK_WIDTH = 720×0.86≈619，主流与走查弹两出口同步 | ✅ |
| C4 | 应用图标 PNG/ICO 套件再生——**已毕 2026-08-22**：栅格化以 headless Edge 截图代偿（免引 resvg/sharp），cargo tauri icon 全套落地，android/ios 目录移除；128px vision 复核通过 | ✅ |
| C5 | --obs-* 别名层退役：逐文件迁移到兰台 token 名后整体删除——**已毕 2026-08-22 自主段**：余量十文件全迁 + tokens.css 别名块删 + 收容块（--snap/--glide/--glass/--glass-hi/--line-soft）+ tokens.obs.css 删；死引用按定案处理（blue-hi→indigo、warn-dim/text-1 删）；休眠层引用随 C13 sweep 一并消失 | ✅ |
| C6 | 主聊天输入条 placeholder 文案打磨——**已毕 2026-08-22**：「向 Agent 拟文…」去冗余映射为「拟文…」（§5：发送→拟文一词足矣）；真机截图确认生效 | ✅ |
| C7 | 来文圈点关键词（.circled 朱砂圈）：——**已毕 2026-08-22**：定案「【词】书写语法 + 渲染层解析」零数据契约方案（用户拍板）。落地：marks.ts 解析器（≤8 字不含换行才圈，超长/未闭合/跨行/空按字面）+ inline-block 圈永不拆行 + measure 原文测高零镜像；10 单测全绿。**真机用户验证通过（2026-08-22，填 key 实发来文实测）**；原型 .circled 只在来文生效，AI 回文中的【】不受影响 | ✅ |
| C8 | **V5 拆除交互欠账：多卷切换 UI**——**已毕 2026-08-22（书脊列 SpineRack）**：用户拍板隐喻流派四决策（左缘/卷首名双击改名/合卷自动存/恒显）。落地：左缘函套书脊列（一卷一脊，当前卷朱砂侧条「抽出一半」；列尾虚脊另起一卷）；卷首名沿用 autoTitle；双击题签改名（sess store renameSession 单写入口 + 改名即落盘 saveSessionById）；运行中卷石青呼吸点 + 合卷钮禁用；合卷自动存根治旧病灶（closeSession 末尾的 autosave 存的是切后活跃卷，被合卷内容从未落盘——现在 dispose 前同步捕获快照异步落盘 writeSessionSnapshot）；空卷不落盘（同 saveActiveSession 规）；冷启动无 key 死路防护（sr-notice 本地提示条）。守护 8 UI 用例 + 3 落盘数据面用例；真机 CDP 全链路（另起/换卷/改名/合卷自动存实锤 230.json 重写）| ✅ |
| C9 | **V5 拆除交互欠账：权限/ask 卡纸面化**——**已毕 2026-08-22（牒卡）**：位置不变（输入条上方递出），暗卡皮退役→纸面牒卡：权限卡=请示·PERMIT（朱砂 tag/subject 抄录图版/落印准此=纸面唯一实色按钮/本卷均准/驳回石墨）、问卡=问询·ASK（石青系）、递出动画 160ms；逻辑层零改动；真机 DOM 断言过 | ✅ |
| C10 | **V5 拆除交互欠账：附件入口**——**已毕 2026-08-22（拾遗）**：旧链四病灶根治（拖放 HTML5 drop 在 T2 WebView 从未触发/浏览器回退 f.name 冒充 path/size 恒 0 伪造/📎行拼楷书正文）；composer 夹按钮走 Tauri dialog 真路径；translate 结构化 payload.files；来文附件行（石青 mono「附 · name」+悬停真路径）；拖放明确 no-op（要做须走 Tauri onDragDropEvent 原生通道，另立任务）；守护 6 用例 + 真机 CDP（按钮/chip/keyguard）| ✅ |
| C11 | **V5 拆除交互欠账：模型/权限模式切换入口**——**已毕 2026-08-22（重设计）**：旧链路三病灶（切换不镜像 Rust/双源单向陷阱/per-panel 作用域错位）根治——mode-store 单源真相（切换=写 store+镜像 Rust+落盘；boot 水合）；书眉 ModeIndicator（模型纸面菜单按 provider 分组+恒 swap 热切换；模式常询/半放/全放三档轮转，yolo 须朱砂确认条）；panel-store permissionMode 退役。真机 CDP 闭环验证（含重启水合）；切回 ask 模式即可高频见 C9 新卡 | ✅ |
| C12 | **V5 拆除交互欠账：状态反馈面**——**已毕 2026-08-22（书眉状态字）**：StatusLine 接回 pushStatus 承接面（statusText 常显 + analyzing 石青呼吸徽标 + 点击展开 statusLog 环 15 条）；真机 CDP 验真实链路（cold-start 推的「已恢复上次案卷」直显）| ✅ |
| C13 | **V5 拆除欠账：scene/ui 休眠层 sweep**——**已毕 2026-08-22 两切片**：切片 A 删 ui/ 死件九文件（agent-visualizer/chat-utils/context-menu/file-translator+css/file-viewer/markdown-file-preview/message-height/pretext-cache，可达性闭包实测零活引用）+ 死测试三件；切片 B 删 scene/ Three.js 渲染面 22 文件（活代码全 type-only，bundle 实测无 three），scene/ 收窄为 graph-types.ts 类型模块 + README；StarGraph 降级兼容形状 interface；ui/graph.ts shim 重指向类型模块（冻结文件 import 面不动）；eventbus-zero 终态守护更新为新事实。合计 -12,700 行 | ✅ |
| C14 | **V5 拆除欠账：dock-store 开合表收缩**——**已毕 2026-08-22**：open 初始表从旧观测台七键（check/constraints/dataflow/settings/agents/tasks/paper）收缩为两个活键（settings 常量面 + paper 组合贡献）；三处 check 死写入清除（runCheck 后 openPanel('check') / setCheckResult 失败自动展开 / showCheckHistory 死 action 删）；setCheckResult 保留真价值（喂 agent 状态注入缓存 cacheCheckResult + 结果入库），简报可见性走 statusText + 违规徽章（原有链路不动）；守护 2 用例（初始表对拍 + setCheckResult 新语义）。插件面板键动态写入不进初始表（S1-5 string 开集语义不变）| ✅ |

## A 段 · 转录缺口（保真项）

| # | 项 | 状态 |
|---|---|---|
| A1 | 书眉右侧缺 folio 信息行（ZOOM/BLOCKS 计数）——HUD 迁入书眉 | ✅ 已清 |
| A2 | 书眉标题残留「一张纸 · The Paper · V1-R3」，应为「纸」 | ✅ 已清 |
| A3 | 缺 ORIGIN · 0,0 原点标记（流底） | ✅ 已清 |
| A4 | 缺 flow-band 流锚带（黄铜竖线 + FLOW 竖排字） | ✅ 已清 |
| A5 | plan-card 序号用浏览器默认 ol 样式 → 印刷品编号（mono leading-zero） | ✅ 已清 |
| A6 | 滚动条样式未接（3px ink-4 细杆） | ✅ 已清 |
| A7 | 抽纸条 strip 样式未移植（交互本身后接）——**已毕 2026-08-24（收尾批）**：strip 样式完整化（题签头 + hover 显形销毁钮 + pre-wrap 正文）；交互同步重写（判拖防误触/选区锚点块校验/source 溯源）；钉住块 + 纸条持久化接入（`state/paper-store.ts` 按会话管理，随会话快照落盘/恢复，切卷/合卷/删卷/切工作区各路径清理）；守护 `tests/paper-store.test.ts` + `chat-session.test.ts` paper 持久化 4 用例 | ✅ |
| A8 | 产品化去机器味：调试读数（主题/格线/材质）与快捷键提示不外露，书眉只留 ZOOM·BLOCKS·RENDERED 印刷品行 | ✅ 已清 |
| A9 | 思（reasoning/校对批语）块型补全——风格源六文类对齐 | ✅ 已清 |
| A10 | 内容手工化重写：占位货 → 打磨过的自指会话（measure.ts 块高估算故事，含思块） | ✅ 已清 |
| A11 | 首屏锚定修正：默认视图第一块内容曾在 ~500px 处（半屏空白），改为贴书眉起排 | ✅ 已清 |
| A12 | 微工艺包：font-kerning / text-rendering / 表格数字变体 / caret 主题色 / focus 态 | ✅ 已清 |

## B 段 · 审美开放项（单维循环队列）

| # | 维度 | 环数 | 状态 |
|---|---|---|---|
| B1 | 垂直节奏：块距 48 的呼吸感、asterism 前后间距配比 —— **环 1 已毕（2026-08-22 直审循环首环）**：用户拍板块距 48 收下、asterism 收下、来文间距反转（尾距收 8 头顶放宽 72——「分得开用户消息和前一轮 LLM 消息」）。落地：blockGap 18→48、userLeadGap 24 / userTailGap 8（layoutFlow 按 kind 定间距）、来文尾 asterism 三星（原型同款 30px 尾距 + 测量镜像 44）、markdown 段距 10（双换行分段 + .pp-para + 测量镜像）| 1/3 ✅ 环 1 |
| B2 | 页边注光学：文类签基线与正文首行对齐、tick 连线位置 —— **环 1 已毕（2026-08-23，vision 会话首环）**：数值账（签基线落差 来文+9.6/正文+5.8/夹注−0.3/脚注+6.0/抄录+27.8/拟策+28.0）+ 三列对照 `prototype/b2-margin-optics-ab.html`（A 顶挂 / B 全量基线对齐 / C 分组）；用户判「区别其实不大，你来定就好」→ agent 定 **A 维持顶挂**（top:2 / tick:10 原型转录值，差异不显著守原型最小改动），基线对齐方案判死——**收维，零改动** | 1/3 | ✅ 收维 |
| B3 | 墨阶配比：ink-2/3 在界面中的分布密度 —— **环 1 已毕（2026-08-23）**：数值账（原型 ink-3×21/ink-2×15；产品 ink-3×77/9 文件）+ B 提墨变体对照（`prototype/b3-ink-b.html`）；用户拍板 **B 提墨**——信息承载五处 ink-3→ink-2 落地（tool/code .pp-out、案卷日期/卷号、页脚），饰件留 ink-3；钉值 paper-visual-decisions ✅ **收维，已落地** | 1/3 | ✅ 收维 |
| B4 | 问批注音量：字重/字号/缩进的强调程度 —— **环 1 已毕（2026-08-23）**：发现规格书（来文身 seal-deep）与原型实演（ink-1）分叉，产品随规格书；三变体对照（A 规格书 18px / B 原型墨身 / C 16px 折中），用户拍板 **C 折中**——seal-deep 保持（问仍是唯一彩色声音）、字号 18→16 收到正文 17 之下；落地 CSS+measure 镜像+规格书，钉值双处 ✅ **收维，已落地** | 1/3 | ✅ 收维 |
| B5 | 代码块印刷化：diff 加删色的墨阶化程度 —— **环 2 已毕（2026-08-23）**：环1 三变体（A 矿物 / B 全墨 / C 单墨）用户判「不符合代码块直觉，要红-绿+ 但墨色化」；环2 出 D 变体（`prototype/b5-d-cinnabar-jade.html`：add 松绿 --pass / del 朱砂深 --seal-deep+删除线）**用户拍板 D**；落地 CSS+规格书铁律豁免注记，钉值 paper-visual-decisions ✅ **收维，已落地**。**B 段五维至此全收（B1 落地三件套+来文间距反转 / B2 授权 agent 判 A / B3 拍 B 落地 / B4 拍 C 落地 / B5 环2 拍 D 落地）** | 2/3 | ✅ 收维 |

## D 段 · 2026-08-29 代码走查留单

> 背景：三方探查（交互 a11y / CSS 规格符合度 / 四态手感）55 条线索，人工复核后修复 16 处落 **commit `b5195c24`**（弹层 a11y/焦点管理 + 四态补齐 + token 纪律收编 + 退役字体删除；门禁 build/biome/vitest 全绿零回归），4 条误报剔除（见段尾记录）。以下为复核后不进修复批的余项。
>
> 栈裁决记录（2026-08-29，UI/UX 专项开工前置）：外部推荐栈评审结论 = React Flow / Tailwind / shadcn / react-query / React 18 全不引入（范式不合：文档画布非节点图、tokens.css 即设计系统、Tauri IPC 无 HTTP 缓存面）；控件行为层定「甲路线」= 手写为常规（dialog-focus.ts 为范式件），复杂交互件单点 react-aria hooks 例外（一事一议）；motion 不预装，遇 CSS 不可达的弹簧/FLIP 交互单点引入。按 Agent 建议执行中 → **用户拍板确认（2026-08-29：拍板 1A），栈关闭。**

| # | 项 | 谁判断 | 状态 |
|---|---|---|---|
| D1 | **印章重制**：用户自评「蘭臺」印章不好看（`.sh-seal` 竖排字 + 3px 边框微倾，foundation.css）——方向：生图模型出朱砂印章图案候选（篆刻风、透明底、单色朱砂），产品侧替换 CSS 字排章；favicon/应用图标同源换装可顺带 | 用户（候选终审） | ✅ **候选集齐 4 张（2026-08-29，用户拍板「都留着需要时用」）**——资产落 `assets/seals/`（README 含各张评估与建议用途）；书眉替换/favicon 换装等落地待办见该 README，不在 D1 探索范围 |
| D2 | 状态圆点形态：状态点/呼吸点/更新角标等 `border-radius: 50%` 族（~12 处）——用户拍板（2026-08-29）「不是百分之百要的，有更好方案更好」；现状圆点保留（视作字形本体，同 C7 圈点豁免先例），后续视觉方案若出现更优标记形态（方点/短竖线/印泥点）单点替换 | Agent（可自主探索） | 开放 |
| D3 | hover 过渡普遍缺失：多数交互件 hover 瞬间变色，`--snap`（0.12s）token 已在但未普遍引用——补齐属手感维度 | Agent | 开放 |
| D4 | IME 候选窗错位：钉住块就地编辑时输入法候选窗位置漂移（`ime.ts` 头注记录在案）——画布变换 × OS 输入法坐标换算 | Agent | 挂起（深水区，单独立项） |
| D5 | 后台失败统一可见出口：画布落盘失败仅 console.warn 静默重试（board-persistence）+ 摊开集恢复失败仅 console.error——需先定「后台错误提示面」形态（StatusLine 警告档？notice 条？）再两处接入 | 用户（形态）+ Agent（落地） | ✅ 已拍板 **C 混合**（2026-08-29）+ **已落地**（commit d2846bd9）：bg-alert-store（同 id 失败态延续不重复弹/成功解除再弹/单槽语义，4 用例守护）+ StatusLine 警告档（--warn 色警点）+ 一次性提示条（「知道了」收条不动警报）；接入画布落盘失败 + 摊开集恢复失败两处 |
| D6 | document.title 动态化：窗口标题恒「兰台 — Lantai」，切工作区不随动，多开难区分 | 用户（格式） | ✅ 已拍板 **C**（2026-08-29）+ **已落地**（commit d2846bd9）：`useDocumentTitle`——`{工作区名} · {活跃案卷} — 兰台`，随切工作区/切卷/改名实时刷新（工作区名取 basename，注册表登记名不参与） |
| D7 | 窗口位置/尺寸记忆：**核查完毕（2026-08-29）——已实现，无需改动**。`tauri-plugin-window-state` 依赖（Cargo.toml:49）+ `main.rs:66` 注册在位，插件默认 StateFlags 恢复尺寸/位置/最大化（首次探查误报「未实现」系 pattern 连字符没匹配到下划线 `window_state`，记为教训） | Agent | ✅ 已实现 |
| D8 | ModelSelector 目录拉取 loading 行：动态目录拉取中下拉无「拉取中…」指示（失败标注已有）——需目录状态 plumbing，可见度低 | Agent | 开放（低优先） |

**误报剔除记录**（2026-08-29 走查，避免后人重查）：① 流式中发送=插话特性（chat-core 插入路径有「已插入进行中的回合」回音通知），非吞消息；② 「hover 无 focus-visible 系统性缺失」大部分被 foundation.css 全局 `:focus-visible` 兜底覆盖，实际缺口小；③ PromptShelf 权限卡实有 `aria-label="权限请示"`；④ `type="button"` 全数在位。另：--indigo 语义存疑三处复核合规（摊开标记自注「机=石青」/拟策序号=规格书明文/牒卡=机器问询）。

## 用户补充痛点

（空——等全屏复看后填入，注明是哪一处）
