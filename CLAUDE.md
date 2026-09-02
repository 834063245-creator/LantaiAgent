# CLAUDE.md — 兰台（Lantai）项目规范

> ## ⚡ 破坏性操作授权（最高优先级，2026-08-25 用户拍板）
>
> ### 授权（行为面——以下全部明文允许，无需再问）
>
> **用户允许 Agent 对代码库进行重构、清理、架构整理等破坏性操作，一切由测试工程兜底，以结果论对错。**
> 具体放宽（未尽事项按此精神类推）：
>
> 1. **删代码、删文件、删模块**：不合理的行为、死代码、过时抽象——直接删，不留注释尸体，不写「deprecated 保留一个版本」。
> 2. **改公开行为**：函数签名、参数、返回形状、RPC 契约、存储格式——发现不合理的直接改，不造兼容层、不写双读、不搞渐进迁移（除非用户明确要求保留过渡期）。
> 3. **改架构**：移动文件、拆分/合并模块、重画层边界、删除整层——按目标架构直接落位，git mv 保历史即可，不因「动静太大」而绕行。
> 4. **改数据约定**：旧数据不迁移、直接归档（.bak 挪位、代码永不回读）是被认可的标准操作；旧格式读不进来就让它不存在。
> 5. **推翻 Agent 自己之前的方案**：上一轮做错了就整段撤销重做（撤销预留-领取制是先例），不为沉没成本辩护。
> 6. **连带清理**：修 A 时发现 B 也是同类病灶，允许顺手把 B 一并拆掉（测试同步更新），不必为「最小 diff」原则留下病灶。
>
> **判定原则：发现旧的不合理行为，默认拆除而非兼容；兼容层只在用户明确要求时建；拆干净比绕着走重要。**
>
> ### 铁律（测试面——授权的边界，一条不可协商）
>
> **一切破坏性操作由测试工程兜底：**
> 1. **动刀前**：受影响面的测试先跑一遍，确认基线状态（绿/红都要知道）。
> 2. **动刀中**：删除行为时同步删除/改写为它服务的测试；测试不许为旧行为陪葬，也不许假装没看见。
> 3. **动刀后**：对应验证门禁必须全绿才允许 commit（engine/storage/vector/graph：`cargo test`；src-ui：`vitest` + `build` + `biome ci` 0/0；组合层：`verify:convergence`）。门禁红着就是没改完，不许「先 commit 以后修」。
> 4. **行为变更**：用户可感知的行为变了（哪怕变对了），在 commit message 里写清楚变了什么——结果论对错的前提是结果可查。
>
> 背景：LLM 的天性是保守兼容（读旧代码后本能往上堆、兼容旧行为/参数/存储），本项目的历史包袱（铺卷化石等三轮「重构」都绕着旧时序走）正是破坏性操作干得不彻底留下的。本条款反转该默认值：**在此仓库，破坏性操作是常态，保守兼容才需要理由。**

> 本文件由 AgentRuntime 在创建每个会话时读入 system prompt（`src-ui/src/agent/runtime/runtime.ts`），
> 对 Claude Code 直接生效；Codex 读 `AGENTS.md`，而 `AGENTS.md` 强制加载同一套规则。
> 命名架构（2026-08-22）：应用 = 兰台 / Lantai；HoloGram = 图谱引擎专名（工具域 `hologram(...)`、`.lantai/`、`HOLOGRAM_*` env 不改）。

## 规则优先级

