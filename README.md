<p align="center">
  <img src="assets/banner.png" alt="兰台 Lantai" />
</p>

<p align="center">
  <strong>兰台（Lantai）— 一张纸上的 Agent 工作台</strong><br />
  界面不是聊天窗，而是一部正在被编纂的案卷：人在纸边批注、AI 居中撰文、机器贴底注记。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <a href="https://whyihaveyou.github.io/dsh-suite/"><img src="https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe" /></a>
  <a href="https://github.com/834063245-creator/Lantai/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/Lantai" /></a>
  <a href="https://github.com/834063245-creator/Lantai/actions"><img src="https://img.shields.io/github/actions/workflow/status/834063245-creator/Lantai/ci.yml" /></a>
</p>

---

## 定位

**兰台是桌面 Agent 工作台**，主界面是「纸壳 · 注疏案卷」——把「等权消息流」换成注疏层级：
人的问话是来文、AI 的答是正文、思考是夹注、工具是脚注、代码是抄录，全部落在一张会生长的纸上。
会话即案卷，多卷并行摊开，摊开的工作集重启即恢复。
工作台内部是完整的多 Agent 运行时：领域工具面、子 Agent 协作、Plan / Goal、记忆与技能、多厂商模型体系、
事件溯源会话与 token 治理——**这一切完全插件化**：面板 / 命令 / 工具 / 块渲染器 / prompt 段 / 管道钩子 /
capability 全部经插件通道贡献，出厂态零硬编码特权行。
配套的 **HoloGram 代码图谱引擎**是**独立进程**（Rust 单二进制）：把代码库静态解析成确定性依赖图，对外是
一个稳定的 MCP 工具面。它是随包配套件，不是应用内的主叙事——兰台默认不挂任何图工具，需要时按工作区启用
（见 [配套引擎 HoloGram](#配套引擎-hologram)）。

---

## 快速开始

### 桌面应用（推荐）

[Releases](https://github.com/834063245-creator/Lantai/releases) → 下载 Windows 安装包（MSI / NSIS）→ 启动 → 选工作区 → 打开案卷。
从源码：仓库根 `build.cmd`，或 `cd src-tauri && cargo tauri build`。

### 启用随包图谱引擎（可选，默认关）

安装包自带引擎（`bundle.resources`：exe + grammars + onnxruntime + 模型）：
**设置 → MCP → 「随包图谱引擎」→ 勾选 → 下次打开工作区生效**（引擎按该工作区根启动）。
**默认关是刻意的**：不启用则工具面零变化；懒启动 + 崩溃自愈重启 + 空闲回收，**离开工作区即停**。引擎数据落
工作区根的 `.hologram/`，与兰台自管的 `.lantai/` 分居；接别的实例见
[`docs/engine-as-external-mcp.md`](docs/engine-as-external-mcp.md)。

### 引擎 CLI（从源码构建）

```bash
cd engine && cargo build --release

hologram-engine run --list                          # 列出全部工具
hologram-engine run <工具> <项目根> [--key value]    # 一次性执行（结构化 JSON 出参）
hologram-engine serve --project-root <项目根>        # MCP stdio 服务
hologram-engine serve --project-root <项目根> --tcp  # 另开 TCP 数据面（供外部客户端）
```

工具清单以生成物 [`docs/agents/engine-plugin-contract.md`](docs/agents/engine-plugin-contract.md) 为准。

### 接入任意 MCP 客户端

引擎就是一个标准 stdio MCP server。**Claude Code** — `~/.claude/mcp.json`：

```json
{
  "mcpServers": {
    "hologram-myproject": {
      "command": "hologram-engine",
      "args": ["serve", "--project-root", "D:/work/myproject"]
    }
  }
}
```

Cursor 同理；多项目配多条 server，或用插件 manifest 的 `mcpServers` 声明式挂接。

### DeepSeek Harness 插件（`@a834063245/hologram-dsh`）

引擎与 MCP 图工具打包为 DSH bundle 插件（**薄发布适配层**，引擎二进制来自主仓构建产物），装完即进 agent
工具箱（`mcp__hologram__*`）：

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
```

安装与数据模型见 [`dsh-bundle/README.md`](dsh-bundle/README.md)。

> ⚠ **包内 3D 星图 viewer 的重建路径已断**：viewer 直接构建应用侧的 StarGraph 渲染内核，而该内核已随
> 「图谱内置接线全量退役」删除（2026-09-09，`src-ui/src/ui/graph*` 与 `src-ui/src/scene/` 均已不存在）。
> 以引擎 + MCP 工具面为准；viewer 需专门批次重做（未实跑 vite 构建复验）。

---

## 主界面：纸壳 · 注疏案卷

> 兰台＝汉代皇家档案典籍库。产品不是聊天窗，而是**一部正在被编纂的案卷**。

**注疏层级**：来文（人的问话，手迹位 + 朱砂深）· 正文（AI 的答，居中主角）· 夹注（思考）· 脚注（工具调用）·
抄录（代码与 diff）· 拟策（方案审批）· 贴黄（系统通知与回合错误）。块类型是**开放面**（内置 + Agent 资产
kind + 插件贡献），完整版式契约见 [`docs/design/lantai-design-spec.md`](docs/design/lantai-design-spec.md)。

**墨色与字体**：朱砂 = 人，石青 = 机，石墨 = 草稿，墨 = 正文；MiSans 单文件可变字体自托管（原宋 / 楷 /
等宽三体已退役，文类语义位保留）。视觉决定账本见
[`docs/plans/paper-shell/taste-ledger.md`](docs/plans/paper-shell/taste-ledger.md)。

**画布与多卷**：无限画布 + 纸条钉住 / 收回 + 小地图 + 拖拽落点分区；左缘书脊列管理多卷（恒显 / 卷首名
双击改名 / 合卷自动存）。流式渲染按**工作单元**成组（读 / 写 / 验证包），长回合是几个工作单元加换气，
而不是等距瀑布。

---

## 内置 Agent 工作台

**工具面**是**域工具面**：每个域工具内部是 `action` 判别联合（`fs(read|write|edit|…)`、
`shell(run|output|wait|kill)`、`git(status|diff|commit|…)`…），会话级另有 `Skill` / plan / 通信族 /
`code_execution` 执行原语（程序体在 Web Worker 沙箱里跑，可嵌套调用全部可见工具）。事实源是生成物
[`docs/agents/model-tool-contract.md`](docs/agents/model-tool-contract.md)，域计数等标量见
[`docs/facts.generated.md`](docs/facts.generated.md)。

**运行时内核**：工具行 / prompt 段 / capability 三类装配面全经插件通道贡献，**三层表序是字节契约**（禁重排）；
会话变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三个入口（`SessionLog` 支撑差分
对拍、回放与审计）；vendored cordis 承载资源生命周期；流式执行 tool_use 完成即 dispatch、同轮只读工具并发；
工具结果滚动折叠 + 成本驱动的 auto-compact（压缩只作用于发送载荷）。契约由 `npm run verify:convergence` 钉死。

**多 Agent**：子 Agent 池（`fork` / `fresh` 两种启动）+ 有界 inbox 通信层 + 按会话隔离的 TaskBoard /
DiscoveryBoard + **git worktree 隔离执行**。见 [`docs/MULTI_AGENT_ROADMAP.md`](docs/MULTI_AGENT_ROADMAP.md)。

**Plan / Goal**：Plan 模式只读探索 + 写计划文件，交用户审批后离开，写约束在执行层由 `planGate` 拦截；
Goal 模式持久化目标状态、跨会话恢复。

**记忆与 Provider**：事件溯源会话记忆 · 项目记忆（`.lantai/memory/*.md`）· Memory Bundle · 技能
（`.lantai/skills/<name>/SKILL.md` 热加载）；模型侧多家厂商 + 运行时动态模型清单 + 本地反向代理 +
系统级加密凭据。见 [`docs/design/provider-system-spec.md`](docs/design/provider-system-spec.md)。

---

## 插件系统

出厂态零硬编码特权行；**全部贡献行（含第一方）都可被 roster patch / preset 禁用、覆盖、锚定**。贡献面覆盖
工具 / prompt 段 / capability / 管道钩子 / 块渲染器 / 面板 / 命令 / overlay / llm 等（**通道与服务清单以
生成物 [`docs/agents/service-catalog.md`](docs/agents/service-catalog.md) 为准**），另有
`manifest.mcpServers`（外部 MCP server 桥接）与 `manifest.activation`（声明式惰性激活：登记 ≠ 激活，
按引用计数）。

- **最短路径**：一个 `manifest.json` + 一个自包含 ESM 模块（webview 动态 import 装载，无包管理器、无
  import map）。最小示例 [`examples/plugins/hello/`](examples/plugins/hello/README.md)。
- **权限三层**：manifest 声明 → `plugins.json` 授予门禁（装载期一票否决）→ Rust 命令咽喉逐调用强制。
  **信任模型（如实声明）**：插件是本机全信任代码——不做签名、不做沙箱。
- **完整契约**：[`docs/plugins/README.md`](docs/plugins/README.md)；用户向指南 [`PLUGINS.md`](PLUGINS.md)；
  组合层与 preset 见 [`docs/composition/README.md`](docs/composition/README.md)。

---

## Harness Engineering

**权限引擎**：规则分层合并（系统 / 项目 / 会话），裁决四态 `Allow` / `Deny` / `Ask` / `Passthrough`（`Passthrough` = 本层不裁、真权在能力口内的业务自检与路径级授权；危险动作走红卡），
模式 Ask（默认）/ Auto（白名单常规编辑自动批准）/ Yolo（全部自动批准，不旁路 Deny）。**危险命令引擎**维护
危险模式表（`rm -rf /`、`curl | sh`、`eval` / `source`、`sudo`、`git push -f main` 等）并对 PowerShell 特判；
路径规则对 worktree 自动反映射回主仓库逻辑路径。**沙箱三层**：OS 层（Windows Job Object / Linux bubblewrap /
macOS sandbox-exec，shell 默认走捆绑 bash）· 路径层（边界外升级为 Ask）· I/O 层（读写上限、超时、瞬态重试、
原子写）。**审计**：全部工具调用落 `.lantai/audit.jsonl`。

---

## 配套引擎 HoloGram

### 它与兰台的关系

引擎是**独立进程**（**默认不启用**，开关在 设置 → MCP）。壳只做**二进制位置的只读探测**
（`engine_assets.rs` + `engine_bundled_info` RPC，可用环境变量 `LANTAI_ENGINE_EXE` 覆盖），**不 spawn、
不链接任何引擎 crate**；启用后由前端经既有的 **MCP 受治进程通道**拉起（`plugins/bundled-engine.ts` →
`mcp-bridge.ts` 的 ServerGovernor：生命周期 / 崩溃退避重启 / 空闲回收 / 进程树终止 → Rust
`protocol_bridge.rs` stdio）→ `hologram-engine serve --project-root <工作区根>`。**一进程一根**（同根幂等、
异根拒绝），**离开工作区即停**；引擎数据落工作区根的 `.hologram/`，与兰台自管的 `.lantai/` 分居。手动接法
（用户级 `mcp.json`、插件 `mcpServers`）见 [`docs/engine-as-external-mcp.md`](docs/engine-as-external-mcp.md)。

### 引擎做什么

把代码库静态解析成依赖图（节点 = 符号 / 函数 / 类 / 模块…，边 = 调用 / 继承 / 读写 / 时序…），让
「改 A 会炸什么」变成**确定性的图查询**，而不是让模型逐文件读源码去猜：tree-sitter 语法静态链接 + 运行时
动态加载（`.dll` / `.so`）；按需拉起原生 LSP + SCIP 索引导入；并行分批解析 → 跨文件引用解析 → 耦合 / 循环 /
脆弱模块 / 架构盲点 → 执行流与语法级数据流 → 社区检测 → 落库（内存 CSR + SQLite / FTS5 + 语义向量）；
watcher 增量合图、失败回退全量。**诚实标记**：eval / 动态代码标为不可达、动态 import 标为动态站点。细节见
[`ARCHITECTURE.md`](ARCHITECTURE.md) 的引擎章节与
[`docs/agents/engine-plugin-contract.md`](docs/agents/engine-plugin-contract.md)。

### 免编译扩展面

**不改 Rust 也能扩展**：在扩展目录（环境变量 `HOLOGRAM_PLUGIN_DIR`，缺省 `<项目根>/plugins`）放 manifest
即可声明新语言（扩展名表 + 查询式）、新框架（路由候选模式）、新工具（schema + 复用既有 handler）；装载
情况经 `engine_status.extensions` 可见，单个 manifest 失败不阻断启动。见
[`examples/engine-plugins/`](examples/engine-plugins/README.md)。

---

## 架构

```
src-ui/    (TypeScript)  React 19 · 注疏案卷纸壳 · Agent 运行时 · 组合层 · Provider 体系
src-tauri/ (Rust)        Tauri 2 壳 · 权限引擎 · 沙箱 · worktree 隔离 · 审计 · 凭证 · MCP 受治进程
engine/    (Rust)        独立二进制：解析 → 图构建 → 分析 → 存储 → stdio MCP / CLI / TCP
```

前端与壳走单一契约的 typed RPC（见生成物
[`docs/agents/frontend-rpc-contract.md`](docs/agents/frontend-rpc-contract.md)）；壳与引擎**无进程内依赖**。
分层、技术栈与关键设计决策见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；四条最高架构约定见
[`docs/adr/project-constitution.md`](docs/adr/project-constitution.md)。

---

## 工程事实

- **数字只有一个真源**：[`docs/facts.generated.md`](docs/facts.generated.md)；另有
  `cd src-ui && npm run doc-check` 六查兜底。**自举**：兰台可用配套引擎分析自身代码库。
- 规则与雷区 [`CONVENTIONS.md`](CONVENTIONS.md) · [`INVARIANTS.md`](INVARIANTS.md)；现状与计划
  [`docs/plans/README.md`](docs/plans/README.md)；技术债 [`docs/landmine-map.md`](docs/landmine-map.md)；
  词汇 [`CONTEXT.md`](CONTEXT.md)；总索引 [`docs/README.md`](docs/README.md)（`docs/archive/` 是历史）。

---

## 从源码构建

```bash
# 引擎（独立二进制；Linux / Windows 均可）
cd engine && cargo build --release

# 桌面应用（Windows；会先跑前端构建）
cd src-tauri && cargo tauri build     # 或仓库根 build.cmd

# DSH 插件包（本地开发用，细节见 dsh-bundle/README.md）
cd dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build && npm run build:client
```

## 开发

```bash
cd engine && cargo test        # 引擎用例
cd src-tauri && cargo test     # 壳用例（权限 / 生命周期 / 隔离）
cd src-ui && npx vitest run    # 前端用例
cd src-ui && npm run build     # tsc --noEmit + vite build
cd src-ui && npm run verify:convergence   # Agent 运行时契约门禁（T0 + baseline 双轨）
cd src-ui && npm run doc-check            # 文档面门禁（六查）
```

实测基线与运行纪律（含本机 `NODE_ENV` / `cargo` 假挂等实测坑）见 [`CONVENTIONS.md`](CONVENTIONS.md) §3
——**数字会漂移，以重新实测为准**。

**写插件**：契约 [`docs/plugins/README.md`](docs/plugins/README.md)，最小示例
[`examples/plugins/hello/`](examples/plugins/hello/README.md)。开工纪律见 [`CLAUDE.md`](CLAUDE.md)
（唯一权威规则文件）与 [`AGENTS.md`](AGENTS.md)；提交流程 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 许可

兰台（Lantai）© 2026 Wenbing Jing — [MIT](LICENSE)。第三方组件版权声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；安全策略见 [SECURITY.md](SECURITY.md)。
