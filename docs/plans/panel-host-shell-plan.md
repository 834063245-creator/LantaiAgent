# 面板宿主壳 + 架阁升格（施工单）

> **状态**：**代码已落地**（2026-11-21 立并实现；用户拍板「一批做完」+「架阁搬出纸壳」+「视觉面后面单独立项」）。
> 待办：canvas-nav 两块面板的 `frame:'self'` 已有声明，但**真机走查**（互斥两态 / 拖拽调宽 / 纸开合联动）尚未做。
> **来由**：`D:\\research\\research-system\\docs\\issues\\lantai-plugin-panels-no-home.md`——
> 插件 `ctx.panels.register()` 能注册、能 `openPanel`，但壳里没有落点（`DockRail` 随 V5 拆除，
> `side` 字段从此零消费者，第三方插件裸挂文档流 ⇒ 永远不可见）。
>
> **一句话**：给 `panels` 通道补上「宿主端」——壳出盒子（`DockSlot`），架阁出入门。

## 0. 决定

| 项 | 决定 | 理由 |
|---|---|---|
| 几何归谁 | **归壳**（`frame: 'shell'`，缺省） | `ctx.overlays` / `ctx.rootViews` 都是这个形状且都能用；`panels` 是唯一例外 |
| 自持定位的面板 | `frame: 'self'` 显式声明 | 书脊列 / 案卷侧栏是家具不是面板（自带书眉、拖拽调宽、互斥两态）；给它们套通用壳 = 双书眉 |
| 入口 | **架阁**（唯一出口） | 架阁已是插件窗口的门；面板是同一件事的另一半 |
| 架阁归属 | 出纸壳 → `ctx.rootViews` 的 `'overlay'` 槽 | 架阁自述「随时可开的查询面」，纸关着时不存在 = 自己没兑现承诺 |
| 视觉精度 | **本批不做**，单独立项 | 用户 2026-11-21 拍板 |

## 1. 契约变更（v63 → v66）

`composition/services.ts` 的 `PanelContribution` 与 `app/panels/panel-def.ts` 的
`PanelDef` 同批各增两个**可选**字段（v57 `animateExit` 的同款形状——两处是
「贡献面 / 消费面」一对，合流时 `panelDefs()` 原样透传）：

```ts
/** 壳形态：'shell'（缺省）= 壳给盒子；'self' = 面板自持定位与 chrome。 */
frame?: 'shell' | 'self';
/** 面板宽度（px）。缺省 = fit-content（内容撑开，兜底带 260px～45vw）。 */
width?: number;
```

**向后兼容**：旧插件不声明 ⇒ `frame` 缺省 `'shell'` ⇒ **从「不可见」变成「可见」**，
零迁移（这正是本版要的）。

## 2. 批次

### 批 1 · 宿主壳（`DockSlot`）

| 文件 | 动作 |
|---|---|
| `src/app/panels/DockSlot.tsx` | 新增：盒子 + 书眉（标题 / 关闭钮）+ `PluginBoundary` |
| `src/app/panels/dock-slot.css` | 新增：`position: fixed` 贴左/右缘、`--z-dock-panel`、宽度兜底带 |
| `src/app/panels/DockPanel.tsx` | 按 `side` / `frame` 分流（`PanelSlot` 逐字不动） |
| `src/app/tokens.css` | `--z-dock-panel: 283`（纸 280 / 书脊 281 / 侧栏 282 之上，插件窗 460 之下） |
| `src/shell/rows/workspace.ts` | `escLayer()`：settings 之后关第一个开着的壳面板 |
| `canvas-nav/index.ts` | 书脊 / 案卷两块声明 `frame: 'self'`（**零 CSS 迁移**） |

**分流规则**（`DockPanel`）：

- `side === null` → `PanelSlot`（全屏覆盖，自己定位；paper / settings）
- `side !== null && frame === 'self'` → `PanelSlot`（家具，自己定位）
- 其余 → `DockSlot`（通用壳）

### 批 2 · 架阁出纸壳

| 文件 | 动作 |
|---|---|
| `plugins/builtin/shelf-domain/` | 新产物：`index.tsx` + `git mv` 进来的 `ShelfOverlay.tsx` / `shelf-card-document.ts` / `shelf.css` + `host.ts` |
| `plugins/builtin/paper-shell/PaperPanel.tsx` | 删 `<ShelfOverlay />` 与「架阁」字件 |
| `plugins/builtin-roster.json` | 新增 `shelf-domain`（`buildOrder: 38`，其后续接顺延） |
| `plugins/factory-products.ts` | 加行 |
| `sessions-home/SessionsHome.tsx` | 顶栏加「架阁」字件（首页入口） |
| `ShelfOverlay.tsx` | 补：搜索框（两页共用）+ `↑↓` / `Enter` |

