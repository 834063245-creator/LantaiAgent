# 内核能力化 C-3/C-4 —— 工具编排回 TS 设计件

> 状态：**R3 执行蓝本（2026-09-04 拍板定稿；2026-09-05 fs + git + shell 三域收口竣工后刷新）**。C 模型定稿（kernel-plugin-architecture-decision.md v3）。
> 决策史：本件初为「待用户审」设计稿；R2 试点（search 域）已落地独立能力口 search_cap + schema 回 zod
> （commit 789aef86/fe91f016/d524f124）。2026-09-04 用户拍板「主线 R2+R3 推进，R2-d(2) 并入 R3 统一做」。
> 本件即 R3 执行蓝本——D-A/D-B/D-C 按 R2 先例裁定，批序 = v3 执行序表 R3 行的分解，并把 R2-d(2)
> （search_cap 输出组装编排回 TS）并入统一能力口收窄批。
>
> **2026-09-05 fs 域收口竣工（agent 执行批，a681adc7/8bce6ffb/cd15fdcb/a107e4e2）**：
> R3-b 的「范围注记」（UI helper 保留 builtin.fs 信封、插件不退役）**已推翻兑现**——
> fs 域全链路闭环：UI 内部 helper（kernelReadFile/kernelWriteFile/kernelCreateDirectory/
> kernelDeleteFile/kernelListDirectory/kernelLogAppend/kernelGlobalMemoryDir/
> kernelReadMemoryBatch/kernelReadFileBase64）全量换 fs_cap 能力口直呼；builtin.fs 插件
> 整目录退役（Rust 注册/镜像/schema 镜像全清）；fs 8 模型族 schema zod 转录回 TS
> （coding.ts FS_CAP_SCHEMA，收敛零漂移）；测试层 18 文件 mock 站 rpc-contract 具名
> helper。**R3 批表 fs 行（含 UI/内部消费）由此全数兑现**，C-3 §6 批表仅余 git/shell/
> 权限三行 + 收口。
>
> **2026-09-05 git 域收口竣工（agent 执行批，f3add174/c5acb876/8b006be2）**：
> git 域全链路闭环（§8 形态定稿逐条兑现）：git_cap 能力口（批 1——commands/git_cap.rs
> 单方法 action 分派 + 口内 PluginToolAdapter 闸：只读五动作 Read 家族 / 写动作 Git
> 家族两段闸 subcommand 位；精确名寻址保留 plugin:builtin.git.<action>，用户既有规则
> 不失义；执行体 git_exec_path + run_git）；模型族 gitCapTool zod 转录 + git_cap 直呼
> （批 2——coding.ts GIT_CAP_SCHEMA，diff 双路由/stage 拆单保留在工具层）+ 内部消费
> kernelGitCall 换轨（state-inject 用户路径 is_agent=false）；porcelain 三处解析
> （status 头 / parse_status / log \x00 split）迁 src-ui/src/agent/git-porcelain.ts；
> builtin.git 整目录退役（Rust 注册/镜像/gen-kernel-manifest git DOMAIN 全清）；
> convergence 双档零漂移。附带修复 frontend-rpc-contract 生成器 SECTIONS 存量错位
> （R3-a fs_cap 箱线组加入后未同步——identity 错挂「插件安装通道」、dataflow 三方法
> 被分区溢出整行丢弃）。
>
> **2026-09-05 shell 域收口竣工（agent 执行批，5edb9c28/86d0d659/bd9b9712）+ R2-d(2) 并入竣工（5e563923）**：
> shell 域全链路闭环（§8 形态定稿 + §9 粘性 cwd 裁定逐条兑现）：process_cap 能力口
> （批 1——commands/process_cap.rs 7 action 分派；口内 fg/bg 双检查不对称直用 BashTool：
> fg = require_command 可 Ask + resolve_read_dispatch / bg = require_command_sync +
> require_read_sync 免 Ask——shell 无 manifest permission 声明 = 无工具级规则寻址，
> 与 git_cap 构造 adapter 的区别；事件形状零改：shell:output/shell:done 双事件 +
> started 回 {streamId, job_id, resolvedCwd}；bg 三工具留口内 BG_JOBS ledger；
> platform_boundary 冻结清单 + 宪法注释 + action 表单测）。批 2——粘性 cwd 归 TS
> （§9：session-context OwnerContext + stickyCwd per-owner 注册（agent 拆卸重置 =
> 切工作区即重置，取代 Rust generation 换代 fence）+ agent/sticky-cwd.ts
> CwdMarkerFilter 跨块截流 + queued-shell 截流提交 + coding.ts withStickyCwd 注入候选
> （产物自包含的 provider 不持宿主 session-context 实例）；Rust 口只收 cwd 显式 +
> sticky_cwd 候选（盘上不存在即跳过自愈——存在性检查属物理层）+ capture_cwd 方言包装
> （marker 字节原样流经，TS 截流/提交）；sticky_cwd.rs 整文件拆除（wrap 方言函数随
> 业务迁 process_cap.rs）；builtin.shell 整目录退役（Rust 注册/镜像/gen-kernel-manifest
> shell DOMAIN 全清）+ 模型族 shellCapTool zod 转录（SHELL_CAP_SCHEMA 4 工具）+
> 内部消费换轨（runtime shell_env / workspace + default-loop drain_bg_notifications 经
> kernelProcessCall）+ 开放面契约 v12（default-loop 在契约文件清单内）。批 3——
> kernel-envelope shell 7 死表项清。R2-d(2) 并入（批 4，见 r2-search-pilot §8）。
> **C-3 §6 批表 fs/git/shell 三行全数兑现；余 R3-e 残余（裁定不迁，见 §9）+ 收口行**。

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
| **R3-b** | TS fs 域换轨：模型族 execute 从 provider seam（tool_call 信封）换 fs_cap 直呼（builtinFsProvider 换轨 + read 形状解包/line_numbers 反相 + camel→snake 映射）；fs_cap 承接 write/delete/rename 副作用（timeline/changed_files 从 fs 插件迁入）；git/shell 同批评估 | ✅ **已落地（2026-09-04，模型族换轨；2026-09-05 fs 域收口全闭环）**：builtinFsProvider.execute 换 fs_cap（8 动作 read/list/glob/write/delete/mkdir/move/rename；edit/constraints 留信封）；fs_cap.rs write/delete/rename 补 record_fs_side_effect（ignored 路径跳过，与插件原语义一致）；read 形状层（fs_cap {path,content} → content 解包 + raw→line_numbers 反相——旧 read 默认行号）；6 个测试文件更新（fs-seam/define-tool/parallel-subagent/coding-domain/tool-param/ab-tools）。**范围注记已兑现（2026-09-05）**：UI helper 全量换 fs_cap、builtin.fs 退役——见状态头。vitest 2441 + convergence 零漂移 + biome 0/0 |
| **R3-c** | git 域同型：git_cap 能力口（run_git + 家族闸）；git 编排（porcelain 解析）回 TS；builtin.git 退役 | ✅ **已落地（2026-09-05，f3add174/c5acb876/8b006be2）**：git_cap 单方法 action 分派（16 工具名一位；口内 PluginToolAdapter 闸——只读五动作 Read 家族 / 写动作 Git 家族两段闸 subcommand 位，精确名寻址保留 plugin:builtin.git.<action>）；模型族 13 工具 zod 转录 + 直呼（diff 双路由/stage 拆单留工具层）；内部消费 kernelGitCall 换轨（is_agent=false 用户路径）；porcelain 三处解析迁 git-porcelain.ts；builtin.git 整目录退役 + 镜像/生成器条目清；vitest 2442 + convergence 双档零漂移 + biome 0/0 + doc-sync 全绿。附带修复 frontend-rpc-contract 生成器 SECTIONS 存量错位（dataflow 三方法此前被溢出丢弃） |
| **R3-d** | shell 域同型 + R2-d(2) 并入：process_cap（spawn 收敛）+ exec_command 编排回 TS（流式闭环处置）；search_cap 输出组装编排回 TS（统一命中集收窄） | ✅ **已落地（2026-09-05，5edb9c28/86d0d659/bd9b9712 + R2-d(2) 5e563923）**：process_cap 单方法 7 action 分派（口内 fg/bg 双检查不对称直用 BashTool；事件形状零改；粘性 cwd 归 TS——§9 裁定全兑现，见状态头）；builtin.shell 整目录退役 + sticky_cwd.rs 拆除 + 模型族 shellCapTool zod 转录 + 内部消费换轨 kernelProcessCall + 开放面契约 v12；R2-d(2)：search_cap 收窄纯扫描（统一原始命中集 + max_matches/max_files/collect_lines 收窄键），三形态组装/分页/行号显示回 search-assembly.ts。cargo 448/428 + vitest 2468 + convergence 双档零漂移 + biome 0/0 + doc-sync 全绿 |
| **R3-e（权限）** | ~~TS 策略闸接管六步裁决~~ **不迁（agent 裁定 2026-09-05，见 §9）**：六步裁决留 Rust 强制层；R1 已收拢的双份名单（auto 白名单/系统规则数据面归 TS）是策略数据面，与裁决执行序解耦——R3-e 收口 = 维持「Rust 口最小强制 + TS 策略建议」双层现状，删除随迁的 dead_code（append_project_rule 接线等按需） | ✅ **收口（2026-09-05）**：双层现状维持（v3 §1 落地形态即此——PluginToolAdapter 是能力口/git 闸的口内构造，非待拆脚手架）；随迁 dead_code 清点 = 零新增（R3-d 全程零 warning；现存 #[allow(dead_code)] 均带既存意图注记——append_project_rule 按上窗拍板「攒着」）；权限回归 = 各能力口批内专项（fs/git/shell 三域闸形状单测 + 权限回归套件全绿） |
| 收口 | tool_call/PluginRegistry 去留裁定；builtin.* 残余域退役或留 R4/R5；内核=能力口+闸+应用壳 | ✅ **R4 窗全清（2026-09-05，e8e9fb6d…f6b74343）**：十一插件（含 R4 句柄域 browser/uia + 小面 web/constraints/pty/lsp/editor）信封全部退役，tool_call 的 TS/Rust 业务消费面清零；PluginToolAdapter 终态改判兑现（口内闸构造，git_cap/editor_cap 消费中）。内核形态 = 能力口（search/fs/git/process/browser/uia/web/constraints/pty/lsp/editor 十一口）+ 口内闸 + 应用壳 ✓；tool_plugins 脚手架（manifest/registry/dispatch）拆除收在 R5 |

