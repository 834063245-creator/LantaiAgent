# 内核能力化 C-3/C-4 —— 工具编排回 TS 设计件

> 状态：**设计件（待用户审）**。前提：C 模型定稿（kernel-plugin-architecture-decision.md）。
> 本文设计「编排从 builtin.* Rust 模块回迁 TS 域插件」的完整形态，审过再动代码。

## 0. 目标形态（C 模型收敛后）

```
模型/UI 工具调用
   │  TS 域插件（44 hologram/*）：schema + 编排 + 解析（工具业务的家）
   ▼
能力口 RPC（极少数，≈5 类，过闸在口内）
   │  fs.read/write/list…  process.run  credential  ask/audit
   ▼
内核（裁决 resolve_*_dispatch + 字节/spawn 执行）
```

- 工具数（fs 13/git 16/…）**不产生**内核接口数；内核接口 ≈ 能力数。
- 闸门 = 现成 `resolve_read/write_dispatch`（Agent→require_* 过闸+Ask；UI→只解析）
  ——C-2 已核实这是能力口闸门的现成实现，无需新建权限引擎。

## 1. 现状（C-2 后核实）

- **Rust**：fs 字节执行已收敛 confined_fs（裁决+字节一体，能力口实现就绪）；
  builtin.fs/git/shell/browser/uia/pty/lsp 模块仍持**编排**（porcelain 解析、参数
  组合、句柄编排），经 dispatch 的 PluginToolAdapter 过闸后 execute。
- **TS**：createFsTools 等域工厂 = manifest 驱动（schema 字节来自 kernel-manifests
  mirror），execute → fsExecute → provider（builtin/rust-fs）→ **tool_call 信封** →
  builtin.* 模块。44 域插件是「manifest 转发壳」。
- **能力口闸门现成**：resolve_read_dispatch / resolve_write_dispatch（Agent 过
  require_* Ask + 规则，UI 只解析）——fs 能力口 = 它 + confined_fs 字节执行，已闭环。
- **句柄域**：browser/uia/pty/lsp 持 CDP/COM/PTY/LSP 会话句柄（进程内注册表），
  不能进 webview；编排可回 TS，句柄操作收敛为 exe 能力口。

## 2. 能力口 RPC 面设计（Rust 新增，收敛面）

| 能力口 | RPC（新增到 rpc.rs，或 tool_call 语义改造） | 闸门（口内） | 现状字节/执行实现 |
|---|---|---|---|
| fs.read | `fs_cap.read {path, offset?, limit?, raw?}` | resolve_read_dispatch | confined_fs::read_text/bytes |
| fs.write | `fs_cap.write {path, content}` | resolve_write_dispatch | confined_fs::write_text |
| fs.list | `fs_cap.list {path, recursive, filterIgnored}` | resolve_read_dispatch | confined_fs::list_dir_* |
| fs.delete | `fs_cap.delete {path}` | resolve_write_dispatch | confined_fs::delete |
| fs.move/rename | `fs_cap.rename {from,to}` | read+write 双检查 | confined_fs::rename |
| process.run | `process.run {command, cwd?, bg?}` | BashTool/git 家族 | utils::run_git/shell 执行体 |
| credential/ask/audit | 已存在 | — | — |

**关键裁决：能力口 RPC 取代 tool_call 对 builtin.* 的分派，还是并存？**
- 并存（推荐过渡）：tool_call 保留（浏览器/uia 等复杂编排暂留），fs/git/shell
  纯编排域先换能力口直呼——验证模型后全量并轨。
- 收敛终态：tool_call → 能力口（一个通用入口内按 capability 分派），PluginRegistry/
  manifest 体系退役或仅作 schema 源。

## 3. TS 侧改造（44 域插件）

- fs/git/shell 域插件从「manifest 转发壳 + fsExecute/provider/tool_call」改为：
  `createFsTools` 等定义 schema（仍 manifest 字节，收敛纪律不变），execute 直接
  `typedRpc('fs_cap.read', {path, ...})` 过能力口闸。provider seam（D11 开放面）
  保留——替代 provider（JS 内存/MCP）仍可实现同一 FsProvider 接口；默认
  builtin/rust-fs 的 execute 从 tool_call 换 fs_cap.*。
- schema 真源不变（manifest 镜像），convergence 零漂移可保（工具面字节不动，只改
  execute 内部）。
- 编排逻辑（git porcelain 解析、shell env 处理等）从 Rust 模块迁回 TS 域插件的
  execute 内（或独立 util）。这是「业务离开 exe」的核心动作。

## 4. 权限矩阵迁移（关键风险）

现状：工具级（plugin:builtin.fs.read_file + family 回退 "Read" 家族规则）。
目标：能力级（fs.read 路径检查）。用户 rules/permissions.json 多为家族/路径级
（"Edit" deny 等），天然兼容能力级（family == 能力类）。需核对：
- 精确到单工具的规则（plugin:builtin.git.git_commit deny）在能力级下的语义——
  git 走 process.run 后无法区分 git 子命令，需在 process 口保留 subcommand 位
  （GitTool 两段检查：仓库路径 + git::check(subcommand)）。
- auto 白名单（EditTool 家族）——能力级 fs.write 过 EditTool 继续生效。

## 5. 句柄域边界（browser/uia/pty/lsp）

- 编排回 TS：TS 工具拼参数、解析结果。
- 句柄操作 = exe 能力口（browser.* / uia.* / pty.* / lsp.* 操作 RPC，持注册表句柄，
  过各自运行时闸——BrowserTool/DesktopTool 多层语义 + lease/grant）。**这些不是
  「每工具一接口」，是「每会话类型一能力口 + 参数化操作」**——需设计会话类型粒度
  的收敛接口（如 browser.act {session, action, params}）。
- 单独设计件（D4），不在 C-3 范围。

## 6. 批序（每批独立 commit 全门禁绿）

| 批 | 内容 | 验收 |
|---|---|---|
| C-3a | rpc.rs 加 fs_cap.read/write/list/delete/rename 能力口（复用 resolve_*_dispatch + confined_fs）；rpc-contract + 生成物同步 | cargo 全绿；能力口单元过闸测试 |
| C-3b | TS fs 域插件 execute 从 tool_call 换 fs_cap.*（provider 表换源）；git/shell 同批评估 | vitest/convergence 零漂移（工具面字节不动） |
| C-3c | 编排回迁：git porcelain 解析等从 builtin.git 迁 TS；builtin.fs/git 模块瘦身为能力口转发或退役 | 全门禁 |
| C-3d | process.run 能力口（shell/git spawn 收敛） | 全门禁 |
| C-4 | 句柄域（browser/uia/pty/lsp）能力口设计 + 编排回 TS | 独立设计件 |
| 收口 | tool_call/PluginRegistry 去留裁定；tool_plugins 工具域退役；内核=能力口+闸+应用壳 | 全门禁 |

## 7. 待拍板决策点

- **D-A**：能力口 RPC 用独立 `fs_cap.*` 方法 vs 改造 tool_call 单入口内按 capability 分派。
- **D-B**：builtin.* 模块退役时机——C-3c 即退役纯编排域（fs/git/shell），还是留到全量
  并轨。
- **D-C**：编排回 TS 时，manifest 生成器/收敛镜像是否保留（schema 仍是 manifest 字节）
  还是 schema 回 TS zod（推翻 P0-2 的单一真源在 manifest）。