`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 本文件 > 历史 plan/handoff。
有冲突时以左边为准；无法判断就停下来问用户。

## 开工顺序（不可跳过）

1. **动任何代码前，先读根目录 `CONVENTIONS.md` 和 `INVARIANTS.md`。** 没读不要改文件。
2. 修改 `src-ui/src/ui/**` 或 `src-ui/src/agent/**` 前，逐条核对 INVARIANTS，并 grep 目标文件的 `⚠️ INVARIANT` 注释。
3. 改高 fan-in 文件前先查图影响面：内置工具用 `graph(preflight)` / `graph(impact)`；外部 MCP 用 `preflight_check` / `trace_impact`。
4. 在代码库里找做同类事的文件，复制它的模式。不要发明新的状态、通信、工具定义或错误处理方式。

## 硬约束

- **四条架构约定**（最高）：类型边界 / 单一权威源 / 异步纪律 / 错误不静默。详见 `docs/adr/project-constitution.md`；新代码违反即返工。
- **前端**：React 19 + Zustand 5。跨组件业务状态走 zustand store（面板级走 `createScopedStore` 注册表）；事件总线已归零（`ui/events.ts` 已删除，禁复活——不要 window.dispatchEvent / CustomEvent / 自建 EventEmitter）。分层终态：store 一律 `src/state/`、`src/scene/` 仅存星图类型模块 graph-types.ts（C13 sweep 2026-08-22：Three.js 渲染面已删，StarGraph 为兼容形状）、`src/ui/` 残余 = chat 编排域核心 + 旧层命令式基础设施（见 `src/ui/README.md`）；新组件落 `src/app/**`。聊天消息原地 mutate 后必须 `touchMessage` / `touchMessageContaining`。
- **RPC**：前端调后端一律 `typedRpc` / `typedListen`（`src-ui/src/rpc-contract.ts`）；参数键 snake_case。新增后端方法同步 `src-tauri/src/rpc.rs` + `RpcContract`，生成文档用 `scripts/gen-rpc-contract-md.cjs`。受权文件之外裸 `rpc` 会被 biome 拦截。
- **工具**：模型工具必须 `defineTool` + zod v4；领域动作变更同步 `DOMAIN_SPECS` / `collectHiddenToolNames()` / 测试。禁止手写 schema、execute 里 `as` 强拆、用 `.strict()`。
- **Agent 运行时**（组合架构 S1 三层 + S2 外化 + S4 preset realm/热重载/安装通道，2026-08-20 起）：内置工具族（①c 后仅 web/browser-desktop 2 行）加行到 `src/composition/tool-rows.ts` 行表；第一方工具域插件（B①/② 无状态五族 + ①c 装配期真值七族 wait/ask/memory/skill/task/agent/hologram）经 `plugins/coding-domain-plugins.ts` + `composition/first-party-tools.ts` 清单走 ctx.tools 贡献（无状态族实例缓存；真值族贡献 noCache 每装配重创）；system-prompt 段落定义留 `src/composition/prompt-sections.ts` 单一真源（分隔符是字节契约禁规整；P4 B④ 收官起 13 段全量经 `plugins/prompt-segments-plugin.ts` 走 ctx.prompts 通道贡献，出厂段表退役）；插件 prompt 段贡献（P4 A-1）经 `ctx.prompts`（`composition/prompt-service.ts`）下次装配生效；S4-4 甲（2026-08-23）组合解析域收编通道贡献——factoryComposition() 快照 pluginToolRows 行 + prompt 段贡献，patch/preset 可寻址 plugin/<贡献 id> 行与贡献段 id（含 13 第一方段）；**平台化 P3（2026-08-27）seam 裁剪域**——factoryComposition() 收编七条 `seam/<域>` 寻址域（llm/subagents/fs/shell/sessionPersistence/graph/loopEvents），patch/preset 可禁用 provider、开关 emit 观测事件（消费视图 = 活动注册表 − 禁用集，过滤收在 active* 消费单点与 emitLoopEvent；目录生成 `gen-service-catalog`/`gen-event-catalog` + `doc-sync` 门禁 + 开放面契约版本 `composition/contract-version.ts`）；**平台化 P4（2026-08-27）运行时插件全链路**——D6 外部插件装/卸/启用/禁用**运行时生效**（loader 活跃注册表 + activate/deactivateExternalPlugin，fiber dispose 链式回收）；D7 `ctx.dynamicRunner`（agent/dynamic-runner/）——模型经 **cordis 域**（define/run/stop/undefine/inspect，形状对齐 DSH tool-cordis）运行时定义插件包：approval 门（首激活 UI 批准）+ 宿主半沙箱（危险全局阴影 / 守卫注册面 / 预算三层防线）+ 包不可变/失败回滚/会话所有权隔离；进程外能力面收口 = `examples/plugins/dataflow-mcp/`（外部 MCP server 端到端例子，`./` 前缀 args 相对插件目录解析）；信任模型见 `docs/plugins/README.md` §6；**平台化 P5（2026-08-28）存量迁移**——D13 `ctx.agentLoop`（agent/agent-loop/：AgentLoop/AgentLoopHost + builtin/default + 注册表后注册胜）流式循环降为第一方默认实现（行为逐字节一致）；工具管道生产路径切 eventBus（构造期 attachPlanGate + setters 各自 attach；差分 trace 钉住等价）；第一方 loop 可观测监听器 observability.ts；P5-C1/C2 守卫测试 first-party-surface + agent-loop-seam；**平台化 P6（2026-08-28）平台税收口**——插件面人类契约 = `docs/plugins/README.md`（§0 平台契约总览）；各 seam cookbook = `docs/cookbook/`；三方发布路径 = `docs/user/develop/publishing-plugins.md`；跨 seam 替换集成 = `tests/cross-seam-swap.test.ts`；会话级工具/hook 加项到 `agent/blueprint.ts` capability 表，不改 `AgentConfig`（冻结 31 字段）。三层表序 = 字节契约（前缀缓存 + effective 快照依赖）；teardown 走 `ctx.effect`，不做进 capability。session 变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三入口；改工具折叠同步 `session-log.ts` 的 `derivePayload`。**S2 起**：用户层 patch（`~/.lantai/composition/roster.patch.yml` → `composition/roster.ts` `resolveRoster`）可禁用/覆盖/插入四域行（语法见 `docs/composition/README.md`；寻址域 = builtin 行表 + 通道贡献快照（S4-4 甲：plugin 贡献行/段可寻址禁用/覆盖/锚定））；10 壳行（`composition/shell-rows.ts` + `src/shell/rows/*` + `src/shell/boot.ts`）承载引导职责——新引导接线加壳行，不往 main.ts 堆。**S4 起**：四 service 消费闭环已接线（面板 `panelDefs()` 合流 / 命令面板折算 / 插件工具行 `plugin/<贡献 id>` 折算进 buildToolRegistry）；**V3b 起**：第五贡献通道 `ctx.renderers` 块渲染器（`composition/renderer-service.tsx`——纸壳块体渲染经 `resolveRenderer(kind)` 解析，后注册胜 + `*` 兜底）+ 纸面板迁 PanelsService 贡献（`paper/paper-plugin.ts`，panel-def 常量面已迁出 paper 行）；preset realm（`composition/presets.ts` 内置表 + `preset-discovery.ts` 用户目录 + `preset-assembly.ts` cache/选择同步；层序 factory → 用户层 → preset；装配面可选 composition 覆盖参数）；热重载（composition_watcher → `composition:changed` → `reloadCompositionPatch`）；插件安装通道（`plugin_install`/`plugin_uninstall`/`plugin_set_enabled` + `plugin_dir`（S4-4 乙机器桥的目录锚点） + 设置「插件」tab；manifest `mcpServers` 声明式挂接外部 MCP server（S4-4 乙：一 server 一条贡献行 plugin/<插件名>/mcp/<server名>，lazy/startup-error 失败策略，kill 挂插件 fiber disposer）；插件自包含无裸 import——宿主桥 `window.__lantai_plugin_host__`，范本 `examples/plugins/hello/`，契约 `docs/plugins/README.md`）。**S3 起（2026-08-22）**：第一方域行化先例——settings 域经 `plugins/settings-plugin.ts` 双贡献（面板 + 命令）、paper 域补齐 `paper/toggle`；`PANEL_DEFS` 常量面清空（全量面板走贡献）；快捷键链路经 `app/actions.ts` 别名翻译层（`ACTION_CONTRIBUTION_ALIASES`）桥接，useGlobalKeys 字面量不变。**P4 起（2026-08-23）**：第六贡献通道 `ctx.prompts`（`composition/prompt-service.ts`）——插件注系统提示段落，`assembleSystemPrompt` 末端追加。以上全部门禁化：`npm run verify:convergence` 失败即返工（standard preset 快照零漂移）。
- **第一方插件清单**（2026-08-29 立账；2026-09-03 S5 竣工后 44 个 = 15 内核 + 29 出厂产物）：`plugins/first-party-manifest.ts` = 第一方插件身份单一真源（kind 降级为展示分组标签——`service` 内核不可禁 / `feature` 出厂产物可禁用）；设置面板「插件」tab 三组陈列（平台服务/内置插件/已安装）；feature 启用/禁用经 `state/plugin-prefs.ts`（localStorage）**下次启动生效**；装载统一收 `state/plugin-store.ts`。**S5（2026-09-03）：BUILTIN_PLUGINS 只装 15 内核；29 出厂产物真源在 `plugins/builtin/<name>/`（磁盘通道装载，改插件 = 换产物不重编译 exe）；dev 模式经 `plugins/factory-products.ts` 的 import.meta.env.DEV 分支走源码路径；装载调度 = cordis fiber PENDING + `plugins/boot-gate.ts` 全 ACTIVE 审计 fail-loud**。**新增出厂产物 = 产品目录建 index.ts + manifest.json + factory-products.ts 加行 + 清单加条目**（守护 `tests/first-party-manifest.test.ts`）。
- **Rust**：生产代码零裸 `.unwrap()`（测试模块除外）。锁中毒用 `lock_or_recover` / `read_or_recover` / `write_or_recover`（src-tauri），engine 用 `unwrap_or_else(|e| e.into_inner())`。失败必须可见，写入/持久化错误不得静默吞。
- **Windows 路径**：拆 `location` 的 `文件:行` 只拆最后一个冒号（`rsplit_once(':')`），不要吃掉 drive letter。
- **不改的**：`graph-layout.ts` / `gpu-layout.ts` 的布局参数、`.github/workflows/ci.yml`、Python 引擎路径（已退役，不要恢复）。
- **产品输出纪律**：应用的程序层只呈现图数据，不替用户推断 bug 根因/解释因果。这条限制的是你写进产品 UI/工具输出的内容；你排查问题时照常推理，结论写在回复/计划/代码注释里。

## 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build`（tsc --noEmit + vite build） |
| 前端逻辑 | `cd src-ui && npx vitest run` |
| 前端格式 | `cd src-ui && npx biome ci .`（**0/0 已归零**，2026-08-24 存量清零后保持；改动文件 `npx biome check --write <改动文件>` 后提交） |
| Agent 运行时/组合层 | `cd src-ui && npm run verify:convergence`（T0 静态 + 8 baseline 对拍 + system-prompt.fixture；record 永不上 CI，baseline 变更走 change request 审批） |
| 引擎 | `cd engine && cargo test`（快验 `cargo build`） |
| 壳 | `cd src-tauri && cargo check`；权限/锁/IPC/命令改动跑 `cargo test` |
| 桌面打包 | `cd src-tauri && cargo tauri build`（会自动先跑前端构建；根目录 `build.cmd` 是 Windows 包装） |

禁止用 `cargo build --release` 代替桌面发布验证。当前实测基线：engine lib 592 · hologram-graph 53 + doc 1 · src-tauri bins+lib 411 + 集成 1（2026-08-29 引擎插件化 Phase 4 竣工实测，含进程级 e2e；**hologram-engine 依赖已摘——引擎 = 进程外消费**；**Phase 4 免编译扩展面 = plugins 模块 + HOLOGRAM_PLUGIN_DIR manifest（language/framework/tool）+ engine_status.extensions，契约 v4，示例 examples/engine-plugins/**）· 前端 203 文件 1895 passed / 4 skipped（2026-08-29 Phase 3 实测；convergence 双 preset 零漂移）。基线细则以 `AGENTS.md` §10 为准。

> ⚠ **本机 NODE_ENV=production 注入的两刀（2026-08-29 实测扩写，细则见 AGENTS.md §10）**：Cowork/codely 进程链给子 shell 注入 `NODE_ENV=production`——① vitest jsdom UI 测试大面积假红（`act is not a function` + `No such built-in module: node:`）；② **`npm install` / `npm uninstall` 同样中招：剥掉 devDependencies**（`Cannot find package 'vitest'`，.bin shim 丢失）。**纪律：本机凡 npm/vitest 命令一律先 `$env:NODE_ENV='test'`**；中招恢复 = 清变量 → `npm install` → 必要时 `npm rebuild`。

## 项目快照

- **定位**：把代码库解析成可对话的依赖星图，并内置多 Agent 编码工作台。桌面应用 = Tauri 2 + Rust 引擎 + TypeScript/React 19 + Three.js + Monaco。
- **工具层**：模型可见工具面以生成物为准：`docs/agents/model-tool-contract.md`（由 `npm run gen:tool-contract` 从 ToolRegistry 装配产物生成，勿手改；域折叠形态 + action 枚举 + 参数说明 + 隐藏旧名附录）。会话级 capability 工具（`Skill` / plan / 通信族 / `code_execution` 执行原语）经 blueprint 装配，契约由 convergence 快照钉住。`code_execution`（P2/P3，2026-08-23）：程序体经 ctx.codeRuntime 服务（agent/code-run/runtime-service.ts）在 Web Worker 沙箱执行，程序内 `await tools.<name>(args)` 嵌套调全部可见工具（审计逐条落 session-log，门禁/hooks/截断不豁免，读并行写串行）。旧工具名（`run_shell`、`write_file`、`git_*`、`search_symbols` 等）已淘汰，模型调用会被重定向。
- **图优先**：`graph(symbols/impact/preflight/...)` 是改代码前的工作流入口，grep 只做兜底。
- **现状文档**：先查 `docs/plans/README.md`（计划现状入口——现在在哪/还剩什么/谁判断；里程碑史在 `docs/plans/HISTORY.md`）；项目手册 `AGENTS.md`、架构 `ARCHITECTURE.md`、词汇 `CONTEXT.md`、多 Agent 工作台 `docs/MULTI_AGENT_ROADMAP.md`。`docs/archive/` 是历史，勿作现状。
