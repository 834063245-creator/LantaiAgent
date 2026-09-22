# CLAUDE.md — 兰台（Lantai）项目规范

> ## ⚡ 破坏性操作授权（最高优先级，2026-08-25 用户拍板）
>
> ### 授权（行为面——以下全部明文允许，无需再问）
>
> **用户允许 Agent 对代码库进行重构、清理、架构整理等破坏性操作，一切由测试工程兜底，以结果论对错。**
> 具体放宽（未尽事项按此精神类推）：
>
> 1. **删代码、删文件、删模块**：不合理的行为、死代码、过时抽象——直接删，不留注释尸体，不写「deprecated 保留一个版本」。
> 2. **改公开行为**：函数签名、参数、返回形状、RPC 契约、存储格式——发现不合理的直接改，不造兼容层、不写双读、不搞渐进迁移（除非用户明确要求保留过渡期）。
> 3. **改架构**：移动文件、拆分/合并模块、重画层边界、删除整层——按目标架构直接落位，git mv 保历史即可，不因「动静太大」而绕行。
> 4. **改数据约定**：旧数据不迁移、直接归档（.bak 挪位、代码永不回读）是被认可的标准操作；旧格式读不进来就让它不存在。
> 5. **推翻 Agent 自己之前的方案**：上一轮做错了就整段撤销重做（撤销预留-领取制是先例），不为沉没成本辩护。
> 6. **连带清理**：修 A 时发现 B 也是同类病灶，允许顺手把 B 一并拆掉（测试同步更新），不必为「最小 diff」原则留下病灶。
>
> **判定原则：发现旧的不合理行为，默认拆除而非兼容；兼容层只在用户明确要求时建；拆干净比绕着走重要。**
>
> ### 铁律（测试面——授权的边界，一条不可协商）
>
> **一切破坏性操作由测试工程兜底：**
> 1. **动刀前**：受影响面的测试先跑一遍，确认基线状态（绿/红都要知道）。
> 2. **动刀中**：删除行为时同步删除/改写为它服务的测试；测试不许为旧行为陪葬，也不许假装没看见。
> 3. **动刀后**：对应验证门禁必须全绿才允许 commit（engine/storage/vector/graph：`cargo test`；src-ui：`vitest` + `build` + `biome ci` 0/0；组合层：`verify:convergence`）。门禁红着就是没改完，不许「先 commit 以后修」。
> 4. **行为变更**：用户可感知的行为变了（哪怕变对了），在 commit message 里写清楚变了什么——结果论对错的前提是结果可查。
> 5. **测试改造禁令（2026-09-04 立规）**：重构之下测试只有三种命运——行为未变→零改动（黄金标准：换轨 commit 的测试 diff 为零 = 行为零漂移的最强证据）；行为退役→同批删除；行为新增→从用户操作序列新写。**禁止第四种「改造后放回原位」**——被改造的测试考官与考生同为一人，绿灯作证力归零，旧实现形状（mock/setup/参数形状）随改造续命成化石床。故意规格变更必须显式声明（走 baseline-change-request 等审批通道），不偷跑。验收重构 commit 先看测试 diff 形状：理想 = 大片零改动 + 少量整删整增；大片小改 = 嫌疑必查。
>
> 背景：LLM 的天性是保守兼容（读旧代码后本能往上堆、兼容旧行为/参数/存储），本项目的历史包袱（铺卷化石等三轮「重构」都绕着旧时序走）正是破坏性操作干得不彻底留下的。本条款反转该默认值：**在此仓库，破坏性操作是常态，保守兼容才需要理由。**

> 本文件由 AgentRuntime 在创建每个会话时读入 system prompt（`src-ui/src/agent/runtime/runtime.ts`），
> 对 Claude Code 直接生效；Codex 等读 `AGENTS.md`——**`AGENTS.md` 是薄指针，强制加载本文件同一套规则**。
> 命名架构（2026-08-22）：应用 = 兰台 / Lantai；HoloGram = 图谱引擎专名（工具域 `hologram(...)`、`.lantai/`、`HOLOGRAM_*` env 不改）。
> **L0 体量纪律（2026-09-16 文档面重构 P1）**：本文件是唯一权威注入文件，**只放规则 + 指针**——
> 叙事、清单、批次流水、字段枚举一律外移（规则 → `CONVENTIONS.md`，现状 → `ARCHITECTURE.md`，
> 数字 → `docs/facts.generated.md`）。当前字节数由 `npm run doc-check` 的 budget 查守护。

