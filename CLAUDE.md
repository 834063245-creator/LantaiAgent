# CLAUDE.md — 兰台（Lantai）项目规范

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
- **Agent 运行时**（组合架构 S1 三层 + S2 外化 + S4 preset realm/热重载/安装通道，2026-08-20 起）：内置工具族加行到 `src/composition/tool-rows.ts` 行表；system-prompt 段落加段到 `src/composition/prompt-sections.ts`（分隔符是字节契约禁规整）；会话级工具/hook 加项到 `agent/blueprint.ts` capability 表，不改 `AgentConfig`（冻结 31 字段）。三层表序 = 字节契约（前缀缓存 + effective 快照依赖）；teardown 走 `ctx.effect`，不做进 capability。session 变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三入口；改工具折叠同步 `session-log.ts` 的 `derivePayload`。**S2 起**：用户层 patch（`~/.lantai/composition/roster.patch.yml` → `composition/roster.ts` `resolveRoster`）可禁用/覆盖/插入四域行（语法见 `docs/composition/README.md`）；12 壳行（`composition/shell-rows.ts` + `src/shell/rows/*` + `src/shell/boot.ts`）承载引导职责——新引导接线加壳行，不往 main.ts 堆。**S4 起**：四 service 消费闭环已接线（面板 `panelDefs()` 合流 / 命令面板折算 / 插件工具行 `plugin/<贡献 id>` 折算进 buildToolRegistry）；**V3b 起**：第五贡献通道 `ctx.renderers` 块渲染器（`composition/renderer-service.tsx`——纸壳块体渲染经 `resolveRenderer(kind)` 解析，后注册胜 + `*` 兜底）+ 纸面板迁 PanelsService 贡献（`paper/paper-plugin.ts`，panel-def 常量面已迁出 paper 行）；preset realm（`composition/presets.ts` 内置表 + `preset-discovery.ts` 用户目录 + `preset-assembly.ts` cache/选择同步；层序 factory → 用户层 → preset；装配面可选 composition 覆盖参数）；热重载（composition_watcher → `composition:changed` → `reloadCompositionPatch`）；插件安装通道（`plugin_install`/`plugin_uninstall`/`plugin_set_enabled` + 设置「插件」tab；插件自包含无裸 import——宿主桥 `window.__lantai_plugin_host__`，范本 `examples/plugins/hello/`，契约 `docs/plugins/README.md`）。**S3 起（2026-08-22）**：第一方域行化先例——settings 域经 `plugins/settings-plugin.ts` 双贡献（面板 + 命令）、paper 域补齐 `paper/toggle`；`PANEL_DEFS` 常量面清空（全量面板走贡献）；快捷键链路经 `app/actions.ts` 别名翻译层（`ACTION_CONTRIBUTION_ALIASES`）桥接，useGlobalKeys 字面量不变。以上全部门禁化：`npm run verify:convergence` 失败即返工（standard preset 快照零漂移）。
- **Rust**：生产代码零裸 `.unwrap()`（测试模块除外）。锁中毒用 `lock_or_recover` / `read_or_recover` / `write_or_recover`（src-tauri），engine 用 `unwrap_or_else(|e| e.into_inner())`。失败必须可见，写入/持久化错误不得静默吞。
- **Windows 路径**：拆 `location` 的 `文件:行` 只拆最后一个冒号（`rsplit_once(':')`），不要吃掉 drive letter。
- **不改的**：`graph-layout.ts` / `gpu-layout.ts` 的布局参数、`.github/workflows/ci.yml`、Python 引擎路径（已退役，不要恢复）。
- **产品输出纪律**：应用的程序层只呈现图数据，不替用户推断 bug 根因/解释因果。这条限制的是你写进产品 UI/工具输出的内容；你排查问题时照常推理，结论写在回复/计划/代码注释里。

## 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build`（tsc --noEmit + vite build） |
| 前端逻辑 | `cd src-ui && npx vitest run` |
| 前端格式 | `cd src-ui && npx biome check --write <改动文件>`（全仓 588 errors/335 warnings 是存量基线，只保证自己零新增） |
| Agent 运行时/组合层 | `cd src-ui && npm run verify:convergence`（T0 静态 + 8 baseline 对拍 + system-prompt.fixture；record 永不上 CI，baseline 变更走 change request 审批） |
| 引擎 | `cd engine && cargo test`（快验 `cargo build`） |
| 壳 | `cd src-tauri && cargo check`；权限/锁/IPC/命令改动跑 `cargo test` |
| 桌面打包 | `cd src-tauri && cargo tauri build`（会自动先跑前端构建；根目录 `build.cmd` 是 Windows 包装） |

禁止用 `cargo build --release` 代替桌面发布验证。当前实测基线：engine 697 tests（696 passed / 1 ignored）· src-tauri bin 389 + 集成 14（全绿；2026-08-22 第 5 棒实测，含 rpc Value 化第二步；cdp e2e 偶现 ±1）· 前端 147 文件 1473 passed / 1 skipped（2026-08-22 第 5 棒实测，+rpc-value-shapes 守护；convergence 零漂移）。

## 项目快照

- **定位**：把代码库解析成可对话的依赖星图，并内置多 Agent 编码工作台。桌面应用 = Tauri 2 + Rust 引擎 + TypeScript/React 19 + Three.js + Monaco。
- **工具层**：模型可见工具面以生成物为准：`docs/agents/model-tool-contract.md`（由 `npm run gen:tool-contract` 从 ToolRegistry 装配产物生成，勿手改；域折叠形态 + action 枚举 + 参数说明 + 隐藏旧名附录）。会话级 capability 工具（`Skill` / plan / 通信族 / `code_execution` 执行原语）经 blueprint 装配，契约由 convergence 快照钉住。`code_execution`（P2/P3，2026-08-23）：程序体经 ctx.codeRuntime 服务（agent/code-run/runtime-service.ts）在 Web Worker 沙箱执行，程序内 `await tools.<name>(args)` 嵌套调全部可见工具（审计逐条落 session-log，门禁/hooks/截断不豁免，读并行写串行）。旧工具名（`run_shell`、`write_file`、`git_*`、`search_symbols` 等）已淘汰，模型调用会被重定向。
- **图优先**：`graph(symbols/impact/preflight/...)` 是改代码前的工作流入口，grep 只做兜底。
- **现状文档**：先查 `docs/plans/README.md`（计划现状入口——现在在哪/还剩什么/谁判断；里程碑史在 `docs/plans/HISTORY.md`）；项目手册 `AGENTS.md`、架构 `ARCHITECTURE.md`、词汇 `CONTEXT.md`、多 Agent 工作台 `docs/MULTI_AGENT_ROADMAP.md`。`docs/archive/` 是历史，勿作现状。
