# 兰台文档索引

> 收敛日期：2026-08-17。原则：**根目录只放入口与规则；docs/ 按用途分层；完成即归档。**
> 找文档先看本页；本页没有的再去 `docs/archive/`，归档内容不是现状。

## 入口（按角色）

| 角色 | 先读 | 说明 |
|---|---|---|
| 用户 / 想跑起来 | [`README.md`](../README.md) | 定位、安装、快速开始、构建 |
| 贡献者 | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | 提交流程、门禁、结构 |
| 想写插件 / 贡献插件 | [`PLUGINS.md`](../PLUGINS.md) | 插件开发指南：从零到跑通到发布（根目录入口） |
| 内置兰台 Agent / Claude Code | [`CLAUDE.md`](../CLAUDE.md) | 唯一权威 L0 文件：每次会话自动注入的硬约束 + 门禁 + 指针 |
| Codex / 其他项目级 Agent | [`AGENTS.md`](../AGENTS.md) | 薄指针（2026-09-16 起）——强制加载 `CLAUDE.md` 同一套规则 |

## 规则（改动前必读）

1. [`CONVENTIONS.md`](../CONVENTIONS.md) — 编码约定，以代码现状为准。
2. [`INVARIANTS.md`](../INVARIANTS.md) — 已经炸过的雷；改 `src-ui/src/ui/**` / `src-ui/src/agent/**` / Rust 接缝前必读。
3. [`docs/adr/project-constitution.md`](adr/project-constitution.md) — 四条最高架构约定。
4. [`docs/landmine-map.md`](landmine-map.md) — 已知技术债与拆弹状态。
5. 优先级：project-constitution > INVARIANTS > CONVENTIONS > 历史 plan/handoff。

## 现状文档

| 文档 | 状态 | 内容 |
|---|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 当前（2026-08-17 校准） | 系统架构、技术栈、关键决策、验证基线 |
| [`CONTEXT.md`](../CONTEXT.md) | 当前 | 应用级统一词汇（`kind`/`status` 带簇前缀） |
| [`docs/composition/README.md`](composition/README.md) | 当前（2026-08-20 S4 校准） | 组合层用户指南：patch 语法/preset/热重载/涟漪表 |
| [docs/plugins/README.md](plugins/README.md) | 当前（2026-08-28 平台化 P6 平台契约校准） | 插件契约 = 平台契约总览（§0）：贡献通道/seam provider/动态插件/MCP 面/契约版本/信任模型二分 |
| [`docs/agents/engine-plugin-contract.md`](agents/engine-plugin-contract.md) | 当前（契约 v4，2026-08-29） | 引擎开放面契约：模型工具面 / 11 壳专属方法（hidden tools）/ 免编译扩展面（`HOLOGRAM_PLUGIN_DIR` manifest，三类扩展；示例 `examples/engine-plugins/`） |
| [docs/cookbook/](cookbook/) | 当前（2026-09-06 app shell 增补） | 各 seam 指南：llm adapter / subagent provider / fs / shell / session 后端 / 动态插件 / MCP server（graph 后端指南随该 seam 退役删除，2026-09-09） / **软件级插件（app shell 四件套）** |
| [docs/user/develop/publishing-plugins.md](user/develop/publishing-plugins.md) | 当前（2026-08-28 平台化 P6） | 三方发布路径（registry 发布 + 安装 + 信任面） |
| [`docs/MULTI_AGENT_ROADMAP.md`](MULTI_AGENT_ROADMAP.md) | 工作台 | 多 Agent 路线图与已落地能力 |
| [`docs/landmine-map.md`](landmine-map.md) | 当前 | 雷区地图、拆弹批次状态 |
| [`docs/facts.generated.md`](facts.generated.md) | 生成物 | **文档事实单一真源**（跨文档复述的标量：字段数/插件数/契约版本/域数…）——L0-L2 层文档禁止手抄这些数字，只准指本表 |
| [`docs/plans/doc-surface-refactor-plan.md`](plans/doc-surface-refactor-plan.md) | 进行中 | 文档面大重构施工单（四层形态 / 批序 / 完成判据） |

