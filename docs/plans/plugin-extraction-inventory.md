# 插件化欠账总账（三本账 · 一页账）

> 状态：**在办**（2026-09-24 立账）。本页是「还有多少东西没拆到插件域」的**唯一真值**——
> 三本账分开记，别再混读。
> 缘起：用户报「总感觉还有很多该拆的没拆，但自己也搞不清还剩多少」。
> **口径：物理行数**（`(Get-Content).Count`；注意 `Measure-Object -Line` 会静默丢空行，两套差 5–10%，
> 本页一律物理行）。数字会漂移，以重新实测为准。
> 总盘（2026-09-24 实测）：`src-ui/src` **519 文件 / 120,175 行** = 产物包 `plugins/builtin/`
> **173 文件 / 34,546 行** + 内核 **346 文件 / 85,629 行**。
> 来源：本页由全树机械盘点 + **四份只读深审**（`agent/**` · `app/**`+`ui/**` ·
> `paper/**`+`state/**`+`provider/**`+`shell/**` · `composition/**`+`cordis/**`+装载链）合并；
> 每条数字都有 file:line 级证据，明细见 §7。
> 账②的施工图纸在 [`factory-products-homing-plan.md`](factory-products-homing-plan.md)（本文是账，那份是图纸）。

## 0. 为什么「搞不清」——三本账被混着读

| 账 | 是什么 | 状态 | 谁在守 |
|---|---|---|---|
| ① **通道迁移账** | 出厂行是否经 `ctx.*` 通道装配（不再编译期硬编码） | ✅ **全清**（P4 B①-⑥ 收官） | `src-ui/tests/first-party-surface.test.ts` P5-C1「出厂面零硬编码」 |
| ② **物理归家账** | 产物包的**实现**是否真在包内（魂身合一） | ❌ **未开工**（2026-09-04 立项后零施工） | **无人守** |
| ③ **从未立项的插件化面** | 内核里整块产品/内容表，连产物包都没有 | 🤷 **无账**（本页首次立） | **无人守** |

**关键**：账①的守卫只证明「实现经通道贡献」，**不证明实现住在产物包里**。于是门禁全绿、
`plugins/builtin/` 目录看着像已完成插件化，而实现还躺在 `agent/`、`app/`、`paper/` 里——
两本账各自为真，读哪一本都得到相反的印象。`docs/plans/README.md` 的 P4 行写「存量拆解全清」
（=账①）与「出厂产物归家 未开工」（=账②）同时成立且互不引用，这就是「搞不清」的直接来源。

**合计**：账② ≈ **10,052 行** + 账③ ≈ **32,000 行** = **≈42,100 行**（含争议项 ≈2,600 行），
约等于内核 85,629 行的 **49%**。

### 0.1 顺手确证的缺陷（**不是欠账，是 bug**，2026-09-24 本页作者独立复现）

**30 个产物源码仍在生产 bundle 里**——`plugins/loader.ts:573/578` 的
`factoryProductNames()` / `factoryProductPlugins()` 在 **DEV 分支之外**被无条件调用
（DEV 只用于过滤 `indexNames`）⇒ rollup 无法 DCE `factory-products.ts` 及其 30 个产物 import。
实测 `src-ui/dist/assets/index-BG3v5YRK.js`（5,152,526 B，与 HEAD `cf00bb6f` 同日）命中产物独有串
`hologram/compose-dock` · `hologram/settings-domain` · `hologram/renderers` · `hologram/sessions-builtin`
· `hologram/fs-builtin` · `firstPartyCapabilities` · `settings-panel` · `ss-sidebar` ·
`hologram/ask-domain` · `createOfficeTools`。
这与 `plugins/factory-products.ts` 头注「本清单不进生产 bundle」+ `docs/plugins/README.md`
「exe 只留 13 内核装配台」**直接矛盾**（后果：exe 体积虚胖 + 同一份产物在磁盘通道之外还带一份死副本）。
修法很小：把 `factoryProductPlugins()` 收进 DEV 分支，**序真源改用名册 `buildOrder`**
（`builtin-roster.test.ts` 已断言「序 == buildOrder」⇒ 名册本来就是序的唯一真源）。
守卫建议：构建期断言产物体内不含 `plugins/builtin/` 源码串（见 §5）。

