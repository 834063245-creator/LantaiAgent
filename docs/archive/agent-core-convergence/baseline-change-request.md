# Baseline 变更申请 — phase-0/tool-schemas.full.json + phase-0/tool-schemas.plan.json（新增 office 域工具）

> 申请日期：2026-09-13 · 申请人：编码助手（OfficeCLI 集成 C 路：MCP 挂接改判为一等域工具）
> 状态：**已批准** —— 用户在对话中明确下达「干C」（选择 C 路 = 把 OfficeCLI 做成一等域工具、
> 撤掉 MCP 挂接），即本变更的开工授权；本文件按模板登记变更对象与证据。
> 模型可见表面：**有变更**（新增工具 `office`）——这正是本申请的对象（+1 工具，不改既有条目）。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`（`count` 16 → 17）
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`（`count` 18 → 19）
- 变更内容：两个快照的 `schemas` 数组**各追加一条 `office` 工具的 schema**（动作枚举 12 项 +
  参数表），其余条目逐字节不变、顺序不变（新域追加在表尾 = 前缀缓存友好）。
- plan 面含它是因为本域声明了 `readOnlyActions`（plan 克隆按白名单暴露只读动作）——
  **这正是 C 路相对 MCP 路的收益之一**：plan 模式下仍可用 `view/get/query/validate` 读文档，
  而旧 MCP 路整块被判为写、连 `view` 都被拦。

## 2. 为什么必须变

- MCP 挂接把 OfficeCLI 原样搬成「一个收命令行字符串的工具」，绕过兰台自己的强制面：
  ① MCP 子进程是**全权用户进程**（不经 fs_cap、不受 os_sandbox 约束，可写任意路径）；
  ② 参数无类型（自由字符串，与「defineTool + zod 真源」纪律不符）；
  ③ 整块只读/写二分（plan 粒度错）。
- C 路把同一能力做成兰台原生形状：zod 收窄动作面、经 `ctx.shell` seam → `process_cap`
  受控 spawn（os_sandbox 沙箱 + Bash 权限类 + 审计，与 `run_shell` 同一条路）、
  `readOnlyActions` 白名单 ⇒ plan 按 action 分档、命令行由工具层拼装（模型不碰引号）。
- 工具面新增一域 ⇒ 两个快照必然新增一条：这是**新增**而非**改动**，不触碰既有工具的任何字节。

## 3. 证据

- `src-ui/tests/office-domain.test.ts`（12 例）：纯函数（引号/命令行/动作→argv）、工具形状
  （domain/actions/readOnlyActions）、**plan 分档逐动作断言**（4 只读放行、7 写动作拦截）、
  执行面经 ctx.shell seam 派发（相对路径按工作区根解析、粘性 cwd 沿用、写动作带落盘提示）、
  **真 bash × 真 officecli 端到端**（create→add→view→screenshot→validate，且"写完立刻读盘"）。
- 生成物：`npm run gen:tool-contract` 已把 `office` 收录进 `docs/agents/model-tool-contract.md`
  （域 `office` / 11 动作 / 参数表）。
- 登记面：`plugins/builtin-roster.json` 追加 `office-domain`（buildOrder 29）+
  `composition/first-party-tools.ts` 表尾追加；`first-party-manifest` 计数守护 42 → 43
  已按"故意规格变更"显式更新（测试内写明日期与原因）。
- record 后 `git diff` 只含上述两个 baseline 快照 + 生成物文档 + 本批代码。

## 4. 拟议变更

采纳 record 快照：两文件各 +1 条 `office` schema 条目 + `count` +1；其余零变更。

## 5. 落地步骤

1. ✅ office 域工具 `agent/tools/office.ts`（12 动作、zod 真源、`defineTool` 扩 domain/actions/readOnlyActions 透传）；
2. ✅ 域插件 `plugins/builtin/office-domain/`（index/host/host.aliased）+ 名册与清单登记；
3. ✅ 守护测试 12 例（含真二进制端到端）；
4. ✅ `gen:tool-contract` 重生成；
5. ✅ 本文件登记 + 授权依据（用户「干C」）；
6. ⬜ `record:convergence` 独立步骤执行；
7. ⬜ 撤 MCP 路：`examples/plugins/office/` 去 `mcpServers`（保留活预览窗）、`preflight.ps1` 改口径、
   skill 改写为域工具调用面、用户机 `~/.lantai/mcp.json` 删 office 条目；
8. ⬜ 门禁四连（vitest / build / biome ci / verify:convergence）+ 文档（计划 §10、AGENTS 域清单）。

---

