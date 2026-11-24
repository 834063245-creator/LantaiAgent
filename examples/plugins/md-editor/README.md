# 文卷（md-editor）— 软件型插件 · 0.5.0

兰台的案头编辑器：一扇窗里读、改、存。对位范本仍是
[`../notes-app/`](../notes-app/)，本插件取「窗 + 数据地盘 + 宿主文档通道 + 工作区授权」四件，
把编辑器本身做成产品。

> **0.5.0 的边界**：卷库/工作区 = 文本与代码文件；Markdown 走阅读/编辑/分栏，
> 代码/文本按扩展名进源码编辑（不渲染 Markdown 预览）；工作区仍为只读根。
> **宿主要求**：`app.workspace` 是开放面契约 v77、`ws.search`/`doc.follow`/`doc.asset`
> 是 v78；旧宿主（v77 及以前）读这个 manifest 会整份拒载——先升级/重建兰台。
> **代码支持不需要新宿主契约**：`ws.read`/`doc.save` 本来就按文本处理，本版只改了
> 窗内的文件分类、视图与 CodeMirror 语言。
>
> **随包形态（P1a）**：正式分发走第一方软件型产物 `hologram/md-editor`（构建脚本把
> `app/` 原样复制进 `dist-plugins/builtin/hologram/md-editor`，manifest 由
> `builtin-roster.json` 生成）——**默认就有，不用手动装**。`examples/plugins/md-editor`
> 仍是可独立安装的源码/开发形态（用户插件名 `md-editor`）。

## 装上看一眼

随包版：重建/重启兰台 → 顶部「架阁」→ **软件型**页 → 「文卷」（无需拷贝）。
从会话里点开一份宿主文档时，宿主会同时签发**工作区根只读令牌**，左侧「工作区」页
直接出现当前工作区的树。

开发形态（仅调试插件本身时用）：

```
cp -r examples/plugins/md-editor ~/.lantai/plugins/md-editor
```

> ⚠ 随包版（`hologram/md-editor` / `wenjuan_open`）与开发形态（`md-editor` / `md_open`）
> 会各注册一扇文卷窗；调试前先把旧的 `~/.lantai/plugins/md-editor` 移走（数据目录
> `~/.lantai/plugins-data/md-editor/` 可保留）。

## 0.5.0 能做什么

**读**
- 从会话里引用到的文件点一下，按扩展名分派：Markdown 进阅读模式，代码/文本进源码编辑。
- **代码文件**：JS/TS/JSX/TSX、JSON、Python、Rust、HTML/CSS、Shell、YAML、TOML、SQL、
  C/C++、Java、Go、C#/Kotlin/Dart、Dockerfile 等；CodeMirror 语法高亮，Markdown 预览/
  大纲/分栏自动收起。没有官方 parser 的扩展名按纯文本可编辑，不丢内容。
- **工作区树**：左侧「工作区」页懒加载当前工作区目录（点目录展开、点文件开标签）；
  二进制/未知扩展名看得见，但点开会具名拒绝，不冒充文本。
- **快速打开 / 内容搜索**：`Ctrl/Cmd+P` 文件名（含工作区），`Ctrl/Cmd+Shift+F` 全文；
  命中直接跳到编辑模式对应行。
- **多文档标签**：工作区文件 + 宿主文档可同时开多份；每份独立令牌，互不顶掉。
- **本卷引用**：左侧工作区页顶部列出当前会话里出现过的文件（用户附件 / 正文链接与
  行内码 / 工具参数），点一下直接开。
- **相对链接/图片**：Markdown 里的 `[x](../a.ts)` 按当前文档目录跳转；`![](img/p.png)`
  经宿主 `doc.asset` 读成 data URL（8 MiB 闸）。
- Markdown 预览：GFM 表格、任务列表、脚注、删除线、代码高亮（highlight.js）、frontmatter 卡片。
- 左侧大纲（只对 Markdown；ATX + Setext 标题，跳过代码块），点击跳行。
- 夜读 / 纸白双主题；卷库宽度、大纲宽度、打开的文档、滚动位置跨重启恢复。

**改**
- CodeMirror 6：Markdown/JS/TS/JSON/Python/Rust/HTML/CSS 等语法、行号、自动换行、
  撤销历史、查找替换（`Ctrl/Cmd+F`）、多光标。
- Markdown：阅读 / 编辑 / 分栏三态；`Ctrl/Cmd+E` 切换。代码/文本：直接源码编辑，
  不提供 Markdown 分栏。
