# ctx 服务目录（生成物）

> 由 `scripts/gen-service-catalog.cjs`（经 tsx 运行 `src-ui/scripts/gen-service-catalog.ts`）
> 从组合层源码机械推导生成 — 勿手改；服务面变更后重新生成并同 commit。
> 不含时间戳：字节稳定是 `--check`（doc-sync 门禁）的前提。

共 19 个 ctx 服务：seam 5 · 贡献通道 8 · 服务 6。
kind 三分规则（机械推导）：ctx 键 ∈ SEAM_DOMAINS（seam-resolution.ts 单一真源）= seam；
类体含 `register(def: *Contribution)` = 贡献通道；其余 = 服务。

## swappable seam（能力契约层——可换实现）

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.fs` | `FsService` | `src/composition/fs-service.ts` | `builtin/rust-fs` | 2 文件 |
| `ctx.llm` | `LlmService` | `src/composition/services.ts` | `builtin/anthropic` · `builtin/openai` · `builtin/responses` | 2 文件 |
| `ctx.sessionPersistence` | `SessionPersistenceService` | `src/composition/session-persistence-service.ts` | `builtin/rust-sessions` | 2 文件 |
| `ctx.shell` | `ShellService` | `src/composition/shell-service.ts` | — | 2 文件 |
| `ctx.subagents` | `SubagentsService` | `src/composition/subagent-service.ts` | `builtin/in-process` | 2 文件 |

### `ctx.fs` — FsService（swappable seam（可换实现））

fs 后端能力注册表（平台化 Phase 2 · D11）——默认 provider = builtin/rust-fs（agent/fs-provider.ts）；消费面 = agent/tools/coding.ts fs 域。

- owner：`src/composition/fs-service.ts`
- 默认实现 / 贡献者 id：`builtin/rust-fs`
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/builtin/fs-builtin/index.ts`

### `ctx.llm` — LlmService（swappable seam（可换实现））

LLM adapter 注册表（S1-1 起；平台化 Phase 1 升格为 ctx.llm seam）—— 行注册 → disposer；请求期解析语义见 provider/index.ts 方言解析器。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`builtin/anthropic` · `builtin/openai` · `builtin/responses`
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/builtin/llm-adapters/index.ts`

### `ctx.sessionPersistence` — SessionPersistenceService（swappable seam（可换实现））

会话持久化注册表（平台化 Phase 2 · D11）——默认 provider = builtin/rust-sessions（plugins/builtin/sessions-builtin）；消费面 = 产品会话卷持久化（chat-session/chat-core 四动作）。

- owner：`src/composition/session-persistence-service.ts`
- 默认实现 / 贡献者 id：`builtin/rust-sessions`
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/builtin/sessions-builtin/index.ts`

### `ctx.shell` — ShellService（swappable seam（可换实现））

shell 后端能力注册表（平台化 Phase 2 · D11；subprocess 并入本 seam）—— 默认 provider = builtin/rust-shell（agent/shell-provider.ts）； 消费面 = agent/tools/coding.ts shell 域四工具。

- owner：`src/composition/shell-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/builtin/shell-builtin/index.ts`

### `ctx.subagents` — SubagentsService（swappable seam（可换实现））

子代理 provider 注册表（平台化 Phase 1 · D3）——默认 provider = 进程内实现 （agent/subagent-provider.ts）；消费面 = Agent.spawnSubAgent。

- owner：`src/composition/subagent-service.ts`
- 默认实现 / 贡献者 id：`builtin/in-process`
- 消费面（2）：`src/composition/contract-version.ts` · `src/plugins/builtin/subagent-in-process/index.ts`

## 贡献通道

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.capabilities` | `CapabilitiesService` | `src/composition/capability-service.ts` | — | 1 文件 |
| `ctx.commands` | `CommandsService` | `src/composition/services.ts` | `canvas/sidebar-toggle` · `compose/space-status` · `paper/toggle` · `settings/toggle` | 4 文件 |
| `ctx.hooks` | `HooksService` | `src/composition/hook-service.ts` | `plan-injector` | 0 文件 |
| `ctx.overlays` | `OverlayService` | `src/composition/overlay-service.ts` | `asset-rack` · `compose-dock` · `paper-minimap` · `toc-strip` | 2 文件 |
| `ctx.panels` | `PanelsService` | `src/composition/services.ts` | `canvas-sidebar` · `canvas-spine` · `paper` · `settings` | 3 文件 |
| `ctx.prompts` | `PromptsService` | `src/composition/prompt-service.ts` | — | 1 文件 |
| `ctx.renderers` | `RenderersService` | `src/composition/renderer-service.tsx` | — | 6 文件 |
| `ctx.tools` | `ToolsService` | `src/composition/services.ts` | `communication-tools` · `compaction-tools` · `converge-tools` · `discovery-tools` · `hologram/browser-desktop-domain/tools` · `merge-tools` · `request-tool` · `spawn-tool` | 4 文件 |

### `ctx.capabilities` — CapabilitiesService（贡献通道）

capability 贡献注册表（A-3 第八贡献通道）——贡献注册 → disposer； 下次 Agent 装配生效语义。

- owner：`src/composition/capability-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（1）：`src/plugins/builtin/capability-segments/index.ts`

