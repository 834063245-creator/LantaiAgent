# WO-S7 — 多 core / 多面板（真面板并排：两个独立 Agent 面板）

> **状态：已裁定（2026-09-16）——九道判断题由 Agent 按用户授权自裁完毕（裁定表见 §0.5，原请示保留在 §7 供对账）。本件只立契约，未动一行代码；开工见 §4。**
> **命名注**：S6 已全段竣工，本批是它明文留给独立批次的那一格（设计件 §8.5 事实 3 + §7.6 裁定 1），
> 故新开线号 **S7 = 多 core / 多面板线**；仍归档在 `composition-architecture/work-orders/`（本仓施工单唯一住处）。
> 若你更愿意叫 `WO-S6P6-*`，说一声即改名。
> 上级依据：[`designs/S6-per-agent-composition.md`](../designs/S6-per-agent-composition.md) **§8.5 事实 3**（四道拦路石）
> + **§7.6**（并排布局语义，P5 裁定「同纸多卷」时把真面板并排划出范围）+ §4「S6 全段竣工」行的待议清单。
> 前置：S6 全段竣工（HEAD `673f4229`）；P5 真机验收仍挂起（本批会动它附近的面，验收顺序见 §9）。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > `AGENTS.md` > 本单。
>
> **读法：§0 先给结论（含对本轮侦察的纠正），§1 是实测现状（每条 file:line），§7 是要你裁的九道题。**

---

## 0. 一句话结论（先说最要紧的）

P5 裁定「同屏并排 = 同纸多卷」时，把「真面板并排」划出范围并记了四道拦路石。本轮两个只读子代理
重新核实 + 本单作者逐条实读，**四道全部仍真**，但**成本形状与设计件记的不一样**，且**「六行就能修好」
这个看起来最诱人的结论是错的**：

1. ✅ **便宜的一半确实便宜**：`panelId` 早在 2026 年就是 7 个 scoped store 的 storeId
   （`chat-core.ts:544/590` `const storeId = this.panelId`），`agent-session-state.ts` 全 API 带 storeId、
   复合键 `${storeId}:${sid}` ⇒ **数据面（消息/会话/面板/输入/画布/坞/资产）的多实例承载已经建好了**。
2. ⚠ **但 B2「第二实例拆第一实例」不是六行**（本单对侦察的纠正，见 §1.2）：`_globalStoreUnsubs`
   里**混装**了全局订阅（ask/diag/goal/workspace-switch）与**本面板**订阅（`:282` 订的是
   `getChatStore(this.panelId).sess`）。把它改成实例字段**会立刻复活 `2026-09-01 审计` 修掉的老 bug**
   ——「重建不累积」正是那个模块级数组存在的唯一理由，而它成立的前提是**没有 dispose 时机**
   （`ui/chat-store.ts:93-94` 自注：「四件整包调用点（面板销毁）仍缺，**ChatCore 为应用级单例，
   暂无整包拆除时机**」）。⇒ B2 的正解是**给 ChatCore 立一个销毁/所有权时机**，不是把变量挪个位置。
   **这是一条真实的架构决策，本批的难度主要在这里。**
3. 💰 **真正的成本驱动是第 5 道拦路石**（设计件没记，本轮新发现）：`state/canvas-view-store.ts:43`
   的 `useCanvasViewStore` 是**无 storeId 概念的应用级单例**（`create<...>`，不是 `createScopedStore`），
   自注「画布即主界面，**一次只有一个纸视图**——对齐 dock-store 的单例形态」，同时持有
   `view`(pan/zoom) / `canvasSize` / `restoredView` / `pendingFocusId`，消费面 **7 文件 ~40 处**
   且**已在冻结基线** `host-surface.baseline.json:174`。**「独立视口/缩放」这一条就是它**——
   不是设计件记的 B4（面板容器），B4 只是"往哪儿摆"，它才是"各看各的"。
4. 🎯 **所以本批建议切成两截**：**笔 1 = 决定性 spike**（只回答「两个 ChatCore 能否共存」，含 B2 正解），
   **结论绿 ⇒ 再按 §4 往下走**；**红 ⇒ 就地结案**，不必投入面板/视口/磁盘面那三面。

---

### 0.5 裁定与协议变更（2026-09-16）

**九道判断题全部由 Agent 自裁**（用户同日：「我其实都有点过载了…你得帮我做判断」）。裁定如下，
**不再逐条请示**：

