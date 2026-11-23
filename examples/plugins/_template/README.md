# 插件模板（5 分钟路径）

最小可装载的**软件级插件**：一扇窗 + 一个工具。四份文件，零依赖，无构建。

| 文件 | 作用 |
|---|---|
| `manifest.json` | 插件声明（名字、入口、窗口、工具）——装载器唯一读的元数据 |
| `entry.js` | 插件代码：默认导出 `{ name, apply }` + 工具执行体（`toolHandlers`） |
| `app/index.html` | 窗内容（iframe 真隔离；样式归插件） |
| `README.md` | 本文件 |

## 五步

1. **拷贝改名**：把本目录拷成 `<你的目录名>`（id 只收小写字母/数字/连字符，可带一段 `/`，如 `acme/notes`）。
2. **三处同名**：`manifest.json` 的 `name`、`entry.js` 里 `{ name }`、目录名——三者必须逐字一致（装载器按目录名寻址）。顺手改 `description` / `app.title` / 工具名与描述。
3. **验形状**：`cd src-ui && npm run plugin:validate -- <插件目录>`（`--json` 可选）。退出码 0 = 形状过关。
4. **放置**：设置 →「插件」→ 安装输入框填目录路径 →「安装」（本地目录形态会被拷进插件根）。或手动放到 `~/.lantai/plugins/<name>/`。
5. **打开**：设置页「已安装」里出现即装载成功；让 Agent 调 `my_plugin_open`（工具面在下一次 Agent 装配生效），或直接开窗看效果。

## 改什么

- **窗内容**：`app/index.html`（整页归你；要宿主能力走 postMessage 白名单桥）。
- **工具**：`manifest.json` 的 `tools` 声明 + `entry.js` 的 `toolHandlers`——声明与实现**一一对应**（缺/多都拒载）。
- **后端进程**：要起进程的软件在 `manifest.json` 声明 `mcpServers`（条目加 `"governed": true` 即受治：就绪握手带时限、空闲回收、崩溃可按 `restart` 自愈）；长任务走 MCP 完成通知 `lantai/deferred`。

## 别做的

- 裸 `import`（`react` / `zod` 之类）——插件模块必须自包含。
- 在 `apply` 里做 UI 副作用（装载期只做注册动作）。
- 自己起进程 / 自己管窗口仲裁 / 自己装自己——那是宿主的不变量。

更多：`docs/plugins/contract-card.md`（一页契约）、`docs/plugins/README.md`（全文）、`examples/plugins/notes-app/`（带 MCP 后端的完整范本）。
