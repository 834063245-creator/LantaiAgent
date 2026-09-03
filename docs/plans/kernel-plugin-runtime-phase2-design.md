# 内核插件运行时 Phase 2 设计件 —— 工具域全量批次拆解 + tool_call:progress 进度流 + Tool::name() 放宽

> 状态：**自查模式设计件**（2026-09-04；按 2026-08-24 拍板 #4 纪律——agent 对代码库逐条自查设计断言，用户面只保留白话摘要，不产待批长文）。
> 性质：kernel-plugin-runtime-plan §4 Phase 2 前置设计。前批先例：builtin.search（Phase 1）/ builtin.web（Phase 1 续，4778cd5f）——本件沿用其全部已验证模式，只裁决新面。
> 范围：Phase 2 = 工具域全量迁移（2026-09-04 拍板合并原 Phase 2/3——fs/git/shell/editor/constraints/browser/uia/pty/lsp 九域同质工作按风险排序，域界即批界）。P2-5/P2-6（browser/uia/pty/lsp）只立批位，权限形状增补节起工前补。
> 本文所有「实查」数据均于 2026-09-04 对 HEAD=4778cd5f 验证。

## 1. 现状审计（2026-09-04 实查）

### 1.1 分支存量

RPC 145 分支（frontend-rpc-contract.md 生成物计数）。前五域（P2-1~P2-4 面，即原 Phase 2 域）待迁合计 **39 个分支**：

| 域 | Rust 模块（行数） | RPC 分支 | 模型可见工具（TS 族） |
|---|---|---|---|
| fs | commands/filesystem.rs（356）+ search.rs 的 glob（129） | list_directory / list_directory_flat / read_file_content / read_memory_batch / write_file_content / log_append / create_directory / get_global_memory_dir / delete_file_or_dir / rename_file_or_dir / move_file / glob（12） | fs 族 11：read_file_content, write_file, edit_file, list_directory, read_constraints, write_constraints, glob, delete_file, create_directory, move_file, rename_file |
| editor | commands/editor.rs（631） | edit_file（1） | （fs 族的 edit 动作——经 provider seam 派发） |
| constraints | commands/constraints.rs（30） | read_constraints / write_constraints（2） | （fs 族的 constraints/write_constraints 动作） |
| git | commands/git_cmds.rs（285） | 16：status/diff_unstaged/diff_staged/stage/stage_all/commit/push/pull/log/init/checkout/create_branch/stash_push/stash_pop/discard/blame | git 族 14 |
| shell | commands/shell.rs（702） | exec_command / bash_output / bash_kill / bash_wait / shell_env / background_activity / drain_bg_notifications（7） | shell 族 4：run_shell, bash_output, bash_kill, bash_wait |

注：read_file_base64（filesystem.rs）无 rpc 分支外的模型面——是 renderer-host/loader 消费的内部命令；read_memory_batch / get_global_memory_dir / log_append 同为内部命令（memory 域/日志），非 fs 族模型工具，见 §5.3。

### 1.2 TS 消费面三类（迁移面 = 三条不同的路）

1. **fs/shell 域：provider seam（平台化 D11 开放面）**。`createFsTools` 的 execute 全部经
   `fsExecute → ctx.fs 注册表 → provider.execute(action, args, {dispatch})`；默认 provider
   `builtin/rust-fs`（plugins/builtin/fs-builtin/index.ts）以 `FS_COMMAND_BY_ACTION` 表
   （read→read_file_content … constraints→read_constraints，11 行恒等映射）经 dispatch 调旧名。
   shell 同构（shell-builtin：`SHELL_COMMAND_BY_ACTION`，run→exec_command）。
2. **git 域：直 exec**。`createGitTools` zod 工具 execute 直接 `exec('git_status', args)`——
   search/web 同款（无 seam）。