- 快捷键：`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+W` 关标签、`Ctrl/Cmd+P` 快速打开、
  `Ctrl/Cmd+Shift+F` 内容搜索、`Ctrl/Cmd+K` 命令面板、`Ctrl/Cmd+B` 卷库、`Ctrl/Cmd+1..9` 切标签。
- 关闭不丢正文。

**存**
- 自家卷库：`fs.write` 直接落盘。
- 宿主文档 / 工作区文件：`doc.save` 交改稿单 → 宿主算差分 → 用户确认才写；窗内保留正文，
  等 `doc-saved` / `doc-rejected` 回推。带 `baseRev` 时磁盘被外部改过会回 `conflict`，
  不静默覆盖。
- **草稿自动保存**：每次改动 650ms 后写 `drafts/`；关窗/崩溃/切标签都不丢，
  重开自动恢复。
- 外部变更：窗口重新获得焦点时比对磁盘版本；干净就自动同步，脏就出横幅
  「用磁盘版 / 保留我的」。

**卷库**
- 数据地盘里的 Markdown / 文本 / 代码文件列表、筛选、新建、右键删除。
- 最近打开（本地 + 工作区 + 宿主；宿主条目需从会话重新点开）。

## 这一版刻意不做 / 下一批

| 不做 | 为什么 | 留给哪批 |
|---|---|---|
| LSP 补全 / 诊断 / 跳转定义 / 格式化 | 需要 TypeScript server / pyright / rust-analyzer 等 sidecar 与协议、生命周期；不是“打开代码文件”的必需项 | 单独立项（IDE 面） |
| PDF / Office / Excel 预览 | DSH 同款能力是几 MB 级分块；兰台先「用系统程序打开」，不追这个性价比 | P3 |
| 批注 / Agent 改稿 hunk / 选段问 Agent | 需要宿主 `doc-proposed` 与创作坞插入通道 | P2 |

## 编辑器内核是适配点（0.3 已换 CodeMirror 6）

`app/js/editor.js` 是窗内唯一知道内核的地方；`app/vendor/lantai-editor.js` 是
`build/vendor.mjs` 打出的单文件 ESM（CodeMirror 6 + markdown-it + DOMPurify +
highlight.js），随插件提交，装插件仍然只需拷贝目录，不需要 npm。

重新生成 vendor：

```
cd examples/plugins/md-editor/build
npm install
npm run build          # 压缩
npm run build -- --dev # 不压缩（排查用）
```

许可证清单在同目录 `app/vendor/LICENSES.md`。

## 入口形状（硬契约，踩过一次）

`entry.js` 必须 `export default { name, apply }`，且 `name` 与 `manifest.name` 逐字一致。
装载器 `pickPluginObject` 优先取 `default` 导出，`isPluginShape` 只认
`{ name: string, apply: function }`；只裸导一个 `apply` 会报
「插件对象 name (undefined) 与 manifest.name 不一致」——装载失败。

## 目录

```
md-editor/
├── manifest.json
├── entry.js                 # md_open 工具 + 空 apply
├── app/
│   ├── index.html           # 窗结构
│   ├── css/app.css          # 纸面主题 + 布局 + 夜读
│   ├── js/
│   │   ├── main.js          # 文档模型 / 卷库 / 草稿 / 桥事件 / 渲染
│   │   ├── bridge.js        # postMessage 白名单桥客户端
│   │   ├── editor.js        # CodeMirror 适配（唯一内核点）
│   │   └── pure.js          # 无 DOM 纯函数（单测覆盖）
│   └── vendor/
│       ├── lantai-editor.js # 预构建 ESM（不要手改）
│       └── LICENSES.md
└── build/
    ├── package.json
    ├── vendor-entry.js
    └── vendor.mjs
```

## 验收口径

1. 装：目录出现在 `~/.lantai/plugins/`，架阁「软件型」页能看到「文卷」；
2. 开：点开是一扇窗；关掉进程与内存回收（再开无残留状态）；
3. 读：从会话引用点开宿主文档 → 阅读模式 → 大纲/预览正常；
4. 树：左侧「工作区」页出现当前工作区目录；点目录展开、点文件开标签；
5. 多文档：工作区文件与宿主文档可同时开多份，各自保存互不顶掉；
6. 改：点「编辑」→ 改动 → 状态栏「草稿已存」→ 关窗重开，草稿恢复；
7. 存：自家文档 `Ctrl/Cmd+S` 直接落盘；宿主/工作区文档弹改稿单，确认后才写；
8. 变：在外部改同一文件 → 窗重新聚焦时同步（干净）或出横幅（脏）；
9. 越界：工作区根外的文件不可见；相对路径 `..` 被宿主拒绝；
10. 拆：删掉插件目录 / 卸载后，窗、进程、数据目录都不留残渣。
