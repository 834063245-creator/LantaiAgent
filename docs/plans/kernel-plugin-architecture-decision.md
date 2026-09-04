# 内核最小化 —— 从零设计定稿（v3：TS 策略建议层 + Rust 能力口强制层）

> 状态：**定稿**（2026-09-04）。演进：
> - v1 把权限闸写进 Rust 能力口（分层错误残留）；
> - v2 参照 Claude Code permissions.ts / DSH pre-execute waterfall 把**策略**放 TS，
>   但误写成「Rust 口只执行、不判」（把强制层弱化）；
> - **v3（用户定论）**：DSH/Claude Code 的模型有安全隐患——TS 插件代码与资源同在
>   可信 Node 进程，恶意插件可 import node:fs/child_process **不经工具管线绕过全部
>   权限**，sandbox 只套子进程套不了宿主。兰台相反（webview 无盘权），**Rust 能力口
>   不可删**：它是 webview 越不过的**物理强制层**。最终形态 = 双层：
>   **TS = 策略建议层（规则/Ask/mode/记忆）；Rust 能力口 = 强制层（已授权校验 +
>   物理路径 resolve + 审计，即使 TS 被攻破也越不过）+ 物理沙箱兜底。**

## 0. 从零设计的系统形态（五层，策略在 TS，强制在 Rust）

| 层 | 内容 | 位置 | 对应先例 |
|---|---|---|---|
| 产品 + 工具 | 会话/编排/UI/多 Agent/工具 schema+zod + 编排 | webview TS（44 域插件） | Claude Code tools.ts / DSH defineTool |
| 权限策略 | 规则 allow/deny/ask + mode + Ask UI + 记忆（**建议/体验**） | TS | Claude Code permissions.ts / DSH pre-execute + approval |
| 能力执行 + **强制** | 盘/搜索/spawn/句柄——**已授权校验 + 物理路径 resolve + 审计，webview 越不过的最后闸** | Rust 能力口（少数，按能力族） | 兰台独有（Node 直碰缺此层 = 隐患） |
| 物理沙箱 | 进程文件效应兜底（read-only/workspace-write） | Rust/native | Claude Code sandbox / DSH landlock-run |

**从零设计里不存在**：builtin.* Rust 工具模块、manifest.json 双端镜像、生成器、
PluginRegistry、tool_call {plugin} 信封、PluginToolAdapter family 寻址——全是
P0-2 把工具与策略塞进 Rust 的脚手架。**但存在**：极少数 Rust 能力口（执行+强制）。

## 1. 修正后的分层原则（本页核心）

> **权限「策略」层不改进 Rust（产品体验：规则怎么配、谁允许谁拒绝、Ask 怎么弹、
> mode 怎么分发、规则怎么记忆——TS，Claude Code permissions.ts / DSH waterfall
> 同构）；但权限的「强制」最终物理闸必须在 Rust 能力口——因为 TS/webview 层本身
> 不可信，不能把「放行」的最后裁决交给可能被攻破的代码。**

### 安全模型：双层（为什么 Rust 能力口不可删）

- **TS 策略层 = 建议/体验层**：给用户看规则、弹 Ask、管 mode、记忆规则。它裁决
  「模型这次调用该不该放行」。可热改、可审计、与 UI 同进程。
- **Rust 能力口 = 强制层**：webview 里恶意插件或被攻破的 TS **没有盘权/进程权**，
  想碰资源唯一的路就是能力口 RPC——口是**物理上不可绕过的最后一道闸**（校验 +
  路径 resolve + 审计落盘），即使 TS 层整个被攻破也越不过。

### 为什么 DSH/Claude Code 那套对兰台不够（用户定论）

DSH/Claude Code 的模型是「TS 插件代码与资源访问同在可信 Node 进程」——它们拦的是
**模型/会话的调用**（工具管线/规则），不是**插件代码本身**。恶意插件 import
`node:fs`/`child_process` 直接碰盘，**不经工具管线就绕过了全部权限**；sandbox 只套
子进程（bash 等），套不了宿主自己。它们的信任前提 = 代码可信（供应链），只限
调用——代码一旦恶意，防线全空。

兰台相反：**代码不可信 + 调用受限 + 执行物理隔离**。webview 无 `fs` 无
`child_process`，恶意插件写再多也够不到资源，唯一出路是能力口 RPC——那条路在
Rust，闸不可绕过。这就是 Rust 能力口**必须存在**且**必须保留物理强制**的原因：
TS 被攻破（恶意插件 / XSS / 供应链投毒）时，Rust 口是最后防线。

### 分层对照

- **TS 策略**：规则层叠 / Ask 记忆 / mode——产品逻辑，高频演化，TS 热改。
- **Rust 能力口强制**：webview 无盘权，碰资源必经口；口内做「这调用是否真已获
  授权 + 物理路径 resolve + 审计」——即使 TS 被攻破也越不过。Claude Code/DSH 缺
  这一层（Node 宿主可信假设）；兰台 webview 不可信，故必须有。
