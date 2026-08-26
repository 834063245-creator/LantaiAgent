# 兰台交接棒 15 —— B⑤ 会话级能力迁移收官 + B⑥ 标毕：P4 存量拆解全清

> 2026-08-24 凌晨会话（续第 14 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton14.md（第 14 棒：A-3 capability 通道 + C11 两基建）

## 0. 本棒干了什么

按 baton14 §2 工作序接手 B⑤（先行批 + 收官批单窗口合并落地，A-3 通道的
消费面兑现）+ B⑥ 标毕。**P4 计划的存量拆解（B①②④⑤⑥/①b/①c/S4-4）至此
全部清空**——出厂面（工具行 / prompt 段 / capability）三类行源全量经插件
通道贡献，builtin 出厂表三张全部退役。

1. **B⑤ 会话级能力迁移 ✅（十五项单批收官）**：
   - **定义留真源文件**：`agent/blueprint.ts` 的 `builtinCapabilities()` 改名
     `firstPartyCapabilities()`（B④ 同款终态——十五项定义零改写留在原文件，
     只是改名换装载方式）；`AgentBlueprint.standard()` 快捷方式退役（零
     生产调用方——缺省装配本就走 `fromRoster(composition.capabilities)`，
     S2-1 穿线零 runtime 改动；blueprint.ts 顺带甩掉对
     runtime/agent-builder 的值导入，blueprint ↔ roster 旧环变纯类型边）。
   - **新插件**：`plugins/capability-segments-plugin.ts`（B④
     prompt-segments-plugin 同款——装载 firstPartyCapabilities()，注册序 =
     清单序 = 迁移前出厂表序，converge-tools / code-execution-tool 双双
     install 期快照 visibleTools() 的表序依赖由清单序保住）。
   - **清单真源 + 装配腰**：`composition/first-party-capabilities.ts`
     （first-party-tools / first-party-prompts 同款两职责——
     `firstPartyCapabilityPlugins()` 供 loader BUILTIN_PLUGINS 表尾 +
     `withFirstPartyCapabilityChannel()` 供无引导环境（convergence 夹具 /
     gen-tool-contract）复现生产 capability 面）。
   - **roster**：factoryComposition 的 capabilities 域 =
     `activeCapabilityContributions()`（唯一行源；无通道环境 = 空表——
     B④ prompt 域注册面依赖同款语义）。
   - **capability-service 撞 builtin key 检查退役**：出厂表没了，第一方
     十五项本身经通道注册（生产装载序 = capabilitiesServicePlugin →
     capabilitySegmentsPlugin → 外部插件），撞第一方 key 由注册表重名拒绝
     承担（B④ prompt-service 同款终态）；A3 设计件补「B⑤ 收官修订」段
     入档。
   - **测试换代（baton14 预告的三件配套全落地）**：blueprint.test 表序断言
     换代钉通道面（通道快照 ≡ 清单序 ≡ 迁移前表序三重等价）；
     composition-wiring 不变式改钉新真源（「通道内
     factoryComposition().capabilities ≡ firstPartyCapabilities()」）；
     gen:tool-contract 叠 capability 通道腰（文档字节零变化实测）。此外
     全量换代寻址 capability key 的测试（minimal 的 graph-hooks、
     auto-tune 探针等——解析须在 capability 通道腰内，本文件 §2 纪律）。
   - **convergence 双 preset 零漂移实测**；tool-contract 文档零变化。
2. **B⑥ 标毕 ✅**：plan 表 B⑥ 行收官——外部插件钩子通道 A-2 既有 +
     第一方钩子件（graph-hooks / board-tracking-hook）随 B⑤ 迁通道，
     B⑥ 行剩余语义兑现，行毕。

### 0.1 本棒验证记录

- 定向批：8 文件 101 例全绿（blueprint / composition-capability-service /
  composition-roster / composition-wiring / composition-presets /
  composition-preset-assembly / composition-hot-reload / phase-6 spec）。
- convergence：standard + minimal 双 preset check 全过（零漂移——minimal
  初跑 2 例红是 fixtures 的 buildStandardRegistry 漏挂 capability 通道腰，
  修后双绿）。
- gen:tool-contract：再生成 41434 chars 与已提交文档逐字节全等（零变化）。
- tsc / biome：零错（runtime.ts 的 tb 未用变量警告是既有存量，非本批）。
- 全量 vitest：**165 文件 164 passed / 1 skipped / 0 failed（1637 passed +
  1 skipped）**——与 baton14 基线完全一致。
- 提交前 staging 复核见 §4（多窗口纪律）。

### 0.2 本棒重大环境事故复盘：NODE_ENV=production 渗入（§1 新增第 13 条）

全量 vitest 首跑 30 文件假红（两类症状：`act is not a function` 于全部
React act 测试；`No such built-in module: node:` 于全部 node:fs 导入的测试
文件——与我的 B⑤ 改动无关，用 HEAD 版测试文件复现依旧红）。根因：**本
窗口 shell 的 NODE_ENV=production**（Cowork/codely 进程链注入——User/
Machine 注册表与环境变量均无此值，纯进程内渗入；baton8 §1 第 1 条「NODE_ENV
渗入」的具象化变体）。React production 构建不导出 act；vitest 的 vite 管线
在生产模式下把 node:fs 外部化为浏览器模块。**修法：跑 vitest / npm test 前
`$env:NODE_ENV='test'`**（本棒全程已按此执行，全绿）。下一窗口跑测试前
先查 `$env:NODE_ENV`。

