# 兰台前端 · 落地交接（给接手 Agent）

> 设计已定稿。本文是「照着做」的入口；详细契约见同目录 `lantai-design-spec.md`。

## 文件地图

| 文件 | 作用 |
|---|---|
| `docs/design/lantai-design-spec.md` | 设计规格书（锁定决策：注疏版式 / 字体 / 墨色 / 块映射 / 术语） |
| `docs/design/lantai-tokens.css` | token 参考（用于替换 `src-ui/src/app/tokens.css` 的 `--obs-*`，附迁移对照） |
| `prototype/lantai.html` | 高保真原型（视觉真相，本地预览用；`prototype/` 已被 gitignore） |

## 落地清单（按序执行）

1. **换 token**：用 `lantai-tokens.css` 的内容替换 `src-ui/src/app/tokens.css`（先备份旧的为 `tokens.obs.css`）。
2. **换字体**：装 3 个包，改 `src-ui/src/app/fonts.ts`：
   ```bash
   npm i @fontsource/eb-garamond @fontsource/ma-shan-zheng @fontsource/ibm-plex-mono
   ```
   新增 import：`@fontsource/eb-garamond/{400,500,600,400-italic}.css`、`@fontsource/ma-shan-zheng/400.css`、`@fontsource/ibm-plex-mono/{400,500}.css`；退役 fraunces / lxgw-wenkai / jetbrains-mono。
3. **重排纸面板**：`src-ui/src/app/panels/PaperPanel.css` 灰框 → 注疏（七类块见 spec §4）。
4. **新屏换皮 + 术语**：`SessionsHome`（案卷首页）、`SettingsPanel`（设置）；术语替换见 spec §5。
5. **亭台图标**：`prototype/lantai.html` 里的 `<symbol id="icon-lantai">` 落成 favicon / 应用图标。

## 关键决策（不许回退）

- **注疏横排**：正文居中 / 批注列边 / 夹注缩进 / 脚注贴底，文字全程横排。
- **字体**：宋体正文（Noto Serif SC + EB Garamond）、楷书手迹（Ma Shan Zheng，只给来文）、等宽（IBM Plex Mono）。
- **墨色铁律**：朱砂＝人 / 石青＝机 / 石墨＝夹注 / 墨＝正文（「草稿」语义走虚线，不占颜色；2026-09-16 口径订正）。
- **块映射**：`user`→来文 / `markdown`→正文 / `reasoning`→夹注 / `diff`→抄录 / `tool`→脚注 / `plan`→拟策 / `notice`→贴黄。
- **术语**：会话→案卷、新建会话→新建案卷、发送→拟文。

## 重要提示

- **数据模型零改动**：`src-ui/src/paper/block-model.ts` 的 `BlockKind` 已与注疏六类一一对应，`translate.ts` 不用动，只改渲染层（壳 + 块体渲染器）。
- 锁的是「决策」，不是像素：字号/间距/图标/hover 态可在真环境再磨。
