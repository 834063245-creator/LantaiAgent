# 兰台交接棒 13 —— ①b 行表收官（builtin 退役）+ A-2 hooks 通道：两批落地

> 2026-08-24 凌晨会话（续第 12 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton12.md（第 12 棒：S4-4 机器桥整批 + ①c）

## 0. 本棒干了什么

按 baton12 §2 工作序接手前两项，各自验证链全绿后提交：

1. **①b web + browser-desktop 迁移 ✅**（commit `c2197c75`，20 文件）：
   行表收官——builtin 工具行表全量迁毕退役。
   - **web 族**：familyContributions 无状态族（单工具行
     `plugin/hologram/web-domain/web_fetch`，B①/② 同款——只依赖
     codingExec，实例缓存语义等价）。
   - **browser-desktop 族**：**整组缓存行**
     `plugin/hologram/browser-desktop-domain/tools`（一行承载 53 工具，
     动态 import 原装配同款；不收 rowCtx → 实例缓存跨装配复用）。裁决
     理由：per-tool 名清单（53 名手抄）必漂移 + 名面被清单锁死（hologram
     动态面同款教训——新增 browser_/desktop_ 工具不自动进寻址域）；
     整族一行寻址恰是 minimal 禁整族的原使用形态。
   - **builtinToolRows() 退役**：factoryComposition().tools =
     pluginToolRows()（①b 后插件贡献行是 tools 域唯一行源）；tool-rows.ts
     保留行模型类型（BuiltinToolRow/ToolRowContext）。无通道环境 =
     空行表——**寻址 plugin 行的解析必须在 withFirstPartyToolChannel 腰内**
     （生产时序安全：loadBuiltinPlugins 同步先于 bootShell 组合链）。
   - **minimal preset**：寻址行改枚举 plugin 行（browser-desktop 整组行
     + web 单工具行）；diagnostics 序随表序（web 行居首）。
   - **装配序保住零漂移**：web/browser-desktop 前插
     firstPartyToolPlugins 清单首（迁移前行表序）——convergence 双 preset
     零漂移 + tool-contract 文档零变化（隐藏名清单序不变，无需再生成）。
   - **测试探针换代**（九文件 + convergence 两处）：composition 系测试
     寻址 plugin 行的解析全部移进通道腰（roster/presets/preset-assembly/
     hot-reload/patch-loader/wiring + discovery 探针 id）；tool-rows 测试
     退役行表自检（保装配语义钉面）；coding-domain-plugins 扩六族 +
     browser-desktop 整组行专测。preset-assembly 贡献代数测试用户层探针
     改 capabilities 域（裸 root 无域插件，tools 域无行可寻址）。
   - **convergence 修复**：helpers/preset-composition.ts 的
     resolveCurrentComposition 改异步 + minimal 路径包通道腰（phase-1
     effective 快照装载在腰外解析 plugin 行 → 未知 id throw——首轮红）。
2. **A-2 hooks/preflight 暴露面 ✅**（commit `96dd5234`，6 文件）：
   第七贡献通道 `ctx.hooks`（composition/hook-service.ts，prompt-service
   同款先例）——插件参与工具管道。
   - **HookContribution 两类**：`kind: 'enrich'`（Hook 形状零改写——
     post-tool 富化链）/ `kind: 'preflight'`（PreflightHook 形状零改写
     ——警告聚合 + HIGH 风险等级沿用架构门禁语义：无 _forceGate 拦截 +
     code_execution 嵌套打回）。
   - **装配折叠**在 runtime._assembleAgent（setHooks 之后按 kind 注册）：
     capability 钩子先、通道贡献随后——tools 域「builtin-先/贡献-后」
     同序约定。executor 直调与 eventBus 双路径自动生效（同一 registry，
     attach* 适配器天然覆盖）。
   - **裁决记录**（后续 A-3 参照）：贡献**不进 roster 寻址域**（四域行模型
     不含 hooks 域——无既定需求不做预防性扩展，工具/段的寻址是 S4-4 甲
     的专项）；子 Agent 不自动继承（spawnSubAgent 手工建 registry——
     graph-hooks 不下放的既有语义）；贡献实例跨装配复用（无 factory 面，
     插件自担实例状态性）。
   - BUILTIN_PLUGINS 挂 hooksServicePlugin（prompts 之后）；dispose 守卫式
     清空活动读取面（_activeHooks——vitest 同 worker 跨测试残留即静默
     串味，prompt-service 同款纪律）。

## 0.5 验证记录（两批各自全链）

- ①b：目标测试 117 例绿（两批 62+55）；convergence standard×2 +
  minimal 零漂移（minimal 首轮红 = phase-1 腰外解析，见 §0.1 修复）；
  tsc 零错；check:tool-contract 零变化；全量 161 文件 1610 passed /
  1 skipped / 0 failed（无假红）。
- A-2：hook-service 6 例（注册语义/守卫/无服务空集/装配折叠/拆卸后
  新装配不残留/executor 端到端 HIGH 门禁）；convergence 双 preset 零漂移
  （无贡献环境折叠为空集按构造）；tsc 零错；全量 162 文件 1616 passed /
  1 skipped / 0 failed。