### `ctx.commands` — CommandsService（贡献通道）

命令注册表（S1-1）——def 注册 → disposer；即时生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`canvas/sidebar-toggle` · `compose/space-status` · `paper/toggle` · `settings/toggle`
- 消费面（4）：`src/plugins/builtin/canvas-nav/index.ts` · `src/plugins/builtin/compose-dock/index.ts` · `src/plugins/builtin/paper-shell/index.ts` · `src/plugins/builtin/settings-domain/index.ts`

### `ctx.hooks` — HooksService（贡献通道）

工具管道钩子注册表（A-2）——enrich/preflight 贡献注册 → disposer； 下次 Agent 装配生效语义。

- owner：`src/composition/hook-service.ts`
- 默认实现 / 贡献者 id：`plan-injector`
- 消费面：—（无直接 import/ctx 引用——运行时通道注入）

### `ctx.overlays` — OverlayService（贡献通道）

画布覆盖层通道（Stage-4）：创作坞/目次带等视口固定形态经此注册， 由 PaperPanel 在对应槽位渲染。

- owner：`src/composition/overlay-service.ts`
- 默认实现 / 贡献者 id：`asset-rack` · `compose-dock` · `paper-minimap` · `toc-strip`
- 消费面（2）：`src/plugins/builtin/compose-dock/index.ts` · `src/plugins/builtin/paper-minimap/index.ts`

### `ctx.panels` — PanelsService（贡献通道）

面板注册表（S1-1）——def 注册 → disposer；即时生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`canvas-sidebar` · `canvas-spine` · `paper` · `settings`
- 消费面（3）：`src/plugins/builtin/canvas-nav/index.ts` · `src/plugins/builtin/paper-shell/index.ts` · `src/plugins/builtin/settings-domain/index.ts`

### `ctx.prompts` — PromptsService（贡献通道）

system-prompt 段落注册表（A-1 第六贡献通道）——段注册 → disposer； 下次 Agent 装配生效。

- owner：`src/composition/prompt-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（1）：`src/plugins/builtin/prompt-segments/index.ts`

### `ctx.renderers` — RenderersService（贡献通道）

块渲染器注册表（V3b 第五贡献通道）——def 注册 → disposer；即时生效。

- owner：`src/composition/renderer-service.tsx`
- 默认实现 / 贡献者 id：—
- 消费面（6）：`src/plugins/builtin/host-modules.ts` · `src/plugins/builtin/paper-renderers/index.tsx` · `src/plugins/builtin/paper-shell/host.ts` · `src/plugins/builtin/renderers/components.tsx` · `src/plugins/builtin/renderers/index.tsx` · `src/plugins/service-plugins.ts`

### `ctx.tools` — ToolsService（贡献通道）

工具注册表（S1-1）——行注册 → disposer；下次 Agent 装配生效语义。

- owner：`src/composition/services.ts`
- 默认实现 / 贡献者 id：`communication-tools` · `compaction-tools` · `converge-tools` · `discovery-tools` · `hologram/browser-desktop-domain/tools` · `merge-tools` · `request-tool` · `spawn-tool`
- 消费面（4）：`src/plugins/builtin/browser-desktop-domain/index.ts` · `src/plugins/builtin/contribution-helpers.ts` · `src/plugins/mcp-bridge.ts` · `src/plugins/tool-declarations.ts`

## 服务

| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |
|---|---|---|---|---|
| `ctx.activation` | `ActivationService` | `src/composition/activation-service.ts` | — | 1 文件 |
| `ctx.agentLoop` | `AgentLoopService` | `src/plugins/builtin/agent-loop-service/index.ts` | — | 0 文件 |
| `ctx.codeRuntime` | `CodeRuntimeService` | `src/agent/code-run/runtime-service.ts` | — | 0 文件 |
| `ctx.dynamicRunner` | `DynamicRunnerService` | `src/agent/dynamic-runner/dynamic-runner-service.ts` | — | 0 文件 |
| `ctx.lsp` | `LspService` | `src/ui/lsp-client.ts` | — | 0 文件 |
| `ctx.space` | `SpaceService` | `src/composition/space-service.ts` | — | 1 文件 |

### `ctx.activation` — ActivationService（服务）

插件激活账（S6 P3a）——登记 ≠ 激活：组合装配期按插件引用计数， 首次激活启动副作用、归零停止（设计件 §3.5）。

- owner：`src/composition/activation-service.ts`
- 默认实现 / 贡献者 id：—
- 消费面（1）：`src/plugins/loader.ts`

### `ctx.agentLoop` — AgentLoopService（服务）

agent loop 注册表（平台化 Phase 5 · D13；S5b 产物化后类本体在 plugins/builtin/agent-loop-service/——此声明用结构面，内核/产物 双域类型检查共享）。

- owner：`src/plugins/builtin/agent-loop-service/index.ts`
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
- 消费面（1）：`src/plugins/builtin/compose-dock/index.ts`

