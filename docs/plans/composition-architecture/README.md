# 组合架构（composition-architecture）——特权线左移计划

> **本目录阅读顺序**：① 本 README（宪法 + 阶段 + 排程）→ ② `work-orders/`（施工单，按编号即执行顺序）→ ③ `designs/`（设计件，S1/S2/S4 已竣工）。边界依据在 `docs/adr/composition-boundaries.md`。当前状态：**S0 Done（Landed）；S1 Done（2026-08-20，9 commits）；S2 Done（2026-08-20 全批次落地）；S4 Done（2026-08-20 落地——S4-0/1a/1.5/2/3/5 六批全绿，S4-1b 持 Phase 5 change request 用户批准后另启，S4-4 机器桥按排程可降级未决项）**。

> 立项：2026-08-20 · 主导：Agent（设计/实现/验收），用户（拍板/审批/放行）
> 状态：**In progress — S0-S2 Done · S4 主体 Done（2026-08-20：preset realm + 热重载 + npm 安装通道 + 消费闭环 + hello 闭环 + 文档全套；唯一遗留 S4-1b 会话事件 + minimal baseline freeze——批间审批门待用户出场）· 下一步 S3 设计件（等纸工程）**
> 取代：`.hologram/plans/plan-1787199847398-bu20.md`（plugin-ecosystem v1「插件口子」计划——其 P0/P1 被吸收为本计划 S0/S1 零件，P2 降级为 S3 第一项，P3 后移至 S4）
> 边界依据：`docs/adr/composition-boundaries.md`（为什么不做/做不到 DSH 式全体插件化——先读它，本计划在它划定的边界内施工）
> 关联计划：`agent-plugin-architecture-plan.md`（执行原语 + 工具面收口——其 P3 cordis 收口与本计划 S1 汇流，P4 路线 B 自研插件边界由本计划承载，D8 观望决策继续有效）
> 前置工程：cordis-migration（Done）· agent-core-convergence（Done，本计划将触及其 baseline 体系——见 R1）

## 一句话

把「给固化宿主开插件口子」反转为「移动特权线」：内核线收敛到最小，线外一切——**包括第一方代码**——走同一条声明式组合管道（roster 行 + patch 叠加 + preset realm）。

## 宪法（内核线定义，先于一切阶段）

**内核线内（特权代码，永不插件化）：**

1. cordis kernel（vendored）+ 根引导（`initCordisKernel`）
2. Loader + 组合引擎本体（roster 数据解析 + patch 叠加 + 行生命周期）
3. slot / 注册表本身（panels/commands/tools/providers 四 service 的注册机制）
4. React root 挂载点 + 壳容器（App 骨架 / DockRail / DockPanel 容器 / StatusBar / CommandBar）
5. RPC 平台面（`rpc.rs` 133 方法冻结契约 + `agentInvoke` 动态分发 + biome 两个受权出口）
6. **Agent↔engine 耦合带**：图数据管线、graph hooks（preflight/impact）、执行腰——产品核心，永久特权（理由见 ADR §4.1）
7. 星图 scene（`src/scene/**`）——GPU 资源 + dispose 纪律，永久豁免

**线外一切皆行：** 面板 / 命令 / 工具 / provider / system-prompt section / 第一方功能域。

**试金石：** 独占进程级单例资源或有顺序契约 → 宿主；功能面 → 行。

## 与 v1 计划的宪法差异（为什么必须换版）

| 维度 | v1（plugin-ecosystem） | v2（本计划） |
|---|---|---|
| 第一层宪法 | 「宿主壳永不插件化」——永久特权线画死在功能面上 | 内核线——壳**容器**仍特权，功能域皆行 |
| 内置 66 工具 | append-only、永不动序、永不被禁 | 默认 roster 的行：id 寻址、可 disabled、可配置 |
| 字节契约 | 全局冻结 | **per-preset 确定性组合**：同一 preset → 同一表序 → 前缀缓存照吃 |
| settings 迁移 | 唯一范本 | 第一个（后面跟着整个面板层 + 命令层） |
| 终点 | 「带插件的单体」+ 四通道扩展机制 | 组合均匀性：第一方 = 出厂默认 roster |

