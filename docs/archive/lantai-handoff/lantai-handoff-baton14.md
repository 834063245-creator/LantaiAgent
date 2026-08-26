# 兰台交接棒 14 —— A-3 capability 通道 + C11 两基建：三批落地

> 2026-08-24 凌晨会话（续第 13 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton13.md（第 13 棒：①b 行表收官 + A-2 hooks 通道）

## 0. 本棒干了什么

按 baton13 §2 工作序接手 A-3 + C11 两项，各自验证链全绿后提交；A-3 设计件
走**自查模式**（用户当窗口声明失去设计件审批能力——见 §0.2 流程变更）。

1. **A-3 capability 贡献面 ✅**（commit `869bf82c`，9 文件）：
   第八贡献通道 `ctx.capabilities`——会话级能力的插件装载（B⑤ 批前置）。
   - **形状零改写**：CapabilityContribution = AgentCapability 本体
     （phase/when/install 原样）——插件贡献与 builtin 十五项同一张
     blueprint 表竞争。
   - **表尾追加序**：`[...builtinCapabilities(), ...贡献]`——builtin 前缀
     不动，无贡献环境 keys ≡ builtin（零漂移按构造）；贡献序 = 注册序。
   - **贡献 key 进 capabilities 域寻址**（S4-4 甲同款快照收编）：patch/
     preset 可按 key disable 插件能力行——插件开关与能力粒度裁剪正交。
   - **三径装载期拒绝**（fail-fast）：撞注册表 key / 撞 builtin key /
     畸形形状（key 空 / phase 非法 / install 缺失——外部插件纯 JS 无
     tsc，不拦即潜伏到会话装配期 TypeError）。
   - **runtime 零改动**：`_assembleAgent` 既有
     `fromRoster(composition.capabilities)` 穿线消费整张表——S2-1「组合
     是值不是注册副作用」的直接兑现。
   - **第三条代数挂点**：onCapabilityContributionsChanged →
     preset-assembly cache 代数失效 + bootShell reapplyComposition。
   - 设计件 designs/A3-capability-contribution-channel.md（自查模式首件，
     六断言对照代码库验证 + 两缺陷修订入档）。
2. **C11-1 工具声明可序列化（zod↔manifest）✅**（本棒第二批）：
   manifest `tools` 声明式工具挂接——「第三方工具免编译挂载前提」落地。
   - **声明是数据**：manifest.tools 条目 = name/description/parameters
     （draft-7 JSON Schema，type:"object" 必填）/readOnly——DSH L1 契约
     同构三字段（p4a-dsh-contract-notes §1.1）。
   - **执行是映射**：entry 模块 `toolHandlers` 命名导出（工具名 → 函数）；
     loader 包装挂载（entry.apply 后）——插件不触碰 ctx.tools（信任面
     更小，装载期即知工具面）。
   - **双向桥**（plugins/tool-declarations.ts）：declarationToTool（数据
     声明 → Tool，零 zod）+ declarationOf（任意 Tool → 声明数据——
     defineTool 的 zod 工具经 toInputJsonSchema 天然同形，往返对拍测试
     钉住）+ mountToolDeclarations（挂接 + 一一对应校验）。
   - **声明与实现一一对应**（all-or-nothing）：缺 handler / handler 未
     声明 / 非函数 / 无 toolHandlers 导出 → 插件 error（失败隔离）。
   - 行 id `plugin/<插件名>/<工具名>`（S4-4 甲起可寻址）；实例缓存同
     无状态族；与 mcpServers 可并存（loader 包装层统一处理）。
   - **hello 示例换代四通道**：+ hello_status 声明通道（manifest 声明 +
     entry toolHandlers），与 hello_greet 代码通道并存演示双形态。
