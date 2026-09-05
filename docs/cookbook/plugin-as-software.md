# Plugin as Software（写一个软件级插件）

> 平台契约指南（app shell · S6）。真源：`src-ui/src/plugins/window-facility.ts`
> （窗口设施）+ `window-bridge.ts`（postMessage 桥）+ `deferred.ts`（后台唤醒）+
> `mcp-bridge.ts`（受治进程治理）；全程示例：`examples/plugins/notes-app/`
> （四件套闭环的活范本）；契约总章：[`docs/plugins/README.md` §10](../plugins/README.md#10-软件级插件app-shell-四件套)。

软件级插件 = **完整软件住进兰台**：装载即给数据地盘、开窗即视图、工具驱动
即干活、卸载即整体回收。与「贡献零件」（面板/命令/工具——见
[`adding-an-mcp-server.md`](adding-an-mcp-server.md) 等）的区别：软件有自己的
窗（iframe 视口）、自己的后端进程（受治 MCP server）、自己的数据地盘。

本指南以 notes-app 为全程示例，五步走完一个软件级插件。

## 第 0 步：manifest 骨架

```json
{
  "name": "notes-app",
  "version": "1.0.0",
  "entry": "entry.js",
  "app": { "entry": "./app/index.html", "mode": "floating", "title": "便签" },
  "dataDir": true,
  "mcpServers": [
    { "name": "notes", "transport": "stdio", "command": "node", "args": ["./server.cjs"], "lifecycle": "lazy" }
  ],
  "tools": [
    { "name": "notes_open", "description": "打开便签软件窗口", "parameters": { "type": "object", "properties": {} }, "readOnly": true }
  ]
}
```

四件套各取所需：纯 GUI 软件可以只声明 `app`（后端 = 零工具 MCP server
是可选项——没工具也能装、能开窗给人用，只是 Agent 驱动不了）。

## 第 1 步：窗内容（`app/index.html`，件 A）

窗内是**你自己的 HTML**（iframe 真隔离：sandbox 无 allow-same-origin，
拿不到 `window.__lantai_plugin_host__`）。需要宿主能力走 postMessage
白名单桥（默认最小集 `fs` 四动作 + `notify`）：

```js
const PROTO = 'lantai-plugin-bridge';
// call：reqId 关联的 RPC（fs.read / fs.write / fs.list / fs.delete / notify）
function call(method, params) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    pending.set(reqId, { resolve, reject });
    window.parent.postMessage({ protocol: PROTO, op: 'call', reqId, method, params }, '*');
  });
}
// 宿主→窗广播只有 bridge-ready（桥就绪——此时起 call 不会丢）/ window-closing
// （关窗告警——尽力而为，需要可靠持久化请「改动即存」）
```

**插件身份由容器侧绑定**——你的消息里不携带插件名，fs 调用恒落在你自己的
数据根（窗内脚本无法冒充别的插件）。

## 第 2 步：数据地盘（件 B）

声明 `dataDir: true` 后宿主给两样：

- **后端进程**：spawn env `LANTAI_PLUGIN_DATA_DIR`——绝对路径，握手前即可读；
- **窗**：桥 fs 面（`fs.list/read/write/delete`，锁死在你的根内）。

notes-app 的用法：server 启动后把 HTTP 端口写 `port.json` 进地盘，窗经
桥 `fs.read` 读到再直连后端——窗和后端怎么相认是 app 内部的事，宿主不掺和。

## 第 3 步：后端 = 受治 MCP server（件 C）

后端进程只有一种形态：**MCP server**（对宿主说 MCP，对自己的窗说自己
的 HTTP API）。在 `mcpServers` 条目声明治理字段进受治面：

| 字段 | 取值 | 语义 |
|---|---|---|
| `lifecycle` | `lazy`（缺省） | 首次装配/调用/**开窗**拉起；无窗且空闲超 5 分钟回收；再拉再起 |
| | `eager` | 装载即拉起，卸载才停（常驻引擎型） |
| | `with-window` | 随窗开合——开窗拉起、关窗即杀 |
| `restart` | `off`（缺省）/ `on-crash` | 崩溃后指数退避自动重启（1s×2 封顶 30s，就绪清零） |

受治语义（宿主承担）：就绪 = initialize 握手 + tools/list 限窗完成（缺省
60s，到点判启动失败 + 清场）；未就绪调用立即报 `service_not_ready`（带
starting/not-running 状态）并已触发拉起——**等待由调用方按需重试承担**；
kill 是进程树终止；任何受治进程必有回收出口（泄露即 bug）。

数据工具声明在 server 里（`tools/list` 随进注册表，名 `mcp__<server名>__*`）；
**动态名面族天然走「一行贡献承载整族」**——不写静态清单。

## 第 4 步：两张门各放什么工具（决策 8）

- 实现住在**进程里** → MCP 路（server 的 tools/list）：notes 的
  `notes_list/create/delete/export`；
- 实现必须在**宿主 webview** → 工具口（`manifest.tools` + entry 的
  `toolHandlers`）：`notes_open`（窗口设施只有宿主摸得到）：

```js
export const toolHandlers = {
  notes_open: async () => {
    const windowId = globalThis.__lantai_plugin_host__?.windows?.open('notes-app');
    return windowId ? `便签窗口已打开（${windowId}）` : '[notes_open] 窗口定义不在册';
  },
};
```

窗口开合的工具语义归你——宿主只提供 `windows` 设施（开/关/聚焦/模式/查询），
不实现任何窗口工具。

## 第 5 步：异步长任务（件 D）

「提交即返回卡片，完成后台唤醒，凭定位键取内容」：

- **工具口**：manifest.tools 条目加 `"async": true`——宿主生成 taskId 注入
  `args._task_id`（回执引用同一键）；你的后台代码完成后调宿主桥
  `deferred.complete(taskId, 'completed' | 'failed', message?)`；
- **MCP 路**：`tools/call` 立即回卡片（记住请求 `_meta.progressToken`），
  完成后发通知：

```json
{ "jsonrpc": "2.0", "method": "lantai/deferred",
  "params": { "progressToken": "<调用期回带的 token>", "taskId": "export-x1", "status": "completed", "message": "导出完成" } }
```

两条路汇成同一唤醒：发起 Agent 收到 minimal 定位键
`{"status":"completed","taskId":"export-x1","sessionId":"7"}`——**内容不进
唤醒体**，模型凭 taskId 调你的查询工具按需取（notes_export 带 taskId = 取
导出内容的双模设计）。

## 端到端验证

- 守护测试：`tests/notes-app-example.test.ts`（真 server 进程集成——握手/
  工具面/异步唤醒/HTTP CORS 面）+ `tests/notes-app-loader.test.ts`（装载/
  窗口定义登记/notes_open 端到端）；
- 真机验收：装载 → 开窗 → Agent 调 `notes_create` 窗内可见 → `notes_export`
  异步唤醒 → 关窗空闲回收 → 卸载 `.trash`。

## 复制 notes-app 做新软件

改五处：manifest（name/app.entry/mcpServers/tools）→ entry.js（你的开窗
工具）→ server.cjs（你的数据工具 + 窗 API）→ app/index.html（你的 UI，
桥 SDK 段可原样拷走）→ README。三档启动策略怎么选、数据权威单点怎么设计：
见 [`examples/plugins/notes-app/README.md`](../../examples/plugins/notes-app/README.md)。
