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
（三 commit，门禁全绿，实机验收七项待跑）；同日夜在册小账收尾（D2/C5/D5，体检全表清零）。
**Provider 数据模型重构收官（2026-08-26 夜）**：从「一 Provider = 一模型」走向
「可用模型列表 + 最近使用默认 + per-model 覆盖」——创作坞下拉只列配置面、同家多模型、
名字全宽；思考按钮常驻；「默认模型」选择器与「设为当前」退役（activeProvider = 最近使用）；
上下文/最大输出改 per-model（`modelOverrides`）。**baton 制退役，所有交接棒已归档**
（`docs/archive/lantai-handoff/`）。没有拦路的硬依赖。

## 会话 / 分层 / 画布 / 平台化 / 内核插件运行时五线（2026-08-24 起立项）

| 线 | 文档 | 状态 | 说明 |
|---|---|---|---|
| 平台化 | [`agent-platformization-plan.md`](agent-platformization-plan.md) | **全计划竣工（Phase 0-6，2026-08-25/28）**——Phase 6（平台税收口）：`57e935a3` 平台契约总览 + cookbook 八指南 + 三方发布路径 + 形状守卫/跨 seam 集成测试。交付用户验收 | 强制层/能力契约层二分宪法已入档；Phase 1 swappable seam；Phase 2 后端能力四 seam；Phase 3 组合域统一（seam 裁剪域 + 目录生成 + doc-sync + 契约版本化）；Phase 4 运行时插件全链路（D6 热重载 / D7 dynamicRunner + cordis 域 / D1 MCP 端到端 / D12 信任模型）；Phase 5 存量迁移（D13 agentLoop 降为默认实现 + eventBus 统一路径 + 零硬编码守卫）；Phase 6 平台税收口（平台契约文档 + cookbook + 发布路径） |
| 会话统一 → **归属反转** | [`workspace-session-ownership-rework.md`](workspace-session-ownership-rework.md) | **In progress：P1-P3 已落地**（2026-08-27，commits 40a43875/7b1d5a3e/cc0df8c0），P4 文档收口 + P5 实机验收进行中 | 推翻全局会话池方向——会话**物理归属工作区**（`{ws}/.lantai/sessions/` 唯一存储位，焦点/绑定/全局列表全退役）。旧 session-unify 计划已归档归档标记取代：[`../archive/session-unify-plan.md`](../archive/session-unify-plan.md) |
| 分层重构 | [`layering-rework-plan.md`](layering-rework-plan.md) | **L1-L4 + L5b crate 化已落地**（2026-08-25） | engine 纯化 + 壳瘦身 + 数据上下文 + 双工作区并发守卫 + L5b 三 crate 拆出；真机验收四项待跑（见计划 §4.6） |
| **内核插件运行时（已拆除）** | [`kernel-plugin-runtime-plan.md`](kernel-plugin-runtime-plan.md)（历史记录——现状真源见 [`kernel-plugin-architecture-decision.md`](kernel-plugin-architecture-decision.md) v3） | **已建成又已拆除（2026-09-05 v3 拆除令全文兑现）**：Phase 0-2 九域信封化竣工（2026-09-04，P2-0..P2-6 七 commit）后，v3 定稿改判——TS 策略建议层 + Rust 能力口强制层，tool_call 信封/PluginRegistry/manifest 镜像随 R2-R5 拆除（R4-5 f6b74343/8bb4dcc5 + R5 批 2 6819d63e + 批 3 44ba5429）；Phase 3 内核插件管理面随之作废 | 用户 2026-09-03 拍板立项（Rust 内核不再实现具体工具，全部走 ToolPlugin）→ 2026-09-04 v3 用户定论推翻：webview 无盘权形态下 DSH/Claude Code 式 Node 直碰信任模型不成立——工具编排归 TS 域插件（zod 真源）、Rust 只留能力口强制层（十一口 + 口内闸 + 应用壳），详见 kernel-plugin-architecture-decision.md §0-§2 |
| 画布空间模型 | [`canvas-space/canvas-space-model-notes.md`](canvas-space/canvas-space-model-notes.md) | **设计定稿；Stage-1 ✅ + Stage-2 ✅（实机已验）+ Stage-3 ✅（门禁全绿）+ Stage-4 ✅（2026-08-26 落地 + 返工修复 + 联合体检方案甲施工）+ Stage-5 ✅（2026-08-26 落地：布局持久化 + 公共物工作区级 + 零目录退役，门禁全绿）**，**Stage-6 进行中（2026-08-31 起 = §11 层次法立法 + UI 全面审计三轴批等 UI/UX 专项）** | 一整片会生长的纸 / 有界流区 / 宿主模型 / 三层导航 / 性能基准；阶段性展开文档见 `canvas-space/` 子目录；**provider/创作坞联合体检与修复见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md)**（方案甲定案 + 2026-08-26 修复落账 + 夜批在册小账收尾 D2/C5/D5，全表清零） |
| 引擎插件化 | [`engine-plugin-extraction.md`](engine-plugin-extraction.md) | **全计划竣工（Phase 0-5，2026-08-29）**——Phase 0/1/1.5/2/3：契约化（现 v4 = 11 壳方法 hidden tools）→ 分页栈整链删除 → 壳侧 transport → **摘 hologram-engine Cargo 依赖**（兰台全链路进程外消费：每工作区一个 `engine serve` 子进程，stdio MCP；notification 泵 + 崩溃重启持久化闭环 + 双工作区 e2e）；**Phase 4 免编译扩展面**：`plugins` 模块 + `HOLOGRAM_PLUGIN_DIR`（缺省 `<root>/plugins`）manifest 声明 language（扩展名表 + builtin/dll 语法 + 运行时 .scm 查询）/ framework（路由候选模式→route 节点）/ tool（schema + handler id 复用既有 handler，壳方法不入表）——`engine_init` 首行装载、`engine_status.extensions` 可见、单 manifest 失败不阻断启动、兼容由 `manifest_version` 管控；示例 `examples/engine-plugins/` 三 manifest 零 Rust 端到端生效；**Phase 5 收口**：gen-engine-plugin-contract 挂 doc-sync 门禁。门禁：引擎 lib 全绿 / doc-sync 全对拍 / 契约指纹一致；行为变更与施工落点见计划各 Phase 竣工记录 | 把图谱引擎拆成独立插件（2026-08-23 已定「Rust 侧插件化标准形态 = 外部 MCP server」兑现）；DSH 不共包 / monorepo 子目录已拍板；**待真机验收：开卷/切卷/图查询/工具调用/merge gate/图 hooks 全链路 + 崩溃恢复不挂主进程**；全仓旧时代残留清点见计划 §8——**§8 清理已部分执行（2026-08-29）**：8.1 死槽/死字段 + 8.3 物理残留全清，8.2 死装饰注解 + TCP 旧协议留专项，8.4 bench 脚本存疑未动 |

