# 内核能力化（C 模型）—— 工具业务外置的终态定稿

> 状态：**定稿（2026-09-04 用户拍板）**。前身：kernel-plugin-architecture-decision.md
> （拆壳 D0-D2 方向记录）。用户三轮追问收敛出本模型：
>   「内核这边要给每个工具准备接口？」→ 否；
>   「有没有可能提供一个通用接口，不管注册什么工具，工具调用经过内核闸门就好？」→ 是。
> 本页 = C 模型定稿 + D0-D2 处置。代码按此执行。

## 0. 一句话

**内核 = 极少数受信能力口（碰盘/起进程/发请求/凭据/UI，≈5 类），每个口内嵌权限闸
（认「能力 + 目标」，不认工具名）；工具代码（schema/编排/解析）全部在 TS/进程外，
经能力口碰资源。接口数 ≈ 能力数，不随工具数增长。**

## 1. 为什么 C 是终点（对比走过的弯路）

| 形态 | 问题 |
|---|---|
| Phase 0-2：工具实现 = 编译期内置 Rust 模块 | 工具业务仍在 exe，「插件化」徒有虚名（用户定论） |
| D0-D2：字节执行搬 primitives-server，每工具一后端接口 | 内核从「巨型工具包」变「巨型接口面」，仍臃肿；用户质疑「给每个工具准备接口？」 |
| **C：极少数能力口，工具代码回 TS** | 内核瘦到能力 + 闸门；工具 = 可装卸的 TS 编排；接口数 ≈ 能力数 |

## 2. 内核保留物（能力口 + 闸门 + 应用壳）

| 能力口 | 通用接口（少数） | 闸门（内嵌，认能力+目标） |
|---|---|---|
| 盘 fs | fs.read / fs.write / fs.list / fs.delete / fs.move（5±） | ReadTool/EditTool 路径检查 + worktree 映射 + 规则 + Ask |
| 进程 process | process.run（起命令收输出）/ process.kill / 后台任务（3±） | BashTool 命令检查 + 规则 |
| git | （= process.run 的特例？或保留 git 口） | GitTool 仓库路径 + 子命令规则 |
| 引擎/图谱 | hologram_call（已进程外） | 工具级无门（只读/分析）；write 动作另有 |
| 凭据/权限/审计 | credential_* / permission_* / audit 查询 | —（本身就是内核） |
| webview/UI | Ask / 事件 | — |

**工具代码（不在内核）**：fs 13 工具 / git 16 / shell 7 / browser 37 / uia 17 —— 的
schema、参数组合、porcelain 解析、glob 策略、编排逻辑，全部回 TS 域插件。
每个工具 = manifest（schema）+ TS 实现（编排 + 调能力口）。**工具数不产生内核接口数。**

## 3. 闸门语义（用户拍板：能力+目标粒度）

- 能力口内构造对应 Tool（ReadTool/EditTool/BashTool/GitTool——**已存在**）过闸；
  闸认 path/command + 家族规则 + 用户 rules/permissions.json，**不认谁调的**。
- TS 工具 = 纯编排：`read_file_content`（TS）编排 → 调 `fs.read {path}` → 能力口过
  Read 闸（worktree 映射 + 路径规则 + Ask）→ 执行。
- 现状 PluginToolAdapter（每工具一个、认 plugin.tool）退役或降级为能力口内构造的
  Tool。auto 白名单（"Edit"）、Ask 文案、审计全在能力口。

## 4. 权限系统兼容性（已核实）

现有 `permissions::Tool` trait 的裁决本来就是**路径/命令级**（filesystem::check_read/
write、bash::check、git::check + get_path）——name() 只是规则寻址第一级 + 审计名。
**C 模型不需要推翻权限系统**，只需把「按工具构造 adapter」改为「按能力口构造 Tool」。
用户 rules（"Edit" deny 等家族规则）天然兼容（family 即能力类）。worktree 映射、
Ask、审计全保留在能力口（exe）。

## 5. TS 侧形态

- 现有 TS 域插件（44 个 hologram/*，fs/git/shell 域本是 re-export）从「转发到
  tool_call 信封」改为「TS 实现编排 + 调能力口 RPC」。createFsTools 等恢复真业务
  （不再只是 manifest 转发壳）。
- 但 webview 无盘权/进程权 —— TS 调能力口 = 调内核 RPC（fs.read 等），这些 RPC
  就是能力口，带闸。**没有「绕过闸直接碰盘」的通道。**

## 6. D0-D2 处置

- primitives-server（D0-D2 建的每工具接口后端）与 C 模型**方向不符**：C 下字节执行
  回 TS 经能力口，不需要第二个进程做每工具接口。**处置：primitive-server 退役**，
  其 fs_ops 字节层不删（它是「能力口 fs 的实现候选」——能力口 fs.read 可直接调用
  这些已剥离裁决的字节函数，只是不需要子进程包装）。
- 即：能力口 = exe 内函数（裁决 + 字节执行一体，回 D2 前的 confined_fs 形态但
  收敛为 5 个通用函数），TS 经 RPC 调它。**不需要 process 外置**——webview 不能
  碰盘，但 exe 可以，TS 工具经 exe 能力口碰盘即可，不必再经第二个进程。
- shell/git 同理：TS 编排 + 调 process.run（exe 内能力口，spawn 子进程 + Bash/Git
  闸）。

## 7. 执行批序（每批独立 commit 全门禁绿）

| 批 | 内容 | 验收 |
|---|---|---|
| C-1 | 定稿本件（docs 落账） | — |
| C-2 | 退役 primitives-server（删 crate + workspace 成员 + client）| cargo 全绿 |
| C-3 | confined_fs 收敛为能力口形态（fs.read/write/list/delete/move 5 函数，裁决+字节一体在 exe）| 壳测试全绿 |
| C-4 | TS fs 域插件恢复真编排：createFsTools 直接调能力口 RPC（过闸），弃 manifest 转发壳 | vitest 全绿 + 行为一致 |
| C-5 | git/shell 域编排回 TS，走 process 能力口 | 逐域全绿 |
| C-6 | 收口：tool_plugins 工具域模块退役；内核 = 能力口 + 闸 + 应用壳；rpc 分支收敛 | 全门禁 |

## 8. 待执行时再定的点

- git 是否独立能力口 vs process.run 特例（gate 语义差异：GitTool 两段 vs BashTool）。
- browser/uia/pty/lsp（持会话句柄）外置形态——句柄留 exe，编排回 TS + 操作能力口。
- 引擎 graph 域：已是进程外 + 动态 schema，维持 hologram_call 通道或并能力口。