| # | 裁定 | 理由（一句话） |
|---|---|---|
| 1 | **先做决定性 spike**（笔 1 可单独结案） | 一次会话就能把「多 core 能否共存」钉成事实；不先证实就铺七面是赌 |
| 2 | **甲案**：`ChatCore` 改实例自有订阅 + 加显式 `dispose()` | 乙案把「活跃实例」塞回模块级态（正面违 `CONVENTIONS §1.10` 四级归属）；且 dispose 顺带清偿 `ui/chat-store.ts:93` 已登记的欠账（「面板销毁调用点仍缺」）⇒ 净收益 |
| 3 | spike 红 ⇒ **结案留档**，不在同批换路线硬攻 | 路线级改判另立设计件；同批硬攻会把"证伪"变成沉没成本 |
| 4 | **共享工作区**——**且这从来不是选择题** | 引擎契约「一进程一工作区根」强制（`workspace.ts:774`）；我把它写成判断题是失误，已在 §1.3 改为约束陈述 |
| 5 | 笔 4 **先交便宜形态**（两覆盖层各占半屏、边界可拖），真分栏留后 | 全仓面板是 `position: fixed` 全屏范式 + `PaperPanel.css` 4954 行；先用最小形态验证「并排到底有没有用」，且先便宜者后升级不亏（单向门） |
| 6 | `PanelDef`/`PanelContribution` 加 **`instanceKey?`**，`component` 保持不接 props | `instanceKey` 是增量（缺省 = 今天语义逐字不变）；改 props 要同时改 87 处消费侧 |
| 7 | 独立视口（`useCanvasViewStore` 参数化）**不并入本批** | 它才是「各看各的」的真实成本（7 文件 ~40 处 + 冻结基线）；混进来会让本批膨胀、回滚粒度糊掉 |
| 8 | 磁盘面分账（`canvas.json` per-panel）**不并入本批** | 沿 7 同理；且与并发线的会话存盘域邻近 |
| 9 | 门禁 = **进程内行为测试 + jsdom 组件测试 + 真机验收交用户** | 沿 P1e/P5 先例；cdp e2e 是环境型抖动源（AGENTS §10），截图 golden 本仓无机制 |

**协议变更（即刻生效，立规在 `CONVENTIONS.md` §0.5）**：本线此后**不再产出「请示：N 道判断题」**——
施工单写「**我的裁定 + 理由**」；只有当决策属于「只有用户能给的输入 / 不可逆且代价大 /
证据两边打平」三类之一时才提问，且**每批次最多一个问题、必须一句话以用户可见的后果提问**。
留痕照旧（裁定表在件内），但不制造决策；事后有异议再翻案，翻案成本 < 事前评审成本。

---

## 1. 现状（已核实，逐条给证据）

### 1.1 B1 唯一 ChatCore + 单槽 store（**仍真**）

| 事实 | 位置 / 证据 |
|---|---|
| `new ChatCore(` 全仓**唯一**调用点 | `shell/rows/chat.ts:15`（`refs.chatPanel = new ChatCore()`）；`:16` `useCoreStore.getState().setChatCore(refs.chatPanel)` |
| 单槽 store | `app/chat/core-instance.ts:10-13`（`create<{ core: ChatCore \| null; setChatCore }>`，初值 `core: null`） |
| 单例 refs | `shell/runtime.ts:27-38`（`ShellRefs.chatPanel: ChatCore \| null` + `export const shellRefs` 单例） |
| 消费面（**87 处**命中 `panelIdOf(` / `core.panelId` / `refs.chatPanel`） | `app/App.tsx:28/34`（`PromptShelfHost core={core}`）；`composition/space-service.ts:49-51`（`panelIdOf()`）；`plugins/builtin/paper-shell/PaperPanel.tsx:362-363`（`const core = useCoreStore((s) => s.core)`——**消费侧也是全局取用，不是 props**，故改法要两端一起改）；`app/use-document-title.ts:22`；`canvas-nav/SessionSidebar.tsx:123`；`canvas-nav/SpineRack.tsx:66`；`compose-dock/ComposerDock.tsx:204`；`compose-dock/TocStrip.tsx:162` |
| `useCoreStore` **已在冻结基线** | `plugins/host-surface.baseline.json:176`（⇒ 改其形状 = 走基线变更通道） |
| `disposePanelStores` 无生产调用点 | `ui/chat-store.ts:93-95`（自注「面板销毁调用点仍缺，ChatCore 为应用级单例，暂无整包拆除时机」） |

### 1.2 B2 第二实例会拆掉第一实例（**仍真，但设计件低估了修法**）

