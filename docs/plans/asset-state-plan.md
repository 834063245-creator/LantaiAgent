# 资产状态（asset-state）· 施工单

> 立项 2026-10-07 · 状态：**代码已落地（2026-10-07）；余真机验收** · 范围：kind `html` 的交互态（v1 最小闭环）
> 施工记录与两处设计修订（键系 / 删卷挂点）见 **§8**；门禁全绿（vitest / build / biome ci / convergence / doc-check）。
> 触发原话：「HTML 作为文件天生不就可以被修改的么」→「如果生成的 KIND 是可编辑的，比如 HTML，被编辑之后能被 Agent 读到新版本吗？」→「我主要怕你说的键值对表加在现有的东西上，会导致代码纠缠在一起……我想的是这一套东西要不就作为某个独立模块运作比较好」
> 先例真源：`agent/board-persistence.ts`（防抖落盘）、`agent/asset-store.ts`（内核表 + scope）、`renderers/components.tsx` 的 `buildHtmlCardDocument`（沙箱桥）

## 0. 一句话

给沙箱 html 卡配一根**存档线**：iframe 里的交互经既有 postMessage 桥写回内核 → 按会话防抖落盘（复用 `BoardPersistence`）→ Agent 侧在 `list_block_kinds` 的资产清单里读状态摘要。

## 1. 现状（施工前必读，四个既有事实，本批全部复用、不新造）

1. **桥骨架已存在**。`src-ui/src/plugins/builtin/renderers/components.tsx` 的 `buildHtmlCardDocument()` 已向沙箱 iframe 注入脚本，用 `postMessage({type:'lantai.card-resize', height})` 上报高度；`HtmlBody` 已在监听并按 `e.source !== iframeRef.current?.contentWindow` 校验来源。本批只给这条协议**加第二个消息类型**。
   - 沙箱约束（不可放宽）：iframe `sandbox="allow-scripts"`（无 allow-same-origin）、文档级 CSP `connect-src 'none'`。iframe 拿不到宿主 DOM、无网络，postMessage 是唯一出口。
2. **防抖落盘设施已存在**。`src-ui/src/agent/board-persistence.ts` 的 `BoardPersistence`：目录创建、2 秒防抖、串行写链、restore/destroy；落点 `<project>/.lantai/<dirName>/<sessionId>.json`。现成用法两处：`plugins/builtin/task-domain/task-board.ts`、`agent/discovery-board.ts`。
3. **内核资产表已存在**。`src-ui/src/agent/asset-store.ts`：`scope → assetId → AssetRecord` 的模块级单例；`removeAsset(scope, assetId)` 已预留"生命周期挂接"位（WO-5）。
4. **宿主桥双走查纪律**。renderers 是产物化内置插件：任何新的内核依赖**必须同时改三处**——`renderer-host.ts`（开发/测试域直连）+ `renderer-host.aliased.ts`（产物域经 `window.__lantai_plugin_host__.mods.faceDeps` 取用）+ `plugins/builtin/host-modules.ts`（面键注册）。先例：`createBlock`、`activeMarkdownBody`。**漏改任一处 = 产物域运行时偏斜**。

## 2. 定案摘要

| # | 定案 | 依据 |
|---|---|---|
| **D1** | 只服务 kind `html`，其余 kind 不接状态面 | 交互态只存在于沙箱卡；表/图/指标无用户写入语义 |
| **D2** | 状态**不进会话日志**：真源 = `.lantai/asset-state/<sessionId>.json`（与消息真源平行，互不污染） | 会话日志是"会话事实"的地方；高频交互态进去会撑爆并破坏回放语义 |
| **D3** | 写入语义 = **浅合并 patch**；值必须 JSON 可序列化；单资产上限 **64 KiB**（写后序列化字节数，超限拒绝 + warn） | 卡片按字段增量写（输入框只写自己那格），不整份覆盖 |
| **D4** | v1 **只做 Agent 读口（摘要），不做写口** | 写口要等"Agent 为什么改卡片状态"的真实需求；读口立刻有用（核对/回读） |
| **D5** | **不做冲突检测（后写赢）**，不做跨会话共享 | 单写者场景（卡片自己的 UI）足够；版本号是另一个立项 |
| **D6** | 内核单例放 `agent/` 层（不是 `state/` 的 zustand scoped store） | 三个消费方（渲染器插件 / asset 域工具 / 会话生命周期）取**同一份**；对齐 asset-store 同层同族 |
| **D7** | 状态按 **assetId** 索引（多视图同源）：同一资产在流里与架上各挂一份时，读的是同一份状态 | 资产身份即真源；v1 不做实例级分叉（Hana 的 pin 副本语义是另一个立项） |

