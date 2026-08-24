# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；已竣工计划全文在 `docs/archive/`。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 阻塞（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——这页只保留活的工作。

## 一句话现状（2026-08-23）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的 Agent 软件**。执行原语已落地
（code_execution + ctx.codeRuntime，模型可在程序体内循环/并发/试错调全部工具）；插件化
战略已换轨（D9：自研为主，存量逐步拆为域插件，特权区只减不增）。没有拦路的硬依赖。

## 活跃工程（就一个半）

### 1. paper-shell — 收尾中

> 深入入口：[`paper-shell/README.md`](paper-shell/README.md)（管线与拍板史）· [`paper-shell/r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)（**剩余工作逐项清单——最常看的文件**）· [`paper-shell/taste-ledger.md`](paper-shell/taste-ledger.md)（视觉决定账本）

剩余工作按「谁判断」分三层：

| 层 | 项 | 谁判断 |
|---|---|---|
| **纯转录**（agent 可自主推进） | ~~C2~~✅ · ~~C5 余量~~✅ · ~~C3 夹注列宽~~✅ · ~~C4 应用图标~~✅ · ~~C6 文案~~✅ · ~~C7 圈点~~✅ · ~~C13 scene/ui 休眠层 sweep~~✅ · ~~C14 dock-store 开合表收缩~~✅ —— **纯转录层全清（2026-08-22，C 段全段收官）** | Agent |
| **产品判断**（需用户拍板形态） | ~~C8 多卷切换 UI~~✅（2026-08-22 用户拍板隐喻流派：左缘书脊列 SpineRack，恒显/卷首名双击改名/合卷自动存） · ~~C10 附件入口~~✅ · ~~C11 模型/权限模式切换入口~~✅ · ~~C12 状态反馈面~~✅ · ~~C7 圈点关键词来源~~✅（2026-08-22 定案【词】书写语法零契约方案，真机人判通过——见 backlog 明细） —— **产品判断层全清** | 用户 |
| ~~**审美循环**~~ | ✅ 全收（2026-08-23 vision 会话，文字重判有效）：B1 环1 落地（块距 48/asterism/来文间距反转）；B2 授权 agent 判 A（零改动）；B3 拍 B 提墨落地（信息五处 ink-3→ink-2）；B4 拍 C 落地（来文 seal-deep 16px/1.9）；B5 环2 拍 D 红绿墨色化落地（add 松绿 / del 朱砂深删除线）——逐项明细见 taste-ledger 2026-08-23 四条；钉值 tests/paper-visual-decisions.test.ts | Agent+用户终审 |

### 2. composition-architecture — ✅ 全段竣工（2026-08-22）

S0/S1/S2/S4 竣工后，S3（settings 域第一方行化：面板/命令双贡献 + runAction 别名翻译层）于 2026-08-22 收官——组合架构计划全段完成。设计件与施工史见 [`composition-architecture/`](composition-architecture/)。

## 待执行但已立项（按成本排）

| 项 | 成本 | 说明 |
|---|---|---|
| **session-ledger 案卷总目**（L0-L3） | ~3 天 | **2026-08-23 立项**：会话管理收敛——立账本（档案号=卷号/开合有册/落盘两动词），书脊列与首页退化为两个视图 → [`session-ledger-plan.md`](session-ledger-plan.md)。paper-shell C8 之后积欠的会话层结构债，四段 L0-L3 按成本排 |
| ~~rpc 返回值 Value 化~~ | ✅ 已毕 | 两步全落地（2026-08-22）：第一步出口结构化 + typedJsonRpc 单点收敛（be8bba85）；第二步 B 路线命令→形态分派表 + 前端双形态 shim（63e0fd77/a59fc086）。真机双轮验证过（CDP 形态断言 + 真实会话全工具链）→ [`landmine-map.md`](../landmine-map.md) 根治级段；残留仅 DataflowPanel.tsx 启发式一处（P2 段在册） |
| agent-plugin **P2+P3** 执行原语 | ~~2-4 天 + 1-2 天~~ ✅ 已毕（2026-08-22/23）：code_execution（Web Worker 沙箱 + 协议腰线 + 嵌套审计 + 程文块）+ ctx.codeRuntime cordis 收口；C4-C10 全判据；commit d772af37/15930f65 → [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) |
| agent-plugin **P4** 插件化全集 | 持续 | **D9 换轨（2026-08-23）：不等 DSH，自研为主自己当第一用户**——通道补齐 + 存量拆解①-⑥ + P4a 调研交替推进；批次表见计划 §5 P4 |
| browser CDP 功能面扩展 | 中 | 现状 4/10 功能覆盖（缺导航/正文提取/表单全动作等）→ [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md) |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| ~~agent-plugin **P4** 插件边界/DSH 跟随~~ | **D9 换轨（2026-08-23）：移出等待表**——自研为主不等信号（见上表）；DSH 信号点亮只追加 compat 装载层 |
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
| R5 | 打磨环（A 转录段✅ / B 审美段 / C 产品化段）；另：agent-plugin 计划的风险编号 R5（Worker CSP spike，已毕）同名不同物 | paper-shell / agent-plugin |
| P1-P4 | agent-plugin 阶段（P1 工具文档✅ / P2 执行原语✅ / P3 cordis 收口✅ / P4 插件化全集·自研为主） | agent-plugin |
| V0-V5 | 纸的管线阶段（全部完成，V5=拆除旧前端） | paper-shell |
| C1-C14 | r5-polish-backlog 产品化项编号 | paper-shell |
| S0-S4 | 组合层阶段（S3 剩余） | composition |
| W1/D-W1-x、D9 | workspace-flip 访谈/设计件（已归档） | — |
