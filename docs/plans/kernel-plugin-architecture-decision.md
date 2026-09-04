# 内核最小化 —— 从零设计定稿（v2：权限策略层在 TS，不进 Rust）

> 状态：**定稿**（2026-09-04）。v2 修正：权限**策略**层放 TS（对齐 Claude Code
> `permissions.ts` / DSH `pre-execute` waterfall 两个主流先例），Rust 能力口只做
> 已授权调用的执行 + 物理沙箱兜底。本页取代 v1 的「能力口内嵌权限闸」表述。
>
> 溯源：用户思想实验（「假设没有内核从零设计，会纠结吗」→ 不会）指出 P0-2 的
> 脚手架（builtin.* / manifest 双端镜像 / tool_call 信封 / PluginRegistry）是为
> 「工具住在 Rust」圆场。用户读 DSH + Claude Code 泄露源码（jeecg-cc）后确认：
> **两个主流 agent 系统都是 TS 定义工具 + TS 实现权限策略，原生层只做物理执行与
> 沙箱——没有任何一个把工具 schema 或权限策略焊进原生二进制。** v1 把「闸」写进
> Rust 能力口仍是分层错误残留，v2 修正。

## 0. 从零设计的系统形态（四层，权限策略在 TS）

| 层 | 内容 | 位置 | 对应先例 |
|---|---|---|---|
| 产品 + 工具 | 会话/编排/UI/多 Agent/工具 schema+zod + 编排 | webview TS（44 域插件） | Claude Code tools.ts / DSH defineTool |
| **权限策略层** | 规则 allow/deny/ask + mode 分发 + Ask UI + 规则记忆 | **TS**（不进 Rust） | Claude Code `utils/permissions/permissions.ts` / DSH `tools/pre-execute` waterfall + guards + approval |
| 能力执行 | 盘字节/搜索/spawn/句柄操作——webview 碰不了的受信执行 | Rust 能力口（**薄，只执行已授权调用**） | Node 直碰 + landlock/seatbelt 兜底 |
| 物理沙箱 | 进程文件效应兜底（read-only/workspace-write） | Rust/native | Claude Code sandbox / DSH native landlock-run |

**从零设计里不存在**：builtin.* Rust 工具模块、manifest.json 双端镜像、生成器、
PluginRegistry、tool_call {plugin} 信封、PluginToolAdapter family 寻址、以及
**Rust 内的权限裁决逻辑**——全是 P0-2 把工具与策略塞进 Rust 的脚手架。

## 1. 修正后的分层原则（本页核心）

> **权限策略层不改进 Rust。** 它和工具定义一样是产品逻辑——规则怎么配、谁允许谁
> 拒绝、Ask 怎么弹、mode 怎么分发、规则怎么记忆——这些全在 TS。Claude Code 的
> `permissions.ts`、DSH 的 pre-execute/guards/approval 是同一层的两个成熟实现。
>
> Rust 只留**执行**：能力口收到「已被 TS 策略层裁决放行」的调用就执行；外加物理
> 沙箱兜底（即使 TS 策略被绕过，进程也受 OS 级文件效应约束）。Rust 不读规则、
> 不判 allow/deny/ask、不弹 Ask。

### 为什么必须这样（对照先例）

- **TS 策略**：规则层叠（user/project/local/policy）、Ask 记忆写回、mode 切换、
  审批文案、审计——全是高频演化的产品逻辑，放 TS 可热改、可审计、与 UI 同进程。
- **Rust 只执行**：webview 无盘权/进程权，碰资源必须经原生；但「能不能碰」已由
  TS 判定，Rust 不重复判——只执行 + 沙箱兜底（防 TS 层被攻破后越权碰盘）。
- Claude Code 的 Bun/Node 宿主 + DSH 的 Node 宿主都是「TS 直碰资源 + 沙箱约束」；
  兰台 webview 不可信，故中间加 Rust 能力口——这是 Tauri 架构差异，不是分层差异。
  策略仍在 TS，只有执行因架构必须经原生。

