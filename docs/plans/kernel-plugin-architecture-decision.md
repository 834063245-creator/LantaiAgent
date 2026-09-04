# 内核最小化 —— 从零设计定稿（拆除 P0-2 架构脚手架）

> 状态：**定稿**（2026-09-04 用户思想实验定案）。本页取代前几页的「逐步反向拆」——
> 用户指出我触发了「不敢拆」的模型惯性，每一步都要拍板。思想实验：
> **假设没有内核，从零设计这套系统，会纠结把什么给什么吗？** 答案：不会。
> 从零设计的形态是干净且无歧义的——反向拆之所以难，是因为 P0-2 把工具硬塞进
> Rust 时造的脚手架（builtin.* / manifest 双端镜像 / tool_call 信封 / PluginRegistry）
> 给「工具住在 Rust」圆场。**从零设计减去现状，剩下全拆。**

## 0. 从零设计的系统形态（无争议基准）

| 层 | 内容 | 位置 |
|---|---|---|
| 产品本体 | 会话/编排/UI/多 Agent/**工具（schema+代码）** | webview TS（44 hologram/* 域插件就是家） |
| 系统能力 | 盘/进程/网络/凭据/Ask/UI——webview 碰不了、且是受信原语 | exe（极少数能力原语口 + 口内权限闸） |
| 图谱引擎 | 独立进程 hologram-engine serve（自有工具随它暴露） | 进程外，壳只 MCP client 转发 |
| LSP | 用户机器原生 language server | 起原生进程转发，薄，留内核无编排业务 |
| 外部第三方 | MCP server | 进程外既有通道 |

**从零设计里不存在**：builtin.* Rust 工具模块、manifest.json 双端镜像、生成器、
PluginRegistry、tool_call {plugin} 信封、PluginToolAdapter family 寻址——全是 P0-2
把工具塞进 Rust 的脚手架。

## 1. 拆除令（用户拍板：拆干净，不再逐项征求意见）

**退役（工具业务离开 exe）**：
- 11 个 builtin.* Rust 模块（fs/git/shell/browser/uia/pty/lsp/search/web/editor/
  constraints，共 5631 行）——编排迁 TS 域插件；字节执行走内核能力原语。
- 11 份 manifest.json + include_str! + gen-kernel-manifest/gen-plugin-manifests
  生成器 + kernel-manifests.generated.ts 镜像 + doc-sync 对拍——**schema 真源回
  TS zod**（P0-2 的「单一真源在 manifest」裁决废除，回 INVARIANTS #8 原版：
  工具定义 = defineTool + zod）。
- tool_call 信封 + PluginRegistry + PluginToolAdapter——被能力原语 RPC 取代。
- 引擎域壳半截桥（hologram_call 工具侧）——归引擎 serve（壳只 client 转发）。

**保留（本来就是内核）**：permissions/sandbox/audit/credential/os_sandbox（能力闸）、
confined_fs 字节执行（作为 fs 能力原语的实现，裁决+字节一体已就绪）、
workspace/session 应用壳、engine_transport（MCP client）、LSP 原生转发、llm_proxy/
plugin_assets。

## 2. 终态能力原语面（极少数，与工具数无关）

| 能力族 | 口内实现（在内核，可复杂） | 闸（口内，现成） |
|---|---|---|
| fs（含 search/glob 变体） | 字节 I/O + 全文扫描/向量召回 | resolve_read/write_dispatch（Agent 过 require_* Ask+规则，UI 只解析） |
| process（含 git/shell spawn） | spawn 子进程收输出 | BashTool/git 家族 + 命令规则 |
| 凭据 | credential_* | 已存在 |
| Ask/UI | permission_ask_response | 已存在 |
| 会话句柄（browser/uia/pty/lsp 若留壳） | CDP/COM/PTY/LSP 注册表操作 | BrowserTool/DesktopTool 多层语义 |

**精化（2026-09-04 定案：能力 vs 业务界）**：search/glob 的全文扫描+向量召回
**是 fs 能力族的实现，不是「工具业务」**——留在内核能力口（fs.search 变体），
TS 只做编排+schema。原则：**「回 TS」的是用户可见工具编排（工具名/参数组合/
结果呈现）；能力的实现永远在内核能力口**。能力口数量 = 能力族数，与工具名数
无关——search 是 fs 族一个变体，不是每工具一个口。

## 3. 域归属终态

- 用户可见工具编排（fs/git/shell/search/web/editor/constraints/browser/uia/pty 的
  工具名/schema/组合/呈现）→ TS 域插件（schema 回 zod）。
- 能力实现（字节 I/O / 全文搜索 / spawn / CDP/COM/PTY 句柄操作）→ 内核能力口。
- 引擎自有（graph/ops）：随引擎 serve 暴露，壳只 MCP client 转发，不定义 schema。
- 原生引用（LSP）：起用户机器 language server + 转发，留内核（无编排业务）。
- 外部第三方：MCP server，已有通道。

## 4. 执行序（批 = commit 界，门禁全绿）

R1 勘察 TS 域插件装配 → R2 薄域编排先回 TS（schema zod）+ 能力实现并入口 →
R3 fs/git/shell 编排回 TS → R4 browser/uia 句柄域 → R5 拆 manifest 脚手架 +
tool_call/PluginRegistry → 收口全门禁 + 落账。
