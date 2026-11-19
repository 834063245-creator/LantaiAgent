# 兰台 · 反馈密度体检（2026-11-17）

> **一句话结论**：兰台不是"缺动效"，是**只会变色、不会动**（几何过渡全仓 5 处 vs 颜色过渡 54 处），
> 且**按下去没有回弹**（`:active` 22 条 vs 交互件 140 个）。"死板"感来自这两件事，不来自入场动画不够。
>
> **性质**：静态扫描（CSS/TSX）+ 历史报障 + 代码注释交叉，**未做真机逐点**。标 `?` 的条目需真机确认。
> 数据快照：2026-11-17，`main` @ `c93ec1fa` 之后。

---

## 0. 口径

### 0.1 五个时刻

任何一个动作都有生命周期，反馈密度 = 五个时刻各有没有回应：

| # | 时刻 | 问的问题 | 典型手段 |
|---|---|---|---|
| ① | **可发现** | 做之前，知道这里能操作吗 | 光标形状、hover 显形、提示、一次性眉批 |
| ② | **按下** | 按下那一瞬，有回弹吗（<100ms） | `:active` 形变、压深、位移 1-2px |
| ③ | **等待** | 在做吗，还要多久 | 运行态、呼吸、进度、字数在长 |
| ④ | **完成** | 成了吗 | 收束一拍、确认、落定 |
| ⑤ | **因果** | 是我干的吗，从哪来 | 来源引线、来源标注、痕迹 |

### 0.2 强度四档

| 档 | 含义 |
|---|---|
| **无** | 动作发生，界面零变化（或变化在视野外） |
| **弱** | 有变化但需刻意看才察觉（1px 色差、屏幕边缘细线） |
| **中** | 一眼能看出，但没有"体感"（颜色跳变、瞬时出现） |
| **强** | 有体感：有力度、有先后、有停顿、有余 |

### 0.3 局限（必须先说）

- 本报告是**静态分析**。CSS 能证明"有没有规则"，不能证明"好不好看"。
- 部分硬切是**刻意的**（见 §5.3），不是缺陷。
- 用户真实体感只有真机能给；本报告的作用是**把"哪里一定空"找出来**，把真机时间花在"哪里可能不对"上。

---

## 1. 总量数据

| 指标 | 数量 | 说明 |
|---|---|---|
| 交互件（`cursor: pointer`） | **140** | CSS 侧可点面 |
| `<button>` 元素 | **247** | TSX 侧显式按钮 |
| 非 button 点击面（`onClick` / `role="button"`） | **165** | 卡片、行、块、缩略图等 |
| `:hover` 规则 | **198** | 悬停覆盖较好 |
| **`:active` 规则** | **22** | **按下态严重不足** |
| `:focus-visible` | **45** | 键盘可达性中等 |
| `transition:` 声明 | **158** | 其中颜色类 54、透明度 12、**几何类 5** |
| `display` 切换点 | **353** | 元素瞬间出现/消失 |
| `allow-discrete`（离散过渡） | **3** | 353 里只有 3 处做了过渡 |
| 音效 | **0** | 全仓无音频 |
| 光标族 | 15 种 | pointer 140 / grab 10 / grabbing 8 / zoom 4 / resize 4 / not-allowed 5 / progress 1 |

**读法**：兰台在"告诉你能点"（hover、光标）上做得不差；在"按下去有回应"（`:active`）和"东西真的在动"（几何过渡）上几乎是空白。

---

## 2. 五个时刻总评

| 时刻 | 总档 | 依据 |
|---|---|---|
| ① 可发现 | **中** | 光标族丰富；拖动锁、一次性眉批已做；但多数按钮靠 hover 才显形，无提示 |
| ② 按下 | **弱** | 22 条 `:active` / 412 个交互点。**两条是主按钮范式**（`.sh-btn-primary` / `.ss-new`：背景转朱砂 + `translateY(1px)`），次级件几乎全为 0 |
| ③ 等待 | **弱** | 首 token 前只有屏幕底缘一条呼吸线；长任务只有状态点 |
| ④ 完成 | **中** | 工具卡有勾、设置保存有"已保存"、toast 通道齐；但无"收束一拍" |
| ⑤ 因果 | **部分** | 拖块有朱线引路（2026-09-18）；其他动作没有 |

