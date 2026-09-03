# 内核插件运行时（kernel-plugin-runtime）

> 状态：**In progress**（2026-09-03 立项并开工；Phase 0 + Phase 1 首插件 + Phase 1 续批 builtin.web 已落地）
> 拍板源：用户 2026-09-03 完整方案（核心判断原文：「不再区分内核工具/特权工具/普通插件，只有不同权限声明的插件。内核保留的是安全能力和插件运行时，而不是工具业务」）。
> 本文是该方案对本仓现状的落地映射；方案未逐字复述，只记录裁决点。

## 0. 一句话

Rust 壳从「巨型工具包」变成「带安全边界的插件运行时」：工具业务全部搬进可注册的
`ToolPlugin`，前端只消费 Tool Manifest，不再自持工具参数定义。这是插件化工程的
最后一块：前端 webview 插件（P4/S5）、引擎免编译插件（engine Phase 4）、MCP 机器桥
（S4-4 乙）之后，**Rust 执行内核插件化**。

## 1. 现状审计（2026-09-03 实测）

- RPC 单入口 `src-tauri/src/rpc.rs`：迁移前 **146 个方法分支**（生成物 frontend-rpc-contract.md 计数；
  Phase 1 首批 −1 +2 → 147；本批 web −2 → **145**），
  业务实现散在 `commands/` 18 个文件 + `app/services/`。用户方案所述「168」为约数，以生成物计数为准。