| 事实 | 位置 / 证据 |
|---|---|
| 模块级登记数组 + **它的存在理由** | `chat-core.ts:115-119`：注释原文「ChatCore 每次重建都新订四个全局 store（ask/agent-panel/goal/workspace-switch），此前从不退订——**重建即累积**（同一事件被多个死实例重复消费）。模块级登记上一实例的退订函数，构造时先解除再重订」 |
| 构造首行无条件清空并执行全部 | `chat-core.ts:183`（`for (const unsub of _globalStoreUnsubs.splice(0)) unsub();`） |
| 四条全局订阅入册 | `:196-200`（ask）、`:206-212`（agent-panel diag）、`:215-219`（goal）、`:222-232`（workspace-switch） |
| ⚠ **本面板订阅也入同一册** | `:282`（`getChatStore(this.panelId).sess.subscribe(...)`）+ `:284`（`agentSessionState.subscribe(...)`）；`:281` 注释「此前漏收——旧实例的订阅永不解除」 |
| `panelId` 每实例唯一 | `:184`（`cp-${Date.now().toString(36)}-${Math.random()...}`） |

**⇒ 纠正（本单要点）**：把 `:119` 的模块级数组改成实例字段，会**同时**废掉「重建不累积」这条防线。
`:282/:284` 之所以进这个册子，正是因为**每实例自己的 store 订阅在旧实例上没人解除**——旧实例没有
销毁时机，模块级「上实例退订」是当时唯一可用的替代。所以 B2 的正解二选一（§7 判断题 2）：

- **甲**：给 ChatCore 加**显式销毁**（`dispose()` 退订实例自有订阅）+ 实例字段持有订阅；
  谁调 dispose = 面板关闭 / core 被替换（接上 `shell/rows/chat.ts` 的生命周期）。
  **代价** = 顺手补上 `ui/chat-store.ts:93` 记的那条欠账（「面板销毁调用点仍缺」）。
- **乙**：保留模块级册子但**改键控**（`Map<panelId, unsubs>`），构造时只清理**同一 panelId 的陈旧实例**
  （重建语义不变），另立「活跃实例表」供共存放行——**改动更小，但把「活跃实例」概念塞进模块级态**，
  与 `CONVENTIONS.md §1.10` 的模块级可变态四级归属需要正面交代。

### 1.3 B3 一 Workspace 只绑一 core（**仍真；且底下还有一条更深的事实**）

| 事实 | 位置 / 证据 |
|---|---|
| 每 Workspace 一个 `_storeId` 单值 | `workspace.ts:517`（`this._storeId = chatPanel.panelId`；`:137` 缺省 `'__default__'`） |
| `_chatPanel` 单值 + 工厂闭包捕获单 core | `:758`（赋值）；`:906`（`eventSink: chatPanel.eventSinkFor(sessionId)`） |
| `Workspace.open` 的 `_chatPanel` 形参**是死参数** | `:213`（下划线命名，方法体 `:211-241` 不读它；真赋值在 `:758`） |
| 壳行单槽 | `shell/rows/workspace.ts:86`（`workspace.deactivate(chatPanel)`）→ `:95`（`shellRefs.workspace = null`）；`:107`（`WorkspaceCls.open(folder, chatPanel, …)`）→ `:121`（`shellRefs.workspace = ws`）；`:205` leaveToHome 同款 |
| **更深的事实：一个工作区一个 Agent runtime** | `workspace.ts:774` 注释明写引擎契约「**一进程一工作区根**」（`ensure_ready` 异根拒绝）；`:196` 每 Workspace 一个 cordis fiber（`workspaceScopePlugin`）⇒ **同一路径两个 Workspace 实例 = 引擎根冲突** |
| 好消息：工厂本就按 storeId 键控 | `setAgentFactory(storeId, fn)`（`agent-session-state.ts:248-256`）⇒ 「一面板一工厂」在数据面已具备形状 |

**⇒ 推论**：可行形态**不是**「两个独立工作区」，而是**同一 Workspace、各自 core**（两面板共享工作区 deps，
各自 `panelId`/会话/视口）。这也顺带回答了设计件 §7.6 的原问「是否共享工作区」——**必须共享**，
否则撞引擎契约。本单据此把 B3 的改法定为「解绑 storeId 单值 + 事件面按所属面板路由」，**不拆 Workspace**。

### 1.4 B4 面板层没有多实例语义（**仍真，四条逐字核实**）

| 事实 | 位置 / 证据 |
|---|---|
| `PanelDef` 无 storeId/instanceKey | `app/panels/panel-def.ts:16-29`（`id` / `side` / `title` / `icon` / `askAgent?` / `unmountOnClose?` / `component: ComponentType`） |
| `PanelContribution` 同形（**这是开放契约面**） | `composition/services.ts:59-72` |
| `DockPanel` 不传 props | `app/panels/DockPanel.tsx:18-27`（`:24` `<C />`）；`:19` `useDockStore((s) => s.open[def.id])` |
| 开合表按 id 布尔 | `state/dock-store.ts:26`（`open: Record<string, boolean>`）；`useDockStore` 在基线 `:178` |
| 面板 = 全屏覆盖层（**今天无分栏承载**） | `PaperPanel.css:8-11`（`.pp-root { position: fixed; inset: 0; z-index: 280 }`）+ 各面板自持 `position: fixed` + `app/tokens.css:129-131` 固定 z 阶梯 |
| 磁盘布局面按**工作区路径**键控、不含 panelId | `state/canvas-store.ts:283-287`（`canvasFilePath(workspace)` = `${norm}/.lantai/canvas.json`）；读写 `:358-403` / `:409-442` |