## 3. 批次（施工顺序 B1 → B6，一步一绿）

### B1 · 内核模块 `src-ui/src/agent/asset-state.ts`（新文件）

职责单一、零依赖（不 import renderer / state 层）。内存形状：

```
scope -> assetId -> { [key: string]: unknown }
```

导出面（命名对齐 asset-store 风格）：

- `getAssetState(scope, assetId): Record<string, unknown> | null`
- `patchAssetState(scope, assetId, patch: Record<string, unknown>): { ok: true } | { ok: false; error: string }`
- `clearAssetState(scope, assetId): void`
- `disposeAssetStateScope(scope): void`
- `listAssetStateSummary(scope): Array<{ assetId: string; keys: number; bytes: number }>`（Agent 读口用）
- 落盘面：内部持有 `BoardPersistence({ projectPath, sessionId, dirName: 'asset-state' })`；
  `configureAssetStatePersistence(projectPath, sessionId)` / `restoreAssetState(): Promise<void>` / `flushAssetState(): Promise<void>`

坑位（施工时逐条确认）：

- **scope 键系必须与 `agent/asset-store.ts` 的 `scopeOf` 语义一致**（照抄，不发明新键系）；落盘定位参数 `(projectPath, sessionId)` 由调用方在会话激活时 configure 一次。
- 值白名单式判定：`undefined` / 函数 / Symbol / 循环引用一律拒绝并回带窗错误；序列化用 `try/catch` 包裹。
- 上限判据用**序列化后字节数**（不是键数）。
- `restore` 是异步的（kernel RPC）。语义定死：**restore 完成前读到 `null`；restore 进行中发生的写入，恢复完成后以"内存已有"优先**（当帧用户输入赢，不被恢复覆盖）。
- 模块级单例，但每个 scope 的表独立（对齐 asset-store 的 `tableOf` 模式）。

### B2 · 桥扩展 `renderers/components.tsx`

| 项 | 落点 | 语义 |
|---|---|---|
| 协议常量 | 与 `HTML_CARD_NS` 同族：`HTML_CARD_STATE_NS = 'lantai.card-state'` | 见下方消息形状 |
| 注入脚本 | `buildHtmlCardDocument()` 内追加 `window.lantai.state`：`get()` / `patch(obj)`；reqId 自增配对、2s 超时 reject；无宿主时 reject 并给出可读文案 | 卡片作者（模型）的唯一 API；注释里写明"这是 html 卡的存盘口" |
| 宿主处理 | `HtmlBody` 的 `onMessage` 加分支：`e.data?.type === HTML_CARD_STATE_NS`，**沿用**既有 `e.source` 校验 | 校验不过一律静默忽略（对齐高度上报现状） |
| 上下文定位 | **施工首件**：确认 `HtmlBody` 能拿到当前 `(projectPath, sessionId)` | 拿不到就在块渲染上下文/paper 上下文里找；找不到 = 阻塞项，**不许硬编码** |

消息形状（固定）：

```
子 → 父：{ type: 'lantai.card-state', req: 1, op: 'get' }
        { type: 'lantai.card-state', req: 2, op: 'patch', patch: { ... } }
父 → 子：{ type: 'lantai.card-state', req: 1, ok: true, state: { ... } }
        { type: 'lantai.card-state', req: 2, ok: false, error: '...' }
```

### B3 · 宿主桥面（双走查三处 + 构建）

| 项 | 落点 |
|---|---|
| 面键注册 | `plugins/builtin/host-modules.ts`：faceDeps 增 `assetState` 键（get / patch / summary 的函数引用） |
| 开发域出口 | `renderers/renderer-host.ts`：加 `rendererAssetState()`（形状纪律同 `rendererActiveMarkdownBody`） |
| 产物域出口 | `renderers/renderer-host.aliased.ts`：同形，从 `host.mods.faceDeps` 取 |
| 构建 | 面键提取器 / face.json 按 first-party-hot-reload-plan 既有流程重跑；第一方插件产物重建 |

### B4 · 生命周期联动（三条）