3. **内部直呼（非模型面，Agent 工具链之外的进程内消费）**：
   - agentInvoke：queued-shell.ts（bash_kill ×2 / exec_command / bash_output——shell:output/done
     事件流 + 600s 兜底 + watchdog 811fe584）；agent-builder.ts（exec_command / bash_wait）
   - typedRpc：canvas-store.ts / chat-session.ts / agent-compaction.ts
     （read_file_content `{raw:true}` / write_file_content——canvas.json/会话卷/压缩追踪的持久化 I/O）
   - renderer-host / plugins/loader（read_file_base64——资产渲染）

### 1.3 权限管线现状（两级）

- **dispatch 级**：`PluginToolAdapter` 恒 Passthrough（v1 裁决），`name() = "plugin"`（&'static str）。
- **插件内真权**：search 用 `ctx.resolve_read`（路径级）；web 用 `ctx.check_permission(&WebFetchTool)`
  （工具级 + 域名规则 + Ask）。**既有七家族 Tool（Read/Edit/Bash/Git/Browser/Desktop/WebFetch）
  承载全部真语义**：ReadTool→`filesystem::check_read_permission`，EditTool→`check_write_permission`
  （auto 白名单唯一入口——`auto_mode_allows` 只认 "Edit"），BashTool→`bash::check`，GitTool 按子命令。
- 命令侧现状混用两种形态（实查）：filesystem.rs 的 log_append 自构 `EditTool + check_permission_sync`；
  editor.rs 的 edit_file 走 `resolve_write_dispatch`（其 agent 路内部同样构 EditTool 过 check_permission）；
  create_directory 走 `confined_fs::create_dir`（内含沙箱+权限）。**语义等价，形状不一——插件化时统一到一种**（§3.2）。
- 用户 UI 路径（is_agent=false）：`resolve_path_user_read/write` 只做沙箱不做规则——权限系统是给 Agent 的。

### 1.4 进度流现状

- `streaming-executor` 注入 `args._callId = call.id`（L378，INVARIANTS #9 meta 通道）。
- `Tool.execute(args, onProgress, signal)` 签名有 onProgress，但**生产 executor 链在 provider seam 处丢弃它**
  （provider → dispatch=codingExec=agentInvoke，agentInvoke 不收 onProgress）——全仓唯一真流式是 shell：
  `shell:output`/`shell:done` 事件（streamToolId 键控，queued-shell.ts 消费）。

## 2. 批次拆解（序 = 风险递增，每批独立 commit + 全门禁）

| 批 | 内容 | 为什么这个序 |
|---|---|---|
| **P2-0** | `Tool::name()` Cow 放宽 + `rule_fallback_name` 默认方法 + adapter 升级（§3）——**纯基建，无分支迁移** | fs 写工具的硬前置（§3.1）；先落基建使后续五批不再动 permissions/ |
| **P2-1** | builtin.constraints（2 工具）+ builtin.editor（edit_file） | 最小热身：constraints.rs 30 行；editor 1 工具但验证「fs 族动作跨插件寻址」（edit 动作 → builtin.editor.edit_file）+ checked_write_atomic 进程级锁原样保留 |
| **P2-2** | builtin.fs 主体（filesystem.rs 9 模型工具 + glob 出 search.rs）+ TS fs 族换源（§5.1/§5.2）+ 内部直呼换源（§5.3，canvas/chat/compaction/renderer 共 4 文件）+ search.rs 空文件退役（web.rs 先例） | 面最大的一批；P2-1 已验证 provider 表跨插件寻址 |
| **P2-3** | builtin.git（16 分支）+ TS git 族换源 | 直 exec 族机械迁移（search/web 同款）；GitTool 语义按子命令进插件 |
| **P2-4** | builtin.shell（7 分支）+ tool_call:progress 落地（§4）+ queued-shell/agent-builder 换源 | 进度流主场；watchdog 链路保护裁决（§4.3） |
| **P2-5** | builtin.browser（37 分支）+ builtin.uia（desktop_* 族）——原 Phase 3 域并批（2026-09-04 拍板合并，同质工作无相界） | 权限路径最特殊：`check_browser_permission` 是 rpc.rs 里的独立包装器（37 分支共享 + ADR 0003 D6 L3 三级动作规则），uia 有三级动作分类（physical/grant/pattern）——**起工前先在本件补权限形状增补节**（family 化 vs in-plugin ctx.check_permission 的裁决），browser_sessions 按 agent_id 键控的会话注册表访问同期进 ToolContext |
| **P2-6** | builtin.pty（4 分支）+ builtin.lsp（3 分支） | pty/lsp 挂进程/服务器生命周期注册表；TS 直 exec 族（createBrowserTools 同款路径）；权限走 in-plugin check（家族无既有对应，Passthrough + 域内真权） |