### 1.5 第 5 道拦路石（**设计件未记，本轮新发现——真成本**）

| 事实 | 位置 / 证据 |
|---|---|
| 视口真源 = **无 storeId 的应用级单例** | `state/canvas-view-store.ts:43`（`export const useCanvasViewStore = create<CanvasViewState>(...)`——**不是** `createScopedStore`）；头注 `:8-10` 自认「app 级单例（画布即主界面，一次只有一个纸视图）」 |
| 它同时是这些面的真源 | `:25` `view`（pan/zoom）、`:47` `canvasSize`、`:30` `restoredView`、`:32` `pendingFocusId` + `setView/restoreView/requestFocus` |
| 消费面 7 文件 ~40 处 | `use-paper-viewport.ts`（:51-54/70/77/88/95/121-144/183/191/207/278/309-323/383/482/488）、`use-paper-focus.ts`（:37/45/55/87/99/109/116/129）、`canvas-store.ts:389/430`、`space-service.ts:127/141`、`SessionSidebar.tsx:368/511`、`SpineRack.tsx:151/182`、`TocStrip.tsx:163/379`、`use-region-placement.ts:24`、`use-jump-keys.ts:38`、`InkLayer.tsx:77` |
| **已在冻结基线** | `host-surface.baseline.json:174`（`useCanvasViewStore`） |

**⇒ 「独立视口/缩放」的成本在这里，不在 B4。** B4 决定「两个画布摆在哪儿」，它决定「两个画布各自看哪儿」。

### 1.6 已经建好的那一半（**本批的最大利好**）

| 事实 | 位置 / 证据 |
|---|---|
| scoped store 注册表原语现成 | `state/scoped-store.ts:35`（`createScopedStore(key, createImpl)`——window 挂 Map + `getStore(storeId?)` 惰性建 + `disposeStore` / `disposeStoresByPrefix`） |
| 已有 7 个注册表走在它上面 | messages(`messages-store.ts:97`) / session(`session-store.ts:59`) / panel(`panel-store.ts:115`) / input(`input-store.ts:136`) / canvas(`canvas-store.ts:259`) / compose(`compose-store.ts:156`) / asset(`asset-store.ts:87`) |
| `panelId` 就是 storeId | `chat-core.ts:544` / `:590`（`const storeId = this.panelId`） |
| Agent 句柄/组合登记全键控 | `agent-session-state.ts`（全 API 带 storeId；复合键 `${storeId}:${sid}` `:135-137`；`clearPanelState` 按前缀清 `:288-312`） |
| ⇒ **panelId 隔离键早已全线铺好** | 缺的只是「core 实例本身」「视口」「面板容器」三件 |

---

## 2. 目标形态（建议）

### 2.1 笔 1 = 决定性 spike（本批的第一笔，也是唯一必须先做的一笔）

**目标**：一次会话内回答「两个 ChatCore 能否共存」，**不碰 B3/B4、不碰视口、不碰磁盘面**。

1. `core-instance.ts` 加多槽（spike 期可与旧单槽并存，避免一次性改 87 处消费点）；
2. 在**既有**并排 harness（`tests/paper-side-by-side-agents.test.tsx` + `tests/paper-new-volume.test.tsx:22-101`
   的模板：mock `@chenglou/pretext`/`rich-inline`/`../src/bridge` + Fake 2d ctx + 确定性 rAF + 真 `new ChatCore()`）
   里造**两个真 ChatCore**（A、B），各自 `setAgentFactory(pid, stub)`，直写各自 `getChatStore(pid).sess` 塞一卷；
3. **只打 B2 的正解补丁**（§1.2 甲或乙，按 §7 判断题 2）；
4. **验收判据（三问，全绿才算共存）**：
   - ① **归属隔离**：对 A 推一条 pending ask ⇒ **A 收到、B 未收到**（今天 A 会因 B 构造而永久失聪）；
   - ② **不互拆**：B 构造后，A 的 exec 起停仍能驱动 A 的状态栏（即 A 的 `:282` 订阅仍活）；
   - ③ **数据面不串**：A/B 各自 `msgStoreFor(pid,sid)` 写入互不可见，且 `A.panelId !== B.panelId`；
5. **不做**：不渲染两个 `PaperPanel`、不动 `canvas-view-store`、不动 `PanelDef`。
   若 ①②③ 绿而渲染面红 ⇒ 结论 = **「多 core 可共存、多面板是另一件工程」**——这正好把七面切成
   「一笔 + 一个独立批次」，与 §0 结论 4 一致。

