# 插件文档通道（受治文档面）— 施工单

> **状态**：**三批全部落地**（2026-11-23，契约 v70 → v71；批 3 只动插件与设施，未改契约面）。
> 批 1 = 只读打通（`AppDecl.documents` + `openPluginWindow` 文档载荷 + `doc.read` + `doc-open`，令牌表 `state/plugin-document-store.ts`）；
> 批 2 = 写回过审（`doc.save` 交单 → 宿主算差分 → 确认面 → 批准才写；`doc-saved` / `doc-rejected` 回推；
> `window-bridge.ts` 同批入册契约面）；
> 批 3 = 入口 + 插件接入（`md_open` 工具 → 宿主开窗签令牌；窗内 `doc-open` / `doc.save` 已接）。**真机待验**。
> 前置：软件级插件第 1 步 `md-editor` 已交付并提交
> （`examples/plugins/md-editor/`，窗 + 桥 + 数据地盘回归基线）。
> **来由**：用户 2026-12 拍板「编辑器以**窗**的形态住进架阁」——第 1 步证明窗内只能
> 摸自己的数据地盘（`plugins/window-bridge.ts` 白名单 = dataDir 四动作 + notify，
> `openPluginWindow(name)` 不收参数，宿主 → 窗只有 `bridge-ready` / `window-closing`）。
>
> **一句话**：让窗能安全地打开并回写**宿主的文档**——**令牌化 + 能力声明 + 保存过审**，
> 而不是把 fs 放开。

## 0. 边界（先定死，违反即返工）

| 条 | 判据 | 为什么 |
|---|---|---|
| 窗永不自报路径 | 窗只能说「保存 token X」，路径解释权只在宿主 | 让窗自报路径 = 给插件任意写权限 |
| 默认关 | manifest 未声明 `app.documents` ⇒ 桥里没有 `doc.*`、开窗不发 `doc-open` | 沿用既有 kill switch 语义（不声明 = 不发生） |
| 令牌绑窗 | token 绑定 windowId + pluginName，跨窗/跨插件使用一律拒绝 | 一个窗拿不到另一个窗的文档 |
| 保存过审 | `doc.save` 不直接落盘：先出改稿单（diff），确认后才走**既有写通道** | 审阅型的地基；也复用现有的差分视图与审批门 |

## 1. 今天缺什么（实证）

| 缺 | 现状 |
|---|---|
| 开窗带文档 | `openPluginWindow(pluginName): string \| null`——无 opts，无载荷 |
| 读宿主文档 | `WindowBridgeMethod = fs.list \| fs.read \| fs.write \| fs.delete \| notify`，fs 作用域 = `<dataRoot>/<插件名>/` |
| 写回宿主 | 同上；且没有「确认」这一层 |
| 宿主 → 窗的数据推送 | 只有 `bridge-ready` / `window-closing` 两个事件 |

## 2. 契约变更

```ts
// ① manifest.app 增可选能力声明（kill switch）
interface AppDecl { documents?: boolean }

// ② 开窗带文档：宿主签发令牌
openPluginWindow(name: string, opts?: { document?: { path: string } }): string | null

// ③ 桥白名单（仅在 ① 声明且窗口已绑令牌时可达）
type WindowBridgeMethod = … | 'doc.read' | 'doc.save';
doc.read({ docToken }) → { path, text }
doc.save({ docToken, content }) → { status: "pending-review" | "written", diff?: string }

// ④ 宿主 → 窗：文档推送事件
{ protocol, op: 'event', event: 'doc-open', docToken, path, text }
```

**令牌表归属**：`state/plugin-document-store.ts`（宿主侧单例；`windowId → { docToken → path }`），
开窗时写入，关窗时整窗回收。

## 3. 批次

### 批 1 · 只读打通（最小垂直切片）——**已落地 2026-11-23（契约 v70）**

> 实落：令牌表 `src/state/plugin-document-store.ts`（一窗一文档、绑 windowId + pluginName、关窗/换文档/卸载整窗回收）；
> 桥面三道闸（能力声明 → 令牌存在 → 令牌绑窗）与 `{ path, text }` 回执；帧在 `bridge-ready` 后推 `doc-open`。
> 测试 `tests/plugin-window-document.test.ts`（5 例：正路 / 未声明零读盘 / 无令牌·撤销 / 跨窗串用 / 缺 token）。
> ~~已知限制：窗已开着时再带新文档不重推 `doc-open`~~ ——批 3 已解决（设施对已开窗直接推 `doc-open`）。

| 文件 | 动作 |
|---|---|
| `plugins/types.ts` | `AppDeclSchema` 增 `documents?: boolean`（strictObject 内加字段） |
| `plugins/window-facility.ts` | `openPluginWindow(name, opts)`；开窗登记令牌 |
| `plugins/window-bridge.ts` | 白名单扩 `doc.read`；分发前校验「声明 + 令牌 + 绑窗」 |
| `app/plugin-windows/PluginWindowFrame.tsx` | `bridge-ready` 后按登记推 `doc-open` |
| `plugins/builtin/shelf-domain/ShelfOverlay.tsx` | 软件页条目维持（开窗入口不变；带文档入参留待批 3） |

### 批 2 · 写回过审（改稿单）——**已落地 2026-11-23（契约 v71）**