v1 的问题不是零件错了（四通道原语、loader 设计都是对的），是宪法与目标矛盾：**在冻结宿主的计划上追加阶段，到不了以溶解特权为定义的终点。**

## 阶段

每阶段契约：**commit 前全绿**（`cd src-ui && npm run build` + `npx vitest run` + biome 改动文件零新增；触 agent 工具面加 `npm run verify:convergence`；触 Rust 加 `cargo check` / `cargo test`）。

### D0 — 宿主选择（2026-08-20 四问访谈：方向已定——自己的组合层）

**访谈结论（用户四答要点）：**
1. 产品终局：HoloGram = **两个产品共居一个软件实例**（代码图谱 + Agent 工作台），因集成需求合体，产品定义上确为两物。
2. 白纸 §5.2 表仅初版；Agent 层动不动取决于整套设计定稿之后。
3. DSH 平台赌注：**不接受全部押注**——「DSH 是 agent 软件，我也是 agent 软件，我依赖 DSH 活，我的 agent 就没了身份定义」。
4. 耦合带处置：「为什么重写为 DSH 插件，而不是重写为我自己的插件？」

**决策合成：世界 B（DSH 宿主）出局。** 它的真实成本从来不是工程量，是产品身份。世界 B 的定义是「住在 DSH 壳里」，而 DSH 组合层是那里唯一的公民权形式——Q3 已拒其前提，Q4 是拒绝的形式化表达。剩世界 A：**自己的插件体系——仿 DSH 的模式，不仿 DSH 的形态**（ADR 已定案「同构但不同形」）。DSH 插件在本架构中的唯一角色是既有的 `hologram-dsh`：**机器暴露给 DSH 的方向**（机器供应商，不是租客），已建成运行。

**两产品形式化（内核线即产品分界线）：**

- **产品 G（图谱机器）**：engine + 认知层（graph 工具 / preflight / impact）。居内核线之下，宿主无关——今天已同时服务三个消费者：HoloGram 自家 Agent（TCP 9777）、DSH（dsh-bundle stdio MCP）、外部 MCP 客户端（Cursor / Claude Code）。「图谱机器是独立产品」不是构想，是已在运行的事实。
- **产品 A（Agent 产品）**：组合层 + 壳 + 会话/工具/面板。居内核线之上，一切皆行——HoloGram 的身份所在。
- 耦合带（宪法第 6 条）= A 消费 G 的桥，永久特权。两产品共居一个二进制而不纠缠，靠的就是这条线；**「两个产品」不是待修复的问题，是软件的真实形状，组合架构是让共居成立的工具**。

**排程（2026-08-20 二次修订：本计划与 paper-shell 为两个独立工程，无主从阶段）：**

- **本计划核心**：S0 → S1 → S2，绿灯模式推进（用户角色 = 批准 S1 设计件【已预写，约半小时】+ 看绿灯放行 commit，门禁替你看）。
- **paper-shell（`../paper-shell/`）是独立创作工程**，由用户决定何时开工、做多久（月级共同创作，高频沟通-修改-测试循环是其本体）。它对本计划的唯一硬依赖：V3b 壳装配需 S1 完成——串行下自然满足，并行下也兼容。
- **S4 提前到纸之前**（2026-08-20 三次修订，用户拍板：S2 完 → S4 → 前端工程 → S3）：S4（preset realm / npm 分发 / hello 示例）与纸无耦合，提前零返工风险；且 **preset realm 恰是 V5 壳切换要用的机器**（观测台 preset / 纸壳 preset = 同一组合引擎的确定性双装配，共居期直接踩在它上面）——纸开工时地基现成。附带心智收益：前端工程期间组合层「除 S3 外全部完工且经 hello 闭环验证」，不会中途爆雷打断创作。
- **S3 是唯一有资格等的**：它等的不是时间，是纸做出来——「重构推到哪个域，行化跟到哪个域」，且图谱面板终局已定（workspace ADR：退役路径非行化路径），S3 名单只剩 Agent 产品域（settings / 命令面板等）+ workspace 翻转收尾（同窗协同）。
- 排程史（诚实记录）：上午稿 = 并行（被否，优化错了资源）；下午稿 = 三阶段串行把白纸当阶段 2（被否，把创作工程塞进机械工程模板，否认其主体工作量）；二次稿 = 两独立工程 + S4 纯排后；本稿 = 用户主动序：**S0-S2 → S4 → 纸 → S3**（理由：流程简单化 + preset 提前造好 + 前端期间组合层静默）。