## docs/ 分区

| 目录 | 放什么 | 现状 |
|---|---|---|
| [`adr/`](adr/) | 架构决策记录（编号 ADR + 主题 ADR） | 6 篇，见目录 |
| [`agents/`](agents/) | Agent 操作/事故/对比文档 | 保留：dsh-harness-comparison、platform-bugs-2026-08-13、frontend-rpc-contract（生成物）、engine-plugin-contract（生成物） |
| [`design/`](design/) | 设计定稿与探索 | provider-system-spec、visual-language-ink-brass、mcp-acp-protocol-support、一张纸设计 |
| [`plans/`](plans/) | 待执行/进行中的计划与实验；**竣工即归档** | 入口 [`plans/README.md`](plans/README.md)（现状全景）+ [`plans/HISTORY.md`](plans/HISTORY.md)（里程碑时间轴） |
| [`research/`](research/) | 调研证据与决策 | 入口 [`research/README.md`](research/README.md) |
| [`archive/`](archive/) | 已竣工施工稿、历史 handoff、被取代的 plan | 入口 [`archive/README.md`](archive/README.md) |
| 散件 | 仍在使用的路线图/雷区/回归 runbook | `MULTI_AGENT_ROADMAP.md`、`landmine-map.md`、`p3-regression-runbook.md` |

## 已归档（2026-08-16 收敛）

- `docs/agents/frontend-refactor-handoff.md` → `docs/archive/frontend-refactor-handoff.md`（前端重构施工史）
- `docs/agents/p0-demining-handoff.md` / `p1-demining-handoff.md` → `docs/archive/`
- `docs/architecture-refactor-spec.md`、`docs/agent-shell-hardening.md` → `docs/archive/`
- `docs/plans/graph-id-refactor-plan.md`、`tool-convergence-browser-plan`、`browser-cdp-suite-plan` → `docs/archive/`
- `docs/code-graph-tools-gap-report.md` → `docs/research/`
- `docs/ARCH_ACTION_PLAN.md` → `docs/plans/arch-action-plan.md`
- `docs/provider-system-spec.md` → `docs/design/provider-system-spec.md`
- `docs/agents/visual-language-ink-brass.md` → `docs/design/visual-language-ink-brass.md`

## 维护规则

0. **事实与体量门禁**：`cd src-ui && npm run doc-check`（六查：事实对拍 / 断链 / 体量 / 孤儿 /
   归档纪律 / 注入预算；`--report` 看全量漂移清单）。**跨文档复述的数字只准来自
   [`docs/facts.generated.md`](facts.generated.md) 或写指针**，禁手抄——改了真源就跑
   `npm run gen:doc-facts`（doc-sync 会对拍）。
1. **完成即归档**：施工稿、交接稿、被取代的 plan 完成后移入 `docs/archive/`，并更新本索引与相关链接。
2. **生成物勿手改**：`docs/agents/frontend-rpc-contract.md` 由 `scripts/gen-rpc-contract-md.cjs` 生成；
   `docs/agents/model-tool-contract.md` 由 `scripts/gen-tool-contract-md.cjs`（经 tsx 运行
   `src-ui/scripts/gen-tool-contract-md.ts`）生成，工具面变更后重新生成并同 commit；
   `docs/agents/engine-plugin-contract.md` 由 `scripts/gen-engine-plugin-contract.cjs` 生成
   （真源 `engine/src/contract.rs` + `engine/src/tools/mod.rs`），随 `npm run doc-sync` 门禁对拍。
3. **数字必须实测**：README / ARCHITECTURE / AGENTS / CONVENTIONS 中的用例数、方法数、语言数等，改动后要重测并标注日期。
4. **工具/RPC/领域动作变更**：同步 `tools/domains.ts` → 根规则文档 → 本索引 → 生成物。
5. 归档文件保留 commit 历史，不删除；历史文件顶部应有「已归档/被取代」说明。
