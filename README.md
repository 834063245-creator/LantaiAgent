<p align="center">
  <img src="assets/banner.png" alt="兰台 Lantai" />
</p>

<p align="center">
  <strong>兰台（Lantai）— 一张纸上的 Agent 工作台</strong>：图谱引擎 HoloGram 把代码库编译成可查询的依赖图，桌面端以「注疏案卷」为唯一主界面
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://whyihaveyou.github.io/dsh-suite/"><img src="https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe" /></a>
  <a href="https://github.com/834063245-creator/Lantai/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/Lantai?color=orange&style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/Lantai/actions"><img src="https://img.shields.io/badge/tests-2700%2B-brightgreen?style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/Lantai/releases"><img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux-blue?style=flat-square" /></a>
</p>

---

## 定位

兰台把代码库解析成一张**统一 IR 依赖图**（节点 = 符号/函数/类/模块，边 = 调用/继承/读写/时序/数据流），让依赖推理变成**确定性的图查询**而不是 LLM 逐文件猜源码；同时内置完整的多 Agent 编码工作台——工作台本体经八条贡献通道**完全插件化**，出厂态零硬编码特权行。

**核心主张：依赖推理应当是确定性的，而不是猜的。**

LLM 分析"改 A 会炸什么"时，靠逐文件读源码推测依赖——弱模型会漏，大项目会翻不动。兰台的图谱引擎（HoloGram）用 tree-sitter 静态分析预先算好整张依赖图：Agent 一次工具调用拿到结构化事实（影响面、循环、脆弱模块、数据流路径），而不是源文件文本。单点查询省 ~70% token，全局分析省 90%+；省 token 是次要的，**可靠性**是主要的。

引擎是单文件二进制，本地运行、零配置、代码不出机器。它同时服务三种形态，共享同一份内存图与 watcher 增量更新：

- **MCP 服务**（`hologram-engine serve`）—— 接入 Claude Code / Cursor 等任意 MCP 客户端；
- **桌面应用**（Tauri 2 壳）—— 注疏案卷工作台（详见「桌面端」一节）；
- **DSH 插件**（`@a834063245/hologram-dsh`）—— 引擎 + 3D 星图打包进 DeepSeek Harness。

---

## 特性总览

| 能力域 | 说明 |
|---|---|
| **多语言静态分析** | 27 种 tree-sitter 语法静态链接，18 族有手工调校的结构与数据流查询（`engine/queries/` 共 38 个 .scm），Kotlin / Markdown / TOML 动态加载 |
| **确定性依赖图** | 9 种节点 / 12 种边，边带 L1–L4 耦合深度、跨文件、时序延迟、LSP 已解析等属性 |
| **深度分析** | 耦合 / 循环依赖 / 脆弱模块 / 架构盲点 / 边界违规 / 执行流 / 语法级数据流 / 社区检测（Leiden + Louvain）/ 24 个框架路由 / gRPC 服务映射 |
| **35 个图查询工具** | 影响面、改前预检、死代码、线程冲突、语义向量搜索、SCIP 导入、符号重命名……全部以结构化 JSON 返回 |
| **精确解析** | 按需启动原生 LSP（rust-analyzer / gopls / pyright 等 9 个），`resolve_call` / `infer_type` / `find_implementations` / `find_references` |
| **内置 Agent 编码工作台** | 12 个领域工具（fs / shell / git / search / web / agent / task / browser / desktop / graph / ops / lsp）+ ask_user/wait 常驻件 + code_execution 执行原语，多 Agent 协作、Plan / Goal 模式、事件溯源会话日志、token 治理 |
| **多厂商 LLM** | 9 个静态模型目录共 77 个模型 + 运行时动态发现，Anthropic / OpenAI 兼容 / DeepSeek / GLM / Qwen / MiniMax / Moonshot / Ollama / opencode；thinking 档位按厂商适配；本地反向代理绕 CORS |
| **完全插件化** | 面板/命令/工具/块渲染器/prompt 段/管道钩子/capability 八条贡献通道 + MCP 机器桥；第一方与第三方走同一注册表（详见「插件系统」） |
| **Harness 工程模式** | 约束治理（constraints.yaml）、权限引擎（Allow / Deny / Ask / Passthrough）、三层沙箱、git worktree 隔离、审计日志、系统级加密凭证 |
| **注疏案卷主界面** | 古籍注疏范式：来文/正文/夹注/脚注/抄录/拟策/贴黄七类文类块，矿物墨色语义（朱砂=人、石青=机、石墨=草稿），无限画布纸条交互（详见「桌面端」） |
| **增量与自举** | watcher 驱动增量更新（保存即刷新）；兰台用自己的引擎分析自己的代码库 |