白纸与组合层在架构上收敛而非竞争：其块协议（`docs/design/一张纸-Agent软件交互形态设计.md` §3.2 语义声明 + 可插拔渲染器）本身就是一个插件面——块渲染器 = ctx service 行，白纸壳 = 组合层的又一个消费者。纸成则长在组合层上，纸败则观测台仍在：**壳切换 = roster 变更，不是重写**。Agent 层将来动不动，也随之从「单体手术」降级为「行组合调整」。

### S0 — 装载通道 + 插件内核（v1 P0 扩展；1-2 天）— ✅ Done（2026-08-20 Landed）

v1 计划唯一未验证的硬前提：**生产 webview 从 `tauri.localhost` 加载静态 dist，全部 import 是编译期 chunk**（asset protocol 未开、无自定义协议注册）——「扫目录 → dynamic import entry」今天不成立。解锁原语已有：`llm_proxy.rs`（127.0.0.1:14570，已无条件加 CORS 头）加静态文件路由即可，即 DSH webserver 服务 `/plugins/<id>/client.js` 的同构物。

- `src-tauri/src/llm_proxy.rs`（或独立 `plugin_server.rs`）：`/plugins/<id>/*` 静态路由，路径遍历防护，仅 loopback（跑 `cargo test`）
- `src-ui/src/plugins/`：`types.ts`（PluginManifest + HologramPlugin）+ `loader.ts`（扫描 `~/.hologram/plugins/` → 校验 → import → `root.plugin(obj)` → fiber 记录；单插件失败不炸应用）+ `plugin-store.ts`（zustand，`src/state/`）+ 启用持久化
- **加载协议纪律**（学 DSH `seed.ts` 冻结 module table）：插件只能 import 白名单（react / cordis / 宿主服务面），loader 层强制；白名单 = 平台契约，变更走文档
- 测试：manifest 校验 / 失败隔离 / disabled 跳过 / fiber dispose 后注册表清理

**验收：** 手放一个坏插件进目录，应用正常起、状态可见；一个示例插件从磁盘经 14570 通道装载成功。

**落地记录（2026-08-20）：** S0A spike 取三分支之 ✅（假设证实：webview 从 14570 import ES module 可行，spike 代码已清）。S0B 落地 `plugin_assets.rs`（静态路由：遍历防护/仅 GET/仅 loopback/MIME 含 .wasm/JSON 错误/junction 测试）+ `plugins/types.ts`（zod manifest）+ `plugins/loader.ts`（失败隔离永不 reject/disabled 跳过/inject 装载期校验/端口经 llm_proxy_port RPC 解析）+ `state/plugin-store.ts` + main.ts 接线 7 行。手动验收全过（坏插件 error 状态不炸应用、hello 装载成功、disabled 实测、生产 origin `tauri.localhost` import 随 `cargo tauri build` 验证——console 捕获 `[plugin] loaded: hello`）。门禁：cargo test 356+14 全绿、vitest 1307 passed、build/biome/convergence 零新增。**加载协议纪律（import 白名单）顺延至 S1**：四 service 尚不存在，插件现阶段能 import 的只有通道本身，白名单强制随注册表化一起落。启用持久化（plugins.json disabled 集）已含。

### S1 — 注册表化（决战；v1 P1 扩展 + agent-plugin-arch P3 汇流）— ✅ Done（2026-08-20）

四 service 挂根 Context + 内置面行化 + 字节契约重设计。**本计划最大工程债与最大风险段**（R1），可按域分批。