### 2.2 笔 2..N = 共存之后的形态（**spike 绿才做**）

- **笔 2 多 core 承载**：`core-instance.ts` 改 core 注册表（`cores: Record<storeId, ChatCore>` +
  `useCore(storeId)`）；`shell/rows/chat.ts` 造第二个 core；消费面（`App.tsx:28/34` 的 `PromptShelfHost`、
  `space-service.ts:49-51` 的 `panelIdOf()`、`PaperPanel.tsx:362`）改**按面板取参**。
  `panelIdOf()` 今天无参 ⇒ 必须引入「哪个面板」这个概念（今天不存在）。
- **笔 3 面板多实例语义**：`PanelDef` / `PanelContribution` 加实例键（或 `component` 改接 props）；
  `DockPanel.tsx:24` 传 props；`dock-store.ts:26` 的 `open` 键改复合。**`PanelContribution` 是开放契约 ⇒ 升版。**
- **笔 4 布局容器**：真分栏（矩形槽位 + 分隔条 + 面板级布局持久化）——**今天完全没有**（各面板 `position: fixed` 全屏）。
  §7 判断题 5 会给一个更便宜的替代形态。
- **笔 5 独立视口**：`useCanvasViewStore` 参数化（§1.5，7 文件 ~40 处 + 基线）——**建议不并入本批**。
- **笔 6 磁盘面分账**：`canvas.json` 按工作区路径键控 ⇒ per-panel 段——**建议不并入本批**。

### 2.3 本批**不做**（明确边界）

- **不拆 Workspace**（§1.3：撞引擎契约「一进程一工作区根」）⇒ 两面板**共享工作区**；
- **不给两面板不同组合**（那部分今天已成立：同纸多卷 P0/P1 已落 + P5b 已验收）——
  真面板并排买到的是**独立视口 / 独立活跃卷 / 面板级布局持久化**，**买不到组合隔离**（设计件 §8.5 事实 3 原话）；
- **不动** `resolveRoster` / `effectiveComposition` / `AgentConfig`（28 字段）/ 出厂 preset 面。

---

## 3. 默认路径零漂移（构造性论证）

1. **单 core 路径逐字不变**：今天 `shell/rows/chat.ts` 只造一个 core、`useCoreStore` 只有一槽
   ⇒ 只要笔 2 的注册表在「只有一个 core」时行为与单槽等价（取参缺省 = 唯一实例），**既有 87 处消费点零改动**；
2. **数据面零改动**：`panelId` 已是 storeId、scoped store 注册表原语现成 ⇒ 不新增状态机制
   （沿 `CONVENTIONS.md §1.10` 的模块级可变态四级归属，新增态一律归入其一类并就地注释）；
3. **B2 的修法必须保住「重建不累积」**（§1.2）：spike 的破测③**专门**钉这一条——
   若修完 B2 后「重建一次 = 订阅不累积」变红，说明修法错误（复活了 `2026-09-01 审计` 的老 bug）；
4. **不动模型可见面**（工具 schema / prompt 段 / capability）⇒ 两轨 `tool-schemas` 与
   `system-prompt.fixture` 逐字节不变，**不新增 baseline 快照、不跑 `record`**；
5. **契约**：笔 1/笔 2 不碰 `OPEN_SURFACE_CONTRACT_FILES`（`core-instance.ts` / `shell/rows/chat.ts` /
   `space-service.ts` 均不在册）⇒ **spike 期契约仍 v39**；笔 3 加 `PanelContribution` 形状 ⇒ 必升版
   （届时**顺带折入两处陈旧注释**，见 §6）；面板面是插件面、**不是模型可见面** ⇒ 升版**不应**引起快照漂移
   （这条要在笔 3 当场验证，不许假设）；
6. **哨兵**：`tests/paper-side-by-side-agents.test.tsx`（3 例）、`tests/seam-composition.test.ts`（⑨-⑬）、
   `tests/composition-session-count-profile.test.ts`、`tests/workspace-lifecycle.test.ts`（T0）、
   `tests/workspace-fiber.test.ts` 若需改动 = 既有语义被改坏（应**零改动**）。

---

## 4. 施工切分（建议：笔 1 独立交付并能单独结案）

