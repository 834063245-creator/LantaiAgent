# ctx 服务目录（生成物）

> 由 `scripts/gen-service-catalog.cjs`（经 tsx 运行 `src-ui/scripts/gen-service-catalog.ts`）
> 从组合层源码机械推导生成 — 勿手改；服务面变更后重新生成并同 commit。
> 不含时间戳：字节稳定是 `--check`（doc-sync 门禁）的前提。

共 19 个 ctx 服务：seam 6 · 贡献通道 8 · 服务 5。
kind 三分规则（机械推导）：ctx 键 ∈ SEAM_DOMAINS（seam-resolution.ts 单一真源）= seam；
类体含 `register(def: *Contribution)` = 贡献通道；其余 = 服务。

## swappable seam（能力契约层——可换实现）

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.fs` | `FsService` | `src/composition/fs-service.ts` | — | 2 文件 |
| `ctx.graph` | `GraphService` | `src/composition/graph-service.ts` | `builtin/rust-graph` | 2 文件 |
| `ctx.llm` | `LlmService` | `src/composition/services.ts` | `builtin/anthropic` · `builtin/openai` | 2 文件 |
| `ctx.sessionPersistence` | `SessionPersistenceService` | `src/composition/session-persistence-service.ts` | — | 2 文件 |
| `ctx.shell` | `ShellService` | `src/composition/shell-service.ts` | — | 2 文件 |
| `ctx.subagents` | `SubagentsService` | `src/composition/subagent-service.ts` | `builtin/in-process` | 2 文件 |

### `ctx.fs` — FsService（swappable seam（可换实现））

fs 后端能力注册表（平台化 Phase 2 · D11）——默认 provider = builtin/rust-fs（agent/fs-provider.ts）；消费面 = agent/tools/coding.ts fs 域。

- owner：`src/composition/fs-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/agent/fs-provider.ts` · `src/composition/contract-version.ts`

### `ctx.graph` — GraphService（swappable seam（可换实现））

图分析后端注册表（平台化 Phase 2 · D11）——默认 provider = builtin/rust-graph（agent/graph-provider.ts）；消费面 = hologram 域 holoExec。

- owner：`src/composition/graph-service.ts`
- 默认实现 / 贡献者 id：`builtin/rust-graph`
- 消费面（2）：`src/agent/graph-provider.ts` · `src/composition/contract-version.ts`

### `ctx.llm` — LlmService（swappable seam（可换实现））

LLM adapter 注册表（S1-1 起；平台化 Phase 1 升格为 ctx.llm seam）—— 行注册 → disposer；请求期解析语义见 provider/index.ts 方言解析器。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`builtin/anthropic` · `builtin/openai`
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/llm-adapters-plugin.ts`

### `ctx.sessionPersistence` — SessionPersistenceService（swappable seam（可换实现））

会话持久化注册表（平台化 Phase 2 · D11）——默认 provider = builtin/rust-sessions（agent/sessions-provider.ts）；消费面 = agent-store。

- owner：`src/composition/session-persistence-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/agent/sessions-provider.ts` · `src/composition/contract-version.ts`

### `ctx.shell` — ShellService（swappable seam（可换实现））

shell 后端能力注册表（平台化 Phase 2 · D11；subprocess 并入本 seam）—— 默认 provider = builtin/rust-shell（agent/shell-provider.ts）； 消费面 = agent/tools/coding.ts shell 域四工具。

- owner：`src/composition/shell-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/agent/shell-provider.ts` · `src/composition/contract-version.ts`

### `ctx.subagents` — SubagentsService（swappable seam（可换实现））

子代理 provider 注册表（平台化 Phase 1 · D3）——默认 provider = 进程内实现 （agent/subagent-provider.ts）；消费面 = Agent.spawnSubAgent。

- owner：`src/composition/subagent-service.ts`
- 默认实现 / 贡献者 id：`builtin/in-process`
- 消费面（2）：`src/agent/subagent-provider.ts` · `src/composition/contract-version.ts`

## 贡献通道

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.capabilities` | `CapabilitiesService` | `src/composition/capability-service.ts` | — | 1 文件 |
| `ctx.commands` | `CommandsService` | `src/composition/services.ts` | `canvas/sidebar-toggle` · `compose/space-status` · `paper/toggle` · `settings/toggle` · `space/demo-status` | 5 文件 |
| `ctx.hooks` | `HooksService` | `src/composition/hook-service.ts` | — | 0 文件 |
| `ctx.overlays` | `OverlayService` | `src/composition/overlay-service.ts` | `compose-dock` · `toc-strip` | 1 文件 |
| `ctx.panels` | `PanelsService` | `src/composition/services.ts` | `canvas-sidebar` · `canvas-spine` · `paper` · `settings` | 3 文件 |
| `ctx.prompts` | `PromptsService` | `src/composition/prompt-service.ts` | — | 1 文件 |
| `ctx.renderers` | `RenderersService` | `src/composition/renderer-service.tsx` | — | 2 文件 |
| `ctx.tools` | `ToolsService` | `src/composition/services.ts` | `hologram/browser-desktop-domain/tools` · `hologram/engine-domain/tools` | 3 文件 |

### `ctx.capabilities` — CapabilitiesService（贡献通道）

capability 贡献注册表（A-3 第八贡献通道）——贡献注册 → disposer； 下次 Agent 装配生效语义。

- owner：`src/composition/capability-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（1）：`src/plugins/capability-segments-plugin.ts`

