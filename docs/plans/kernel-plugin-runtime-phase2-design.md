# 内核插件运行时 Phase 2 设计件 —— 工具域全量批次拆解 + tool_call:progress 进度流 + Tool::name() 放宽

> 状态：**自查模式设计件**（2026-09-04；按 2026-08-24 拍板 #4 纪律——agent 对代码库逐条自查设计断言，用户面只保留白话摘要，不产待批长文）。
> 性质：kernel-plugin-runtime-plan §4 Phase 2 前置设计。前批先例：builtin.search（Phase 1）/ builtin.web（Phase 1 续，4778cd5f）——本件沿用其全部已验证模式，只裁决新面。
> 范围：Phase 2 = 工具域全量迁移（2026-09-04 拍板合并原 Phase 2/3——fs/git/shell/editor/constraints/browser/uia/pty/lsp 九域同质工作按风险排序，域界即批界）。P2-5/P2-6（browser/uia/pty/lsp）只立批位，权限形状增补节起工前补。
> 本文所有「实查」数据均于 2026-09-04 对 HEAD=4778cd5f 验证。

## 0. 进度记录（2026-09-04 施工窗）

- **P2-0 已落地**（commit 08c5466f，全门禁绿）：Tool trait Cow 放宽 + rule_fallback_name + 两级规则寻址 + adapter 请求级形态 + manifest permission 字段 + dispatch 过闸条件化；回归钉 r13/r14/r15。
- **P2-1 已落地**（commit 87ab054a，全门禁绿）：builtin.constraints + builtin.editor；confined_fs 免检变体与 path_resolve unchecked 助手；rpc 142 methods；fs-builtin provider 表三动作先换信封。
- **P2-2 已落地**（commit fcd120b4，2026-09-04 收尾窗全门禁绿）：builtin.fs 13 工具 + rpc 129 methods + search.rs 退役 + 15 内部直呼换源 + sessions-builtin 信封化 + kernelFsCall 助手族；测试面 25 文件经基建 A（tests/helpers/kernel-envelope.ts 的 legacyDispatchShim/legacyRpcShim 信封翻译层）适配；mock-data 死 fs 条目清理。**基建 B 同批落地**：`npm run gen:kernel-manifest` 生成器（src-ui/scripts/gen-kernel-manifest.ts）——manifest schema 唯一转录通道，P2-3 起禁手写新工具 schema；fs/editor/constraints --check 对拍一致（人工转录审计通过），git 域 16 工具 TOOLS_SPEC 就位待发射。
- **P2-3 已落地**（2026-09-04 收尾窗续批，全门禁绿）：builtin.git 16 工具（生成器发射 manifest；13 TS 面直出 + diff_unstaged/diff_staged 共享 git_diff schema + stage_all/blame 手写 spec）；权限声明 status/diff/log/blame=Read 家族、其余=Git 家族+subcommand（原 require_git_dispatch 第二参）；业务免检化——require_git_dispatch/require_git 随消费者退役，保留 git_exec_path+run_git；rpc 113 methods（-16）；git_cmds.rs 整文件退役；TS createGitTools 换 manifest 驱动（git_diff 双目标路由/git_stage 拆单保留工具层）+ state-inject 换 kernelGitCall 信封 + shim 表扩 builtin.git 16 行。**单键语言裁决落地**：模型面键 = manifest 键 = 插件实收键——随迁修复两处存量静默丢参（git_log 的 count 旧 RPC 读 limit 恒被丢；git_create_branch 的 branch 旧 RPC 读 name 必报 missing）。
- **P2-4 已落地**（2026-09-04 收尾窗续批，全门禁绿）：builtin.shell 7 工具（生成器发射；4 TS 面直出 + shell_env/background_activity/drain_bg_notifications 手写内部 spec）——**权限形状 = 全族业务自检**（exec_command 的 bg/fg 双检查不对称：前台 require_command Ask 可弹、后台 sync 免 Ask——单键 adapter 表达不了，v1 形态不声明 permission）；rpc 106 methods（-7）；shell.rs 整文件退役（业务+全部单测随迁）；queued-shell/agent-builder/workspace/default-loop/runtime 五消费面换 kernelShellCall/信封；agent-builder 的 codingExec 特殊面（前台流式）改解信封按 plugin.tool 寻址（与 ab-tools kernelExec 互为镜像），随批清两块 seam 化以来的死分支（run_shell 后台等待环 + TIMEOUT_TOOLS 名字面匹配——外层名 Phase 1 起不再到达，行为零变化）。**tool_call:progress 进度流落地**（§4）：ToolContext 增 call_id + emit_progress（首个生产消费者 = 后续增量输出型工具，shell 不迁自有流式——§4.3 裁决）；EventContract 增事件行；manifest 工具（manifestTool/fs/git/shell 四工厂）经 withProgressStream 自持订阅转发 onProgress。
- **P2-5 已落地**（2026-09-04 施工窗，全门禁绿）：builtin.browser 37 工具 + builtin.uia 17 工具（生成器发射 manifest，37+17 全量 TS 面直出）。**权限形状按 §8 裁决**：browser/uia 均不进 manifest permission——插件内 ctx.check_permission(&BrowserTool/&DesktopTool) 业务自检原样迁入（browser 的 self 路由 / click_sensitive·type_sensitive 运行时二次 Ask、uia 的 resolve→classify→grant→lease 全链 + keys/activate 租约 + 逐动作审计）；dispatch 侧 adapter 恒 Passthrough；rpc 106→52 methods（-54 分支）；rpc.rs 退役 check_browser_permission/self_or_agent/desktop_check/desktop_uia_write/keys/activate 壳函数 + 死码清理（opt_u64/usize/f64 + result-shape desktop 行 + self 路由测试）；TS createBrowserTools/createDesktopTools 换 manifest 驱动（kernelBrowserTool 工厂 + envelopeCall tool_call 信封寻址，37+17 schema/desc/readOnly = manifest 字节），复合工具 browser_fill/browser_navigate_snapshot/desktop_uia_fill 保留工具层（无 RPC 分支，defineTool 定义 + 逐字段调信封工具）；RpcContract 删 browser_audit 行；browser/desktop 四测试文件（46 断言）适配信封。
- P2-5~P2-6 未动工。


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