| 笔 | 内容 | 关键产物 | 可否独立结案 |
|---|---|---|---|
| **S7a** 决定性 spike | `core-instance.ts` 多槽（可与旧单槽并存）+ B2 正解补丁 + 三问验收 + **破测四条**（见 §5） | 一份「多 core 可/不可共存」的**结论 + 证据**（结论若红，本批就地收口） | ✅ 可（这正是先做它的理由） |
| **S7b** 多 core 承载 | core 注册表 + 第二 core 装配 + 消费面按面板取参（`App.tsx` / `space-service.ts` / `PaperPanel.tsx`） | 两个 core 真并存且互不干扰 | ✅ |
| **S7c** 面板多实例语义 | `PanelDef`/`PanelContribution` 实例键 + `DockPanel` 传 props + `dock-store` 复合键 + **契约升版**（顺带折入陈旧注释） | 一面板一实例可寻址 | ✅ |
| **S7d** 布局容器 | 真分栏 / 或 §7 判断题 5 的替代形态 + 面板级布局持久化 | 两面板同屏可见 | ✅ |
| **S7e（建议独立批次）** | 独立视口/缩放（`useCanvasViewStore` 参数化，7 文件 ~40 处 + 基线变更） | 各看各的 | — |
| **S7f（建议独立批次）** | 磁盘面分账（`canvas.json` per-panel） | 面板级布局落盘 | — |

**依赖**：S7a → S7b → S7c → S7d（S7e/S7f 挂在 S7d 之后，可各自独立立项）。
**每笔独立全绿独立 commit**（沿 S6 惯例）；**S7a 若红，S7b-d 不立项**。

---

## 5. 测试与破测（新增从用户操作序列新写；破测逐条验证能红）

| # | 断言 | 形状 |
|---|---|---|
| 1 | **两 core 共存（spike 主判据）** | 进程内/jsdom：造 A、B 两个真 ChatCore ⇒ ①A 推 pending ask 只有 A 收 ②B 构造后 A 的 exec 起停仍驱动 A 的状态栏 ③A/B 数据面互不可见且 `panelId` 不同 |
| 2 | **重建不累积（B2 的回归哨兵）** | 同一 core 被重建 N 次 ⇒ 每个全局事件**只被消费一次**（计数台：订阅者数不随重建次数增长）——**这条是修 B2 不许碰坏的那条既有防线** |
| 3 | **销毁对称（若取 §1.2 甲案）** | `dispose()` 后实例自有订阅全部解除（订阅计数归零），且再构造新实例不影响已销毁者的行为 |
| 4 | **单 core 零漂移** | 只造一个 core 时，行为与今天逐字相同；`useCoreStore` 既有消费面（87 处）零改动 |
| 5 | **两面板各持视口（S7e 才验）** | 两面板 pan/zoom 互不影响（今天 `useCanvasViewStore` 单例 ⇒ 必红，作为 S7e 的前置证据） |
| 6 | **面板级布局落盘（S7f 才验）** | 两面板各自布局重启后各自恢复（今天 `canvas.json` 按工作区键控 ⇒ 必红） |

**破测（每条注入缺陷确认能红，结果写进 commit message）**：
① 把 B2 的补丁退回模块级无条件 `splice(0)` ⇒ 1 红（A 失聪）；
② 只把订阅数组改成实例字段、不加销毁/键控 ⇒ **2 红**（重建即累积——**这一条是防止"看起来修好了"的陷阱**）；
③ 多槽 store 改回单槽 ⇒ 1③ 红（两 core 抢同一槽）；
④ 两条命令各自断言 A、B 收到自己的 ask ⇒ 摘掉「按 panelId 取 core」⇒ 1① 红。
**照 P5b 教训**：破测同时是**断言有效性的验收**——若某条注入照绿，先怀疑断言没牙（P5b 的 ⑤a 就是首跑照绿、改现场后才有牙），别急着换注入。

---

## 6. 契约与文档

| 面 | 笔 1/2（spike + 多 core） | 笔 3（面板多实例） |
|---|---|---|
| 开放面契约 | **不动（仍 v39）**——不碰 `OPEN_SURFACE_CONTRACT_FILES` 任一文件 | **必升版**（`PanelContribution` 形状）——四步流程：改契约文件 → bump → `docs/agents/open-surface-contract.md`「当前版本」+ 变更记录加行 → `npm run gen:contract-fingerprint` → 同 commit（号一律提交时点重读） |
| `host-surface.baseline.json` | **可能变**（`useCoreStore` 已在册 `:176`）⇒ `npm run gen:host-surface` 同 commit | 同；另 `useDockStore`(`:178`) 若键形状变也在此 |
| convergence 双轨 | **零漂移**（不动模型可见面） | 面板面非模型可见面 ⇒ **预期零漂移**，但**必须当场验证不许假设** |
| 生成物 | service/event catalog 不动（无新 ctx 键、无新事件） | 同 |
| 文档写回 | 设计件 §8.5 事实 3 补「第 5 道拦路石 = `useCanvasViewStore`」+ §7.6 裁定落账 + 本单结论 | `docs/plugins/README.md`（`PanelContribution` 形状）+ 手册 |