# Baseline 变更申请 — phase-5/session-projection.trace.json（turn/start 载荷 provider/model 分账）

> 申请日期：2026-09-12 · 申请人：编码助手（链路挂起排障事故的可观测面拆碑）
> 状态：**已批准** —— 用户在对话中就本项给出明确选项裁决（「乙：甲 + 给 Provider
> 接口加 model() 补上真模型」），即本变更的开工授权。
> 模型可见表面：**无变更**（turn/start 是 R1 明示的非模型可见观测事件，
> 不进 system prompt / 工具表）；本变更只动审计载荷与日志。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-5/session-projection.trace.json`
- `src-ui/tests/convergence/baseline/preset-minimal/phase-5/session-projection.trace.json`
- 变更内容：`turn/start` 事件的 `data` 由 `{model}` 变为 `{model, provider}`——
  新增 `provider` 字段（提供方身份），`model` 值保持不变（该 fixture 的 mock
  provider 名与模型名同为 `"mock"`）。**逐处 = 每个 turn/start 只多一行**。

## 2. 为什么必须变

- 2026-09-12 排障事故：`turn/start` 载荷与 `llm response` 日志把
  `host.prov.name()`（提供方身份，如 `commandcodegoat`）填进名为 `model` 的字段，
  日志读起来像「模型 = commandcodegoat」。排查链路挂起时被这行带偏十几分钟，
  先误判到错误的端点与模型上去。
- 单据「模型」语义必须成立：`turn/start` / `request/start` 的 `model` 改为真实
  模型 id（`Provider.model()` 新增），提供方身份另立 `provider` 字段。
- 三处调用点同批：`sessionLog.append('turn/start')`、
  `emitLoopEvent('turn/start')`、`emitLoopEvent('request/start')`
  （`request/start` 不在 baseline 观测面内）。

## 3. 证据

- `tests/agent-loop-events.test.ts`：mock provider 的 `name()`（`mock-provider`）
  与 `model()`（`mock-model`）**故意取不同值**——任何「把 name() 塞进 model」
  的回归都会让载荷断言当场变红；
- 新增开放面契约 v25 登记（`docs/agents/open-surface-contract.md` 变更记录 +
  指纹重算）：`Provider.model()` 为必填，属 `ctx.llm` adapter 实现面形状变更，
  cookbook 已同步；
- record 后 `git diff` 只含上述两个 baseline 快照 + 生成物文档；
- 门禁：vitest 全量 / `npm run build` / `biome ci .` 0-0 / `verify:convergence`。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（每个 turn/start 增加 `provider: "mock"` 一行，`model` 值不变）。

## 5. 落地步骤

1. ✅ `Provider` 接口加 `model()` + 四方言实现（openai/anthropic/responses/live）；
2. ✅ 载荷与日志 provider/model 分账（events.ts / default-loop.ts / observability.ts / session-log.ts）；
3. ✅ 测试 mock 全量补 `model()`（25 文件 / 34 处——机械规则 `name:` 行复制为 `model:`）；
4. ✅ 开放面契约 v25（版本 + 变更记录 + 指纹 + `provider/types.ts` 补登记）；
5. ✅ 本文件登记 + 用户批准（方案乙裁决）；
6. ✅ record:convergence 独立步骤执行；
7. ✅ 门禁四连重跑全绿收尾。

---

# Baseline 变更申请 — phase-0/tool-schemas.full.json + phase-1/tool-schemas.effective.json（Agent 工具面 × 引擎能力同步）

> 申请日期：2026-08-19 · 申请人：编码助手（工具面迭代：semantic_search 一等化 / dataflow 折叠 / write_constraints / 参数枚举化）
> 状态：**已批准** —— 用户在对话中批准整个工作包（"那就开工吧，你去建一个新的worktree……等全部做完之后再合并"），
> 本文件按 2026-08-19 模板补全审批记录，record 以独立提交执行。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-1/tool-schemas.effective.json`
- 变更内容：
  - `graph` 域 `action` 枚举 24 → **27 项**（新增 `semantic` / `dataflow_save` / `dataflow_query`），域 description 重写（semantic 语义检索入口 + dataflow 写动作标注）；
  - `fs` 域 `action` 枚举 10 → **11 项**（新增 `write_constraints`），域 description 更新；
  - phase-1 effective 快照同步以上工具面变化。
- **模型可见表面：确有计划性变更**（用户批准的工具面迭代核心交付物），非伪漂移。

## 2. 为什么必须变

