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
| `fs-domain`·`shell-domain`·`git-domain`·`ask-domain`·`agent-isolation-domain` | `agent/tools/coding.ts` **998**（**一文件载五族，须先按域拆**） | `git-porcelain.ts` 126 · `sticky-cwd.ts` 138 · `session-context.ts` 122 · `tools/structured-error.ts` 24 |
| `browser-desktop-domain` | `agent/tools/browser.ts` **912** | ✅ **批 4a 已归家**（桥位仅 5 运行时 + 1 类型） |
| `search-domain`·`web-domain` | `agent/tools/manifest-tools.ts` 187 | ✅ **批 4b 已归家**（按域拆两半：`search-domain/search-tools.ts` + `web-domain/web-tools.ts`；随行 `tools/search-assembly.ts` 169 随 search 走——**一个文件不能同时住两个包，故按域拆**） |
| `agent-domain` | `agent/tools/subagent.ts` 265 | — |
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
| `subagent-in-process` | `agent/subagent-spawn.ts` **543** | `agent.ts` 的值 re-export 桥（保一个测试的导入面）⇒ **并入批 7**（同族一次搬完） |
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
| 上下文压缩 | `agent-compaction.ts` 1051 + `compaction-model.ts` 644 + `compaction-summarize.ts` 327 = **2,022** | 新包 `compaction/` | Agent 类 host 模式（`as unknown as CompactionHost`）；`ui/chat-stream.ts` 直引跨层常量 |
| 多 Agent 通信族 | `message-bus.ts` 605 + `message-types.ts` 137 + `message-store.ts` 129 + `topology.ts` 80 + `tools/communication.ts` 159 + `tools/request.ts` 94 = **1,204** | 新包 `multiagent-comm/`（或并入 agent-domain） | MessageBus 是 runtime 级单例；**13 个测试直连** |
| 子代理运行时 | `coordinator.ts` 420 + `lifecycle-manager.ts` 217 + `tools/merge.ts` 215 + `subagent-activity.ts` 96 + `file-ownership.ts` 73 + `tools/merge-gate.ts` 55 + `isolation-queue.ts` 13 = **1,089** | `subagent-in-process/`（与 §1.2 同批实心化） | `SubAgentPool` 由 `workspace.ts` 构造；**21 个测试直连 coordinator** |
| token 计量（**分类缺口**） | `token-meter/**` 874 + `token-counter.ts` 89 = **963** | **待裁**：立 `ctx.tokenMeter` service 或判内核 | 既不在 13 个 service，也不是任何 feature 产物 |
| plan 模式五件 | `agent/plan/**` = **572** | 新包 `plan-mode/` | loop 契约类型直引 `PlanGate`；`agent.ts` 直引门禁 |
| goal 模式 | `goal-loop.ts` 317 + `goal-manager.ts` 236 = **553** | 新包 `goal-mode/` | GoalManager 由 `workspace.ts`/`chat-core.ts` 构造；goal-loop 是 Agent 类方法 |
| 附图与资产事件通道 | `request-images.ts` 259 + `tool-images.ts` 91 = **350** | 随 asset-domain（归属待裁） | 工具结果管道 vs 资产域功能 |
| state hooks 数据源 | `state-inject.ts` 231 + `cache-store.ts` 107 = **338** | 随 `state-hooks` 包（或判共享留内核） | `workspace.ts` 直调 |
| 第一方工具管道 hook | `hooks.ts` 301 + `hooks/` 31 = **332** | 新包 `state-hooks/` | `HookRegistry` 类=机制留内核；7 个测试直连 |
| ACP server（**疑似死代码**） | `agent/acp/` = **306** | 新包 `acp-server/` 或**退役** | 生产零消费者（唯一引用是类型 + 自身测试） |

### 2.4 UI 面 12 项 —— 10,402 行（`app/**`+`ui/**` 共 22,901 行的 45%）

| 项 | 路径（物理行） | 应去哪 | 通道 / 障碍 |
|---|---|---|---|
| 会话流块渲染器 11 kind + `'*'` 兜底 | `app/paper/builtin-renderers.tsx` **1,020** | 新产物 `paper-renderers/`（或并入 paper-shell） | `ctx.renderers`；现由**内核 service** 直接 `svc.register`，不经通道；注册序=字节契约 |
| mermaid 围栏渲染器 | `app/paper/mermaid-block.tsx` 312 + css 48 = **360** | 同上 | 重依赖动态分片，须与上项同批 |
| ask/权限卡架 | `PromptShelf.tsx` 776 + Host 30 + css 412 = **1,218** | 新产物 `ask-cards/` | `ctx.overlays` **需新槽**（现槽位闭集渲染在 PaperPanel 内部）；`chat-core` 持 ref 句柄 |
| 案卷首页 | `app/SessionsHome.tsx` **593** | 新产物 `sessions-home/` | `ctx.panels` 无「常驻」语义；顶栏与窗口壳件同体须切分 |
| 首页样式 | `app/foundation.css` 首页区段 **≈800** | 随上项进包 | 与全局 `body::before/after` 氛围层同文件交织，须逐段切 |
| ipynb 查看器 | `app/paper/viewers/ipynb.tsx` 516 + css 148 = **664** | `renderers/viewers/` 内联（撤 `heavy`） | 阻塞于「块渲染器归家」（它要复用 `MarkdownBody`） |
| markdown 独立查看器 | `markdown-doc.tsx` 263 + css 147 = **410** | 同上 | 同上 |
| 查看器装载面 | `app/paper/viewers/index.ts` **46** | 随上项收窄（仅 pdf/model3d 留白名单） | 与产物 `viewer-registry` 互为类型依赖（**内核 app 反向依赖产物包**） |