---

## 3. 逐面体检

> 每面列交互件、现有反馈、缺口。档位按 §0.2。
> "active 数"指该面 CSS 文件内的 `:active` 规则条数，非按钮数。

### 3.1 首页 / 工作区（`sessions-home/`）

- 文件：`SessionsHome.tsx`（**24 个 button**）、`home.css`（hover 15 / **active 1** / transition 10 / display 切换 2）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| `sh-btn-primary`（打开/新建卷） | hover + **`:active` 背景转朱砂 + `translateY(1px)`** | —— 做对的主按钮范式 | **强** |
| `sh-btn-text`（设置入口） | hover | 同上 | 弱 |
| `sh-btn-ghost`（指定目录） | hover | 同上 | 弱 |
| `sh-link`（新建/更多） | hover | 同上 | 弱 |
| `sh-sib`（相邻卷卡片） | hover | 按下无反馈；点开有卷飞行 | 弱 |
| `sh-row-main`（工作区行） | hover | 按下无反馈；进入工作区是硬切 | 弱 |
| 工作区行内三枚小钮（重命名/固定/移除） | `data-tip` 提示 | 按下无回弹 | 弱 |
| `sh-sheet-opt`（建目录/选目录） | hover | 按下无回弹 | 弱 |
| `sh-retry`（重试） | hover | 无"正在重试"中间态 ? | 弱 |
| 危险操作（移除工作区） | `.danger` 色 | 无二次确认的手感（有确认弹窗 ?） | 中 |
| 卷清单加载 | 三态骨架（loading/ready/error） | 首次进入有骨架 ✓ | 中 |

**面结论**：24 个按钮、1 条按下态——**那一条在唯一的主按钮上**。这更像"主次分明的刻意取舍"而非遗漏；但其余 23 个次级件（含重命名/固定/移除这类破坏性操作）按下去完全无回响，次级操作因此读作"不可靠"。

### 3.2 侧栏（`canvas-nav/SessionSidebar.tsx`）

- 文件：**22 个 button**、`session-sidebar.css`（hover 19 / **active 1** / transition 16 / display 切换 2）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| `ss-new`（新建卷） | **`:active` 背景转朱砂 + `translateY(1px)`** | —— **这是全仓唯一做对的按下态范式** | **强** |
| `ss-check`（批量勾选） | `.on` 类 | 勾选瞬间无过渡（瞬时） | 弱 |
| `ss-kids` / 子卷行 | hover | 按下无回弹 | 弱 |
| `ss-branch-tag`（枝标记） | hover | 无 | 弱 |
| 行内小钮（改名/合卷） | `data-tip` | 按下无回弹 | 弱 |
| `ss-bucket-head`（分组头） | `.folded` 类 | 折叠是瞬时（见 §5.3 刻意硬切） | 中 |
| `ss-arrange-enter` / `ss-arrange-del` / `ss-arrange-done`（整理模式） | hover + danger 色 | 进入整理模式是**整面切换**，无过渡 | 弱 |
| `ss-section-head` × 4（分区折叠） | `.folded` | 同上 | 弱 |
| `ss-resize`（拖宽） | cursor 变 | 跟手 ✓；松手无吸附/无回弹 | 中 |
| 批量删除 | 二次确认（batchArmed） | 确认态有 danger 色 ✓ | 中 |

**面结论**：侧栏与首页用的是**同一个范式**（`.ss-new:active` / `.sh-btn-primary:active`：背景转朱砂 + 1px 下压）——兰台会做按下态，且写法已经统一，只是**只给了主按钮**。

