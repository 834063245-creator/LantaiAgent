# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；**已竣工的计划全文在 `docs/archive/`**——本页只活在办项 + 一句指针。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 搁置（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——`npm run doc-check` 的 archive 查已上牙：plans/ 下挂竣工横幅 = 门禁红。

## 一句话现状（2026-10-28）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的桌面 Agent 软件**；HoloGram 图谱引擎是随包配套的
独立进程（应用内默认关），不再是应用内的主叙事。

**十月收口（全部竣工、门禁绿）**：动效法·纸感档（10-15/16，规则与批次流水在
[`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §15，守护 `tests/motion-contract.test.ts`）·
目次带 v4.1 两栏/编号/纸捻（10-20，§13）· **创作坞精修 P0/P1/P2**（10-21/22：硬缺陷五条 + 视觉系统 +
信息架构，`compose-dock` 产物）· 模型级自定义推理等级（10-22，对齐 DSH `reasoningEfforts`）·
**goal 目标域**（10-27 `6c1da811`，会话内持久目标 + `goal` 域工具 + 空闲自动续行）· 版本推到 **1.0.9**（10-28）。

**验收口径（2026-10-28 用户定调，逐字）**：「**验收默认全过，有问题我自然会主动修的**，然后 exe 我已经是
重建过的了，不需要重建」——⇒ 累计 24 组「代码完成、待实机勾销」的验收项**一律视为通过**，不再占在办行
（判据转登记册，见下「真机验收登记册」）；exe 已重建完毕，本页不再出现「须重建 exe」类待办。

**当前真正的在办**：① 三件已立项待排期的代码（见「待执行但已立项」）；② 文档面重构收尾（P0-P4 全落，余归档）；
③ 画布支 Stage-6。已竣工线的权威叙事全在 [`docs/archive/`](../archive/README.md)；**跨文档数字一律看
[`docs/facts.generated.md`](../facts.generated.md)，本页不复述**。

## 活跃线（在办）

| 线 | 文档 | 状态 | 一句话 |
|---|---|---|---|
| **goal 目标域（DSH 移植）** | [`goal-domain-dsh-port.md`](goal-domain-dsh-port.md) | **已交付（2026-10-27 `6c1da811`；验收默认通过）** | 每卷一个持久目标（会话日志 `goal/change`/`goal/round` 事件 + 严格折叠）+ `goal(get/create/update)` 域工具 + 空闲自动续行轮 + 创作坞状态条；旧 `goal-manager`/`goal-loop`/`goal_report` 整拆 |
| **文档面重构** | [`doc-surface-refactor-plan.md`](doc-surface-refactor-plan.md) | **P0-P4 全部落地（2026-09-16 起；余归档本文档）** | 四层形态 + 批序 + 豁免账见施工单；门禁 `npm run doc-check`（267 份 0 违规），真源 `scripts/doc-facts.cjs` |
| **paper-shell** | [`paper-shell/README.md`](paper-shell/README.md) | **R5 已结清（2026-08-29 全账清零）；当前 = 创作坞精修线** | R5 逐项清单 [`r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)（已清零，作历史判据）；视觉决定账本 [`taste-ledger.md`](paper-shell/taste-ledger.md)；管线史 [`HISTORY.md`](paper-shell/HISTORY.md)；走查 [`walkthrough.md`](paper-shell/walkthrough.md)；表面覆盖地图 [`v2-surface-inventory.md`](paper-shell/v2-surface-inventory.md)；访谈 [`interviews/R1-2026-08-20.md`](paper-shell/interviews/R1-2026-08-20.md) |
| **画布空间模型** | [`canvas-space/canvas-space-model-notes.md`](canvas-space/canvas-space-model-notes.md) | **Stage-6 进行中**（UI/UX 专项） | 一纸多卷 / 有界流区 / 宿主模型 / 三层导航；阶段件与返工清单见笔记「展开」段；provider+创作坞联合体检 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) |
| **agent hooks（生命周期扩展点）** | [`agent-hooks-plan.md`](agent-hooks-plan.md) | **一期/二期已竣工** | 步骤钩子家族已落（`ctx.steps`：pre-step 每步 enter/reject + turn-stopping 停止边界，含 durable/transient 注入、`create` 工厂、发现注入收编）；三期待拍（request 系列 / plan·inbox 收编 / CC 桥） |

## 待执行但已立项（按成本排）

