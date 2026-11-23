# 文卷编辑器（案头）— 施工单

> **状态**：**P0 已落地（2026-11-23）**——`md-editor` 0.3.0：阅读/编辑双模、CodeMirror 6、
> GFM 预览、大纲、草稿自动保存/恢复、外部变更检测、夜读、单文档多标签（自家卷库）。
> **P1a/P1b/P1c 主体已落地（2026-11-23，契约 v78，文卷 0.4.0）**：
> 第一方软件型产物 `hologram/md-editor` 随包（`builtin-roster.json` 的 `software` 段生成
> manifest，构建脚本复制 `app/`）；`app.workspace` + `ws.list`/`ws.read`/`ws.search` +
> `doc.follow`/`doc.asset` + 根只读令牌 + 多文档标签 + 树/快速打开/内容搜索/相对链接/图片 +
> 本卷引用（会话消息里的可见引用推窗）。
> **余 P1c 尾项**：`ws.stat`/树变更事件（非阻塞）；写仍每次过审（租约 = P2）。
> **部署**：P1 需宿主 v78（重建 exe；先关掉运行中的兰台，否则 `target/release/lantai.exe`
> 被占用会报 os error 32）；随包版默认在架阁，旧的手装 `md-editor` 需移走以免
> 同时出现两扇文卷窗（随包工具名 `wenjuan_open`，旧手装 `md_open`）。
> **定位（2026-11-23 用户拍板 A）**：**第一方旗舰编辑器**——随包、默认装、开箱即用，
> 但仍以软件型插件形态存在（可替换、可禁用；不把编辑器焊进宿主）。
> **前置**：插件文档通道三批已落地（[`plugin-document-channel-plan.md`](plugin-document-channel-plan.md)，
> 契约 v70→v71）；文卷 0.2.0 已接 `doc.read` / `doc.save`。

## 0. 一句话

文卷现在缺的不是编辑器内核，是**文件面**：先给窗一个「工作区授权」（根 + 相对路径围栏），
再让编辑器知道会话/案卷——DSH 侧栏的「树 + 搜索 + 预览」是地板，**会话原生**才是超过它的地方。

## 1. 对标与差距（2026-11-23 实证）

DSH 侧栏 = `sidebar-files`（工作区树 + 文件名搜索 + 隐藏项 + 忽略规则 + 分栏状态）
+ `sidebar-documentpreview`（按扩展名分发 md/代码/图片/PDF/Office/Excel，文本分页，
自动刷新，frontmatter）。**它是只读预览器**，不是编辑器。

文卷 0.3.0 补上了「单文档编辑体验」，但仍差三层：

| 层 | 今天 | 后果 |
|---|---|---|
| 到不了 | 窗内只能列插件数据地盘；工作区文件靠宿主推一枚 `docToken`；`plugin-document-store` 一窗一文档 | 没有树/快速打开/工作区搜索/链接跳转/相对图片；这是 80% 的「难用」 |
| 编不顺 | 每次宿主文档保存都弹改稿单；没有租约/快照/冲突合并 | 用户打字像在填审批表；Agent 改了同一文件只能等下次保存才发现 |
| 不像文卷 | 与当前案卷/会话无关 | DSH 只是「文件 + 聊天」两块；兰台可以让文卷知道「本卷引用过什么、Agent 刚改了什么」 |

## 2. P1 目标（工作区授权）

### 2.1 契约面（v77 已落地）

```ts
// manifest.app 新增（kill switch：不声明 = 桥里没有 ws.*）
workspace?: boolean

// 开窗时签发根授权（**已拍板 2026-11-23：工作区根只读默认**——用户已选过工作区，
// 编辑器读同一根是预期；窗脚常驻范围标签 + 可撤销，写仍另档）
openPluginWindow(name, { workspace?: { root?: string } }) // root 缺省 = 工作区根

// 桥方法（全部以 rootToken 为根，窗只报工作区相对路径）
ws.list({ rootToken, relPath })                    → { entries: [{ name, is_dir, size, relPath }] }
ws.read({ rootToken, relPath })                    → { text, rev, docToken, relPath }
ws.search({ rootToken, query, mode: 'name' | 'content', limit? }) → { hits: [{ relPath, line?, preview? }], truncated }
doc.follow({ docToken, href })                     → { docToken, relPath }   // 相对链接按当前文档目录解析
doc.asset({ docToken, href })                      → { dataUrl, mime }       // 相对图片，8MiB 闸
// 以下为 P1c 尾项（尚未实现）：
ws.stat({ rootToken, relPath })                    → { size, mtime, rev }
// 保存仍走既有 doc.save（ws.read 顺带签发 docToken，可选 baseRev）；不另开 ws.write。
```