> R3-e 权限迁移是风险最高的批——六步裁决 + Ask 链路 + worktree 两跳映射都依赖
> Rust 现状；是否本批全迁 TS 或「TS 判 + Rust 口最小强制」双轨过渡，施工时按
> 回归测试结果定（v3 §1：口内最小必要校验不信任 TS 授权）。

## 7. 待拍板决策点（2026-09-04 按 R2 先例裁定）

- **D-A**：能力口 RPC 用独立方法（`search_cap`/`fs_cap.*`）vs 改造 tool_call 单入口内分派。
  **裁定：独立方法**（R2 search_cap 先例——tool_call 信封是 P0-2 脚手架，v3 拆除令要退役；
  能力口 = 极少数稳定面，独立 RPC 真源清晰、rpc-contract 类型化、与信封解耦）。
- **D-B**：builtin.* 模块退役时机。
  **裁定（2026-09-04 初判「builtin.fs 保留服务 UI/内部」；2026-09-05 兑现推翻——fs 域收口）**：
  UI 内部 helper 与内部工具随 fs_cap 能力口扩展（memory_batch/read_base64/append/
  global_memory_dir 迁入）**全量换轨直呼**，builtin.fs 信封无消费方整目录退役
  （a681adc7）——「插件保留给内部消费」的过渡形态不需要：内部消费与模型族同走
  能力口（is_agent=false 用户路径，resolve_*_dispatch 只解析不过 Ask，语义等价）。
  git/shell 同型结论沿用此经验：能力口需覆盖内部消费工具（git 的 status/blame、
  shell 的 shell_env/background_activity/drain_bg_notifications）后整体退役。
