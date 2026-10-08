# 批 9 施工单：拆分件 + 常驻面 + 内核产品件（≈11,000 行）

> 状态：**施工单（2026-09-26 实测）· 待施工**；账本 [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)
> §6.5 是它的侦察记录。**前置裁定已全部在位**（用户 2026-09-24 拍板 §7 八条：§4-5 A · §4-6 B ·
> §4-7 B · §4-9 B · §4-11 B暂 · §4-12 B · §4-13 A）；其余七条 Agent 自裁条见账本 §7 尾注。
> 本批是本账最大的剩余面：**灰区 84 文件 / 23,124 行的主体 + 红区最后 9 条账**都在这里。

## 1. 范围（账本登记项 + 2026-09-26 实测行数）

| 组 | 件 | 行数 | 去向 / 判据 |
|---|---|---|---|
| **拆分组**（§2.5） | `paper/measure.ts` **2,015** · `paper/type-tokens.ts` **806** · `paper/group.ts` 306 · `paper/virtualize.ts` 155 · `paper/selection.ts` 193 | **3,475** | 契约/账本留内核，实现进 `paper-shell/` |
| **常驻面**（§2.4） | `app/SessionsHome.tsx` 593 + `foundation.css` 首页段 ≈850 | **≈1,443** | 新产物 `sessions-home/`（含 CSS 分段） |
| **ask 卡架**（§2.4） | `PromptShelf.tsx` 776 + `PromptShelfHost.tsx` 30 + css 412 | **1,218** | 新产物 `ask-cards/`（需 `ctx.overlays` 新槽） |
| **provider 控制台**（§2.1） | `app/panels/settings/` 8 件（ProviderPage 721 · ProviderDetail 784 · AddProviderSheet 802 · ProviderList 85 · ProviderAdvanced 102 · ProviderDocCard 161 · protocol 35 · status 50） | **2,740** | 进 `settings-domain/`（红区已认领） |
| **内核产品件**（§2.6） | `workspace.ts` **1,076** · `settings.ts` **705** · `first-party-*` 228 · `preset-authoring` 192（批 1 已落） · `bundled-engine` 186 · `prompt-sections` 文案段 122 · `i18n.ts` 98 · `asset-renderers.tsx` 49（批 0c 已删） | **≈2,400** | 逐件：产品进包 / 清单由名册派生 / 半尸体删除 |
| **机制收口** | §4-13 `ui/lsp-client.ts` 655 纳入内核清单（13→14 service）· §4-15 loader ↔ 清单双写收单一真源 · §4-10 `agent/asset-kinds.ts` 581 注册表机制留内核 / kind 内容表随 asset-domain · §4-3 `ConfirmDialog` 102 挪内核共享面 · §4-11 `bundled-engine` 186（B暂，前置=引擎链路真机验收） | ≈1,500 | 见 §3 各子批 |

## 2. 拆分组的实测出边（2026-09-26，file:line 级）

| 件 | 内核消费者（决定契约层留什么） | 产物消费者（决定实现进哪） |
|---|---|---|
| `measure.ts` | `paper/ink.ts`（值：`inkSourcesFor` / `measureSignature`）· `state/messages-store.ts`（值：`clearObservedHeightsForSession`） | `paper-shell/{host,dock-tether}.ts`（`folioHeadWidthFor` 一族） |
| `type-tokens.ts` | 仅 `paper/measure.ts`（值：`ASSET_DERIVED` / `CHROME_TOKENS` / `FOLIO_TOKENS` / `cssUsedPx` / `injectPaperTokens`） | `paper-shell/host.ts` + `host-modules.ts`（`injectPaperTokens` 桥） |
| `group.ts` | `paper/region-view.ts`（类型：`WorkUnit`） | `paper-shell/host.ts`（值：`groupWorkUnits` / `leadOf` / `rhythmAssign` / `sealedMessageIdsOf` / `unitMembership`） |
| `virtualize.ts` | `paper/overlay-context.ts` · `paper/region-view.ts`（类型：`WorldRect` / `FlowGeom` / `PinnedGeom`） | `paper-shell/host.ts`（值：`viewportWorldRect` / `visibleFlowWindow` / `visiblePinnedIds`） |
| `selection.ts` | `state/canvas-store.ts`（类型：`PaperStrip`） | `paper-shell/host.ts`（值：`classifyDropZone` / `makeStrip` / `selectionMaskRects` / `stashStripPositionAt`） |

⇒ **统一切法**：每件拆「契约层」（类型 + 内核确需的少数值，落内核 `paper/*-contract.ts` 或原地保留）
与「实现层」（其余真身进 `paper-shell/`）；`host-modules.ts` 的桥键随之上收/改指（faceDeps 指纹重生成）。
`type-tokens` 是这条链的**验收标志**：它进包后「改版式 token 必须重建 exe」的现状消失
（`docs/plans/paper-shell/taste-ledger.md` 记的就是这条）。