## 8. 权限形状增补节（P2-5/P2-6 起工前裁决，2026-09-04 续窗实查）

### 8.1 裁决结论

**browser/uia 不走 manifest permission 声明；权限整体留插件内业务自检（shell 先例同构）。**
PTY/LSP 同理，不进 manifest permission（原本就无工具级家族对应）。

理由（逐条实查，详见 §8.2）：

- browser 的 BrowserTool 分层包含「只读放行 / L2 普通动作放行 / 高危动作 Ask /
  敏感目标动态升级 Ask」四层语义；`click_sensitive`/`type_sensitive` 是插件内根据
  selector/目标状态**运行时**判断后调用的第二把权限闸，manifest 单键 adapter 无法表达。
- uia 的 DesktopTool 分层更强：写动作先做只读 `resolve` 拿控件名/patterns/hwnd/密码态，
  经 `classify_uia_action` 归为 `uia_grant` / `uia_pattern` / `uia_click_sensitive` /
  `uia_type_sensitive` / `uia_physical` / `uia_keys` / `uia_activate` 后才构造 Tool 过闸；
  是否放行还依赖运行期 `has_grant(agent, hwnd)` 窗口授权状态——不是静态单键能表达的。
- browser_sessions / UIA grants / PTY sessions / LSP servers 都是全局进程内注册表；
  插件不直接持有原始锁，而是继续走既有高层函数（`cdp_*` / `uia::*` /
  `pty_manager::*` / `lsp_manager::*`），ToolContext 不需要新增裸注册表句柄。
- DesktopInputLease / DesktopGrant 语义完全保留在 uia 模块与 `tools/mod.rs` DesktopTool
  原链，迁移只换「rpc 分支 → tool_call 分派」的外皮，不换权限/租约真源。

### 8.2 权限形状实查（2026-09-04 对 HEAD=b74d18c6 验证）

