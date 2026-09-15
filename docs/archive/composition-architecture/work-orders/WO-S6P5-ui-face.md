# WO-S6P5 — UI 面（卷首组合 chip · 同屏并排两 Agent · UI 门禁层级）

> **状态：✅ 执行完毕（2026-09-16，两笔：P5a `87681434` 卷首组合芯片 / P5b 并排验收 + 收官写回；
> 每笔独立全绿：vitest + biome 0/0 + build + convergence 双轨 + doc-sync v39；破测 7 条逐条确认能红
> ——①恒锁 3 红 ②作用对象 1 红 ③CSS 事件放开 1 红 ④挂载点 1 红 ⑤a 活跃卷判据 1 红（**首跑照绿 ⇒
> 断言没牙，改现场后才有牙**）⑤b 牵连他卷 2 红 ⑤c 读面忽略卷级记录 1 红）。**
> 上级设计件：[`designs/S6-per-agent-composition.md`](../designs/S6-per-agent-composition.md)
> §2 序列 B（同屏并排两 Agent）+ §3.6（卷头只读标签）+ §3.8（卷头 hover 显示来源）+ §4 P5 行 + **§7.6（并排布局语义——本单最后一道未决项）**。
> 前置批次：P-1 / P0.5 / P0 / P1(a-e) / P2(a/b) / P3(a-d) / **P4(a/b)** 全部落地（HEAD `9f330b82`）。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > `AGENTS.md` > 本单。
>
> **读法：§1 是实测现状（每条 file:line），§2 是建议形态，§7 是要你裁的八道题。**

---

## 0. 一句话

P5 在设计件里写成「卷头 chip + 同屏并排两 Agent + UI e2e/golden」，实测后**两半的成本差别很大**：

- **同屏并排这一半比设计件设想的便宜**——兰台纸壳**本来就是「一纸多卷」**的横向画布
  （每个卷 = 一个 region，各自消息流/在跑态/落笔点），而「每卷一份组合」在 P0/P1 已经落地
  ⇒ 序列 B 要的「左审查右施工、各显示自己的组合名」**主要缺的是卷首那颗 chip 与验收测试**，
  不是新架构（**前提**：并排语义取「同纸多卷」而不是「两个 ChatCore」——§7 判断题 1）。
- **卷首 chip 这一半有一个真实的镜像债**：卷首（`.pp-folio-head`）的高度有 **CSS ↔ `paper/measure.ts` 逐字对映**纪律
  （改一处必改两处），且卷首当前 `pointer-events: none` + 远档（`lodFar`）不渲染
  ⇒ 往卷首塞可交互控件要同时处置这三件事（§2.1）。

---

## 1. 现状（已核实，逐条给证据）

### 1.1 「卷头」在兰台就叫**卷首**（`folio-head`），是 per-卷 渲染的

| 事实 | 位置 / 证据 |
|---|---|
| 卷首 DOM = 玉徽 + 机读眉行 + 卷名 + 机读档行 | `src-ui/src/plugins/builtin/paper-shell/PaperPanel.tsx:784-802`（`pp-yuwei` / `pp-folio-eyebrow`「兰台 · 案卷 Nº N」/ `pp-folio-title`（卷名）/ `pp-folio-sub`「案卷 #N · M 块」） |
| **每个 region（= 每卷）各渲染一份**（字段来自 `r`） | 同上（`{!lodFar && (<div className="pp-folio-head">…)}`，`r.sessionNum` / `r.label` / `r.blocks`） |
| 卷首样式 + **高度镜像纪律** | `PaperPanel.css:378-452`（`.pp-folio-head` / `.pp-folio-eyebrow` / `-title` / `-sub`）；CSS 头注原文：「**paper/measure.ts measureFolioHeadHeight（逐字对映，改一处必改两处）**」 |
| 卷首当前**点击穿透** | `PaperPanel.tsx:787`（注释「pointer-events none——点击穿透流区背景，激活语义不变」）⇒ 塞可交互控件必须**只对该控件子树**放开事件 |
| 卷首在**远档 LOD 不渲染** | `PaperPanel.tsx:791` `{!lodFar && …}`（注释：缩糊的 DOM 卷首不如无，卷名由 InkLayer 地志标签接管）；既有断言 `tests/paper-lod-tiers.test.tsx:205/213/229/236/241` 钉住远档卷首数 = 0 |
| 卷首高度**真源链**（不止两处） | `paper/type-tokens.ts:525-537`（`FOLIO_TOKENS`）→ `paper/measure.ts:437-465`（`measureFolioHeadHeight`）→ `use-paper-regions.ts:387-388/444`（卷级缓存消费） |
| 每卷的卷号在 DOM 上直接可得 | `PaperPanel.tsx:778`（region 根带 `data-session-id`）；活跃性判据 = `r.sessionId === activeSessionKey`（`:758`）⇒ 卷首 chip 的**作用对象**天然是"本 region 的卷"，不需要问"谁是活跃卷" |

