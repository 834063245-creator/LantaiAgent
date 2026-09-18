# docs/plans — 计划与现状入口（人类优先）

> 这一页回答三个问题：**现在在哪 / 还剩什么没做 / 想深入去哪读**。
> 时间轴与施工史在 [`HISTORY.md`](HISTORY.md)；**已竣工的计划全文在 `docs/archive/`**——本页只活在办项 + 一句指针。
> 状态词：In progress（干着）/ Proposed·Draft（立项未开工）/ 搁置（等条件）。
> 维护纪律：**竣工即归档**（CONVENTIONS §4）——`npm run doc-check` 的 archive 查已上牙：plans/ 下挂竣工横幅 = 门禁红。

## 一句话现状（2026-09-16）

**兰台（Lantai）= 纸壳（注疏案卷工作台）为唯一主界面的桌面 Agent 软件**；HoloGram 图谱引擎降为随包配套的
独立进程（应用内默认关），不再是应用内的主叙事。**在办三件**：文档面重构 P4（索引重建——本页所在批）· paper-shell
R5 打磨收尾 · 画布支 Stage-6（UI/UX 专项）。已竣工线的权威叙事全在 [`docs/archive/`](../archive/README.md)
（组合架构 S0-S6、平台化 Phase 0-6、引擎插件化、bundle 退役…点名见文末）；**跨文档数字一律看
[`docs/facts.generated.md`](../facts.generated.md)，本页不复述**。

## 活跃线（在办）

