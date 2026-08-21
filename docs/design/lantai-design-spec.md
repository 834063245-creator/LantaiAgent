# 兰台前端 · 设计规格书（v1 · 落地前置）

> 本文是 `holo-paper.html` 原型锁定的设计决策，供 `src-ui` 工程落地对照。
> **「已锁定」是契约，落地时不许回退；未列出的像素细节（字号/间距/图标形状/hover 态）可在真环境再磨。**

---

## 0. 一句话定位

**兰台＝汉代皇家档案典籍库。** 产品不再是「聊天窗」，而是**一部正在被编纂的案卷**——人在纸边批注、AI 居中撰文、机器贴底注记。核心是把「等权消息流」换成「注疏层级」。

---

## 1. 版式范式（已锁定）

**注疏横排**。文字全程横排（代码、英文、URL 不折行），但骨架是古籍注疏的层级，不是聊天气泡：

- **正文**（答 / 策）居中，是案卷的「经文」，宋体、大一号（17px 起，行距 2.0）；
- **来文**（问）是人的批注，楷书 + 朱砂，左侧 2px 红批线；
- **夹注**（思）缩进列边（约 86% 宽），石墨铅笔，小一号，虚线勾边；
- **脚注**（器）贴底小字，上方一道 44px 石青注线引出；
- **抄录**（码）栏内图版（3px 硬左线 + 上下规线 + 米黄底）；
- **卷首**：亭台图标（`#icon-lantai`）＋ 卷次 ＋ 标题 ＋ 日期 ＋ 朱砂短横；
- **界栏**：正文列左右各 1px 栏线（`--rule-strong`），页边注在左栏外；
- **印章**：朱砂「蘭臺」二字竖排印，作品牌签名。

---

## 2. 字体系统（已锁定）

| 角色 | 中文 | 英文 | fontsource 包 | 备注 |
|---|---|---|---|---|
| 宋体（正文/标题） | Noto Serif SC | EB Garamond | `@fontsource/noto-serif-sc` ＋ `@fontsource-variable/eb-garamond` | 宋体 + 16 世纪旧书衬线对偶 |
| 楷书（手迹） | Ma Shan Zheng（马善政楷书） | EB Garamond | `@fontsource/ma-shan-zheng` | 只用于「人的」来文 |
| 等宽（机读） | — | IBM Plex Mono | `@fontsource/ibm-plex-mono`（或 variable） | 代码 / 工具 / 编号 |

字体栈（CSS 直抄）：

```css
--f-song: "EB Garamond", "Noto Serif SC", "Songti SC", serif;
--f-kai:  "Ma Shan Zheng", "EB Garamond", "Kaiti SC", "STKaiti", serif;
--f-mono: "IBM Plex Mono", "Cascadia Code", "Consolas", monospace;
```

**`src/app/fonts.ts` 变更**：
- 新增：`eb-garamond`（variable）、`ma-shan-zheng`、`ibm-plex-mono`；
- 退役：`fraunces`、`lxgw-wenkai`、`jetbrains-mono`；
- 保留：`noto-serif-sc`。

> 关键纪律：**英文思考链用 EB Garamond，不是手写体**。夹注（reasoning）是模型的英文思考，走 `--f-song`（宋体/Garamond）；楷书只给「人的来文」。

---

## 3. 墨色系统（已锁定 · 矿物颜料）

| token | 值 | 语义 | 用在哪 |
|---|---|---|---|
| `--ink-1` | `#26221C` | 松烟墨（正文） | 答 / 策 / 码正文 |
| `--ink-2` | `#55503F` | 次级墨 | 规线 / 次级文字 |
| `--ink-3` | `#8A8172` | 三级墨 | 注记 / 页码 |
| `--ink-4` | `#B5AC9A` | 弱规线 | 分隔 |
| `--seal` | `#A63A2E` | 朱砂（人的批改） | 印章 / 来文 / 圈点 / 朱批 |
| `--seal-deep` | `#8C2F26` | 朱砂深 | 来文文字 |
| `--indigo` | `#3A5B7A` | 石青（机器/仪表） | 脚注 / 拟策序号 / diff 新增 |
| `--graphite` | `#6F6E68` | 赭石（铅笔草稿） | 夹注 / 擦改 / diff 删除 |
| `--paper` | `#F6F1E7` | 纸面 | 画布 / 页面底 |
| `--paper-deep` | `#EFE8DA` | 深纸 | 输入条 / 图版底 |
| `--paper-margin` | `#EDE5D5` | 页边 | 舞台底色 |