| 项 | 成本 | 说明 |
|---|---|---|
| **code_execution 升级** | **P1 ✅ / P2 ✅ 已落地（2026-10-30）**；P3-P4 待开工，一批一 commit 串行施工 | 「code mode v1」补四条回路：**绑定目录进描述**（✅ 名字 + 派生签名 + 一条示例，读活注册表——取证发现域门面是构建期快照，装配期取会晚一次收敛）· **并发面**（✅ 域工具按动作只读 + 键控写锁 + 排他闸，修描述里已存在的假承诺；锁键按归一化绝对路径分片）· **错误面**（`code`/`hint` 可分类，程序内自纠）· **输出预算**（超限从「整段作废」改为「截断 + 标记，部分结果可读」= 唯一故意规格变更）。P5 结构化完成值待触发；类型检查器 / 读面批量 / 基座硬化 / 暂停等审批**挂起**（理由在文内，附业界横向对账 §11）——[`code-execution-upgrade-plan.md`](code-execution-upgrade-plan.md) |
| **pretext 排版引擎** | P1-P5 全竣工 + P4c 远景三档；**余 P2a 对齐环未开工**（方向 A\|B 未定 ⇒ 待排期） | 从高度计算器升级为纸面排版引擎（lift 遮罩 / rich-inline 精确测量 / 来文变宽纸条 / 缩远墨迹 LOD 与小地图真墨）——[`pretext-typography-plan.md`](pretext-typography-plan.md) |
| **日志可观测性（失败可见 P0）** | 批 0–4 **已落地**（批 1/2 = 2026-09-27：`06fadbe2` + `bf4c910b`；批 3/4 = 2026-10-12：级别开关 + 健康度 + 前情缓冲 + Rust 出网留痕 + **轮转/保留窗口** + **设置页「诊断」签（级别开关 UI + 诊断包导出）**）；验收默认通过（2026-10-28 口径） | 消灭「失败默认无痕」：事件门面 `agent/obs.ts`（唯一脱敏审查点）+ 用户可见失败唯一漏斗 + 五条接缝（boot / config.load / cred / llm / turn.failed）插桩 + `logger.ts` 的级别过滤（默认 info，**debug 进内存前情缓冲，失败时自动连现场落盘**——用户不必记得开开关）与丢条补偿；三份日志同规轮转（8 MiB / 保 2 代，失败不静默）；诊断包导出（单文件，带可信度段：通道可用性/断档/丢条/字段来源标签）。规格 [`../design/log-observability-spec.md`](../design/log-observability-spec.md)，计划与事故取证 [`log-observability-plan.md`](log-observability-plan.md)（触发 = 2026-09-27 用户报本地模型调不动，其 log 对该故障的可答信息 0 条） |
| **插件化欠账（总账）** | ✅ **已完成（2026-09-26；2026-09-24 立账）** | 「还有多少没拆」的唯一真值 = [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)：账①通道迁移 ✅ 全清 / **账② 物理归家 ✅ 清零**（红区 0 产物 / 0 文件 / 0 行；纯壳集 21 → 0）/ 账③ 逐项判定完毕（判内核平台/共享面者已入名册 `shared` 与白名单）；§0.1 的「30 产物源码进 bundle」守卫同批落。**用户裁定六项排期全落**（真机验收 → 9h-5 → 9c-4 → §4-6 → 9f → 批 10 + §4-9 → §4 自裁项收尾）；三色实测见总账 §5，批次表 §6 |
| **v11 分析引擎** | 草案挂起（用户拍板挂起） | 动态边 + 查询预算 + 降噪分级三篇合一——[`v11-analysis-engine-master-plan.md`](v11-analysis-engine-master-plan.md)；D 篇原件 [`docs/archive/kernel-tooling-line/dynamic-edge-detection-plan.md`](../archive/kernel-tooling-line/dynamic-edge-detection-plan.md)（superseded，以主文档为准） |
| agent-plugin **P4** 插件化全集 | 持续 | **D9 换轨：不等 DSH、自研为主**；存量拆解全清，剩 C12 dsh-compat 合法挂起 + 新能力走通道——[`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| agent-plugin **C12 dsh-compat** | P4 全清后的唯一合法挂起：DSH peer 出非 workspace 版本即启动（外部信号依赖；p4a 调研已备好契约地图，见 [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md)） |
| v4-pro-minimal AB 实验 | Linux 环境（Windows 不可用）；**且旧 harness 已删**（2026-09-16 `77ad6fe7` 后续一笔——`src-ui/tests/ab/` + `scripts/ab-test/` 是图谱时代化石，重跑需先重写 harness）——[`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) |
| repo 改名 GitHub 侧执行 | 用户操作；**2026-09-22 已在现名下发布 v1.0.0** ⇒ 原先「改名前不打发布包」的约束随之作废（改名与否不再卡发版，纯 GitHub 设置面动作） |

