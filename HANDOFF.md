# 兰台前端 · 交接说明（HANDOFF）

> 设计已定稿（原型 → 兰台注疏方向）。本包共 4 个文件，下面是每个文件放哪、怎么用、按什么顺序落地。

---

## 一、文件 → 放置位置

| 文件 | 内容 | 放到 | 动作 |
|---|---|---|---|
| `holo-paper.html` | 高保真原型（注疏版式全貌，可交互） | `prototype\lantai.html` | 放进去做**设计参考**，不动产品代码 |
| `lantai-design-spec.md` | 设计规格书（锁定的决策 + 块映射 + 术语） | `docs\design\lantai-design-spec.md` | 放进去做**契约** |
| `lantai-tokens.css` | 设计 token（矿物墨色 + 四体字体） | `src-ui\src\app\tokens.css` | **覆盖**（先备份旧的） |
| `HANDOFF.md` | 本文 | 仓库根目录 `HANDOFF.md` | 交接说明 |

---

## 二、落地顺序（按此执行）

### 第 0 步 · 备份
```
src-ui\src\app\tokens.css  →  tokens.obs.css（旧的 --obs-* 观测台暗色，先留底）
```

### 第 1 步 · 换 token
用 `lantai-tokens.css` 覆盖 `src-ui\src\app\tokens.css`。
（token 文件里已附 `--obs-* → 兰台` 的迁移对照表，方便全局替换。）

### 第 2 步 · 换字体
编辑 `src-ui\src\app\fonts.ts`，整段替换为：

```ts
// 兰台字体（P0 自托管）—— 宋体正文 / 楷书手迹 / 等宽机读
import '@fontsource-variable/eb-garamond/standard.css';
import '@fontsource-variable/eb-garamond/standard-italic.css';
import '@fontsource/ma-shan-zheng/400.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/600.css';
import '@fontsource/noto-serif-sc/700.css';
```

装 3 个新包（其余退役的 fraunces / lxgw-wenkai / jetbrains-mono 可留可删）：

```bash
npm i @fontsource-variable/eb-garamond @fontsource/ma-shan-zheng @fontsource/ibm-plex-mono
```

> ⚠️ fontsource v5 的 import 子路径（`standard.css` / `400.css`）沿用你现有 `fonts.ts` 的写法；装完若路径报错，以 `node_modules/@fontsource-*/` 里的实际文件名微调即可。

### 第 3 步 · 重排纸面板（PaperPanel.css）
目标：灰框 → 注疏。`src-ui\src\app\panels\PaperPanel.css` 里的 `.pp-*` 类按 `lantai-design-spec.md §4` 重排七类块：
- `.pp-block` 默认**透明、无边框**（不再是灰框卡片）；
- 按 kind 分体分色：`user`→楷书+朱砂红批线、`markdown`→宋体 17px、`reasoning`→石墨虚线勾边、`tool`→石青注线小字、`diff`→3px 硬线图版、`plan`→顶硬线+石青序号、`notice`→贴黄。

（下一步我可以直接产出完整的 `PaperPanel.lantai.css`，你说一声。）

### 第 4 步 · 新屏换皮
- 案卷首页（`SessionsHome`）与设置（`SettingsPanel`）换兰台皮；
- 术语见 `lantai-design-spec.md §5`：会话→案卷、新建会话→新建案卷、发送→拟文。

### 第 5 步 · 亭台图标
把 `holo-paper.html` 里的 `<symbol id="icon-lantai">` 落成 favicon / 应用图标（SVG 已就绪，可复用）。

---

## 三、关键决策速查（不许回退）

- **范式**：注疏横排（正文居中 / 批注列边 / 夹注缩进 / 脚注贴底），文字全程横排。
- **字体**：宋体正文（Noto Serif SC + EB Garamond）、楷书手迹（Ma Shan Zheng，**只给来文**）、等宽（IBM Plex Mono）。
- **墨色铁律**：朱砂＝人 / 石青＝机 / 石墨＝草稿 / 墨＝正文。
- **块映射**：`user`→来文 / `markdown`→正文 / `reasoning`→夹注 / `diff`→抄录 / `tool`→脚注 / `plan`→拟策 / `notice`→贴黄。
- **术语**：会话→案卷。
- **好消息**：`paper/block-model.ts` 的 `BlockKind` 已和注疏六类一一对应，**数据模型与 `translate.ts` 零改动**，只改渲染层（壳 + 块体渲染器）。

---

*原型 `holo-paper.html` 即设计规格的视觉真相，落地时以它为准绳，不必追求像素级还原。*