非目标：isolation（独立域，随多 Agent 线裁决）；
workspace_*/plugin_*/credential_/permission_/audit_（终态生命周期族，不迁）。

## 3. 权限模型升级（P2-0）

### 3.1 为什么是硬前置

fs 写工具今日过 EditTool——auto 模式白名单（`auto_mode_allows` 只认 "Edit"）、Ask 弹窗、
路径规则全部挂在家族名上。若 v1 的恒 Passthrough adapter 直接用于 fs 批，**auto 模式白名单
静默失效 + Ask 消失**（工具级门是唯一入口的语义被丢掉）。web/search 无此问题（只读 + 无工具级门）。

### 3.2 形状

```rust
pub trait Tool: Sync {
    fn name(&self) -> Cow<'static, str>;                       // &'static str → Cow
    fn rule_fallback_name(&self) -> Option<&'static str> { None } // 新增默认方法：家族名回退
    // 其余签名不变
}
```

- **七存量实现**：`Cow::Borrowed("Read")` 等机械替换（tools/mod.rs 7 处）。
- **PluginToolAdapter 升级为请求级形态**（不再共享常量）：
  ```rust
  pub(crate) struct PluginToolAdapter {
      full_name: String,                    // "plugin:builtin.fs.write_file"，dispatch 构造期一次
      read_only: bool,
      path: Option<String>,                 // manifest 声明的路径键从 args 提取（forward-map 后）
      agent_id: Option<String>,
      family: Option<&'static str>,          // manifest 声明："Edit"/"Read"/"Bash"/"Git"/"WebFetch"
  }
  impl Tool for PluginToolAdapter {
      fn name(&self) -> Cow<'static, str> { Cow::Borrowed(&self.full_name) }
      fn rule_fallback_name(&self) -> Option<&'static str> { self.family }
      fn check_permissions(&self, ctx) -> PermissionResult {
          // family 委托：Edit→filesystem::check_write_permission，Read→check_read_permission，
          // Bash→bash::check，Git→git::check（带 subcommand），None→Passthrough（现状）
      }
  }
  ```
- **manifest ToolSpec 增可选 `permission` 字段**（非模型面——schema 字节不动）：
  `{"family": "Edit", "path_key": "filePath"}` / `{"family": "Bash", "command_key": "command"}` /
  `{"family": "Git", "command_key": "…"}` / 缺省 = 无（v1 语义）。dispatch_tool_call 构造
  adapter 时按声明从 args 提取 path/command。

### 3.3 规则寻址双轨（向后兼容）

`has_permission_to_use_tool` 的 ①② 工具级规则匹配改为两级：先 `tool.name()`
（`plugin:builtin.fs.write_file` 精确寻址——Phase 2 新能力），未中再
`rule_fallback_name()`（家族名）——**既有用户规则（"Edit" deny 等）不静默失效**。

### 3.4 调用点适配清单（实查 6 处，全机械）

- permissions/mod.rs L316 `let tool_name = tool.name();` → Cow；后续 audit_*/format! 处
  `.as_ref()`（audit 记 plugin 精确名）。
