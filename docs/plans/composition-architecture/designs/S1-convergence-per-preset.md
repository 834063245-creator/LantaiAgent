# S1 设计件 — convergence 体系 per-preset 重设计（S1 开工首日交付物，预写于 2026-08-20）

> 状态：**已批准（2026-08-20）**——用户在对话中直接批准（"我直接批准，你来做好就行"，同时授权全程代理执行）；本件即 baseline 变更申请的预写稿，批准记录落此处。S1-0 起按 §3 批次序列推进，每批独立 commit、独立全绿，S1-2 起严格遵守 §2.4 零漂移规则。
> 性质：这是组合架构计划 R1（最大风险段）的拆弹设计。S1 的每一批施工都在本件划定的安全网内进行。

## 1. 问题陈述

现行 convergence 体系钉死「全局唯一装配」假设：

| 受影响 baseline | 钉住的契约 | S1 冲击点 |
|---|---|---|
| `phase-0/tool-schemas.full.json` | 标准注册表模型可见工具面（逐字节） | 工具行化改写装配来源 |
| `phase-0/tool-schemas.plan.json` | planRegistry 派生工具面 | 同上 |
| `phase-1/tool-schemas.effective.json` | effective 快照 | 同上 |
| `phase-0/system-prompt.fixture.json` | buildSystemPrompt 完整输出 | persona 拆 section 注册表 |

S1 要把装配来源从「`buildToolRegistry` 编译期硬编码」改为「roster 行管道」，且最终支持 per-preset 组合——若 baseline 维度不先建好，每批行化都会红门禁，工程无法推进。

## 2. 设计：preset 维度（加法，不动现有 8 快照）

### 2.1 定义

**Preset = 命名的行集合 + 组合序**。`standard` preset = 恰好等于今天的装配（内置行按现行表序、外部贡献为空集）。

### 2.2 baseline 布局（零迁移）

`baseline/phase-N/` **原地不动**——按定义它就是 `standard` preset 的快照。新 preset 的快照落 `baseline/preset-<name>/phase-N/`，产生自独立 freeze commit（沿用现行协议：`test(convergence): freeze preset-<name> phase-N baseline`，不夹带 src 改动）。

### 2.3 gate.mjs 扩展

- 新环境变量 `CONVERGENCE_PRESET`（缺省 `standard` = 现行行为，**不设变量时行为零变化**——这是回滚保证）
- specs 的装配 helper 增加显式 `contributions` 参数（行贡献列表）；`standard` → `[]`
- **确定性按构造保证，不按环境保证**（关键修正，替代 v1 计划「测试环境不装载外部插件天然安全」的侥幸表述）：specs 构造装配时显式传贡献集。测试环境装没装插件、用户机器上有什么，都不影响 gate 结果——贡献集是参数不是环境
- `record` 协议不变：`CONVERGENCE_RECORD=1` + change request + 人类批准

### 2.4 S1 批次推进规则（安全网本体）

每一批把一族工具从硬编码迁到行管道后，必须满足：

> **`CONVERGENCE_PRESET` 不设（= standard）跑 `verify:convergence`，三个 tool-schemas 快照逐字节零漂移。**

做不到零漂移的批次，说明它做的不是机械迁移而是行为变更——**停下，写 baseline change request，等人类审批**。这条规则把「S1 改坏工具面」的风险压缩到每批一次 diff 检查。

### 2.5 KV-cache 语义（写给插件文档的口径）

前缀缓存稳定性 = per-preset 确定性：同一 preset 每次装配产出相同表序 → 缓存命中语义与今天完全一致。切换 preset（或装卸外部插件）= 主动的缓存失效事件，属预期成本，写进 `docs/plugins/README.md`（S4 交付物）。

## 3. S1 批次序列（每批独立 commit、独立全绿）