3. **C11-2 permissions.json 接插件声明 ✅**（本棒第三批）：
   装载期一票否决落地——「对外开放前的硬前提」清账。
   - **manifest.permissions**：枚举闭集 `read/edit/bash/git/web`（Rust
     权限咽喉五域的 lowercase 形态）——未知类拒绝（枚举闭集纪律）。
   - **plugins.json granted 段**：`{"disabled":[...], "granted":{...}}`
     ——loader 读授权态；声明类未全覆盖 → **blocked 状态**（不 import
     插件代码，missingPermissions 对设置面板可见——「待授权」徽章 +
     可抄写的 granted 片段提示）。
   - **无声明 = 零摩擦**：hello（纯 JS）不受影响；部分授予 → 仍 blocked
     （缺的部分可见）。
   - **Rust 集成 bug 顺手修**：plugin_set_enabled 原来整文件重写
     `{"disabled":[...]}` 会把 granted 段静默抹掉（授权被一次 UI 开关
     清空 = 安全回退）——改读改写保留全部顶层键（只动 disabled 段），
     roundtrip 测试钉住。
   - **三层安全叙事入档**（README §5）：①授予门禁（装载期，不授予 =
     代码不进进程）②声明面（安装期可审——诚实约束非强制约束）③逐调用
     强制（运行期——真正的强制层在 Rust 命令咽喉，Bash/Edit/Git/
     WebFetch 规则 + ask/auto/yolo 模式对插件工具照常逐调用生效，与声明
     与否无关）。已知边界如实列出：mcpServers 子进程不在闭集内；
     browser/desktop 命令域未接权限检查。

### 0.1 本棒验证记录

- A-3：新增 11 例钉面；convergence 双 preset 零漂移；tsc/biome 零错；
  tool-contract 文档零变化；全量 163 文件 1627 passed / 1 skipped。
- C11-1 + C11-2：新增/扩展 22 例（plugin-tool-declarations 7 例 +
  plugin-loader 扩 15 例）；tsc 零错；convergence 双 preset 零漂移；Rust
  roundtrip 测试 1 passed（granted 保留断言）；全量终态 165 文件
  1637 passed / 1 skipped / 0 failed（含并行窗口在途的
  mode-indicator-model-menu.test.ts 4 例）。
- 全量假红复盘见 §4.1（根因 = 冷导入计入 5s 超时预算；已修）。
- biome：改动文件 --write 归一。

### 0.2 流程变更：设计件审批 → agent 自查（本棒起）

用户 2026-08-24 原话：「我的人脑现在处理不了这种级别的设计件，我需要你
自查，我已经失去了审批能力了」。自此：

- **设计件不再等待用户批复**——agent 自查 = 对着代码库逐条验证承重断言
  + 主动找真实缺陷并修复/入档，然后在设计件批准栏记录自查结论（A-3 是
  首件范本）。
- 用户面只保留 3-5 行白话摘要（改什么/风险在哪）；重大信任类决策（开放
  面扩大等）仍用一句话白话确认。
- 账本已记 feedback 记忆；后续设计件沿用此模式。

## 1. 本机环境坑（沿袭 baton8-13 §1，全部继续有效 + 本棒新增）

1-10 沿袭 baton13 §1（NODE_ENV 渗入 / TEMP 错位 / 并行 vitest 假失败 /
多窗口还原 / 工具面契约同 commit / convergence record 危险操作 / cordis
asyncDispose 不级联 / zod TDZ / JSDoc `*/` 字面量 / ids() 收对象）。

11. **cordis ctx 属性注入纪律**：plugin 的 apply 里摸 `ctx.tools`（或任何
    service）必须先在插件对象上声明 `inject: ['tools']`——否则运行时
    "cannot get property ... without inject"。测试里手写插件对象别漏
    （mountToolDeclarations 的测试首跑即栽在这）。
12. **root[Symbol.asyncDispose] 不是清理面**：直接 ctx.effect 登记在 root
    上的 effect，`await root[Symbol.asyncDispose]?.()` 未必清（行为不可
    靠）；测试验证清理链时把 effect 挂进显式 fiber 再 `fiber.dispose()`
    （复刻装载器真实路径）。

## 2. 下一窗口的工作序

P4 计划的通道/基建面**全部清空**（A-1/A-2/A-3/B①②④/①b/①c/S4-4/C11
全毕）。剩余：