- biome：两批改动文件 --write 归一（coding-domain-plugins.test 的 2 个
  noNonNullAssertion warning 是 ①c 存量，非本棒引入）。

## 1. 本机环境坑（沿袭 baton8-12 §1，全部继续有效 + 本棒新增）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位——跨工具传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑。
4. 多窗口还原——staging 前重新 `git status` 核对 + 关键编辑在位抽查
   （本棒两批提交前都做了，无还原事故）。
5. 改工具面 `npm run gen:tool-contract` 同 commit；改 RPC 面
   `node scripts/gen-rpc-contract-md.cjs` 同 commit（本棒装配序保住，
   tool-contract 文档零变化未触发）。
6. convergence record 是危险操作（CONVERGENCE_RECORD=1 用后必须
   git checkout 恢复；定位差异用 gate 报告对照）。
7. cordis root 的 asyncDispose 不级联 plugin fibers（测试断言插件
   fiber 清理链必须显式 fiber.dispose()）。
8. zod schema 常量 TDZ（子 schema 声明序）。
9. **JSDoc 里的 `*/` 字面量**：注释中写 `browser_*/desktop_*` 这类含
   `*/` 的文本会提前终结块注释（esbuild 报 Expected ";" 但 found "—"，
   报错行号在注释尾部之后——迷惑性大）。写法改为 `browser_ / desktop_
   前缀工具`。
10. **ids() 帮手收对象不报错**：`ids(factoryComposition())`（对象）过了
    编译但运行时 `rows.map is not a function`——12 处一次性错（应
    `ids(factoryComposition().tools)`）。T 泛型约束 `{ id: string }`
    对 ResolvedComposition 也成立（它有 id 字段吗？没有——但 TS 对对象
    字面量宽放行 + tsc 不报，直到运行时才炸）。教训：ids 类帮手只在
    确认数组时用。

## 2. 下一窗口的工作序（沿 baton12 §2，前两项已清）

1. **A-3 capability 贡献面**（设计件**过用户审批**后实施）：会话级能力
   的插件装载（⑤ 会话级能力批的前置）。设计要点（本棒 A-2 裁决可参照）：
   - blueprint capability 是「表序 = 装配序」的**字节敏感面**
     （phase-1 effective 快照守护）——设计必须回答「贡献 capability 的
     序如何确定」（tools 域是清单序；capability 的序 = 装配序 = 模型可见
     schema 序，贡献插到表尾/表头/锚定是设计题）。
   - capability 有 phase（context/agent）与 when() 条件——贡献形状须
     覆盖两阶段语义。
   - 寻址：capabilities 域已在 roster 寻址域（graph-hooks 可被 minimal
     禁用）——贡献 capability 是否同样可寻址（A-2 的「不进寻址域」裁决
     基于无需求；capability 域已有寻址面，贡献进域是自然延伸但需设计
     论证）。
   - 产出设计件（docs/plans/composition-architecture/designs/ 或
     agent-plugin-architecture-plan 内嵌）→ **用户审批 → 实施**。
2. **C11 两基建**（~4 天）：zod↔manifest 可序列化 + permissions.json
   接插件声明（拍板 #5：对外是目标，「我自己也是『一个用户』」自举论证）。
3. **C12 dsh-compat** 唯一合法挂起（DSH peer 出非 workspace 版本即启动）。

## 3. 环境与雷区备忘

- **并行窗口 agent/provider 线仍在途**（agent.ts / chat-agent-handle.ts /
  ModeIndicator / ModelSelector / SettingsPanel / SpineRack /
  model-selector.css / provider-settings.css / AddProviderSheet /
  ProviderDetail / ProviderList / ProviderPage / status.ts / selection.ts /
  thinking.ts / settings.ts / paper-store.test.ts /
  provider-page-staging.test / mode-indicator-model-menu.test.ts /
  CONTEXT.md / lantai-design-spec.md）——提交时继续排除，staging 前重新
  核对；他们跑 vitest 会造成 §1.3 假失败。
- ①b 后**无通道环境的 tools 域 = 空行表**：任何新增测试若要寻址工具行
  （resolveRoster/patch/preset），解析必须在 withFirstPartyToolChannel
  腰内做（写法参照 composition-presets.test / composition-wiring.test
  的腰内样本）。
- hooks 通道的既有消费面只覆盖主 Agent（executor + Agent 嵌套分发）；
  子 Agent 手工 registry 不折叠贡献（有意为之——若未来要下放，改
  spawnSubAgentImpl 的 subHooks 构造处）。
- 机器桥 DSH reconnect loop 同构重连监督仍是未决项（docs/plugins/README
  §9）；手动验收（engine.exe 靶子）留待真实插件场景。

## 4. 本棒提交清单

- `c2197c75` — refactor(composition): P4 ①b——web/browser-desktop 迁
  ctx.tools，builtin 行表退役（20 文件）
- `96dd5234` — feat(composition): P4 A-2——ctx.hooks 管道钩子贡献通道
  （6 文件）