| 路径 | 落点 | 语义 |
|---|---|---|
| 会话消亡 | `ui/chat-session.ts` 中 `disposeAssetSessionStore(...)` 的**三处**调用点旁，同步 `disposeAssetStateScope(...)` | 合卷 / 删卷 / 工作区重置 |
| 单条资产删除 | `agent/asset-store.ts` 的 `removeAsset` | 挂接 `clearAssetState`（WO-5 预留位） |
| 文件清理 | 会话删除路径 | `.lantai/asset-state/<sessionId>.json` 随会话消亡删除（对齐 `BoardPersistence.destroy` 的尽力而为语义） |

### B5 · Agent 读口（v1 只读）

`plugins/builtin/asset-domain/asset-tools.ts` 的 `list_block_kinds`：inventory 每行追加状态摘要，形如 `状态 3 键 / 128 字节`；无状态不显示。取用经 `asset-domain/host.ts` 加一行导出（同层内核模块，零新通道）。

### B6 · 文档与门禁

- 本文件进 `docs/plans/README.md` 活跃线；竣工归档 `docs/archive/` + 补 `HISTORY.md`。
- B5 影响模型可见工具面（`list_block_kinds` 输出形状）⇒ 跑 `doc-sync` / `gen:doc-facts`（以既有流程为准，有数字漂移以重跑为准）。

## 4. 判据（测试清单，只写用户操作序列，不写实现形状）

`src-ui/tests/asset-state.test.ts`（新）：

| 用例 |
|---|
| 用户在一张 html 卡里输入 → 块重挂载（滚走再滚回）→ 值还在 |
| 两次 patch 不同键 → 两个键都在（浅合并） |
| patch 超限值 → 被拒绝，既有状态不变 |
| patch 非对象 / 含函数 / 循环引用 → 被拒绝 |
| 会话消亡（dispose scope）→ 状态清空 |
| 落盘恢复：patch → flush → 新实例 configure + restore → 值一致 |
| restore 未完成时写入 → 恢复完成后当帧输入不被覆盖 |

`src-ui/tests/html-card-state-bridge.test.tsx`（新）：

| 用例 |
|---|
| iframe 发 `lantai.card-state` patch → 内核 store 更新（经渲染组件） |
| 非本 iframe source 的消息 → 被忽略 |
| 未知 type / 畸形 payload → 被忽略、不抛 |

（样板纪律：`tests/session-repro-ghost-volume.test.ts`——实现变桩，判据不动。）

## 5. 门禁（不过不 commit）

```
cd src-ui
npx vitest run
npm run build                 # 含 build:builtin-plugins；产物域偏斜在 build 里抓
npx biome ci .
npm run check:builtin-plugins # 产物一致性（若与 build 重复以仓库流程为准）
npm run verify:convergence    # 本批动了 agent/** ⇒ 需要
npm run doc-check
```

## 6. 显式排除（v1 不做）

- Agent 写口（工具改卡片状态）
- 状态版本冲突检测 / 多写者合并
- 跨会话共享状态、状态的导出与迁移
- `kind != 'html'` 的状态接入
- 权限 / 授权面（状态是本地数据：不触网、不出沙箱）
- 状态的实时多视图广播（同一 assetId 多处挂载时，各自挂载时取一次；后写赢）

## 7. 部署面（诚实栏）

- 状态文件：`<project>/.lantai/asset-state/<sessionId>.json`
- 恢复语义：会话激活后按需恢复；未恢复前的读返回空
- 孤儿状态：资产从消息中消失后，其状态项可能残留在文件里（无害、不会被读到）；要清理属后续小批
- 与资产事件管道的关系：状态**不参与** AssetDelta / Asset 事件（纯旁路），消息真源零污染
- 前提依赖：B2 的"会话上下文定位"是**硬前提**，未落实前 B1/B3 可先行、B2 阻塞

## 8. 施工记录（2026-10-07，本批落地）

**落地范围**：B1-B5 全量落地（B6 门禁全绿）；施工中按代码实况修订三处（下方），其余照案执行。

### 修订一（B1 键系）：owner scope（bus id）→ 会话键 `(projectPath, sessionId)`