> **顺带清偿（用户 2026-09-16 裁定：折进下一个会合法升版的批次）**：`composition/services.ts:145/245`
> （DockRail 已删引用）与 `composition/roster.ts:9/261`（capability「十五项」实为十四项）两处陈旧注释
> 属同批漂移，但这两个文件在契约清单里、而指纹 = 逐文件 sha256 全文（**含注释**）⇒ 改一行注释就要升版。
> **笔 3 会合法升版 ⇒ 把这两处折进笔 3 同一笔**（不单开"注释版"）。若笔 3 最终不升版，这两处继续挂着。

---

## 7. 原请示（九道判断题）——**已裁定：见 §0.5；本节保留供对账，不再是待办**

| # | 判断 | 我的建议 | 影响面 |
|---|---|---|---|
| **1** | **批次范围**：先做决定性 spike（笔 1 可单独结案），还是直接按「两面板并排含独立视口」整批立项？ | ✅ **先 spike**。理由：spike 能一次会话内把「多 core 可共存 / 多面板是另一件工程」这个二分**钉成事实**，而 §1.2 的纠正说明连"最便宜的那一刀"都含一条架构决策——先证实再投入，避免为一个可能被证伪的方向铺七面 | 决定本批的量级与是否成立 |
| **2** | **B2 修法**（本批唯一的既有行为改动）：**甲** = 给 ChatCore 加显式销毁（实例字段持有订阅 + 面板关闭/core 替换时 dispose，顺手补 `ui/chat-store.ts:93` 的欠账）；**乙** = 保留模块级册子但改 `Map<panelId, unsubs>` 键控 + 另立活跃实例表 | ✅ **甲**。理由：乙把"活跃实例"塞回模块级态（与 `CONVENTIONS §1.10` 四级归属正面冲突），且它只是把"上实例退订"从"全部"收窄成"同 panelId"——**多面板共存迟早要一个真正的销毁时机**，不如这一步就立起来。代价 = 多一个 dispose 契约与它的调用点（笔 1 内做） | B2 的修法与「重建不累积」这条既有防线的形态 |
| **3** | **spike 红了的处置**：结案留档 / 换路线（乙 scope realm）/ 加预算继续攻？ | ✅ **结案留档**（写明证伪的具体判据与现场），不在同一批里换路线硬攻——路线级改判另立设计件 | 是否给本批设"证伪即止"的闸 |
| **4** | **两面板是否共享工作区**（设计件 §7.6 原问）：共享（同一 Workspace/deps，各自 core）还是各自独立（两套 deps）？ | ✅ **共享**——不是偏好而是约束：`workspace.ts:774` 的引擎契约是「一进程一工作区根」，同路径两个 Workspace 实例直接撞（§1.3）。**本单据此把 B3 的改法定为「解绑 storeId 单值 + 事件面按面板路由」，不拆 Workspace** | B3 的改法面与是否触碰引擎契约 |
| **5** | **布局容器形态**：真分栏（矩形槽位 + 分隔条 + 布局持久化，要重做各面板的 `position: fixed` 全屏范式）还是**更便宜的替代**——两面板仍为覆盖层，但各占半屏、边界可拖（不动 `.pp-root` 族与 z 阶梯）？ | ✅ **先做便宜的替代形态**（笔 4 内先交它），把"真分栏 + 面板级布局持久化"留到有真实手感反馈之后再议。理由：`PaperPanel.css` 4954 行 + 全仓面板 `position: fixed` 范式，重做量级远超"并排能看见"这个诉求；先用最小形态验证手感，避免为一个未经验证的布局范式铺大工程 | 笔 4 的量级（天 vs 周）|
| **6** | **面板多实例的键**：`PanelDef`/`PanelContribution` 加 `instanceKey?`，还是 `component` 改成接 props（`ComponentType<{ storeId: string }>`）？ | ✅ **加 `instanceKey?` + 保持 `component` 不接 props**：面板组件今天一律走 `useCoreStore`/`panelIdOf()` 全局取用（`PaperPanel.tsx:362`），改 props 要同时改 87 处消费侧；`instanceKey` 是**增量**（缺省 = 单实例，今天语义逐字不变），且 `ContributionChannel` 本就按 key 注册 | 契约形状变更的方向与消费面改动量 |
| **7** | **是否在同批做独立视口**（`useCanvasViewStore` 参数化，7 文件 ~40 处 + 冻结基线）？ | ❌ **同批不做**（S7e 独立立项）。理由：它才是"独立视口"的成本所在，混进来会让本批从"能看见两个面板"膨胀成"重做视口真源"，回滚粒度也糊掉 | 本批量级与回滚粒度 |
| **8** | **磁盘面分账**（`canvas.json` per-panel）本批做不做？ | ❌ **同批不做**（S7f 独立立项）——沿判断题 7 同理；且它与并发线的会话存盘域邻近 | 批次边界 |
| **9** | **门禁层级**：进程内行为测试 + jsdom 组件测试 + 真机验收交用户（沿 P1e/P5 先例）？ | ✅ **同上**。cdp e2e 是环境型抖动源（AGENTS §10）；截图 golden 本仓无机制（设计件 §8.5 事实 4）。真机验收必须由你走（`cargo tauri build` 后可见），并且**排在 P5 真机验收之后**（§9） | 门禁耗时与"谁来验" |

