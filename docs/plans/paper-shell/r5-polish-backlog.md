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
| C2 | SettingsPanel 注疏化重排（本轮只继承 token 翻纸，版式未按 set-frame 重排） | ⬜ |
| C3 | 夹注（reasoning）86% 收窄列宽（本轮块宽由世界坐标决定，未收窄） | ⬜ |
| C4 | 应用图标 PNG/ICO 套件再生（favicon.svg 已就绪；缺栅格化工具链，`cargo tauri icon` 待跑） | ⬜ |
| C5 | --obs-* 别名层退役：逐文件迁移到兰台 token 名后整体删除（**切片 1 已毕 2026-08-22 深夜**：shared.css 938→222 行死面板样式全删，计算样式对拍零变更；余量 = settings-panel/provider-settings/prompt-shelf/shell 四 css + SettingsPanel/PluginsPage/ContextMenu 内联——休眠层 scene/ui 的 --obs-* 引用不拦退役，它们不再渲染） | 🔶 |
| C6 | 主聊天输入条 placeholder 文案打磨（纸壳 composer 现文案未按 §5 术语化） | ⬜ |
| C7 | 来文圈点关键词（.circled 朱砂圈）：需 user 块关键词高亮数据面，渲染层已备样式钩子 | ⬜ |
| C8 | **V5 拆除交互欠账：多卷切换 UI**（旧会话 tab 条随 ChatBeacon 退役；chat-core 的 switchSession/closeSession/createNewSession 面尚无纸壳入口——案卷首页可续开，卷内切换待设计） | ⬜ |
| C9 | **V5 拆除交互欠账：权限/ask 卡纸面化**（PromptShelfHost 仍是旧观测台暗卡样式——纸面朱砂批红卡归本项；功能已接通） | ⬜ |
| C10 | **V5 拆除交互欠账：附件入口**（旧 Composer 的文件选择/拖放接口在 chat-core.openFilePicker/handleFileDrop；纸壳 composer 未接） | ⬜ |
| C11 | **V5 拆除交互欠账：模型/权限模式切换入口**（旧 ChatFooter 的 ModelSwitcher + ask/auto/yolo 模式条退役；设置面板可改 provider，权限模式切换无入口——影响 bridges 权限桥行为） | ⬜ |
| C12 | **V5 拆除交互欠账：状态反馈面**（pushStatus 的 statusText/statusLog 无 UI 消费——图谱预热/分析进度对用户不可见；候选：书眉行或纸面贴黄块） | ⬜ |
| C13 | **V5 拆除欠账：scene/ui 休眠层 sweep**（星图 23 文件 + file-viewer/file-translator 等仍被 workspace/chat-session 类型引用；完整删除需动冻结文件 import 图——独立小步施工） | ⬜ |
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