- 工具执行链现状：模型 → TS `ToolRegistry`（zod 定义工具面）→ `agentInvoke` → rpc.rs 细粒度分支
  → commands/*.rs 业务。**schema 真源在 TS，执行真源在 Rust，同一工具双端维护**——
  并行窗口当日给 web_search 加 `max_results` 需同时改 Rust 签名 + rpc 分支 + TS zod + 基线 + 契约文档，
  双源漂移税是本立项的直接动因。
- 已有权限/沙箱/审计资产全部可复用：`permissions::Tool` trait（7 实现）、`check_permission`
  （Ask 事件 + 回包等待）、`resolve_read_dispatch`（路径级真权）、`confined_fs`、`AuditLogger`。

## 2. 契约（Phase 0 已落地，代码位置即真源）

- **ToolManifest**（`src-tauri/src/tool_plugins/manifest.rs`）：`{ id, version, trust, description,
  capabilities[], tools[{ name, description, schema, read_only }] }`。`schema` 是给模型看的
  JSON Schema（draft-7）。manifest.json 文件本身是**双端唯一真源**：Rust `include_str!` 编译期内嵌，
  TS 侧由 `scripts/gen-plugin-manifests.cjs` 生成镜像模块（`src-ui/src/agent/tools/kernel-manifests.generated.ts`），
  doc-sync 门禁防漂移。
- **ToolPlugin trait**（`tool_plugins/plugin.rs`）：`id() / manifest() / execute(&ToolContext, tool_name, args)`。
  异步分发用手写 `Pin<Box<dyn Future>>`（仓内无 async-trait 依赖，不为此引入）。
- **ToolContext**（同文件）：`{ agent_id, is_agent, state, app }` + `resolve_read()` 等能力方法。
  v1 有意收窄——sandbox/process/network/credential 句柄随各自 Phase（2/3）进场，不预建空壳。
- **统一入口**：RPC `tool_call { plugin, tool, args }`；执行流 = 查注册表 → 启用校验 →
  工具存在 → 权限引擎（`PluginToolAdapter`）→ 插件 `execute`（内部走既有 `resolve_read_dispatch`
  等真权路径）→ 返回。`plugin_tool_manifests` RPC 返回全量清单供 UI。
- **参数语言**：tool_call 的 `args` 说模型的语言（manifest schema 声明的 camelCase 键），
  不再说旧 RPC 的 snake_case——旧 snake 是 ipc 枢纽的历史产物，插件契约以 manifest 为准
  （`_agent_id` meta 照旧嵌在 args 内透传，INVARIANTS #9 不变）。

## 3. 与既有系统的裁决

| 冲突点 | 裁决 |
|---|---|
| INVARIANTS #8「工具定义必须 defineTool+zod」 | **修订**：单一真源原则不变，真源从「TS zod」改为「Rust manifest」。manifest 驱动的工具不走路由 zod（zod v4 无 JSON-Schema→zod 反向）；运行时校验回归插件侧参数提取（与今日 Rust 命令同强度）。TS 手写 schema + `as` 解包的禁令对非 manifest 工具继续生效 |
| convergence 字节契约 | Phase 1 迁移的 manifest schema = 原 zod 发射字节逐字转录（发射管线 `z.toJSONSchema(draft-7, io:'input')` + `.passthrough()` + 去 `$schema`），三层表序不动 → baseline **零重录**。后续批次 schema 有意变更时走 baseline-change-request 审批 |
| 旧细粒度 RPC 分支 | 迁一批、删一批（分支 + TS 契约行同 commit 删，不留双路）。已退役：search_content、web_search、web_fetch；glob 属 fs 域工具，随 Phase 2 fs 批 |
| 权限模型 | v1 `PluginToolAdapter` 过权限引擎返回 Passthrough（与今日 search 命令无 tool 级门一致），真权在 `resolve_read_dispatch`。Phase 2 fs 写工具进场时引入 `plugin:<id>.<tool>` 规则寻址（需把 `permissions::Tool::name()` 从 `&'static str` 放宽为 `Cow`，已列 Phase 2 首项） |
| 信任分级 | manifest `trust: system/official/third_party`；v1 只注册 system。第三方 + 用户装/卸/能力授予 = Phase 3（持久化接 `plugin_*` 通道） |
| 进度流（onProgress） | v1 search 无流式需求。shell/browser 批进场时经 `tool_call:progress` 事件（`_callId` 键控）回推——Phase 2 设计件，未预建 |

## 4. 阶段表（对应用户方案 Phase 0-4）

| 批 | 内容 | 验收 |
|---|---|---|
| **Phase 0**（本窗） | 契约三件 + 注册表 + `tool_call`/`plugin_tool_manifests` RPC + 内核模块 `tool_plugins/` | cargo test 新增单测；注册表重名拒绝 |
| **Phase 1**（本窗起） | `builtin.search` 插件自 `commands/search.rs` 拆出（search_content）；TS search 域改 manifest 驱动；旧分支退役 | vitest/convergence/build/biome/doc-sync 全绿，baseline 零漂移 |
| Phase 1 续（已落地 2026-09-04） | `builtin.web`（web_search/web_fetch 自 `commands/web.rs`，含并行窗口 64b56542 的 max_results 批转录）；`commands/web.rs` 整文件退役；coding.ts 旧 zod 版 search/web 死码清理；web_fetch 文本结果经分派处 `Value::String` 直通（Text 铁律） | 同上 |
| Phase 2 | 工具域全量迁移：fs / git / shell / editor / constraints / browser / uia / pty / lsp 九域 + glob + 进度流 + `permissions::Tool::name` 放宽（2026-09-04 拍板合并原 Phase 2/3——同质工作按风险排序，域界即批界，无相界）。**进度（2026-09-04 收尾窗）**：P2-0（08c5466f）+ P2-1（87ab054a）+ P2-2（fcd120b4——含基建 A 测试 mock 翻译层 + 基建 B `gen:kernel-manifest` 生成器，manifest schema 自此禁手写）+ P2-3（builtin.git 16 工具，rpc 113 methods）已落地全绿；P2-4~P2-6 未动工 | 每域独立批；拆解与机制见 [`kernel-plugin-runtime-phase2-design.md`](kernel-plugin-runtime-phase2-design.md)（P2-0 基建 → P2-1 constraints/editor → P2-2 fs 主体 → P2-3 git → P2-4 shell+进度流 → P2-5 browser/uia → P2-6 pty/lsp；P2-5 起工前在设计件补权限形状增补节） |
| Phase 3 | **内核插件管理面 = 扩展现有设置面板「插件」tab（非另起 UI）**——S5 已有的 tab（三组陈列/启停/卸载/第三方安装通道，`plugin_set_enabled`/`plugin_uninstall` 消费方是 PluginsPage）管的是 TS/cordis 体系；本相给内核 Rust ToolPlugin 注册表补管理面：内核插件分组消费 `plugin_tool_manifests`（今日零消费方）+ 启停持久化（`is_enabled` 从信任级硬编码接 `plugin_*` 通道；禁用语义 = 装配期工具面移除 + tool_call 拒绝双闸，TS 镜像是编译期生成）+ 能力展示/授予 + 审计入口；第三方内核插件装载通道（manifest 目录装载，对齐 TS 出厂产物磁盘通道先例） | 现有 tab 内验收；第三方内核插件端到端可装可卸可审计 |
| 终态 | rpc.rs 只余 `tool_call` + 生命周期族（workspace_/plugin_/credential_/permission_/audit_/sandbox_status）；`commands/` 业务目录退役 | 守卫测试钉死分支上限 |

## 5. 本窗已知残留（非挂起，均有下落）

- ~~`commands/web.rs` 拆出顺延~~（已落地，见 §4 Phase 1 续行）。
- ~~`agent/tools/coding.ts` 旧 `createSearchTools`（zod 版）成为死码~~（已删，web 域 zod 版同批清理；A/B 试验 harness 经 tool_call 解信封适配器续用 manifest 工具）。
- `commands/search.rs` 仅余 glob（fs 域，随 Phase 2 fs 批迁移）。
- 生成器 `gen:plugin-manifests` 已挂 doc-sync 门禁。

## 6. 终止条件

全部 Phase 3 完 + rpc 分支守卫测试上线 + 第三方插件可装可卸可审计。