| 批 | 内容 | 验收 |
|---|---|---|
| S1-0 | ✅ 完成（2026-08-20）纯基建：gate.mjs preset 维度 + specs `contributions` 参数 + `standard` 定义落地。**零行为变化** | 不设 `CONVERGENCE_PRESET` 全绿；设了 `=standard` 也全绿；两路径 diff 为空 —— 三条均实测通过（baseline 零触碰 + 新增 3 条 preset 机制自检：resolvePreset 路由/未知 preset 显式报错/contributions 生效与重名装载期拒绝） |
| S1-1 | ✅ 完成（2026-08-20）四 service 挂根 Context（commands/panels/tools/providers，注册 → disposer）；纯新增，内置装配不改读 | 全绿 + 新 service 各一条注册/卸载测试 —— 落地 `src/composition/services.ts`（ContributionRegistry 内核：id 寻址 + 一次性/陈旧性双守卫 disposer + 重名装载期拒绝 + 组合序=注册序；`compositionServicesPlugin` 经 loader 第一方表挂根，先于外部插件保证 inject 可解析）；10 条测试（挂载/inject 视角/disposer 契约/重名拒绝/陈旧守卫/组合序） |
| S1-2 | 内置工具分族迁行（fs → shell → git → search → graph/ops/lsp → agent → 其余），每族一批 | 每批 standard 快照零漂移（§2.4 规则）。**fs 批 ✅（2026-08-20）**：`createFsTools` 从 `createCodingTools` 机械迁出（定义零改写）+ 行表 `src/composition/tool-rows.ts`（行 id `builtin/fs`，表序=组合序）+ builder 行装配/按名去重（`createCodingTools` 保持完整面供直连测试，S1-3 全族迁完后去重退役）；4 条行表测试（id 稳定/行序=现行表序/无共享状态/真实装配无重名）；§2.4 快照零漂移实测通过（gate exit 0，baseline 零触碰）。**shell 批 ✅（2026-08-20）**：`createShellTools`（run_shell/bash_output/bash_kill/wait）同法迁出 + `builtin/shell` 行入表（builder 无需改动——行装配/去重是族无关的）+ 行序测试；§2.4 零漂移实测通过。**git 批 ✅（2026-08-20）**：`createGitTools`（13 工具，主段+Phase 2b 段按原声明序）同法迁出 + `builtin/git` 行入表 + 行序测试；§2.4 零漂移实测通过。**search 批 ✅（2026-08-20）**：`createSearchTools`（单工具 search_content）同法迁出 + `builtin/search` 行入表 + 行序测试；§2.4 零漂移实测通过。**（流程调整：应用户要求，后续剩余族迁完后统一跑全量门禁，不再逐族跑）**。**收尾批（web + agent-isolation + ask）✅（2026-08-20）**：`createWebTools`（web_fetch，含 Web Search 已禁用历史注释随迁）/ `createAgentIsolationTools`（worktree 隔离 5 工具）/ `createAskUserTools`（ask_user，ui 缺帐仍可注册——原行为保留）三族一次迁出，coding 面**全部迁完**；`builtin/web`、`builtin/agent-isolation`、`builtin/ask` 行入表（ToolRowContext 扩 ui 字段接 BuilderDeps.onAskUser）；统一门禁全绿（vitest 1330/1 + build + biome 零新增 + §2.4 零漂移 exit 0）——**S1-2 完成** |
| S1-3 | ✅ 完成（2026-08-20）`buildToolRegistry` 末端改读行表（含名字冲突装载期拒绝） | 剩余七族（hologram[dataflow 对]/skill/memory/task/agent/browser-desktop/wait）全部迁行——`ToolRowContext` 扩全依赖字段，行 factory 支持 async；装配末端收敛为「遍历行表 + read_file 别名 + 外部 mcpClients + converge」四级，createCodingTools 兜底退役；hologram helpers 迁 `agent/tools/hologram.ts`（机械迁出防循环依赖）；9 条行表测试（含冲突拒绝：贡献撞内置行名 → 装配期 duplicate throw）+ 统一门禁全绿（vitest 1330/1 + build + biome 零新增 + §2.4 零漂移 exit 0） |
| S1-4 | ✅ 完成（2026-08-20）system-prompt section 化（persona → section 注册表） | `src/composition/prompt-sections.ts`：13 段 section（id + applicable + render，render 产出含自身前导分隔符的完整文本，拼装 = 表序纯 concat）；两装配面（简短面 identity-brief/memory-brief/env-brief vs 完整面十段）经 applicable 互斥分流，env/memory 因两面位置不同各拆双 id；buildSystemPrompt 变签名兼容壳（组装机械迁 assembleSystemPrompt）；5 条注册表测试（表序/互斥分流/条件段/壳一致/简短面 trim 判空差异保留）；**`system-prompt.fixture.json` 零漂移实测通过**（首轮一处 \n 分隔符漂移被快照拦截后修正——零漂移门禁证明有效） |
| S1-5 | `DockPanelId` union → string + panel-def 运行时校验 + dock-store `Record<string, boolean>` | 全绿 + `panel.*` action id 不变对拍 |

批内门禁统一：`build + vitest + biome 零新增 + verify:convergence`。

## 4. 回滚

preset 维度是纯加法：`CONVERGENCE_PRESET` 不设 = 现行一切；任何一批出问题 revert 该批 commit，baseline 无需动（因为 standard 快照从未被允许漂移）。

## 5. 未决项（S1 开工时定）

- preset id 的运行时来源（workspace 级 or 会话级）——**S4 才需要真答案**，S1 期间只有 standard + 显式参数传入的测试 preset
- 行表数据文件格式（yml schema）——S2 设计件，S1 期间行在 TS 常量表中过渡

## 6. 审批

本设计件批准后，S1-0 即可开工（它是纯加法批次，风险最低）；S1-2 起每批遵守 §2.4 规则。