### `ctx.commands` — CommandsService（贡献通道）

命令注册表（S1-1）——def 注册 → disposer；即时生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`canvas/sidebar-toggle` · `compose/space-status` · `paper/toggle` · `settings/toggle` · `space/demo-status`
- 消费面（5）：`src/paper/paper-plugin.ts` · `src/plugins/canvas-nav-plugin.ts` · `src/plugins/compose-dock-plugin.ts` · `src/plugins/settings-plugin.ts` · `src/plugins/space-demo-plugin.ts`

### `ctx.hooks` — HooksService（贡献通道）

工具管道钩子注册表（A-2）——enrich/preflight 贡献注册 → disposer； 下次 Agent 装配生效语义。

- owner：`src/composition/hook-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.overlays` — OverlayService（贡献通道）

画布覆盖层通道（Stage-4）：创作坞/目次带等视口固定形态经此注册， 由 PaperPanel 在对应槽位渲染。

- owner：`src/composition/overlay-service.ts`
- 默认实现 / 贡献者 id：`compose-dock` · `toc-strip`
- 消费面（1）：`src/plugins/compose-dock-plugin.ts`

### `ctx.panels` — PanelsService（贡献通道）

面板注册表（S1-1）——def 注册 → disposer；即时生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`canvas-sidebar` · `canvas-spine` · `paper` · `settings`
- 消费面（3）：`src/paper/paper-plugin.ts` · `src/plugins/canvas-nav-plugin.ts` · `src/plugins/settings-plugin.ts`

### `ctx.prompts` — PromptsService（贡献通道）

system-prompt 段落注册表（A-1 第六贡献通道）——段注册 → disposer； 下次 Agent 装配生效。

- owner：`src/composition/prompt-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（1）：`src/plugins/prompt-segments-plugin.ts`

### `ctx.renderers` — RenderersService（贡献通道）

块渲染器注册表（V3b 第五贡献通道）——def 注册 → disposer；即时生效。

- owner：`src/composition/renderer-service.tsx`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/app/panels/PaperPanel.tsx` · `src/plugins/loader.ts`

### `ctx.tools` — ToolsService（贡献通道）

工具注册表（S1-1）——行注册 → disposer；下次 Agent 装配生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`hologram/browser-desktop-domain/tools` · `hologram/engine-domain/tools`
- 消费面（3）：`src/plugins/coding-domain-plugins.ts` · `src/plugins/mcp-bridge.ts` · `src/plugins/tool-declarations.ts`

## 服务

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.agentLoop` | `AgentLoopService` | `src/agent/agent-loop/agent-loop-service.ts` | — | 0 文件 |
| `ctx.codeRuntime` | `CodeRuntimeService` | `src/agent/code-run/runtime-service.ts` | — | 0 文件 |
| `ctx.dynamicRunner` | `DynamicRunnerService` | `src/agent/dynamic-runner/dynamic-runner-service.ts` | — | 0 文件 |
| `ctx.lsp` | `LspService` | `src/ui/lsp-client.ts` | — | 0 文件 |
| `ctx.space` | `SpaceService` | `src/composition/space-service.ts` | — | 2 文件 |

### `ctx.agentLoop` — AgentLoopService（服务）

agent loop 注册表（平台化 Phase 5 · D13）——默认实现构造期登记， 替换实现 register 即接管（后注册胜）。

- owner：`src/agent/agent-loop/agent-loop-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.codeRuntime` — CodeRuntimeService（服务）

执行腰服务（P3）——run() 门面 + 绑定面归一；后端可换。

- owner：`src/agent/code-run/runtime-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.dynamicRunner` — DynamicRunnerService（服务）

动态插件运行时（平台化 Phase 4 · D7）——define/run/stop/undefine/ inspect；沙箱宿主半见 agent/dynamic-runner/sandbox.ts。

- owner：`src/agent/dynamic-runner/dynamic-runner-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.lsp` — LspService（服务）

- owner：`src/ui/lsp-client.ts`
- 默认实现 / 贡献者 id：—
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.space` — SpaceService（服务）

画布空间 API（Stage-2）：读画布状态 + 订阅 + 空间命令。

- owner：`src/composition/space-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/plugins/compose-dock-plugin.ts` · `src/plugins/space-demo-plugin.ts`