- utils/path_resolve.rs：L147 Ask 载荷 / L164/172/183 audit / L209 `auto_mode_allows(tool.name())`
  ——**L209 是静默失效点**：adapter 名不是 "Edit"，auto 白名单必失。改为
  `auto_mode_allows(tool.name()) || tool.rule_fallback_name().is_some_and(auto_mode_allows)`
  （is_some_and 稳定于 1.70，仓内 Rust 版本满足）。
- 两级匹配逻辑集中在 has_permission_to_use_tool 与 path_resolve 的 Ask/auto 两处，不散装。

### 3.5 dispatch 过闸条件化（用户 UI 路径）

dispatch_tool_call 的 adapter 过闸改为**仅 is_agent 路径**执行；用户 UI 路径（内部直呼
canvas/chat 持久化等）直接进插件，插件内按 `ctx.is_agent` 分流
`resolve_read/write_dispatch` vs `resolve_path_user_read/write`——与今日命令的 is_agent
分流语义逐字一致。search/web 已落地的两个插件不受影响（read 真权在 resolve_read_dispatch
内部分流，本就一致）。

## 4. tool_call:progress 进度流（P2-4）

### 4.1 Rust 侧

- `dispatch_tool_call` 从 args 抽 `_callId`（与 `_agent_id` 同法，INVARIANTS #9 meta）入 ToolContext。
- `ToolContext::emit_progress(&self, chunk: &str)`：`call_id` 为 None 时 no-op（用户路径）；
  有则 `app.emit("tool_call:progress", {"callId": …, "chunk": …})`。

### 4.2 TS 侧

- rpc-contract 增事件行 `tool_call:progress: { callId: string; chunk: string }`。
- **manifestTool 自持订阅**（不依赖 exec 链透传 onProgress——生产链在 provider seam 处丢弃它
  是已知现状，§1.4）：execute 开始且 `args._callId` 存在且 onProgress 非空时
  `typedListen('tool_call:progress')` 按 callId 过滤转发；settle（成功/异常）即 unlisten。
  事件不会早于 execute 开始（emit 只发生在插件执行期），无竞态窗口。

### 4.3 shell 双事件通道原样保留（裁决）

`shell:output`/`shell:done` + streamToolId + bash_output 轮询 + 600s 兜底 + watchdog
（811fe584 刚修复）是完整闭环，**不迁 tool_call:progress**——插件内经 ctx.app emit
同名同载事件，queued-shell.ts 零改动。tool_call:progress 服务于「增量输出型」工具
（editor 大 diff 读、fs 长扫描），与 shell 自有流式是两个正交通道；`_callId` 与
`streamToolId` 两个键空间不合并。

## 5. TS 消费面迁移路线

### 5.1 fs/shell 族：provider seam 保留，默认 provider 表换源

平台化 D11 的 provider 开放面**不动**（这是「插件运行时」与「provider 替换」两个正交关注点——
内核插件化换的是 Rust 执行真源，provider 换的是 TS 执行策略）。变更仅两处：

- `createFsTools`/`createShellTools` 的 zod 定义换 manifest 驱动（schema/description/readOnly
  = manifest 字节，convergence 零漂移——search/web 先例），execute 仍走
  `fsExecute/shellExecute → provider`。
- 默认 provider 的命令表从旧 RPC 名换 tool_call 信封：
  `FS_COMMAND_BY_ACTION: Record<FsAction, string>` →
  `FS_PLUGIN_TOOL_BY_ACTION: Record<FsAction, { plugin: string; tool: string }>`
  （read/list/glob/mkdir/move/rename/delete/constraints→builtin.fs；edit→builtin.editor；
  write→builtin.fs.write_file_content）。dispatch 腰变
  `opts.dispatch('tool_call', { plugin, tool, args }, onProgress, signal)`——
  与 ab-tools.ts 的 kernelExec 解信封适配器互为镜像。

