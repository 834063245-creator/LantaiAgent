# docs/plans — 计划与实验入口

> 状态词：Proposed（待评审）· Draft（未执行）· In progress · Landed（代码已落地，剩真机验证）。
> 已完成的施工规格/被取代的 plan 移入 `docs/archive/`。

## 活跃计划

| 计划 | 状态 | 下一步 |
|---|---|---|
| [`arch-action-plan.md`](arch-action-plan.md) | 批 1/2 完成；批 3 的 13/12/11a/11b 完成，14 部分完成，11c 搁置 | 11c 与 agent 区 any 清理 |
| [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) | P0–P5 已落地 | Windows 真机验证（cfg(windows) 路径） |
| [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md) | 第一至第五批已提交 | Windows 真机 E2E-1/2/3/4/5 |
| [`agent-core-convergence/`](agent-core-convergence/) | **Done — Phase 0–6 + V0–V6 全部完成**（四原语全落地：Context / Effect 所有权 / 类型化事件 / 事件溯源日志 + blueprint 声明式装配；baseline 8 快照冻结） | 工程转入维护态：gate 与 baseline 长期守护（维护约束见 handoff-phase6） |
| [`cordis-migration/`](cordis-migration/) | **Done — P0-P4 全部落地**（内核 vendor → Workspace fiber 化 → Agent 身份 fiber 桥接 → LSP Service 化 → 四件套评估收口：双范式残留清零、epoch 定案永久保留、8 baseline 零漂移） | 后续同模式候选（goal-manager / memory-bundle-client 等）按需逐个迁 |
| [`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) | Draft | Linux 环境执行 |
| [`ui-react-island-retirement-plan.md`](ui-react-island-retirement-plan.md) | **Done**（2026-08-19：ui/react/ 目录删除、5 总线事件退役迁 store、32 文件全量迁入 app/**；终态守护测试常驻） | — |
| [`eventbus-zero-and-ui-split-plan.md`](eventbus-zero-and-ui-split-plan.md) | **Done**（2026-08-19 P0-P3 竣工：11 事件归零迁 store、events.ts 删除；11 store 迁 state/ + 23 scene 文件迁 scene/ + graph.ts shim；守护 COMPLETE=true + 全文档回写） | — |
| [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) | Proposed（方向性立项：DSH 源码实证对标——执行原语 + 工具面单一真源 + cordis Service 收口 + 插件边界；**生态跟随观望中**：P4 门控于 DSH 官方接口稳定信号，P1-P3 纯自研独立成立，见 D8） | P1 工具面文档生成（半天，独立收益）随时可做；P2 执行原语建议在总线归零后开；P4a 契约调研（纯侦察）可先行 |
| [`composition-architecture/`](composition-architecture/) | **In progress — S0 可开工**（2026-08-20 立项并备齐施工单：特权线左移取代 plugin-ecosystem v1；D0 四问访谈已定方向——世界 B 出局、自己的组合层、两产品形式化；宪法与边界见 [`docs/adr/composition-boundaries.md`](../adr/composition-boundaries.md)） | 第一刀 WO-S0A spike（小时级，已备单）→ WO-S0B 插件内核 → 批 S1 设计件 → S1-0…S1-5 → S2；**阶段 1（组合层核心）到 S2 为止**——之后转白纸全程（paper-shell），S3/S4 排阶段 3（2026-08-20 拍板三阶段串行，用户带宽优先，见计划 D0 排序节） |
| [`paper-shell/`](paper-shell/) | Draft（2026-08-20 立项：白纸前端重构落地管线——核心方法论「视觉层=转录任务不是设计任务」；V0 访谈→V1 原型收敛→V2 视觉契约→V3a 壳无关骨架→V3b 装配→V4 打磨→V5 壳切换；设计地基 `docs/design/一张纸-Agent软件交互形态设计.md`；**排队于阶段 1（组合层核心）之后，三阶段串行**） | 阶段 1 期间 R1 访谈可选随时做（纯对话零工程）；正式开工第一件事 = R1 四问访谈 → V1 白纸 vs 深色并排看（两侧打样已在 prototype/） |

## 已归档计划

见 [`docs/archive/README.md`](../archive/README.md)：graph-id-refactor-plan（R0–R10 竣工）、tool-convergence-browser-plan、browser-cdp-suite-plan-2026-08-13 等。