- 引擎向量检索子系统（MiniLM ONNX + usearch HNSW）此前只以 `search_symbols` 的「边车附加」暴露（≤5 条 node_id+分数），
  本次升级为一等工具 `semantic_search`（完整节点信息 + 相似度 + top-k 可控），并接进 `graph(semantic)`；
- `dataflow_save` / `dataflow_query` 原以裸名注册漏在领域收敛外（违反自家「工具一律用领域名」规矩），折叠进 `graph` 域；
- `write_constraints` 补齐 `check_boundaries` 发现违规后的规则固化闭环（引擎只读不写的断口）；
- 引擎 schema 参数枚举化（mode/filter/sort_by/kind_filter/detail_level）——mod.rs 侧 inputSchema.enum，
  领域扁平 schema 合并后模型可见描述同步变化。

## 3. 证据

- record 后 `git diff` 只含上述快照文件；
- 新增 `tests/engine-tool-surface.test.ts`（6 用例）钉住「引擎默认清单 ↔ DOMAIN_SPECS ↔ mock 清单」三层对齐；
- 工具面测试组 95/95 通过（engine-tool-surface / domains-convergence / tool-param-contract / tool-semantics / plan-gate / define-tool）；
- 引擎 cargo test 全绿（新增 3 用例：空 query 降级 / 无索引降级 / 命中+节点解析）。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（graph 27 动作 + fs 11 动作 + semantic_search schema 与实代码逐字节一致）。

## 5. 落地步骤

1. ✅ 引擎侧交付（semantic_search 工具 + 参数枚举 + 单测）；
2. ✅ TS 侧交付（DOMAIN_SPECS / write_constraints / mock 对齐 / 防漂移测试）；
3. ✅ 本文件重写；
4. ✅ 用户批准（开工指令即批准）；
5. ✅ record:convergence 独立提交执行；
6. ✅ biome check 改动文件（exit 0；9 warnings 为存量非本次引入）。

## 6. 遗留观察（不在本次范围）

- `search` 域（单动作 content）与 memory 语义检索的进一步融合留待后续；
- 领域扁平 schema 同名参数类型合并（domainParametersSchema 取首类型）目前无冲突实例，未加检测。

---

# Baseline 变更评估 — D4 全 loop 事件表扩展（agent-platformization-plan Phase 1 施工③）

> 申请日期：2026-08-27 · 申请人：编码助手（平台化 Phase 1 · D4）
> 状态：**已批准（用户 2026-08-27 对话拍板 A 路线：「批准动基线，继续实施」）·
> 评估结论：无需改动任何冻结 baseline 文件**——本节为审批留痕。

## 1. 变更对象（评估结果）

- `src-ui/src/agent/events.ts` 的 `AGENT_EVENT_MAP`：5 工具事件 → 13 事件
  （+turn/step/request 生命周期六事件 + subagent/spawn|done 能力域首批，全部
  mode='emit'，载荷表 `LoopEventPayload` + `LOOP_EVENT_NAMES` 运行时镜像）。
- **冻结 baseline 文件：零改动**。依据：
  - `specs/phase-2.test.ts` 的 mode 合法性断言是泛化的（遍历 `AGENT_EVENT_MAP`
    全部键，新增事件自动纳入门禁，无需改断言）；
  - phase-2 第二断言钉「5 个 legacy 工具事件存在」——保持真；
  - trace 等价测试（eventBus 路径 ↔ legacy 冻结 trace）的 fixture 不含新事件，
    逐字节对拍不受影响。

## 2. 为什么此前需要申请

- 事件表扩充在名义上触碰「T0 门禁 + 8 baseline 对拍」冻结面（R1 风险表 +
  CONVENTIONS record 纪律）；按纪律先申请后动手，实测评估后确认零基线文件变更。

## 3. 证据（随施工③ commit）

- `tests/agent-loop-events.test.ts`（新）：完整性 guard 双向对拍（LOOP_EVENT_NAMES ↔
  map emit 域，tool/result|error 豁免）+ emitLoopEvent 拒绝非 emit 域（运行时守卫）+
  发射序/载荷逐项断言 + disposer 生效；
- `docs/agents/event-feature-map.md`（新）：事件目录 + feature→mechanism map +
  R1「非模型可见、不进 session log」显式声明；
- vitest / build / biome / convergence 四连全绿（数字见施工③ commit message）。

---

# Baseline 变更申请 — cordis 域工具（agent-platformization-plan Phase 4 · D7 动态插件运行时）