### 3.3 书脊 / 目次带 / 小地图（`canvas-nav/spine-rack.css`、`paper-shell/paper-toc.css`、`paper-minimap/`）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 书脊条目（`spine-rack.css`：hover 5 / **active 0**） | hover | 按下无回弹；跳转有飞行 ✓ | 弱 |
| 目次带卡片（`paper-toc.css`：hover 6 / **active 0**） | hover、翻转 | 按下无回弹；拖动落位有动画 ? | 弱 |
| 目次带折叠 | — | 硬切 | 弱 |
| 小地图（`minimap.css`：hover 3 / active 1） | hover | 视口框拖动跟手 ✓ | 中 |

### 3.4 画布与卷（`paper-shell/PaperPanel.tsx`、`paper-ops.css`）

- `paper-ops.css`：hover 17 / **active 4** / transition 12 / display 切换 0

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 卷本体（`.pp-region`） | 拿纸（`pp-region-take` 影过冲）+ 朱笔划界（0.24s） | **强**：切换瞬间有回响（2026-09-10 已修） | 强 |
| 落纸入场 | 纸淡入 + 墨 18px 落 + 冻帧 | **本次新增余波（1.6s 影收）** | 强 |
| 起纸（合卷） | 淡出 + 墨沉 18px + 冻帧 | 好 | 强 |
| 版口钮（红条） | 划界动画 | —— | 强 |
| 区域缩放/移动 | 跟手零缓动（手律） | 正确；但**到边界无阻挡感** | 中 |
| 空白处点击 | 无 | 无回执（是否算缺陷见 §5.3） | 弱 |
| 卷首（folio） | 随纸落/沉 | 好 | 强 |

**面结论**：**画布是兰台反馈密度最高的地方**——拿纸、落纸、起纸、冻帧、余波都在这里。问题不在画布。

### 3.5 块与消息流（`paper-block.css`、`paper-motion.css`）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 块入场（`pp-enter`） | 淡入 + 上浮 8px | **无先后**（多块同时入场） | 中 |
| 块拖拽 | 跟手 + 落影提档 + 带内预览态 | 强 ✓（2026-09-05 松手定夺批） | 强 |
| 钉住块 | 盖章剪报换装 + 引线 | 强 ✓ | 强 |
| 块折叠/展开 | 硬切（刻意，见 §5.3） | 无 | — |
| 工具卡运行态 | 石青方点呼吸（`pp-writing`）+ `.pp-status.pp-running` | 中；**长任务无进度** | 中 |
| 工具卡完成 | 勾 / 状态变化 | 无收束一拍 | 中 |
| 流式增量 | 0.72→1 起墨渐显（`--glide`） | 中 ✓（2026-08-30 方案 B） | 中 |
| 消息复制/操作钮 | hover 显形 | 按下无回弹 | 弱 |
| 折叠组 / 阶段细线 | 静态 | 无 | — |

**面结论**：块的**手势**是强项（拖、钉、引线），块的**事件**（开始/完成/失败）是弱项。

### 3.6 创作坞（`compose-dock/`、`paper-shell/paper-composer.css`、`paper-dock-tools.css`）

- `composer-rows.tsx` 9 个 button；`ModelSelector.tsx` 8 个 button；`model-selector.css` **active 0**；`paper-composer.css` **active 0**；`paper-dock-tools.css` active 3

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| `pp-send`（发送） | hover / **active** / disabled 三态齐 | 按下有回弹 ✓ | 强 |
| `pp-stop`（停止） | 有 | 按下 ? | 中 |
| `pp-attach`（附文件） | hover + `open` 态 | 按下无回弹 | 弱 |
| `pp-yin-btn`（印钮，组合/权限） | `open` 态 | 按下无回弹 | 弱 |
| 模型选择器（8 钮） | hover | **下拉、档位切换全无按下态**（0 条 active） | 弱 |
| 图片缩略图 / 移除钮 | hover | 按下无回弹 | 弱 |
| 坞拖动（解锁后） | grab / grabbing 光标 + 跟手 | 强 ✓ | 强 |
| 坞升降（案头 ↔ 常驻） | 有动画 ? | — | 中 |
| 工作台（`paper-dock-jobs.css`：hover 8 / **active 0**） | hover | 按下无回弹 | 弱 |
| 发送 → 首个 token | 卷尾 **`.pp-quill` 7px 石青方点呼吸**（跑而无湿墨时渲染）+ 底缘呼吸线 + 停止钮 | 点太小、只有"在闪"没有"在长" | 弱 |