- **D-C**：编排回 TS 时 manifest 生成器/镜像去留。
  **裁定：schema 真源回 TS zod**（search R2-d 先例——逐字节转录零漂移已证）；
  R3 起 fs 域随 execute 换轨回 zod，镜像/生成器条目随 builtin.* 退役逐步删
  （fs/git/shell 已删：kernel-manifests.generated 7 manifest + gen-kernel-manifest
  fs/git/shell DOMAIN）；
  全量脚手架拆除（manifest.rs/registry/生成器）收在 R5。

## 9. R3-c/d/e 执行裁定（2026-09-05 agent 裁定——用户确认技术决策由 agent 定、测试兜底）

> 背景：用户 2026-09-05 明示「技术上的东西我自己也不一定拍得好」——技术执行决策
> 由 agent 按先例/风险裁定并落档，测试工程兜底；有产品味道的决策才端用户。

- **R3-e（权限）——裁定：不迁六步裁决**。维持 v3 双层现状（Rust 能力口强制 +
  TS 策略建议）：webview 无盘权，Rust 口是恶意 TS 越不过的物理闸——把六步裁决整体
  迁 TS 是「为架构整洁的重构」，行为零收益、风险实打实（worktree 两跳映射拆散 =
  fork 子 Agent 直写主仓事故复发，有守卫测试盯着）。R1 已收拢的是**策略数据面**
  （auto 白名单/系统规则/danger 归 TS 单真源），与裁决执行序解耦——数据面收拢完成
  即 R3-e 的实际收益，裁决序迁移不做。残留收口 = 删随迁 dead_code（如
  append_project_rule 的接线按需评估），按 R3-e 行验收。
- **R3-d 粘性 cwd——裁定：归 TS，Rust 口无状态**。粘性 cwd 是「编排记忆」，与
  tool-ergonomics 焦点文件（session-context.ts，per-owner 上下文、Rust 零改动）同类；
  放 Rust 静态态需防跨工作区串味（本仓库反复炸的雷区形态）。process_cap 显式带 cwd，
  编排层维护 per-agent cwd（切工作区即重置）。Rust sticky_cwd.rs 随 builtin.shell
  退役拆除。