事件：`doc-changed`（`docToken` + `rev`，宿主 Agent/外部写触发）、`tree-changed`（`rootToken` + `relPath`）。

**四条不变量（与现有令牌模型同族，不得破）**：

1. 窗**不报绝对路径**；只报 `rootToken` + 工作区相对路径。解析、`..` 围栏、忽略规则、扩展名白名单全在宿主。
2. 根授权由**用户动作**产生，可撤销；关窗/卸载即整窗回收；绑定 `windowId + pluginName`。
3. 读默认开，写分档；Agent 写入永远过审；用户写入走租约/快照（见 §2.3）。
4. 根围栏必须与 Agent 工具同一个边界（`resolve_read_dispatch` 语义）；不做「窗专用后门」。

**为什么不做逐节点令牌树**：更严，但实现量高一个数量级；根围栏 + 相对路径已能挡住越界，
且与 DSH 的 `sessionId + relative path` 同构。需要逐文件撤销时再加，不阻塞体验。

### 2.2 宿主侧改动（尽量复用）

| 件 | 动作 |
|---|---|
| `plugins/types.ts` | `AppDecl.workspace?: boolean` + schema 测试 |
| `state/plugin-document-store.ts` | 一窗一文档 → `{ rootGrant?, docGrants: Map }`；根授权 + 文档令牌双层；关窗整窗回收 |
| `plugins/window-bridge.ts` | 白名单扩 `ws.*` / `doc.follow` / `doc.asset`；三道闸（声明 / 令牌 / 绑窗）+ `rev` 冲突 |
| `plugins/window-facility.ts` | 开窗带 workspace；`openFileWithPlugin` 可传 `workspace` 根；首次授权 UI |
| `state/plugin-document-review.ts` | 槽位加 `baseRev` / 租约（用户直写路径）；hunk 化留给 P2 |
| Rust `fs_cap stat` | 补 `mtime`（现在只有 size/is_dir）；`rev = size:mtime`，不读全文 |
| 复用 | `kernelListDirectory`（ignore 过滤）、`kernelReadFile`、`kernelReadFileBase64`、[`search_cap`](../../src-tauri/src/commands/search_cap.rs)、`fs_cap stat` |

### 2.3 保存模型（P1 必须定，默认保守）

> **落地口径（2026-11-23）**：P1b 先落「每次保存仍过审 + `baseRev` 冲突检测」；
> 用户直写租约/快照是 P1c 余项（不把写安全降级混进第一批）。

| 来源 | 行为 |
|---|---|
| **用户编辑**（窗内打字） | 首次保存出一次改稿单，确认面附「信任本窗编辑此文件直到关窗」；勾选后本窗对该文件直写，写前快照到 `.lantai/doc-history/`；关窗租约失效 |
| **Agent 编辑** | 始终过审；文件正开着时改稿单以 hunk 形式进编辑器（P2），P1 先走既有确认面 |
| **冲突** | `baseRev` 不匹配不自动合并：返回 `conflict`，窗内三选（重载 / 保留我的 / 看差异） |

不勾「信任」= 每次保存都过审（严格模式），但确认面改为**窗内浮条**，不弹宿主模态。
kill switch：`app.workspace` 不声明 ⇒ 无 `ws.*`，行为退回 0.3.0。

### 2.4 文卷侧 UI（P1）