### 1.2 同屏并排两 Agent：**视图层与组合层今天都已成立**，缺的是 chip 与验收

| 事实 | 位置 / 证据 |
|---|---|
| 纸壳 = **一纸多卷**横向画布（每卷一个 region，有横向可见集/卷级缓存/卷级虚拟化） | `paper-shell/use-paper-regions.ts:4-6`（头注「布局核心域——**一纸多卷的派生心脏**：regions memo…横向可见集」）；`use-paper-strips.ts:6-9`（纸条 = 工作区级公共物） |
| 多卷**同时在跑**已有专门处理 | `use-running-sessions.ts:4-7`（「任一摊开卷在跑 → 画布底缘呼吸线 + 各在跑卷尾落笔点」；订阅 `subscribeExecAll`，`runningSessions` 集合） |
| 每卷一份组合已落地（P0/P1） | 卷级登记 `agent/agent-session-state.ts`；工厂判据 `workspace.ts:824`（`getRecordedPresetId`）→ `:833`（`effectiveComposition`）→ `:836-837`（**组合身份比较**）→ 身份不同才自建会话作用域注册表（`:839-860`），否则复用共享注册表 |
| 每卷一个 Agent 句柄（各自装配） | `agentSessionState` 按 `storeId:sessionId` 键控（`agent-session-state.ts:147`）；装配点 `agent/runtime/runtime.ts:617 _assembleAgent`（每 Agent 一份 `ctx.set('composition', …)` ≈ `:683`） |
| **唯一 ChatCore**（"两个面板"若指两个 ChatCore = 另一件工程） | `shell/rows/chat.ts:15-16`（`new ChatCore()` + `useCoreStore.setChatCore`）；`app/chat/core-instance.ts:10-13`（**单例 store**，`core: ChatCore \| null`）；`chat-core.ts:184` `panelId = cp-<ts>-<rand>`（每实例唯一）⇒ 机制上**支持**多实例，但今天只造一个、且 shell 只挂一个 |

**「两个 Agent 面板」（两个 ChatCore）为什么是另一件工程——四道构造级拦路石**（2026-09-16 侦察实测）：

| 拦路石 | 证据 |
|---|---|
| 唯一 ChatCore + 单槽 store，消费面全取它 | `shell/rows/chat.ts:15-16`；`app/chat/core-instance.ts:10-13`；`app/App.tsx:28/34`；`composition/space-service.ts:49-50`（`panelIdOf()`）；`PaperPanel.tsx:362` |
| **第二实例会拆掉第一实例** | `chat-core.ts:119` 模块级 `_globalStoreUnsubs` + `:183` 构造首行 `unsub()` 全部 ⇒ ask / goal / diag / workspace-switch 四个全局订阅是「上实例退订」语义 |
| 一 Workspace 只绑一 core | `workspace.ts:517` `this._storeId = chatPanel.panelId`（覆盖式单值）、`:758` `this._chatPanel`、`:906` `eventSink`；`shell/rows/workspace.ts:84-96,121` 单一 `shellRefs.workspace`（开新区先 deactivate 旧区） |
| 面板面**没有**多实例语义 | `app/panels/panel-def.ts:16-29`（`PanelDef` 无 storeId）；`app/panels/DockPanel.tsx:18-27`（`<C />` 不传 props）；`state/dock-store.ts:26`（`open: Record<string, boolean>`）；各面板 CSS 自持 `position: fixed` 覆盖层（`PaperPanel.css:9` 等）+ 固定 z 阶梯（`app/tokens.css:129-131`）⇒ 无分栏/分隔条；`canvas.json` 按**工作区路径**键控、不含 storeId（磁盘面也得先分账） |