原文要求「scope 键系与 `agent/asset-store.ts` 的 scopeOf 一致（bus id）」——施工侦察否决，理由：
1. **写入方拿不到 bus id**：写入发生在渲染层（iframe 桥 → `HtmlBody`），它知道的是（纸壳递下的）工作区路径与会话号；bus id 只在 Agent 装配面可见。
2. **bus id 是「本轮装配实例」的 id**：重启 / 重建句柄即换，而状态真身属于**会话**（落盘文件本来就按会话号命名）——用实例 id 做持久化键是把实例当实体。
3. **同源先例**：TaskBoard / DiscoveryBoard 就是「会话级资源」：runtime 按 sessionId 建板 + `BoardPersistence` 按 sessionId 落文件——本键系照抄它们，不是新发明。

Agent 读口因此需要一个「owner（`_owner_id`）→ 会话号」的解析面：落在 `agent/session-context.ts`（新表 `sessionByOwner`，runtime 在 `_bindAgentSession` / `_materializeSessionServices` 两处写入、`_disposeAgent` 清理），对外出口 `listAssetStateSummaryForOwner(ownerId)`。

### 修订二（B4 文件清理）：挂**真删除**路径，不挂合卷

原文说「会话消亡（disposeAssetSessionStore 调用点旁）同步清理」——施工修正：`closeSession`（合卷）与 `deleteSessionFile`（真删除）**共享同一路径**，在 closeSession 处清 = 合卷即丢状态（用户把卷收回侧栏，再打开时卡里写的东西没了）。改为：**真删除**（`deleteSessionFile`，卷文件被真删处）→ `removeAssetStateSession(projectPath, sessionId)`（清内存 + 删文件）；**合卷保留**（续开时从磁盘恢复）。

### 修订三（B2 上下文定位落实方式）：BlockRendererProps 加两个可选字符串

「HtmlBody 能拿到当前 (projectPath, sessionId)」落实为：`composition/renderer-service.tsx` 的 `BlockRendererProps` 增 `sessionProjectPath?` / `sessionId?` 两个**字符串**字段；`PaperPanel` 三处块渲染点填（流内块 / 钉住块 / 孤儿钉——孤儿钉源卷已删则不填）；`BlockView` 原样转交块体渲染器。用字符串不用对象：Props 比对新旧，对象字面量每次渲染换引用会击穿 BlockView 的 memo（纸面平移帧全块重渲）。

### 落地清单（文件）

- 内核：`src/agent/asset-state.ts`（新）；`src/agent/session-context.ts`（owner→会话表）；`src/agent/runtime/runtime.ts`（三处接线 + 预热）
- 桥：`src/plugins/builtin/renderers/components.tsx`（注入脚本 `window.lantai.state` + HtmlBody 应答面）；`renderer-host.ts` / `renderer-host.aliased.ts`（`rendererAssetState`）
- 壳：`src/composition/renderer-service.tsx`（Props 两字段）；`src/plugins/builtin/paper-shell/PaperPanel.tsx`（三处填值）
- 面：`src/plugins/builtin/host-modules.ts`（faceDeps +3 键）+ `host-surface.baseline.json` 重生成（指纹 `251cbd2a → 8ac3c19a`）
- 读口：`src/plugins/builtin/asset-domain/*`（list_block_kinds 行尾状态摘要）
- 教学（第二 commit `4ba106d8`）：`src/agent/asset-kinds.ts` —— html kind 描述带出 `window.lantai.state` 用法（patch/get + 上限 + 状态读数可见）。**机制若不被卡作者（模型）知道，对模型生成的卡等于空转**；kind 描述是模型写卡前唯一的发现面（已验证非契约面：convergence 快照与生成物均不含 kind 描述）
- 清理：`src/ui/chat-session.ts`（`deleteSessionFile` 一处）
- 测试：`tests/asset-state.test.ts`（14 例）、`tests/html-card-state-bridge.test.tsx`（5 例）

### 余项（真机验收，须重建 exe）

1. 卡里输入 → 滚走再滚回：值还在（同一卷）；
2. 卡里输入 → 切走工作区再回来 / 重启应用：值还在（重启后首帧可能先空一拍——读盘恢复完成前读到 null 是既定语义）；
3. 让 Agent 做一张带输入/勾选的 html 卡（kind 描述已教它用 `window.lantai.state`）→ 操作后 `list_block_kinds` 行尾出现「用户状态 N 键 / B 字节」；
4. **删卷**（侧栏删除）→ `.lantai/asset-state/<该卷号>.json` 消失；**合卷** → 文件保留、续开恢复。