### 3.7 面板与浮层（`ShelfOverlay`、`ask-cards`、`overlay-base.css`）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 书架浮层（`shelf.css`：hover 4 / **active 0**） | hover | 开合动画 ?；按下无回弹 | 弱 |
| 提问卡（`prompt-shelf.css`：hover 10 / active 2） | hover + 按下 | 选项按下有回弹 ✓ | 中 |
| 浮层基座（`overlay-base.css`：hover 2 / active 1） | 递出动画（`--m-ink`） | 中 ✓ | 中 |
| 设置浮层 / 数据流浮层 | 同上 | — | 中 |
| Toast（`ToastHost.css`） | 入场/退场 + 自动消散 | 强 ✓ | 强 |

### 3.8 设置页（`settings-domain/`）

- `SettingsPanel.tsx` 11 钮、`ProviderDetail.tsx` 16 钮、`AddProviderSheet.tsx` 14 钮
- `settings-panel.css`：hover 9 / **active 0**；`provider-console.css`：hover 15 / **active 4**

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 页签切换（八页签） | `.is-on` + `allow-discrete`（出场） | 换景有过渡 ✓ | 中 |
| 提供方行（`pp-ob-btn`） | **active ✓** | — | 中 |
| 添加厂商（`pp-rail-add`） | **active ✓** | — | 中 |
| 测试连接（`pp-btn-test`） | **active ✓** | 测试中有"正在测"态 ? | 中 |
| 保存（`pp-save-btn`） | **active ✓** | — | 中 |
| 其他开关/输入（settings-panel.css） | hover | **按下无回弹**（0 条 active） | 弱 |
| 插件页（`PluginsPage.tsx` 5 钮） | hover | 同 settings-panel | 弱 |
| 保存确认 | "已保存 N 条请求头" / "已保存——重启后生效" | 有 ✓；但只在部分面 | 中 |

### 3.9 命令面板 / 搜索 / 快捷键（`app/CommandPalette.tsx`、`HelpSheet.tsx`）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| Ctrl+K 打开搜索 | 浮层递出动画 | 中 ✓ | 中 |
| 搜索结果行 | hover / 选中 | 键盘上下移动有选中态 ? | 中 |
| 快捷键本身（Esc / C / P / , 等） | **无任何视觉回执** | 按了没反应除非有可见结果 | 弱 |
| 斜杠面板（`/`） | 内联浮层 | 中 ? | 中 |

### 3.10 渲染器与文件查看器（`paper-renderers/`、`app/paper/viewers/`）

- `renderers.tsx` 11 个 button、`components.tsx` 6 个 button；`paper-inline.css`（hover 7 / **active 2**）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| `pp-pc-btn`（权限卡：允许/拒绝/反馈） | **`:active` 背景加深 + 1px 下压；主按钮转朱砂** | —— **唯一把"次级按钮"也做了按下态的组件** | **强** |
| `pp-md-img-zoom`（正文图放大） | hover ? | 按下无回弹 | 弱 |
| `pp-marginalia-toggle` / `pp-marginalia-pin` / `pp-marginalia-out`（旁注） | hover | 按下无回弹 | 弱 |
| `pp-user-image`（用户附图） | hover | 按下无回弹 | 弱 |
| PDF 查看器（`pdf.css`：hover 0 / **active 0** / transition 0） | 浏览器原生滚动 | **几乎零样式反馈** | 弱 |
| 3D 模型查看器（`model3d.css`：0/0/0） | three.js 交互 | 同 | 弱 |

