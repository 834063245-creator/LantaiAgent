# office —— OfficeCLI 载体插件（分发形态）

把 [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（单二进制 Office 套件：
`.docx`/`.xlsx`/`.pptx` 读写 + 内置渲染引擎与公式/透视引擎）以**受治 MCP server** 形态挂进兰台。

> 集成计划与全部实测数据：[`docs/plans/office-cli-integration-plan.md`](../../../docs/plans/office-cli-integration-plan.md)
> 零代码挂接件（不改代码的 A 路）：[`examples/office-cli/`](../../office-cli/)

## 1. 这个插件做什么 / 不做什么

| 做 | 说明 |
|---|---|
| 二进制载体 | 二进制住插件目录 `bin/officecli.exe`——**换版本 = 换产物，不重编译 exe**（与出厂产物磁盘通道同思路） |
| 受治后端 | `mcpServers` 一条 stdio 声明：`lifecycle: lazy`（首装配/调用拉起，空闲回收）+ `restart: on-crash`（崩溃指数退避自动重启）；进程 kill 挂插件 fiber |
| 工具面 | 模型得到**一个**工具 `mcp__office__officecli`（唯一参数 `command`：命令行字符串或 argv 数组） |
| 装卸面 | 走兰台「设置 → 插件 → 安装目录」，可禁用/卸载（卸载即链式停进程） |

| 不做 | 为什么 |
|---|---|
| 不带技能文件 | 兰台技能只从 `.lantai/skills`（项目/用户）与出厂技能三个根发现，插件通道**没有**技能贡献面——技能走 `examples/office-cli/SKILL.md`（拷进 `~/.lantai/skills/officecli/`） |
| 不在 entry.js 里查二进制 | 插件在 webview 内无盘权（宿主桥 fs 只覆盖自己的 dataDir），查不了插件目录 |
| 不声明 `readOnly` | officecli **写文件**；条目级 `readOnly: true` 会让写动作在 plan 模式被放行——缺省不表态 = fail-closed 视为写，这才是期望行为（契约 v27） |
| 不声明 `permissions` | 权限类是兰台 RPC 咽喉的五个域（read/edit/bash/git/web）；本插件的写动作发生在**它自己的子进程**里，不走那些 RPC——声明了也管不到，如实不声明（见 §3 边界） |

## 2. 装

```powershell
# ① 放二进制（三选一，见 bin/README.md）
.\bin\README.md 的 a/b/c 任一

# ② 装插件：设置 → 插件 → 安装框填本目录绝对路径 → 安装
#    （或把整个目录拷进 %USERPROFILE%\.lantai\plugins\office\ 后重启）

# ③ 技能（插件通道不带技能）
Copy-Item ..\..\office-cli\SKILL.md "$env:USERPROFILE\.lantai\skills\officecli\SKILL.md" -Force
```

装完开**新会话**（工具面变更只发生在会话边界——这是平台纪律不是 bug）。

## 3. 活预览窗（环回远端视图，契约 v28）

manifest 声明了 `app: { url: "http://127.0.0.1:26315/", mode: "floating" }`——**环回远端页**形态：
窗里跑的不是插件自己的 HTML，而是本机 `officecli watch` 提供的实时渲染页。

```powershell
# ① 起 watch（Agent 走 shell 域后台跑，或你手动跑）
officecli watch D:\path\to\文档.docx      # 打印 http://localhost:26315
# ② 开窗：让 Agent 调本插件的工具 office_preview_open（或经窗口设施）
```

- 改文档 → watch 服务经 SSE 推新页 → **窗内实时刷新**（这才是"活预览"）。
  **实测机制**：连上 `/events` 立即收 `selection-update` / `mark-update`；每次文件改动**约 0.6 s 内**推一条
  `word-patch`——载荷是**增量补丁**（`{op, block, html, data-path}` + `version`/`baseVersion`），不是整页重载；
  所以窗内自动刷新，**不需要轮询、不需要重开窗**（推送链路已实测；**真机壳也已验**：在兰台真实 webview 里
  注入隐藏 iframe 后，A 档 `allow-same-origin` 的内页 `EventSource.readyState=1(OPEN)`、页面真渲染，
  不加该许可则为 `2(CLOSED)`——实验细节见 `docs/plans/office-cli-integration-plan.md` §2.4）。
- 窗内容是**跨源远端文档**：iframe 给 `allow-same-origin`（保住它自己的 origin，同源 SSE/fetch 才通——
  实测该服务不回 CORS 头，opaque origin 下活刷新必死），**但不绑宿主桥**（远端页不是插件代码，
  拿不到插件身份与桥能力）；父页也拿不到它的 DOM。
- 白名单硬边界：只许 127.0.0.1 / localhost / ::1，禁凭据，禁公网，**禁 fullscreen**（远端文档能覆盖
  宿主视觉面，全屏形态把界面辨识度也拿走）。
- 端口变了（`officecli watch --port N`）要同步改 manifest 里的 url——窗指向的是声明值，不做发现。
- **不想起 watch 的场合**：用截图刷新路（`view … screenshot` + `update_asset` 原地刷新纸面资产块，
  见 `examples/office-cli/SKILL.md` §7.5）——零进程、零平台件，代价是图不自动跟。

## 4. 与用户级 `~/.lantai/mcp.json` 的关系（重要）

两者都能挂同一个 server：

| 形态 | 优点 | 缺点 |
|---|---|---|
| **本插件（推荐分发形态）** | 走设置面板装卸/启停；二进制随插件目录走；进程治理字段同源 | 目录要自带二进制；不带技能 |
| 用户级 `mcp.json` | 零文件、跨工作区个人配置；`examples/office-cli/README.md` 有现成三件套 | 手写 JSON；不进插件面板；不随插件装卸 |

⚠️ **不要同时挂两份**：两个 server 各折算出一条工具行，两条行都产出同名工具 `mcp__office__officecli`；
装配期 `buildToolRegistry` 对每个工具调 `registry.register(tool)`，重名**直接 throw**
（`ToolRegistry: duplicate tool "mcp__office__officecli"`）⇒ **该会话的 Agent 装配失败**（不是静默取其一、
也不是"后注册胜"）。二选一；切换时先把另一份卸掉（插件禁用 / 删 mcp.json 条目）再开新会话。

## 5. 边界（如实列出）

- **沙箱外**：MCP 挂接的子进程是**全权用户进程**——不经 `fs_cap`、不受 `os_sandbox` 约束，可写任意路径。
  需要沙箱/权限类/审计的动作应走 shell 域（`process_cap`），不要挂 MCP。
  （`docs/plugins/README.md` §5 已知边界 + 本计划 §7 坑 2）
- **模型看不到工具结果里的图**：`view screenshot` 返回图片内容块，兰台工具结果契约是纯文本 ⇒ 图被丢。
  要看效果：落盘 PNG + `show_asset(kind='file', …)`（技能铁律 2）。
- **落盘边界**：officecli 自己的读总见最新，别的程序读的是盘上字节 ⇒ 兰台回读/交付前必须 `save`/`close`。
- 版本漂移快：本插件按 pin 版本（1.0.149）验证；升版本走安装器换哈希 + 重跑
  `src-ui/tests/office-cli-e2e.test.ts` 与 `src-ui/tests/office-plugin-example.test.ts`。

## 6. 守护测试

`src-ui/tests/office-plugin-example.test.ts`：
① 形状守护（manifest 过 `validateManifest`；`./bin/officecli.exe` 相对命令；治理字段；**未声明 readOnly**；
entry 导出 `{name, apply}`；`bin/README.md` 在）；
② 载体语义真机（二进制在场时）：把已装二进制硬链进临时插件目录 → 用**本 manifest 的声明**经
`registerMcpServerTools` 装载（pluginDir 锚在临时目录）→ 就绪后工具名/只读语义/真命令执行。
二进制缺席自动跳过（CI 安全）。