语义状态（保留原 `--pass/--warn/--fail` 语义，降饱和到矿物色）：`--pass #5E7A55`、`--warn #B0782E`、`--fail #A9443F`。

**一条铁律：朱砂 = 人，石青 = 机，石墨 = 草稿，墨 = 正文。** 不许换义。

---

## 4. 块类型映射（已锁定）

现有 `paper/block-model.ts` 的 `BlockKind` 无需改动，只改渲染层视觉：

| BlockKind | 文类签 | 字体 | 墨色 | 视觉 |
|---|---|---|---|---|
| `user` | 来文 | `--f-kai` | `--seal-deep` | 左 2px 红批线 + 圈点关键词 |
| `markdown` | 正文 | `--f-song` | `--ink-1` | 17px / 行距 2.0，居中主角 |
| `reasoning` | 夹注 | `--f-song`（英文走 Garamond） | `--graphite` | 86% 宽、虚线勾边、擦改痕迹 |
| `diff` | 抄录 | `--f-mono` | `--ink-1` | 3px 硬左线 + 米黄底图版，add 石青 / del 石墨 |
| `tool` | 脚注 | `--f-mono` | `--indigo` | 44px 注线 + 11–11.5px 小字 |
| `plan` | 拟策 | `--f-song` | `--ink-1` | 顶硬线 + 石青序号 |
| `notice` | 贴黄 | `--f-song` 小字 | `--warn` | 系统通知（建议作「贴黄」纸条） |

> `notice`（系统通知）原型未覆盖，建议按「贴黄」（古代奏章上贴的黄纸条）处理：小字、土黄底、一条弱规线，与正文明确区分。

**文类签（页边注）**：来文 / 正文 / 夹注 / 脚注 / 抄录 / 拟策（贴黄），配机读码 `USER / AGENT / THINK / TOOL / CODE / PLAN`。

---

## 5. 术语表（已锁定）

| 旧 | 新 |
|---|---|
| 会话 | 案卷 |
| 新建会话 | 新建案卷 |
| 发送 / 向 Agent 写字 | 拟文 |
| 星图 / 依赖图 | （退役，不再作为用户可见卖点） |
| 工作台 | 兰台 |

---

## 6. 交互（保留既有，只重排视觉）

无限画布 + 钉住 / 收回 + 小地图 + 抽纸条，已在 `PaperPanel.tsx` 与 `paper/` 内核实现。**逻辑零改动**，只做视觉重排。已修过的手感（抓取偏移按实际渲染位反推、防跳变）保留。

---

## 7. 锁 vs 放

**锁（契约，落地不许回退）**：注疏范式、字体栈、墨色语义、块类型映射、术语、钉住手势、界栏/印章/亭台图标。

**放（真环境再磨）**：精确字号与行距、图标形状、hover/focus 态、空态 / 加载 / 流式 / 错误态、擦改痕迹浓淡、界栏粗细、notice「贴黄」的具体样式。

---

## 8. 落地清单（前置工作）

- [ ] `src/app/tokens.css` 换成 `lantai-tokens.css`（`--obs-*` 退役或并行过渡）
- [ ] `src/app/fonts.ts` 换字体（见 §2）
- [ ] `src/app/panels/PaperPanel.css` 按 §4 重排七类块（灰框 → 注疏）
- [ ] 块体渲染器（`composition/renderer-service` 的 `resolveRenderer`）按文类换墨色/字体
- [ ] 新屏：案卷首页（SessionsHome）与设置（SettingsPanel）换兰台皮
- [ ] 亭台图标 `#icon-lantai` 落成 favicon / 应用图标
- [ ] 文案全局替换（§5 术语表）

---

*原型文件：`holo-paper.html`；token 文件：`lantai-tokens.css`。*