（另含 §2.1 的 settings 5,291 行——它在 `app/**` 内，但归属上属「包已有」那类。）

### 2.5 `paper/**` 里的产物私有件 —— 4,434 行

深审用全仓 import 图（931 文件 / 4,032 条边）实测：**`paper/**` 不是「一个产物的私有实现」，
也不是「全量平台基础」**，而是三层叠加：

| 层 | 文件（物理行） | 判定 |
|---|---|---|
| 契约层（2–4 个产物 + 内核共享） | `block-model.ts` 240 · `region-view.ts` 68 · `overlay-context.ts` 91 · `canvas-math.ts` 234 · `space.ts` 165 · `minimap-core.ts` 180 · `ink.ts` 374 | **留内核**（跨产物同实例/契约） |
| 判据层（有意上移的单一真源） | `asset-rack.ts` 46 · `plate-sign.ts` 38 | **留内核**（头注有案：宿主→插件方向禁反） |
| **产物私有排版引擎** | paper-shell 独占 5 件：`type-tokens.ts` **806** · ~~provenance 316 · sel-ink 138 · focus-flight 57 · sheet 36~~；compose-dock 独占 3 件：~~toc 275 · toc-ink 103 · ime 37~~ | **7 件已归家**（批 5a，962 行：paper-shell 4 + compose-dock 3）；余 `type-tokens.ts` |
| 拆分件 | `measure.ts` **2015**（内核只用 1 个符号 `clearObservedHeightsForSession`）· `group.ts` 306 · `virtualize.ts` 155 · `selection.ts` 193 | 类型/账本留内核，实现进 paper-shell |

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
| 15 | 13 service 名**双写** | `loader.ts` 的 `BUILTIN_PLUGINS` ↔ `first-party-manifest.ts` 的 `SERVICE_META` 两处手写、靠守护测试对拍 ⇒ 可收成单一真源 |

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

**常驻对账**：`npm --prefix src-ui run plugin-home:report`（`scripts/plugin-home-check.cjs`，
`--json` 机器可读）——三色清单：**红** = 名册 `impl` 仍在内核（逐产物逐文件列行数），
**绿** = 平台白名单 + 已被产物认领的共享面，**灰** = 无产物认领也不在白名单。
**2026-09-24 基线**（批 4b 后重测）：红 **16 产物 / 34 文件 / 13,665 行**（§1 的 14 条 +
§2.1 Provider 家族 8 件 + §2.5 的 `type-tokens`）；绿 111 平台 + 66 已认领；灰 133 文件 / 37,797 行。
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
| **4** | 大文件按域拆：`coding.ts` 五域 + `browser.ts` + `manifest-tools/search-assembly`（+ 三个域私有编排件） | ≈2,600 | 🟡 **4a 已落 `browser.ts`（912）· 4b 已落 `manifest-tools` 按域拆（187+169，search/web 各归其包）**；余 `coding.ts`（998，一文件载五族：fs/shell/git/ask/agent-isolation）与随行私有件（git-porcelain 126 · sticky-cwd 138 · session-context 122 · structured-error 24）。硬点：9+5+2 个测试直连 |
| **5** | paper 独占件随包：paper-shell 5 件 + compose-dock 3 件 | 1,765 | ✅ **批 5a 已落 7 件 / 962 行**（provenance 316 · sel-ink 138 · focus-flight 57 · sheet 36 · toc 275 · toc-ink 103 · ime 37；零内核消费者）；`type-tokens.ts` 806 行**复核后改期**——内核 `paper/measure.ts` 直接引用其 token 表（宿主→插件禁反），随批 9 拆分件一起搬 |
| **6** | agent/ 能力面新产品：plan-mode · compaction · state-hooks · goal | ≈3,485 | 通道现成；工作量在拆 loop 契约耦合与 host 模式 |
| **7** | 多 Agent 协作域：子代理运行时本体 + 通信族 + discovery | ≈2,293 | `ctx.subagents` seam 已在位；障碍是 runtime 单例与 21+13 个测试 |
| **8** | 渲染面整合：纸面渲染器归家（含 mermaid）+ ipynb/markdown-doc 内联 + 白名单收窄 + 解开内核↔产物类型环 | ≈2,500 | 依赖批 5/6 落地；同批消掉 hljs 两处内联 |
| **9** | 拆分件 + provider 控制台大块 + 常驻面（SessionsHome / PromptShelf）+ §2.6 内核产品件（`workspace.ts` / `settings.ts`） | ≈11,000 | 需先有通道（§4-3/4/9）与归属裁定（§4-1/5/6/11/12/13） |

