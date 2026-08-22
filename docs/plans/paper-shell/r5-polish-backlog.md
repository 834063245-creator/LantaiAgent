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
| C8 | **V5 拆除交互欠账：多卷切换 UI**（旧会话 tab 条随 ChatBeacon 退役；chat-core 的 switchSession/closeSession/createNewSession 面尚无纸壳入口——案卷首页可续开，卷内切换待设计） | ⬜ |
| C9 | **V5 拆除交互欠账：权限/ask 卡纸面化**——**已毕 2026-08-22（牒卡）**：位置不变（输入条上方递出），暗卡皮退役→纸面牒卡：权限卡=请示·PERMIT（朱砂 tag/subject 抄录图版/落印准此=纸面唯一实色按钮/本卷均准/驳回石墨）、问卡=问询·ASK（石青系）、递出动画 160ms；逻辑层零改动；真机 DOM 断言过 | ✅ |
| C10 | **V5 拆除交互欠账：附件入口**——**已毕 2026-08-22（拾遗）**：旧链四病灶根治（拖放 HTML5 drop 在 T2 WebView 从未触发/浏览器回退 f.name 冒充 path/size 恒 0 伪造/📎行拼楷书正文）；composer 夹按钮走 Tauri dialog 真路径；translate 结构化 payload.files；来文附件行（石青 mono「附 · name」+悬停真路径）；拖放明确 no-op（要做须走 Tauri onDragDropEvent 原生通道，另立任务）；守护 6 用例 + 真机 CDP（按钮/chip/keyguard）| ✅ |
| C11 | **V5 拆除交互欠账：模型/权限模式切换入口**——**已毕 2026-08-22（重设计）**：旧链路三病灶（切换不镜像 Rust/双源单向陷阱/per-panel 作用域错位）根治——mode-store 单源真相（切换=写 store+镜像 Rust+落盘；boot 水合）；书眉 ModeIndicator（模型纸面菜单按 provider 分组+恒 swap 热切换；模式常询/半放/全放三档轮转，yolo 须朱砂确认条）；panel-store permissionMode 退役。真机 CDP 闭环验证（含重启水合）；切回 ask 模式即可高频见 C9 新卡 | ✅ |
| C12 | **V5 拆除交互欠账：状态反馈面**——**已毕 2026-08-22（书眉状态字）**：StatusLine 接回 pushStatus 承接面（statusText 常显 + analyzing 石青呼吸徽标 + 点击展开 statusLog 环 15 条）；真机 CDP 验真实链路（cold-start 推的「已恢复上次案卷」直显）| ✅ |
| C13 | **V5 拆除欠账：scene/ui 休眠层 sweep**——**已毕 2026-08-22 两切片**：切片 A 删 ui/ 死件九文件（agent-visualizer/chat-utils/context-menu/file-translator+css/file-viewer/markdown-file-preview/message-height/pretext-cache，可达性闭包实测零活引用）+ 死测试三件；切片 B 删 scene/ Three.js 渲染面 22 文件（活代码全 type-only，bundle 实测无 three），scene/ 收窄为 graph-types.ts 类型模块 + README；StarGraph 降级兼容形状 interface；ui/graph.ts shim 重指向类型模块（冻结文件 import 面不动）；eventbus-zero 终态守护更新为新事实。合计 -12,700 行 | ✅ |
| C14 | **V5 拆除欠账：dock-store 开合表收缩**（open 初始表仍是旧六面板 + paper；随 C8-C11 面收敛重定义） | ⬜ |

## A 段 · 转录缺口（保真项）

| # | 项 | 状态 |
|---|---|---|
| A1 | 书眉右侧缺 folio 信息行（ZOOM/BLOCKS 计数）——HUD 迁入书眉 | ✅ 已清 |
| A2 | 书眉标题残留「一张纸 · The Paper · V1-R3」，应为「纸」 | ✅ 已清 |
| A3 | 缺 ORIGIN · 0,0 原点标记（流底） | ✅ 已清 |
| A4 | 缺 flow-band 流锚带（黄铜竖线 + FLOW 竖排字） | ✅ 已清 |
| A5 | plan-card 序号用浏览器默认 ol 样式 → 印刷品编号（mono leading-zero） | ✅ 已清 |
| A6 | 滚动条样式未接（3px ink-4 细杆） | ✅ 已清 |
| A7 | 抽纸条 strip 样式未移植（交互本身后接） | ⬜ 待办 |
| A8 | 产品化去机器味：调试读数（主题/格线/材质）与快捷键提示不外露，书眉只留 ZOOM·BLOCKS·RENDERED 印刷品行 | ✅ 已清 |
| A9 | 思（reasoning/校对批语）块型补全——风格源六文类对齐 | ✅ 已清 |
| A10 | 内容手工化重写：占位货 → 打磨过的自指会话（measure.ts 块高估算故事，含思块） | ✅ 已清 |
| A11 | 首屏锚定修正：默认视图第一块内容曾在 ~500px 处（半屏空白），改为贴书眉起排 | ✅ 已清 |
| A12 | 微工艺包：font-kerning / text-rendering / 表格数字变体 / caret 主题色 / focus 态 | ✅ 已清 |

## B 段 · 审美开放项（单维循环队列）

| # | 维度 | 环数 | 状态 |
|---|---|---|---|
| B1 | 垂直节奏：块距 56 的呼吸感、asterism 前后间距配比 | 0/3 | ⬜ 待用户点名 |
| B2 | 页边注光学：文类签基线与正文首行对齐、tick 连线位置 | 0/3 | ⬜ |
| B3 | 墨阶配比：ink-2/3 在界面中的分布密度（是否太灰） | 0/3 | ⬜ |
| B4 | 问批注音量：字重/字号/缩进的强调程度 | 0/3 | ⬜ |
| B5 | 代码块印刷化：diff 加删色的墨阶化程度 | 0/3 | ⬜ |

## 用户补充痛点

（空——等全屏复看后填入，注明是哪一处）
