# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；已竣工计划全文在 `docs/archive/`。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 阻塞（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——这页只保留活的工作。

## 一句话现状（2026-08-26）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的 Agent 软件**。执行原语已落地
（code_execution + ctx.codeRuntime）；插件化出厂面全量通道化（P4 存量拆解 2026-08-24 全清）；
分层重构 L1-L4 + L5b crate 化已于 2026-08-25 落地（真机验收四项待跑）；画布支 Stage-4 会话内
体验已落地（2026-08-26），**同日完成联合体检 + 方案甲施工**：创作坞会话级模型/思考真生效
（覆盖制，`composer-provider-audit.md`），provider/创作坞两报告共 20+ 项毛病一次修完
（三 commit，门禁全绿，实机验收七项待跑）；**同日夜在册小账收尾**（D2 热切换 IPC 收窄 /
C5 目录失败面 / D5 组件测试补齐——体检全表清零，仅剩实机验收，见 `lantai-handoff-baton18.md`）。
没有拦路的硬依赖。

## 会话 / 分层 / 画布三线（2026-08-24 立项）

| 线 | 文档 | 状态 | 说明 |
|---|---|---|---|
| 会话统一 | [`session-unify-plan.md`](session-unify-plan.md) | ✅ 归零重建落地（2026-08-25，待真机验收） | U1-U4 竣工后兼容层全部拆除；全局位成为唯一事实源 |
| 分层重构 | [`layering-rework-plan.md`](layering-rework-plan.md) | **L1-L4 + L5b crate 化已落地**（2026-08-25） | engine 纯化 + 壳瘦身 + 数据上下文 + 双工作区并发守卫 + L5b 三 crate 拆出；真机验收四项待跑（见计划 §4.6） |
| 画布空间模型 | [`canvas-space/canvas-space-model-notes.md`](canvas-space/canvas-space-model-notes.md) | **设计定稿；Stage-1 ✅ + Stage-2 ✅（实机已验）+ Stage-3 ✅（门禁全绿）+ Stage-4 ✅（2026-08-26 落地 + 返工修复 + 联合体检方案甲施工）**，Stage-5 草案待审（开工依赖：返工清单 + 体检验收实机勾销） | 一整片会生长的纸 / 有界流区 / 宿主模型 / 三层导航 / 性能基准；阶段性展开文档见 `canvas-space/` 子目录；**provider/创作坞联合体检与修复见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md)**（方案甲定案 + 2026-08-26 修复落账 + 夜批在册小账收尾 D2/C5/D5，全表清零） |

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
| ~~rpc 返回值 Value 化~~ | ✅ 已毕 | 两步全落地（2026-08-22）：第一步出口结构化 + typedJsonRpc 单点收敛（be8bba85）；第二步 B 路线命令→形态分派表 + 前端双形态 shim（63e0fd77/a59fc086）。真机双轮验证过（CDP 形态断言 + 真实会话全工具链）→ [`landmine-map.md`](../landmine-map.md) 根治级段；残留仅 DataflowPanel.tsx 启发式一处（P2 段在册） |
| agent-plugin **P2+P3** 执行原语 | ~~2-4 天 + 1-2 天~~ ✅ 已毕（2026-08-22/23）：code_execution（Web Worker 沙箱 + 协议腰线 + 嵌套审计 + 程文块）+ ctx.codeRuntime cordis 收口；C4-C10 全判据；commit d772af37/15930f65 → [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) |
| agent-plugin **P4** 插件化全集 | 持续 | **D9 换轨（2026-08-23）：不等 DSH，自研为主自己当第一用户**——通道补齐 + 存量拆解①-⑥ + P4a 调研交替推进；批次表见计划 §5 P4。**存量拆解 2026-08-24 全清（baton15）**：B①②④⑤⑥/①b/①c/S4-4/A-1/A-2/A-3/C11 全毕，出厂面三类行源（工具行/prompt 段/capability）全量经插件通道贡献；剩余 C12 dsh-compat 唯一合法挂起（等 DSH 外部信号）+ 新能力加面走通道（见 docs/plugins/README.md §3） |
| ~~browser CDP 功能面扩展~~ | ✅ 已毕 | 五批全落地（2026-08-15，第一至第五批——导航/正文/表单全动作/dialog/upload/tab/截图 inline/网络配对+HAR/AX snapshot/viewport/跨平台/profile+proxy+多账号 slot+cookie 管理），E2E 1-5 已于 2026-08-22 Windows 真机实跑 35/35 全绿 → [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md)；剩余 eval 隔离 world 为已拍板的可选项（不做） |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| ~~agent-plugin **P4** 插件边界/DSH 跟随~~ | **D9 换轨（2026-08-23）：移出等待表**——自研为主不等信号（见上表）；DSH 信号点亮只追加 compat 装载层 |
| agent-plugin **C12 dsh-compat** | P4 全清后的唯一合法挂起：DSH peer 出非 workspace 版本即启动（外部信号依赖；p4a 调研已备好契约地图，见 agent-plugin 计划） |
| v4-pro-minimal AB 实验 | Linux 环境（Windows 不可用） |
| repo 改名 GitHub 侧执行 | 用户操作；改名前不打发布包 |