1. **B⑤ 会话级能力迁移**（A-3 通道的消费面，路线已在 A3 设计件 §2.8
   钉死）：
   - **先行批**：非工具五件（graph-hooks / board-tracking-hook /
     plan-injector / pre-run-hook / auto-tune——converge-tools 之后的
     表尾后缀）迁 ctx.capabilities——迁后落贡献表尾恰 = 原表位后缀，
     零漂移按构造。
   - **收官批（单批）**：工具注册十件（plan-tools…converge-tools——
     converge-tools 与 code-execution-tool 双双 install 期快照
     visibleTools()，序依赖锁死）整批迁入第一方 capability 插件（清单
     序 = 迁移前表序），builtinCapabilities() 退役（B④ 终态同款）。
   - 配套：blueprint.test 表序断言换代、gen:tool-contract 通道腰
     （withFirstPartyCapabilityChannel）、composition-wiring 不变式
     改钉新真源。
2. **B⑥ 收官判定**：A-2 已毕（外部插件钩子通道）——B⑥ 行的剩余语义
   （graph hooks/board tracking 第一方件随 B⑤ 先行批迁移）已在 B⑤ 覆盖，
   计划表 B⑥ 行可标毕（下一窗口顺手）。
3. **C12 dsh-compat** 唯一合法挂起（外部信号依赖：DSH peer 出非
   workspace 版本即启动——p4a 调研已备好契约地图）。
4. 计划外：多窗口并行 agent/provider 线仍在途（§3）。

## 3. 环境与雷区备忘

- **并行窗口 agent/provider 线仍在途**（baton13 §3 同清单——agent.ts /
  chat-agent-handle.ts / ModeIndicator / ModelSelector / SettingsPanel /
  SpineRack / 各 css / AddProviderSheet / ProviderDetail / ProviderList /
  ProviderPage / status.ts / selection.ts / thinking.ts / settings.ts /
  paper-store.test / provider-page-staging.test / mode-indicator-model-menu.test /
  CONTEXT.md / lantai-design-spec.md + 两个未跟踪 plan 文档
  dynamic-edge-detection-plan.md / v11-analysis-engine-master-plan.md）——
  提交时继续排除，staging 前重新核对。
- **A-3 后新增纪律**：无通道环境的 capabilities 域 ≡ builtin 表（贡献
  走表尾）——测试若寻址贡献 capability key，解析须在 capability 通道在
  册环境（CapabilitiesService 装载后）。
- **C11-1 后 hello 示例是四通道**：manifest.json 声明 hello_status +
  entry.js toolHandlers 导出——手改示例时两边必须同步（声明/实现一一
  对应校验会拦，但示例别带病）。
- **plugins.json 现在有两个段**：disabled + granted——任何写该文件的
  代码必须读改写保留 granted（plugin_set_enabled 已修；新增写入方照此
  纪律）。

## 4. 本棒提交清单

- `869bf82c` — feat(composition): P4 A-3——ctx.capabilities 会话级能力
  贡献通道（9 文件）
- `6536266f` — feat(plugins): P4 C11 两基建——工具声明可序列化 +
  permissions 接插件声明（15 文件，含测试超时基建修 + baton14 交接）

### 4.1 全量假红复盘（下一窗口防再踩）

全量 vitest 三轮假红（graph-engine-toggle 2 例 + hook-service 1 例超时）
——根因：**测试内冷导入巨型模块图计入 5s 默认测试超时**，套件组成变化
（本批 +1 测试文件、并行窗口 +1 未跟踪测试文件）改变 worker 分配 → 冷
导入负载击穿预算 → 超时用例泄漏 Workspace fiber → 下用例 lsp 服务双
注册连锁假红。产品代码零回归（两文件单跑恒绿 × 3、convergence 双 preset
零漂移）。修法 = 超时预算对齐 20s（graph-engine-toggle 两用例 +
hook-service 装配折叠用例，注释写明缘由）。**下一窗口写新测试若在测试
体内动态 import 大模块图，直接给 20s 预算**。