> 实落：`doc.save` 三道门 + 「一窗一笔待审」；宿主侧差分 `plugins/document-diff.ts`（行级 LCS，计数全量、展示可截）→
> 待审状态 `state/plugin-document-review-store.ts` → 编排 `plugins/document-review.ts` → 确认面
> `app/plugin-windows/DocumentReviewHost.tsx`（App 根挂一次，窗关了不消失）；批准才写（`kernelWriteFile`），
> 退回/失败回 `doc-rejected`。**`doc.save` 回执立刻回 `pending-review`**（不等用户——桥调用有超时，用户可能看几分钟）。
> 测试 `tests/plugin-document-save.test.ts`（4 例：正路零写盘直到批准 / 退回零写盘 / 未声明拒绝 / 无令牌拒绝 + unchanged 不弹单）。

- `doc.save` → 宿主算 diff（复用 `paper/code-view.ts` 的差分口径）→ 弹确认面 →
  确认后走既有写通道落盘；拒绝则回 `{ status: "rejected" }`，窗内保持脏标记。
- 首次保存走审批门（既有 `dynamic-runner` approval 同族语义），不做「永久信任」灰色开关。

### 批 3 · 入口与插件侧——**已落地 2026-11-23**

> 实落：`md-editor` 0.2.0 声明 `app.documents` + 工具 `md_open(path)`（Agent 命令窗口打开宿主文档，
> 与 notes-app 的 `notes_open` 同款分工：工具语义归插件、窗口设施归宿主）；窗内接 `doc-open` / `doc.save`，
> 保存结果按 `pending-review` / `doc-saved` / `doc-rejected` 三态走；窗已开着时设施直接推新令牌。
> 入口形态 = **Agent 驱动**（`md_open`），不是纸面按钮——纸面「用文卷打开」需要块级动作，**留待后续单独立项**。
>
> **入口重定位（2026-11-23，用户定调）**：Agent 命令本来就不该是入口——用户要的是**会话里引用到的
> 文件点一下就开**（通用 Agent 软件用侧栏做这件事，兰台装不下侧栏，所以由一个软件型插件出窗来承担）。
> 已落第一批：宿主设施 `openFileWithPlugin(path)`（`window-facility`，经宿主桥 `windows.openWith` 暴露，
> 找注册面里第一个声明 `app.documents` 的插件；没有就状态栏具名提示）+ 来文「附 · 文件名」卡改为可点。
> `md_open` 降级为调试/脚本手段，不再是产品入口。**待接的其余引用面**：工具卡参数里的路径、
> 正文里的行内路径、引用卡片。
>
> **相对路径批（2026-11-23，同一批收口）**：上述三面原先只认**绝对路径**（相对路径没有共识起点），
> 而模型最自然的写法是仓库相对路径，Markdown 链接 `[x]（docs/a.md）` 更只是裸 `<a target=_blank>`。
> 本批落：判据真源 `paper/file-ref.ts`（基准 = 工作区根 `useShellStore.projectPath`，绝对/相对/`file://` 归一，
> `#L24` 与 `:24` 后缀剥掉，URL/锚点/含空白一律不认）→ 正文 Markdown 链接与行内码都点开进文卷；
> 工具卡「打开」签同步认带扩展名的相对 token；宿主窗口设施 `openPluginWindow` 兜底把相对文档路径解析成绝对
> （Rust 只收绝对路径）。测试：`tests/file-ref.test.ts`（12）/ `tests/paper-file-link.test.tsx`（5）/
> `tests/open-file-with-plugin.test.ts`（相对路径令牌一例）。

- 纸面/引用处加「用文卷打开」入口（从卷里/工作区取当前文档）；
- `examples/plugins/md-editor/` 接入 `doc-open` 与 `doc.save`，README 撤掉「刻意不做」里的对应行。

## 3.5 补强（2026-11-23，真机使用前收口的三个洞）

- **关窗撤单**：窗关掉 / 卸载时，该窗待审改稿单一律作废（`cancelDocumentReviewsForWindow`）——
  不留「没有窗的单子还能点写入」这种骗人的状态。
- **大文件闸**：行级 LCS 表设 4M 单元上限，超限退化成整篇替换计数并**如实标注**——
  宁可少给信息，也不把宿主标签页拖死。
- **确认面单测**：`tests/document-review-host.test.tsx`——渲染（路径/计数/差分）、
  点写入→决议 true、点退回→决议 false、关窗撤单→决议 false 且弹窗消失。

## 4. 门禁与守护

- 契约变更按 `composition/contract-version.ts` 四步升版（当前版本见 `docs/facts.generated.md`），
  并跑 `npm run verify:convergence`（双轨）。
- 新增 `tests/window-bridge-doc.test.ts`：未声明 / 无令牌 / 跨窗串用 / 过期令牌 →**四类拒绝**各一条；
  `doc.save` 未确认前**不得**产生写盘副作用（以 mock fs 断言调用零次）。
- 现有 `window-bridge` 白名单测试同步加两项（方法面扩了就必须有正面用例）。

## 5. 明确不做

- **不**放开任意 fs 读（文档通道≠文件管理器）；
- **不**支持多文档同时打开（一次一文档；多标签是另一个产品决定）；
- **不**给 `url`（环回远端页）窗开 `doc.*`——远端页不是插件代码，信任模型不同；
- **不**做协作光标 / 实时同步（窗与 Agent 同时改同一文档的冲突留给改稿单判定）。
