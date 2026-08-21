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
| [`composition-architecture/`](composition-architecture/) | **S0-S2 Done · S4 Done**（2026-08-20 立项当天全竣工。S0：装载通道（14570 静态路由 + loader/manifest/plugin-store）；S1：注册表化（三张行表 + 四 service + per-preset 收敛基建，9 commits 零漂移贯穿）；S2：组合外化（roster patch 引擎 + 用户层通道 + 12 壳行拆 main.ts 919→37 行，6 批）；S4：preset realm + 分发（7 批 + CR 审批门——preset 数据模型/发现/装配穿线/消费闭环 G0 修复/热重载/npm 安装通道（tar-slip 双重围栏）/hello 闭环三通道/文档全套；S4-1b 经 Phase 5 CR 用户批准：preset/selected 首事件 + `baseline/preset-minimal/` 首次冻结（双 preset convergence 通过）；S4-4 机器桥按裁定跳过为未决项）；宪法与边界见 [`docs/adr/composition-boundaries.md`](../adr/composition-boundaries.md)，用户指南 [`docs/composition/README.md`](../composition/README.md) + [`docs/plugins/README.md`](../plugins/README.md)） | S3 设计件（等纸工程——第一方行化纲领，与前端重构排程协作） |
| [`paper-shell/`](paper-shell/) | In progress（2026-08-20 立项，**独立创作工程**——与组合层并列非阶段关系：前端重构 = 密集人机共同创作（沟通→修改→测试循环为主体工作量，月级）；V0 访谈完成（R1 五项 + R2 四项）；走查弹 2026-08-21 毕业（「感觉是对的」）；**V3a 骨架内核 + V3b 壳装配 2026-08-22 竣工**：V3a = 测量引擎切 `@chenglou/pretext`（内部快照退役）/ 视口虚拟化 / 抽纸条 / 方位感 / IME 谓词；V3b = 纸面板迁 PanelsService 贡献（paperPlugin）+ 块渲染器第五贡献通道 `ctx.renderers`——61 无头测试 + convergence 零漂移，`src-ui/src/paper/` + `composition/renderer-service.tsx`；**#9 workspace 翻转子题已拍板（2026-08-22 R4）+ 施工设计件已出**（`paper-shell/designs/D9-workspace-flip-v5-mechanism.md`，六批序列待批准）） | #9 + V5 机制半施工（agent 主场，解锁 S3）；随后 V2 视觉契约 → V4 打磨环（用户节奏）；R3/V5 判断半等「纸能住人」 |

## 已归档计划

见 [`docs/archive/README.md`](../archive/README.md)：graph-id-refactor-plan（R0–R10 竣工）、tool-convergence-browser-plan、browser-cdp-suite-plan-2026-08-13 等。