- **权限规则持久化层级（原 #3/#4 待定，2026-09-05 澄清后收起）**：与 agent 记忆
  （/remember + hologram_memory，在用在产）无关——指权限规则落点。
  - #3「永久记忆」= append_project_rule（写 .lantai/permissions.json）接线：**攒着**，
    会话级 remember 日常够用；永久键 = 一行 UI + 落盘，真实需求出现再加。
  - #4 用户级规则文件（~/.lantai/ 规则，RuleSource::User）：**不做**（YAGNI——
    兰台单机桌面无多项目场景，Claude Code 式 user/policy 层用不上）。
    两条均非待拍板，agent 按此执行，改主意随时可开。

## 8. R3-c/d/e 施工输入（2026-09-04 勘察定稿，下窗开工点）

> 两份勘察报告（R3 fs/git/shell 迁移 + R3-c/d git/shell 能力口）已收齐，结论沉淀如下。

### git_cap（R3-c）——可行，形态定稿
- `git_cap { repo_path, subcommand, args, is_agent, agent_id }`：**subcommand 位必须
  保留**（Git 家族两段闸 = filesystem::check_read_permission(repo) + git::check(subcommand)，
  精确子命令 deny/allow/ask 规则依赖它；plugin:builtin.git.git_commit deny 不失义）。
  read_only 5 工具（status/diff/log/blame）走 Read 家族闸分流。
- Rust 执行体 = utils::run_git（纯同步进程封装，无流式/job）；git_exec_path（worktree
  forward-map）是执行侧唯一物理换算点——能力口显式收 is_agent/agent_id（search_cap
  先例双键读取已解决）。
- 编排回 TS：porcelain 解析 3 处纯文本（status 头 + parse_status utils.rs:174 + log
  \x00 split）——TS 拿 run_git stdout 自 split 可行（webview 无盘权不构成障碍，输出
  字符串经 RPC 回传）。
- 测试钉面：permissions/git.rs:93-160 + permissions/mod.rs:730-841（Git 子命令规则 +
  forward-map worktree 端到端）；git/mod.rs tests:331-368（manifest 权限形状）；
  kernel-envelope.ts LEGACY_METHOD_OF git 16 行换轨须处理。

### process_cap（R3-d）——可行，切割面大
> **已兑现（2026-09-05，5edb9c28/86d0d659/bd9b9712）**——本节各切割点逐条落地，
> 唯一执行偏差：marker 截流位置由「口内截留」改为「口内原样流经 + TS 截流」
> （§9 粘性归 TS 的自然推论——状态在 TS 则截流提交必须同侧；事件/结果形状零改）。
- `process_cap { command, cwd?, interpreter?, bg?, streamToolId? }` + 口内保留
  fg/bg 双检查不对称（fg = require_command 可 Ask + resolve_read_dispatch / bg =
  require_command_sync + require_read_sync 免 Ask——shell 域自检形态，manifest 单键
  permission 表达不了，不能进 adapter）。
- **保留 shell:output/shell:done 事件形状 + started 回 {streamId,job_id}**——queued-
  shell.ts 已完整收双事件闭环，换 invoke 目标即可零改（shell-done-watchdog.test 仅换
  shim 目标）。bg 三工具（bash_output 增量游标/wait/kill）依赖 Rust BG_JOBS ledger，
  TS 无法自实现——留口内 action。
- **新增风险（勘察发现）**：粘性 cwd 状态（sticky_cwd.rs：marker 截流 + generation
  换代 + per-agent 存储）全在 Rust 静态态——编排回 TS 需裁定状态归属（能力口带 cwd
  参数 vs 保留 Rust 小状态口）。比流式更深的切割决策。
- R2-d(2) 并入本批：search_cap 输出组装编排回 TS（统一命中集收窄）。

### R3-e（权限）——风险最高
- 六步裁决迁 TS 策略层 vs 「TS 判 + Rust 口最小强制」双轨过渡：按回归测试结果定
  （v3 §1：口内最小必要校验不信任 TS 授权）。
- Rust 侧 PERMISSION_MODE/auto_mode_allows 消费点仅两处同步路径（check_permission_sync
  后台 + check_mcp_permission）——TS 闸覆盖不到的同步路径是盲区，需保留 Rust 最小
  强制或改同步旁路协议。
- worktree forward-map 两跳依赖（adapter path forward-map + 家族 check reverse-map）
  若拆散 = fork 子 Agent 直写主仓事故复发（regression r4/r5/r7 守卫）——隔离映射
  必须整体搬或保 Rust 强制层。
- audit_deny/allow、Ask oneshot（register_ask/resolve_ask 300s 超时）由 TS 闸承接
  或明确保留。