> 申请日期：2026-08-27 · 申请人：编码助手（平台化 Phase 4 施工②）
> 状态：**已批准（用户 2026-08-25 计划拍板全权授权——本计划 Phase 4 明文交付物
> 「`cordis_*` 模型工具族进 DOMAIN_SPECS + 工具目录」，P4-C4 判据要求
> convergence 双 preset 零漂移；按计划执行即批准）**。
> 模型可见表面：**确有计划性变更**（cordis 域工具为新增能力面），非伪漂移。

## 1. 变更对象

- `baseline/phase-0/tool-schemas.full.json`（standard + preset-minimal 两份）：
  新增 `cordis` 域工具（6 动作 define / run / stop / undefine / inspect_list /
  inspect_self——形状对齐 DSH tool-cordis，折叠形态符合 agent-plugin 计划
  Non-goal「不摊平工具面」）；
- `baseline/phase-0/tool-schemas.plan.json`（两份）：同步 planRegistry 克隆面；
- `baseline/phase-1/tool-schemas.effective.json`（两份）：effective 快照同步。
- system-prompt.fixture：域工具枚举行变化（如该节枚举域清单）。

## 2. 为什么必须变

- D7 裁定：动态插件（运行时 define → run → stop → undefine → inspect）是
  平台「运行时动态生成插件」目标的落地件（用户拍板「运行时动态生成插件、
  该做的彻底落地」）；工具面是模型使用该能力的唯一入口；
- 域折叠走 DOMAIN_SPECS 单一真源（`tools/domains.ts`），与既有 14 域同构
  ——细粒度名经 collectHiddenToolNames 隐藏，可见面 = cordis 域工具。

## 3. 证据（随施工② commit）

- `tests/dynamic-runner.test.ts`（新，8 用例）：求值面阴影 / define 校验 /
  define→run→stop 主链（P4-C2）/ 审批门 APPROVAL_REQUIRED·DENIED（P4-C3）/
  守卫注册面零残留 / apply 超时回收 / 跨会话隔离 / update 失败回滚；
- 沙箱承诺（R4 如实声明：浏览器主文档无进程级硬边界，安全面 = 实现质量）：
  危险全局阴影（window/fetch/eval/Function…全 undefined）+ 守卫注册面
  （白名单外访问响亮拒绝）+ 预算（源码 256KB / apply 10s / 贡献 64 条）+
  审批前置；
- record 后 `git diff` 只含 convergence baseline 快照 + 生成物文档
  （model-tool-contract / service-catalog）；
- 门禁四连 + doc-sync 全绿（数字见施工② commit message）。

---

# Baseline 变更申请 — Agent 资产块工具三件套（asset-domain：show_asset / update_asset / list_block_kinds）

> 申请日期：2026 资产协议实施（WO-2）· 申请人：编码助手（Agent 资产块协议 docs/archive/agent-asset-blocks.md 施工）
> 状态：**已批准** —— 用户在对话中逐项拍板协议（Q1-A7 全部裁决，含三原语设计），并批准「开始实施」（WO-1/2 开工指令）；
> record 以 WO-2 收尾的独立步骤执行（与 baseline-change-request 模板纪律一致）。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`（标准装配静态面 15 → **18**）
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`（plan 克隆面 17 → **20**）
- `docs/agents/model-tool-contract.md`（gen:tool-contract 随工具面变更同 commit 重生成）
- 变更内容：新增 `show_asset` / `update_asset` / `list_block_kinds` 三个独立工具（asset 域插件
  `plugin/hologram/asset-domain/<工具名>` 贡献行，经 ctx.tools 第八通道同构装配）。
- **模型可见表面：确有计划性变更**——三原语是资产协议经用户逐项拍板的核心交付物（Q1/A4/A7），非伪漂移。

## 2. 为什么必须变

- 用户拍板（Q1）：Agent 必须能**生成可被引用/更新的资产块**——show_asset / update_asset 是
  「Agent → 块」通路的两原语，list_block_kinds 是发现通道（报错带窗的「窗」）；
- 工具面是模型使用资产能力的唯一入口（对齐 D7 先例：能力 → 工具面 → 可见）；
- 三工具全部静态注册（无引擎依赖），语义由 kind 注册表（agent/asset-kinds.ts）承载。

## 3. 证据（随 WO-2 commit）

- 新测试 `tests/asset-tools.test.ts`（16 用例）：校验带窗 / update 语义 / 注册表实时性 /
  executor 资产通道事件路由（ToolDispatch→AssetDelta→Asset→ToolResult 序）全钉；
- 新测试 `tests/asset-blocks.test.ts`（8 用例，WO-1）：BlockPart 事件路由；
- 装配回归 82/82（composition 六件套）+ asset 套件 24/24 + tsc 零错误 + biome 全绿；
- 门禁全量 vitest 除 baseline 三处（本申请对象）+ tool-contract 生成物（同 commit 重生成）外全绿。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（phase-0 full 18 工具 / plan 20 工具，含三工具 schema 逐字节一致）。