**面结论**：**越危险的操作，按下态越全**——权限卡（Agent 要写盘）做全了，正文图片和旁注（纯浏览）一个都没做。
这不是疏忽，是优先级：安全操作被默认"不需要手感"。但这恰恰是"死板"的来源——**日常动作才是手感的绝大多数**。

### 3.11 插件窗口（`app/plugin-windows/`）

| 交互件 | 现有反馈 | 缺口 | 档 |
|---|---|---|---|
| 标题栏拖动 | `:active { cursor: grabbing }`（唯一一条） | 只有光标，无按下形变 | 弱 |
| 窗口按钮（关闭/最小化 ?） | hover | 按下无回弹 | 弱 |
| `PluginWindowFrame.tsx` 内的插件自绘内容 | 由插件自己负责 | 宿主无统一约定 | — |

### 3.12 全局（启动 / 加载 / 通知 / 错误 / 音效）

| 项 | 现状 | 档 |
|---|---|---|
| 冷启动 | 首页三态骨架 ✓ | 中 |
| 卷切换 | 260ms 视角飞行 + 落纸 | 强 |
| 错误 | `turn.failed` / toast 通道（错误不静默宪法） | 中 |
| 通知 | Toast 入场/退场/自动消散 | 强 |
| **音效** | **0** | 无 |
| 窗口控制（`WinControls`） | hover | 弱 |
| 插件窗口（`plugin-windows.css` active 1） | hover | 弱 |

---

## 4. 缺失清单（按严重度 × 成本排序）

> 严重度：A = 影响"活"的根；B = 明显但局部；C = 锦上添花。
> 成本：S = 半天内；M = 1-3 天；L = 需要设计决策。

| # | 面 | 问题 | 现在 | 应该 | 严重 | 成本 |
|---|---|---|---|---|---|---|
| 1 | 全局 | **次级按钮**按下态缺失 | 22 条 `:active` / 412 交互点；主按钮 + 权限卡已做对 | 把已有范式（背景加深 + 1px 下压）推到次级件 | **A** | S |
| 2 | 全局 | 几何过渡几乎为零 | 5 处几何 vs 54 处颜色 | 面板开合/坞升降/卡片展开走高度或位移 | **A** | M |
| 3 | 坞 | 首 token 前的等待黑洞 | 只有屏幕底缘一条呼吸线 | 纸上先落一枚墨点 / 墨在聚 | **A** | M |
| 4 | 块 | 工具完成无收束 | 勾 | 落印：沉一下 + 影收 | B | S |
| 5 | 全局 | `display` 硬切 353 处 | 元素瞬间出现 | 高频 20 处改离散过渡或高度动画 | B | M |
| 6 | 设置 | `settings-panel.css` 0 按下态 | hover only | 补 active | B | S |
| 7 | 模型选择器 | 0 按下态 | hover only | 补 active | B | S |
| 8 | 书架 | 0 按下态 | hover only | 补 active | B | S |
| 9 | 书脊/目次 | 0 按下态 | hover only | 补 active | B | S |
| 10 | 首页 | 24 钮 1 按下态 | hover only | 补 active；主按钮加力度 | B | S |
| 11 | 侧栏 | 21/22 钮无按下态 | 仅 `.ss-new` | 补齐 | B | S |
| 12 | 全局 | 无音效 | 0 | **是否要**需产品决策（见 §6） | C | L |
| 13 | 快捷键 | 无回执 | — | 按下时角标闪一下 / 或不做 | C | S |
| 14 | 块 | 多块同时入场无先后 | 同帧 | 块级 stagger（受控上限） | C | M |
| 15 | 画布 | 拖到边界无阻挡 | 硬止 | 边界吸附/阻尼 | C | M |
| 16 | 工具卡 | 长任务无进度 | 状态点 | 耗时读数 / 阶段名 | B | M |
| 17 | 首页 | 进入工作区是硬切 | 切换即换屏 | 纸铺开 / 淡出 | B | M |
| 18 | 侧栏 | 整理模式整面切换无过渡 | 瞬时 | 进出各 200ms | C | S |
| 19 | 全局 | 滚动无平滑/惯性 | 浏览器默认 | 是否要需决策（工具类应用常刻意关） | C | L |
| 20 | 全局 | 焦点环有 45 处，但不统一 | — | 收编到统一 focus token | C | S |

