# 内核拆壳 —— 工具原语进程外化（kernel-plugin-runtime 方向拨正）

> 状态：**施工中**（2026-09-04 定方向，首刀落地）。
> 起因与定论：用户 2026-09-03 拍板「内核保留安全能力和插件运行时，而不是工具
> 业务」。Phase 0-2 把工具业务从 rpc.rs 迁进 11 个 Rust 模块，**仍在 exe 内编译焊死**——
> 用户指出这是「内部重新分了文件夹，工具一条没离开内核」，插件化徒有虚名。
> 2026-09-04 用户最终定论：**工具实现必须物理离开 exe，否则插件化是空话**；
> fs/git 原语也做成外部进程，exe 只留极薄调度壳 + 安全能力。干就干彻底，拆完不行再说。

## 0. 一句话

**Rust exe 从「工具包」瘦成「安全能力 + 原语分派 + 极薄调度壳」；工具字节执行全部
外置到受信后端进程（primitives-server），工具域（schema/编排/策略）回到 TS 成为真插件。**

## 1. 安全模型（用户 2026-09-04 拍板：裁决留 exe，执行外置）

| 层 | 归属 | 内容 |
|---|---|---|
| 权限裁决 | **exe（不可外置）** | agent worktree 映射 + 规则 + Ask + 审计——安全面，不能交给可能被攻破的进程 |
| 字节执行 | **受信后端进程** | 只做已授权物理路径上的 I/O（read/write/list/rm/mkdir/mv/glob）；无裁决权，只信 exe 给的路径 |
| 工具编排/策略 | **TS 插件** | schema/参数/组合——真正可装卸的单元 |

威胁边界：webview 渲染器被攻破 → 无法触达后端进程（仅 exe spawn 的 stdin 可达）；
且每个动作先经 exe 裁决。后端进程不是独立信任边界，是 exe 的受信执行臂。

## 2. 现状执行体（拆前核实）

| 执行体 | 形态 | 通道 | 工具面 |
|---|---|---|---|
| 内置工具 11 个 | Rust 编译期 tool_plugins/builtin.* | tool_call 信封 | manifest 静态 + TS 镜像 |
| 图谱引擎 | 独立进程 hologram-engine.exe serve（每工作区一个，stdio MCP） | hologram_call → McpRemoteTransport | 运行时动态 tools/list |
| 外部能力 | 任意进程（MCP server 等） | TS MCP 机器桥 / protocol_bridge | TS 侧声明 |

「两套插件系统」观感来源：TS cordis 贡献行（44 个 hologram/*，fs/git/shell 只是
re-export）+ Rust builtin.*（执行真源但零 UI）；引擎走独立通道。根子在工具业务
仍在 exe。

## 3. 拆法（批序 = 从易到难）

| 批 | 内容 | 验收 |
|---|---|---|
| **D0（本刀）** | `primitives-server` crate：受信后端进程骨架（stdio JSON-RPC：fs 字节执行 read/write/delete/mkdir/rename/move/list/glob/format_lines/preview 自 confined_fs/utils 搬出，剥掉 resolve_* 裁决层）+ workspace 注册 | cargo test 后端 6 用例全绿 |
| D1 | 壳侧 client：spawn 管理 + stdio JSON-RPC（引擎 transport 骨架）+ ready/initialize/ping + 裁决后转发 | 后端进程 e2e（模拟裁决后调用） |
| D2 | 接 tool_call dispatch：fs 域工具改走 client 转发（裁决仍 exe），confined_fs 字节层退役 | fs 域工具经后端进程全量回归 |
| D3 | git 域：run_git spawn 收敛为 process 原语走后端（裁决留 exe） | git 域全量回归 |
| D4 | shell/browser/uia/pty/lsp 逐域评估：可外置的字节/句柄操作进后端；策略回 TS | 逐域全量回归 |
| 收口 | 内核瘦到「原语 client + 权限 + 应用壳」；tool_plugins 工具域模块退役 | rpc 分支收敛；全门禁 |

## 4. 逐域裁决注记（D2 起逐批补）

- fs 字节执行可整体外置（confined_fs *_resolved / write_atomic / list_dir_* 已与
  裁决分离）；rename/move 的 read+write 双检查留在 exe（双路径语义）。
- 引擎工具面是运行时动态 schema——与静态 manifest 张力，独立评估，不在本刀范围。
- browser/uia/pty/lsp 持会话/句柄，属内核资源，外置形态逐域定（句柄不可移出 exe
  的域，策略回 TS + 操作原语化）。

## 5. 施工史

- **D0 已落地**：primitives-server crate（lib + fs_ops + protocol + main），
  confined_fs/utils 字节层搬出、剥裁决，错误文案/guards 原样；6 协议用例全绿。
