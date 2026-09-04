# 内核能力化 C-3/C-4 —— 工具编排回 TS 设计件

> 状态：**R3 执行蓝本（2026-09-04 拍板定稿）**。C 模型定稿（kernel-plugin-architecture-decision.md v3）。
> 决策史：本件初为「待用户审」设计稿；R2 试点（search 域）已落地独立能力口 search_cap + schema 回 zod
> （commit 789aef86/fe91f016/d524f124）。2026-09-04 用户拍板「主线 R2+R3 推进，R2-d(2) 并入 R3 统一做」。
> 本件即 R3 执行蓝本——D-A/D-B/D-C 按 R2 先例裁定，批序 = v3 执行序表 R3 行的分解，并把 R2-d(2)
> （search_cap 输出组装编排回 TS）并入统一能力口收窄批。

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

## 6. 批序（每批独立 commit 全门禁绿；= v3 执行序表 R3 行的分解）

> 裁决先记：D-A 独立能力口方法（search_cap 先例）；D-B 纯编排域随各自能力口
> 落地即退役（fs 域第一批）；D-C schema 真源回 TS zod（search R2-d 先例）——
> 但 R3 的 schema 回迁与 R5 脚手架拆除分工：**R3 只迁「能力口直呼域」的 schema
> 随 execute 换轨一起回 zod（fs 域为第一范式），git/shell 若换轨重可留 manifest
> 到 R5**。实际执行序（2026-09-04 定稿，域界 = 批界）：

| 批 | 内容 | 验收 |
|---|---|---|
| **R3-a** | fs 能力口 RPC 面建立：`fs_cap`（read/list/glob/write/delete/rename/create_dir/append + 补 confined_fs 缺的 dispatch 闸 cap 变体）；rpc.rs 分支 + rpc-contract 类型 + shape 表；platform_boundary 冻结清单更新 | ✅ **已落地（2026-09-04）**：confined_fs 增 read_text_cap/write_text_cap/list_tree_cap/delete_cap/rename_cap/glob_cap（口内 resolve_*_dispatch 闸）；commands/fs_cap.rs 单方法 action 分派（返回 Value）；rpc.rs fs_cap 分支 + JsonValue shape；platform_boundary 加 fs_cap（宪法依据注释）；rpc-contract fs_cap 类型；frontend-rpc-contract.md 重生成（47 methods）。cargo bin 437 passed + boundary 通过 |
| **R3-b** | TS fs 域换轨：createFsTools/fsExecute 从 provider seam（tool_call 信封）换 fs_cap 直呼（camel→snake 映射表 + UI 内部直呼 kernelFsCall 覆盖）；fs 域 schema 回 zod（R2-d 范式）；builtin.fs 退役（manifest/registry/镜像/生成器） | vitest/convergence 零漂移；kernelFsCall 消费方全绿 |
| **R3-c** | git 域同型：git_cap 能力口（run_git + 家族闸？评估）或 process_cap 先行；git 编排（porcelain 解析）回 TS；builtin.git 退役 | 全门禁 |
| **R3-d** | shell 域同型 + R2-d(2) 并入：process_cap（spawn 收敛）+ exec_command 编排回 TS（流式闭环处置）；search_cap 输出组装编排回 TS（统一命中集收窄） | 全门禁 |
| **R3-e（权限）** | TS 策略闸接管：六步裁决迁 TS 策略层（规则/mode/Ask 在 TS 判）；Rust dispatch 权限逻辑退役（PluginToolAdapter/has_permission_to_use_tool 的去留裁定）；同步路径（check_permission_sync/后台）旁路处置；audit/Ask oneshot/票据协议 | 权限回归专项全绿 |
| 收口 | tool_call/PluginRegistry 去留裁定；builtin.* 残余域退役或留 R4/R5；内核=能力口+闸+应用壳 | 全门禁 |

> R3-e 权限迁移是风险最高的批——六步裁决 + Ask 链路 + worktree 两跳映射都依赖
> Rust 现状；是否本批全迁 TS 或「TS 判 + Rust 口最小强制」双轨过渡，施工时按
> 回归测试结果定（v3 §1：口内最小必要校验不信任 TS 授权）。

## 7. 待拍板决策点（2026-09-04 按 R2 先例裁定）

- **D-A**：能力口 RPC 用独立方法（`search_cap`/`fs_cap.*`）vs 改造 tool_call 单入口内分派。
  **裁定：独立方法**（R2 search_cap 先例——tool_call 信封是 P0-2 脚手架，v3 拆除令要退役；
  能力口 = 极少数稳定面，独立 RPC 真源清晰、rpc-contract 类型化、与信封解耦）。
- **D-B**：builtin.* 模块退役时机。
  **裁定：随各自能力口落地即退役**（fs 域 R3-b 首批退役；git/shell 随 R3-c/d；
  句柄域 browser/uia/pty/lsp 留 R4）。
- **D-C**：编排回 TS 时 manifest 生成器/镜像去留。
  **裁定：schema 真源回 TS zod**（search R2-d 先例——逐字节转录零漂移已证）；
  R3 起 fs 域随 execute 换轨回 zod，镜像/生成器条目随 builtin.* 退役逐步删；
  全量脚手架拆除（manifest.rs/registry/生成器）收在 R5。