| **引擎-宿主逻辑全断** | [`engine-host-severance-plan.md`](engine-host-severance-plan.md) | **竣工（2026-09-08，五 commit `ecd64595`/`2cd4d751`/`8f6b3439`/`495b6652`/`777d4600`，门禁全绿：引擎 592 / 三库 53+46+16 / 壳 460+集成 1）** | 壳摘 hologram-graph/storage/vector 全部 crate 依赖（守卫 `shell_has_zero_hologram_crate_refs` 钉零直连）；引擎数据分居 `.hologram/`（`engine_init` 自动搬迁老 `.lantai` 引擎文件，宿主零感知）；壳侧向量召回改走引擎子进程（semantic_search 经 transport）；资产 onnxruntime/models/grammars 归位 engine/。壳对引擎的全部知识收敛为「spawn 二进制 + MCP 协议」两条；**真机验收四项待跑（计划 §4）**；同日附批 §7：宿主引擎面 rpc 死面清理（record_event / dataflow_delete 退役 + OAuth 分区补登生成器，用户拍板 B） |

| pretext 排版引擎 | [`pretext-typography-plan.md`](pretext-typography-plan.md) | **P1-P4 竣工（2026-08-30，commits `550973c6`/`14fa755c`，门禁全绿）**，P5 设计件待用户方向确认 · P2a 对齐 A\|B 环待实机 | lift 遮罩（抽纸条原地占位）/ rich-inline 精确测量（0.96 系数退役 + 圈点精确）/ 来文变宽纸条（shrink-wrap）+ 钉住/纸条宽度手调（pin.w 唯一真相）/ 缩远墨迹 LOD 行条骨架 + 小地图真墨——pretext 从高度计算器升级为纸面排版引擎，做聊天框做不到的事 |