---

## 5. 附注

### 5.1 兰台已经做对的（别推倒）

> **体检初版的两处误判（2026-11-17 第二批施工时勘察更正）**：静态扫描看不见
> TSX 条件渲染出来的运行时元素，也看不见相位机——
> ① **落笔点一直在**（`PaperPanel.tsx` 的 `.pp-quill`：卷在跑且尾部无湿墨时渲染，
>    卷尾 7px 石青方点呼吸）。初版写"只有屏幕底缘一条线"是错的；
> ② **面板开合不是硬切**（`DockPanel.tsx` 的 open/leaving/closed 三相位机 +
>    `[data-panel-leaving]` 退场过渡，2026-10-16 已立）。§4 #5 的「353 处 display
>    切换」是**元素数**不是**缺陷数**——核心开合面大多已有相位或过渡。

- **画布动效族**：拿纸（影过冲）、朱笔划界、落纸/起纸、冻帧、余波——是全产品最成熟的一套。
- **手势**：拖块跟手零缓动、钉住盖章、引线溯源——"手感来自微伏不来自粗细"这条判例。
- **Toast**：入场/退场/消散齐全。
- **按下态范式（三处，写法已统一）**：`.sh-btn-primary:active` / `.ss-new:active`（主按钮：背景转朱砂 + 1px 下压）、
  `.pp-pc-btn:active` + `.pp-pc-btn--primary:active`（权限卡：次级加深、主按钮转朱砂）——
  **权限卡是唯一把次级按钮也覆盖了的组件**。范式成熟，缺的是推广。

### 5.2 与"类游戏"的差距不在特效

游戏的"活"来自四件事：**每一下都有回弹、每一段都有节奏、每一次都有因果、每一下都有声音**。
兰台前三件只做了局部，第四件为零。但加音效是**产品决策**（工具类应用加音效有风险），不是技术活。

### 5.3 刻意的硬切（不是缺陷，别乱改）

- **块折叠/展开**：§15 明确拒绝高度过渡（虚拟化重挂会反复播，且布局成本高）。
- **虚拟化平移**：流区随视口卸载/重挂，任何入场动画都会"凭空浮现"（`@starting-style` 已被判死）。
- **冷启动整批**：满屏纸一起淡入会被读成一次闪，故首帧整批算"已落纸"。
- **纸体位移**：纸律——纸纹按坐标铺，墨迹层另一套坐标，纸一移即错位。

### 5.4 证据出处

- CSS 统计：`src-ui/src/**/*.css`（57 文件），2026-11-17 快照。
- TSX 交互面：`src-ui/src/**/*.tsx`（88 文件）。
- 历史报障：`docs/plans/paper-shell/taste-ledger.md`（2026-09-10 拿纸批、2026-09-18 出处引导批、
  拖动锁条、2026-08-22 全弃批）。
- 刻意硬切：`docs/design/lantai-design-spec.md` §15、`paper-base.css` 卷开合段。

---

## 6. 建议的三批

**第一批（补课，不需要美学决策）**
#1 按下态、#6 #7 #8 #9 #10 #11 各面补齐。目标：全产品高频件 100% 有按下回弹。