- **物理沙箱兜底**：os_sandbox 进程文件效应（read-only/workspace-write）——能力口
  之上的纵深防御。

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
- confined_fs 字节执行 + **强制校验面**（fs 能力口：已授权调用的物理路径 resolve +
  执行——口是 webview 越不过的最后闸；「授权决策」在 TS 策略层，口做最小必要校验）。
- os_sandbox / sandbox（物理沙箱兜底，纵深防御）。
- credential 存储、audit 落盘（强制层审计）、workspace/session 应用壳、
  engine_transport（MCP client）、LSP 原生转发、llm_proxy/plugin_assets。

## 3. 终态调用链（双层闸：TS 策略建议 + Rust 能力口强制）

```
模型/UI 工具调用
  → TS 工具（schema zod + 编排，44 域插件）
  → TS 权限策略层（规则 allow/deny/ask + mode + Ask + 记忆——产品体验层）
  → Rust 能力口 RPC（强制层：校验该调用确已获授权 + resolve 物理路径 +
    审计落盘——webview 被攻破/插件恶意也越不过的物理最后闸）
  → （可选）物理沙箱兜底（os_sandbox read-only/workspace-write）
```

能力口面（极少数，与工具数无关）：fs（含 search/glob 变体）/ process（含 git/
shell spawn）/ credential / 会话句柄（browser/uia/pty/lsp）。**口内不判策略**
（allow/deny/ask 由 TS 定），但口是**强制执行面**：不信任 TS 层传来的「已授权」，
口自身对每个调用做最小必要校验（授权票据/agent 身份/路径安全）+ 审计——这是
「代码不可信」模型的落点，Claude Code/DSH 的 Node 直碰缺这一层。

## 4. 域归属终态

- 工具编排 + **权限策略（规则/mode/Ask/记忆）**：TS。
- **强制闸 + 能力实现**（字节/搜索/spawn/句柄操作 + 物理校验/审计）：Rust 能力口——
  口数量 = 能力族数，与工具名无关（search 是 fs 族变体，非每工具一口）。
- 物理沙箱：Rust/native（read-only/workspace-write 文件效应）。
- 引擎自有（graph/ops）：随引擎 serve 暴露，壳只 MCP client 转发。
- 原生引用（LSP）：起用户机器 language server + 转发，留 Rust（无编排业务）。
- 外部第三方：MCP server，进程外。

## 5. 执行序（批 = commit 界，门禁全绿）

| 批 | 内容 | 验收 |
|---|---|---|
| R1 | TS 权限策略层设计（规则/mode/Ask 落点——现 permissions.json + 前端 Ask 已是雏形，评估复用 vs 重写为 Claude Code 同构） | ✅ 已拍板 + 设计（kernel-permission-strategy-layer-r1.md）+ 代码落地（commit a185f096） |
| R2 | 薄域编排先回 TS（search/web/constraints/editor：schema zod + 编排迁域插件）+ 能力实现并入 Rust 能力口 | 🔶 R2-a/b 已落地（commit 789aef86：search 能力口 + 信封换直呼）；R2-d(1) schema zod 真源回 TS + R2-c builtin.search 退役已落地（fe91f016/d524f124，含 R2-a 键位回归修复）；**R2-d(2) 编排真回 TS（能力口收窄）余量**见 kernel-capability-r2-search-pilot.md §8 |
| R3 | fs/git/shell 编排回 TS；TS 策略闸接管权限；Rust dispatch 权限逻辑退役 | 权限回归专项 |
| R4 | browser/uia 句柄域编排回 TS + 句柄能力口 | 全门禁 |
| R5 | 拆 manifest 脚手架 + tool_call/PluginRegistry + Rust 权限裁决 | 全门禁 |
| 收口 | 全门禁 + 交接/决策落账 | — |

## 6. 待执行时定的点

- ~~TS 策略层复用现前端 Ask/permissions.json 生态 vs 重写为 Claude Code 分层规则
  （user/project/local/policy）~~ —— **已拍板（2026-09-04，R1）：选项 A = 复用现状 +
  收拢双份名单**。裁决与完整设计见 `kernel-permission-strategy-layer-r1.md`。
  简短理由：现状 Ask/remember/PromptShelf/模式链路已在产线形态（非雏形）；按
  AGENTS.md 默认「拆旧不造新」，四层堆叠/参数通配/八层 source 是 Claude Code 在
  Node 直碰模型下的表达需求，兰台强制层在 Rust 能力口，TS 策略层不必一步到齐。
- 物理沙箱形态（os_sandbox 现状够不够 read-only/workspace-write 两档承诺）——
  R2 起核。