- 左栏三源：**工作区树 / 本卷引用 / 最近**；树懒加载（`ws.list` 一层一层），宽度/展开/滚动按窗保存。
- 快速打开：`Ctrl/Cmd+P` 对工作区路径做子序列模糊（复用宿主 `app/search/file-match.ts` 的口径，窗内重写纯函数）。
- 内容搜索：`Ctrl/Cmd+Shift+F` 走 `ws.search` `mode:'content'`（DSH 只搜文件名——这里是超越点）；结果按文件分组、行号跳转、可取消/有上限。
- 多文档：根授权下可同时开 N 份令牌；tab 不再受「一窗一文档」限制。
- 相对链接/图片：`doc.follow` / `doc.asset`；非文本文件先「用系统程序打开」，不重造 PDF/Office。
- 会话面：宿主在开窗/切卷时推 `session-files`（本卷引用过的文件，去重 + 上限），左栏「本卷」直接列。

## 3. 批次

| 批 | 内容 | 验收 |
|---|---|---|
| **P0（已落地）** | CM6 + 阅读/编辑/分栏 + GFM 预览 + 大纲 + 查找替换 + 草稿自动保存/恢复 + 外部变更检测 + 夜读 + 最近/多标签（自家卷库） | 500KB md 不卡；中文输入法不丢字；关窗不丢草稿；宿主改稿单回推三态正确 |
| **P1a 打包**（A 定位的随包） | 第一方软件型产物：`builtin-roster.json` 的 `software` 段（app/appSource/dataDir/tools）+ 构建脚本复制 `app/` → `dist-plugins/builtin/hologram/md-editor/`；装载器按名册装载 | **已落地 2026-11-23**：42 个出厂产物；随包默认在架阁、可禁用；手装 `md-editor` 调试形态仍可独立用 |
| **P1b 契约** | `app.workspace` + `ws.*` + 多令牌/根授权 + `rev` 冲突 + 事件；四类拒绝测试；契约升版 + convergence 双轨 | **已落地 2026-11-23 · v77**：根只读令牌、`ws.list`/`ws.read`、`ws.read` 顺带 docToken、多文档保存、`baseRev` conflict；`tests/plugin-workspace.test.ts` / `plugin-workspace-path.test.ts` |
| **P1c 文件面** | 树 + 快速打开 + 内容搜索 + 多文档 + 链接/图片 + 本卷引用 | **主体已落地 2026-11-23 · v78**：树/多文档/`ws.search`/`doc.follow`/`doc.asset`/本卷引用；余 `ws.stat` + 树变更事件（非阻塞） |
| **P2 会话原生** | Agent hunk 审阅（gutter 接受/拒绝）、选段→问 Agent/夹签/批注、版本历史、文档与卡片的互引 | Agent 改稿在编辑器内逐条裁决；选段一键进创作坞；批注随文件走 |
| **P3 打磨** | PDF/图片预览、打印/导出、停靠/多窗、拖放导入、字号/版心偏好 | — |

## 4. 测试与门禁

- 纯函数：`src-ui/tests/wenjuan-pure.test.ts`（路径围栏 / 草稿键 / frontmatter / 大纲 / 链接解析 / 模糊匹配）。
- 桥面：`tests/plugin-window-document.test.ts` 扩四类拒绝；`tests/plugin-document-save.test.ts` 加 `baseRev` 冲突与租约；
  `ws.list`/`ws.search` 的根围栏各一组（`..`、绝对路径、junction/symlink 逃逸）。
- 契约：`npm run verify:convergence`（双轨）＋ `npm run doc-check`＋`npm run build`＋`npx biome ci .`。
- 真机：500KB md、1 万文件工作区、中文输入法、Agent 与用户同时改同一文件、关窗重开草稿恢复。

## 5. 明确不做

- 不做 IDE：LSP、git 面板、终端、调试、任务运行器都不进文卷。
- 不为 parity 重造 Office/Excel 预览（DSH 的 Excel/PDF 分块是 MB 级）；非文本文件交给系统程序。
- 不放开任意 fs；不让窗自报绝对路径；不引入新的状态库（窗内继续单一 store + 纯函数）。
- 不把编辑器焊进宿主：A 是「随包的第一方插件」，不是「宿主内置面板」——可禁用、可替换这条不破。

## 6. 已拍板（2026-11-23，用户）

**首次打开宿主文件的默认授权范围 = 工作区根只读**（不是「仅此文件 → 显式升级」）。
落地口径：开窗即签发工作区根授权（`rootToken`），窗脚常驻显示根路径 + 撤销入口；
**写能力仍另档**（用户编辑首次保存过一次审 / 租约，Agent 写永远过审）。