| 线 | 文档 | 状态 | 一句话 |
|---|---|---|---|
| **文档面重构** | [`doc-surface-refactor-plan.md`](doc-surface-refactor-plan.md) | **P0-P4 已落**（P3 补批 = 11 件竣工件归档，本页所在批） | 四层形态 + 批序 + 豁免账见施工单；门禁 `npm run doc-check`，真源 `scripts/doc-facts.cjs` |
| **paper-shell（R5 打磨环）** | [`paper-shell/README.md`](paper-shell/README.md) | **收尾中** | 剩余工作逐项清单 = [`r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)（最常看）；视觉决定账本 [`taste-ledger.md`](paper-shell/taste-ledger.md)；管线史 [`HISTORY.md`](paper-shell/HISTORY.md)；走查 [`walkthrough.md`](paper-shell/walkthrough.md)；表面覆盖地图 [`v2-surface-inventory.md`](paper-shell/v2-surface-inventory.md)；访谈 [`interviews/R1-2026-08-20.md`](paper-shell/interviews/R1-2026-08-20.md) |
| **画布空间模型** | [`canvas-space/canvas-space-model-notes.md`](canvas-space/canvas-space-model-notes.md) | **Stage-6 进行中**（UI/UX 专项） | 一纸多卷 / 有界流区 / 宿主模型 / 三层导航；阶段件与返工清单见笔记「展开」段；provider+创作坞联合体检 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) |
| **出处引导（钉住块的来路）** | [`pin-provenance-plan.md`](pin-provenance-plan.md) | **代码已落地（2026-09-18）；余真机验收** | 钉块页边注第三行常显「摘自 卷名」（不依赖视口内目标）+ hover 引线拉到源洞（**洞离屏也出屏**）+ 点行溯源飞到洞；连带修飞行动画混钟（jsdom 实测循环永不终止、视口飞出 16 万 px） |
| 会话归属反转 | [`workspace-session-ownership-rework.md`](workspace-session-ownership-rework.md) | P1-P4 代码全量落地；P5 实机验收在办 | 会话**物理归属工作区**（`{ws}/.lantai/sessions/` 唯一存储位，焦点/绑定/全局列表全退役）；旧 session-unify 方向已归档（[`../archive/session-unify-plan.md`](../archive/session-unify-plan.md)） |
| 引擎-宿主逻辑全断 | [`engine-host-severance-plan.md`](engine-host-severance-plan.md) | 代码竣工（2026-09-08，五 commit）；**真机验收四项待跑**（计划 §4） | 壳摘掉全部 hologram-* crate 依赖；壳对引擎的全部知识收敛为「spawn 二进制 + MCP 协议」两条 |
| 并发会话（多卷同跑） | [`concurrent-sessions-plan.md`](concurrent-sessions-plan.md) | In progress（Phase 1-5 代码已落地，Phase 6 门禁收尾中） | 会话身份贯通：多卷同时运行互不拖累；触发=用户「多个会话不能同时运行」 |
| LSP 舰队共享化 | [`lsp-fleet-daemon-plan.md`](lsp-fleet-daemon-plan.md) | 开工（2026-09-09） | 每根目录一套 LSP（hologram-lspd）——16GB 机器内存耗尽的**结构性根治**（当日已落三闸止血） |
| 软件级插件（app shell） | [`app-shell-software-plugin-plan.md`](app-shell-software-plugin-plan.md) | S0-S6 竣工；**余管理 UI 面 + 用户真机验收** | 数据目录 / 受治进程治理 / 窗口原语 / 后台唤醒四件套 + 范本 `examples/plugins/notes-app/` |
| 纸壳交互承接 | [`paper-interaction-handoff.md`](paper-interaction-handoff.md) | 审计完成，逐条修复中 | 守护 `src-ui/tests/paper-interaction-handoff.test.ts`（KNOWN_DEAD 收敛机制——只减不增） |
| **工具附图通道（agent 眼睛环）** | [`tool-image-context-plan.md`](tool-image-context-plan.md) | **P0a 代码已落地 2026-09-17；余真机验收** | 工具产出的截图进模型可见通道（此前只挂 user 消息 ⇒ 模型看不见自己的产出，靠用户眼睛逐轮喂）；P0b（元素级截图 + 描述改写 + 拆 `inline`）需 BCR 放行 |

## 待执行但已立项（按成本排）

| 项 | 成本 | 说明 |
|---|---|---|
| **OfficeCLI 集成** | 工程完成；**余用户真机验收**（计划 §6 六条 + 权限面判据） | 单二进制 Office 套件接成一等 `office(action,…)` 域工具；真机复盘四处病灶与 P0 权限判定已全修（`4412ce87` / `f207e5f4`）——见 [`office-cli-integration-plan.md`](office-cli-integration-plan.md) |
| **科研渲染（scientific-rendering）** | 4A/4B 已验收；#5/#10/#11/#15/#16 已落地；**余 §7 真机项** | 双通道决策模型（正文 markdown / 产物资产通道）+ kind 扩充（math / citation / chem / 交互 chart / 虚拟 table）——见 [`scientific-rendering-plan.md`](scientific-rendering-plan.md) §7 |
| **会话流版式语法（stream-rhythm）** | 五批全落地；**余真机验收五项 + D1/D2 终审** | 事件语义分类 + 工作单元 + 节奏渲染（族边界切单元）+ 目次带阶段导航——见 [`stream-rhythm-plan.md`](stream-rhythm-plan.md) §5 |
| **pretext 排版引擎** | P1-P5 全竣工 + P4c 远景三档；**余 P2a 对齐 A\|B 环待实机拍板** | 从高度计算器升级为纸面排版引擎（lift 遮罩 / rich-inline 精确测量 / 来文变宽纸条 / 缩远墨迹 LOD 与小地图真墨）——[`pretext-typography-plan.md`](pretext-typography-plan.md) |
| **流式渐显渲染** | 1-2 天 | Claude Code 式增量淡入（旧块零动画），识别收在渲染器内部、不动数据管线——[`streaming-fade-render-plan.md`](streaming-fade-render-plan.md)（等拍板方案 A/B + 参数） |
| **出厂产物归家** | Proposed·Draft（未开工） | 一个产物 = 一个物理目录（魂身合一：实现从内核深处搬进插件包）——[`factory-products-homing-plan.md`](factory-products-homing-plan.md) |
| **v11 分析引擎** | 草案挂起（用户拍板挂起） | 动态边 + 查询预算 + 降噪分级三篇合一——[`v11-analysis-engine-master-plan.md`](v11-analysis-engine-master-plan.md)；D 篇原件 [`dynamic-edge-detection-plan.md`](dynamic-edge-detection-plan.md)（superseded，以主文档为准） |
| **会话存盘换轨（DSH 参照）** | 未定 | 参照 DSH 的会话持久化审计与移植——[`session-persistence-dsh-port-plan.md`](session-persistence-dsh-port-plan.md) |
| **钉住与纸条改造** | 未定 | 钉住/纸条 UX 重构 + UI 换装——[`pin-strip-rework-plan.md`](pin-strip-rework-plan.md) |
| **Skills 与 MCP 生产级改造** | 余文档收口 + 真机验收 | Commit 1-6 已落地——[`skills-mcp-production-plan.md`](skills-mcp-production-plan.md) |
| **卷首字节稳定性（前缀缓存）** | 中（动段表 + 基线重录双轨） | 记忆库坐卷首第 ~2.5k token ⇒ 每次「重启 + 记忆变动」整卷重算（实测 34.7 万 token 全价、命中率 99%→0.6%）；「把记忆段挪到卷首末尾」已验算**无效**（只省 2.8%）——[`prompt-prefix-stability-plan.md`](prompt-prefix-stability-plan.md) |
| agent-plugin **P4** 插件化全集 | 持续 | **D9 换轨：不等 DSH、自研为主**；存量拆解全清，剩 C12 dsh-compat 合法挂起 + 新能力走通道——[`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) |