⇒ 真面板并排 = ① 面板多实例承载 ② 面板↔storeId 映射 ③ 多 core 的全局订阅所有权 ④ Workspace↔core 一对一解除 ⑤ 磁盘面分账 ⑥ 布局容器与矩形持久化 ⑦ 每面板卷头 chip——**七面**，量级等同独立批次。
**它买到的是**：每面板独立视口/缩放（今天平移/缩放是**全局**的，`PaperPanel.tsx:553-556`）、独立活跃卷、面板级布局持久化；
**它买不到的是**：组合隔离本身——「两卷各持一份组合」今天已成立（`tests/seam-composition.test.ts` ⑨-⑬ 已绿 + `composition-session-count-profile.test.ts`）。

### 1.3 P1e 芯片（P5 的直接先例：读面/写面/三态/测试形状全都有）

| 事实 | 位置 / 证据 |
|---|---|
| 三态实现 + 两个调用面 | `plugins/builtin/compose-dock/ComposerDock.tsx:448-520`（无主态 → `selectPreset`（全局默认）；有卷且空白 → `core.selectSessionPreset(sid, id)`；跑过一轮 → 只读）+ 读面 `core.sessionComposition?.(sid)`（`:485`）+ 重读触发器 `presetRoster/presetSelected`（`:456-458/466`） |
| 样式 | `plugins/builtin/compose-dock/composition-chip.css`（3.4KB，纯 `--obs-*` token） |
| 组件级测试形状 | `tests/composer-dock-composition-chip.test.tsx`（4 例：无主态不可拨 / 空白卷可拨走卷级写路径 / 跑过一轮只读 / …），mock `core` + `useCoreStore` |
| 产物插件的取数姿势 | `const core = useCoreStore((s) => s.core)`（`ComposerDock.tsx:204`）+ 直接读 `getChatStore(core.panelId)` / `msgStoreFor(...)` / `usePresetStore` / `agentSessionState` ——**这些面必须在本插件的 host 面里**（`compose-dock/host.ts:18` 导出 `selectPreset` 等；产物域经 `host.aliased.ts` + `builtin/host-modules.ts` 的 `faceDeps` 取真实例） |
| 芯片 DOM 与类名（**不能靠 class 复用**） | 根 `[data-comp-chip]`（`ComposerDock.tsx:1160`）；可拨态 = `<button class="pp-comp-pill">` + 自绘 `role="listbox"/role="option"` 菜单（`:1195-1221`）；锁态 = `<span class="pp-comp-pill" data-locked>`（`:1163-1173`）；`composition-chip.css` **全部规则以 `.pp-composer-settings` 为祖先限定**（`:12/18/42…`）⇒ 卷首须**新类名或新祖先规则** |
| ⚠ 连带发现（陈旧注释） | `composition-chip.css:9-10` 自称"只写 `--obs-*` / 既有权杖 token"是漂移：**全仓无任何 `--obs-*` 自定义属性定义**（唯一 `var(--obs-fail)` 在 `ui/icons.ts:387`，是悬空引用）。本批**如实照抄既有 token 用法**，不顺手改这条注释（不在本批范围，登记备查） |
| `paper-shell` 的 host 面**缺** preset 族 | `paper-shell/host.ts` 今天只导出 `agentSessionState`(:15) / `useCoreStore`(:16) / `getChatStore`+`msgStoreFor`(:131)；`usePresetStore` / `selectPreset` / `sessionCompositionInfo` / `isSessionBlank` **零命中**（compose-dock 那边有）⇒ §1.4 的四处联动是本批的**真实成本**（不是形式主义） |

### 1.4 把 chip 落进 paper-shell 的**真实成本**：host 面四处联动

`paper-shell` 是产物插件（自包含、无裸 import）：要在其中读 `useCoreStore` / `getChatStore` / `msgStoreFor` /
`usePresetStore` / `selectPreset` / `agentSessionState` / `sessionCompositionInfo` 面，必须走
**四处联动**（设计件 §8.3 事实 4 的实测口径）：`plugins/builtin/paper-shell/host.ts`（开发域 re-export）
→ `host.aliased.ts`（产物域从 `mods.faceDeps` 取）→ `builtin/host-modules.ts` 的 `faceDeps`
（**类型封蜡 `FaceBridgeSeal`——漏注册在写代码时就 tsc 红**）→ `npm run gen:host-surface` 重生成
`src-ui/src/plugins/host-surface.baseline.json`（**该文件在并发工作线射程内**，改前查净、改后立提）。
**不新增插件条目** ⇒ 出厂清单计数 `43 = 13 + 30` 不动。