**依赖判定**：`newRefId` / `payloadChars` 是 `state/card-quote.ts` 的**无状态纯函数**，
直引不进桥（先例 `paper-shell/card-quote-of.ts:16`）。有状态的 store 一律走 `host` 面。

### 批 3 · 架阁收编面板

`ShelfOverlay` 软件页列表 = `usePluginWindowStore.defs` ∪ `panelDefs().filter(side !== null)`；
窗行 → `openPluginWindow`，面板行 → `togglePanel`，两者末尾都 `closeShelf()`。

**`side: null` 的面板不进架阁**——它们不是「软件」，各有自己的开关。

## 3. 测试

| 文件 | 断言 |
|---|---|
| `tests/dock-slot.test.tsx`（新） | 无 CSS 的 `side:'right'` 面板被 `.dock-slot[data-side="right"]` 包裹、出现标题与关闭钮、点关闭即消失 |
| 同上 | `frame:'self'` 不被壳包裹；`side:null` 走全屏槽 |
| `tests/shelf-panels.test.tsx`（新） | 面板行进架阁；点击 → `dock.open[id] === true` 且架阁关闭；搜索框过滤 |
| `tests/panel-esc.test.tsx`（新） | Esc 关壳面板（走真实键位层 useGlobalKeys → esc-layer） |

**现有测试**：`motion-contract` / `plugin-boundary` / `interaction-primitive` 对
`DockPanel.tsx` 的源码断言**全部保持现状**（`PanelSlot` 逐字不动），不需要改判据。

## 4. 门禁

```powershell
cd src-ui
$env:NODE_ENV='test'; npx vitest run
npm run build
npx biome ci .
npm run gen:contract-fingerprint   # 契约升版
npm run gen:host-surface           # host 面若动
npm run doc-check
```

## 5. 落地记录（2026-11-21）

**契约**：v63 → v66，`OPEN_SURFACE_CONTRACT_VERSION` 已 bump、指纹已重算、
`docs/agents/open-surface-contract.md` 已记一行。

**产物**：新增 `shelf-domain`（名册 buildOrder 38，其后续接顺延；`required: true`、`face: true`、
`shared: ["state/card-quote.ts", "paper/plate-sign.ts"]`）。`ShelfOverlay.tsx` /
`shelf-card-document.ts` / `shelf.css` 以 `git mv` 从 `paper-shell/` 迁出。

**不含旧 CSS 迁移**：canvas-nav 两块面板改声明 `frame: 'self'`，**一行样式都没动**——
它们本来就自持定位；`frame` 只是把「这是家具」这件事写进契约，壳据此不套盒子。

**计数**：出厂产物 40 → 41，第一方插件 59 → 60（`first-party-manifest` /
`plugin-loader` / `builtin-roster` 三处断言同步；`doc-facts` 已重生成）。

**新增 token**：`--z-dock-panel: 283`（书脊 281 / 侧栏 282 之上，插件窗 460 之下）。

## 6. 已知后续（不在本批）

- **层级**：架阁遮罩仍是硬编码 `z-index: 400`（shelf.css），**低于插件应用窗 460**——
  开着插件窗时架阁会被压住。搬家前后行为一致（此前它困在 .pp-root 的 z280 上下文里，
  同样被压），不是本批引入的回归；修法归视觉立项（与 `--z-shelf` / `--z-tip` 一起排）。
- **canvas-nav 真机走查**：互斥两态、拖拽调宽、纸开合联动——单测覆盖不到。
- `docs/plans/card-quote-plan.md` 等历史计划里的旧路径 `paper-shell/ShelfOverlay.tsx`
  是当时的事实记录，按「archive 是历史勿作现状」保留不改。

## 7. 不做

- 视觉精度（字号 / 间距 / 条目密度 / 浮层尺寸）——单独立项
- 旧 `DockRail` 的 `.dr-*` 视觉复活（`--obs-*` 变量已全量退役）
- `side: 'left' | 'right' | null` 改名
- 面板与插件窗口合并（书脊/案卷是同树 React 组件，转 iframe 全部失效）