## 真机验收登记册（**默认通过**——出问题按行回查，不构成在办）

> **口径（2026-10-28 用户定调，逐字）**：「验收默认全过，有问题我自然会主动修的，然后 exe 我已经是重建过的了，不需要重建」。
> ⇒ 2026-09-17～2026-10-27 累计 **24 组**「代码完成、待实机勾销」的验收项一律视为通过，从在办行移除；
> exe 已重建，本页不再出现「须重建 exe」类待办。用户报问题时按「主题 → 判据文档」直接回查。

| 主题 | 涉及项 | 判据在哪 |
|---|---|---|
| 纸壳交互手感 | 创作坞浮动化 · 顶部浮件 · 目次带 v4.1 / 加宽 · 左缘边缘滚动 · 匣脚引线 · 图版架 · 出处引导 · 退出确认 · 役册 | 设计规格 [`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §9.2–§9.4 / §12.1 / §13 / §14；视觉决定 [`paper-shell/taste-ledger.md`](paper-shell/taste-ledger.md) |
| 画布/会话 | 画布 Stage-3 / Stage-4 · 创作坞+提供方联合体检 · 会话树「枝」 · 并发会话 · 卷号治理 A+B · 卷重建丢卡 · session-ledger 三项 | [`canvas-space/stage-3.md`](canvas-space/stage-3.md) · [`canvas-space/stage-4-rework-checklist.md`](canvas-space/stage-4-rework-checklist.md) · [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) · [`../archive/session-line/`](../archive/session-line/README.md)（session-tree / concurrent-sessions / volume-number-governance / session-rebuild-recovery） |
| 流与渲染 | stream-rhythm 五项（含 D1 间距三档 / D2 阶段线终审） · 多模态图片线六项 | [`../archive/render-paper-line/stream-rhythm-plan.md`](../archive/render-paper-line/stream-rhythm-plan.md) §5 · [`../archive/multimodal-image-plan.md`](../archive/multimodal-image-plan.md) §5 |
| 工具链/命令面 | 内核能力口 R3+R4 四项（browser / desktop / shell cwd+bg / 编辑） · 斜杠命令面 · 技能与 MCP 生产级 · 案卷侧栏载入体感 | [`../landmine-map.md`](../landmine-map.md) S6/S8 · [`../archive/kernel-tooling-line/command-surface-rework-plan.md`](../archive/kernel-tooling-line/command-surface-rework-plan.md) · [`../archive/kernel-tooling-line/skills-mcp-production-plan.md`](../archive/kernel-tooling-line/skills-mcp-production-plan.md) |
| 系统面 | provider「刷新目录」CORS · 随包 LSP 守护（打包件） · 权限卡桥（真实 agent 写动作） · goal 目标域 | [`../landmine-map.md`](../landmine-map.md) 第十三批 · [`../archive/kernel-tooling-line/lsp-fleet-daemon-plan.md`](../archive/kernel-tooling-line/lsp-fleet-daemon-plan.md) §7 · [`goal-domain-dsh-port.md`](goal-domain-dsh-port.md) |
| 开发侧自测 | 运行看门狗真机复现（临时压阈值 + 假 provider，取 `ui.log` 两条 `log.warn`） | [`../landmine-map.md`](../landmine-map.md) L3——**唯一仍算开发侧欠账的一行**，不占用户时间 |

## 已完成并归档（点名即可，详情勿读）

**2026-10-28 双竣工**：卷首字节稳定性（记忆库退出卷首、改走对话尾部注入——[`prompt-prefix-stability-plan.md`](../archive/prompt-prefix-stability-plan.md)）· 嵌入缓存持久化（跨重启免去 22k 节点 13.7 分钟重算——[`embedding-cache-persistence-design.md`](../archive/kernel-tooling-line/embedding-cache-persistence-design.md)）。

**2026-10-28 双竣工**（另一批）：**LSP 舰队孤儿回收**（Windows Job Object 补齐 unix PDEATHSIG 的另一端——[`lsp-fleet-orphan-reaping-design.md`](../archive/kernel-tooling-line/lsp-fleet-orphan-reaping-design.md)；实测修前 150ms 硬杀窗口必留孤儿、修后七档全清）。

**2026-10-28 取消**：**钉住与纸条改造**（[`pin-strip-rework-plan.md`](../archive/pin-strip-rework-plan.md)）——用户裁定「不做，这一项取消」；该单剩余项不再执行，2026-09-05 已落地的交互修订照常保留。

**2026-10-08 归档大扫（第二批 · 23 份）**：把「代码已完成、只欠真机验收（或已作废）」的**过程文档**整批移出 `docs/plans/`——
**会话线 4**（[`session-line/`](../archive/session-line/README.md)）· **渲染纸面线 8**（[`render-paper-line/`](../archive/render-paper-line/README.md)）·
**内核工具平台线 11**（[`kernel-tooling-line/`](../archive/kernel-tooling-line/README.md)）。判据 = **「过程文档是否还活着」，不是「验收跑没跑完」**
（CONVENTIONS §4：「待实机 / 验收 / 欠账」不算在办标记）——**真机欠账一行未删，全在本页欠账表**。
补（同日）：**纸壳交互承接**（8/8 全销账、守护断链集 = 空）与**卷号治理 A+B**（代码已落、余真机一次）按同判据归入 `render-paper-line/` / `session-line/`。同日早些时候已归档 8 份插件化欠账施工单（[`plugin-extraction/`](../archive/plugin-extraction/README.md)）。
**同日追加（2026-10-08 深夜）**：会话线 `session-line/` +1——[`session-rebuild-recovery-plan.md`](../archive/session-line/session-rebuild-recovery-plan.md)（卷重建丢卡根治：资产/拟策块自工具回执恢复 + 开卷落盘断循环；案卷 51 真机取证立案，当日施工当日归档）。

**2026-09-16 P3 归档批**（全文在 [`docs/archive/`](../archive/README.md)，索引见 [`../archive/README.md`](../archive/README.md)）：
组合架构 S0-S6 全树（[`composition-architecture/`](../archive/composition-architecture/README.md)——S6 设计件
[`S6-per-agent-composition.md`](../archive/composition-architecture/designs/S6-per-agent-composition.md)、施工史
[`../archive/composition-architecture/HISTORY.md`](../archive/composition-architecture/HISTORY.md)）·
平台化 Phase 0-6（[`agent-platformization-plan.md`](../archive/agent-platformization-plan.md)）·
插件 bundle 退役（[`plugin-bundle-retirement-plan.md`](../archive/plugin-bundle-retirement-plan.md)）·
内置插件名册单一真源（[`builtin-plugin-roster-single-source.md`](../archive/builtin-plugin-roster-single-source.md)）·
前端浮层/a11y 修复（[`frontend-overlay-a11y-plan.md`](../archive/frontend-overlay-a11y-plan.md)）·
内核插件运行时 Phase 2 交接窗（[`handoff-p2-window.md`](../archive/handoff-p2-window.md)）。

**2026-09-16 P3b 归档批**（补批：`archive` 查只看头部 15 行横幅，这批「竣工但没写横幅」的件漏网——逐条取证后归档；
各件顶部已加归档横幅 + 现状指针；施工史见 [`HISTORY.md`](HISTORY.md)）：
[`engine-plugin-extraction.md`](../archive/engine-plugin-extraction.md)（引擎插件化 Phase 0-5）·
[`layering-rework-plan.md`](../archive/layering-rework-plan.md)（分层重构 L1-L4 + L5b crate 化）·
[`first-party-hot-reload-plan.md`](../archive/first-party-hot-reload-plan.md)（第一方热更）·
[`agent-asset-blocks.md`](../archive/agent-asset-blocks.md)（资产块协议 + 渲染跟上批）·
[`multimodal-image-plan.md`](../archive/multimodal-image-plan.md)（多模态图片链 B1-B5；**真机六项欠账仍在办**，见上表）·
[`browser-cdp-suite-review-round2.md`](../archive/browser-cdp-suite-review-round2.md)（CDP 二轮评审；E2E-1..5 已实跑结清）·
[`session-persistence-seam-wiring-plan.md`](../archive/session-persistence-seam-wiring-plan.md)（会话持久化 seam 接线；头注「待施工」已过期）·
[`paper-shell/paper-panel-split-plan.md`](../archive/paper-shell/paper-panel-split-plan.md)（PaperPanel 机械拆解；真机一项待跑）·
[`tool-ergonomics-notes.md`](../archive/tool-ergonomics-notes.md) +
[`tool-ergonomics/design-1-context-waist.md`](../archive/tool-ergonomics/design-1-context-waist.md) +
[`tool-ergonomics/design-2-session-focus.md`](../archive/tool-ergonomics/design-2-session-focus.md)（工具层人体工学 T-1/T-2）。

**更早**（按线点名，施工史在 [`HISTORY.md`](HISTORY.md)）：workspace-flip · 总线归零 + ui/ 拆分 · 岛层退休 ·
cordis-migration · agent-core-convergence（baseline 冻结维护态）· 雷区地图 P0/P1 全拆 · V5 旧前端拆除 ·
session-ledger L0-L3 · workspace-ownership-root-cure（实机验收通过）。

**注意两个活的例外**：`docs/landmine-map.md`（技术债清单，P2 残留与根治级在册）与 convergence 的 baseline
change request 流程（[`../archive/agent-core-convergence/baseline-change-request.md`](../archive/agent-core-convergence/baseline-change-request.md)）
——虽在归档目录，仍是活流程入口。

**内核插件线（已拆除，但决策与能力口仍是现状）**：决策真源
[`kernel-plugin-architecture-decision.md`](kernel-plugin-architecture-decision.md)（v3：TS 策略建议层 + Rust
能力口强制层）及其衍生执行蓝本（R1 [`kernel-permission-strategy-layer-r1.md`](kernel-permission-strategy-layer-r1.md) ·
R2 [`kernel-capability-r2-search-pilot.md`](kernel-capability-r2-search-pilot.md) ·
C3 [`kernel-capability-c3-design.md`](kernel-capability-c3-design.md) ·
D4 [`kernel-capability-d4-handle-design.md`](kernel-capability-d4-handle-design.md)）；
已作废的运行时线记录留 [`docs/archive/kernel-tooling-line/kernel-plugin-runtime-plan.md`](../archive/kernel-tooling-line/kernel-plugin-runtime-plan.md) 与
[`docs/archive/kernel-tooling-line/kernel-plugin-runtime-phase2-design.md`](../archive/kernel-tooling-line/kernel-plugin-runtime-phase2-design.md)。

## 编号对照（防绕晕）

| 编号 | 含义 | 归属 |
|---|---|---|
| R1、R2 | 纸的视觉/交互访谈 | paper-shell |
| R3 | 纸的退役访谈——**作废**（V5 提前拆除，无对象） | — |
| R5 | 打磨环（A 转录段✅ / B 审美段✅ / C 产品化段✅）；另：agent-plugin 的风险编号 R5（Worker CSP spike，已毕）同名不同物 | paper-shell / agent-plugin |
| P1-P4 | agent-plugin 阶段（P1 工具文档✅ / P2 执行原语✅ / P3 cordis 收口✅ / P4 插件化全集·自研为主） | agent-plugin |
| V0-V5 | 纸的管线阶段（全部完成，V5=拆除旧前端） | paper-shell |
| C1-C14 | r5-polish-backlog 产品化项编号 | paper-shell |
| S0-S6 | 组合层阶段——**全段竣工并归档**（S7 真面板并排 ⏸ 搁置，随线归档） | [`../archive/composition-architecture/`](../archive/composition-architecture/README.md) |
| P0-P4（文档面） | 文档面重构批次（P0 立尺 / P1 注入层 / P2 现状层 / P3 归档 / P4 索引） | [`doc-surface-refactor-plan.md`](doc-surface-refactor-plan.md) |
| W1/D-W1-x、D9 | workspace-flip 访谈/设计件（已归档） | — |

> **S7 搁置件的取回方式**：真面板并排（多 core / 多面板）**重启该批时从归档取回并重新立项**——
> 施工单在 [`../archive/composition-architecture/work-orders/WO-S7-multi-core-panels.md`](../archive/composition-architecture/work-orders/WO-S7-multi-core-panels.md)
> （搁置裁定与四道拦路石见其 §0.5/§0.6；当时结论：preset 对本批零依赖，本批也买不到组合隔离）。