### 1.5 P5 行的「+ UI e2e + golden」需要重新解释（本仓现实）

| 面 | 今天有什么 |
|---|---|
| UI 组件测试 | jsdom 侧成熟：`tests/paper-*.test.tsx`（new-volume / c8-spine / viewport-ux / image-render / checklist / math / code-highlight 等十余个）+ `composer-dock-composition-chip.test.tsx`（P1e 先例：mock core 的组件级三态测试） |
| 真机 e2e | `src-tauri/src/cdp/e2e.rs`（**环境型抖动源**，AGENTS §10 纪律：残留 profile/端口未就绪会连环污染；`src-tauri/tests/` 只有 `platform_boundary_test.rs`） |
| "golden" | 本仓**没有**现成的 UI/截图 golden 机制：`tests/ui/layout-golden.test.ts` 已随 `35db9ef8`（C13 Three.js 渲染面退役）**删除**，只剩孤儿快照 `tests/ui/__snapshots__/layout-golden.test.ts.snap`；全仓无 `toMatchImageSnapshot`。**最接近"视觉 golden"的既有惯例** = `tests/paper-visual-decisions.test.ts`（774 行，node 环境，readFileSync 读 CSS/TS 源码做**字面量钉值**）——其 `:281` 断言 `.pp-folio-head` 含 `pointer-events: none`、`:323-330` 钉 `FOLIO_TOKENS` 值与 `measureFolioHeadHeight` 符号存在 ⇒ **卷首塞交互控件时这两条会先红**（属"故意规格变更"，必须显式声明并同批改写） |
| 真机验收先例 | P1e 芯片的验收方式是**交用户真机看**（`cargo tauri build` 后可见；用户 2026-09-15 回「已真机验收」）——设计件 §8 记为本线最后一次挂起的真机门 |

### 1.6 设计件里 P5 要兑现的原文断言（验收依据）

- §2 序列 B：「纸壳里左审查右施工，两个面板各自卷头显示自己的组合名；在 A 面板切换组合**只影响 A 的下一次装配**，B 不动；A 切组合后，**B 的注册表引用与工具实例不重建**」；
  断言：「两个 Agent 的 `ctx.get('composition').id` 不同；全屏只有 A 的（重新）装配发生」。
- §4 P5 行：「卷头 chip（含 blank-only 锁）+ 同屏并排两 Agent；锁生效（跑过一轮的卷拒绝切换）」。
- §3.8 欠账：「**卷头 hover 显示本卷组合与来源**（全局默认 / 卷级 / 程序指定）随卷头 UI 落 P5」。
- §7.6（**未决项**）：「同屏并排的布局语义：两个 Agent 面板**是否共享工作区**（→ 同一注册表 deps）还是各自独立（→ 两套 deps）」。

---

## 2. 目标形态（建议）

### 2.1 P5a 卷首组合 chip（落 `.pp-folio-head`）

- **语义与 P1e 完全同款**（三态 + 不可用原因悬停可见）：无主态 / 空白卷可拨 / 跑过一轮只读；
  写面继续走 `selectSessionPreset`（严一档校验 + 空白闸二道闸，**一把尺子两处用**）。
- **作用对象 = 该 region 的卷**（不是"当前活跃卷"）：卷首天然 per-卷，而 P1c 的写路径本就支持
  「句柄缺席的空白卷先登记、下次装配生效」⇒ 对**任意空白卷**可拨是自然语义（§7 判断题 4）。
- **三处必须同时处置**（§1.1）：
  ① 卷首 `pointer-events: none` ⇒ 只对 chip 子树放开（`pointer-events: auto`），卷首其余部分保持穿透；
  ② 卷首高度进 `paper/measure.ts measureFolioHeadHeight` 镜像 ⇒ **CSS 与 measure 同改**，并给这条镜像加/复用一条守卫断言（§5）；
  ③ `lodFar` 不渲染卷首 ⇒ 远档看不到 chip（**如实声明**：远档是缩略视图，交互控件本不该在）。
- **hover 来源**（§3.8 欠账）：悬停显示「本卷组合 + 来源（全局默认 / 卷级 / 程序指定 / 不可用原因）」——
  建议**本批做**（读面 `sessionCompositionInfo` 已经给 `source`，只是字形化）。

