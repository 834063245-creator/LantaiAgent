# notes-app — 软件级插件范本

对位基本插件范本 [`examples/plugins/hello/`](../hello/)（贡献零件：面板/命令/
工具），本示例是「**软件级插件**」的范本：完整软件以插件形态住进兰台——
装载即给数据地盘、开窗即视图、工具驱动即干活、卸载即整体回收（app shell
四件套闭环，`docs/plans/app-shell-software-plugin-plan.md`）。

```
notes-app/
├── manifest.json     ← 声明：窗口入口（app）+ 数据地盘（dataDir）+ 受治进程
│                       （mcpServers · lazy）+ 工具口工具（tools · notes_open）
├── entry.js          ← 工具口执行体（住宿主 webview——窗口设施只有它摸得到）
├── server.cjs        ← 后端（零依赖 Node）：对宿主说 MCP（stdio 数据四工具），
│                       对自己的窗说 HTTP API——两副面孔，宿主不掺和
└── app/index.html    ← 窗内容（自包含 HTML：桥 SDK + 便签 UI）
```

## 宿主给了什么（四件套基础设施）

| 件 | 宿主基础设施 | 本范本怎么用 |
|---|---|---|
| A 窗口原语 | manifest.app 登记 → 窗口注册表 + iframe 视口（真隔离）+ postMessage 白名单桥（默认最小集 `fs` + `notify`）+ 窗口设施（宿主桥 `windows` 键） | 声明 `app.entry: "./app/index.html"`；窗页经桥 fs 读 `port.json`、经桥 notify 发状态通知；`notes_open` 工具调 `host.windows.open('notes-app')` 开窗 |
| B 数据目录 | 装载即分配 `<数据根>/notes-app/`；spawn env `LANTAI_PLUGIN_DATA_DIR` 注入受治进程；桥 fs 面锁死插件根；卸载随 `plugin_uninstall` 挪 `.trash` | server 进程用 env 定位自己的地盘（`notes.json` / `port.json` / 导出文件全在里面）；窗经桥 fs 读 `port.json` |
| C 受治进程 | 治理字段声明 = 受治面：就绪 = initialize 握手（60s 时限）、崩溃退避重启、三档生命周期、空闲回收、关窗/卸载回收出口 | `lifecycle: "lazy"`——首次装配/调用/**开窗**拉起，无窗且空闲 5 分钟回收，再拉再起 |
| D 后台唤醒 | async 语义两张门统一：工具口 `async: true`（宿主注入 `args._task_id`，完成经 `host.deferred.complete`）；MCP 路完成通知 `lantai/deferred`（progressToken 回带）由桥翻译成同一唤醒 | `notes_export` 不带 taskId = 提交即回卡片，1.2s 后 server 发完成通知 → 宿主唤醒发起 Agent（minimal 定位键 `{status, taskId, sessionId}`）；凭 taskId 再调 `notes_export` 取内容 |

## 插件自己的责任（宿主不负责）

- **窗内渲染完全归软件**：`app/index.html` 是你自己的 HTML（iframe 真隔离
  ——sandbox 无 allow-same-origin，拿不到 `window.__lantai_plugin_host__`）。
  需要宿主能力只能走 postMessage 白名单桥（默认最小集 fs + notify，其余按需
  申请——方法级白名单，克制开面）。
- **窗 ↔ 后端的 HTTP API 是 app 内部的事**：manifest 不管、宿主不掺和。本
  范本的做法：后端启动后把动态端口写 `port.json` 进数据地盘，窗经桥 fs 读到
  再直连（`Access-Control-Allow-Origin: *`——窗是 opaque origin）。
- **数据权威单点自己设计**：本范本 = server 进程单写者（窗与工具都经它，
  不并发打架）。宿主只保证「你只能碰自己的数据根」。
- **协议面是你的义务**：不贡献工具也能装载开窗给人用（纯 GUI 软件），但
  Agent 驱动不了、不承诺视觉兜底进编排。

## 两张门各放什么（决策 8——没有第三张门）

| 门 | 什么实现走这里 | 本范本 |
|---|---|---|
| **工具口**（`manifest.tools` + entry 的 `toolHandlers`） | 实现必须住在宿主 webview（窗口设施这类宿主能力） | `notes_open`——Node 进程碰不到宿主窗口设施 |
| **MCP 路**（`manifest.mcpServers` + tools/list） | 实现住在进程里 | `notes_list / notes_create / notes_delete / notes_export`——随 tools/list 动态进注册表（行 id `plugin/notes-app/mcp/notes`） |

不做的：没有「工具执行体 fetch 自己进程」的代理层，没有服务地址注入——
需要进程的软件，后端就是 MCP server（决策 8）。

## 复制本范本做新软件要改哪几处

1. `manifest.json`：`name` / `app.entry`（你的窗页路径）/ `mcpServers[0]`
   （command + args）/ `tools`（你的工具口清单）；
2. `entry.js`：`toolHandlers` 换成你的窗口设施类工具（开/关/聚焦自己的窗）；
3. `server.cjs`：`TOOLS` 表换成你的数据工具；HTTP 面换成你的窗 API；
4. `app/index.html`：整页换成你的软件 UI（桥 SDK 段可原样拷走）；
5. `README.md`：改成你的软件说明。

## 三档启动策略差异（lifecycle 字段）

- `lazy`（本范本缺省档）：首次装配/调用/开窗拉起；无窗且空闲超时（缺省
  5 分钟）回收；再调用再拉起（首调报 `service_not_ready` 并已触发拉起，
  稍后重试即可——宿主永不阻塞等待，等待由调用方按需重试承担）。
- `eager`：装载即拉起，卸载才停——常驻引擎型软件（崩溃后下次装配/调用
  兜底拉起；配 `restart: "on-crash"` 则退避自动重启）。
- `with-window`：随窗开合——开窗拉起、关窗即杀（多窗计数全关才杀）；
  窗口即外壳的软件用这档。

## 真机验收路径

装载（安装到插件目录后启用）→ 开窗（Agent 调 `notes_open` 或未来启动器）→
窗内写便签 → Agent 调 `notes_create` 窗内可见 → `notes_export` 异步完成唤醒 →
关窗（lazy 档空闲回收，进程杀）→ 卸载（数据目录整体挪 `.trash` 回收）。