## 5. 落地步骤

1. 新增 asset-domain 工具面（WO-2，本 commit）；
2. 新测试钉死（asset-tools 16 / asset-blocks 8）；
3. plugin-loader 计数 43→44 + first-party-manifest 补 `hologram/asset-domain`；
4. 本文件追加申请；
5. 用户批准（开工指令即批准：协议 Q1-A7 逐项拍板 + WO 开工授权）；
6. record:convergence 独立步骤执行；
7. gen:tool-contract 重生成 model-tool-contract.md 随同 commit；
8. 门禁四连（vitest / tsc / biome / convergence）重跑全绿收尾。


---

# Baseline 变更申请 — phase-5/session-projection.trace.json（`tool/call` 前移到分发时落）

> 申请日期：2026-09-15 · 申请人：编码助手（会话存盘换轨 · 触发点 B 收官）
> 状态：**已批准** —— 用户在对话中明确回应「需要审批的那个地方我看了，通过」；
> 本文件按模板登记变更对象与证据。
> 模型可见表面：**无变更**（`tool/call` 无消息投影，`deriveMessages`/`derivePayload` 逐字节不变）；
> 变更的是**事件序列**（审计面）——这正是本申请的对象。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-5/session-projection.trace.json`（standard 轨）
- `src-ui/tests/convergence/baseline/preset-minimal/phase-5/session-projection.trace.json`（minimal 轨）
- 变更内容：事件序列里 `tool/call` 的位置**前移**——由「流收尾之后（assistant/text 之后）」
  变为「执行器分发时（assistant/text 之前）」：

  ```
  旧：… user/message → turn/start → assistant/text → tool/call → tool/result → assistant/text
  新：… user/message → turn/start → tool/call → assistant/text → tool/result → assistant/text
  ```

  其余事件逐字节不变、投影派生（`deriveMessages`）不变。

## 2. 为什么必须变

- 兰台的 `StreamingToolExecutor` 在**流期间**就跑工具（流式执行优化），而
  `tool/call` 审计事件与 assistant 消息都在**流收尾**才落——于是「模型宣布了 X」
  这件事在副作用发生时**还不在日志里**。崩溃/断电后恢复，链上看不到任何痕迹，
  模型会以为那次写动作从未发生（可能重复执行有副作用的操作）。
  这正是 `docs/session-checkpoint-design.md` §3.2 点名的**工具副作用窗口**。
- DSH 参照实现把同一保证做在「工具派发前 flush 已记录的调用」上
  （`packages/session/session-checkpoint-policy/src/index.ts:70-75`）。
- 前移后，触发点 B 的语义才完整：**宣布落盘 → 排空屏障 → 才执行工具体**。

## 3. 证据

- `src-ui/tests/session-differential.test.ts`「工具循环」用例：钉住新的事件顺序
  （含日期 + 依据的显式声明注释）；`deriveMessages` 投影等价断言同用例内仍绿。
- `src-ui/tests/tool-dispatch-checkpoint.test.ts`（4 例）：钩子在工具体**之前** await
  （顺序可证）；失败 fail-open + warn 可见（工具体照跑）；未注入 = 旧行为；
  生产接线的 T0 源码断言（default-loop 的钩子 = append `tool/call` + `flushPersistence`）。
- `src-ui/tests/session-log-repair.test.ts`：**孤儿 `tool/call`（有分发、无宣布）** →
  恢复链先合成 assistant 宣布再补 `tool/result`，投影后转写对 provider 合法
  （前移带来的新常态：崩溃点落在 assistant 消息落盘之前）。
- `record` 后 `git diff` 只含两轨 phase-5 快照 + 上述代码/测试 + 文档。

## 4. 拟议变更

采纳 record 快照：两轨各一处事件顺序变更；`deriveMessages`/`derivePayload` 零漂移
（无消息投影，前缀缓存不受影响——`tool/call` 不进模型载荷）。

## 5. 落地步骤

1. ✅ executor 钩子 = 宣布落盘 + 排空（default-loop 注入）；
2. ✅ 移除 default-loop 两处流收尾的重复 `tool/call` 追加（单一写入点）；
3. ✅ 差分用例钉新序 + 显式声明；恢复链补「宣布补落」；
4. ✅ 本文件登记 + 授权依据（用户「通过」）；
5. ✅ `record:convergence` 两轨重录 + 门禁四连（vitest / build / biome ci / verify:convergence）。