### 2.2 P5b 同屏并排两 Agent = **验收 + 少量接线**（形态 = 同纸多卷）

- **不给"两个 ChatCore"**（那是另一件工程，见 §7 判断题 1/8）；给的是把**已有能力显性化 + 钉住**：
  两卷并排（纸壳今天就会横向铺开）、各自卷首 chip 显示自己的组合名、各自句柄与组合面互不影响。
- **要新增的证据**（序列 B 的断言逐条落地）：
  ① 进程内：同一工作区两卷、组合不同 ⇒ 两个 Agent 的组合面不同（工具面/提示面），
     **且只发生一次新建**（B 的注册表引用与工具实例不重建——用计数台断言，沿 P3 的结构性计数思路）；
  ② 在 A 卷拨组合 ⇒ **只有 A 的（重新）装配发生**（B 的工厂调用次数不变）；
  ③ UI（jsdom）：两 region 并排渲染、各自 chip 显示各自组合名与三态。
- **若有真缺口**（例如非活跃卷的 chip 拨动后 UI 不重读、或惰性卷无句柄时读面返回"全局默认"造成误显），
  在本批内修（**改的是既有面，不新增面**）。

### 2.3 门禁层级（按 §7 判断题 7 裁定）

建议：**jsdom 组件级 + 进程内行为级测试**（本批新增）+ **真机验收交用户**（沿 P1e 先例：
`cargo tauri build` 后看卷首 chip 三态与并排两卷）；**不做 cdp e2e**（环境型抖动，收益不抵）；
**不做截图 golden**（本仓无此机制，新建一套截图基线 = 另一件工程）。

---

## 3. 默认路径零漂移（构造性论证）

1. 卷首 chip 是**新增只读展示 + 一个已有写路径的调用点** ⇒ 不碰任何解析面
   （`resolveRoster` / `effectiveComposition` / `resolvePresetComposition` 一字不动）；
2. **不动模型可见面**（工具 schema / prompt 段 / capability）⇒ 两轨 `tool-schemas.full.json` 与
   `system-prompt.fixture` 逐字节不变；**不新增 baseline 快照、不跑 `record`**；
3. **不动契约文件**（不新增 ctx 键、不新增 RPC、不加工具参数）⇒ 开放面契约**仍 v39**；
4. 唯一可能触发的生成物 = `host-surface.baseline.json`（若 paper-shell 新增 host 面出口）——
   走 `npm run gen:host-surface` 并**同 commit**；该文件在并发线射程内（改前查净、改后立提）；
5. **哨兵**：`tests/composer-dock-composition-chip.test.tsx`（4 例）、`tests/composition-session-preset.test.ts`（7 例）、
   `chat-session.test.ts`（45 例）、`paper-*.test.tsx` 若需改动 = 行为被改坏（应零改动）。

---

## 4. 施工切分（建议两笔，每笔独立全绿独立 commit）

| 笔 | 内容 | 关键产物 |
|---|---|---|
| **P5a** 卷首组合 chip | `PaperPanel.tsx` 卷首内嵌 chip（三态 + hover 来源）+ `PaperPanel.css` 卷首样式 + **`paper/measure.ts` 镜像同步** + host 面四处联动（`paper-shell/host.ts` / `host.aliased.ts` / `host-modules.ts` faceDeps / `gen:host-surface`）+ 测试（组件级三态 + 镜像守卫） | chip 上卷首；生成物同 commit |
| **P5b** 同屏并排两 Agent 验收 | 进程内两卷不同组合的装配计数断言（B 不重建 + A 拨动只重装 A）+ jsdom 两 region 并排渲染各自 chip + 设计件 §4 P5 行 ✅ / §8.4 补记 / 计划索引 / `docs/composition/README.md` 用户面一段 | 验收证据 + 文档写回 |

> **若判断题 2 裁定"并排拆独立批次"**：P5a 单笔落地（卷首 chip 本身就是用户可见价值），
> 并排验收 + §7.6 的形态（若真要两 ChatCore）另立批次。

---

## 5. 测试与破测（新增从用户操作序列新写；破测逐条验证能红）