## 规则优先级

`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 本文件 > 历史 plan/handoff。
有冲突时以左边为准；无法判断就停下来问用户。

## 开工顺序（不可跳过）

1. **动任何代码前，先读根目录 `CONVENTIONS.md` 和 `INVARIANTS.md`。** 没读不要改文件。
2. 修改 `src-ui/src/ui/**` 或 `src-ui/src/agent/**` 前，逐条核对 INVARIANTS，并 grep 目标文件的 `⚠️ INVARIANT` 注释。
3. 改高 fan-in 文件前先查影响面。**应用内图工具面已随图谱内置接线整量退役（2026-09-09）**——内置 Agent 用 `search` 域 + `fs(read)` 摸依赖；兰台之外的 MCP 客户端仍有引擎图工具（`explore_deps` / `trace_impact` / `preflight_check`）。
4. 在代码库里找做同类事的文件，复制它的模式。不要发明新的状态、通信、工具定义或错误处理方式。
5. 规则与代码现状冲突时：以代码为准，更新规则文档，不要盲改；无法判断就停下来问用户。
6. 向用户提问前先过 `CONVENTIONS.md` §0.5（决策分层与提问纪律）——工程内部取舍（修法/切分/命名/门禁层级/契约版本/范围）一律**自裁**，每批次**最多一个问题**且以用户可见后果提问。文档体量纪律见 §4（入口必须小、重复即负债）。

## 硬约束

- **四条架构约定**（最高）：类型边界 / 单一权威源 / 异步纪律 / 错误不静默。详见 `docs/adr/project-constitution.md`；新代码违反即返工。
- **前端**：React 19 + Zustand 5。跨组件业务状态走 zustand store（面板级走 `createScopedStore` 注册表）；事件总线已归零（`ui/events.ts` 已删除，禁复活——不要 window.dispatchEvent / CustomEvent / 自建 EventEmitter）。分层终态：store 一律 `src/state/`；`src/scene/` 目录已随图谱多轮 sweep **整个删除**（类型面同亡——别再引用 `graph-types.ts`）；`src/ui/` 残余 = chat 编排域核心 + 旧层命令式基础设施（见 `src/ui/README.md`）；新组件落 `src/app/**`。聊天消息原地 mutate 后必须 `touchMessage` / `touchMessageContaining`。
- **token 计量**：真源 = `agent/token-meter/`（分桶代数 `usage.ts` / 构成测量 `estimate.ts` / 每卷账本 `SessionTokenMeter`）+ Agent 侧每卷一本账（`getTokenStats / snapshotTokenLedger / restoreTokenLedger` 是句柄上的**能力位**——不实现 = 无读数，不炸链路）；录入点唯一 = `Agent.streamOnce`，落盘 = 卷文件 `tokens` 字段（旧卷无此字段 = 从空开始）。**口径纪律（沿 DSH token-meter，禁漂移）**：① 输入四桶互不重叠且加总恒等于提供方 `prompt_tokens`；② 压力只算 prompt 侧；③ 占用 = 投影（夹零）；④ 构成是估算不是账单（与压缩预检共用 `token-counter.ts` 同一把尺子）；⑤ 缓存命中率部分命中绝不四舍五入成 100%。UI 面契约见 `docs/design/lantai-design-spec.md` §9.1。
- **RPC**：前端调后端一律 `typedRpc` / `typedListen`（`src-ui/src/rpc-contract.ts`）；参数键 snake_case。新增后端方法同步 `src-tauri/src/rpc.rs` + `RpcContract`，生成文档用 `scripts/gen-rpc-contract-md.cjs`。受权文件之外裸 `rpc` 会被 biome 拦截。
- **工具**：模型工具必须 `defineTool` + zod v4；领域动作变更同步 `DOMAIN_SPECS` / 测试（`collectHiddenToolNames()` 已派生自 `DOMAIN_SPECS`，不必手工登记）。禁止手写 schema、execute 里 `as` 强拆、用 `.strict()`。
- **Agent 运行时与组合层**：装配面 = 三层表序（工具行 `composition/tool-rows.ts` + prompt 段 `composition/prompt-sections.ts` + capability `agent/blueprint.ts`）——**层序是字节契约**（前缀缓存 + effective 快照依赖此序），禁重排。`AgentConfig` 冻结 23 字段（真源 `src-ui/src/agent/runtime/types.ts`，`gate.mjs` 断言）——新增能力走 blueprint capability，不扩 config。第一方工具域 / prompt 段 / 渲染器 / 面板 / 命令 / capability / hooks / overlays / llm 等**全部贡献一律经 ctx.\* 通道**（通道与服务清单以生成物 `docs/agents/service-catalog.md` 为准，禁在本文件复述通道数），禁裸表。**改 `src-ui/src/agent/**` 或 `src-ui/src/composition/**` 必过 `npm run verify:convergence`**（T0 静态 + baseline 对拍，双轨；record 永不上 CI，baseline 变更走 `docs/archive/agent-core-convergence/baseline-change-request.md` 审批）。契约面文件（`agent-loop/types.ts` / `default-loop.ts` / 组合层 patch 契约）改动按 `composition/contract-version.ts` 四步流程升版——**当前版本与各计数见 `docs/facts.generated.md`，禁在本文件复述**。细则：`docs/composition/README.md` · `docs/plugins/README.md`。
- **插件激活（登记 ≠ 激活）**：manifest 声明 `activation.lazy` 的插件在 `apply` 里只 `ctx.activation.declare(名字, { start, stop })` **登记**，副作用在**组合装配期**按引用计数启动（Agent dispose / 切组合 → 归零 stop，句柄走 `ctx.effect` 对称释放）；账本体 = 叶模块 `composition/activation.ts`（零项目内运行时 import，环守卫钉住）。组合层 patch 顶层键另有 `requires`（缺插件 → 选择期拒 + 具名原因）与 `exclusive`（装配期冲突检测 + 整体回滚）；诊断面四栏。**kill switch：不声明 `activation` 块 ⇒ 新行为不发生**。细则见 `docs/plugins/README.md`。
- **程序入口（按组合起卷）**：UI 之外的单点 = `app/chat/session-composition.ts` 的 `createSessionWithPreset(ctx, presetId?)`——**只收 preset id**（组合必须有限可枚举，内联 patch 不入 API），优先级 = 显式参数 > 卷级记录 > 全局默认；不可解析 ⇒ **拒绝创建 + 具名原因、一个卷都不建**，`createNewSession` 返回 `number | null`。「起卷时指定」与「空白卷上拨组合」是两条语义、共用同一份记录真源。细则见 `docs/composition/README.md`。
- **卷首（folio-head）与组合芯片**：卷首是**版心天头**（2026-09-16 用户拍板 B 案）——玉徽 / 眉行 / 题字 / 档行四行**同轴居中于版心**，与正文块同轴（`FOLIO_TOKENS.colW` = 720）；四行一律不得回到「纸缘内距左齐」（旧形态题字比正文左缘还左 344px，实测病灶）。**高度契约**：真源 `FOLIO_TOKENS` → `measureFolioHeadHeight(title, **流区宽**)`（左右内距与版心封顶都在函数内算清，调用点禁手写 `width - 32`）→ 卷级几何；改 CSS 数值必同改 token（`tests/paper-visual-decisions.test.ts` 全项对映 + `tests/paper-folio-height.test.ts` 行为面）。芯片显示本卷组合名（空白卷可拨 = 写本卷卷级选择；跑过一轮 = 只读标签）；读写判据全经 core 能力位（`sessionComposition` / `isSessionBlank` / `selectSessionPreset`）。**芯片落位纪律**：绝对定位覆盖、**不进高度流水**、锚点以**版心**为参照系；卷首本体 `pointer-events: none`，只放开本子树。细则与同屏并排证据见 `docs/archive/composition-architecture/designs/S6-per-agent-composition.md` §8。
- **第一方插件清单与新增出厂产物**：身份单一真源 = `plugins/first-party-manifest.ts`（`service` 内核不可禁 / `feature` 出厂产物可禁用；**计数见 `docs/facts.generated.md`**）；出厂产物真源 = `plugins/builtin/<name>/` + `plugins/builtin-roster.json`（磁盘通道装载，改插件 = 换产物不重编译 exe）。**新增出厂产物 = ①目录建 `index.ts` ②`builtin-roster.json` 加条目（唯一真源；产物 manifest 由 `build-builtin-plugins.mjs` 生成，不手写）③插件对象进出厂装配面**（直接 import 的产物在 `factory-products.ts` 加行；工具/prompt/capability 域产物只进各自通道清单）——构建脚本与 Rust 资产通道都不用动。守护：`tests/first-party-manifest.test.ts` + `tests/builtin-roster.test.ts`。细则 `PLUGINS.md`。
- **Rust**：生产代码零裸 `.unwrap()`（测试模块除外）。锁中毒用 `lock_or_recover` / `read_or_recover` / `write_or_recover`（src-tauri），engine 用 `unwrap_or_else(|e| e.into_inner())`。失败必须可见，写入/持久化错误不得静默吞。
- **Windows 路径**：拆 `location` 的 `文件:行` 只拆最后一个冒号（`rsplit_once(':')`），不要吃掉 drive letter。
- **不可擅动（改前须先问用户，非绝对禁止）**：`graph-layout.ts` / `gpu-layout.ts` 的布局参数、`.github/workflows/ci.yml`（历史上长期写作「不改的」，2026-09-22 由用户授权重写为「必过的最简 CI」——**授权仅覆盖那一次**，此后仍须先问）、Python 引擎路径（已退役，不要恢复）。壳层不得直连 `hologram-storage` / `hologram-vector` 门面、**不得重新引入 hologram-engine 依赖**（守卫测试 `shell_has_zero_hologram_crate_refs` 钉死）；**壳也不拉起引擎**（`engine_transport.rs` 已随图谱退役删除）——引擎由前端经 MCP 受治进程通道拉起（`plugins/bundled-engine.ts` → `mcp-bridge.ts` 的 ServerGovernor → Rust `protocol_bridge` stdio），壳对引擎的全部知识 = 二进制位置只读探测（`engine_assets.rs`）+ MCP 协议。不要把与任务无关的未提交改动混进 commit——用户/他窗的在途改动单独确认。
- **产品输出纪律**：应用的程序层只呈现数据，不替用户推断 bug 根因/解释因果。这条限制的是你写进产品 UI/工具输出的内容；你排查问题时照常推理，结论写在回复/计划/代码注释里。

## 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build`（tsc --noEmit + vite build） |
| 前端逻辑 | `cd src-ui && npx vitest run` |
| 前端格式 | `cd src-ui && npx biome ci .`（**0/0 已归零**，保持；改动文件 `npx biome check --write <改动文件>` 后提交） |
| Agent 运行时/组合层 | `cd src-ui && npm run verify:convergence`（双轨 standard + minimal） |
| 引擎 | `cd engine && cargo test`（快验 `cargo build`） |
| 壳 | `cd src-tauri && cargo check`；权限/锁/IPC/命令改动跑 `cargo test` |
| 生成物文档 | `cd src-ui && npm run doc-sync` |
| 文档面 | `cd src-ui && npm run doc-check`（`--report` 看逐查漂移清单） |
| 桌面打包 | `cd src-tauri && cargo tauri build`（会自动先跑前端构建；根目录 `build.cmd` 是 Windows 包装） |

禁止用 `cargo build --release` 代替桌面发布验证。**实测基线数字与测试运行纪律（含 `cargo` 假挂规避、`hologram-engine.exe` 禁杀、`NODE_ENV=production` 两刀）见 `CONVENTIONS.md` §3 + §3 尾注**——数字会漂移，以重新实测为准。

## 项目快照

- **定位**：兰台（Lantai）= 以「纸壳·注疏案卷」为唯一主界面的桌面 Agent 软件（Tauri 2 壳 + TypeScript/React 19 前端）。**HoloGram 代码图谱引擎是随包配套的独立进程与独立产品面**（`engine serve`，stdio MCP；**应用内默认关**，由前端经 MCP 受治进程通道拉起，一进程一根），不再是应用内的主叙事。
- **工具层**：模型可见工具面以生成物为准（`docs/agents/model-tool-contract.md`；域折叠 + action 枚举 + 参数说明 + 隐藏旧名附录）。会话级 capability 工具（`Skill` / plan / 通信族 / `code_execution` 执行原语）经 blueprint 装配，契约由 convergence 快照钉住。`code_execution` 程序体经 `ctx.codeRuntime` 在 Web Worker 沙箱执行，程序内可嵌套调用全部可见工具（审计逐条落 session-log，门禁/hooks/截断不豁免，读并行写串行）。旧工具名（`run_shell` / `write_file` / `git_*` / `search_symbols` 等）已淘汰，模型调用会被重定向。
- **文档面纪律（2026-09-16 起）**：跨文档复述的数字**只准来自 `docs/facts.generated.md` 或写指针**，禁手抄；规则 → `CONVENTIONS.md` / `INVARIANTS.md`，架构现状 → `ARCHITECTURE.md`，现在在哪 → `docs/plans/README.md`，索引 → `docs/README.md`，`docs/archive/` 是历史勿作现状。门禁 = `npm run doc-check`。