**常驻对账（本账的稳态）**：批 0 里一并落 `plugin-home:report`（§5 三色清单）——
此后「还剩什么」由报告回答，本页只保留结论与批次表；**报告灰区非空即告警**，
不需要再安排「人肉再验一轮」。

**批 10（单独立项，2026-09-24）**：工作区接线贡献面 + 随包引擎产物化——
设计件与真机验收清单见 [`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)；
**先跑验收四条，再定稿施工**（该链路从未真机跑通）。

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

每批收尾必做：`vitest` + `build`（含 `build:builtin-plugins`）+ `biome ci` + `verify:convergence` 双轨；
faceDeps 键集一变即须重生成 `src/plugins/host-surface.baseline.json` 并**重建一次 exe**。

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

| §4# | 问题 | 关键证据（已实测） | 推荐 | 代价 |
|---|---|---|---|---|
| 1 | 11 块会话流渲染器（1,020）是否产物化 | 现由内核 service 直接 `svc.register`；`requires` 机制**已存在**（`preset-assembly.ts:194` + `roster.ts:405`，缺插件则具名拒绝）；但内置 standard preset 是**零 patch 常量** | **A** 实现搬进新产物 `paper-renderers/`，该产物标**不可禁用**（沿用 service 语义）⇒ 归家 + 可热更，同时不引入「禁用即裸奔」 | 一批次 + faceDeps 指纹重生成 + 重建一次 exe |
| 5 | MessageBus / TaskBoard / DiscoveryBoard（1,309） | MessageBus 是 runtime 构造的会话级单例、**13 个测试直连**；三者只服务多 Agent 一族，且已在 capability 清单里 | **A** 判欠账，随多 Agent 协作域归家（批 7） | 动 runtime 装配面；测试导入面迁移 |
| 6 | token-meter（963）归属 | `SessionTokenMeter` 是 **Agent 私有账本**（`agent.ts:257` 每 Agent new 一个）+ `CLAUDE.md` 口径不变量；非 provider 型 seam | **B** 判**内核度量/审计面**留内核，但**登记分类**（消除「既非 service 又非 feature」的缺口） | 仅账目登记 |
| 7 | `agent/acp/**`（306）去留 | **不是死代码**：`docs/design/mcp-acp-protocol-support.md` 明确「三个标准角色」且状态「已实现」；当前生产零消费者（仅测试 + 类型 import） | **B** 与 `agent/mcp/**` 同族 ⇒ 判**协议面=平台**留内核，并把「当前零产线消费者」写明认领 | 仅账目认领 |
| 9 | 壳行贡献通道 `ctx.shellRows` | `composition/shell-rows.ts` 自述壳行=**纯 boot 时序、无 disposer 诉求**；11 行已可按 roster shell 域寻址禁用 | **B** 不立通道（维持既有分工），把「产物不得贡献 boot 期副作用」立成规则；`update-check` 27 行留内核 | 该类需求永久留内核 |
| 11 | 随包引擎（`bundled-engine.ts` 186）产物化 | 缺口三件（2026-09-24 复核）：**① 产物拿不到工作区生命周期**——现由 `workspace.ts:813` 以**工作区 fiber ctx** 调 `registerBundledEngineTools(ctx, root)`，插件无此 hook（结构性，与 §4-9 壳行通道同族）；② 产物拿不到 MCP 桥（`registerMcpServerTools`/`McpBridgeIO` 只在装载链内）；③ 声明静态——是①的推论。**不要扩 manifest 声明面**（会破坏「声明=可审数据 / 机器桥纯声明面」纪律） | **B（暂）**，解锁路径 = 补①一处「工作区生命周期 + scoped ctx」贡献面 + ②经 faceDeps 暴露 MCP 桥（第一方专用面）⇒ 运行期注册，无需给 manifest 加动态语义。**前置**：该链路真机从未跑通（`plans/README.md` 欠账表），先验收再定型 | 一处新契约面 + baseline 重生成 + 契约升版 + 重建 exe。**设计件 + 验收清单 = [`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)**（2026-09-24） |
| 12 | 用户级 `mcp.json`（142）第二通道 | **现行契约已 sanction**（`plugins/README.md:416-420`）；张力来自**已归档**计划的旧 Non-goals | **B** 承认并**登记为合法用户级配置面**（它不是「插件格式」） | 仅账目登记 |
| 13 | 游离 `ctx.lsp`（655） | `LspService extends Service` + `super(ctx,'lsp')`；`lsp-client.ts:584` 自建**第二个根 Context**（绕过 `initCordisKernel()`）；不在 13 清单 ⇒ 不受「内核不可禁用」覆盖、不进 boot 审计 | **A** 纳入内核清单（13→14）由 loader 装载 + 去掉 fallback 根 Context | 小；须过 boot 审计与指纹 |

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
