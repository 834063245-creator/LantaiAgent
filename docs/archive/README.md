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
- **2026-08-22 S3 竣工归档**：`composition-architecture-S3-settings-domain-externalization.md`（S3 settings 域行化设计件——六裁决两批落地后随段竣工归档；施工史与落地记录在 `docs/archive/composition-architecture/HISTORY.md` S3 段）
- **2026-08-23 归档**：`arch-action-plan.md`（any 清理 + agent.ts 拆分等架构行动全集——11c/14 全收官后退役；现状叙事由 CONVENTIONS/AGENTS 承接）
- **2026-08-24 归档（会话线连续三棒）**：`session-ledger-plan.md`（案卷总目 L0-L3 竣工，2026-08-24 merge `e677c5c8`；后续由 session-unify 继承身份/发号机制）、`workspace-ownership-root-cure-handoff.md`（工作区归属根治五 Phase + boot 序洞真根因，实机验收通过；DSH 对标事实源清单）。活线见 `docs/plans/README.md`「会话 / 分层 / 画布三线」。
- **2026-08-26 归档（baton 交接棒系列全量）**：`lantai-handoff/`（目录，baton6–baton18 全部 13 棒）——baton 制退役，后续不写交接棒；当前状态与下一步以 `docs/plans/README.md` 为准。
- **2026-09-16 归档（文档面重构 P3 · 归档大扫除）**：竣工线与计划整批移出 `docs/plans/`——
  - `composition-architecture/`（目录整树：README + HISTORY + designs×5 + reports×2 + work-orders×7）——组合架构 S0-S6 全段竣工；
    **S7「真面板并排」是 ⏸ 搁置件随线归档，重启该批时取回重新立项**（其 §0.5/§0.6）。
  - `agent-platformization-plan.md`（平台化 Phase 0-6 全竣工）· `plugin-bundle-retirement-plan.md`（插件 bundle 退役）·
    `builtin-plugin-roster-single-source.md`（内置插件名册单一真源）· `frontend-overlay-a11y-plan.md`（前端浮层/焦点/a11y 修复）·
    `handoff-p2-window.md`（内核插件运行时 Phase 2 竣工窗交接记录——该线已随 v3 拆除令作废）。
  - 以上各件顶部均已加「已归档（2026-09-16 · P3）」横幅与现状指针；现状入口一律 `docs/plans/README.md`。
- **2026-09-16 归档（文档面重构 P3b 补批 · 竣工但没写横幅的件）**：`archive` 查只看头部 15 行横幅，
  这批因此漏网；逐条取证（头注 + `docs/plans/README.md` 真机欠账表）后归档——
  - `engine-plugin-extraction.md`（引擎插件化 Phase 0-5）· `layering-rework-plan.md`（分层重构 L1-L4 + L5b；真机四项已闭）·
    `first-party-hot-reload-plan.md`（第一方热更）· `agent-asset-blocks.md`（资产块协议 + 渲染跟上批）·
    `multimodal-image-plan.md`（多模态图片链 B1-B5；**真机六项欠账仍在办**，在办真值在计划索引欠账表）·
    `browser-cdp-suite-review-round2.md`（CDP 二轮评审；E2E-1..5 已实跑结清）·
    `session-persistence-seam-wiring-plan.md`（会话持久化 seam 接线；**原头注「待施工」已过期，横幅内已订正**）·
    `paper-shell/paper-panel-split-plan.md`（PaperPanel 机械拆解）·
    `tool-ergonomics-notes.md` + `tool-ergonomics/`（design-1-context-waist · design-2-session-focus；工具层人体工学 T-1/T-2）。
  - 各件顶部已加「已归档（2026-09-16 · 文档面重构）」横幅 + 现状指针；引用面同步到 `docs/archive/…`
    （含 `INVARIANTS.md` / `docs/adr/` / `docs/agents/open-surface-contract.md` / 计划索引与施工史）。
- **2026-09-16 归档（dsh-bundle 3D 视图拆除）**：`dsh-viewer-phase2-design.md`（阶段 2 设计定稿：复用兰台渲染内核
  只换数据源）、`dsh-viewer-phase2-integration.md`（client-plugin 集成规格 + `/hologram` 自托管形态）——
  该视图随主仓图谱渲染内核退役（2026-08-19 → 09-09 三步）从 `dsh-bundle` 拆除，包自此只发「引擎 + MCP 工具面」；
  两份顶部均已加归档横幅，其中 client-plugin 机制一节仍是可复用的机制事实。

## 使用规则

- 新窗口/新 Agent 默认**不需要**读本目录；需要理解“为什么当时这么做”时再按文件名检索。
- 本目录文件不删除、不重写内容（只修死链）；有新结论写新文档，不回来改历史。