| **组合粒度（per-agent composition）** | [`composition-architecture/designs/S6-per-agent-composition.md`](composition-architecture/designs/S6-per-agent-composition.md) | **P-1 + P0.5 + P0 + P1 + P2 已落地（2026-09-15）；P3 起待续** | 把组合从「全局状态的一次函数求值」推到「每 Agent 一份值」。**已落地（2026-09-14）**：**P-1 authoring 环境**（`composition_dir` RPC + 打开目录 + 复制内置为模板（拒覆盖 / id 围栏 / 内置 id 拒绝）+ 免重启重扫 `rescanPresets` + 设置面板作者块——单二进制下用户不动源码即可配 preset，四条缺项全补）；**P0.5**（minimal 轨重录 `office` 漏项 + `verify:convergence` 改双轨）；**P0 记录闭环**（卷落 `presetId` + 会话工厂按卷内记录的组合重建 + 恢复期校验与「本卷组合不可用」提示 + 连带修复改名不再抹掉 `tokens`/`compose`）。**P1 全部落地（2026-09-15，五笔 `6e3b3fb2`/`6abbcc30`/`9196f5da`/`cca04a58`/`fd30742c`）**：P1a 卷内记录不再被落盘改写（工厂回述记录给 Agent 镜像——此前重开旧卷再存一次即把 `presetId` 改写成全局默认）；P1b 选择集语义（`ToolContribution.defaultOff` + `disabled:false` 回开，**开放面契约 v31**）+ 诊断按原因分三栏（未选中 / 被禁用 / seam 裁剪——第四栏 `skipped` 留 P3，不预造空栏）；P1c 卷级选择写路径（`selectSessionPreset`：校验 → 空白闸 → 拆句柄 → 登记 → 空白卷即时重建）；P1d 会话工厂判据换轨为**组合身份**（输入派生 + 贡献代数——消掉「每卷白建注册表」的 F4 浪费且不复用陈旧注册表）；P1e **创作坞组合芯片**（无主态 = 新卷出生默认 / 空白卷 = 卷级 / 跑过一轮 = 只读标签）。**P2 全部落地（2026-09-15，两笔 `a1e83c8f` P2a / `53924344` P2b；施工单 `composition-architecture/work-orders/WO-S6P2-seam-value-injection.md`）**：seam 裁剪面从「全局一份」推进到「按 Agent 取值」——新增键控叶模块 `composition/seam-scope.ts`（装配期登记，键 = Agent bus id）+ `seamDisabled(domain, view?)` / `active*Providers(view?)` 可选视图 + `AgentEventBus.setSeamView`（每 Agent 一条总线，10 个 emit 调用点零改动）+ llm 经 `createProvider` 的 `options.seamView`；**无组合上下文的旧路径仍读全局当前选择（零漂移，双轨快照逐字节不变）**；`seam/sessionPersistence` 单点按裁定留独立批次（per-volume 后端要「读也按该卷组合」，需另立「卷→组合」外部索引）。**契约 v36/v37**。**待续**：P3 插件按需激活（引用计数 + 独占声明 + fail loud + 诊断第四栏）→ P4 程序入口（RPC/MCP 带 `preset`）→ P5 卷头只读标签 + 同屏并排。路线 = **视图 + 引用计数**（不抄 DSH scope realm，realm 仅作资源型插件逃生门）；不变式 = **门禁维度只在出厂 preset（用户 preset 走运行时校验，空间无限）**。立项输入 = 2026-09-14 组合层审计（F1-F6 断链修复批已落地）+ 用户四项拍板（含「preset 不上线，平台只提供环境」）；P1 施工中实测的环境事实（导入成环两次、`ui/` 冻结目录、`removeAgent` 清登记、`selectionError` 对未知 id 的容忍）记在设计件 §8.1；P2 实测事实（契约版本已漂到 v37、两处「源码窗口守卫」按固定字符窗口断言 `workspace.ts` 工厂正文、`familyContributions` 首装配锁存、`createLiveProvider` 的参数位）记 §8.2 |

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
| **OfficeCLI 集成（office-cli）** | **工程完成 + 真机复盘修复批已落（2026-09-15）；余：用户真机验收（含权限面判据）**——2026-09-13 立项并十窗完工：P0 平台前置（契约 v27）+ P4 窗入口二态（契约 v28）+ A 路落位 + C 路改判（MCP 挂接 → 一等 `office` 域工具，`2d54081f`）+ 哈希校验安装器 + 活预览两形态；2026-09-15 真机复盘（会话 23）暴露四处病灶（假成功信号 / argv 无上限 / playbook 教命令行 / 错误归因过宽，`4412ce87`）与 P0 权限判定（默认模式每次调用弹卡且规则无效，`f207e5f4` 强制层重构：`process_cap::office_exec` + `OfficeTool`），**全部已修**；门禁：cargo 467 绿 + office 面 18 例 + convergence exit 0。**余**：§6 六条真机验收（新增权限面判据）+ 产品方向件（工具结果携带图像） | 把单二进制 Office 套件接进兰台（起于 MCP 单工具 `officecli(command)`，2026-09-13 改判为域工具 `office(action,…)`）。**实测**：win-x64 31.87 MB / v1.0.149（哈希已核）；`view screenshot` 可用、`view html` 外链 CDN、watch 页 SSE 同源；并修掉平台洞「MCP 工具恒只读 ⇒ 写动作绕过 plan 模式与并发组」。见 [`office-cli-integration-plan.md`](office-cli-integration-plan.md)（§11 = 真机复盘 + R3 重构全过程） |
| **会话持久化 seam 接线（C 定案）** | ✅ 已竣工（2026-09-05，批 2/3/4 三 commit） | R5 落账窗发现空承诺（`sessionExecute` 产线零调用方——唯一设计消费方 agent-store 2026-09-01 已内存化；真实落盘链全在 seam 外直连）→ 用户拍 **C 把承诺做实**。**批 2**：四动作面重设计（read_volume/list_volumes/save_volume/delete_volume——会话语义，旧六动作退役）+ 默认 provider 走 kernel* 具名 helper（测试 mock 面零迁移）+ Service.execute 落位（sandbox 白名单变真）+ 开放面契约升 v13。**批 3**：chat-session.ts/chat-core.ts 产品会话卷 CRUD 全链接线 sessionExecute（冻结文件最小 diff）+ workspaceSessionsDir 导出收敛路径拼接 + 豁免三处显式注记（#9 导出/#10 脚手架/#11 workspace_remove）。**批 4**：文档面 + 落账。承诺句「插件注册 SessionPersistenceProvider 即接管产品会话持久化」由 sessions-seam.test ③ fake provider 端到端测试可证——plan 见 [`session-persistence-seam-wiring-plan.md`](session-persistence-seam-wiring-plan.md) |
| **软件级插件（app shell 四件套）** | **S0-S6 竣工（2026-09-06 五窗连推 S1→S5+S6 文档，门禁全绿）** | 2026-09-03 立案，2026-09-05 决策点全定稿，2026-09-06 开工当日全落地：S1 数据目录（dataDir + plugin_data_* + 宿主桥 fs + .trash 回收）→ S2 受治进程治理（restart/lifecycle 治理字段 + ServerGovernor 三档 + 进程树终止 + 决策 8 收敛：受治进程 = MCP server 一种；工具只有工具口 / MCP 路两张门）→ S3 窗口原语（manifest.app + 窗口注册表 + iframe 视口 + postMessage 白名单桥容器侧绑定 + 窗口设施 API；Rust 资产通道补 .html MIME）→ S4 后台唤醒（manifest.tools async:true 工具口 + lantai/deferred 完成通知 MCP 路 → 同一唤醒，minimal 定位键 {status, taskId, sessionId}）→ S5 范本 `examples/plugins/notes-app/`（两副面孔 server + 自包含窗页 + 守护测试真进程集成）→ S6 文档（plugins README §10 + cookbook plugin-as-software）。开放面契约 v14-v17 逐版在案。**余：管理 UI 面（启动器/任务栏——用户设计定稿后另批）+ 用户真机验收**——见 [`app-shell-software-plugin-plan.md`](app-shell-software-plugin-plan.md) |
| **插件 bundle 退役（30 个出厂插件全产物化）** | ✅ 已竣工（2026-09-03，S1-S6+S5b 七 commit） | **S2-S5 全部落地**：六供应商真源产物化 + 十六工具域/两段贡献薄壳→真源 + 装载调度层（依赖图 PENDING + boot 全 ACTIVE 审计 fail-loud）+ bundle 双轨拆除（BUILTIN_PLUGINS 44→14 内核，30 出厂产物走磁盘通道，displace 退役，dev/prod 双态 import.meta.env.DEV 隔离）。**S5b：agent-loop-service 产物化（模块级状态拆内核 agent-loop-active.ts），终态 14 内核 + 30 出厂产物。** 真机验收五项待用户跑**——见 [`plugin-bundle-retirement-plan.md`](plugin-bundle-retirement-plan.md)（§4） |
| **第一方代码热更（P0+P1+增补一二三四）** | ✅ 已竣工（2026-08-30/31） | P0 dev.cmd 热更工作流 + P1 渲染器插件通道化（2026-08-30）；增补四（2026-08-31 当日施工）：dev 不可用实锤后生产热更升格唯一路径——**kind='feature' 全量通道化**（23 个内置插件产物 = 渲染器 + UI 四面 canvas-nav/paper-shell/settings-domain/compose-dock + 16 工具域 + 2 段贡献；space-demo 退役），**位移式装载**（manifest.displace——bundle 兜底行 ↔ 产物行单活互换，失败自动恢复）、UI 四面组件源码双走查迁移（宿主桥 mods 共享真实例 + 产物 CSS 注入 + React 别名桥）、薄重导出产物（工具域/段贡献）、装载序=表序纪律；convergence 零漂移（快照重录免除），门禁全绿——见 [`first-party-hot-reload-plan.md`](first-party-hot-reload-plan.md) §8 |
| **会话流版式语法（stream-rhythm）** | 4-6 天 | **五批全落地（2026-09-03 三窗连推，门禁全绿；真机验收五项 + D1 间距值 / D2 细线形态终审待用户跑——见下方欠账表）**——事件语义分类（`paper/grammar.ts`：工具调用→读/写/验证/提交派生族，未知名兜底不破语法）+ 跨块工作单元（`paper/group.ts` 封套 pass）+ **版式语法表数据化**（补 seal/host 两动词）+ 节奏渲染（单元内紧 32 / 单元间 64 / Error 与阶段放空 96 + 阶段细线 --rule-soft）+ 两宪法（封口纪律：已封口单元不可变——布局级刚体测试钉死；跨消息前瞻禁止：单元不跨消息，消息边界即收口）+ 组原子性（虚拟化窗口不腰斩折叠组）+ foldLabel 判别量（组头露路径/命令）+ 目次带阶段导航（消费工作单元）+ Error 墨色家族确认（--fail 墨浓红，朱砂=人不挪用）+ **刀5 族节奏批**（真机判「还是瀑布」根治：**族边界切单元**——节律族切换即封口旧单元，读包/写包/验证包在回合内真实成组开火 + 折叠组按族切分 + 单元界短规线（全宽=阶段界/短线=单元界/无线=同单元）+ 验证链毕「✓ 阶段完成」锚 + 组头族签 读/写/验/落）——见 [`stream-rhythm-plan.md`](stream-rhythm-plan.md)（原方案全文存其附录 A） |
| **科研渲染（scientific-rendering）** | **4A + 4B 已落地 + 真机验收全过（4A 2026-09-07 用户确认；4B 2026-09 用户确认 §7 项 3-5 全过）+ #5/#15 批次推进已落地 + #10 化学式已落地（待真机验收 §7 项 6-7）+ #16 交互图表已落地（待真机验收 §7 项 8-9）+ #11 大表虚拟滚动已落地（待真机验收 §7 项 10）+ #20 PDF/Office 用户拍板暂缓（2026-09）** | 按「科研 Agent 渲染 20 种清单」倒查兰台（见计划 §0.1 对拍表：#11 落地后 ✅12 · ⚠️6 · ❌2）；确立双通道决策模型（正文 markdown 通道 / 产物资产通道）；**镜像治理前置**（CSS↔measure 人肉镜像债收口，§3）+ **首期两项并行**——**§4A 正文 LaTeX 数学✅**（markdown 单一解析 + KaTeX 渲染 + type-token 版式 + 静态预算/RO 实测；含公式 markdown 内容感知挂 RO；`tests/paper-math-rendering.test.ts` 17 用例；D1 不保守 D2 KaTeX 已拍板）· **§4B 引用卡 citation kind ✅**（2026-09：asset-kinds 增 citation kind + citation-card 表现原语 + type-token 版式 + measure 静态测高/RO 兜底；DOI/PMID/arXiv 链接化暂缓——opener RPC 未立，标识为 mono 纯文本；`tests/citation-card.test.ts` 14 用例）——见 [`scientific-rendering-plan.md`](scientific-rendering-plan.md)（真机验收清单在 §7）· **§5 轮子策略定稿**（2026-09-06）：现有 kind **无一需换 wheel**——chart 用「加 `interactive` 表现（ECharts）」非换；选型核验表（highlight.js/citation-js/smiles-drawer/mermaid/ECharts）+ 双渲染域依赖进场路径 + 后续批次见 §5 · **#5 代码高亮 ✅（2026-09）**（hljs `lib/common` + 补科研语言；renderer-service code case 拆 MdCodeBlock 组件接 hljs；measure 零镜像；`.pp-md-code` 内 hljs 类→纸面墨色 token；`tests/paper-code-highlight.test.ts` 6 用例）· **#15 任务列表 checkbox ✅（2026-09）**（GFM `- [ ]`/`- [x]` 剥 MdListItem.check + 纯 CSS 自绘框 + measure 最小行高；`tests/paper-checklist.test.ts` 11 用例）· **#10 化学式 kind chem ✅（2026-09-07，B 通道批次开推）**（asset-kinds 增 chem kind（name/formula/smiles）+ chem-body 表现原语：smiles-drawer 2.4.1 内联进 renderers 产物——分子 `SvgDrawer`/反应 `ReactionDrawer`，固定盒结构区 180px + name/formula 实测折行，解析失败错误可见不崩；`tests/chem-card.test.ts` 19 用例）· **#16 交互图表 ✅（2026-09-07，B 通道批次二）**（chart presentations 加 `interactive`——InteractiveChartBody + ECharts 6.1.0 进场（用户拍板 +219KB gzip 共享包；实测按需 640KB min 压不小，直用 core 不引 echarts-for-react）：tooltip/图例/dataZoom/工具箱；buildEchartsOption 纯函数 + 固定盒 260 token + RO 兜底；静态 chart 与历史块零影响；`tests/chart-interactive.test.ts` 18 用例）· **#11 大表虚拟滚动 ✅（2026-09-07，B 通道批次三）**（grid 自动虚拟化：>1000 行转 thead 固定 + tbody 滚动区 240 + 行窗口化，@tanstack/react-virtual 已在依赖零新增体积；table-layout fixed 双半对齐；小表 999 行全量平铺零变化；measure 镜像封顶不再全高延伸；`tests/grid-virtual.test.ts` 9 用例）· **#20 PDF/Office ⏸️（2026-09-07 用户拍板暂缓）**（PDF 内嵌依赖 WebView data: PDF 真机验证；Office 需解析引擎后置；media 保留文件壳） |
| **多模态图片链路（附图入卷）** | ✅ **已竣工（2026-09-09，B1-B5 五批全落地：0d2c39bd/b99c5217/9affbbf2/ed6008ef/8eaada50，门禁全绿）** | 全链：引用模型（字节永不进卷，INVARIANTS #14）+ write_base64 能力口 + 准入规整 + 三入口采集 + 附图 rail + **发送边界管线**（能力投影 inputModalities/预算降级保新弃旧/请求期解析缓存）+ 三适配器 wire 构造（openai parts/anthropic image blocks/responses input_image，纯文本形态字节不变）+ **渲染面**（用户气泡缩略两径回读——进程内预览 URL/盘上附件 data URI，重启存活 + markdown 远端图固定盒白名单 + measure 镜像）+ **配置面**（catalog seed vision 声明——anthropic/openai 全线 + deepseek vision-exp 款；ModelOverrides.input 覆盖链 modelInput 三面同链（能力戳/坞门禁/「视」徽标）+ 设置页参数面板「视觉模型」开关）——**余真机验收六项待用户跑（计划 §5）**——见 [`multimodal-image-plan.md`](multimodal-image-plan.md) |
| **流式渐显渲染** | 1-2 天 | 给流式文本装 Claude Code 式「增量淡入」（旧块零动画、只有新长出的小段浮现），覆盖 markdown 正文 / reasoning / notice / user 全文本 kind，统一不割裂；增量识别收在渲染器内部，不动数据管线（冻结文件不碰）——见 [`streaming-fade-render-plan.md`](streaming-fade-render-plan.md)（Proposed·Draft，等用户拍板方案 A/B + 动画参数） |
| **工具层人体工学 + 工具层智能** | ✅ 已竣工（2026-08-30 当日实施） | notes [`tool-ergonomics-notes.md`](tool-ergonomics-notes.md)；设计件 ×2 rev2 全落地：[`tool-ergonomics/design-1-context-waist.md`](tool-ergonomics/design-1-context-waist.md)（JS 上下文腰：per-owner 注册表 `agent/session-context.ts` + fs/git/search 相对路径/省缺填充/可见键归一 + 描述瘦身）+ [`tool-ergonomics/design-2-session-focus.md`](tool-ergonomics/design-2-session-focus.md)（fs 焦点文件 read/edit 省缺 + `[file:]` 回显 + desktop 粘性窗口；graph nodeId 裁决不做）——**Rust 零改动**（enforcement 留 Rust，resolution 归 JS 平台层）；门禁全绿 + baseline freeze（附带补录 56fb9285 漏掉的 minimal system-prompt 重录） |
| **Agent 资产块（块协议落地）** | 已竣工 + **渲染跟上批（2026-09-06）**（[`agent-asset-blocks.md`](agent-asset-blocks.md)）——WO-1..WO-8 全 ✅ + 渲染跟上批 ✅ | **设计定稿 + 拍板全齐 14 项；WO-1 ✅（协议与类型）WO-2 ✅（工具三件套 + executor 资产通道 + baseline 获批 record）WO-3 ✅（block-model 开放 + translate 映射）WO-4 ✅（兜底 JSON 渲染 + 文类签）WO-5 ✅（资产表 + update 广播 + pinned 孤儿刷新）WO-6 ✅（首发表现原语）WO-7 ✅（持久化/回放）WO-8 ✅（html 沙箱）**——Agent 随时生成可引用/更新的资产块：show_asset / update_asset / list_block_kinds 三原语 + BlockPart + **语义 kind / 表现 presentation 双维度正交**（7 族判据 + 会话级资产表 A7 + html 沙箱逃生舱；graph 轻量 SVG 兑现图谱内化 ADR）；**渲染跟上批（2026-09-06）**：confirm 真实回调面（executor 预发卡 + 阻塞决议回传 + 决议终态持久化）/ deps_impact 空数据占位 / board+timeline 两表现原语补齐（10 原语全谱）/ graph 分层布局（A5 二期）/ 产物通道装配断层对账（renderers 缺席不再静默落 JSON）/ 资产表会话重建（重启后 update_asset 的 U 面续命） |
| ~~rpc 返回值 Value 化~~ | ✅ 已毕 | 三步全落地：第一步出口结构化 + typedJsonRpc 单点收敛（2026-08-22，be8bba85）；第二步 B 路线命令→形态分派表 + 前端双形态 shim（2026-08-22，63e0fd77/a59fc086），真机双轮验证过（CDP 形态断言 + 真实会话全工具链）；**第三步边界 schema（2026-09-01 当日竣工，ea1606b6 合入 main）**——rpcResultSchemas 同址共治 + typedJsonRpc 签名一刀切收紧（未登记命令 = 编译错）+ 违形即 throw + 三重守护测试，设计件 [`rpc-runtime-validation-design.md`](../design/rpc-runtime-validation-design.md)，批二长尾无施工日（签名强制未来调用者入表）→ [`landmine-map.md`](../landmine-map.md) 根治级段；残留仅 DataflowPanel.tsx 启发式一处（P2 段在册） |
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
| ~~workspace-flip 批 3 边界~~ | **作废（2026-09-09）**——「预热期内创建的会话缺 graph 工具」随图谱功能全量退役消失：兰台已零引擎内置接线，图工具面整体退役（见本表图谱退役行） |
| ~~**分层重构真机验收四项**~~ | **图谱相关项作废（2026-09-09）**：①② 中的「图查询」验收点随图谱全量退役消失（兰台零引擎内置，图工具面退役）；~~③ 跨工作区续开~~（作废——workspace-session-ownership-rework D2 拍板，2026-08-27）；~~④ Ungrouped 会话可用~~（作废——零目录会话随同一反转退役）——见 [`layering-rework-plan.md`](layering-rework-plan.md) §4.6 |
| **画布 Stage-3 实机待验** | 代码已落地（2026-08-25，门禁全绿）：① 书脊手感（左键定位轻动画 / 拖动落位幽灵+吸附 / hover 小卡合卷；右键菜单已取消，改名/删除在侧边栏）；② 侧边栏折叠（收起只剩书脊）与状态点/相对时间/行操作；③ 生命周期闭环体验（新建→落位→展开→收起→删除）；④ 未摊开卷行点击展开补飞 + 视角自由拖拽（定位动画不再抢手动 pan）——见 [`canvas-space/stage-3.md`](canvas-space/stage-3.md) |
| **画布 Stage-4 返工清单（P0-P4）** | 代码面已修（2026-08-26），待实机勾销：P0-1 全放确认+关窗崩溃 / ~~P1-1 自动选中三道闸~~（**拔源勾销 2026-09-10**——浏览跟随随拍板整体退役，详 stage-4-rework-checklist.md）/ P1-2 聚焦落点手感 / P3-1 非全屏布局——见 [`canvas-space/stage-4-rework-checklist.md`](canvas-space/stage-4-rework-checklist.md) |
| **创作坞+提供方联合体检验收七项** | 方案甲 + 全批修复已落地（2026-08-26 三 commit `efc74e7d`/`254ad008`/`36ad9ed5`，门禁全绿）：① 卷间会话级模型/思考隔离；② 未改卷跟全局/改过卷不跟；③ 重启后各卷配置保留；④ 模型下拉列全+未配置厂商不出现+无 Key 标注；⑤ 测试连接后取消不落暂存改动；⑥ ↑↓ 历史+焦点回归；⑦ 后台卷运行态指示——见 [`canvas-space/composer-provider-audit.md`](canvas-space/composer-provider-audit.md) 修复落账节 |
| **会话流版式节奏（stream-rhythm）真机验收五项** | 代码五批全落地（2026-09-03，门禁全绿；刀5 族节奏批后节奏词汇在族边界真实开火——此前的「还是瀑布」反馈已根治），待实机：① 长回合（≥10 次工具调用）读起来是几个工作单元 + 换气（读包/写包/验证包 + 单元界短规线 + 组头族签 读/写/验/落），不是等距瀑布；② Error 出现处明显转折（前置放空），Retry 紧贴其后；③ 流式中活尾重排不引起视口上方跳动，回合 finalised 后永不再动；④ 折叠组展开后文件路径判别量可见（折叠行露判别字段）+ 验证链毕「✓ 阶段完成」锚出现位置正确；⑤ 旧卷回放（任一历史长卷）过新管线渲染正常、滚动性能不退——另带 **D1 间距三档（32/64/96）、D2 阶段细线形态与刀5 新词汇（单元线宽度 96 / ✓ 锚 ink-3 / 族签用字）终审**（taste-ledger 待用户判）——见 [`stream-rhythm-plan.md`](stream-rhythm-plan.md) §5 |
| **内核能力口收口 R3+R4 真机四项** | 代码十一插件全退役 + 十一能力口在产（2026-09-05，R3 fs/git/shell + R4 browser/uia/web/constraints/pty/lsp/editor 七 commit 全绿），真机待跑：① browser 全链路（launch→discover→connect→attach→snapshot→click/type→sensitive 二次 Ask 弹窗→audit 审计可见——browser_cap 直呼后权限分层与敏感目标 Ask 与收口前一致）；② desktop 全链路（probe→tree→click pattern 不抢焦点→type 物理路径 Ask→input lease 串行——uia_cap 直呼后 INVARIANTS #13 链路不变）；③ shell 粘性 cwd + bg 三件（R3 已立账三项沿用）；④ 编辑（edit_file diff 快照与权限 Ask）——~~约束读写~~（**作废（2026-09-09）**：constraints_cap 随图谱全量退役整口删除）——owner：用户 |
| **多模态图片线真机验收六项** | 代码 B1-B5 全落地（2026-09-09，五 commit `0d2c39bd`/`b99c5217`/`9affbbf2`/`ed6008ef`/`8eaada50`，门禁全绿），真机待跑：① vision 模型（GLM-4V/Qwen-VL/deepseek-vision-exp 任配；目录外款在 设置→Provider→参数面板开「视觉模型」开关补声明）贴截图 → 模型描述图片内容（而非 read_file 报错）；② 非 vision 模型附图入口隐藏 + 贴图提示，强行含图历史 → 投影占位不炸；③ 三入口齐验（Ctrl+V 粘贴截图 / 拖放图入卷 / 夹选图）；④ 重启后历史卷用户气泡附图缩略仍显示（盘上附件回读慢径）；⑤ 多图/大图预算降级（超限图换占位文本，对话不炸）；⑥ 模型回 markdown 远端图渲染 + 非白名单源降级 alt 文本——见 [`multimodal-image-plan.md`](multimodal-image-plan.md) §5——owner：用户 |

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