**落地记录：** 按设计件批次序列 S1-0…S1-5 全部完成（9 commits，`cd9092fa`…`55c5177a`），每批独立全绿。核心交付：preset 维度基建（gate/快照路由/contributions 显式参数）→ 四 service（ContributionRegistry 内核：装载期重名拒绝 + disposer 双守卫）→ 工具行表 `composition/tool-rows.ts`（14 行全部内置族，表序=组合序，行 factory 支持 async）→ 装配末端整体改读行表（`createCodingTools` 兜底退役，名字冲突装载期拒绝测试就位）→ system-prompt section 注册表 `composition/prompt-sections.ts`（13 段，两装配面 applicable 分流）→ `DockPanelId` union 退役（string 开集 + panel-def 装载期校验 + panel.* id 对拍）。**§2.4 零漂移规则全程生效**：每批不设 CONVERGENCE_PRESET 跑 verify:convergence，三个 tool-schemas 快照 + system-prompt.fixture 逐字节零漂移，baseline 零触碰（S1-4 曾拦下一处 \n 分隔符漂移——安全网实战有效）。终态门禁：vitest 1338 passed / 1 skipped、build exit 0、biome 零新增。

1. 四 service：`ctx.commands` / `ctx.panels` / `ctx.tools` / `ctx.providers`（注册 → disposer；panel-def 的 `DockPanelId` union → string + 装载期运行时校验；dock-store `open` 改 `Record<string, boolean>`）
2. **内置 66 工具从编译期固化为默认 roster 行**：`buildToolRegistry` 末端的贡献并入改读行表；行 = `{ id, factory, config?, disabled? }`；id 寻址 + 名字冲突装载期拒绝
3. system-prompt section 化：persona 拆 section 注册表（学 DSH `system-prompt` 行 + 插件自带 prompt section）
4. **字节契约重设计**：convergence baseline 从「全局唯一装配」改为「per-preset 分组对拍」——同一 preset 组合序确定 → effective 快照与前缀缓存语义保持；baseline 变更走既有 change request 审批
5. 生效语义写死：工具/provider 贡献下次 Agent 装配生效；命令/面板即时生效（文档如实声明）

**验收：** 四通道注册/卸载/冲突拒绝 vitest 全覆盖；内置工具经行管道装配后 effective 快照与现行对拍零漂移；`verify:convergence` 绿。

### S2 — 组合外化（1-2 周量级）— ✅ Done（2026-08-20）

- roster 数据文件（yml，学 DSH 行语义：id 寻址 / config 覆盖 / disabled / insert）+ 分层 patch（出厂 → 用户 `~/.hologram/` → overlay）
- `blueprint.standard()` 从手写 capability 表改为**由 roster 行生成**（表序 = 行序，Phase 6 铁律换真源不改语义）
- `main.ts` 收缩为薄引导（现 904 行硬编码装配 → 目标 <100 行；学 DSH `apps/web/src/main.ts` 8 行 + 壳装配插件化）

**验收：** 改一个用户层 patch 文件即可禁用一个内置工具/换一段 persona（无需重编译）；main.ts 净减行；全门禁绿。

**落地记录（2026-08-20）：** 设计件经用户授权代理复审后 6 批全落地（`28f6612d` 设计件 → S2-0 `6d4667c4` → S2-1 `02a7f751` → S2-2 `39850ea9` → S2-3 `51267323` → S2-4 `0ff58774` → S2-5 文档收尾），每批独立全绿（build + vitest + biome 零新增 + verify:convergence 零漂移；S2-2 起 + cargo test）。核心交付：`composition/roster.ts` 解析引擎（四域行模型 + last-write-wins + all-or-nothing + 诊断）→ 装配面穿线（toolRows/sections/fromRoster 全带出厂缺省参数）→ 用户层通道（Rust `/composition/` 路由 + patch-loader + composition-store）→ 12 壳行拆解 main.ts（919 → 37 行，行实现 `src/shell/rows/*` + `src/shell/boot.ts` 编排器）→ 用户文档 `docs/composition/README.md`。已知涟漪（prompt 规则 #13/#14 静态枚举、热重载延期 S4）如实在设计件 §2.8 与用户文档记录。