## 2. 拆除令（用户拍板）

**退役**：
- 11 个 builtin.* Rust 模块（5631 行编排）——编排迁 TS 域插件。
- 11 份 manifest.json + include_str! + 生成器 + generated 镜像 + doc-sync 对拍——
  schema 真源回 TS zod（回 INVARIANTS #8 原版：defineTool + zod）。
- tool_call 信封 + PluginRegistry + PluginToolAdapter——被「TS 策略闸 + 能力口 RPC」取代。
- Rust 权限裁决（PluginToolAdapter family 寻址、dispatch 侧 check_permission）——
  权限策略归 TS；Rust 只留 permissions/ 的**物理执行辅助**（sandbox 判定、路径
  canonical、审计落盘点）。
- 引擎域壳半截桥（hologram_call 工具侧）——归引擎 serve（壳只 client 转发）。

**保留（Rust 能力层本体）**：
- confined_fs 字节执行（fs 能力口实现；**不含**权限裁决——物理路径由 TS 策略层
  经 resolve 传给口）。
- os_sandbox / sandbox（物理沙箱兜底）。
- credential 存储、audit 落盘、workspace/session 应用壳、engine_transport（MCP
  client）、LSP 原生转发、llm_proxy/plugin_assets。

## 3. 终态调用链（一层闸，在 TS）

```
模型/UI 工具调用
  → TS 工具（schema zod + 编排，44 域插件）
  → TS 权限策略闸（规则 allow/deny/ask + mode + Ask + 记忆——Claude Code 同构）
  → Rust 能力口 RPC（薄：resolve 物理路径 + 执行已授权调用）
  → （可选）物理沙箱兜底（read-only/workspace-write）
```

能力口面（极少数，与工具数无关）：fs（含 search/glob 变体）/ process（含 git/
shell spawn）/ credential / 会话句柄（browser/uia/pty/lsp）。**口内无策略**——
「已授权」由 TS 层保证，口只执行 + 报审计。

## 4. 域归属终态

- 工具编排 + **权限策略**：TS。
- 能力实现（字节/搜索/spawn/句柄操作）：Rust 能力口（执行）——能力口数量 =
  能力族数，与工具名无关（search 是 fs 族变体，非每工具一口）。
- 物理沙箱：Rust/native（read-only/workspace-write 文件效应）。
- 引擎自有（graph/ops）：随引擎 serve 暴露，壳只 MCP client 转发。
- 原生引用（LSP）：起用户机器 language server + 转发，留 Rust（无编排业务）。
- 外部第三方：MCP server，进程外。

## 5. 执行序（批 = commit 界，门禁全绿）

| 批 | 内容 | 验收 |
|---|---|---|
| R1 | TS 权限策略层设计（规则/mode/Ask 落点——现 permissions.json + 前端 Ask 已是雏形，评估复用 vs 重写为 Claude Code 同构） | 设计 + 勘察 |
| R2 | 薄域编排先回 TS（search/web/constraints/editor：schema zod + 编排迁域插件）+ 能力实现并入 Rust 能力口 | 全门禁 |
| R3 | fs/git/shell 编排回 TS；TS 策略闸接管权限；Rust dispatch 权限逻辑退役 | 权限回归专项 |
| R4 | browser/uia 句柄域编排回 TS + 句柄能力口 | 全门禁 |
| R5 | 拆 manifest 脚手架 + tool_call/PluginRegistry + Rust 权限裁决 | 全门禁 |
| 收口 | 全门禁 + 交接/决策落账 | — |

## 6. 待执行时定的点

- TS 策略层复用现前端 Ask/permissions.json 生态 vs 重写为 Claude Code 分层规则
  （user/project/local/policy）——R1 定。
- 物理沙箱形态（os_sandbox 现状够不够 read-only/workspace-write 两档承诺）——
  R2 起核。