### 5.2 git 族：直 exec 换源（search/web 同款）

git-domain/host.ts 换源 manifest-tools；createGitTools 迁 manifest-driven。

### 5.3 内部直呼换源（随各自域批，同 commit）

| 调用方 | 现状 | 迁移 |
|---|---|---|
| queued-shell.ts（bash_kill/exec_command/bash_output） | agentInvoke 旧名 | `agentInvoke('tool_call', { plugin:'builtin.shell', tool, args })`（信封参数 snake 键由 bridge 转换，args 原样） |
| agent-builder.ts（exec_command/bash_wait） | 同上 | 同上 |
| canvas-store / chat-session / agent-compaction（read_file_content/raw、write_file_content） | typedRpc 旧名 | typedRpc('tool_call', …)；**raw 是 IPC 内部参数**——manifest schema 是模型契约不是 IPC 硬边界（INVARIANTS #8 修订：插件侧参数提取同命令强度），args 透传 raw 即可，不进 schema |
| renderer-host / plugins/loader（read_file_base64） | agentInvoke | builtin.fs 增内部工具 read_file_base64（manifest 声明、TS 不注册进模型族——manifest 驱动的注册面是白名单式） |

`log_append` / `read_memory_batch` / `get_global_memory_dir`：非模型工具，消费方是 memory/日志
内部链——随 fs 批一并进 builtin.fs 作内部工具（同 read_file_base64 待遇），rpc 分支退役。

## 6. 验收门（每批同 commit）

1. cargo test（新批插件单测 + 平台边界守卫基线随 commands 冻结清单同步收窄）。
2. vitest 全量 + convergence **零漂移**（schema 字节转录纪律——gen:plugin-manifests 重生成）。
3. `npm run gen:tool-contract` / `gen-rpc-contract-md`（SECTIONS 数组同步收窄）同 commit。
4. 权限回归专项（P2-0 起钉进测试）：auto 模式白名单经 family 回退仍生效；"Edit" deny 规则
   对 plugin:builtin.fs.write_file 仍拦截；用户 UI 路径（is_agent=false）零规则零弹窗。
5. P2-2/P2-4 加真机验收项：canvas 持久化读写（raw 路径）、shell 流式 + watchdog。

## 7. 自查记录

- 分支计数与九域清单：frontend-rpc-contract.md 生成物 + commands/*.rs `pub async fn` 逐文件核（2026-09-04）；browser 37 分支 + desktop/pty/lsp 计数来自 rpc.rs 分区实查（P2-5/P2-6 起工前增补节重核）。
- TS 三类消费面：fs-builtin/shell-builtin index.ts、coding.ts 族工厂、`agentInvoke|typedRpc + 旧名`
  全仓 rg 逐一列举（queued-shell / agent-builder / canvas-store / chat-session / agent-compaction / renderer-host）。
- 权限管线：permissions/mod.rs（trait + has_permission_to_use_tool 全文）、tools/mod.rs 七实现、
  path_resolve.rs（require_write / resolve_write_dispatch / check_permission 全文）、
  filesystem.rs log_append + editor.rs edit_file 两形态对照。
- auto 白名单静默失效点：`auto_mode_allows` 只认 "Edit"（permissions/mod.rs L66-68）+ path_resolve
  L209 调用位——该断言是本件最重要的一条新发现，P2-0 的验收门 4 直接钉它。
- 进度流：streaming-executor.ts L376-378、queued-shell.ts L114/144/154/159/172、rpc-contract
  shell:output 行；onProgress 在 agentInvoke 处被丢弃经 coding.ts fsExecute → provider → dispatch
  链路核（provider execute 透传 opts.onProgress，dispatch=agentInvoke 不收）。
- raw 参数语义：filesystem.rs L56-70（P1-3 注记——跳过行号的 JSON 读取面）。