## 等外部条件（挂着不动）

| 项 | 等什么 |
|---|---|
| agent-plugin **C12 dsh-compat** | P4 全清后的唯一合法挂起：DSH peer 出非 workspace 版本即启动（外部信号依赖；p4a 调研已备好契约地图，见 [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md)） |
| v4-pro-minimal AB 实验 | Linux 环境（Windows 不可用）；**且旧 harness 已删**（2026-09-16 `77ad6fe7` 后续一笔——`src-ui/tests/ab/` + `scripts/ab-test/` 是图谱时代化石，重跑需先重写 harness）——[`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) |
| repo 改名 GitHub 侧执行 | 用户操作；改名前不打发布包 |

## 真机验证欠账（代码完成、未实跑——**本表是唯一在办真值**）

| 项 | 欠什么 |
|---|---|
| ~~V5 拆除后的 Tauri 真机~~ | **大部分已跑（2026-08-22 自主段）**：真机启动 + 纸壳渲染截图取证 ✓；窗口控制 IPC 最大化/还原往返 ✓；冷启动缓存过期→重分析全链路 ✓；优雅关闭 lifecycle 全清 ✓。未覆盖：权限卡桥需真实 agent 写动作触发（需 provider 配置），留给带 API key 的会话 |
| ~~shell 捆绑 bash（P0-P5）~~ | **已实跑（2026-08-22）**：os_sandbox:: 17/17 绿；init_bundled 开发态兑底路径修正一处布局雷；src-ui tsc 绿 → [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) §4 |
| ~~browser CDP E2E-1/2/3/4/5~~ | **已实跑（2026-08-22）**：`cargo test cdp::` 35/35 全绿，含 E2E-5 多账号 cookie 隔离（上会话偶发失败本轮未复现） |
| session-ledger 真机三项 | 代码判据已测试钉死，真机未跑（需带 API key 会话）：① 重启工作集恢复；② 后台卷落盘；③ 续开查重——见 [`../archive/session-ledger-plan.md`](../archive/session-ledger-plan.md) §7（⚠️ ①已被 session-unify Q-B 取代：重启不自动摊开） |
| ~~workspace-flip 批 3 边界~~ | **作废（2026-09-09）**——「预热期内创建的会话缺 graph 工具」随图谱功能全量退役消失（兰台已零引擎内置接线） |
| ~~**分层重构真机验收四项**~~ | **图谱相关项作废（2026-09-09）**：①② 的「图查询」验收点随图谱退役消失；~~③ 跨工作区续开~~ / ~~④ Ungrouped 会话~~ 随归属反转作废——见 [`../archive/layering-rework-plan.md`](../archive/layering-rework-plan.md) §4.6 |
| **画布 Stage-3 实机待验** | 代码已落地（2026-08-25，门禁全绿）：① 书脊手感（左键定位轻动画 / 拖动落位幽灵+吸附 / hover 小卡合卷）；② 侧边栏折叠与状态点/相对时间/行操作；③ 生命周期闭环（新建→落位→展开→收起→删除）；④ 未摊开卷行点击展开补飞 + 视角自由拖拽——见 [`canvas-space/stage-3.md`](canvas-space/stage-3.md) |
| **画布 Stage-4 返工清单（P0-P4）** | 代码面已修（2026-08-26），待实机勾销：P0-1 全放确认+关窗崩溃 / ~~P1-1 自动选中三道闸~~（**拔源勾销 2026-09-10**——浏览跟随随拍板整体退役）/ P1-2 聚焦落点手感 / P3-1 非全屏布局——见 [`canvas-space/stage-4-rework-checklist.md`](canvas-space/stage-4-rework-checklist.md) |
| **创作坞+提供方联合体检验收七项** | 方案甲 + 全批修复已落地（2026-08-26 三 commit，门禁全绿）：① 卷间会话级模型/思考隔离；② 未改卷跟全局/改过卷不跟；③ 重启后各卷配置保留；④ 模型下拉列全+无 Key 标注；⑤ 测试连接后取消不落暂存；⑥ ↑↓ 历史+焦点回归；⑦ 后台卷运行态指示——见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) |
| **stream-rhythm 真机验收五项** | 代码五批全落地（2026-09-03，门禁全绿），待实机：① 长回合读起来是几个工作单元 + 换气；② Error 处明显转折（前置放空）且 Retry 紧贴；③ 流式活尾重排不引起视口上方跳动；④ 折叠组展开后判别量可见 + 「✓ 阶段完成」锚位置正确；⑤ 旧卷回放渲染正常、滚动不退——另带 **D1 间距三档（32/64/96）、D2 阶段细线形态与刀5 新词汇终审**——见 [`stream-rhythm-plan.md`](stream-rhythm-plan.md) §5 |
| **内核能力口收口 R3+R4 真机四项** | 代码十一插件全退役 + 十一能力口在产（2026-09-05）：① browser 全链路（含 sensitive 二次 Ask 与 audit）；② desktop 全链路（不抢焦点 / input lease 串行 / INVARIANTS #13 链路不变）；③ shell 粘性 cwd + bg 三件；④ 编辑（edit_file diff 快照与权限 Ask）——~~约束读写~~（**作废 2026-09-09**：constraints_cap 随图谱整口删除）——owner：用户 |
| **多模态图片线真机验收六项** | 代码 B1-B5 全落地（2026-09-09，门禁全绿）：① vision 模型贴截图 → 模型描述内容；② 非 vision 模型入口隐藏 + 强行含图不炸；③ 三入口齐验（粘贴/拖放/夹选）；④ 重启后缩略仍显示；⑤ 多图大图预算降级；⑥ 远端图回渲染 + 非白名单降级 alt——见 [`../archive/multimodal-image-plan.md`](../archive/multimodal-image-plan.md) §5——owner：用户 |
| **随包图谱引擎端到端** | 代码已落地（`engine-bundled-mcp-distribution`，2026-09-16）；**「拨开关 → 引擎真拉起 → 工具面出现图查询工具」从未在真机跑通过**。已实机取证的部分：打包 app 里 `engine_bundled_info` 返回 `available: true`（引擎在 `lantai.exe` 同级）、开关从未被拨（`lantai.bundledEngine.enabled` 为 null）——即**探测链路通、接线链路未验**。欠：① 拨开关 → 重开工作区 → 看状态栏回执与设置面板「接线回执」；② 无回执时报文可读；③ 引擎进程真起（任务管理器见 `hologram-engine.exe` 挂在兰台下）+ 工具面出现 `mcp__hologram__*`；④ 离开工作区进程真停（一进程一根 + 离开即停）——owner：用户（2026-09-16 用户报「开关在哪」缺陷后新立） |
| **创作坞浮动化手感** | 代码已落地（2026-09-17，门禁全绿，见 [`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §9.2）；jsdom 测不到的手感欠四项：① 按住坞书眉行拖动是否跟手（拖动期 PaperPanel 每帧重渲，真机帧率未测）；② 磁吸四锚位（左右缘 / 版心中轴 / 底带 / 最底缘）的吸附距离 24px 是否顺手；③ **双击坞头复位**在 WebView2 真触发（刻意没 `preventDefault` pointerdown，正为它让路）；④ 坞拖离底带后让位件（目次带映射区 / 小地图默认位 / 递牒卡 / 插件 dock）的视觉是否合意——owner：用户 |
| **顶部浮件（标题栏拆除）手感** | 代码已落地（2026-09-17，门禁全绿，见 [`../design/lantai-design-spec.md`](../design/lantai-design-spec.md) §14）；jsdom 测不到的手感欠四项：① **上缘边缘滚动**在真机是否终于顺手（指针甩到屏顶即滚）；② 浮件落位/宽度（右上、右距 80=目次带宽+16、宽约 470）在正文之上是否碍眼、是否压到你想看的内容；③ 浮件本体那段 x 区间**不滚**（它是「别的面」）能否接受——不爽可改「背后照滚」（`.pp-chrome` 进 `HOVER_ALLOW_DOCKS`）；④ 窗口拖动只剩浮件抓手（`画布` 二字 + 件间空白）是否够用——owner：用户 |
| **案卷侧栏载入体感** | 代码已落地（2026-09-18 侧栏载入批两批，门禁全绿；病灶与实测见 [`../landmine-map.md`](../landmine-map.md) S6/S8）——待用户体感确认四件：① 开侧栏是否不再「半天出不来」（清点 = 目录枚举 + 一份小 JSON，与历史卷数/体量无关；升级后**首次**开侧栏会补建卷目录，2.5 s 内阻塞 + 之后渐进填入，此后永不再补）；② 流式回话期间整机是否不再发滞；③ 清单读取真失败时是否如实显示错误而不是「本工作区暂无案卷」；④ 几百卷历史下侧栏是否仍即时（若仍慢，请报当时卷数与目录大小）——owner：用户 |
| **出处引导手感** | 代码已落地（2026-09-18，门禁全绿，六条验收见 [`pin-provenance-plan.md`](pin-provenance-plan.md) §6）——待用户体感确认六件：① 页边注第三行常显卷名是否够读、是否碍眼；② hover 引线的朱砂发丝在真纸上是否合意（不合意可换 `--ink-4` 石墨档）；③ **洞不在屏内时** hover 引线是否真的指得对路；④ 点行溯源飞行后「洞点名一拍」是否够醒目；⑤ 「未摊开 / 已删」两态的文案与不可点手感；⑥ 重启后卷名回读是否正常——owner：用户 |

## 已完成并归档（点名即可，详情勿读）

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
已作废的运行时线记录留 [`kernel-plugin-runtime-plan.md`](kernel-plugin-runtime-plan.md) 与
[`kernel-plugin-runtime-phase2-design.md`](kernel-plugin-runtime-phase2-design.md)。

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