| 面 | 现状权限闸 | 是否可压成单键 | 裁决 |
|---|---|---|---|
| browser 只读（targets/inspect/report/snapshot/content/console/network/…/wait/cookies_list） | BrowserTool::is_read_only → Passthrough；但 Browser=deny 仍最高优先 | 表面可声明 Read/ReadOnly？否——Browser 家族规则/Ask 语义要保留 | 插件内 `ctx.check_permission(BrowserTool{action})` |
| browser L2（navigate/back/forward/reload/click/hover/type/select/upload/dialog/press/scroll/viewport/new_tab/close_tab/switch_session） | BrowserTool 内直接 Passthrough（attach 后免重复 Ask） | 可声明？否——不能丢失 attach 后免弹语义 | 插件内同链 |
| browser 高危（launch/kill/attach/connect/eval/cookies_set/cookies_delete） | BrowserTool → Ask | 可声明 Ask？否——Ask 文案/建议规则在 BrowserTool 内 | 插件内同链 |
| browser 敏感（click_sensitive/type_sensitive） | rpc 层先 `check_sensitive` 命中后再 `check_browser_permission("…_sensitive")` | 单键 adapter 完全无法表达 | 插件内运行时二次 Ask |
| uia 只读（probe/uia_tree/find/read/wait/window_shot/audit） | DesktopTool is_read_only → Passthrough | 否 | 插件内 `ctx.check_permission(DesktopTool{action})` |
| uia 写 | resolve → classify_uia_action → DesktopTool{action=…} | 否（依赖运行期 resolve/classify/grant） | 插件内保留完整编排 |
| uia screenshot | DesktopTool screenshot → Ask | 否 | 插件内同链 |
| pty/lsp | 无家族规则，仅生命周期注册表 | 不必声明 | 插件内 Passthrough + 原函数 |

### 8.3 browser/uia 插件内权限调用形态

- 插件模块**不**在 dispatch 侧声明 `permission`，故 PluginToolAdapter 恒 Passthrough。
- 各业务函数内部照旧调用 `ctx.check_permission(&crate::tools::BrowserTool{…})` 或
  `ctx.check_permission(&crate::tools::DesktopTool{…})`；`ctx.check_permission` 已存在且
  与旧 `crate::utils::check_permission` 同一真权路径（Ask 事件 + 回包等待）。
- browser 的 self 路由、`check_sensitive` 二次 Ask、`desktop_uia_write` 的 resolve →
  classify → grant → lease 全链原样迁入插件，不做机制改动。
- 插件业务中不再使用 rpc.rs 的 `check_browser_permission` / `desktop_check` /
  `desktop_uia_write` 壳函数；它们随 rpc.rs 分支退役。

### 8.4 注册表访问裁决

- **不向 ToolContext 暴露内部 Mutex/静态表**。既有高层封装已经是正确边界：
  - browser：`cdp::cdp_*` 系列内部用 `session_key/active_session_key/ACTIVE_SLOTS/SESSIONS`；
    插件直接调用 `cdp_sessions/cdp_switch_session/cdp_browser_activity` 等公开函数即可。
  - uia：`uia::grant/has_grant/list_grants/lease_holder/acquire_input_lease` 已是
    grants 模块的公开封装，插件不需要直接摸 `grants` 内部。
  - pty/lsp：`pty_manager::pty_*` / `lsp_manager::lsp_*` 已是公开封装。
- 设计件 §2 P2-5 行原话「browser_sessions 注册表访问进 ToolContext」**修订为**：
  browser_sessions 的**既有高层查询函数**继续留在 cdp 模块，插件经 `crate::cdp::` 调用；
  ToolContext 不新增浏览器会话句柄字段。结论依据：注册表形态是全局静态
  `SESSIONS: LazyLock<Mutex<HashMap<String, CdpSession>>>`，直接暴露给插件等于
  把内核内部锁/会话结构体泄漏出模块边界；而插件业务需要的只是 `cdp_sessions(agent_id)`
  这类高层只读查询，无新增能力需求。

### 8.5 P2-6 权限/注册表裁决

- PTY：`pty_spawn/write/resize/kill` 无家族对应；Passthrough + 原 `pty_manager::*` 调用。
  生命周期注册表（`pty_manager::SESSIONS`）不暴露给 ToolContext，插件只走高层函数。
- LSP：`lsp_start/request/stop` 无家族对应；Passthrough + 原 `lsp_manager::*` 调用。
  `lsp-message` 事件通道原样保留（Rust 侧 `app.emit("lsp-message", …)` 不变；
  TS `ui/lsp-client.ts` 继续 `typedListen('lsp-message')` 消费）。
- 二者都不在 manifest 写 permission；也不新增 ToolContext 注册表字段。

### 8.6 对后续实施的影响

- 生成器 `gen-kernel-manifest.ts` 的 browser/uia/pty/lsp TOOLS_SPEC 中：
  **不写 permission 字段**；只写 `tsTool`/手写 schema/description/read_only。
- Rust 插件 mod.rs 需**原样搬入权限编排代码**，不能照 fs/git 的“dispatch 侧免检化”模式
  省略插件内权限检查。
- rpc.rs 退役后，`tools/mod.rs` 的 BrowserTool/DesktopTool 七家族实现**保留不动**——
  它们是插件内真权检查的依赖，不是死码。