## 真机验证欠账（代码完成、未实跑）

| 项 | 欠什么 |
|---|---|
| ~~V5 拆除后的 Tauri 真机~~ | **大部分已跑（2026-08-22 自主段）**：真机启动 + 纸壳渲染截图取证 ✓；窗口控制 IPC 最大化/还原往返 ✓；冷启动缓存过期→重分析全链路（louvain/LSP×3/向量嵌入）✓；优雅关闭 lifecycle 全清 ✓。未覆盖：权限卡桥需真实 agent 写动作触发（需 provider 配置），留给下次带 API key 的会话 |
| ~~shell 捆绑 bash（P0-P5）~~ | **已实跑（2026-08-22）**：os_sandbox:: 17/17 绿（含新增 repo vendor 三连测试）；init_bundled 开发态兑底路径修正一处布局雷（BUNDLED_BASH_REL 自带 vendor/ 前缀，root 应为 CARGO_MANIFEST_DIR 本身）；src-ui tsc 绿 → [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) §4 已更新 |
| ~~browser CDP E2E-1/2/3/4/5~~ | **已实跑（2026-08-22）**：cargo test cdp:: 35/35 全绿，含重点 E2E-5 多账号 cookie 隔离（上会话偶发失败本轮未复现） |
| session-ledger 真机三项 | 代码判据已测试钉死，真机未实跑（需带 API key 会话）：① 重启工作集恢复（多卷摊开 → 关 → 开，摊法全回）；② 后台卷落盘（双卷并发跑一轮后检查卷文件）；③ 续开查重（同卷两次续开只有一条脊）——见 [`../archive/session-ledger-plan.md`](../archive/session-ledger-plan.md) §7（⚠️ ①已被 session-unify Q-B 取代：重启不自动摊开） |
| workspace-flip 批 3 边界 | 预热期内创建的会话缺 graph 工具（已知边界，非 bug） |
| **分层重构真机验收四项** | L1-L4 + L5b crate 化代码已落地（2026-08-25，七 commit 全绿；L5b 三 crate 拆出后 workspace 全量测试对账守恒），真机待跑：① 单工作区零回归（开卷/切卷/图查询/工具调用如常）；② 双工作区并行（两会话两项目同时跑图查询无错乱）；③ 跨工作区续开（首页点他工作区卷 → 图上下文正确）；④ Ungrouped 会话可用（零目录卷打开不报图错误）——见 [`layering-rework-plan.md`](layering-rework-plan.md) §4.6 |
| **画布 Stage-3 实机待验** | 代码已落地（2026-08-25，门禁全绿）：① 书脊手感（左键定位轻动画 / 拖动落位幽灵+吸附 / hover 小卡合卷；右键菜单已取消，改名/删除在侧边栏）；② 侧边栏折叠（收起只剩书脊）与状态点/相对时间/行操作；③ 生命周期闭环体验（新建→落位→展开→收起→删除）；④ 未摊开卷行点击展开补飞 + 视角自由拖拽（定位动画不再抢手动 pan）——见 [`canvas-space/stage-3.md`](canvas-space/stage-3.md) |
| **画布 Stage-4 返工清单（P0-P4）** | 代码面已修（2026-08-26），待实机勾销：P0-1 全放确认+关窗崩溃 / P1-1 自动选中三道闸（panningRef 根因已修）/ P1-2 聚焦落点手感 / P3-1 非全屏布局——见 [`canvas-space/stage-4-rework-checklist.md`](canvas-space/stage-4-rework-checklist.md) |
| **创作坞+提供方联合体检验收七项** | 方案甲 + 全批修复已落地（2026-08-26 三 commit `efc74e7d`/`254ad008`/`36ad9ed5`，门禁全绿）：① 卷间会话级模型/思考隔离；② 未改卷跟全局/改过卷不跟；③ 重启后各卷配置保留；④ 模型下拉列全+未配置厂商不出现+无 Key 标注；⑤ 测试连接后取消不落暂存改动；⑥ ↑↓ 历史+焦点回归；⑦ 后台卷运行态指示——见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) 修复落账节 |

## 已完成并归档（点名即可，详情勿读）

workspace-flip · 总线归零+ui/拆分 · 岛层退休 · cordis-migration · agent-core-convergence（baseline 冻结维护态）· 组合层 S0-S2/S4 · 雷区地图 P0/P1 全拆 · V5 旧前端拆除 · **session-ledger L0-L3（2026-08-23 四段当日连推，2026-08-24 merge `e677c5c8` 合入；判据 26 用例钉死，真机三项见上表）** · **workspace-ownership-root-cure（工作区归属根治五 Phase + boot 序洞真根因，2026-08-24 实机验收通过）**。索引见 [`../archive/README.md`](../archive/README.md)。

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