| # | 断言 | 形状 |
|---|---|---|
| 1 | **卷首 chip 三态**（P1e 同款语义） | 组件级：无活跃卷 = 无主态；空白卷 = 可拨（拨后走 `selectSessionPreset` 且登记变化）；跑过一轮 = 只读（不可拨 + 悬停给原因） |
| 2 | **锁的尺子与写路径同源** | 组件面判据 = `isSessionBlank`（同一把尺子）；构造"UI 显示可拨但写路径拒绝"的差异 ⇒ 应当**不可能**（该断言即为此设） |
| 3 | **per-卷 而非 per-活跃卷** | 两个 region（一卷活跃一卷非活跃）：非活跃但空白的卷也能从自己的卷首拨组合，登记落在**它自己**的卷级记录上 |
| 4 | **卷首高度镜像** | `paper/measure.ts` 的 `measureFolioHeadHeight` 与 CSS 的卷首高度一致（钉住"改一处必改两处"） |
| 5 | **并排两卷各自组合**（序列 B 主判据） | 进程内：两卷各按不同组合装配 ⇒ 两个 Agent 的工具面/提示面不同；**B 的工厂调用次数在 A 拨组合前后不变**；A 拨动 ⇒ A 恰好重新装配一次 |
| 6 | **hover 来源词汇** | 三种来源（全局默认 / 卷级 / 程序指定）+ 不可用原因，文案与 P1e 芯片**同一套词**（不造第二套说法） |
| 7 | **零漂移哨兵** | 不传参 / 无卷级记录的路径行为与今天逐字相同；P1e 与 P1c 的既有测试**零改动** |
| 8 | **既有「卷首不变量」断言的同批改写**（**故意规格变更，显式声明**） | `tests/paper-visual-decisions.test.ts:281`（断言 `.pp-folio-head` 含 `pointer-events: none`）与 `:323-330`（`FOLIO_TOKENS` / `measureFolioHeadHeight`）随本批卷首改动**显式改写并声明**（不是"改造后放回原位"）；`tests/paper-lod-tiers.test.tsx`（远档卷首数=0）应**零改动** |

**测试台形状（照抄先例，别自创）**：卷首 chip 的组件测试以 `tests/composer-dock-composition-chip.test.tsx` 为模板（桩 core 六方法 + 真 React root + `PaperDockContext.Provider` + 直写 `getChatStore().sess` / `msgStoreFor().setMessages`），但**宿主换 paper harness**——`tests/paper-new-volume.test.tsx:22-101`（mock `@chenglou/pretext` / `rich-inline` / `../src/bridge` + Fake 2d ctx + Fake ResizeObserver + **确定性同源 rAF** + 真 `new ChatCore()`）；断言作用对象走 `data-session-id`（本 region 的卷）而非 `activeSessionKey`。

**破测（每条注入缺陷确认能红，结果写进 commit message）**：
① 卷首 chip 用「活跃卷」而不是「本 region 的卷」→ 3 红；
② 锁的判据换成"有句柄即锁"（而非空白判据）→ 1/2 红；
③ CSS 改了卷首高度但不改 measure → 4 红；
④ 并排断言里把 B 的工厂计数摘掉 → 5 红（此时应能在"没接线"的实现上照绿 ⇒ 说明断言无效，必须重写）。

---

## 6. 契约与文档

| 面 | 本批 |
|---|---|
| 开放面契约 | **不动（仍 v39）**——不碰 `OPEN_SURFACE_CONTRACT_FILES` 任一文件 |
| `host-surface.baseline.json` | **可能变**（paper-shell 新增 host 面出口）⇒ `npm run gen:host-surface` 重生成并同 commit |
| service / event catalog、`model-tool-contract.md`、`frontend-rpc-contract.md` | 不动 |
| 文档写回 | 设计件 §4 P5 行 ✅ + §3.6（卷头只读标签落地口径）+ §3.8（hover 来源兑现）+ §8.4 补记 + §7.6 裁定落账；`docs/plans/README.md` 计划索引；`docs/composition/README.md`（用户面：卷首 chip 怎么用）；`AGENTS.md` §7 / `CLAUDE.md`（若形态与设计件有偏离，**偏离必须显式写**） |

---

## 7. 请示：八道判断题（**请逐条裁定**）