### S3 — 第一方行化（逐域迁移纲领；与前端重构排程协作）

- 第一个：settings 面板 → `hologram/settings` 插件（v1 P2 原案：迁面板+命令+`toggle-settings`，不迁 settings 持久化与 workspace 级订阅）
- 后续逐域：命令面板 / check / constraints / dataflow / tasks 面板 → 各自插件；每域独立 commit、行为逐项对拍
- **与前端重构的协作纪律**（学 agent-plugin-arch D6）：重构推到哪个域，行化跟到哪个域——一场迁移不叠两次 diff；重构未动的域不抢跑
- 星图 scene 永久豁免（宪法第 7 条）

**验收：** 每域迁移前后行为对拍清单全过；第一方代码在插件目录下的占比持续上升（工程健康度指标）。

### S4 — preset realm + 分发 + 机器桥

**落地记录（2026-08-20）：** 设计件经三轮复审后 6 批落地（`c7e089ff` S4-0 → `01c035f8` S4-1a → `8f8b131e` S4-1.5 → `b366422d` S4-2 → `7913d266` S4-3 → S4-5 收尾），每批独立全绿（build + vitest + verify:convergence 零漂移 + biome 零新增；触 Rust 批 + cargo test）。核心交付：preset 数据模型（内置表 standard/minimal + `/composition/presets/` 索引路由 + 发现层 + preset-store）→ 装配穿线（createAgentFromContext/createAgent 可选 composition 覆盖参数 + ctx composition 服务子 Agent 继承 + 会话工厂会话作用域注册表机制位 + boot 组合链）→ 消费闭环接线（G0 修复：panelDefs()/命令面板/插件工具行折算——四 service 贡献首次流进渲染面与装配面）→ 热重载（composition_watcher → composition:changed → reloadCompositionPatch；patch 删除显式回退；设置面板「组合」诊断节 + preset 选择器）→ npm 安装通道（plugin_install 三形态源 + tar-slip 双重围栏 + 原子落盘 + plugins.json 读改写 + 设置「插件」tab + 供应链警告）→ hello 闭环（`examples/plugins/hello/` 三通道 + 宿主桥 + e2e 钉面）+ 文档全套（`docs/plugins/README.md` 新建 + `docs/composition/README.md` 扩 preset/热重载段 + AGENTS/CLAUDE/CONVENTIONS 纪律回写）。
**遗留：S4-1b（会话 `preset/selected` 首事件 + minimal preset baseline freeze）**——动 session-log 冻结面，批间审批门（Phase 5 change request）待用户放行后另启批实施。S4-4 机器桥（manifest mcpServers）按设计件裁定可整体跳过（未决项——hello 三通道不依赖它）。

- per-session / per-agent preset：每会话挂自己的行组合（DSH agent preset 同构；工具面随 preset 变化，前缀缓存按 preset 分组——S1 已铺）
- npm tarball 源 + 安装 UI（v1 P3 原案：设置面板「插件」节 + Rust `plugin_install` 命令 + 供应链警告）
- 可选：**通用外部进程桥**——`dsh-bundle/cordis.patch.yml` 模板产品化（spawn + stdio 透传，一条 RPC），让插件能挂任意外部机器进程
- `examples/plugins/hello/`：1 面板 + 1 工具 + 1 命令，照文档从零写一遍装上能跑（「假装是外人」验收工装）

**验收：** hello 插件经完整链路装-用-卸；禁用/删除后注册表与 UI 干净退出；文档全套（`docs/plugins/README.md` manifest 规范 + 四通道 API + 完全信任警告 + KV-cache 注意事项 + ADR 引用）就位。

## 风险表