> **2026-09-24 批 0a 落地（完整）**——三步，前两步都是**实测无效后推翻重做**的（留证防后人重走）：
> ① **装载器侧**（上窗已落，commit `084b8184`）：序真源换名册 `BUILTIN_ROSTER.map(builtinScopeName)`
> + `factoryProductPlugins()/factoryProductNames()` 收进 DEV 分支（装载序不变 = 字节契约不动）。
> ② **配置侧 DCE —— 两条路都无效**：(a) `build.rollupOptions.treeshake.moduleSideEffects`
> 谓词：Vite 内置 resolve 插件对**每个**相对 import 都回 `moduleSideEffects: <最近 package.json
> 的 sideEffects 字段>`（壳包未声明 ⇒ 恒 true），插件回值**优先于**该选项 ⇒ 谓词被逐模块覆盖
> （取证：谓词换成 `() => false` 重建，产物连尺寸都一样）；(b) `load` 钩子逐模块回
> `moduleSideEffects: false`（钩子优先级更高，实测命中 125 模块，含 `factory-products.ts`）
> ——**依然无效**：`loadExternalPlugins` 里 `devSourceDomain ? factoryProductNames() : null`
> 那句**没被折死**（初始化依赖 `(import.meta.env as …).VITE_FORCE_PRODUCT_CHANNEL` 这类动态形态，
> rollup 不当字面常量）⇒ **活引用**在，`moduleSideEffects` 只对「无人引用的模块」生效，轮不到它。
> **病灶是「活引用」，不是「副作用标记」——这条是本节最值钱的结论。**
> ③ **正解**（`vite.config.ts::stubFactoryProductsInBuild`）：构建期把装载链那处
> `./factory-products` **置换成语义等价空壳**（`factoryProductPlugins()→[]`、`factoryProductNames()→`
> 名册派生全集`，逐名等价）⇒ 30 个产物源码**根本不进 rollup 解析面**，不赌任何折叠。
> **实测收益**：`dist/assets/index-*.js` 5,155,362 → **3,838,924 B（−1.32 MB / −25.5%）**，
> 壳 CSS 237,673 → 199,115 B；产物独有串（`hologram/settings-domain` · `pp-minimap` · `sr-rack` …）
> 与 `factory-products.ts` 函数体（`出厂产物名撞车`）**全清**。dev/vitest 不受影响（`apply: 'build'`）。
>
> **壳 CSS 面清单（先审后剪的产物——剪枝只改了 JS，产品 CSS 的去留是**独立**决定）**：
> 壳 bundle **留 4 份**（= `main.ts` 显式声明的首帧面）：`paper-shell/PaperPanel.css`（539 选择器）·
> `paper-shell/status-line.css`（16）· `settings-domain/settings-panel.css`（81）·
> `compose-dock/model-selector.css`（23）。其余 **17 份**（`canvas-nav/*` 2 · `compose-dock/composition-chip.css` ·
> `paper-minimap/minimap.css` · `paper-shell/ToastHost.css` · `renderers/viewers/*` 12）改由**产物
> `entry.css` 在装载期注入**。**安全性两处取证**：① 注入点在产物模块顶层（`face-css.ts` 的
> `injectFaceArtifactCss()` 于 `index.ts` 模块求值即调）⇒ 发生在 `loadExternalPlugins` 内、
> **早于 `bootShell()`** 与任何面板渲染；② 产物装载前的可见面只有 `SessionsHome`（内核 CSS 面），
> 实测它与 17 份里的类名交集 = 0（唯一同名 `sh-section-title` 定义在 `foundation.css`）。
> 落盘对账（`plugin-home:report` 同批守卫）：**21 份产品 CSS 零未覆盖选择器**——要么在壳 CSS、
> 要么在本产物 `entry.css`。守卫 `tests/product-source-not-in-bundle.test.ts` 三段钉住
> （配置插件在场 / 产物体内无产物独有串（探针**从产物源码派生**，新产物自动纳入）/ 上述 CSS 面两条）。

### 0.2 实机缺陷「随包引擎开关拨不开」——**已修**（2026-09-24，用户实机报）

**症状**：设置 → MCP → 「随包图谱引擎」开关**置灰拨不动**（`McpPage.tsx:286 disabled={!info?.available}`），
于是 §4-11 那条「拨开关 → 引擎真拉起」的验收第 1 步就走不下去。

**根因**（一条，跨语言形状错配）：
`engine_bundled_info` 在 TS 契约里声明了结构化返回 `{path,dir,available}`，但
**`src-tauri/src/rpc.rs` 的 `rpc_result_shape()` 表里没有它** ⇒ 落默认臂 `Text`
⇒ Rust 出口把 JSON 当**字符串**直通；而 `probeBundledEngine()` 用 `typedRpc`
（直通、不 parse；双形态 shim 在 `typedJsonRpc`）读 `raw?.available` ⇒ 恒 `undefined`
⇒ `available:false` ⇒ 开关置灰。且该错判被 `cachedInfo` 缓存整个进程。
**磁盘侧无罪**：候选梯实测全命中（`target/{release,debug}/hologram-engine.exe` 就在 `lantai.exe` 同级）。

**为什么 8 天没人发现**：2026-09-16 的 CDP 探针读到的是那条 JSON 字符串本身
（**文本里写着 `"available":true`**）⇒ 假阳性；既有 `bundled-engine.test.ts`
自陈「测试内不触发真 RPC」⇒ 形状差从未被覆盖；`rpc_result_shape` 表**没有**任何
跨语言对拍守卫。

**修法（四处 + 两条回归/守卫）**：
① `rpc.rs`：`"engine_bundled_info" => RpcResultShape::JsonValue`（+ 该表测试
`dispatch_result_to_value_shapes` 补断言）；② `rpc-contract.ts`：补 `// JSON` 标注 +
收编进 `rpcResultSchemas`；③ `bundled-engine.ts`：改走 `typedJsonRpc`（双形态兼容 +
违形即 throw），并把 catch 的静默降级改成 `log.warn`（「RPC/形状故障」不再伪装成
「二进制缺席」）；④ `mock-data.ts`：补浏览器面诚实形状（available=false，不合成）。
回归钉 `tests/bundled-engine-probe-shape.test.ts`（喂产线两种线形）；
新守卫 `tests/rpc-json-shape-consistency.test.ts`（**跨语言**：契约里结构化返回的命令
必须在 Rust 出口展开或已收编；**变异验证**：改名 Rust 表项 ⇒ 当场红）。
顺带：`scripts/gen-rpc-contract-md.cjs` 自 09-15 未再生成 ⇒ 本次一并重生成（53→55 方法）。

> **同族第二例（2026-09-24 批 5 收尾，真机日志抓到）**：`composition_dir` / `providers_dir`
> 两条**裸串路径**命令的 Rust 臂用了 `ok_json(r)`，而 `r: Result<String, _>` ⇒ 序列化成
> **带引号的 JSON 文本**（`"C:\\Users\\…"`）；契约声明 `result: string`、前端按裸串直读
> （`typedRpc`，非 `typedJsonRpc`）⇒ 路径判据当场失败。**症状**：真机 `ui.log` 报
> `provider-doc: providers_dir 返回的不是路径`（provider YAML 通道被**静默降级**成内置存储，
> 设置页显示「通道不可用」）；`composition_dir` 同病（preset 作者面路径同病，尚未被用户撞上）。
> **修法**：两条臂改**裸串返回**（`spawn_blocking(...).await.map_err(...)?`——别再用 `ok_json`）。
> **真机验收**：重建 exe 后设置页 Provider 段显示 `C:\Users\Administrator\.lantai/providers.yml`
> （无引号），`ui.log` 该错误消失。
> **守卫**：`rpc-json-shape-consistency.test.ts` 增 ④「裸串路径命令不得用 `ok_json` 包」
> （机制验证：合成变异臂 ⇒ 判据命中）。**教训**：默认臂 `Text` + `ok_json` 对**裸串**是
> 双刃——凡是「路径/单值」返回，先问一句「这是 JSON 值还是裸文本」。

### 0.3 实机缺陷「随包引擎接线失败：… without inject」——**已修**（2026-09-24，同一路径第二处）

**症状**（0.2 修好后立刻暴露）：拨开开关 + 重开工作区 →
`随包引擎接线失败：can not get property "tools" without inject`。

**根因**：`registerMcpServerTools` 用**属性访问** `ctx.tools.register(…)`（两处：
legacy 路 + 治理路），而工作区 scope fiber 的插件
（`workspace.ts` 的 `{ name: 'hologram/workspace', apply() {} }`）**不声明 inject**
⇒ cordis 拒绝对服务做属性访问。**`ctx.resolve` 同受此门禁，不是逃生口**
（这一版 cordis 里 resolve 也走 inject 校验）。
磁盘候选梯与 RPC 形状均无问题——纯粹是「谁要 `ctx.tools` 谁声明 inject」这条纪律
在这条程序化创建的 fiber 上被漏掉了。

**试过并否掉的修法**：给工作区 scope 补 `inject: ['tools']`——声明 inject 会让 cordis
为该插件派生 realm，`new LspService(this._fiber.ctx)` 的 `set('lsp')` 当场冲突
（`tests/workspace-fiber.test.ts` 5 条全红：`service "lsp" has been registered at
<hologram/workspace>`）。**该形态已写进 `workspace.ts` 的 ⚠ 注释，防后人重踩。**

**正解**：接线方**自带 inject 的子 fiber**——`bundled-engine.ts` 内
`ctx.plugin({ name: 'hologram/bundled-engine-mcp', inject: ['tools'], apply })`，
服务可见性归子 fiber；**归属与回收仍挂调用方 ctx**（把子 fiber 的 dispose 登记进
调用方 `ctx.effect` ⇒ 离开/切换工作区时摘行 + 治理器杀进程树，不赌 cordis 的父
dispose 级联语义）。`apply` 必须用**块体**（返回值会被 cordis 当 effect，
返回治理面对象即 `TypeError: Invalid effect`）。

**回归**：`tests/mcp-bridge.test.ts`「scope ctx 的服务可见性」段（裸 scope ctx 抛
`without inject` = 约束钉死／子 fiber 两路都登记成功／lazy 注册期不 spawn）+
`tests/bundled-engine-probe-shape.test.ts` 端到端（真 `registerBundledEngineTools`
+ 工作区 scope ⇒ `wired: true` + 行 id `plugin/hologram-engine/mcp/hologram` +
scope dispose 后行摘除）。

**遗留**（未验证，非本次范围）：并发多工作区同时启用引擎时，两者会注册**同一条**
贡献 id（`hologram-engine/mcp/hologram`）⇒ 第二条大概率撞 duplicate。引擎「一进程
一根」语义下这是真问题，但该特性从未真机跑通、`concurrent-sessions` 是否要求引擎
并发亦未定 —— 记为待验证点，不预先造机制。

### 0.4 实机缺陷「已接线但进程不起、工具面空」——**已修**（2026-09-24，同一路径第三处）

**症状**（0.3 修好后立刻暴露）：设置页显示「本工作区已接线」，但任务管理器里
**没有 `hologram-engine.exe`**，Agent 工具面也没有 `mcp__hologram__*`。

**根因（两半，都在这条从未跑通的路径上）**：
1. **没声明激活**——loader 对声明 `manifest.mcpServers` 的插件会把受治面交给激活账
   （`activation.declare(manifest.name, { start: () => face.startLazy(), … })`，
   `loader.ts:943-954`），而引擎路径把 `registerMcpServerTools` 的**返回值整个丢掉**：
   治理器只进了注册表，`activationPlan` 看不见它（账键 = 插件名，判定 = 组合里有
   `plugin/<名字>/…` 存活行）⇒ **永无 retain ⇒ 永无 start ⇒ 进程永不拉起**。
2. **拉起的时机晚于工具行物化**——装配面先建注册表（`runtime.ts:715`）再 retain 激活
   （`:739`），而行工厂按 `governor.toolFace()` 快照产出（`noCache`，每装配重调）。
   于是「只靠 retain」时**首个会话**的工具面是空的（工具面在会话创建时点冻结，要等
   下一个新卷才出现）。

**修法**（`plugins/bundled-engine.ts`，子 fiber 的 apply 内）：
① 子 fiber `inject: ['tools', 'activation']`，注册后 `activation.declare('hologram-engine',
{ resources: ['stdio'], start: face.startLazy, stop: face.stopLazy })`（账键 = 贡献行前缀
`plugin/hologram-engine/…` 的属主名）；② **开工作区即预热**（`void face.startLazy()`，
fire-and-forget，不阻塞开工作区；失败 `log.warn` 不静默）——这样首个会话装配时
tools/list 已就位。回收不变：工作区 fiber dispose ⇒ 子 fiber dispose ⇒ 摘行 + 治理器
杀进程树；激活账归零 ⇒ `stopLazy`。

**回归**（`tests/bundled-engine-probe-shape.test.ts` 端到端一条，三个症状一次钉住）：
`wired: true` + 行 id 在册 + **`activation.has('hologram-engine')` 为真**（本次缺口）
+ **开工作区发生一次拉起尝试**（预热）+ scope dispose 后行摘除。

**真机验收（2026-09-24，Agent 自跑，非用户代验）**：dev 模式（vite 直供源码 + CDP 驱动，
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）四条全过——
① 拨开关 + 开工作区 ⇒ `hologram-engine.exe` PID 17296，**PPID = lantai**；
② 命令行 = `…\hologram-engine.exe serve --project-root D:/useful/实验立项`；
③ 活的工具行 62 条含 `plugin/hologram-engine/mcp/hologram`，其 factory 产出 **7 个工具**
`mcp__hologram__{graph,analysis,lsp,ops,analyze_project,import_scip,rename_symbol}`；
④ 切工作区 ⇒ 旧进程停、新进程（PID 5416，根 `D:/HoloGramHG`）起。
**教训（流程，非代码）**：第 0.4 处的修复写于 16:23，而用户手上的 `target/release/lantai.exe`
构建于 16:16 ⇒ 那条「还是没有」的回报其实是在**不含修复的构建**上做的。
**纪律**：让用户验收前先确认「他手上的产物是否已含该修复」（构建时间 vs 改动时间），
或干脆像本节这样自跑——用户不该当编译-验证回路。

### 0.5 实机缺陷「进程起了、接线正常，Agent 手里却没图谱工具」——**已修**（2026-09-24，同一路径第四处）

**症状**（用户实机报，第三次回报）：设置页「已接线」、任务管理器有 `hologram-engine.exe`
（`serve --project-root D:/HoloGramHG`，PPID = lantai），但 Agent 的工具面里没有
`mcp__hologram__*`。

**根因（两处，都在「通道 → 注册表」那一段；0.4 只修到「进程不起」为止）**：
1. **组合产物取在引擎行注册之前**——`workspace.ts` 的 `_setupAgentInner` 在接线**之前**
   就取走 `composition-store` 的快照（供 `new AgentRuntime(...)` 与
   `_buildRegistryLocked(...)` 共用），而引擎的工具行是接线时才注册的 ⇒ 那份快照里
   没有这一行 ⇒ 注册表不含引擎工具（runtime 的激活 retain 也看不见它）。0.4 的注释只
   要求「在 `_buildRegistryLocked` 之前」，而快照在更上面就取走了。
2. **工具面在进程就绪前被冻结**——行工厂按 `governor.toolFace()` 快照产出，而 0.4 的
   预热是 fire-and-forget；装配只花微秒级、经 Rust `protocol_bridge` 起进程要数百毫秒
   ⇒ 首个（也是唯一）装配读到空集。空集不缓存 = 「下次装配重试」，而**共享注册表路径
   没有下次装配**（会话工厂判身份相等即复用）。

**修法**：① `workspace.ts`：接线移到取产物之前，且产物改为**重新解析**
（`effectiveComposition()`——不再赌 store 是否被贡献监听刷新过：监听未武装或 store 处
error 态时快照会停在旧产物），`_assemblyKey` 随之取 `compositionIdentity()`；
② `bundled-engine.ts`：接线**有界等待就绪**（`PREHEAT_BUDGET_MS = 10s`，实测引擎冷启动
32ms + 握手 2ms，余量 ~300×），超时/拉起失败/工具面为空一律**如实上报**
（`wired:false` + 具名原因）而不是继续报「已接线」；`mcp-bridge` 的激活面补 `toolCount()`
（回执据此报「N 个引擎工具在册」）。

**回归**：`tests/bundled-engine-assembly.test.ts`（**真 Workspace 装配腰** + 真 MCP 行协议
+ 就绪闸门）——判据落在用户可见面：**Agent 的注册表里必须有 `mcp__hologram__*`**，
且回执 `wired + toolCount` 一致。既有 `bundled-engine-probe-shape.test.ts` 的一条按新语义
改写（拉起失败从「隐式 wired:true」改为「如实 failed」，这是**有意行为变更**）。

**为什么 0.4 的真机验收没拦住**：那条验收读的是「工具行在册 + 行 factory 产出 7 个工具」
——**通道/工厂层**读数，而缺陷在工厂产物**进注册表的时点**上。教训（验收判据纪律）：
验收必须读**消费端真值**（Agent 的注册表 / 模型可见工具面），通道层自证不算数。

**同一病灶的通用面（同日追查，用户问「第三方 MCP 到底能不能用」）**：缺陷②不是引擎
专属——凡声明 `restart` / `lifecycle` 的**第三方 server**（受治档：插件 manifest 的
`mcpServers` 或用户级 `~/.lantai/mcp.json` 任一声明即入档）都命中「装配期未就绪 ⇒ 空集
⇒ 而共享注册表没有下次装配」⇒ 工具**永久**进不了模型工具面，用户侧只有 console 一行
warn。旧形态条目（两字段皆缺席）因为在装配期自己连接并 await，故一直是对的——这也是
「第三方 MCP 平时能用」的来源。修法 = 装配期**有界等待就绪**（`mcp-bridge` 的
`ASSEMBLY_READY_WAIT_MS = 10s`，等待即拉起触发；失败仍空集 + 可见 warn，真因照抄治理器
原文），随包引擎的接线等待改为共用同一常量（不再各写一份）。回归
`tests/third-party-mcp-assembly.test.ts`（旧形态 / `restart:on-crash` / `lifecycle:lazy`
三条 × 真 Workspace 装配腰，判据 = Agent 注册表里有 `mcp__*`）；
`tests/mcp-bridge-governance.test.ts` 两条按新语义改写（装配不再「非阻塞返回空集」）。
**仍未做（如实记）**：用户侧没有「这个 server 的工具到底进没进工具面」的回执面（引擎有
`bundled-engine-store`，第三方 server 一片空白）——「既无法证实也无法证伪」的同一个病，
列为下一批候选。

## 1. 账②：转发空壳 21 个 —— 10,052 行实现仍在内核

> **进度（2026-09-24）**：21 条已销 **4** —— `llm-adapters`（批 2a）· `wait-domain` ·
> `office-domain` · `cordis-domain`（批 3a）；空壳判据随之校准为三条合一
> （薄 + **包内自有实现为空** + 转发内核实现）——只看「有逃出包外的 import」会把
> 刚搬完的包（仍依赖 `defineTool`/`Tool` 平台面）重新判成空壳。
> **批 3 复核发现三件（memory/skill/task）不能整件搬**：它们的类是**内核构造的**
> （`workspace.ts` new `MemoryManager` / `SkillRegistry`、runtime 用 `TaskBoard` 11 处）
> ⇒ 整件搬会造「宿主→插件」反向依赖（仓库明文禁反）。改随批 7（子代理/多 Agent 族）
> 与批 9（`workspace.ts`）一起搬。

**形态**：`plugins/builtin/<name>/` 只有 `index.ts`（注册贡献行）+ `host.ts`（**一行
`export { … } from '../../../<内核>'`**）+ `host.aliased.ts`（产物域宿主桥）+ 构建期生成的
manifest.json —— 包内合计 30～110 行。

### 1.1 纯空壳（18）：实现 6,132 行 + 随行私有件 992 行

| 产物包 | 实现真源（物理行） | 随行私有件（不随迁则悬空） |
|---|---|---|
| `fs-domain`·`shell-domain`·`ask-domain`·`agent-isolation-domain` | ~~`agent/tools/coding.ts` **998**（**一文件载五族，须先按域拆**）~~ | ✅ **批 4c 已全清**（4c-1 git · 4c-2 ask/agent-isolation · 4c-3 fs/shell ⇒ `coding.ts` 整文件退役，五族各归其包）。随行件仍留内核桥：`session-context.ts` 122（sticky-cwd 被 office 域+内核消费）· `tools/structured-error.ts` 24；`sticky-cwd.ts` 138 已随族段并入包内 |
| `git-domain` | ~~`agent/tools/coding.ts` 的 git 段（318）+ `git-porcelain.ts` 126~~ | ✅ **批 4c-1 已归家**（族段整段移出进包；`git-porcelain` 因内核 `state-inject` 消费而**留内核桥**，随批 6 走） |
| `browser-desktop-domain` | `agent/tools/browser.ts` **912** | ✅ **批 4a 已归家**（桥位仅 5 运行时 + 1 类型） |
| `search-domain`·`web-domain` | `agent/tools/manifest-tools.ts` 187 | ✅ **批 4b 已归家**（按域拆两半：`search-domain/search-tools.ts` + `web-domain/web-tools.ts`；随行 `tools/search-assembly.ts` 169 随 search 走——**一个文件不能同时住两个包，故按域拆**） |
| `agent-domain` | ~~`agent/tools/subagent.ts` 265~~ | ✅ **批 7a 已归家**（2026-09-24）：三个工具工厂进包 `plugins/builtin/agent-domain/subagent-tools.ts`；`SubAgentSpawner` 类型上收内核契约 `agent/subagent-tools-contract.ts`（装配输入，内核面先于产物）；登记表 `agent/subagent-tools-impl.ts`（feature 语义）；**退役 `agent/tool.ts:244` 的值 re-export**（4c 裁定① 同款）；13 个测试改指包内 |
| `asset-domain` | `agent/tools/show-asset.ts` 294 | `asset-store.ts` 137 · `confirm-registry.ts` 80 |
| `wait-domain` | `agent/tools/wait.ts` 102 | — |
| `office-domain` | `agent/tools/office.ts` 576 | — |
| `cordis-domain` | `agent/tools/cordis.ts` 200 | — |
| `memory-domain` | `agent/memory.ts` 733 | `memory-bundle-client.ts` 134 |
| `skill-domain` | `agent/skills.ts` 377 + `agent/builtin-skills.ts` **358（出厂技能内容）** | — |
| `task-domain` | `agent/task.ts` 178 + `agent/task-board.ts` 319 | `board-persistence.ts` 121 · `tools/board-status.ts` 78 |
| `capability-segments` | `agent/blueprint.ts` 389（14 项 capability 定义；`AgentBlueprint` 类=机制留内核） | — |
| `prompt-segments` | `composition/prompt-sections.ts` 244（**9 段**文案真源——实测 id 数，旧记「13 段」是合并前的数；**拼装序 = 字节契约**） | — |

### 1.2 半壳（3）：插件对象已进包，provider 实现仍在内核 —— 2,928 行

> **2026-09-24 批 2a 落地**：`llm-adapters` **已实心化**（1,916 行三方言 + 两 helper 进包）
> ——销账一条。前提条件按账本原判执行：`ANTHROPIC_DEFAULT_BASE_URL` 上收内核
> （`settings.PROVIDER_PROTOCOL_DEFAULTS.anthropic` 成为端点字面量唯一真源，适配器经宿主桥读表）。
> 包内 `host.ts` 从「桥三个工厂」翻面成「桥仍住内核的依赖面」：seam 契约（types）·
> 目录/元数据（catalog/model-meta）· 错误分类（error-catalog）· 思考档（thinking）·
> 传输（transport）· 协议端点表（settings）——16 个运行时 faceDeps 键。
> **收益兑现**：产物 `entry.js` 从 2.6 KB → 41.6 KB（三方言真身），**LLM 适配器自此改产物即热更**。
> `subagent-in-process` **并入批 7**（复核后裁定）：它要 `agent/**` 的 22 个模块、16 个运行时桥位，
> 而那批（子代理运行时本体 + 通信族）正要把同一片 `agent.ts`/context/message-bus 面整体搬走
> ——现在单独搬要建 16 键桥、批 7 再拆一次，合并只付一次。

| 产物包 | 实现真源（物理行） | 搬前须先解 |
|---|---|---|
| `llm-adapters` | `provider/anthropic.ts` 572 + `openai.ts` 518 + `responses.ts` 560 + `shared.ts` 151 + `retry.ts` 115 = **1,916** | ✅ **批 2a 已归家**（端点字面量上收内核协议表；16 个运行时桥位） |
| `subagent-in-process` | ~~`agent/subagent-spawn.ts` **543**~~ | `agent.ts` 的值 re-export 桥（保一个测试的导入面）⇒ **并入批 7**（同族一次搬完） | ✅ **批 7c 已全落**（2026-09-24）：7c-1 两工具族 338 行 + 7c-2 运行时本体 1,188 行（`coordinator` 420 · `lifecycle-manager` 217 · `subagent-spawn` 551）整包实心化，名册 `impl` 销账、`agent.ts` 两处值 re-export 退役 |
| `agent-loop-service` | `agent/agent-loop/default-loop.ts` **469** | `agent.ts` 的 `opts.agentLoop ?? defaultAgentLoop` 内核回落真值（`agent-loop-active.ts` 41 行是内核桥，留） |

> 合格样板（别混进来）：`fs-builtin` 148 · `shell-builtin` 71 · `sessions-builtin` 125
> （provider 本体自包含在包内，`host.ts` 只桥 `rpc-contract` 的强制层 RPC 面）。

## 2. 账③：从未立项的插件化面 —— 32,018 行

### 2.1 包已有、实现留内核：`settings-domain` 半迁移 —— 5,291 行

> **2026-09-24 批 1 落地**：**MCP / 插件 / 技能三页（1,103 行）已归家**进包
> （`git mv` 进 `plugins/builtin/settings-domain/`，内核依赖改走包内 `./host`
> 逐符号桥：新增 24 个 faceDeps 键，`host-surface.baseline.json` 已重生成）。
> 顺带把 `composition/preset-authoring.ts`（192）也搬进同包（0c 第三件并入本批——
> 同一处 host 面只 churn 一次）；其 YAML 序列化留内核（`preset-discovery.stringifyPatchYaml`）
> 经 faceDeps 取用——**产物不得裸 import**（`yaml` 是裸包，自包含契约）。
> **CSS 面无需动**：三页 20 个 class 里 17 个本就在包内 `settings-panel.css`
> （产物 `loadCss` 面），另 3 个（`pp-btn-danger`/`pp-error-banner`/`pp-error-text`）
> 属内核 `provider-settings.css`（壳 bundle，provider 家族回迁时一并处理）。
> 剩余 = 下表 Provider 家族 8 件 + 那份内核侧样式表（**批 9**）。

包内只有「门牌 + 面板壳 971 行 + 自己那份 CSS 958 行」；页面与另一份 CSS 全在内核：

| 块 | 路径（物理行） | 备注 |
|---|---|---|
| Provider 控制台家族 8 件 | `app/panels/settings/`：ProviderPage 721 · ProviderDetail 784 · AddProviderSheet 802 · ProviderList 85 · ProviderAdvanced 102 · ProviderDocCard 161 · protocol 35 · status 50 = **2,740** | 最大单块；依赖内核 `provider/**`(5,418) + `settings.ts`。**批 1 后这是 settings-domain 名册 `impl` 的登记面（红区）** |
| 内核侧样式表 | `app/panels/dock-panels/provider-settings.css` **1,346** | 与包内那份是**两套装载面**（`main.ts` 全局 vs 产物 `loadCss`） |
| MCP / 插件 / 技能三页 | McpPage 449 · PluginsPage 377 · SkillsPage 277 = **1,103** | ✅ **批 1 已归家**（含 `preset-authoring` 192）；`PluginsPage` 反引 `plugins/loader` 经 faceDeps 运行期取用 |
| 面板确认弹层（归属待裁） | ConfirmDialog 102 | `paper-shell` 与 `ExitConfirmDialog` 都在用 ⇒ 跨插件原语住错目录（§4-3 判内核共享原语，随批 9 挪位） |

### 2.2 内核里的「出厂内容表」（5 张；3 张已计入 §1.1，本处只加 2 张）—— 1,246 行

| 内容 | 路径（行数） | 应去哪 |
|---|---|---|
| 出厂资产 kind 表 | `agent/asset-kinds.ts` **581** | `asset-domain`（被 `renderer-service`+`paper/measure` 共享，见 §4） |
| 域折叠表 `DOMAIN_SPECS` | `agent/tools/domains.ts` **665** | 各域产物（折叠算法留内核） |

### 2.3 `agent/**` 里的整块能力（18 之外，连空壳都没有）—— ≈8,025 行

| 项 | 路径（物理行） | 应去哪 | 主障碍 |
|---|---|---|---|
| 上下文压缩 | ~~`agent-compaction.ts` 1059 + `compaction-model.ts` 644 + `compaction-summarize.ts` 327 = **2,030**~~ | 新包 `compaction/` | ✅ **批 6d 已全落**（6d-1 结构切分 + 6d-2 搬进产物包）：**进包 1,773 行**（`agent-compaction` 1016 + `compaction-model` 策略 425 + `compaction-summarize` 332）+ 包内壳 166 行；**留内核 414 行**——记账面 `agent/compaction-tracker.ts` 206（压缩账 + 卷级持久化）· 契约面 `agent/compaction-contract.ts` 156（`CompactionHost` + 配置/摘要账形状 + 跨层常量 + `CompactionImplementation` 16 项）· 登记表 `agent/compaction-impl.ts` 52。`Agent` 16 调用点改查表（service 语义：缺实现调用点 fail-loud） |
| 多 Agent 通信族 | ~~`message-bus.ts` 605 + `message-types.ts` 137 + `message-store.ts` 129 + `topology.ts` 80 + `tools/communication.ts` 159 + `tools/request.ts` 94 = **1,204**~~ | 新包 `multiagent-comm/`（或并入 agent-domain） | ✅ **批 7b 已归家**（2026-09-24）：**进包 1,093 行**（`message-bus` 611 · `communication-tools` 164 · `message-store` 130 · `request-tools` 91 · `topology` 80）+ 包内壳 122 行；**留内核 185**——契约面 `agent/message-contract.ts`（原 `message-types` 整件升格：消息类型 + 四个错误类 + **`MessageBus` 接口** + `MultiagentCommImplementation`）· 登记表 `agent/multiagent-impl.ts`。`runtime.ts` 不再 `new MessageBus`（改工厂查表，service 语义 fail-loud）；blueprint 两条 capability（communication-tools / request-tool）同改 |
| 子代理运行时 | ~~`coordinator.ts` 420 + `lifecycle-manager.ts` 217 + `tools/merge.ts` 215 + `subagent-activity.ts` 96 + `file-ownership.ts` 73 + `tools/merge-gate.ts` 55 + `isolation-queue.ts` 13 = **1,089**~~ | `subagent-in-process/`（与 §1.2 同批实心化） | ✅ **批 7c 已全落**（2026-09-24）：**进包 1,507 行**（7c-1 两工具族 338：`merge-tools` 219 + `merge-gate` 53 + `discovery-tools` 66；7c-2 运行时本体 **1,169**：`coordinator` 411 + `lifecycle-manager` 229 + `subagent-spawn` 529，搬前 1,190）——**留内核 202 行**：契约面 `agent/subagent-runtime-contract.ts` 149（`SubAgentStatus` / `SubAgentHandle` / `SpawnedAgent` / `SubAgentPool` / `AgentLifecycleManager` / `SubAgentSpawnHost` / `SpawnAgentFn` / `SubagentRuntimeImplementation`）+ 登记表 `agent/subagent-runtime-impl.ts` 53（service 语义 fail-loud）；`workspace.ts` 不再 `new SubAgentPool`、`runtime.ts` 不再 `new AgentLifecycleManager`，改工厂查表。判内核共享 182 行：`subagent-activity` 96（UI/工具面共读的活动账）· `file-ownership` 73（compaction 包已桥）· `isolation-queue` 13（四处共用） |
| token 计量（**分类缺口**） | `token-meter/**` 874 + `token-counter.ts` 89 = **963** | **待裁**：立 `ctx.tokenMeter` service 或判内核 | 既不在 13 个 service，也不是任何 feature 产物 |
| plan 模式五件 | `agent/plan/**` = **572** | 新包 `plan-mode/` | 🟡 **批 6a 已落 302 行**：`plan-tools` 184 + `plan-injection` 57 + `plan-prompts` 61 进包（`plugins/builtin/plan-mode/`，产物 entry 555 KB）；**留内核 270**：`plan-state.ts` 121（runtime 构造的状态机）+ `plan-registry.ts` 149（强制层门禁 + 子 Agent 只读克隆）；审批三类型与实现面接口上收新 `agent/plan/plan-contract.ts`，登记表 = `agent/plan/plan-impl.ts`（见 §6.2） |
| goal 模式 | `goal-loop.ts` 317 + `goal-manager.ts` 236 = **553** | 新包 `goal-mode/` | 🟡 **批 6b 已落 317 行**：`goal-loop.ts` 整件进包（`plugins/builtin/goal-mode/`）；**留内核 236**：`goal-manager.ts`（记录 + 会话快照 + 持久化——由 `workspace.ts:634` / `chat-core.ts:1069,1101,1308` 构造，宿主→插件禁反）；契约面（`GoalLoopHost` / `GoalRunResult`）上收 `agent/goal-contract.ts`（`chat-agent-handle` 的同形声明同时删除，单一真源） |
| 附图与资产事件通道 | `request-images.ts` 259 + `tool-images.ts` 91 = **350** | 随 asset-domain（归属待裁） | 工具结果管道 vs 资产域功能 |
| state-hooks 数据源 | `state-inject.ts` 231 + `cache-store.ts` 107 = **338** | 随 `state-hooks` 包（或判共享留内核） | ✅ **批 6c 判内核共享面留内核**：消费者 `workspace.ts:17,30` / `runtime.ts:43` / `blueprint.ts:56` 全在内核（随批 9 workspace 拆分再动） |
| 第一方工具管道 hook | `hooks.ts` 301 + `hooks/` 31 = **332** | 新包 `state-hooks/` | 🟡 **批 6c 已落 ≈200 行**：`hooks.ts` 137–301（四工厂 + 构建输出解析器）与 `hooks/board-tracking-hook.ts` 进包；**留内核 136**：`Hook`/`PreflightHook` 接口 + `HookRegistry`/`PreflightHookRegistry` 两类（机制，七处内核消费）。登记表 + service 类 fail-loud（见 §6.2） |
| ACP server（**疑似死代码**） | `agent/acp/` = **306** | 新包 `acp-server/` 或**退役** | 生产零消费者（唯一引用是类型 + 自身测试） |

### 2.4 UI 面 12 项 —— 10,402 行（`app/**`+`ui/**` 共 22,901 行的 45%）

| 项 | 路径（物理行） | 应去哪 | 通道 / 障碍 |
|---|---|---|---|
| 会话流块渲染器 11 kind + `'*'` 兜底 | ~~`app/paper/builtin-renderers.tsx` **1,020**~~ | 新产物 `paper-renderers/`（**required 不可禁用**） | ✅ **批 8b 已归家**（2026-09-25）：整件 `git mv` 进 `plugins/builtin/paper-renderers/renderers.tsx`，注册点移到产物 apply（`ctx.renderers`，双走查前缀 `builtin/<kind>` ↔ `plugin/hologram/paper-renderers/<kind>`）；内核 `renderer-service` 回归纯通道；产物体积 955 KB（hljs + katex 内联） |
| mermaid 围栏渲染器 | `app/paper/mermaid-block.tsx` 312 + css 48 = **360** | 同上 | ✅ **批 8b 已处置**：**认领 + 降级随包**（`MdCodeBlock` 里 `lang === 'mermaid'` 那一段），**组件本体留应用 bundle**（`import('mermaid')` 是动态裸 import，产物构建闸拒绝）——经 faceDeps 桥 `MermaidBlock` 取用，判据写进 `docs/plugins/README.md` §3（§4-2 文档契约化） |
| ask/权限卡架 | `PromptShelf.tsx` 776 + Host 30 + css 412 = **1,218** | 新产物 `ask-cards/` | `ctx.overlays` **需新槽**（现槽位闭集渲染在 PaperPanel 内部）；`chat-core` 持 ref 句柄 |
| 案卷首页 | `app/SessionsHome.tsx` **593** | 新产物 `sessions-home/` | `ctx.panels` 无「常驻」语义；顶栏与窗口壳件同体须切分 |
| 首页样式 | `app/foundation.css` 首页区段 **≈800** | 随上项进包 | 与全局 `body::before/after` 氛围层同文件交织，须逐段切 |
| ipynb 查看器 | ~~`app/paper/viewers/ipynb.tsx` 516 + css 148 = **664**~~ | `renderers/viewers/` 内联（撤 `heavy`） | ✅ **批 8c 已内联**（2026-09-25）：本体 + css 迁进 `plugins/builtin/renderers/viewers/`（def 与组件同文件，`heavy:'ipynb'` → `component` 直挂）；markdown 单元格经宿主桥 `rendererActiveMarkdownBody()` 复用纸面渲染器 |
| markdown 独立查看器 | ~~`markdown-doc.tsx` 263 + css 147 = **410**~~ | 同上 | ✅ **批 8c 已内联**：同 ipynb（重依赖障碍由 8b 的 markdown 体渲染登记表拆掉） |
| 查看器装载面 | `app/paper/viewers/index.ts` **46** | 随上项收窄（仅 pdf/model3d 留白名单） | ✅ **批 8c 已收窄**（2026-09-25）：目录只剩 `pdf.tsx` + `model3d.tsx`（+ 各自 css）——「目录即白名单」自动生效，`viewer-registry.test` 的 heavy 双向全等守卫零改动即绿；**内核↔产物类型环同批解开**（批 8a：形状上收 `paper/viewer-contract.ts`） |

（另含 §2.1 的 settings 5,291 行——它在 `app/**` 内，但归属上属「包已有」那类。）

### 2.5 `paper/**` 里的产物私有件 —— 4,434 行

深审用全仓 import 图（931 文件 / 4,032 条边）实测：**`paper/**` 不是「一个产物的私有实现」，
也不是「全量平台基础」**，而是三层叠加：

| 层 | 文件（物理行） | 判定 |
|---|---|---|
| 契约层（2–4 个产物 + 内核共享） | `block-model.ts` 240 · `region-view.ts` 68 · `overlay-context.ts` 91 · `canvas-math.ts` 234 · `space.ts` 165 · `minimap-core.ts` 180 · `ink.ts` 374 | **留内核**（跨产物同实例/契约） |
| 判据层（有意上移的单一真源） | `asset-rack.ts` 46 · `plate-sign.ts` 38 | **留内核**（头注有案：宿主→插件方向禁反） |
| **产物私有排版引擎** | paper-shell 独占 5 件：`type-tokens.ts` **806** · ~~provenance 316 · sel-ink 138 · focus-flight 57 · sheet 36~~；compose-dock 独占 3 件：~~toc 275 · toc-ink 103 · ime 37~~ | **7 件已归家**（批 5a，962 行：paper-shell 4 + compose-dock 3）；余 `type-tokens.ts` |
| 拆分件 | ~~`measure.ts` **2015** · `group.ts` 306 · `virtualize.ts` 155 · `selection.ts` 193~~ | 类型/账本留内核，实现进 paper-shell | ✅ **批 9c 已落三件**（2026-09-26）：`selection.ts`（9c-1）· `virtualize.ts`（9c-2）· `group.ts`（9c-3）实现整件随包，形状分别上收内核契约 `paper/selection-contract.ts` / `region-geom-contract.ts` / `group-contract.ts`；faceDeps 291 → **279 键**（-12）。余 **9c-4**：`measure.ts` + `type-tokens.ts`——**实测修正账本口径**：内核消费者不止 `clearObservedHeightsForSession` 一个，`paper/ink.ts` 还要 `inkSourcesFor` / `measureSignature`（墨迹走查 = 同一台 markdown 测高引擎）⇒ 切法须「墨迹路径 + 实测回写账留内核、块级测高/镜像常量/卷首/`injectPaperTokens` 随包」 |

**最痛的一条**：`paper/type-tokens.ts` 是 paper-shell 独占，却住在内核 ⇒
`docs/plans/paper-shell/taste-ledger.md` 已把它记成现状：「属**壳域** ⇒ 改版式 token 必须重建 exe」——
与「改插件 = 换产物，永不重编译 exe」正面冲突。
**批 5a 复核（2026-09-24）**：它**还不能搬**——内核 `paper/measure.ts` 直接 import 它的
`ASSET_DERIVED`/`CHROME_TOKENS`/`FOLIO_TOKENS`/`cssUsedPx`（宿主→插件禁反）⇒ 随批 9
「拆分件」一起处理（measure.ts 的实现进 paper-shell 时，token 表随之）。同批复核：
`provenance`/`sel-ink`/`toc`/`toc-ink` 等 7 件**零内核消费者**，已搬。

### 2.6 内核里的产品件与内容腰（`composition/` · `plugins/` · 顶层）—— 2,620 行

深审结论：机制层是**真平台**（cordis 12 文件全是 vendored 快照 + 兰台自有 `boot.ts` 根 Context 单点；
组合解析 / 注册表内核 `contribution-channel.ts` / 装载器 / 13 个 service 全部名副其实，
**13 个 service 无一是空条目**）；但同批把「第一方内容的清单与腰」留在了内核——
用深审的原话说：**「进货清单挪到柜台，货仍在店里」**。

| 项 | 路径（物理行） | 判定 |
|---|---|---|
| 工作区级 Agent 装配编排 | `workspace.ts` **1,042** | **产品**（唯一持有工作区生命周期的装配点；直接 new Agent/AgentStore/SubAgentPool/GoalManager/MemoryManager/SkillRegistry + 内联调起 user-mcp/bundled-engine） |
| provider 设置数据层 | `settings.ts` **703** | **产品**（settings-domain 只载了 UI，数据/存储/凭据层留内核；`preset-assembly.ts:41` 还反向依赖它） |
| 第一方清单/腰四件 | `first-party-tools.ts` 86 + `first-party-prompts.ts` 43 + `first-party-capabilities.ts` 48 + `with-first-party-channel.ts` 51 = **228** | 清单→可由名册 `buildOrder` 派生（序真源其实已在名册）；`with-first-party-channel` 自述**只服务测试/无 UI 引导环境** ⇒ 应落 `tests/helpers/` |
| 「新建组合」实现 | `preset-authoring.ts` **192** | **产品**（唯一消费者是 `settings-domain/host.ts:18`） |
| 随包引擎接线 | `plugins/bundled-engine.ts` **186** | **产品**（见 §4-11） |
| prompt 段**文案真源** | `prompt-sections.ts` 的 L105–226 约 **122** | 第一方内容（注释自认「段定义仍留本文件」）——与 §1.1 的 `prompt-segments` 空壳是同一笔债 |
| 半尸体 i18n | `i18n.ts` **98** | 翻译表全是已退役观测台的 `legend.*` 键、语言切换 UI 已摘除 ⇒ **删除或收缩** |
| 兼容薄壳（真源已迁产物） | `composition/asset-renderers.tsx` **49** | **删除**（唯一真实 import 方是一个测试；真源=`builtin/renderers/components.tsx`） |

## 3. 零欠账面（同样重要，别再怀疑）

| 面 | 行数 | 实测结论 |
|---|---|---|
| `state/**`（31 文件） | 3,120 | **0 欠账**——无一个 store 被单一产物独占（最接近的 `work-ledger-store` 仍被 `ui/runtime-adapter`+`workspace` 消费）；教科书式跨插件共享层 |
| `shell/**`（13 文件） | 1,269 | **0 欠账**（强制层：壳行）——11 条壳行已按 `shell-rows.ts` 表序 id 寻址 + roster 可禁用；唯 `update-check.ts` 27 行是弱欠账（受 §4-9 通道缺口卡住） |
| `lifecycle/**` | 116 | **0 欠账**（Workspace 原语 + 通用 promise 工具） |
| `cordis/**` · `composition/` 通道内核 · `rpc-contract.ts` · `workspace.ts` | 2,940 / 约 2,000 / 1,004 / 968 | **强制层**（vendored 内核 / 贡献注册表 / RPC 平台面 / Workspace 原语） |
| `plugins/*.ts` 装载链（非 builtin/） | 3,681 | **强制层**（loader 1,051 / mcp-bridge 767 / types 309 / deferred 184 / product-watch 184 / window-bridge 188 / window-facility 104 / tool-declarations 158 / boot-gate 100 / factory-products 100 / 名册与清单 159 / data-fs 49 …）；另 `plugins/builtin/host-modules.ts` **552** 是 faceDeps 宿主面——**它就是欠账的度量衡**：内核 app/ 一天不归家，这份桥就得养一天 |
| 重查看器 `pdf` + `model3d` | 1,204 | **有意例外**（pdfjs/three 只能随应用 bundle 真分片）——但只写在注释里，缺文档契约（§4-2） |

## 4. 待裁定与争议（**这些不该由 Agent 自裁**）

| # | 项 | 争点 |
|---|---|---|
| 1 | `app/paper/builtin-renderers.tsx`（1,020） | 内核注释自陈「**有意**留 bundle：11 kind 是纸壳默认渲染面，禁用=纸壳裸奔」（M2 拍板）；深审判为欠账（注册点在内核 service、不经 `ctx.effect`） ⇒ 需一次归属裁定 |
| 2 | 重查看器 `pdf`/`model3d`（1,204） | 真分片例外成立，但应把「重依赖才留 bundle」写进 `docs/plugins/README.md` §3（现只有注释） |
| 3 | `ConfirmDialog`（102） | 跨插件共享原语：落内核共享面 / 各包内联 / 新增原语面（`ui/` 有只减不增守卫） |
| 4 | `CommandPalette`（204） | 「命令通道消费面 = 应用框架件」判留内核；严格读法（功能 UI 一律插件化）则应插件化 |
| 5 | MessageBus / TaskBoard / DiscoveryBoard（合计 ≈1,309） | 「多产物共享的平台基础」可辩护留内核；判欠账的理由是它们只服务多 Agent 一族且已在 capability 清单里 |
| 6 | token-meter（963） | **分类缺口**：既不在 13 个 kernel service，也不是 feature 产物 ⇒ 是否立 `ctx.tokenMeter` service（DSH 有） |
| 7 | `agent/acp/**`（306） | 生产零消费者 ⇒ 拆包还是按死代码退役 |
| 8 | `paper/viewer-exts.ts` 226 + `tool-text/markdown/marks/fold/translate` 2,226 | 判定随「`app/paper/**` 归属」翻转——第 1 条裁定后须重判 |
| 9 | **壳行贡献通道缺口** | 插件无法贡献 boot 行（`builtinShellRows()` 是硬编码数组）⇒ `update-check` 一类「产物需要 boot 期副作用」的需求全卡住；需立 `ctx.shellRows` 一类通道 |
| 10 | `asset-kinds.ts`（581） | 被 `composition/renderer-service.tsx` 与 `paper/measure.ts` 共享：随 asset-domain 迁 or 判「注册表机制」留内核 |
| 11 | 装载链里的产品接线 | `plugins/bundled-engine.ts` 186（随包图谱引擎拉起）做成第一方产物即可进插件列表（天然 kill switch）；障碍：decl 需按**工作区根**动态构造（manifest 声明是静态的）+ 须覆写 `McpBridgeIO.pluginDir`（引擎不是已安装插件名）⇒ 现有声明通道缺这两个注入口。涉及引擎开关语义，须拍板。**最小设计件已立**（2026-09-24）：[`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)——复核后判定卡点不是声明面缺动态语义，而是「产物拿不到工作区生命周期 + 拿不到 MCP 桥」两件更基础的事 |
| 12 | `user-mcp.ts`（142） | 第二套 MCP 声明通道：**现行契约已 sanction**（`plugins/README.md:416-420` 用户级直配段）；张力来自**已归档**的 `agent-platformization-plan.md:360`「不引入第二套插件格式…不加旁路」⇒ 按现行契约应「承认并登记」，而非折并 |
| 13 | `ui/lsp-client.ts` 的 `ctx.lsp`（655） | **分类缺口（同 token-meter）**：真 cordis Service（`super(ctx,'lsp')`）却**不在 13 service 清单、不经 loader 装载**，还自建第二个根 Context 绕过 `initCordisKernel()` ⇒ 不受「内核不可禁用」声明覆盖、不进 boot 审计。全仓 `extends Service` 共 19 处 / 19 个 ctx 键，而「13」只覆盖其中一部分 |
| 14 | `composition/space-service.ts`（193） | 零自有状态，只做只读合流 + 命令转发到产品 store：按 canvas 设计件判「平台开放 API」，按宪法第五条「能换实现 ⇒ 开放面」复核则偏产品 |
| 15 | ~~13 service 名**双写**~~ | `loader.ts` 的 `BUILTIN_PLUGINS` ↔ `first-party-manifest.ts` 的 `SERVICE_META` 两处手写、靠守护测试对拍 ⇒ 可收成单一真源 |

## 5. 怎么让它不再隐形（守卫建议 · 批 0）

**病灶**：现有守卫很密（Rust 命令面冻结 / 宿主人面指纹 / 契约指纹 / manifest 完备性 / 名册单一真源
/ agent→ui 单向……），但**没有一条问「实现住哪」**：

| 缺口 | 后果 |
|---|---|
| 无「产物实现必须住包内」检查 | 21 个空壳与 §2 全部欠账对门禁**完全隐形** |
| 无 `composition/**` · `plugins/**` 顶层文件集冻结 | 「只减不增」只对 `ui/**`（59 文件 manifest）与 `events.ts`（11 事件）生效 ⇒ 特权区可悄悄膨胀（§2.6） |
| 无「13 service 必须由 loader 装载」检查 | `ctx.lsp` / `ctx.agentLoop` 这类游离服务无人发现（§4-13） |
| 无「生产 bundle 不含 builtin/ 源码」断言 | §0.1 的缺陷（30 产物源码进 exe）无人发现 |

**治法**（三条，照仓库既有范式抄）——**2026-09-24 批 0b 全落**：

1. **产物归家账（销账制）**——真源 = 名册 `builtin-roster.json` 各条目的 `impl`
   （尚未归家的实现真源，相对 `src/`；搬一条删一条，清空即实心化）；守卫
   `src-ui/tests/plugin-home-ledger.test.ts` 只做机制：**磁盘实测的空壳集必须已登记 impl**、
   登记的必须仍真的是空壳/仍被引用（实心化不销账 = 红）、登记路径必须还在（账不腐）。
   （原计划的 `KNOWN_SHELLS` 常量表改成名册字段——人读备注留测试内的 `NOTES`，防「两处真源」。）
2. **特权区文件集冻结**——`src-ui/tests/privileged-zone-freeze.test.ts`：
   `composition/**`（31 文件）+ `plugins/` 顶层（17 文件）⊆ 冻结基线，基线每条必须在磁盘（销账制），
   另加**行数水位线**（composition 4,985 / plugins 4,238，只减不增）与 `KNOWN_DEBT` 登记
   （清单四件 + `preset-authoring.ts`，搬完两处一起销）。
3. **构建期断言**——`src-ui/tests/product-source-not-in-bundle.test.ts`（dist 在场才跑）：
   产物体内无产物源码独有串（探针从产物源码派生）+ 壳/产物两侧 CSS 面无未覆盖选择器。见 §0.1。
4. **宿主面偏斜保险丝 a 的覆盖面**（2026-09-24 批 4c-3 补）——`scripts/lib/face-keys.mjs`
   从产物 `entry.js` 反查 `mods.faceDeps` 的属性访问，构建期写进 `face.json`，装载器 import 前
   对拍运行时 faceDeps（缺键拒载）+ 指纹（`hostApi`）。**实测病灶**：锚点形态是
   `<标识符>.mods.faceDeps`，而 22/30 个产物的 `host.aliased.ts` 写成单行
   `const impl = requireHost().mods.faceDeps;` ⇒ 提取为空 ⇒ 不写 `face.json` ⇒ 装载器按
   「零需求」放行——**保险丝静默失效**（含批 2a/3a/4a/4b/4c/5a 亲手归家的全部产物，
   以及 `sessions-builtin` 等先例）。修法 = 该行拆两步（`const host = requireHost();` +
   `const impl = host.mods.faceDeps;`，esbuild 内联后正好命中锚点），22 个文件一次改完；
   覆盖 5 → **27/30**（余 3 个真实无宿主面：`fs-builtin` / `shell-builtin` / `renderers`）。
   守卫 = `tests/face-keys.test.ts` 第二段（dist 在场才跑）：引用 faceDeps 的产物必须有
   `face.json`、`faceDeps` 非空、`hostApi` 指纹 = 当前宿主面基线。

**常驻对账**：`npm --prefix src-ui run plugin-home:report`（`scripts/plugin-home-check.cjs`，
`--json` 机器可读）——三色清单：**红** = 名册 `impl` 仍在内核（逐产物逐文件列行数），
**绿** = 平台白名单 + 已被产物认领的共享面，**灰** = 无产物认领也不在白名单。
**2026-09-26 基线**（批 9c-1~3 后重测）：红 **9 产物 / 23 文件 / 7,478 行**（§1 的 7 条 +
§2.1 Provider 家族 8 件 + §2.5 的 `type-tokens`；批 8 新产物 `paper-renderers` 零 impl 认领 ⇒ 红区不动）；
绿 119 平台 + **106 已认领**；灰 **78 文件 / 22,072 行**（批 8 把渲染面判据层收成 `shared`：
`markdown` / `marks` / `tool-text` / `fold` / `translate` 五件进 paper-renderers 与 renderers 的
shared 名单；批 9a 把 token-meter / acp 登记进平台白名单，9c-1~3 把 selection / virtualize /
group 三件实现随 paper-shell 包）。
（红区数字涨不是倒退：批 1 把 §2.1 那 2,740 行从「隐性欠账」认领成了显性红账。）

## 6. 建议批次（合并四份深审的次序；每批门禁全绿再下一批）


| 批 | 内容 | 量 | 状态 / 为什么这个次序 |
|---|---|---|---|
| **0a** | **修 §0.1 缺陷**：序真源换名册（上窗）+ 构建期置换产物清单模块 + 构建期断言 | — | ✅ **已落**（2026-09-24）：产物 JS −1.32 MB（−25.5%）；「配置 DCE 两条路都无效」的实测记在 §0.1 |
| **0b** | 立账 + 三条守卫 + 常驻对账报告 | — | ✅ **已落**：归家账（名册 `impl`）/ 特权区冻结（31+17 文件 ⊇ 基线 + 销账制）/ dist 文案与 CSS 面断言 / `plugin-home:report` |
| **0c** | 顺手三清：删 `composition/asset-renderers.tsx`（49，真源已迁）· 收缩 `i18n.ts`（98→21，半尸体）· 清 `preset-authoring.ts`（192）归 settings-domain | 339 | ✅ 全清（第三件并入批 1）——它要动的正是 settings-domain 的 host/faceDeps 面，与三页归家同一处 churn，合并只付一次 baseline 重生成 + exe 重建成本 |
| **1** | settings 三页归家（McpPage/PluginsPage/SkillsPage）+ `preset-authoring` 随迁 | 1,103 + 192 | ✅ **已落**（2026-09-24）：三页 `git mv` 进包、内核依赖改走包内 `./host` 逐符号桥（+24 faceDeps 键，baseline 重生成）、产物自包含校验过、CSS 面无需动（三页 class 本就在包内 `settings-panel.css`）；链路（页面进包 + host 三处同步 + 产物构建 + faceDeps 指纹）已走通 |
| **2** | seam provider 实心化：`llm-adapters`（三适配器 + 两个私有 helper）；`subagent-in-process` 并入批 7 | 1,916 | ✅ **llm-adapters 已落**（2026-09-24 批 2a）：1,916 行进包、端点真源上收内核、16 个运行时桥位、产物 2.6 KB→41.6 KB（**适配器自此可热更**）。`subagent-in-process`（543）复核后并入批 7——它要同一片 `agent.ts`/context/message-bus 面（16 桥位），那批本就要整片搬 |
| **3** | 单文件直连六件：memory · skill · task · wait · office · cordis | ≈1,985（含随行） | ✅ **批 3a 已落 3 件**（wait 102 · office 576 · cordis 200 = 878 行；桥位仅 9 运行时 + 7 类型）。**memory/skill/task 复核后改期**：它们的类是内核构造的（`workspace.ts` new MemoryManager/SkillRegistry、runtime 用 TaskBoard 11 处）⇒ 整件搬会造宿主→插件反向依赖（仓库禁反），改随批 7 / 批 9 |
| **4** | 大文件按域拆：`coding.ts` 五域 + `browser.ts` + `manifest-tools/search-assembly`（+ 三个域私有编排件） | ≈2,600 | ✅ **已全落**：4a `browser.ts`（912）· 4b `manifest-tools` 按域拆（187+169，search/web 各归其包）· 4c `coding.ts`（998，一文件载五族）拆完 **整文件退役**——4c-1 git · 4c-2 ask/agent-isolation · 4c-3 fs/shell（顺带上收 `ownerIdOf`/`ownerSeamView` 进 `composition/seam-scope.ts`）。随行件去向：`sticky-cwd` 并入包内族段，`git-porcelain` 126 / `session-context` 122 / `structured-error` 24 因内核消费者**留内核桥** |
| **5** | paper 独占件随包：paper-shell 5 件 + compose-dock 3 件 | 1,765 | ✅ **批 5a 已落 7 件 / 962 行**（provenance 316 · sel-ink 138 · focus-flight 57 · sheet 36 · toc 275 · toc-ink 103 · ime 37；零内核消费者）；`type-tokens.ts` 806 行**复核后改期**——内核 `paper/measure.ts` 直接引用其 token 表（宿主→插件禁反），随批 9 拆分件一起搬 |
| **6** | agent/ 能力面新产品：plan-mode · compaction · state-hooks · goal | ≈3,485 | ✅ **批 6 四项全落**：6a plan-mode（302 行）· 6b goal-mode（317 行）· 6c state-hooks（≈200 行）· 6d compaction（1,773 行进包 + 414 行留内核）。四项都**不是**「按域拆」型欠账（实现被内核构造/调用）⇒ 走用户拍板的「内核登记表 + 产物登记实现」接缝：capability/工具表条目原位不动、**convergence 基线全程零改动**（表序零漂移的证明）。分类按拍板：plan/goal = feature（可禁用），state-hooks/compaction = service（缺实现 fail-loud）。施工单 = [`capability-impl-seam-design.md`](capability-impl-seam-design.md) |
| **7** | 多 Agent 协作域：子代理运行时本体 + 通信族 + discovery | ≈2,293 | ✅ **批 7 全落**（侦察见 §6.3，实测 ≈3,177 行）：7a `agent-domain` 实心化（265）· 7b 通信族（1,093 进包 / 185 留内核契约）· 7c-1 merge/discovery 两工具族（338 进包）· 7c-2 子代理运行时本体（1,169 进包 / 202 留内核契约，**整包实心化、名册销账**）· 7d 账目清账（无代码动作：`file-ownership` / `isolation-queue` / `subagent-activity` 三条判内核共享已写进 §2.3，名册两条销账已兑现）。施工单 = [`multiagent-extraction-design.md`](multiagent-extraction-design.md) |
| **8** | 渲染面整合：纸面渲染器归家（含 mermaid）+ ipynb/markdown-doc 内联 + 白名单收窄 + 解开内核↔产物类型环 | ≈3,300（侦察实测，原估 2,500） | ✅ **批 8 全落**（2026-09-25，侦察见 §6.4，施工单 [`renderer-face-extraction-design.md`](renderer-face-extraction-design.md)）：8a 类型环解结（形状上收 `paper/viewer-contract.ts` + 新守卫「内核 ↛ 产物源码」）· 8b 新产物 `paper-renderers`（1,020 行，**required 不可禁用** + markdown 体渲染登记表 + mermaid 走重依赖例外）· 8c ipynb/markdown-doc 撤 heavy 内联（1,169 行随包，白名单收窄到 pdf/model3d，hljs 单一真源）· 8d 文档契约化（`docs/plugins/README.md` §3 重依赖判据）。hljs「两处内联」口径 = 应用 bundle 归零（两份都随产物），语言表收成一处 |
| **9** | 拆分件 + provider 控制台大块 + 常驻面（SessionsHome / PromptShelf）+ §2.6 内核产品件（`workspace.ts` / `settings.ts`） | ≈11,000 | 🟡 **9a / 9b / 9c-1~3 已落**（2026-09-26）：9a 内核 service 名单收单一真源（新 `plugins/service-plugins.ts`，loader 与清单双向派生；§4-15）+ `ConfirmDialog` 挪内核共享面（§4-3）+ 账目登记三件（§4-6/§4-7/§4-12）⇒ 灰区 84→79 文件 · 9b `ctx.lsp` 入内核 service 清单（13→14，`lspServicePlugin`）并删掉自建第二个根 Context（§4-13 A）——所有权改「进程级单例 + 工作区级清态」。余：9c 拆分组五件 → 9d provider 控制台 → 9e 常驻面（含 `ctx.overlays` 新槽，开工前问一次）→ 9f `settings.ts` + `workspace.ts` → 9g 收尾。侦察见 §6.5，施工单 [`batch-9-extraction-design.md`](batch-9-extraction-design.md) |

**常驻对账（本账的稳态）**：批 0 里一并落 `plugin-home:report`（§5 三色清单）——
此后「还剩什么」由报告回答，本页只保留结论与批次表；**报告灰区非空即告警**，
不需要再安排「人肉再验一轮」。

**批 10（单独立项，2026-09-24）**：工作区接线贡献面 + 随包引擎产物化——
设计件与真机验收清单见 [`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)；
**先跑验收四条，再定稿施工**（该链路从未真机跑通）。

### 6.3 批 7 施工侦察（2026-09-24 实测；施工单 = [`multiagent-extraction-design.md`](multiagent-extraction-design.md)）

**范围（逐文件实测行数）**：通信族 **1,204**（`message-bus` 605 · `message-types` 137 ·
`message-store` 129 · `topology` 80 · `tools/communication` 159 · `tools/request` 94）·
子代理运行时 **1,089**（`coordinator` 420 · `lifecycle-manager` 217 · `tools/merge` 215 ·
`subagent-activity` 96 · `file-ownership` 73 · `tools/merge-gate` 55 · `isolation-queue` 13）·
**名册红账两条**：`agent-domain` = `tools/subagent` **265**、`subagent-in-process` =
`subagent-spawn` **551** · `tools/discovery` **68** ⇒ 合计 **≈3,177 行**（账本原估 2,293）。

**比批 6 更重的一层**：实现不只是「被内核调用」，而是**被内核 `new` 出来的类**——
`workspace.ts:18` `new SubAgentPool`、`runtime.ts:34-39` `new MessageBus` / `new JsonMessageStore` /
`new AgentLifecycleManager`、`tools/merge.ts:19` + `runtime.ts` + `lifecycle-manager.ts` +
`subagent-spawn.ts` 四处共用模块级 `isolation-queue`。⇒ 除工具族外都要**工厂登记**
（`requireX().create…(...)`，service 语义 fail-loud）。

**两处值 re-export（4c 裁定① 同款，必须先退役）**：`agent/tool.ts:244`
`export { createSubAgentTool, type SubAgentSpawner } from './tools/subagent'`（内核聚合产物）·
`agent.ts:121` `export { buildSubAgentTools, wrapTool } from './subagent-spawn'`。

**判内核共享（留内核，写进账目避免下批重侦察）**：`file-ownership`（compaction 包已桥
`extractFilePath` / `WRITE_TOOLS`）· `isolation-queue`（四处共用的模块级队列）· `SubAgentStatus`
类型面。**UI 直读类型**：`AgentMessage`（`ui/agent-panel-store.ts`）⇒ 7b 上收契约。

**爆破半径**：34 个直连测试（coordinator 21 + MessageBus 13）+ `tools/subagent` 面的 12 个文件
（含 convergence 两个 spec 与 fixtures）+ `wait-domain` 的 `SubAgentStatus` 桥。

**子批**：7a `agent-domain` 实心化（265，闭合一条红账）→ 7b 通信族（1,204）→ 7c 运行时
（1,640，闭合 §1.2 + §2.3 两条）→ 7d 账目清账（红区预期降到 9 产物 / 23 文件）。

**批 7a 落地（2026-09-24，agent-domain）**：
- 进包 265 行 → `plugins/builtin/agent-domain/subagent-tools.ts`（三工厂）+ `implementation.ts` +
  `index.ts`（apply 期登记 + 工具行 family 两条面）+ host 双面（**不再**二次出口包内工厂）。
- 契约面上收：`agent/subagent-tools-contract.ts`（`SubAgentSpawner` 是装配输入 ⇒ 类型留内核；
  `SubAgentToolsImplementation`）；`composition/tool-rows` / `runtime/types` / `agent-builder` 改指。
- 登记表：`agent/subagent-tools-impl.ts`（feature 语义）；blueprint 的 merge-tool / spawn-tool
  两条 capability 改查表。**退役 `agent/tool.ts` 的值 re-export**（4c 裁定① 同款，实测零消费方）。
- faceDeps：撤 2 键（`createSubAgentTool` / `createAgentStatusTool`）补 6 键 ⇒ 指纹
  `5a542fb9 → f90a5a45`；产物 `face.json` 7 键（保险丝 a 覆盖 34/34）。
- 测试面：13 个文件改指包内；新腰 `tests/helpers/subagent-tools-impl.ts` 接进 convergence phase-1
  （裸 AgentRuntime 需复现「装载器已装载」）。
- **真机验收**（重建 exe + CDP）：faceDeps **267 键**（−2 +6）、6 个新键类型全对、两个旧键**已撤**；
  `/plugins/hologram/agent-domain/entry.js` 555 KB 且动态 import 成功（含 agent_spawn/agent_status/
  agent_kill 真身）；`face.json` 带 `f90a5a45`。
- **验收**：vitest 406 文件 / 4,310 用例全绿 · build + build:builtin-plugins · biome ci 0/0 ·
  **convergence 双轨基线零改动** · doc-sync + doc-check 全绿。红区 **11 → 10 产物 / 25 → 24 文件 /
  8,283 → 8,023 行**；空壳 9 → 8。

**批 7b 落地（2026-09-24，通信族；新产物 multiagent-comm）**：
- **进包 1,093 行** → `plugins/builtin/multiagent-comm/`：`message-bus.ts` 611 ·
  `communication-tools.ts` 164 · `message-store.ts` 130 · `request-tools.ts` 91 · `topology.ts` 80
  + `implementation.ts` / `index.ts` / host 双面（122 行）。
- **留内核 185 行**：`agent/message-contract.ts`（原 `message-types.ts` 整件升格——消息类型 +
  四个错误类 + 新增 **`MessageBus` 接口** + `MultiagentCommImplementation`）·
  `agent/multiagent-impl.ts`（登记表，service 语义）。
- **内核构造者改造**：`runtime.ts` 的 `new MessageBus(...)` / `new JsonMessageStore(...)` 改
  `requireMultiagentComm().createBus/createJsonStore`；blueprint 两条 capability
  （communication-tools / request-tool）同改查表。
- **登记面**：名册加 `multiagent-comm`（buildOrder 34，34→35 条）+ `firstPartyCapabilityPlugins()`；
  计数快照三处 + facts（47→48）+ 文档（34→35）；faceDeps **+5 键**（登记表 + 四个错误类；
  三个 kernel* 文件腰早已在册）⇒ 产物 `face.json` 重生成（保险丝 a 覆盖 35/35）。
- **契约面四步流程**：`agent-loop/types.ts` 一行类型导入改指新契约 ⇒ 开放面契约 **48 → 49**
  （变更记录 + `gen:contract-fingerprint` 同 commit）。
- **测试面**：15 个直连测试改指包内/契约（`message-bus.test` 最大）；
  **测试基建立规（批 7b 新增）**：服务型接缝的测试域复现改走 `tests/setup.ts` 的
  **`beforeAll` + 动态 import**——顶层静态 import 会先于测试文件的 `vi.mock` 提升执行、
  架空 mock（批 6d-2 实测教训），而 `beforeAll` 落在 mock 注册之后 ⇒ 一处覆盖全部测试文件
  （本轮实测：40+ 文件的缺实现红一次性收敛；先前 6a/6c/6d 的散点腰保留不动）。
- **验收**：vitest 406 文件 / 4,306 用例全绿 · build + build:builtin-plugins（35 产物自包含）·
  biome ci 0/0 · **convergence 双轨基线零改动** · doc-sync + doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **272 键**（+5）、5 个新键类型全对；
  `/plugins/hologram/multiagent-comm/entry.js` 570 KB 且动态 import 成功（含 `agent_message` /
  `agent_request` / `TreeTopology` 真身）；`face.json` 13 键带指纹 `5824ccb8`（保险丝 a 覆盖 35/35）。

**批 7c-1 落地（2026-09-24，merge / discovery 两工具族进 subagent-in-process 包）**：
- **进包 338 行**：`tools/merge.ts` 215 → `merge-tools.ts` · `tools/merge-gate.ts` 55 → `merge-gate.ts` ·
  `tools/discovery.ts` 68 → `discovery-tools.ts`，内核依赖改走包内 `./host`。
- **契约面 + 登记表**：新 `agent/subagent-runtime-contract.ts`（`MergeToolsImplementation` +
  `DiscoveryToolsImplementation` + `MergeGateResult` 结构镜像）· `agent/subagent-runtime-impl.ts`
  （两族登记表，feature 语义）。
- **内核消费点**：blueprint 的 merge-tool / discovery-tools 两条 capability 与 `subagent-spawn.ts`
  的子 Agent discovery 注册改查表（未登记 = 静默不装）。
- **faceDeps +4 键**（`registerSubagentRuntime` · `enqueueIsolationOp` · `execStreamedShell` ·
  `parseIsolationDiff`）；6 个测试改指包内。
- **账本口径**：`subagent-in-process` 由「空壳」转**半迁移**（包内已有 338 行自有实现 ⇒ 出空壳集；
  `impl` 认领留到 7c-2 销）⇒ `plugin-home-ledger` 口径 8 → **7 条（5 纯壳 + 2 半壳）**。
- **测试基建**：`tests/setup.ts` 的 `beforeAll` 常驻登记扩到 subagent-runtime（与 7b 的
  multiagent-comm 同一处），convergence phase-1 快照因此零改动。
- **验收**：vitest 406 文件 / 4,305 用例全绿 · build + build:builtin-plugins · biome ci 0/0 ·
  **convergence 双轨基线零改动** · doc-sync + doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **276 键**（+4）、5 个探针键类型全对；
  `/plugins/hologram/subagent-in-process/entry.js` 554 KB 且动态 import 成功（含 `agent_merge` /
  `agent_discover` / `runCompileTest` 真身）；`face.json` 7 键带指纹 `6cd49b33`（保险丝 a 覆盖 35/35）。

**批 7c-2 落地（2026-09-24，子代理运行时本体进 subagent-in-process 包 ⇒ 整包实心化）**：
- **进包 1,169 行**（搬前 1,190）：`agent/coordinator.ts` 420 → `coordinator.ts` 411 ·
  `agent/lifecycle-manager.ts` 217 → `lifecycle-manager.ts` 229 · `agent/subagent-spawn.ts` 553 →
  `subagent-spawn.ts` 529（三件 `git mv` 保历史，头注合并、导入面按 biome 收口）。
- **契约面 + 登记表**：`agent/subagent-runtime-contract.ts` 扩到 149 行——新增 `SubAgentStatus`
  枚举 / `SubAgentHandle` / `SpawnedAgent` / `SubAgentPool` 接口 / `AgentLifecycleManager` 接口 /
  `SubAgentSpawnHost`（从 spawn 上收）/ `SpawnAgentFn` / `SubagentRuntimeImplementation`（五个成员：
  `createPool` / `createLifecycleManager` / `spawnSubAgent` + 7c-1 两族）；登记表
  `agent/subagent-runtime-impl.ts`（53 行）由 feature 语义转 **service 语义**（`require…()`）。
- **内核消费点**：`workspace.ts` 的 `new SubAgentPool()` → `requireSubagentRuntime().createPool()`；
  `runtime.ts` 的 `new AgentLifecycleManager(...)` → `requireSubagentRuntime().createLifecycleManager(...)`；
  `agent/tool.ts:244` 与 `agent.ts:121` 两处值 re-export 退役（4c 裁定①的收尾）；
  7 处类型消费点（subagent-service / tool-rows / runtime/types / context / agent-builder /
  agent-domain·wait-domain 两 host）改指契约面。
- **faceDeps**：撤 `spawnSubAgentImpl` 桥，补 11 键（`Agent` · `once` · `createExecState` ·
  `HookRegistry` · `buildOutputSchemaInstruction` · `planRegistry` · `removeSubAgentActivity` ·
  `wrapSubAgentSink` · `ToolRegistry` · `convergeRegistry` · `FileOwnership` ·
  `activeStateHooksImplementation`）⇒ 276 → **287 键**；`host.aliased.ts` 逐符号镜像（23 值 + 7 类型）。
- **契约面四步流程**：`composition/subagent-service.ts` 一行类型导入改指新契约 ⇒ 开放面契约
  **49 → 50**（变更记录 + `gen:contract-fingerprint` 同 commit）。
- **测试面**：24 个直连测试改指包内（`coordinator.test` / `lifecycle-*` / `phase4-collaboration` /
  `agent-spawn-sync` …）；`buildSubAgentTools` 从 `agent/agent` 退役后测试改指包内；
  `tests/setup.ts` 的常驻登记由「两族」改登记**整个运行时对象**（与产物 `index.ts` 同源）；
  `gen-tool-contract-md.ts` 与 bench 的 `SubAgentPool` 引用改指包内（scripts 不回流内核）。
- **账本口径**：`subagent-in-process` 名册 `impl` 销账 ⇒ 红区 10 产物 / 24 文件 / 8,031 行 →
  **9 / 23 / 7,478**；空壳集仍 **7 条（5 纯壳 + 2 半壳）**（7c-1 起它就不是薄壳）。
- **验收**：vitest 406 文件全绿 · build + build:builtin-plugins（35 产物自包含）· biome ci 0/0 ·
  **convergence 双轨基线零改动**（7 文件 / 44 用例双轨绿）· doc-sync + doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **287 键**（276 → 287，+11）、13 个探针键类型全对、
  `spawnSubAgentImpl` **已撤桥**（`(缺)`）；`/plugins/hologram/subagent-in-process/entry.js`
  **577 KB**（554 → 577 KB）且动态 import 成功（`SubAgentPool` / `AgentLifecycleManager` /
  `wrapTool` / `buildSubAgentTools` / `agent_merge` 真身俱在）；`face.json` **23 键**带指纹
  `d5cd61db`（保险丝 a 覆盖 35/35）；启动期 console 无异常（仅结构性的无 face.json 产物 404）。

### 6.4 批 8 施工侦察（渲染面整合，2026-09-25 实测；施工单 = [`renderer-face-extraction-design.md`](renderer-face-extraction-design.md)）

**件（物理行，2026-09-25 实测）**：`app/paper/builtin-renderers.tsx` **1,020**（11 kind + `'*'`
兜底；导出面只有 `JsonBody` 与 `builtinRendererDefs()`）· `app/paper/mermaid-block.tsx` 312 + css 48 ·
`app/paper/viewers/ipynb.tsx` 516 + css 148 · `markdown-doc.tsx` 263 + css 147 ·
`app/paper/viewers/index.ts` 46（目录即白名单）· 随包候选：`paper/markdown.ts` 613 ·
`paper/tool-text.ts` 704 · `paper/marks.ts` 45（§4-8 重判：消费者只有渲染面）·
留内核：`paper/fold.ts` 223 · `paper/translate.ts` 646（paper-shell 产物经 faceDeps 桥用）。
合计约 **3,300 行**（账本原估 ≈2,500，差额 = 三个随包私有件）。

**四条实测硬点**（施工前必读，逐条有 file:line）：
1. **不是纯类型环**：内核 `app/paper/viewers/{index,ipynb,markdown-doc,pdf}.tsx` 引产物
   `renderers/viewer-registry` 的**类型**，而 `model3d.tsx:69` 引的是**值** `normalizeExt` ⇒ 「白名单收窄」
   必须先搬类型契约（值函数一并）。
2. **产物域禁动态裸 import**（`build-builtin-plugins.mjs:239-243` 硬闸）：`mermaid-block.tsx:61` 的
   `import('mermaid')` 使 mermaid **不能住产物** ⇒ 组件的「认领 + 降级」逻辑随包、**组件本体留应用
   bundle 经 faceDeps 桥取用**（同 pdf/model3d 的重依赖例外，§4-2 的文档契约化一并办）。
3. **渲染面 CSS 跨产物**：代码查看器的壳类与整套 hljs 配色住 **paper-shell 产物**
   （`PaperPanel.css:1185-1290` / `:5477-5519`），不在 renderers 产物内 ⇒ 本轮不动这份 CSS，
   只把「同族类名豁免」记进施工单（`product-source-not-in-bundle.test.ts:194-195` 的豁免面）。
4. **hljs 实测 3 个 import 点 / 2 份独立内联副本**：`app/paper/builtin-renderers.tsx:19-27`（应用 bundle）
   + `renderers/viewers/code.tsx:21-31`（产物）+ `app/paper/viewers/ipynb.tsx:32`（复用应用 bundle 那份）
   ⇒ 「消掉两处内联」的口径定为：**应用 bundle 里的 hljs 归零**（两份都随包），语言注册表收成单一真源。

**会响的守卫（搬前先看，file:line）**：`tests/paper-v3b.test.ts:37-60`（11 kind 精确序 + 行 id 以
`builtin/` 开头）· `tests/viewer-registry.test.ts:237-246`（`heavyViewerIds()` ⇄ 全部 `heavy` 键双向全等）·
`tests/paper-visual-decisions.test.ts:44-49`（**拼接两文件源码**做断言——搬文件必须同步改）·
`tests/mermaid-block.test.tsx:239-262`（不得出现静态 `'mermaid'` 值 import）·
`tests/product-source-not-in-bundle.test.ts:113-203`（产物独有串不得进壳 bundle + 产品 CSS 覆盖）·
`tests/contribution-channel-single-source.test.ts:122-147` · `tests/viewer-artifact-load.test.tsx:110-135`。

**爆破半径**：30 个测试文件（`viewer-*` 14 · `paper-*` 12 · `asset-media-load` · `renderer-registry` 一族）。

**批 8 落地（2026-09-25，四笔各自的验收全绿）**：

- **8a 类型环解结**：新内核契约 `src/paper/viewer-contract.ts`（`ViewerBytes` / `ViewerMode` /
  `ViewerProps` / `ViewerDef` / `normalizeExt` 从产物原样上收，产物 re-export）；内核 5 处改指
  （含 `model3d.tsx` 的**值** `normalizeExt`）；新守卫 `tests/kernel-product-import-guard.test.ts`
  （4 用例：内核 ↛ 产物源码 + `main.ts` 只准引产物 CSS + 两条自检）。
- **8b 纸面块渲染器归家**：新产物 `paper-renderers`（`renderers.tsx` 1,020 + `index.tsx` 注册 +
  `host.ts`/`host.aliased.ts` 桥）；**required 机制**（名册 `required: true` → 清单 meta →
  loader 两条禁用路径跳过 → 设置页「常驻 · 不可禁用」）；新内核登记表
  `src/paper/markdown-body-seam.ts`（跨产物 markdown 复用面）；内核 `renderer-service` 回归纯通道；
  faceDeps **287 → 290**（`MermaidBlock` / `Overlay` / `readAttachmentBase64`）。
- **8c 撤 heavy 内联**：ipynb（516 + css 148）· markdown-doc（263 + css 147）迁进
  `renderers/viewers/`（1,169 行随包），`app/paper/viewers/` 只剩 pdf/model3d；
  hljs 收成 `viewers/hljs.ts` 一份（语言表并集）；faceDeps **290 → 291**（`activeMarkdownBody`）。
  同批修提取器 bug：esbuild 路径注释 `// …/echarts/lib/core/impl.js` 被属性访问正则命中 ⇒
  误把 `js` 收成宿主面键（会让装载器按缺键拒载整面）——修法 + 回归用例。
- **8d 文档契约化**：`docs/plugins/README.md` §3 新增「重依赖才留应用 bundle」判据
  （轻依赖内联 / 重依赖走 `heavy` 或 faceDeps 桥，附判据一句话）。
- **真机数字**（重建 exe + CDP）：faceDeps **291 键**、指纹 `15720716`，7 个探针键类型全对
  （`registerMarkdownBody` 正确地**不在**桥面——登记是内核内部事）；
  `paper-renderers/entry.js` **955 KB**（hljs + katex 内联）动态 import 成功且 `MarkdownBody` /
  `JsonBody` 真身在场、`face.json` 5 键；`renderers/entry.js` **2.68 MB** + `entry.css` 20 KB，
  含 `parseNotebook` 与 `pp-viewer-mddoc` 类名（撤 heavy 后的两个查看器真身）、`face.json` 1 键；
  启动期 console 无异常（仅结构性的无 face.json 产物 404）。

### 6.5 批 9 施工侦察（拆分件 + 常驻面 + 内核产品件，2026-09-26 实测；施工单 = [`batch-9-extraction-design.md`](batch-9-extraction-design.md)）

本批是账上最大一笔（≈11,000 行）：**灰区 84 文件 / 23,124 行的主体 + 红区最后 9 条账**都在这里。
§7 八条前置裁定全部在位（§4-5 A · §4-6 B · §4-7 B · §4-9 B · §4-11 B暂 · §4-12 B · §4-13 A）。

**拆分组实测出边**（2026-09-26，决定「契约层留什么 / 实现进哪」的那一行）：

| 件 | 内核消费者（契约层） | 产物消费者（实现层） |
|---|---|---|
| `paper/measure.ts` 2,015 | `paper/ink.ts`（值 `inkSourcesFor`/`measureSignature`）· `state/messages-store.ts`（值 `clearObservedHeightsForSession`） | `paper-shell/{host,dock-tether}.ts` |
| `paper/type-tokens.ts` 806 | 仅 `paper/measure.ts`（五符号） | `paper-shell/host.ts` + `host-modules.ts`（`injectPaperTokens`） |
| `paper/group.ts` 306 | `paper/region-view.ts`（类型 `WorkUnit`） | `paper-shell/host.ts`（五值） |
| `paper/virtualize.ts` 155 | `paper/overlay-context.ts` · `paper/region-view.ts`（三类型） | `paper-shell/host.ts`（三值） |
| `paper/selection.ts` 193 | `state/canvas-store.ts`（类型 `PaperStrip`） | `paper-shell/host.ts`（四值） |

**其余各组实测**：常驻面 `SessionsHome.tsx` 593（唯一消费者 `app/App.tsx`）+ `foundation.css` 1,003 行里
首页段 ≈850（125–976 行）· ask 卡架 `PromptShelf` 776 + Host 30 + css 412（消费者 `chat-core`
类型 + `PromptShelfHost`）· provider 控制台 8 件 2,740（红区已列）· 内核产品件 `workspace.ts` 1,076
（8 个内核 import 方）· `settings.ts` 705（**29 个** import 方）· `ui/lsp-client.ts` 655（§4-13）。

**子批切分**（施工单 §3）：9a 账目登记 + 双写收口 + `ConfirmDialog` 挪位 → 9b `ctx.lsp` 入内核清单（13→14）→ 9c 拆分组五件（3,475）→ 9d provider 控制台（2,740）→ 9e 常驻面（≈2,660，含 `ctx.overlays`
**新槽**——按 §7 路由属「新增通道」层，开工前问一次）→ 9f `settings.ts` + `workspace.ts`（≈1,780）
→ 9g `asset-kinds` 拆 / `i18n` 清 / `prompt-sections` 文案段 / `bundled-engine`（B暂，前置=引擎链路真机验收）。

**9a / 9b / 9c-1~3 落地（2026-09-26）**：

- **9a**（`2262320b`）：`§4-15` 新 `plugins/service-plugins.ts`（14 条单一真源；loader 的
  `BUILTIN_PLUGINS` 与清单 `SERVICE_META` 双向派生，加/删内核 service 只改一处）·`§4-3`
  `ConfirmDialog` 102 行挪到 `app/ConfirmDialog.tsx`（内核共享原语，两处消费者 + 三处 host 桥改指）·
  `§4-6`/`§4-7` 账目登记（token-meter / acp 进平台白名单，带理由）⇒ 灰区 **84 → 79 文件**、
  平台白名单 111 → 119 文件；doc-facts 的 `builtin_service_plugins` 计数点随迁。
- **9b**（`bc8436ed`）：`§4-13 A` 第 14 个内核 service = `ui/lsp-client.ts` 的 `lspServicePlugin`
  （loader 装载 ⇒ 清单登记 + boot 审计 + 不可禁用）；**所有权模型显式变更**：LSP 服务改
  **进程级单例**（同链重名被 cordis reflect 拒——实测证据并入提交信息），工作区改在自身 fiber 上
  登记 `resetWorkspaceState()`「工作区级清态」（与旧的「服务随 fiber dispose」逐条等价）；
  自建第二个根 Context 删除；测试域在 setup.ts 复现「loader 已跑过」；清单计数 49 → **50**
  （14 内核 service + 36 产物）。
- **9c-1~3 拆分组三件**（2026-09-26）：`selection.ts` 193 → `paper-shell/selection.ts`（形状
  `PaperStrip`/`PaperStripSource` 上收 `paper/selection-contract.ts`）· `virtualize.ts` 155 →
  `paper-shell/virtualize.ts`（形状 `WorldRect`/`FlowGeom`/`PinnedGeom`/`RegionFlowGeom` 上收
  `paper/region-geom-contract.ts`）· `group.ts` 306 → `paper-shell/group.ts`（形状
  `UnitKind`/`WorkUnit` 上收 `paper/group-contract.ts`）——三件的桥面出口与 faceDeps 键同步撤除
  （291 → **279 键**：9c-1 -4 / 9c-2 -3 / 9c-3 -5），组件改直连包内；
  灰区 **79 → 78 文件 / 22,227 → 22,072 行**。
  **记账口径修正**：§2.5 原写「measure.ts 内核只用 1 个符号」不完整——`paper/ink.ts` 还要
  `inkSourcesFor`/`measureSignature`（墨迹走查与块级测高同一台引擎）⇒ **9c-4 的切法据此重画**：
  内核留「墨迹路径 + 实测回写账（`clearObservedHeightsForSession`）+ 它们用到的 token 子集」，
  随包走「块级测高 API + 镜像常量 + 卷首测高 + `injectPaperTokens`」。

### 6.1 批 4c 施工侦察（`coding.ts` 五族拆分，2026-09-24 实测，下一轮直接用）

**件**：`agent/tools/coding.ts` **998** + 随行私有件 `git-porcelain.ts` 126 · `sticky-cwd.ts` 138 ·
`session-context.ts` 122 · `tools/structured-error.ts` 24。

**包内形状**（导出面实测）：5 个族工厂 `createFsTools` / `createShellTools` / `createGitTools` /
`createAgentIsolationTools` / `createAskUserTools` + 聚合 `createCodingTools`；2 个执行器
`fsExecute` / `shellExecute`；3 个类型 `AskUserQuestionItem` / `AskUserRequest` / `CodingToolsUI`。
**出边**：`zod`（裸包，产物内联）· `composition/fs-service.ts` · `composition/seam-scope.ts` ·
`composition/shell-service.ts` · `agent/git-porcelain.ts` · `agent/session-context.ts` ·
`agent/tool.ts` · `agent/tools/define-tool.ts`。

**硬点（与批 3 同族：内核反向依赖，宿主→插件禁反）**——搬前必须先解这四条：
1. `agent/tool.ts` **值 re-export** `createCodingTools`（聚合工厂）——五族各归其包后，聚合
   只能在产品之间拼接 ⇒ 要么退役该聚合（消费方改指包内，`tests/parallel-subagent-bugs.test.ts` 一处），
   要么判它「内核 seam 面」；
2. `agent/runtime/agent-builder.ts` 用 `AskUserRequest` 类型（**类型面可上收为内核契约**，不算反向依赖）；
3. `composition/tool-rows.ts` 用 `CodingToolsUI` 类型（同上）；
4. `state/ask-store.ts` 用 `AskUserRequest` 类型（同上）。
⇒ **类型面（3 个 interface）建议上收内核**（`agent/tool.ts` 或 `composition/seam-scope.ts`），
值面（5 工厂 + 2 executor）按族进包；**executor 归属**需一次裁定（随族走 vs 留 seam 面——
`fsExecute`/`shellExecute` 被 `fs-seam`/`shell-seam`/`seam-composition`/`cross-seam-swap` 四个测试直连）。

**测试直连面**（9 处）：`coding-domain-plugins` · `define-tool` · `fs-seam` · `shell-seam` ·
`seam-composition` · `cross-seam-swap` · `tool-receipts` · `parallel-subagent-bugs` ·
`tests/bench/composition-assembly.bench.ts`。

**批 4c-1 落地（2026-09-24）与两项裁定**：
- ✅ **git 族已归家**（318 行移进 `git-domain/git-tools.ts`，包内宿主面桥 `defineTool`/
  `toInputJsonSchema` + `parseGitLogCommits`/`parseGitStatusPorcelain`）。`agent/git-porcelain.ts`
  **留内核**——它被 `agent/state-inject.ts` 消费（宿主→插件禁反），随批 6 state-hooks 搬。
- 裁定①**聚合工厂 `createCodingTools` 退役**（`coding.ts` 的聚合 + `agent/tool.ts` 的值 re-export
  一并撤）：五族各归其包后，内核再拼一次就等于内核 import 产物。测试改用新腰
  `tests/helpers/coding-tools.ts::buildCodingTools()`（各族搬走时只改该文件一行）。
- 裁定②**executor 随族走**：`fsExecute`/`shellExecute` 只是 fs/shell 两族自己的 dispatch
  （生产零第二消费者，只有 seam 测试当入口用）⇒ 搬族时一并进包，测试 import 改指包内。
- 余下三族（fs / shell / ask / agent-isolation）+ 随行件待下一轮；`ownerIdOf`/`ownerSeamView`
  两助手被 fs+shell 共用 ⇒ 搬这两族时须先上收（建议并入 `composition/seam-scope.ts`）。

**批 4c-2 落地（2026-09-24）**：`ask-domain/ask-tools.ts`（120）与
`agent-isolation-domain/isolation-tools.ts`（52）归家——两族只余 `defineTool`/`toInputJsonSchema`
平台面桥；`AskUserQuestionItem`/`AskUserRequest`/`CodingToolsUI` 三类型已先随批 4c 前置上收
`agent/tool.ts`（类型面不算反向依赖）。

**批 4c-3 落地（2026-09-24，本批收官）**：
- ✅ **fs/shell 两族归家**：`fs-domain/fs-tools.ts` **284**（11 工具：read/write/edit/list/glob/
  mkdir/move/rename/delete + `fsExecute`）· `shell-domain/shell-tools.ts` **172**（4 工具 + `shellExecute`
  + `withStickyCwd`）——两族定义逐字保留，只把内核依赖改走包内 `./host`。
- ✅ **`agent/tools/coding.ts` 整文件删除**（998 → 0）：五族全部归家，内核不再持有任何一族实现。
- ✅ **`ownerIdOf`/`ownerSeamView` 上收 `composition/seam-scope.ts`**（两族共用；该件保持叶性——
  零项目内运行时 import，守卫 `composition-import-cycle` 逐行钉住）。
- ✅ **faceDeps 面**：撤 `createFsTools`/`createShellTools` 两桥键，补 `ownerIdOf` · `ownerSeamView` ·
  `activeFsProviders` · `activeShellProviders` 四键（净 +2；`host-surface.baseline.json` 已重生成，
  指纹 `2a43fa3e` → `11a78f3d`）。两包宿主面翻面成「桥仍住内核的依赖面」——
  **包内符号不再经 `host.ts` 二次出口**（`createFsTools` 由 `index.ts` 直连 `./fs-tools`）。
- ✅ **空壳账销 2 条**：`fs-domain`/`shell-domain` 的 `impl` 从名册删除（红区 13 → 11 产物、
  27 → 25 文件、9,209 → 8,265 行；空壳集 11 → 9）。
- 测试面：8 个测试文件改指包内（`fs-seam`/`shell-seam`/`seam-composition`/`cross-seam-swap`/
  `tool-receipts`/`coding-domain-plugins`/`bench/composition-assembly`/腰 `helpers/coding-tools.ts`），
  断言零改动（只改 import 源）；两包产物 `entry.js` 2 KB → **539.7 / 536.9 KB**（真身 + 内联 zod，
  与同族 `git-domain` 541.9 KB 同形——**fs/shell 工具自此改产物即热更**）。
- 壳 bundle：`dist/assets/index-*.js` **3,706,995 B**（批 0a 后基线 3,838,924 B）——内核侧
  schema/编排真身随族段离场（余量含批 1–5a）。

每批收尾必做：`vitest` + `build`（含 `build:builtin-plugins`）+ `biome ci` + `verify:convergence` 双轨；
faceDeps 键集一变即须重生成 `src/plugins/host-surface.baseline.json` 并**重建一次 exe**。

### 6.2 批 6 施工侦察（2026-09-24 实测；施工单 = [`capability-impl-seam-design.md`](capability-impl-seam-design.md)）

**结论：批 6 四项不是「按域拆」型欠账——不能照搬批 4c 的 git mv。** 逐项证据（file:line）：

| 项 | 行数 | 内核侧耦合（实测） |
|---|---|---|
| plan | 572（进包 302 / 留内核 270） | `runtime.ts:555` 构造 `PlanStateManager`、`:612` ctx 回落；`agent.ts:703-709` 持 `_planState/_planInjector/_planGate`；`blueprint.ts:184-193`+`:366-378` 两条 capability 直接 new/调用；`subagent-spawn.ts:154` `planRegistry` |
| goal | 553 | `workspace.ts:19` + `chat-core.ts:19` `new GoalManager`；`agent.ts:69` 值导入 `runGoalImpl/resumeGoalImpl` |
| state-hooks | 670（进包 332 / 留内核 338） | `HookRegistry` 七处内核消费；`state-inject`+`cache-store` 被 `workspace.ts:17,30` 消费 |
| compaction | 2,022 | `agent.ts:41,56,57` 值导入三件；`agent-builder.ts:21` `createCompactionTools`；`ui/chat-stream.ts:9` 跨层常量 |

**硬约束**：plan 的两条 capability 就在 `firstPartyCapabilities()` 的固定位置上，而
「贡献序 = 注册序」「capability 表序 = 字节敏感面」（`capability-service.ts:29-30,128`）——
换注册来源 = 换位置 = convergence 快照漂移 ⇒ 须走 baseline-change-request 审批。

**已拍板路线（用户 2026-09-24 选 A）**：内核立「登记表」（`register/active/clearForTest`，照
`composition/*-service.ts` seam 范式），capability 条目**原位不动**，只把 install 体换成查表；
产物包 apply 期登记实现 ⇒ **表序零漂移、无需审批**。分类：plan/goal 判 `feature`（可禁用，缺实现
即静默少面）、state-hooks/compaction 判 `service`（缺实现启动审计 fail-loud）。

**审计路径（施工前逐条验过，勿省）**：convergence 基线含 `enter_plan_mode`/`exit_plan_mode`
（`baseline{,-minimal}/phase-1/tool-schemas.effective.json`）⇒ 装配路径必须真登记到实现；
`tests/helpers/composition-boot.ts` 是「生产最小集」定义处；`paper-interaction-handoff.test.ts:108-151`
按**路径**读 `plan-tools.ts`（搬文件同步改指）；新增出厂产物 ⇒ 名册 + 首方清单 + `factory-products.ts` 三处。

**批 6a 落地（2026-09-24，plan-mode）**：
- **进包 302 行** → `plugins/builtin/plan-mode/`：`plan-tools.ts`（两工具工厂）· `plan-injection.ts`
  （提醒注入器）· `plan-prompts.ts`（文案真源）+ `implementation.ts`（折成契约面的实现对象）+
  `index.ts`（apply 期登记，`inject: []`——**不贡献任何通道行**）+ `host.ts`/`host.aliased.ts`。
- **留内核 270 行**：`plan-state.ts`（runtime 物化的状态机）+ `plan-registry.ts`（强制层门禁 +
  子 Agent 只读克隆）——两条都是机制，且被 `agent.ts` / `subagent-spawn.ts` / loop 契约消费。
- **契约面上收**：新 `agent/plan/plan-contract.ts`（审批三类型 + `PlanReminderInjector` +
  `PlanModeImplementation`）——UI/kernel 五处改指它（`ui/message-model` · `paper/block-model` ·
  `app/paper/builtin-renderers` · `agent-types` · `runtime/agent-builder`）。
- **登记表**：新 `agent/plan/plan-impl.ts`（`register/active/clearForTest`，栈语义——disposer 回退到
  登记前的值，腰内瞬时 apply/dispose 不会抹掉常驻那版）。blueprint 的 `plan-tools` / `plan-injector`
  两条 capability **原位、原 id、原 phase**，只把 install 体换成查表（feature 语义：未登记即静默不装）。
- **登记面三处**：名册加 `plan-mode`（buildOrder 30，30→31 条）+ `firstPartyCapabilityPlugins()`
  收它（channel 腰与 `factory-products.ts` 同时吃到，一处登记两处生效）+ 计数快照三处更新
  （builtin-roster 30→31 · first-party-manifest 43→44 · plugin-loader 43→44）。
- **faceDeps**：+`registerPlanImplementation` +`EventKind`（`kernelReadFile` 早已在册）⇒ 指纹
  `11a78f3d → 1f16f24d`，baseline 重生成；新产物 `entry.js` 555 KB、`face.json` 4 键（保险丝 a 覆盖 31/31）。
- **测试面**：8 个测试文件改指/加登记（plan-outcome 改指包内；paper-interaction-handoff 路径改指；
  composition-boot 加插件；两个「组合值带出腰、装配在腰外」的用例 + convergence phase-1 spec 用新腰
  `tests/helpers/plan-mode-impl.ts::installPlanModeForTest()` 复现「装载器已装载」的常驻登记态）。
- **验收**：**convergence 双轨基线零改动**（表序零漂移的证据）；vitest / build / biome ci /
  doc-sync（`docs/facts.generated.md` 重生成：first_party_plugins 43→44）+ doc-check 全绿。
- **真机验收**（重建 `target/release/lantai.exe` + CDP）：faceDeps **236 键**（+2）、
  `registerPlanImplementation` 为 function、`EventKind` 在册；`/plugins/hologram/plan-mode/entry.js`
  555 KB 在场且页面内动态 import 成功（含 enter/exit_plan_mode 真身）；plan-mode 与 fs-domain 的
  `face.json` 均带当前指纹 `1f16f24d`（保险丝 a 已武装）。

**批 6b 落地（2026-09-24，goal-mode）**：
- **进包 317 行** → `plugins/builtin/goal-mode/goal-loop.ts`（循环本体整件移出，零逻辑改动）+
  `implementation.ts`（折成契约面）+ `index.ts`（apply 期登记，`inject: []`）+ host 双面。
- **留内核 236 行**：`goal-manager.ts`（记录/会话快照/持久化）——由 `workspace.ts:634` 与
  `app/chat/chat-core.ts:1069,1101,1308` 构造，搬它 = 造宿主→插件反向依赖。
- **契约面上收**：新 `agent/goal-contract.ts`（`GoalLoopHost` + `GoalRunResult` +
  `GoalModeImplementation`）；顺带删掉 `chat-agent-handle.ts` 里那份同形 `GoalRunResult`
  声明（单一真源）。
- **登记表**：新 `agent/goal-impl.ts`（与 plan 同款栈语义）。`Agent.runGoal/resumeGoal` 改查表，
  未登记返回**具名失败**（`GOAL_MODE_UNAVAILABLE`：「目标模式不可用：hologram/goal-mode 产物未装载
  或被禁用」）——feature 语义下的显式降解，不静默。
- **登记面两处**：名册加 `goal-mode`（buildOrder 31，31→32 条）+ `factory-products.ts` 直接列表
  （goal 不经任何通道）；计数快照三处 + `docs/facts.generated.md`（44→45）+ 文档两处（31→32）。
- **faceDeps**：+`registerGoalImplementation`（`errText`/`defineTool`/`EventKind` 已在册）⇒
  指纹 `1f16f24d → f84e6c5c`，baseline 重生成；新产物 `face.json` 4 键（保险丝 a 覆盖 32/32）。
- **测试面**：`tests/helpers/composition-boot.ts`（生产最小集）加插件——`goal-persistence.test.ts`
  的 11 处 `runGoal/resumeGoal` 因此零改动通过。
- **验收**：**convergence 双轨基线零改动**（goal 不经 capability/tool 通道 ⇒ 表序与工具面不动）；
  vitest / build / biome ci / doc-sync（`event-catalog` 随文件路径迁移重生成 + facts）/
  doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **237 键**（+1）、`registerGoalImplementation` 为 function；
  `/plugins/hologram/goal-mode/entry.js` 556 KB 在场且动态 import 成功（含 `goal_report` 真身与
  `MAX_GOAL_ITERATIONS` 常量）；goal-mode 的 `face.json` 带当前指纹 `f84e6c5c`。

**批 6c 落地（2026-09-24，state-hooks）**：
- **切分实测**：`agent/hooks.ts`（301）1–115 行 = 两接口 + `HookRegistry`/`PreflightHookRegistry`
  两类（**机制留内核**，七处内核消费：agent / context / events / runtime / subagent-spawn /
  agent-loop 契约 / composition/hook-service）；137–301 行 = 四工厂 + 构建输出解析器 **进包**
  （≈165 行）+ `hooks/board-tracking-hook.ts` 31 行 = **≈200 行进包 / 136 行留内核**；顺带删死常量
  `_MAX_STATE_BYTES`。
- **契约面 + 登记表**：新 `agent/state-hooks-contract.ts`（`StateHooksImplementation`）+
  `agent/state-hooks-impl.ts`；blueprint 的 `state-hooks` / `board-tracking-hook` 两条 capability
  **原位不动**、只换查表；`subagent-spawn.ts` 的子 Agent board hook 同改查表。
- **service 语义（与 plan/goal 两个 feature 相对）**：缺实现 = 装配期 **fail-loud**
  （`STATE_HOOKS_UNAVAILABLE`）——hook 管道是内核语义，禁用即装歪。
- **登记面**：名册加 state-hooks（buildOrder 32，32→33 条）+ `firstPartyCapabilityPlugins()`
  （channel 腰与 factory-products 一处登记两处生效）；计数快照三处 + facts（45→46）+ 文档（32→33）。
- **faceDeps**：+7 键（登记表 + `buildPreReadBlock` / `cacheBuildResult` / `formatDiagnostics` /
  `hasImageRefs` / `invalidateBlameEntry` / `refreshGitBlame`）⇒ 指纹 `f84e6c5c → 9eb85fdc`；
  新产物 `face.json` 7 键（保险丝 a 覆盖 33/33）。
- **fail-loud 的测试面代价（已付）**：六处装配点补常驻登记腰
  `tests/helpers/state-hooks-impl.ts`（blueprint / composition-capability-service /
  composition-session-count-profile / async-return-delivery / composition-wiring /
  composition-preset-assembly）+ convergence phase-1 spec；`agent-hooks.test.ts` 改指包内。
- **验收**：**convergence 双轨基线零改动**；vitest / build / biome ci / doc-sync / doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **244 键**（+7 全部为 function）；`/plugins/hologram/state-hooks/entry.js`
  7.3 KB 在场且动态 import 成功（含 `board-file-tracking` 真身）；state-hooks 的 `face.json` 7 键、
  指纹 `9eb85fdc`（保险丝 a 覆盖 33/33）。

**批 6d-2 落地（2026-09-24，压缩域搬进产物包；批 6 收官）**：
- **进包 1,773 行** → `plugins/builtin/compaction/`：`agent-compaction.ts`（1016，折叠状态机/触发
  判定/摘要管线调度）· `compaction-model.ts`（425，策略：经济参数/最优保留点/调优/报告/工具面）·
  `compaction-summarize.ts`（332，分块/机械摘要/prompt 构建）+ `implementation.ts` / `index.ts` /
  host 双面（166 行）。
- **留内核 414 行**：`agent/compaction-tracker.ts`（206，压缩账 + 卷级持久化）·
  `agent/compaction-contract.ts`（156，含新增 `CompactionConfig` / `SummaryCall` / `SummaryRun` /
  两个比例默认 / `CompactionImplementation` 16 项）· `agent/compaction-impl.ts`（52，登记表）。
- **16 个调用点改查表**：`Agent` 15 处 + `agent-builder` 的 `createCompactionTools`；
  service 语义 ⇒ 调用点 fail-loud（测试面 16 个文件补常驻登记腰 `tests/helpers/compaction-impl.ts`）。
- **faceDeps +19 键**（登记表 + 数据源/常量）⇒ 指纹 `9eb85fdc → 5a542fb9`；产物 `face.json` 24 键
  （保险丝 a 覆盖 34/34）。
- **测试面教训**：一度把常驻登记收进 `tests/setup.ts`（全局 setup）——**不可行**：setup 先于测试
  文件的 `vi.mock` 提升执行，预载 `rpc-contract` 等内核模块会架空 mock（实测 `plan-outcome` 等
  全线红）。正确形态 = 腰文件按文件显式 import（in-band，受同一套 hoisting 管辖）。
- **验收**：vitest 406 文件 / 4,309 用例全绿 · build + build:builtin-plugins（34 产物自包含）·
  biome ci 0/0 · **convergence 双轨基线零改动** · doc-sync + doc-check 全绿。
- **真机验收**（重建 exe + CDP）：faceDeps **263 键**（+19，抽验 7 键类型全对）；
  `/plugins/hologram/compaction/entry.js` 596 KB 在场且动态 import 成功（含
  `hologram_compaction_stats` 真身）；compaction 的 `face.json` 24 键带指纹 `5a542fb9`
  （保险丝 a 覆盖 34/34）。

## 7. 决策路由（**把「找」与「拍」分家**）

本账不是一次性审计——它的稳态形态是**一条常驻对账报告**（`plugin-home:report`，见 §5）：
每次运行吐三色清单——**红** = 已认领却不在包内（= §1/§2 欠账，搬一个销一条）；**灰** = 内核里
没有任何产物认领、也不在平台白名单（= 需要一次归属判定的残余）；**绿** = 平台白名单。
**灰区非空 = 「又有东西该拆」的告警**，此后不必再靠人肉「再验一轮」。

判定分三层，别混：

| 层 | 判据 | 谁定 |
|---|---|---|
| 强制层 vs 开放面 | 宪法第五条判据：「能不能被配置换成另一实现？」能 ⇒ 必须走开放面 | **Agent 自裁**（给理由，用户只否决异常项） |
| feature vs service（可否禁用）· 去留 · 批次成本 | 无判据可推，取决于产品意图 | **用户拍板** |
| 新增通道 / 开放面契约变更 | 有成本、改契约面 | **用户点头**（Agent 出方案与代价） |

§4 的 15 条按此路由收敛后，**真需要用户拍板的只有 8 条**。每条的证据已实地核过（2026-09-24）：

> **✅ 用户已拍板（2026-09-24）：8 条全按推荐**——§4-1 **A** · §4-5 **A** · §4-6 **B** · §4-7 **B** ·
> §4-9 **B** · §4-11 **B（暂）** · §4-12 **B** · §4-13 **A**。下表「推荐」列即**已生效裁定**，
> 施工时不再逐条复议；账目登记类（§4-6 / §4-7 / §4-12）随批 6 的账本更新一并落账。

| §4# | 问题 | 关键证据（已实测） | 推荐 | 代价 |
|---|---|---|---|---|
| 1 | 11 块会话流渲染器（1,020）是否产物化 | 现由内核 service 直接 `svc.register`；`requires` 机制**已存在**（`preset-assembly.ts:194` + `roster.ts:405`，缺插件则具名拒绝）；但内置 standard preset 是**零 patch 常量** | **A** 实现搬进新产物 `paper-renderers/`，该产物标**不可禁用**（沿用 service 语义）⇒ 归家 + 可热更，同时不引入「禁用即裸奔」 | 一批次 + faceDeps 指纹重生成 + 重建一次 exe |
| 5 | MessageBus / TaskBoard / DiscoveryBoard（1,309） | MessageBus 是 runtime 构造的会话级单例、**13 个测试直连**；三者只服务多 Agent 一族，且已在 capability 清单里 | **A** 判欠账，随多 Agent 协作域归家（批 7） | 动 runtime 装配面；测试导入面迁移 |
| 6 | token-meter（963）归属 | `SessionTokenMeter` 是 **Agent 私有账本**（`agent.ts:257` 每 Agent new 一个）+ `CLAUDE.md` 口径不变量；非 provider 型 seam | **B** 判**内核度量/审计面**留内核，但**登记分类**（消除「既非 service 又非 feature」的缺口） | 仅账目登记 |
| 7 | `agent/acp/**`（306）去留 | **不是死代码**：`docs/design/mcp-acp-protocol-support.md` 明确「三个标准角色」且状态「已实现」；当前生产零消费者（仅测试 + 类型 import） | **B** 与 `agent/mcp/**` 同族 ⇒ 判**协议面=平台**留内核，并把「当前零产线消费者」写明认领 | 仅账目认领 |
| 9 | 壳行贡献通道 `ctx.shellRows` | `composition/shell-rows.ts` 自述壳行=**纯 boot 时序、无 disposer 诉求**；11 行已可按 roster shell 域寻址禁用 | **B** 不立通道（维持既有分工），把「产物不得贡献 boot 期副作用」立成规则；`update-check` 27 行留内核 | 该类需求永久留内核 |
| 11 | 随包引擎（`bundled-engine.ts` 186）产物化 | 缺口三件（2026-09-24 复核）：**① 产物拿不到工作区生命周期**——现由 `workspace.ts:813` 以**工作区 fiber ctx** 调 `registerBundledEngineTools(ctx, root)`，插件无此 hook（结构性，与 §4-9 壳行通道同族）；② 产物拿不到 MCP 桥（`registerMcpServerTools`/`McpBridgeIO` 只在装载链内）；③ 声明静态——是①的推论。**不要扩 manifest 声明面**（会破坏「声明=可审数据 / 机器桥纯声明面」纪律） | **B（暂）**，解锁路径 = 补①一处「工作区生命周期 + scoped ctx」贡献面 + ②经 faceDeps 暴露 MCP 桥（第一方专用面）⇒ 运行期注册，无需给 manifest 加动态语义。**前置**：该链路真机从未跑通（`plans/README.md` 欠账表），先验收再定型 | 一处新契约面 + baseline 重生成 + 契约升版 + 重建 exe。**设计件 + 验收清单 = [`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)**（2026-09-24） |
| 12 | 用户级 `mcp.json`（142）第二通道 | **现行契约已 sanction**（`plugins/README.md:416-420`）；张力来自**已归档**计划的旧 Non-goals | **B** 承认并**登记为合法用户级配置面**（它不是「插件格式」） | 仅账目登记 |
| 13 | ~~游离 `ctx.lsp`（655）~~ | `LspService extends Service` + `super(ctx,'lsp')`；`lsp-client.ts:584` 自建**第二个根 Context**（绕过 `initCordisKernel()`）；不在 13 清单 ⇒ 不受「内核不可禁用」覆盖、不进 boot 审计 | **A** 纳入内核清单（13→14）由 loader 装载 + 去掉 fallback 根 Context | ✅ **批 9b 已落**（2026-09-26）：第 14 个内核 service = `ui/lsp-client.ts` 的 `lspServicePlugin`（loader 装载 + 清单登记 + boot 审计 + 不可禁用）；服务改**进程级单例**（同链重名会被 cordis reflect 拒——实测）、工作区改登记「工作区级清态」`resetWorkspaceState()`（与旧的「服务随 fiber dispose」逐条等价）；自建第二个根 Context 删除 |

其余 7 条（§4-2/3/4/8/10/14/15）Agent 自裁并在此记录理由，不占用用户决策额度：
§4-2 重查看器例外写进 `docs/plugins/README.md` §3（文档契约化）· §4-3 `ConfirmDialog` 判**内核共享原语**
（与 `app/dialog-focus.ts` 同族，物理挪位 + host 改指）· §4-4 `CommandPalette` 判内核（命令通道消费面）·
§4-8 `viewer-exts` 与 5 个 paper 文件随 §4-1 裁定联动重判 · §4-10 `asset-kinds` 判**注册表机制留内核、
kind 内容表随 asset-domain**（需一次拆分）· §4-14 `space-service` 判平台（依 canvas 设计件裁定）·
§4-15 「13 service 名双写」收成单一真源（loader 从清单派生，或反之）。

## 8. 口径与来源

- 总盘与逐文件行数：本页作者实测（物理行 = `(Get-Content).Count`），2026-09-24。
- `agent/**` 深审：110 文件 / 29,294 行，逐项给 file:line 证据（B 组 13 项）。
- `app/**`+`ui/**` 深审：73 文件 / 22,901 行；消费者判定基于全仓 import 图（931 文件 / 4,032 条边）；
  并实测「插件反向依赖内核 UI」19 个模块 ≈3,796 行（其中真欠账 ≈2,161，其余为合法平台桥）。
- `paper/**`+`state/**`+`provider/**`+`shell/**`+`lifecycle/**` 深审：逐文件消费者分布表。
- `composition/**`+`cordis/**`+`plugins/` 顶层+`src/` 顶层 深审：逐文件平台/产品判定 + 现有守卫清单与缺口。
- §0.1 的缺陷由本页作者独立复现（不是深审单方结论）：`loader.ts:573/578` 的无条件调用是代码级证据，
  bundle 命中是产物级证据；**唯一未做的是重跑 `npm run build` 后复查**（dist 与 HEAD 同日）。
- **未跑任何门禁**（四份审计皆只读盘点）——落地任一批次前先取测试基线。