## 3. 子批切分（每批独立可交付、门禁全绿再下一批）

| 子批 | 内容 | 行数 | 为何这个次序 |
|---|---|---|---|
| **9a** | 账目登记三件（§4-6 token-meter / §4-7 acp / §4-12 user-mcp 认领）+ §4-15 双写收单一真源（loader 从 `FIRST_PARTY_MANIFEST` 派生，或反之）+ §4-3 `ConfirmDialog` 挪内核共享面 | ≈0（+102 挪位） | 零行为变更、零新通道；把「账目类」一次结清，后面各批只做代码 |
| **9b** | §4-13 `ctx.lsp` 纳入内核清单（13 → 14 service）：`LspService` 由 loader 装载、去掉 `lsp-client.ts:584` 的自建根 Context、过 boot 审计 | 655（挪位 + 接线） | 独立、小；先例给后面「新 service」立规矩 |
| **9c** | 拆分组五件（`measure` / `type-tokens` / `group` / `virtualize` / `selection`）：契约层留内核 + 实现进 `paper-shell/` | ≈3,475 | 本批最大一笔；`type-tokens` 兑现「token 改动不再重建 exe」 |
| **9d** | provider 控制台 8 件进 `settings-domain/`（红区 §2.1 那 2,740 行的销账） | 2,740 | 与批 1 三页同构（页面进包 + host 逐符号桥），桥面基建已就绪 |
| **9e** | 常驻面：`SessionsHome`（+ `foundation.css` 首页段切分）→ `sessions-home/`；`PromptShelf` → `ask-cards/`（含 `ctx.overlays` 新槽） | ≈2,660 | 依赖一次「常驻面板/新 overlay 槽」的通道裁定（Agent 自裁：§4-4/§4-9 精神——消费面留内核、实现进包） |
| **9f** | 内核产品件：`settings.ts` → `settings-domain/`（29 个内核 import 方改指契约层）· `workspace.ts` 拆分（工作区生命周期装配点：内联的 new/调起面按域切给各产物，内核留 Workspace 原语） | ≈1,780 | 收尾件：两者都是「高 fan-in 内核产品」，须等前面各包的契约面稳定 |
| **9g** | §4-10 `asset-kinds` 拆分（注册表机制留内核 / kind 内容表随 asset-domain）· `i18n.ts` 半尸体删除或收缩 · `prompt-sections` 文案段随 `prompt-segments` · §4-11 `bundled-engine`（**B暂**：前置 = 引擎链路真机验收 + 工作区生命周期贡献面 + MCP 桥 faceDeps 暴露） | ≈900 | `bundled-engine` 是唯一「暂缓」项，其余收尾 |

## 4. 每批验收（与批 6/7/8 同规格）

`vitest` 全量 · `build` + `build:builtin-plugins`（产物自包含）· `biome ci` 0/0 ·
`verify:convergence` 双轨（**基线零改动是硬指标**——本批不动工具表序）· `doc-sync` + `doc-check` ·
faceDeps 指纹重生成 + 基线封印 · 真机 exe 重建 + CDP（新产物 entry.js 在场 + 键数对拍）。

## 5. 已知风险与对策

| 风险 | 对策 |
|---|---|
| `measure.ts` 2,015 行是**排版引擎核心**（纸面高度单一真源） | 先切契约层（类型 + 两个内核值符号）再搬实现；`paper-visual-decisions` / `paper-folio-height` / `paper-measure*` 测试全量在场作护栏 |
| `settings.ts` 29 个内核 import 方 | 契约层（类型 + 纯函数）留内核，数据/存储/凭据层进 settings-domain；逐 import 方改指并同批跑其测试 |
| `workspace.ts` 是唯一工作区生命周期装配点（`new` 六个管理器 + 调起 user-mcp/bundled-engine） | 拆分按域切（不是整件搬）：内核留 Workspace 原语与会话工厂契约，各域构造走「内核登记表 + 产物登记实现」（批 6/7 既定接缝） |
| `SessionsHome` 的 CSS 与全局 `body::before/after` 氛围层同文件交织 | `foundation.css` 按注释段切（125–976 行是首页段），切完跑 `product-source-not-in-bundle` 的 CSS 覆盖守卫 |
| `ctx.overlays` 新槽（ask 卡架） | 通道变更有成本 ⇒ 按 §7 路由属「新增通道」层：**先出方案与代价**，用户点头再落（9e 开工前问一次） |
| `bundled-engine` 链路真机从未跑通 | 9g 之前先做该链路的真机验收（`plans/README.md` 欠账表）；未通则 §4-11 维持 B暂 |