| # | 风险 | 对策 |
|---|---|---|
| R1 | **convergence 重设计**（S1 动了 8 baseline 的地基） | 最大风险段：S1 开工首日先出 baseline 分组重设计方案（机械安全子集先行 vs 一次到位），走 change request 审批；每批工具行化后对拍 |
| R2 | 字节契约迁移期回归（前缀缓存漂移） | per-preset 确定性 = 组合序确定；对拍 effective 快照进每批验收 |
| R3 | 两场大工程并行的 diff 叠加（前端重构 × 行化） | S3 协作纪律：重构到哪行化到哪；未动域不抢跑 |
| R4 | 组合税（新功能必须写成行的纪律成本） | 写进 AGENTS/CONVENTIONS 贡献面纪律；PR 审查试金石：新功能是行还是特权代码堆积 |
| R5 | 14570 加载通道安全（路径遍历 / 任意代码加载） | 仅 loopback + 路径归一化白名单 + 完全信任模型双重显式警告（沿用 v1 已拍板决策） |
| R6 | `DockPanelId` union → string 丢类型收紧 | 注册表键 + PanelDef 装载期运行时校验；既有 `panel.*` action id 不变（v1 对策沿用） |

## 明确不做（永久边界，理由见 ADR §5）

进程内宿主插件（webview 物理边界）· Agent↔engine 耦合带拆解（产品核心）· 星图 scene 插件化 · typert 跨进程类型协议 · Node sidecar 宿主臂（可后补的加法，不预支——dsh-bundle 已证外部进程模式覆盖机器扩展大头）· marketplace / HMR / 真沙箱（v1 延期清单沿用）。

## 施工单与设计件索引（执行 agent 的入口，2026-08-20 备齐）

| 文档 | 状态 | 说明 |
|---|---|---|
| [`work-orders/WO-S0A-spike.md`](work-orders/WO-S0A-spike.md) | **✅ 完成**（分支 1：假设证实） | 装载通道验证 spike（小时级，第一刀）——验证「webview 能从 14570 import ES module」这一物理前提 |
| [`work-orders/WO-S0B-plugin-kernel.md`](work-orders/WO-S0B-plugin-kernel.md) | **✅ 完成**（含生产 origin 验证） | 插件内核：正式静态路由 + loader/manifest/plugin-store + main.ts 接线 + 测试 |
| [`designs/S1-convergence-per-preset.md`](designs/S1-convergence-per-preset.md) | **已批准并竣工**（2026-08-20，用户授权代理执行） | S1 开工首日交付物已预写：preset 维度加法设计 + 批次推进安全网（standard 快照零漂移规则） |
| [`designs/S2-composition-externalization.md`](designs/S2-composition-externalization.md) | **已批准并竣工**（2026-08-20，用户授权代理复审执行） | S2 全量设计：四域行模型 + roster patch schema/解析语义（DSH 实证对标 + 三处刻意偏离）+ 14570 `/composition/` 通道 + composition-store 穿线 + 12 壳行切分 + S2-0…S2-5 批次序列 |
| [`designs/S4-preset-realm-distribution.md`](designs/S4-preset-realm-distribution.md) | **主体竣工**（2026-08-20：S4-0/1a/1.5/2/3/5 六批落地——preset realm + 热重载 + npm 分发 + 消费闭环 + hello 闭环 + 文档全套；S4-1b 持 Phase 5 CR 用户批准后另启，S4-4 按裁定可跳过） | S4 全量设计：preset realm（会话级组合 + 首事件会话记录）+ 热重载 + npm tarball 分发（tar-slip 防护）+ 机器桥（可选批）+ 消费闭环接线（G0：四 service 零消费者复审实证）+ hello 闭环 + 批次序列 S4-0 → 1a → ⚠CR 批间门 → 1b → 1.5 → 2/3 → (4) → 5 |

S2-S4 施工单在前序阶段落地后按需补写（S2 设计件已含批次序列 S2-0…S2-5，按 S1 先例设计件即施工纲领；S3 需白纸执行层外化；S4 需 S1/S2 全落）。执行顺序：WO-S0A → WO-S0B（均已完成）→ S1 设计件已批准并竣工（2026-08-20）→ **S2 设计件（待批准）→ S2-0…S2-5（批准后施工）→ …**

## 验证命令（每阶段门禁）

```bash
cd src-ui && npm run build && npx vitest run && npx biome check <改动文件>
cd src-ui && npm run verify:convergence   # S0 起强制（触 agent 工具面）
cd src-tauri && cargo check && cargo test # S0/S4 触 Rust
```