## 1. 本机环境坑（沿袭 baton8-14 §1，全部继续有效 + 本棒新增）

1-12 沿袭 baton14 §1（NODE_ENV 渗入 / TEMP 错位 / 并行 vitest 假失败 /
多窗口还原 / 工具面契约同 commit / convergence record 危险操作 / cordis
asyncDispose 不级联 / zod TDZ / JSDoc `*/` 字面量 / ids() 收对象 /
cordis ctx inject 纪律 / root asyncDispose 非清理面）。

13. **NODE_ENV=production 进程内渗入（本棒实锤）**：本机 Cowork/codely
    进程链给子 shell 注入 NODE_ENV=production——vitest 全量假红两症状
    （React act 缺失 + node:fs 不可用）。跑测试一律先
    `$env:NODE_ENV='test'`；排查此类「大面积突兀红」先跑
    `node -e "console.log(process.env.NODE_ENV)"`。

## 2. 下一窗口的工作序

**P4 存量拆解全清**——B①②④⑤⑥/①b/①c/S4-4/A-1/A-2/A-3/C11 全毕。
剩余：

1. **C12 dsh-compat** 唯一合法挂起（外部信号依赖：DSH peer 出非
   workspace 版本即启动——p4a 调研已备好契约地图）。
2. 计划外：多窗口并行 agent/provider 线仍在途（§3）——其收口由该窗口
   自行管理。
3. **新能力加面从此走通道**（本棒后的事实，非待办）：新工具族 →
   plugins/coding-domain-plugins.ts 加域插件（ctx.tools）；新 prompt 段 →
   composition/prompt-sections.ts 加段常量（经 promptSegmentsPlugin 自动
   装载）；新 capability → agent/blueprint.ts 的 firstPartyCapabilities()
   加行（经 capabilitySegmentsPlugin 自动装载，**表序断言在
   blueprint.test 必须显式改**——它是字节契约门禁）；外部插件三类面
   同理（见 docs/plugins/README.md §3）。

## 3. 环境与雷区备忘

- **并行窗口 agent/provider 线仍在途**（baton14 §3 同清单——agent.ts /
  chat-agent-handle.ts / ModeIndicator / ModelSelector / SettingsPanel /
  SpineRack / 各 css / AddProviderSheet / ProviderDetail / ProviderList /
  ProviderPage / status.ts / selection.ts / thinking.ts / settings.ts /
  paper-store.test / provider-page-staging.test / mode-indicator-model-menu.test /
  CONTEXT.md / lantai-design-spec.md + 两个未跟踪 plan 文档
  dynamic-edge-detection-plan.md / v11-analysis-engine-master-plan.md）——
  提交时继续排除，staging 前重新核对。
- **B⑤ 后测试纪律**：寻址 capability key（auto-tune / graph-hooks 等）的
  组合解析（resolveRoster / resolvePresetComposition /
  resolveCurrentComposition）须在 capability 通道在册环境——生产 =
  loadBuiltinPlugins 先于 bootShell 组合链（时序已核）；测试 =
  withFirstPartyCapabilityChannel 腰内（单独挂 capabilitiesServicePlugin
  的裸 root 不够——第一方 key 不在册，会「未知行 id」整体拒绝）。
- **测试自定义贡献 + 第一方面并存**：不能 withFirstPartyCapabilityChannel
  外再挂自己的 service（模块级活动服务指针会互相顶掉）——在同一 root 上
  依次 `root.plugin(capabilitiesServicePlugin)` +
  `root.plugin(capabilitySegmentsPlugin)` 再 register 贡献（本棒
  capability-service 测试的样板）。
- **blueprint.test 表序断言**：新增/挪动第一方 capability 必须显式改
  blueprint.test 的十五项清单（通道面钉序——phase-1 effective 快照的字节
  契约守护点）。
- **convergence fixtures**：buildStandardRegistry 现在挂双通道腰（工具 +
  capability）——minimal 的 preset 解析寻址 graph-hooks。

## 4. 本棒提交清单

- `3dca1925` — refactor(composition): P4 B⑤——十五项第一方 capability 迁
  ctx.capabilities，builtinCapabilities() 退役（含 B⑥ 标毕 + baton15 交接）

提交文件面（staging 复核清单——多窗口纪律）：
- src：agent/blueprint.ts（改名+退役 standard）、agent/runtime/runtime.ts
  （仅注释）、composition/{first-party-capabilities,capability-service,
  roster,presets}.ts、plugins/{loader,capability-segments-plugin}.ts
- scripts/gen-tool-contract-md.ts
- tests：blueprint / composition-{capability-service,roster,wiring,presets,
  preset-assembly,hot-reload} / convergence/{helpers/preset-composition,
  helpers/fixtures,specs/phase-6}
- docs：plugins/README.md、plans/agent-plugin-architecture-plan.md（B⑤/B⑥
  行）、plans/composition-architecture/designs/A3（收官修订段）、
  ARCHITECTURE.md §4.10、README.md、plans/lantai-handoff-baton15.md
- 排除（并行窗口在途）：§3 清单全部。