**第二批（体感，需要小决策）**
#2 几何过渡 20 处、#3 等待期落笔、#4 完成落印、#17 进入工作区。

**第三批（可选）**
#12 音效（需产品拍板）、#14 块 stagger、#15 边界阻尼、#16 长任务进度。

---

## 7. 附录：交互件全量索引（按按钮数）

> 只列有 `<button>` 的文件（另有 165 个非 button 点击面未逐一列，分布同上）。
> `hover / active / transition` 取对应 CSS 文件的规则条数（一条规则可覆盖多个元素）。

| TSX 文件 | 按钮 | 对应 CSS | hover | active | transition |
|---|---|---|---|---|---|
| `sessions-home/SessionsHome.tsx` | 24 | `home.css` | 15 | **1** | 10 |
| `canvas-nav/SessionSidebar.tsx` | 22 | `session-sidebar.css` | 19 | **1** | 16 |
| `settings-domain/ProviderDetail.tsx` | 16 | `provider-console.css` | 15 | 4 | 13 |
| `settings-domain/AddProviderSheet.tsx` | 14 | `provider-console.css` | 15 | 4 | 13 |
| `ask-cards/PromptShelf.tsx` | 13 | `prompt-shelf.css` | 10 | 2 | 10 |
| `settings-domain/SettingsPanel.tsx` | 11 | `settings-panel.css` | 9 | **0** | 12 |
| `paper-renderers/renderers.tsx` | 11 | `paper-inline.css` | 7 | 2 | 4 |
| `paper-shell/PaperPanel.tsx` | 10 | `paper-ops.css` | 17 | 4 | 12 |
| `compose-dock/composer-rows.tsx` | 9 | `paper-dock-tools.css` | 10 | 3 | 4 |
| `paper-shell/ShelfOverlay.tsx` | 8 | `shelf.css` | 4 | **0** | 1 |
| `compose-dock/ModelSelector.tsx` | 8 | `model-selector.css` | 6 | **0** | 5 |
| `renderers/components.tsx` | 6 | — | — | — | — |
| `settings-domain/UpdateSection.tsx` | 5 | `settings-panel.css` | 9 | 0 | 12 |
| `settings-domain/PluginsPage.tsx` | 5 | `settings-panel.css` | 9 | 0 | 12 |
| `paper-shell/paper-panel-parts.tsx` | 5 | `paper-ops.css` | 17 | 4 | 12 |
| `compose-dock/sheet-parts.tsx` | 5 | `paper-composer.css` | 7 | **0** | 6 |
| `compose-dock/WorkLedger.tsx` | 5 | `paper-dock-jobs.css` | 8 | **0** | 5 |
| `app/paper/viewers/pdf.tsx` | 5 | `pdf.css` | **0** | **0** | **0** |
| `settings-domain/ProviderDocCard.tsx` | 3 | `provider-console.css` | 15 | 4 | 13 |
| `settings-domain/ModelReasoningLevels.tsx` | 3 | `provider-console.css` | 15 | 4 | 13 |
| `renderers/viewers/epub.tsx` | 3 | — | — | — | — |
| `paper-shell/EnteringSheet.tsx` | 3 | `entering-sheet.css` | 2 | 0 | 3 |
| `compose-dock/goal-strip.tsx` | 3 | `paper-dock-jobs.css` | 8 | 0 | 5 |
| `app/paper/viewers/model3d.tsx` | 3 | `model3d.css` | **0** | **0** | **0** |
| `app/WinControls.tsx` | 3 | `shell.css` | 5 | 0 | 2 |

**读法**：active 为 0 的每一行 = 该面所有按钮按下去都没有回弹。共 **8 个面为 0**（设置页、书架、模型选择器、作坊、工作台、PDF、3D、窗口控制）。

---

*本报告未做真机逐点。建议第一批落地后，再对"等待期"与"完成收束"做一次真机录像复核。*
