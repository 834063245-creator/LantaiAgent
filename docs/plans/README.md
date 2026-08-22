# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；已竣工计划全文在 `docs/archive/`。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 阻塞（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——这页只保留活的工作。

## 一句话现状（2026-08-22 深夜）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的 Agent 软件**。旧观测台前端已于昨夜整体拆除（-16843 行）；工程主体架构全部落地，剩余的是收尾与少数立项未开工项——没有拦路的硬依赖。

## 活跃工程（就一个半）

### 1. paper-shell — 收尾中

> 深入入口：[`paper-shell/README.md`](paper-shell/README.md)（管线与拍板史）· [`paper-shell/r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)（**剩余工作逐项清单——最常看的文件**）· [`paper-shell/taste-ledger.md`](paper-shell/taste-ledger.md)（视觉决定账本）

剩余工作按「谁判断」分三层：

| 层 | 项 | 谁判断 |
|---|---|---|
| **纯转录**（agent 可自主推进） | ~~C2~~✅ · ~~C5 余量~~✅ · ~~C3 夹注列宽~~✅ · ~~C4 应用图标~~✅ · ~~C6 文案~~✅ · C7 圈点（边界探明，触数据契约待裁决）· ~~C13 scene/ui 休眠层 sweep~~✅ —— **以上除 C7 外均已毕（2026-08-22 自主段）** | Agent |
| **产品判断**（需用户拍板形态） | C8 多卷切换 UI · C10 附件入口 · C11 模型/权限模式切换入口 · C12 状态反馈面（预热进度不可见）· **C7 圈点关键词来源**（新契约 UserMessage.marks / 零契约引号启发式 / Agent 端标注，三选一） | 用户 |
| **审美循环**（需 vision 模型会话） | B 段 5 维单维循环（垂直节奏/页边注光学/墨阶/问批音量/代码块印刷化）——vision 解锁已验证：headless Edge 截图 + harness 对拍管线可用（C2 自检先例，`prototype/c2-settings-harness.html` 留作回归工具） | vision 会话 + 用户终审 |

### 2. composition-architecture — 只剩 S3（样板工程）

S0/S1/S2/S4 全竣工。S3 = 把 settings 面板域迁成第一方插件（面板+命令+动作走组合层贡献），一个域的样板量级。图谱面板域原在 S3 名单上，已随 V5 拆除走退役路径消解。**触发条件：纸壳交互欠账（C8-C12）落定后**，按「重构推到哪个域、行化跟到哪个域」推进。

## 待执行但已立项（按成本排）

| 项 | 成本 | 说明 |
|---|---|---|
| agent-plugin **P1** 工具面文档生成 | ~~半天~~ ✅ 已毕（2026-08-22）：gen-tool-contract-md.cjs + model-tool-contract.md 落地；C2 判据如实偏差（ci.yml 冻结 → vitest 守护 + check:tool-contract）；AGENTS/CLAUDE 手写清单段已指向生成物 |
| arch-action-plan **14** any 渐进清理 | ~~渐进~~ ✅ 已收官（2026-08-22）：非 agent 区 2026-08-13 清完；agent 区随 11c 第五批清零（GraphDataShape 宽松形状 + errText 收口；EngineJson 单处豁免为刻意决策）→ [`arch-action-plan.md`](arch-action-plan.md) |
| rpc 返回值 Value 化 | L（独立项目） | 根治「双重编码」bug 家族；typedRpc 前置已就位 → [`landmine-map.md`](../landmine-map.md) 根治级段 |
| agent-plugin **P2** code_execution 执行原语 | 2-4 天 | 产品决策级；**P3** cordis 收口 1-2 天（前置已满足） |
| arch-action-plan **11c** agent.ts 拆分 | ~~1 天~~ ✅ 已毕（2026-08-22）：五批落账，3295 → 1758 行（-47%），四域出仓（loop-helpers / compaction-summarize / goal-loop / subagent-spawn / agent-compaction），宿主接口模式，convergence 零漂移；流式循环域留在 agent.ts（全字段交织，收益/风险比不划算） |
| browser CDP 功能面扩展 | 中 | 现状 4/10 功能覆盖（缺导航/正文提取/表单全动作等）→ [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md) |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| agent-plugin **P4** 插件边界/DSH 跟随 | DSH 官方接口稳定信号（semver/插件文档/稳定性承诺） |
| v4-pro-minimal AB 实验 | Linux 环境（Windows 不可用） |
| repo 改名 GitHub 侧执行 | 用户操作；改名前不打发布包 |

## 真机验证欠账（代码完成、未实跑）

| 项 | 欠什么 |
|---|---|
| ~~V5 拆除后的 Tauri 真机~~ | **大部分已跑（2026-08-22 自主段）**：真机启动 + 纸壳渲染截图取证 ✓；窗口控制 IPC 最大化/还原往返 ✓；冷启动缓存过期→重分析全链路（louvain/LSP×3/向量嵌入）✓；优雅关闭 lifecycle 全清 ✓。未覆盖：权限卡桥需真实 agent 写动作触发（需 provider 配置），留给下次带 API key 的会话 |
| ~~shell 捆绑 bash（P0-P5）~~ | **已实跑（2026-08-22）**：os_sandbox:: 17/17 绿（含新增 repo vendor 三连测试）；init_bundled 开发态兑底路径修正一处布局雷（BUNDLED_BASH_REL 自带 vendor/ 前缀，root 应为 CARGO_MANIFEST_DIR 本身）；src-ui tsc 绿 → [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) §4 已更新 |
| ~~browser CDP E2E-1/2/3/4/5~~ | **已实跑（2026-08-22）**：cargo test cdp:: 35/35 全绿，含重点 E2E-5 多账号 cookie 隔离（上会话偶发失败本轮未复现） |
| workspace-flip 批 3 边界 | 预热期内创建的会话缺 graph 工具（已知边界，非 bug） |

## 已完成并归档（点名即可，详情勿读）

workspace-flip · 总线归零+ui/拆分 · 岛层退休 · cordis-migration · agent-core-convergence（baseline 冻结维护态）· 组合层 S0-S2/S4 · 雷区地图 P0/P1 全拆 · V5 旧前端拆除。索引见 [`../archive/README.md`](../archive/README.md)。

**注意两个活的例外**：`landmine-map.md`（技术债清单，P2 残留与根治级在册）与 convergence 的 baseline change request 流程（`agent-core-convergence/baseline-change-request.md`——baseline 变更审批仍走此文件）虽已归档目录，仍是活流程入口。

## 编号对照（防绕晕）

| 编号 | 含义 | 归属 |
|---|---|---|
| R1、R2 | 纸的视觉/交互访谈 | paper-shell |
| R3 | 纸的退役访谈——**作废**（V5 提前拆除，无对象） | — |
| R5 | 打磨环（A 转录段✅ / B 审美段 / C 产品化段） | paper-shell |
| V0-V5 | 纸的管线阶段（全部完成，V5=拆除旧前端） | paper-shell |
| C1-C14 | r5-polish-backlog 产品化项编号 | paper-shell |
| S0-S4 | 组合层阶段（S3 剩余） | composition |
| W1/D-W1-x、D9 | workspace-flip 访谈/设计件（已归档） | — |