| # | 判断 | 我的建议 | 影响面 |
|---|---|---|---|
| **1** | **§7.6 并排语义**（本单最后一道未决项）：两个 Agent = **同纸多卷**（同一 ChatCore / 同一工作区 deps，两卷按组合身份决定是否自建会话作用域注册表 = P1d 已落机制），还是**两个 ChatCore/两套 deps**（需 ①-⑦ 七面：多实例承载 / storeId 映射 / 多 core 订阅所有权 / Workspace 一对一解除 / 磁盘面分账 / 布局容器 / 每面板 chip）？ | ✅ **同纸多卷**。证据：纸壳本就是「一纸多卷」横向画布（`use-paper-regions` 头注）、多卷在跑已处理（`use-running-sessions`）、每卷一份组合已落且**已被测试钉住**（`seam-composition.test.ts` ⑨-⑬、`composition-session-count-profile.test.ts`）；而真面板并排要动的是 ChatCore 单例链（§1.2 四道拦路石），**且它买不到组合隔离**（只买到独立视口/活跃卷/布局持久化）。设计件 §2 B 的四条断言在「同纸多卷」下**全部可兑现** | 决定 P5b 的成本量级：**天** vs **独立批次（七面）**；也决定是否要在本次动 shell 行 / core 实例化 / 磁盘面 |
| **2** | **批次切分**：P5a 卷首 chip + P5b 并排验收（两笔）／一笔做完／把并排拆独立批次？ | ✅ **两笔**：P5a 单独交付用户可见价值（卷首 chip 可真机验），P5b 是验收+少量接线+文档 | 交付节奏与回滚粒度 |
| **3** | **卷首 chip 落点与交互**：落 `.pp-folio-head`（卷首，建议）？是否只对该子树放开 `pointer-events`？远档（LOD）不渲染卷首 ⇒ chip 也随之不可见（接受？） | ✅ 落卷首 + **只放开 chip 子树** + 远档如实不可见（远档是缩略视图，控件本不该在） | 手感与 CSS/measure 镜像改动面 |
| **4** | **chip 作用对象**：本 region 的卷（**任意空白卷**都能从自己卷首拨，P1c 写路径已支持）还是仅"当前活跃卷"（P1e 芯片的现状）？ | ✅ **本 region 的卷**（卷首天然 per-卷；非活跃空白卷先登记、下次装配生效） | 语义清晰度与 P1e 的差异说明 |
| **5** | **hover 显示来源**（设计件 §3.8 欠账）：本批做？词表用「全局默认 / 卷级 / 程序指定」？ | ✅ 本批做——`sessionCompositionInfo` 已给 `source`，只是字形化；程序指定（P4）尤其需要能看出来源 | 欠账清偿 + 与 P4 的闭环 |
| **6** | **chip 组件复用**：抽成共享组件（放哪？两处各自实现（P1e 那套复制）？是否顺带把 P1e 芯片迁到共享件？ | ✅ **本批各实现一处，暂不抽象**（两处宿主/取数面不同：坞 vs 卷首；抽象早了会造出"两不像"的中间层）。**P1e 不迁**——它已真机验收通过，本批不动它 | 是否引入连带重构（动 P1e 有回归风险） |
| **7** | **门禁层级**（P5 行的「+UI e2e + golden」）：jsdom 组件 + 进程内行为测试 + 真机验收交用户（建议）／加 cdp e2e 脚本／建截图 golden？ | ✅ **jsdom + 进程内 + 真机验收交用户**（沿 P1e 先例）。cdp e2e 是环境型抖动源（AGENTS §10 纪律）；截图 golden 本仓无机制，新建一套基线是另一件工程 | 门禁耗时与"谁来验" |
| **8** | **跨工作区并存 / 多 ChatCore**：设计件的"全粒度并存"含跨工作区，本批做不做？ | ❌ **本批不做**（留独立批次）：跨工作区要动会话物理归属那条线的未收口部分（设计件 §6 R5 已登记风险） | 批次边界 |

### 裁定记录（2026-09-16）

