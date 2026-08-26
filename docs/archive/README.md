# docs/archive — 已归档文档

> 归档原则：已竣工的施工稿、交接稿、被取代的 plan 放这里。**归档 = 历史记录，不是现状依据。**
> 当前约定以根目录 `CONVENTIONS.md` / `INVARIANTS.md` 与 `docs/README.md` 索引为准。

## 主要归档（2026-08-16 收敛；2026-08-22 深夜文档规整追加）

- **前端重构**：`frontend-refactor-handoff.md`、`architecture-refactor-spec.md`、`visual-deepening-plan.md`、`main-view-layout-plan.md`、`icon-design-spec.md`
- **拆弹交接**：`p0-demining-handoff.md`、`p1-demining-handoff.md`、`engine-p0-resolution-handoff-2026-08-15.md`
- **已完成施工规格**：`graph-id-refactor-plan.md`（R0–R10 竣工）、`tool-convergence-browser-plan-2026-08-08.md`、`browser-cdp-suite-plan-2026-08-13.md`
- **被取代方案**：`agent-shell-hardening.md`（被 `docs/plans/shell-stability-bundled-bash-plan.md` 取代并落地）
- **早期设计/性能史**：`COMMUNICATION_LAYER_DESIGN.md`、`DATA_FLOW_ARCHITECTURE.md`、`GRAPH_DRIVEN_SEARCH_DESIGN.md`、`MULTI_AGENT_STATUS.md`、perf 系列、star-map 系列、phase4 设计等
- **清理记录**：audit-fix 系列、async-spawn 系列、framework-expansion-plan
- **2026-08-22 深夜归档（竣工计划全文）**：`workspace-flip/`（目录）、`agent-core-convergence/`（目录，含活流程文件 baseline-change-request.md）、`cordis-migration/`（目录）、`ui-react-island-retirement-plan.md`、`eventbus-zero-and-ui-split-plan.md`
- **2026-08-22 深夜归档（已消费交接稿）**：`design-handoff-lantai-2026-08-22.md`（兰台注疏设计定稿交接——全部落地后退役；产物为 `prototype/lantai.html` + `docs/design/lantai-design-spec.md`）
- **2026-08-22 S3 竣工归档**：`composition-architecture-S3-settings-domain-externalization.md`（S3 settings 域行化设计件——六裁决两批落地后随段竣工归档；施工史与落地记录在 `docs/plans/composition-architecture/HISTORY.md` S3 段）
- **2026-08-23 归档**：`arch-action-plan.md`（any 清理 + agent.ts 拆分等架构行动全集——11c/14 全收官后退役；现状叙事由 CONVENTIONS/AGENTS 承接）
- **2026-08-24 归档（会话线连续三棒）**：`session-ledger-plan.md`（案卷总目 L0-L3 竣工，2026-08-24 merge `e677c5c8`；后续由 session-unify 继承身份/发号机制）、`workspace-ownership-root-cure-handoff.md`（工作区归属根治五 Phase + boot 序洞真根因，实机验收通过；DSH 对标事实源清单）。活线见 `docs/plans/README.md`「会话 / 分层 / 画布三线」。
- **2026-08-26 归档（baton 交接棒系列全量）**：`lantai-handoff/`（目录，baton6–baton18 全部 13 棒）——baton 制退役，后续不写交接棒；当前状态与下一步以 `docs/plans/README.md` 为准。

## 使用规则

- 新窗口/新 Agent 默认**不需要**读本目录；需要理解“为什么当时这么做”时再按文件名检索。
- 本目录文件不删除、不重写内容（只修死链）；有新结论写新文档，不回来改历史。
