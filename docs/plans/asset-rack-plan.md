# 图版架（资产收纳面）· 施工单

> 立项 2026-09-23 · 状态：**设计已拍板（丙 · 匣下横架），待施工**
> 设计真源：[`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §9.5（几何、三案对照、语汇、归属、判据）
> 原型真源：[`../../prototype/asset-rack-v2.html`](../../prototype/asset-rack-v2.html) + [`asset-rack-v2.NOTES.md`](../../prototype/asset-rack-v2.NOTES.md)（真样式台，真几何读数）
> 触发原话：「Agent 产出的 kind 资产直接渲染到聊天流里，其实不好用……我觉得放在创作坞是对的，
> 我觉得需要单独再设计一个收纳的地方，不然全部挤在右下角也不是很舒服」→「再做一版把横架放在坞下面的」→ 拍板丙。

## 0. 一句话

**在创作坞下缘挂一条 `880×38` 的图版架，收本卷全部 kind 资产（物类签 + 题名）；
点 = 飞到流里那一块、拖出 = 钉到纸上、hover = 认脸；流里的图版卡默认收成一行签条。**

## 1. 定案摘要（用户拍板）

| # | 定案 | 依据 |
|---|---|---|
| **D1** | 位置 = **坞下横架**（甲·匣顶 / 乙·匣左 / 丙·匣下 三案择丙） | 真几何对照：丙吃「流锚以下 96px 空白页边」⇒ 零遮挡 + 让位带零变化 + 题名可读（§9.5 表） |
| **D2** | 兜底 = **架在时「最底缘」吸附位 8 → 46**（不翻面） | 翻到匣顶＝当场变甲案（盖纸尾）；顺延架高则架永在匣下、阅读位置一致 |
| **D3** | 流内图版卡**默认收成一行签条**，**钉住态豁免** | 否则架上一份、流里一大坨＝双份；钉是人工挑出来的收藏，默认该张着 |
| **D4** | **钉出去 = 拿出来**：拖出钉住的签条**离架**（不再在架上留记号）；拔钉收回 ⇒ 回架；**架内零张 ⇒ 整条退场** | 用户二次拍板原话「拖出钉住的签条，就不要继续在横架里面了，拖出来钉住就等于"拿出来"了」；连带「已钉」记号整条消失，架读数 = 「本卷还有什么没摆出来」 |

## 2. 批次

### B1 · 架面（产物流：compose-dock）

| 项 | 落点 |
|---|---|
| 新组件 `AssetRack` | `src-ui/src/plugins/builtin/compose-dock/AssetRack.tsx`（与 `InkLedger.tsx` / `WorkLedger.tsx` 同族） |
| 挂载位 | **本插件第三条贡献行**（`compose-dock/index.ts` 注册 `id: 'asset-rack'`，slot `composer`）——坞槽渲染器对每条贡献各出一个**直接子元素** ⇒ 架的 DOM 位天然就是 `.pp-composer` 的**兄弟**（`position:absolute; top:100%; left/right:0`，不进 `.pp-composer-slot` 量高盒）。施工裁定（回执）：原案「ComposerDock 返回 fragment 带出兄弟」要 1400 行坞 JSX 整体重排（formatter 权威 ⇒ 一片缩进 diff），同一 DOM 结果取小 diff；附带收益 = 两件家具各包一层 PluginBoundary（坞崩架还在，实测见 tests/composer-dock-rack） |
| 样式 | `PaperPanel.css` 新增 `.pp-rack*` 段（板面 = `color-mix(--paper-deep 58%, --paper)` + 上下发丝线 + 受光缘高光；签条**不套方框**；hover = 题名转重墨 + 朱砂底规线） |
| 数据面 | 判据真源 = 新宿主模块 `src/paper/asset-rack.ts`（`inRack` / `rackBlocksOf` / `rackPresent` / `RACK_CAP`）——**架自己与槽主人吸附表同用一句**（两处各写一遍判据就是两份真源）。架读 `usePaperRegion().regions`（**裸 context 容缺读**：宿主不给 = 不渲染），**入架判据一条**：`b.asset != null && b.state !== 'pinned'`；序 = 流转序，至多 6 张 + 「… 另 N 张」（N 只数架内） |
| 空态 | **架内零张** ⇒ **整条不渲染**（全钉出 / 本卷零资产同一条规则）；无活跃卷 ⇒ 不渲染（同墨量册/役册的无主待命纪律） |

### B2 · 手势三条 + 兜底

| 项 | 落点 | 语义 |
|---|---|---|
| 单击 | `usePaperDock().flyToPoint(sessionId, blockWorldY)`（worldY = `RegionView.layout.get(id)?.y`，兜底 `regionBottom`）+ 能力位 `expandBlock(blockId)` | 飞到流里那一块；若该块处于收起态则连展开 |
| 拖出 | 复用既有钉手势语义（`use-paper-drag` 新增 `onRackPinMouseDown`，经能力位 `dragBlockOut` 递给架） | 钉到纸上；**松手落钉后该签条从架内移除、后续签条递补**（"拿出来"语义，D4） |
| 收回 | 复用既有拔钉路径（流内「已移出 · 点击恢复」/ 钉上「收回」钮） | 拔钉 ⇒ 签条**回架**（原位、顺序归位） |
| hover | 组件内（原生 title：题名完整 + `kind · presentation · 序` + 到架/更新时刻） | 认脸。**「时间」= 架上观察时刻**（块与消息都不带时间戳，本批不新增通道）——诚实标注，不编造资产时刻 |
| 兜底 | `paper-shell/composer-float.ts` 的 `snapComposerPos` **与** `clampComposerPos` | 吸附表与夹紧下限按「架在否」取 `[46, 96]` / `[8, 96]`（架在 = 有活跃卷且架内非空；判据同源 `paper/asset-rack.ts`）。**下限一并抬**：吸附阈 24 < 架高 38，只改吸附表仍停得住被切位（见设计规范 §9.5 兜底段补记） |

### B3 · 流内收成签条（对 `paper/fold.ts` 的**显式规格变更**）

| 项 | 落点 | 语义 |
|---|---|---|
| 纳入折叠族 | `paper/fold.ts`：`isFoldable` 认资产 kind（判据 = 块带 `asset` 元数据） | 现行文件头「其余 kind 不可折叠」一行**同批改写** |
| 默认收起 | `defaultFolded`：`asset != null` ⇒ `true`；`state === 'pinned'` ⇒ `false`（豁免） | 钉住的张着 |
| 折叠行文案 | `foldLabel`：出「物类签 + 题名」（`plateSignOf` + `asset.title`） | 需把 `block`（而非仅 payload）传进去，签名同批改 |
| 测高 | `paper/measure.ts` 加资产折叠分支 → `FOLD_ROW_H` | 折叠/展开已入 `measureSignature` 与 `observedKeyOf`，无需新机制 |

### B4 · 文档面与门禁

- 设计规范 §9.5 **已落**（本批立项同批写入）；本文件进 `docs/plans/README.md` 活跃线表；
  竣工后按纪律「竣工即归档」进 `docs/archive/` 并补 `HISTORY.md`。
- 生成物：本次**不动模型可见工具面 / 组合层** ⇒ `doc-sync` 只跑不改（若 `gen:doc-facts` 有数字漂移以重跑为准）。

## 3. 判据（测试清单）

| 文件 | 用例 |
|---|---|
| `tests/composer-dock-rack.test.tsx`（新） | 架是 `.pp-composer` 的兄弟且 `top:100%`；**`.pp-composer-slot` 实测高不含架**（让位带 227 不变）；空态（**架内零张**）零渲染；6 张 + 「另 N 张」（N 只数架内）；单击 → `flyToPoint` 到对应块；`update_asset` 广播 → 该签条出石青点；**拖出钉住 ⇒ 该签条离架且「另 N 张」随之**；**从流内文类签钉出 ⇒ 同样离架**（判据一条）；**拔钉收回 ⇒ 签条回架且序归位**；**全钉出 ⇒ 整条退场** |
| `tests/composer-float.test.ts`（扩） | 吸附表：架在 ⇒ `bottoms = [46, 96]`；架不在 ⇒ `[8, 96]`（纯函数逐值 + 与 CSS `--composer-rise` 对拍） |
| `tests/asset-fold.test.ts`（新） | 资产纳入折叠族：默认收起 / 钉住豁免 / `foldLabel` 出签与题名 / `measureBlockHeight(folded)` = `FOLD_ROW_H` / 折叠态入 `measureSignature`（切换必重测） |
| `tests/paper-visual-decisions.test.ts`（扩） | `.pp-rack` 段不出现裸色值（墨阶三级各就各位，同 `asset-ink-tiers` 纪律）；签条无边框（反向钉值） |

## 4. 门禁（不过不 commit）

```
cd src-ui && npx vitest run
cd src-ui && npm run build
cd src-ui && npx biome ci .        # 0/0 保持
cd src-ui && npm run doc-check     # 文档面（本批动了 docs/design + docs/plans）
```

**不需要**：`verify:convergence`（不动 `agent/**` 与 `composition/**`、不动工具契约）、`cargo test`（壳与引擎零改动）。

## 5. 部署面（诚实栏）

**零 `faceDeps` 新增**：架只消费既有上下文（`usePaperRegion().regions` 取块与 `asset` 元数据、
`usePaperDock().flyToPoint` 跳转），吸附表改动在 `paper-shell` 产物内 ⇒ **只换产物热更即可，不必重建 exe**。
`src-ui/src/plugins/host-surface.baseline.json` **零漂移**（`tests/host-surface-seal.test.ts` 是考官）。

## 6. 真机验收（owner：用户）

1. **架在不在该在的地方**：坞下一条，压在空白页边上、正文一个字不遮（对照 §9.5 的丙案）；
2. **匣拖到最底**：架仍完整可见（吸附位顺延 46 生效），不出现「架被屏缘切掉半截」；
3. **匣拖到别处**（左/右缘、半屏）：架跟着匣走，让位带与右下角家具（小地图/递牒卡/插件坞/目次带映射区）不抖；
4. **点一张签条**：视口飞到流里那一块并展开（不是空跳、不是跳到别块）；
5. **拖一张签条到纸上**：成钉、**该签条随即从架上消失**（不是变灰、不是留记号），后续签条递补、无空位残影；
6. **钉住的张着**：源卷收起后钉仍在、`update_asset` 后钉与自己同刷；**拔钉（收回）⇒ 签条回到架上原位**；
7. **全钉出**：架内一张不剩时**整条退场**（案上看得见钉，不存在"资产不见了"）；
8. **流内形态**：新出的图版卡默认是一行签条（签 + 题名），点开就地展开；**钉住的默认张着**；
9. **空态**：新建卷（零资产）时架整条不出现，坞位与让位带与今日逐像素一致。

## 7. 不做（本批排除）

- **点开就地浮出大图预览**（架上的看图面）——留作后续按需加，本批点 = 飞回块；
- **架的横向滚动 / 折行**（溢出只报「… 另 N 张」）；
- **跨会话 / 工作区级资产架**（资产是会话作用域；跨会话引用仍属未来课题）；
- **架上的排序 / 过滤 / 检索**（先有面，再谈治理）；
- **乙案的窄窗兜底**（未选乙，不做）。

## 8. 施工回执（2026-09-23，B1-B3 已落，待真机验收）

| 项 | 结果 |
|---|---|
| 落点裁定 | 架 = 本插件**第三条贡献行**（非 ComposerDock fragment）——同一 DOM 位、小 diff、两件家具各包一层边界（理由见 §2 B1 挂载位格） |
| 接口面 | 宿主面**零漂移**（`tests/host-surface-seal` 绿）：`PaperRegionContext` 键早在册，仅新增使用面；两个手势走 `PaperDockContext` 的**能力位**（optional 字段，同 `composerLock` 先例）——宿主不给 = 该手势不发生 |
| 判据 | `tests/composer-dock-rack.test.tsx`（9 例，真 PaperPanel + 真装本插件）/ `tests/asset-fold.test.ts`（9 例）/ `tests/composer-float.test.ts` 扩（吸附表逐值 + 架高与 CSS 对拍）/ `tests/paper-visual-decisions.test.ts` 扩（`.pp-rack` 段裸色扫描 + 签条不套方框反向钉值） |
| 行为变更（用户可感知） | 流里的**资产块默认收成一行签条**（signature 扩末参 `block`；`foldLabel` 出「物类签 + 题名」）；坞「最底缘」吸附位/夹紧下限在架在时 8 → 46 |
| 未了 | §6 九条**真机验收**（owner：用户）；验收过后按「竣工即归档」移入 `docs/archive/` 并补 `HISTORY.md` |