| # | 裁定 | 落地含义 |
|---|---|---|
| 1 | **同纸多卷**（用户问「真并排居然这么麻烦吗」后看清成本对比：四道构造级拦路石 §1.2 + 七面 ⇒ 真面板并排 = 独立批次） | P5b = 验收 + 少量接线，**不动 ChatCore 单例链 / shell 行 / 磁盘面**；真面板并排（独立视口/缩放、独立活跃卷、布局持久化）与跨工作区一并留独立批次待议 |
| 2 | **两笔** | P5a 卷首 chip 独立交付（可真机验）；P5b 并排验收 + 文档写回 |
| 3 | 落 `.pp-folio-head` + 只放开 chip 子树 + 远档如实不可见 | **追加实施口径（本单自定，开工前记）**：chip 以**绝对定位覆盖**在卷首右上角（**不进高度流水**）⇒ 不动 `FOLIO_TOKENS` / `measureFolioHeadHeight` / 卷级几何，既有画布布局零位移、既有钉值断言（`paper-visual-decisions.test.ts:281/:323-330`）**保持绿**——若真机看起来别扭，再改为进流水（届时才动三处镜像并显式声明规格变更） |
| 4 | **本 region 的卷**（任意空白卷可拨） | 作用对象 = `r.sessionId`（DOM `data-session-id`，PaperPanel.tsx:778），不读"谁是活跃卷" |
| 5 | **hover 来源本批做** | 词表 = 全局默认 / 卷级 / 程序指定（`sessionCompositionInfo.source` + P4 程序入口的落卷=卷级；"程序指定"由卷级记录 + 其来源在 P4 已落为同一登记 ⇒ 文案上以「本卷记录」承载，hover 里补「由程序指定」的说明见 §2.1 实施注） |
| 6 | 两处各自实现、**P1e 不迁** | 卷首 chip 用自己的类名（`.pp-folio-comp*`），不复用被 `.pp-composer-settings` 祖先限定的 `.pp-comp-*` |
| 7 | **jsdom + 进程内 + 真机验收交用户** | 不建截图 golden、不做 cdp e2e |
| 8 | 跨工作区 / 多 ChatCore **不做** | 独立批次待议（若要做，先按 §1.2 七面立施工单） |

---

## 8. 红线

- **不动** `resolveRoster` / `resolvePresetComposition` / `effectiveComposition` / `compositionIdentity` 的签名与语义；
  **不动** `AgentConfig`（28 字段，`gate.mjs` 断言）；**不动**出厂 preset 面；**不新增 baseline 快照、不跑 `record`**。
- **不新增 Rust 命令、不新增 ctx 键、不加模型可见工具参数、不动 RPC** ⇒ 开放面契约仍 v39。
- **`ui/` 是冻结残余目录**：新组件落 `app/**` 或既有插件目录（守卫 `tests/eventbus-zero-and-ui-split.test.ts`）；
  本批预计**不新增文件**（chip 内嵌 `PaperPanel.tsx` + 一个 css）。
- **CSS ↔ measure 镜像纪律**：卷首高度改一处必改两处（`PaperPanel.css` ↔ `paper/measure.ts`），
  并配一条钉住两者一致的守卫（这是本批唯一"新债"入口——不许只改 CSS）。
- **并发工作线**射程内文件：`host-surface.baseline.json`、`rpc-contract.ts`、`workspace.ts`、`docs/**`、`AGENTS.md`/`CLAUDE.md`。
  纪律：每笔只 `git add` 本线显式路径（**不 `git add -A`**）；门禁红了先判归属
  （`git stash push -u -- <本线路径>` → 跑该用例 → `git stash pop`，链在一条命令里）；改前查净、改后立提。
  **另（P4 实测教训）**：本工作区近期出现过「未提交的源文件被外部操作清空/删除」两次 ⇒ 改完**立即**在 `D:\tmp` 留备份再跑测试。
- **测试纪律**：行为未变 → 测试零改动（黄金标准）；行为退役 → 同批整删；行为新增 → 从用户操作序列新写；
  禁止「改造后放回原位」；新增用例必须做**破测验证**并把结果写进 commit message。
- 本机纪律：凡 npm/vitest 命令先 `$env:NODE_ENV='test'`；性能判据一律 **min（p75 次之）**，绝对 ms 不进红绿。

---

## 9. 开工前置（已做，留痕）

- 现状调研：本单 §1 每条 file:line 为本轮实读（含两路只读子代理交叉核对：卷首 chip 落地面 / 同屏并排能力面）。
- 门禁基线（P4 收官后实测，HEAD `9f330b82`）：vitest **317 文件 3174 passed / 3 skipped** ·
  biome ci **0/0（781 文件）** · `npm run build` ✓（30 产物）· `verify:convergence` **双轨 exit 0** ·
  `doc-sync` ✓（开放面契约 **v39**）。