---

## 8. 红线

- **不动** `resolveRoster` / `resolvePresetComposition` / `effectiveComposition` 的签名与语义；
  **不动** `AgentConfig`（28 字段，`gate.mjs` 断言）；**不动**出厂 preset 面；**不新增 baseline 快照、不跑 `record`**。
- **不改模型可见工具 schema / prompt 段 / capability**（一改即两轨快照漂 ⇒ 走 `baseline-change-request` 审批通道）。
- **B2 的修法必须保住「重建不累积」**（§1.2 + 破测②）——那是 `2026-09-01 审计` 的既有防线，
  修掉它比不修更糟；`chat-core.ts:115-118` 的注释解释了它的存在理由，改前先读它。
- **不拆 Workspace**（引擎契约「一进程一工作区根」，`workspace.ts:774`）。
- **冻结文件**：`ui/chat-session.ts`、`ui/chat-stream.ts`、`ui/part-mutator.ts`、`agent/execution-state.ts`
  ——本批预计**一个都不碰**；若要碰，先问用户（P4 有"点头才碰"先例）。
- **`ui/` 是冻结残余目录**：新文件落 `app/**` 或既有插件目录（守卫 `tests/eventbus-zero-and-ui-split.test.ts`，
  UI_MANIFEST 冻结 59 项、终态 ≤26）。
- **模块级可变态四级归属**（`CONVENTIONS §1.10`）：新增的 core 注册表/活跃实例表必须归入其一
  并在声明处注释（甲案走 fiber/实例所有权；乙案要在注释里正面交代为什么留在模块级）。
- **并发工作线射程内文件**：`workspace.ts`、`rpc-contract.ts`、`src-tauri/src/rpc.rs`、`host-modules.ts`、
  `host-surface.baseline.json`、`docs/**`、`AGENTS.md`/`CLAUDE.md`。
  纪律：每笔只 `git add` 本线显式路径（**不 `git add -A`**）；门禁红了先判归属
  （`git stash push -u -- <本线路径>` → 跑该用例 → `git stash pop`，链在一条命令里）；
  改前 `git status -- <文件>` 查净、改后尽快提交。
  **另（P4/P5 实测教训）**：本工作区出现过「未提交的源文件被外部操作清空/删除」两次 ⇒ 改完**立即**
  在 `D:\tmp` 留备份再跑测试；破测注入用「读空即抛守卫 + 备份恢复 + 哈希比对」，禁裸 `[System.IO.File]::ReadAllText` 内存还原。
- **测试纪律**：行为未变 → 测试零改动（黄金标准）；行为退役 → 同批整删；行为新增 → 从用户操作序列新写；
  禁止「改造后放回原位」；新增用例必须做**破测验证**并把结果写进 commit message。
- 本机纪律：凡 npm/vitest 命令先 `$env:NODE_ENV='test'`（否则 jsdom 假红 + `npm install` 剥 devDependencies）；
  性能判据一律 **min（p75 次之）**，绝对 ms 不进红绿。

---

## 9. 开工前置

- **验收顺序（请先办）**：**P5 真机验收仍挂起**（卷首组合芯片 / 两卷并排 / 远档看不到芯片），
  对象须 `cd src-tauri && cargo tauri build` 后可见（dev 态看不到产物插件改动）。
  本批会动到面板承载与视口附近的面 ⇒ 建议**先做 P5 真机验收再开会话开工**，否则本批一落地，
  待验面又多一层、问题归属更难切。
- 门禁基线（本单开工前实测，HEAD `673f4229`，工作区干净）：
  vitest **319 文件 3185 passed / 3 skipped** · `biome ci` **0/0（784 文件）** · `npm run build` ✓ ·
  `verify:convergence` **双轨 exit 0** · `doc-sync` ✓（开放面契约 **v39** 指纹一致）·
  `bench:assembly` 内存 standard 中位 **0.79MB** / 三卷 **1.59MB**、裸查表 ~100ns、fs 派发 11.8µs。
- 调研证据：本单 §1 每条 file:line 为本轮实读（两路只读子代理交叉核对 + 本单作者逐条复核；
  §1.2 的「不是六行」与 §1.5 的「第 5 道拦路石」是本轮的**新结论**，已与设计件原文并记以便对账）。