---

## 快速开始

### MCP 模式（推荐，1 分钟）

引擎随 [Releases](https://github.com/834063245-creator/Lantai/releases) 发布（Windows / Linux），安装脚本一键完成。也可以把下面这段话直接发给你的 AI 编程工具，让它自己装：

```text
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/Lantai/releases 下载：
   - Windows: hologram-engine-windows-x64.zip
   - Linux:   hologram-engine-linux-x64.tar.gz
2. 解压后运行安装脚本：
   - Windows: 双击 install.cmd
   - Linux:   ./install.sh --user
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - command: hologram-engine
   - args: serve
4. 重启 AI 编程工具，调 engine_status 验证
```

<details>
<summary>手动配置</summary>

**Claude Code** — `~/.claude/mcp.json`：

```json
{
  "mcpServers": {
    "hologram": {
      "command": "hologram-engine",
      "args": ["serve"]
    }
  }
}
```

**Cursor** — Settings → MCP → Add new MCP server：command `hologram-engine`，args `serve`。

</details>

MCP 服务默认暴露 35 个工具；注册表里全部的 36 个 schema（含 legacy 的 `symbol_history`）可通过环境变量 `HOLOGRAM_MCP_TOOLS=*` 放开。

### CLI

引擎自带一站式 CLI，复用与 MCP/桌面端完全相同的引擎逻辑：

```bash
hologram run --list                          # 列出所有工具
hologram run graph_summary .                 # 项目概览（节点/边/解析率）
hologram run trace_impact . --node_id src/main.rs:main   # 影响面
hologram run preflight_check . --files a.rs,b.rs         # 改前检查（exit code 表达结果）
hologram run detect_cycles .                 # 循环依赖
hologram run list_flows .                    # 执行流（按安全敏感度排序）
hologram serve --project-root . --tcp        # MCP stdio 服务（可同时开 TCP :9777）
hologram --stress <path> <iters>             # 压力测试 / 基准
```

### 桌面应用

[Releases](https://github.com/834063245-creator/Lantai/releases) → 下载 `.msi`（Windows）→ 选项目 → 打开案卷。桌面端与 MCP 模式共用同一个引擎进程与数据。

### DeepSeek Harness 集成（hologram-dsh）

引擎 + 3D 星图打包为 DSH bundle 插件 [`@a834063245/hologram-dsh`](https://www.npmjs.com/package/@a834063245/hologram-dsh)：

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
# 重启后：mcp__hologram__* 工具进工具箱 + 侧边栏「3D 星图」入口
```

- **MCP 图分析工具**直接注入 DSH agent（与桌面/MCP 模式同一引擎、同一份数据）
- **3D 星图**：DSH web 侧边栏入口，全屏渲染项目依赖图（同源自托管，无独立端口）
- **单一数据生命周期**：引擎单进程双入口（MCP stdio + TCP 9777），存量秒开 + watcher 增量更新
- 安装说明与数据模型见 [`dsh-bundle/README.md`](dsh-bundle/README.md)

---

## 图分析引擎

### 数据模型

- **节点**（9 种）：`Symbol`（通用/未分类）· `Function`（函数/方法/构造）· `Class`（类/结构体/枚举）· `Module`（命名空间/包）· `File`（源文件模块）· `Interface`（接口/trait/类型别名）· `Variable`（变量/常量/字段）· `Medium`（存储/IO）· `Temporal`（异步/定时器）
- **边**（12 种）：`Imports` · `Calls` · `Inherits` · `Defines` · `Reads` · `Writes` · `Shares` · `Triggers` · `Awaits` · `Sequences` · `Usage` · `Throws`
- **边属性**：耦合深度 `L1–L4`、跨文件标记、时序延迟（秒）、`lsp_resolved`、`is_synthesized`（启发式合成边）、溯源 metadata

### 分析管线

```
文件发现 → 分批并行解析（200 文件/批，rayon）→ 串行合并（内存有界、无锁、线性）
→ 跨文件引用解析 → L1-L4 耦合分析 → 24 框架路由 → 动态分发/DI/反射/React JSX 合成边
→ 数据流合成（函数级读写 + 共享状态 + async trigger/await 链）→ 社区检测（Leiden/Louvain）
→ 落库（MemoryIndex CSR + SQLite/FTS5 + 语义向量索引）
```

- **Engine 状态机**：`Uninitialized → Loading → Ready ↔ Analyzing → Error`，panic 守卫，重新分析可抢占在途任务
- **增量更新**：watcher（2s 防抖）只重解析变更文件并增量合图，失败自动回退全量；桌面端"保存即刷新"
- **存储**：内存 CSR 索引（高并发读）+ SQLite WAL 持久化 + FTS5 全文 + usearch HNSW 语义向量（MiniLM ONNX 384 维与 n-gram 双后端自动选择）
- **诚实标记**：eval/动态代码标为不可达，动态 import 标为动态站点，跨语言调用（子进程/HTTP/FFI）以合成边标记运行时桥接点——不假装知道运行时才知道的事

### 语言支持

27 种 tree-sitter 语法静态链接；其中 **18 族适配器有手工调校的查询式结构抽取**（js/ts/tsx 一族、c/cpp 各一族）：

Python · JavaScript/TypeScript/TSX · Rust · Go · Java · C/C++ · C# · Ruby · PHP · Swift · Dart · Scala · Zig · Elixir · Lua · Bash · R

其余静态链接语言（OCaml · Haskell · Nix · HTML · CSS · YAML · Erlang）走 tree-sitter 通用兜底遍历；**JSON 语法在代码中禁用**（数据文件不产生图节点，不浪费解析）；**Kotlin / Markdown / TOML** 通过 `.dll`/`.so` 动态加载（`grammars/`），无需重新编译引擎即可扩展语言。

### MCP 工具面（36 schema，默认 35）

| 域 | 工具 |
|:--|:--|
| 依赖探索（首选） | `explore_deps` `search_symbols` `get_neighbors` `inspect_symbol` `find_dep_path` `graph_summary` `get_community` `cluster_report` `grpc_services` |
| 风险分析 | `trace_impact` `preflight_check` `fragile_modules` `detect_cycles` `thread_conflicts` |
| 架构诊断 | `coupling_report` `arch_blindspots` `check_boundaries` `find_unused` |
| 执行流 | `list_flows` `get_flow` `get_affected_flows` |
| 数据流（语法级启发式，非语义污点） | `trace_dataflow` `async_edges` |
| 框架路由 | 24 种框架 URL → handler 映射（Express / Django / Rails / Spring / Next.js / SvelteKit …），动态 import / 反射 / DI 合成边 |
| LSP 精确（按需启动） | `resolve_call` `infer_type` `find_implementations` `find_references` |
| 工程 | `analyze_project` `validate_project` `project_health` `project_timeline` `rename_symbol` `import_scip` `graph_diff` `engine_status` |
| legacy | `symbol_history`（默认不暴露，`HOLOGRAM_MCP_TOOLS=*` 放开） |

每个工具返回结构化 JSON（不是源文件），并附带推荐的下一步工具；失败时返回带 `guidance`/`fallback` 的降级响应而非硬错误。

### 精确解析：LSP 与 SCIP

- **LSP 管理器**按需拉起 9 个原生语言服务器（rust-analyzer / gopls / pyright / typescript-language-server / clangd / jdtls / omnisharp / intelephense / kotlin-language-server），自研 JSON-RPC 帧协议（字节流定界、快速失败、死壳自愈），提供精确的调用解析 / 类型推断 / 接口实现 / 引用查询
- **SCIP 导入**（`import_scip`）：导入 SCIP 索引提升符号级引用精度，带自动钩子与诚实的跳过统计

---

## 内置 Agent 编码工作台

桌面应用内置完整的多 Agent 运行时（与 DSH 集成共用引擎数据）。改代码前先问图：`graph(symbols → impact → preflight)` 是工作流入口。

### 领域工具（12 个，旧细粒度名已淘汰）

模型可见面上只有 12 个高内聚领域工具（另加 ask_user / wait 两个常驻件），每个工具内部是 `action` 判别联合（全部动作与参数以生成物 [`docs/agents/model-tool-contract.md`](docs/agents/model-tool-contract.md) 为唯一事实源；code_execution 执行原语与记忆族经会话级 capability 装配）：

| 领域 | 动作（示例） |
|---|---|
| `fs` | read / write / edit / list / glob / mkdir / move / rename / delete / constraints / write_constraints |
| `shell` | run（bundled bash，构建/测试命令；Windows 原生任务用 pwsh）/ output / wait / kill |
| `git` | status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame |
| `search` | content（源码文本搜索） |
| `web` | fetch（URL 抓取转可读文本） |
| `agent` | spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolate_*（worktree 隔离全流程） |
| `task` | create / get / list / update / stop / board（TaskBoard） |
| `browser` | 37 个动作：launch / connect / navigate / snapshot / content / click / type / eval / network / HAR / screenshot / audit …（CDP 控制，多账号会话隔离） |
| `desktop` | probe（进程/窗口探测）· screenshot · uia_tree / uia_find /…（进程内 UIA COM 树） |
| `graph` | 27 个动作：symbols / neighbors / impact / path / inspect / explore / community / clusters / summary / cycles / coupling / fragile / blindspots / boundaries / conflicts / async / unused / flows / dataflow / preflight / grpc / diff … |
| `ops` | analyze / validate / health / status / timeline / rename / import_scip |
| `lsp` | resolve_call / infer_type / implementations / references |

旧细粒度名（`run_shell`、`write_file`、`git_*`、`search_symbols` 等）保留在注册表但对模型隐藏，调用会被 `retireRedirect` 拦截并返回 `[已淘汰] → 领域动作` 重定向。新增工具必须 `defineTool` + zod v4（一个 schema 同时产出 JSON Schema / 运行时校验 / 类型化参数）。

### Agent 运行时内核

- **声明式装配 + 完全插件化（2026-08-24 P4 收官）**：工具族 / system-prompt 段 / 会话级 capability 三类行源**全量经插件通道贡献**，出厂表三张退役——兰台的出厂态里没有任何一行硬编码特权。第一方能力与第三方插件在同一注册表上竞争，装载序即防线；`AgentConfig` 冻结 31 字段不再扩张；三层表序 = 字节契约（保护 DeepSeek 前缀缓存与 effective 快照）
- **会话事件溯源**：session 变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三个入口，`SessionLog` 事件日志支撑差分对拍、回放与审计
- **生命周期内核（cordis）**：vendored cordis 内核（Context/Fiber/Service）承载全部资源生命周期——工作区级资源以 fiber effect 登记、顺序敏感拆除组打包逆序执行；Agent 挂身份 fiber；子系统以 Service 挂树；epoch 代际防护管逃逸所有权的在途回调
- **流式执行**：tool_use 完成即 dispatch（不等整条 stream），同轮只读工具并发执行；工具输出 50KB/2000 行截断；可重试错误指数退避（最多 3 次）；AbortSignal 贯穿，卡死工具不挂死循环
- **token 治理**：工具结果滚动折叠、成本模型驱动的 auto-compact（压缩只作用于发送载荷，session 永为完整历史）
- **一致性门禁**：`npm run verify:convergence`（T0 静态 + frozen baseline 对拍 + system-prompt fixture），任何变更破坏契约即失败；baseline 变更走审批

### 多 Agent 协作

- `SubAgentPool`：并发上限 5、队列 20、默认超时 30 分钟；`fork`（继承上下文）/ `fresh`（干净启动）两种模式
- **通信层**：有界 inbox（100 条，满了 drop 防背压）、peek + ack、主题拓扑（Tree/Mesh/Star），消息持久化
- **共享状态板**：TaskBoard（任务状态 / filesTouched / diff）与 DiscoveryBoard（探索发现，TTL 2h）——均按会话隔离，防跨会话串扰
- **隔离执行**：子 Agent 的编辑在独立 git worktree 中运行，`agent(merge)` 进程内串行合并；重启后孤儿 worktree 收养；大 diff 溢写 `.lantai/spill/` 回传
- 模型可见的子 Agent ID：`sub-{timestamp}-{random}`；worktree ID：`agent-{timestamp}-{random}`

### Plan 与 Goal 模式

- **Plan 模式**：只读探索 + 写计划文件，`exit_plan_mode` 提交方案给用户审批；写约束由 `planGate` 在执行层拦截，工具 schema 跨模式恒定（保护前缀缓存）
- **Goal 模式**：持久化目标状态（`.lantai/goals/{id}/`），跨会话恢复，与普通对话完全隔离；完成靠 `goal_report` 工具

### 记忆体系

| 层 | 实现 |
|---|---|
| 会话记忆 | Agent session JSON（事件溯源） |
| 项目记忆 | `MemoryManager` → `.lantai/memory/*.md`，MEMORY.md 索引 + confidence 四档分级 |
| Aura 记忆 | `aura.dll` FFI（SDR + MinHash 语义召回），跨会话语义记忆 |
| Memory Bundle | 独立进程 + HTTP 客户端，进程隔离的记忆服务 |
| 技能系统 | `.lantai/skills/<name>/SKILL.md` 热加载，无需重启 |

### LLM Provider 体系

- **模型目录**：9 个静态 catalog JSON（anthropic / openai / moonshotai / qwen / deepseek / glm / minimax / ollama / opencode，共 77 个模型）+ 运行时 `fetchModels()` 动态合并（静态目录同 ID 优先）
- **协议适配**：统一 `Provider` trait 抹平 Anthropic Messages 与 OpenAI 兼容两大协议；流式 chunk 类型 Text / Reasoning / ToolCallStart / ToolCall / Usage / Done / Error
- **thinking 档位**：自动 / low / medium / high / max / off，wire 参数按厂商适配
- **本地反向代理**：壳侧起 loopback-only 的 HTTP 代理转发 LLM 请求并强加 CORS 头，绕开浏览器直连 API 的跨域限制
- **连接探针**：ConnectionProbe 最小连通性验证（成功/失败/耗时），结果持久化
- **凭据**：系统级加密存储（Windows DPAPI / macOS Keychain / Linux secret-tool），本地永不明文

---

## 插件系统（八通道全开）

> **2026-08-24 P4 收官**：出厂态零硬编码特权行。面板/命令/工具/块渲染器/prompt 段/管道钩子/capability 全部经插件通道贡献——兰台自己就是自己插件架构的第一用户（十五项第一方 capability、十三段 system-prompt、全部领域工具行都走同一套通道），与第三方插件在同一注册表上竞争。

| 通道 | 挂什么 | 生效时机 |
|---|---|---|
| `ctx.panels` | 桌面端面板 | 装载后即时 |
| `ctx.commands` | 命令面板命令 | 装载后即时 |
| `ctx.tools` | 模型可见工具 | 下次 Agent 装配（新会话） |
| `ctx.renderers` | 纸壳块体渲染器 | 即时（渲染期消费） |
| `ctx.prompts` | system-prompt 段落 | 下次 Agent 装配 |
| `ctx.hooks` | 工具管道钩子（enrich 富化 / preflight 预检） | 下次 Agent 装配 |
| `ctx.capabilities` | 会话级能力（工具+钩子+ctx 服务一把抓） | 下次 Agent 装配 |
| manifest `mcpServers` | 外部 MCP server 桥接（零插件代码） | lazy 首装配 / startup-error 装载期 |

- **写一个插件的最短路径**：一个 `manifest.json` + 一个自包含 ESM 模块（webview 动态 import 装载，无包管理器、无 import map）。从零到跑通的最小示例见 [`examples/plugins/hello/`](examples/plugins/hello/README.md)
- **manifest 声明式工具**（`tools` 字段）：声明是数据（name/description/parameters JSON Schema/readOnly），执行是 entry 模块的 `toolHandlers` 命名导出——插件不触碰 `ctx.tools`，装载期即知工具面
- **权限三层**：manifest `permissions` 声明（read/edit/bash/git/web 五域闭集）→ `plugins.json` granted 段授予门禁（装载期一票否决）→ Rust 命令咽喉逐调用强制（与声明无关，照常生效）
- **信任模型（如实声明）**：插件是本机全信任代码——不做签名、不做沙箱；真正的强制层在 Rust 命令咽喉的权限规则与模式门禁
- **MCP 机器桥**：manifest `mcpServers` 声明式挂接外部 MCP server——stdio（Rust 进程桥）与 http 双传输，工具以 `mcp__<server>__<工具名>` 注册；这是比自造插件格式更标准的开放路径
- **preset/patch 寻址**：全部贡献行（含第一方）可被 roster patch / preset 禁用、覆盖、锚定——组合解析域对内外一律均匀
- **完整契约**：[`docs/plugins/README.md`](docs/plugins/README.md)（manifest 字段 / 八通道 API / 宿主桥 / 安装与授权 / 信任模型 / KV-cache 注意事项）

---

## 桌面端（注疏案卷）

> 兰台＝汉代皇家档案典籍库。产品不是「聊天窗」，而是**一部正在被编纂的案卷**——人在纸边批注、AI 居中撰文、机器贴底注记。把「等权消息流」换成「注疏层级」。

### 注疏范式

| 块类型 | 文类签 | 语义 |
|---|---|---|
| `user` | 来文 | 人的问话——楷书 + 朱砂深，左 2px 红批线 |
| `markdown` | 正文 | AI 的答——宋体大字号居中主角 |
| `reasoning` | 夹注 | 模型思考链——缩进列边，石墨铅笔，虚线勾边 |
| `tool` | 脚注 | 工具调用记录——贴底小字，石青注线 |
| `diff` | 抄录 | 代码图版——硬左线 + 米黄底，add 松绿 / del 朱砂深加删除线 |
| `plan` | 拟策 | 方案审批——顶硬线 + 石青序号 |
| `notice` | 贴黄 | 系统通知——古代奏章上贴的黄纸条 |

**墨色铁律**：朱砂 = 人，石青 = 机，石墨 = 草稿，墨 = 正文。字体三栈——宋体（正文，Noto Serif SC + EB Garamond）/ 楷书（手迹，Ma Shan Zheng，只给「人的来文」）/ 等宽（机读，IBM Plex Mono）。

### 画布交互

无限画布 + 纸条（块）钉住/收回 + 小地图 + 拖拽落点分区；多卷并行（左缘书脊列 SpineRack，恒显/卷首名双击改名/合卷自动存）；会话即案卷，摊开的工作集重启全恢复。

### 视觉系统

矿物颜料墨色 token（松烟墨/朱砂/石青/赭石石墨/纸面）全 UI 统一；设计契约 [`docs/design/lantai-design-spec.md`](docs/design/lantai-design-spec.md)，视觉决定账本 [`docs/plans/paper-shell/taste-ledger.md`](docs/plans/paper-shell/taste-ledger.md)。

### 状态管理

React 19 + Zustand 5：面板级状态走 `createScopedStore` 注册表，app 级单例走 shell/dock/overlay store；事件总线已归零（禁复活）；Workspace 统一状态容器（vendored cordis fiber 树）原子化切换，DisposerBag + epoch 防旧项目串台。

---

## Harness Engineering（桌面端）

### 约束治理

`hologram.constraints.yaml` 定义不可逾越的架构边界（L5 永远路由、L4 静默破溃默认路由、波及半径阈值、跨社区边容忍、黑白名单）；Agent 编辑文件前必须过 `preflight_check`，引擎按图拓扑计算波及半径/跨社区影响/L4 穿透决定放行或路由人工确认。

### 权限引擎

- 规则三来源合并：系统 / 项目（`.lantai/permissions.json`）/ 会话，裁决四态：`Allow` / `Deny` / `Ask`（danger 红卡）/ `Passthrough`；模式 Ask / Auto / Yolo（Yolo 不旁路 Deny）
- **Bash 危险命令引擎**：13 类危险模式（rm -rf /、curl|sh、eval/exec/source、sudo/su、写 /dev/*、git push -f main、mkfs、shutdown …）+ PowerShell 特判（Invoke-Expression、iwr|iex、FromBase64String）+ 管道解码检测
- 路径规则对 worktree 自动 reverse-map 回主仓库逻辑路径；`_agent_id` 每次调用显式传递，杜绝并行子 Agent 身份串扰

### 沙箱（三层）

- **OS 层**：Windows Job Object（进程树随父死亡、64 进程 / 1 GiB 上限）；macOS sandbox-exec；Linux bubblewrap；shell 走捆绑 MSYS2 bash（vendor），Windows 原生任务才用 pwsh
- **路径层**：canonicalize + 符号链接/junction 检测，读写边界校验；边界外不静默拒绝，升级为 Ask 弹窗
- **受限文件系统**：统一 I/O 包装（100 MiB 读写上限、30s 超时、3 次瞬态重试、原子写）

### 隔离（git worktree）

每个子 Agent 一个 `git worktree add --detach` 独立工作区：正反向路径映射、范围 cherry-pick 串行合并（清失败≠合并失败）、重启后孤儿 worktree 收养、大 diff 溢写回传；TTL 清理不销毁无记录工作。

### 审计

全部工具调用落 `.lantai/audit.jsonl`（allowed / denied / user_approved / user_denied），配合 `project_timeline` 工具按时间线回溯。

---

## 架构

```
┌─────────────── src-ui (TypeScript) ─────────────────┐
│  React 19 · 注疏案卷纸壳 · Agent 运行时 · 组合层       │
│  zustand stores · Workspace（vendored cordis fiber 树）│
└───────────────────────┬────────────────────────────┘
                        │ typedRpc / typedListen（153 个方法，单一契约）
┌─────────────── src-tauri (Rust / Tauri 2) ──────────┐
│  权限引擎 · 三层沙箱 · worktree 隔离 · ResourceLedger │
│  LLM 反向代理 · 加密凭证 · 审计 · PTY · CDP 浏览器     │
└───────────────────────┬────────────────────────────┘
                        │ TCP 127.0.0.1:9777
┌───────────────────────▼────────────────────────────┐
│  engine (Rust，单二进制 hologram-engine)             │
│  tree-sitter AST → 并行管线 → 9 节点/12 边依赖图      │
│  MemoryIndex (CSR) + SQLite/FTS5 + 语义向量          │
│  36 MCP schema（默认 35）· stdio / CLI / TCP 三入口   │
└────────────────────────────────────────────────────┘
```

| 层 | 目录 | 职责 |
|:--|:--|:--|
| 引擎 | `engine/` | 解析 · 图构建 · 耦合/数据流/社区/脆弱性分析 · 存储 · MCP/CLI/TCP |
| 壳 | `src-tauri/` | Tauri 2 · 权限裁决 · 沙箱 · 隔离 · 生命周期 · 凭证 · 代理 |
| 前端 | `src-ui/` | 注疏案卷纸壳 · Agent 运行时 · 多 Agent 编排 · 组合层/插件系统 · Provider 体系 |

架构决策（为什么引擎独立二进制、为什么权限在壳层、为什么 Agent 在前端、为什么用 worktree 隔离）见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

---

## 工程事实

- **测试基线**（2026-08-23/24 实测，数字会漂移，以重新实测为准）：引擎 **697 用例**（696 passed / 1 ignored）· 壳 **bin 389 + 集成 14**（全绿）· 前端 **162 文件 1610 passed / 1 skipped**（convergence 双 preset 零漂移）
- **自举**：兰台用自己的引擎分析自己的代码库
- 实测（Linux kernel 全量，历史基准）：全量分析 1,770s 全程跑完，RSS 646MB
- 并行解析 200 文件/批；增量更新由 watcher 驱动（保存即刷新）
- 三端独立验证：`engine cargo test` · `src-tauri cargo test` · `src-ui vitest run`；前端另有 `npm run verify:convergence` 契约门禁
- 已知盲区以"诚实标记"处理：eval/动态代码标记不可达、动态 import 标记动态站点，不假装知道运行时才知道的事

---

## 从源码构建

```bash
# 引擎（MCP / CLI / DSH 只需要这个；Linux / Windows 均可）
cd engine && cargo build --release

# 桌面应用（Windows；会自动先跑前端构建）
cd src-tauri && cargo tauri build

# DSH 插件（做本地开发用，见 dsh-bundle/README.md）
cd dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build && npm run build:client
```

## 开发

```bash
cd engine && cargo test        # 引擎用例
cd src-tauri && cargo test     # 壳用例（权限/生命周期/隔离）
cd src-ui && npx vitest run    # 前端用例
cd src-ui && npm run build     # tsc --noEmit + vite build
cd src-ui && npm run verify:convergence   # Agent 运行时契约门禁
cd src-ui && npx biome check --write <改动文件>   # 格式（全仓存量基线勿顺手清）
```

**写插件**：契约见 [`docs/plugins/README.md`](docs/plugins/README.md)，最小示例 [`examples/plugins/hello/`](examples/plugins/hello/README.md)——不改 Rust 引擎也能贡献面板/命令/工具/渲染器。

项目理解与工作纪律见 [`AGENTS.md`](AGENTS.md)（Codex）与 [`CLAUDE.md`](CLAUDE.md)（内置 Agent）；提交流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；文档总索引见 [`docs/README.md`](docs/README.md)（`docs/archive/` 为已竣工施工稿，勿作现状依据）。

---

## 许可

兰台（Lantai）© 2026 Wenbing Jing — [MIT](LICENSE)。第三方组件（tree-sitter 语法库、SQLite、USearch、onnxruntime、mimalloc 等）版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；安全策略见 [SECURITY.md](SECURITY.md)。
