# 插件 bundle 退役 — 施工图纸（30 个出厂插件全产物化 + 双轨废除）

> 状态：**Proposed·Draft → 施工图纸 v2（2026-09-03 摸码升版，未开工；待丢编程 agent 执行）**
> 决策点（§4）已定案（2026-09-03 DSH cordis 调研）。本图纸是立案文档的执行版：现状确诊、步骤文件清单、每步验证。
> 背景/终态/决策点全文见立案版；本文以可施工为准。

## 0. 一句话施工目标

把 30 个出厂插件（7 seam 供应商 + 23 feature）从 bundle 编译态全部搬到产物态（真源随安装包、运行时装载、与外部插件同一通道），exe 只留装配台（装载链 + 10 注册表 + 4 平台运行时），装载顺序靠依赖图，boot 整树审计过才放会话。改插件 = 换产物，永不重编译 exe。

## 1. 现状确诊（2026-09-03 摸码）

### 1.1 双形态混合现状

| 形态 | 范围 | 真源位置 |
|---|---|---|
| bundle 编译态（坚定不移） | 14 内核（10 注册表 + 4 平台运行时） | `loader.ts BUILTIN_PLUGINS`（直接 import TS 源） |
| bundle-only（**本次要拆**） | 7 供应商（llm-adapters/subagent-in-process/fs-builtin/shell-builtin/sessions-builtin/graph-builtin/agent-loop-service） | `loader.ts` import（`../agent/fs-provider.ts` 等），无产物形态 |
| 真源产物（face 模式，合格） | UI 四面（canvas-nav/paper-shell/settings-domain/compose-dock）+ renderers | 源码在 `plugins/builtin/<dir>/`，esbuild 产物自包含经宿主桥取依赖 |
| **薄壳产物（不合格，要升级）** | 16 工具域 + 2 段贡献 | **真源仍留 bundle**：`host-modules.ts` 的 `toolDomains` / `segments`，产物只薄重导出。**改这些代码仍要重编译 exe**，违背本次目标 |

> ⚠ 薄壳不算实现了"改插件不重编译"。施工核心就是把 16+2 工具域/段 + 7 供应商的真源从 bundle 搬进产物。

### 1.2 关键资产（vendored cordis 内核语义已完备，不用造轮子）

- `src/cordis/fiber.ts`：`FiberState.PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED` 全在；fiber 依赖注入自动激活（依赖服务提供 → PENDING fiber `_refresh()` → ACTIVE）。
- `src/cordis/registry.ts`：`ctx.inject(deps, cb)`（依赖齐再跑、变化重跑）、插件对象 `inject` 字段。
- **缺的**：装载调度层。`loader.ts loadOne` 的 manifest.inject 是"一次性存在性检查，缺 = error 拒载"（types.ts:88 注释 WO-S0B 语义），不是 cordis 的"PENDING 挂起等待"。boot 无 settle/全 ACTIVE 审计/fail-loud。

### 1.3 现状文件地图

| 文件 | 角色 | 本次改动 |
|---|---|---|
| `src-ui/src/plugins/loader.ts`（~700 行） | 装载器：BUILTIN_PLUGINS 表 + loadBuiltinPlugins + loadExternalPlugins + loadOne（manifest 校验/inject 检查/权限/face 对拍/displace/import） | 大改：S4/S5 |
| `src-ui/src/plugins/builtin/host-modules.ts` | 宿主桥 faceDeps（内核给产物的面）+ mods（toolDomains/segments 薄壳真源） | S3 瘦身：toolDomains/segments 迁出；faceDeps 保留内核面 |
| `scripts/build-builtin-plugins.mjs` | 产物构建管线（esbuild → dist-plugins/builtin/hologram/，face.json 提取） | S2/S3：规格表扩 7+18；S5：删薄壳模式 |
| `src-ui/src/plugins/first-party-manifest.ts` | 44 插件身份清单（kind: service/feature） | S6：kind 降级展示分组 |
| `src-ui/src/plugins/types.ts` | PluginManifest schema（inject/permissions/displace 等） | S4：inject 语义改 PENDING；S6：三层源字段 |
| `src-ui/src/plugins/builtin/paper-shell/host.ts` + `host.aliased.ts` | 面组件宿主桥（satisfies 封蜡） | S5 配合瘦身 |
| `src-tauri/src/plugin_assets.rs` | Rust 资产通道（/plugins 白名单） | S5 白名单核对 |
| `main.ts` | 引导编排（loadBuiltinPlugins + loadExternalPlugins 接线） | S4 boot 审计接线 |

### 1.4 构建管线现状

- `dist-plugins/builtin/hologram/<dir>/`：manifest.json + entry.js（ESM 自包含）+ entry.css + face.json（增补四后）。
- `pluginSpecs()`：renderers（renderer-host 面、非位移）→ UI_FACES 四面（host 面、face: true）→ TOOL_DOMAINS 16 + SEGMENTS 2（thin 薄壳）。
- 资产通道：`src-tauri/src/plugin_assets.rs` 的 `is_builtin_plugin_path` 按 scope 路径白名单寻址。

## 2. 施工步骤

> 每步独立可验证（门禁全绿才进下一步，同一 commit 粒度）。编程 agent 逐 S 执行，S2-S5 每步一个 commit。

### S1 基线确认（无代码改动）

- 跑：`cd src-ui && npx vitest run`（等 `$env:NODE_ENV='test'`）、`npm run build`、`npx biome ci .`、`npm run verify:convergence`。全绿记录基线数字。
- 跑 `node scripts/build-builtin-plugins.mjs` 确认产物构建管线可复现。
- 确认 `tests/plugin-loader.test.ts`、`tests/first-party-manifest.test.ts`、`tests/face-keys.test.ts`、`tests/plugin-boundary.test.tsx` 覆盖面。
- **验收**：基线全绿数字记录在案（交付物 = 基线报告）。

### S2 七个供应商真源产物化（bundle-only → face 真源产物）

目标：7 供应商从"loader.ts import 的 bundle 插件"变成"plugins/builtin/<name>/ 自包含产物"。

- 在 `plugins/builtin/` 下建 7 个供应商目录，各含 `index.ts` + `manifest.json`：
  - llm-adapters（`plugins/llm-adapters-plugin.ts` 迁入 → builtin/llm-adapters/）
  - subagent-in-process（`agent/subagent-provider.ts`）
  - fs-builtin（`agent/fs-provider.ts`）
  - shell-builtin（`agent/shell-provider.ts`）
  - sessions-builtin（`agent/sessions-provider.ts`）
  - graph-builtin（`agent/graph-provider.ts`）
  - agent-loop-service（`agent/agent-loop/agent-loop-service.ts` 的 agentLoopServicePlugin）
- 产物形态要求：
  - 真源进产物（不是薄壳）；插件对象依赖宿主能力走宿主桥 `window.__lantai_plugin_host__.mods`（与 UI 四面同款；需要新增的宿主面加进 faceDeps 并同步 face.json 自动提取）。
  - manifest 声明 `inject`（依赖的内核注册表服务，如 fs-builtin inject ['fs']；llm-adapters inject ['llm'] 等——按插件对象现有 inject 字段写）。
  - manifest 不声明 displace（S5 拆 bundle 后无兜底可位移；先以新名字装载，S5 再切换登记）。
- `build-builtin-plugins.mjs`：pluginSpecs 扩 7 条（host 面 + face: true，复用 UI_FACES 路径）。
- loader.ts：S2 阶段**不动装载语义**，只把 7 个 bundle import 换走后先跑一遍全量测试确认不破（若入口迁移导致循环依赖问题，按 import 面逐个处理）。
- **验证**：构建产物成功；vitest 全绿（plugin-loader 测试允许先跳过 7 个新产物用例，S5 补）；手动确认产物经资产通道能装载（临时以外部插件身份装载成功）。
- **风险**：供应商对象可能深度 import 内核服务（如 fs-builtin 用 typedRpc、graph-builtin 用 engine transport）——自包含化时按宿主桥面补齐，不裸 import 内核模块。

### S3 薄壳 → 真源（16 工具域 + 2 段贡献）

目标：把 `host-modules.ts` 的 `toolDomains` / `segments` 真源搬进各自产物，宿主桥瘦身。

- 审每个工具域/段插件的实现体量与 import 面（`composition/first-party-tools.ts` 清单 + 域实现文件）：
  - 纯定义型（行表/注册动作，无内部状态）→ 真源直接迁进产物目录，依赖经宿主面带 ctx 服务读面（registry/服务真实例）；manifest.inject 补依赖（如 fs-domain inject ['fs']、prompt-segments inject ['prompts']）。
  - 有共生关系的（与内核共享模块级状态）→ 先拆状态归属再迁。
- faceDeps 扩容：供应商/工具域需要的宿主键（ctx 读面/服务真实例）逐个加进 `host-modules.ts` 的 faceDeps + `FaceBridgeSeal` 泛型（satisfies 封蜡：漏注册立刻 tsc 红）。
- `host-modules.ts` 删 `toolDomains` / `segments`；`pluginHostMods()` 只剩 faceDeps（+ 需要的运行时面）。
- build script：TOOL_DOMAINS/SEGMENTS 从 thin 模式改为 face 真源模式（去掉 mods 薄重导出逻辑）。
- **验证**：全量 vitest 绿（工具域/段测试改直连产物或走装载）；`verify:convergence` 绿（工具表序/贡献序不得漂移——**S1 表序字节契约**：产物重激活注册序必须与 bundle 序逐位一致，见 loader.ts:457 注释）；face.json 对拍检查。
- **风险**：贡献注册序漂移（DeepSeek 前缀缓存 + 组合快照依赖序）——产物装载顺序钉死为 BUILTIN_PLUGINS 表序映射，测试钉住。

### S4 装载调度层：依赖图 + settle + 全 ACTIVE 审计 + fail-loud

目标：从"表序同步装载 + 一次性 inject error"升级为"注册 + PENDING 等待 + settle 审计"。

- `types.ts` / `loader.ts loadOne`：manifest.inject 缺依赖 = **error 改为 PENDING 挂起**。实现路径：利用 vendored cordis 的 fiber inject 语义——插件对象 `inject` 字段已声明依赖，cordis fiber 自动等待；删掉 loader 层"一次性存在性检查拒载"，让 fiber 挂在树里等依赖服务 provide。外部插件 manifest.inject 翻译成插件对象 inject 合并进 `root.plugin(target)`。
- 加 boot 编排（main.ts / 新 `plugins/boot-gate.ts`）：
  - `bootLoading = 装载全部条目（S2/S3 产物 + 内核）→ 等所有 fiber settle（ACTIVE 或 FAILED；PENDING 且依赖永缺 = 超时判失败）`；
  - settle 后审计：全 ACTIVE 才 provide `bootGate` 服务；任一 FAILED/PENDING 超时 → **fail-loud**（明确报插件名 + 缺哪些服务 + 原始错误，启动不进会话）。
  - 会话层等待：创作坞/Agent 会话入口 inject `bootGate`（cordis `Loader.Intercept { await }` 检查代替等待语义，消费者零感知）。
- 保留失败隔离语义（单插件错误不放过但也不炸界面？**注意：fail-loud 与"失败隔离"的矛盾要定**——建议：bundle 域（内核）失败必 fail-loud；产物域失败按出厂插件必装先 fail-loud，后续迭代可降级为"降级为禁用 + visible"——**本次按 fail-loud 拍板，结果是插件错误可见且启动失败，符合"不带病运行"决策**）。
- **验证**：新测试覆盖：a) 依赖缺失 → PENDING 不报 error；b) 依赖后到 → 自动 ACTIVE；c) 依赖永不出现 → settle 审计 fail-loud 报缺名；d) 消费面（会话）在 bootGate 前不可用、之后可用。
- **风险**：PENDING 的 fiber 在 webview 环境有动态 import 时序问题（import 完成前依赖可能已提供）——按 cordis"PENDING fiber 可先注册后激活"语义处理，测试钉死。

### S5 bundle 双轨拆除（核心手术）

目标：BUILTIN_PLUGINS 从 44 减到 14 内核；bundle 兜底/位移/恢复逻辑全删；真源彻底离开 bundle。

- `loader.ts`：
  - `BUILTIN_PLUGINS` 只留 14 内核（composition-services/llm-adapters？**注意 llm-adapters 已在 S2 迁出**——最终内核 14 件见立案 §2.1，逐项核对）。
  - `loadBuiltinPlugins` 只装内核；删除 30 个 bundle import。
  - `builtinFibers`/`displacedBuiltin`/`restoreDisplacedBuiltin`/displace 分支整段删除（无 bundle 兜底可位移）。
  - `loadExternalPlugins` 的 builtinFirst 排序保留（表序契约），但 builtin 名单 = 30 个出厂产物的寻址序映射。
  - `installPluginHostBridge` 宿主桥面收窄（faceDeps 只留内核面 + S2/S3 新增面）。
- `first-party-manifest.ts`：kind 语义降级（展示分组标签），注释更新；"service = 禁了散架"作废。
- `plugin_assets.rs`：白名单核对（30 个 scope 路径），无变化则确认即可。
- `host.ts`/`host.aliased.ts` 四面：若面组件 import 了被删的 bundle 符号，改走 faceDeps 或产物内自持。
- 用户禁用语义：30 个出厂产物全部可禁用（plugin-prefs 对产物通道生效已有）；内核 14 件不提供禁用（现有语义保留）。
- **验证**：全量 vitest 绿；build 绿；biome 0/0；convergence 绿；`first-party-manifest.test.ts` 更新为"30 出厂产物清单 ↔ manifest 完备性"；`plugin-loader.test.ts` 改写（删 displace/兜底用例，补产物主路径用例）；**dev 模式**：vite dev 下 30 个出厂插件走源码热重载还是产物？——按决策 §4-4：dev 走源码路径（保留 BUILTIN_PLUGINS 全量的 dev-only 分支，q 由 `import.meta.env.DEV` 隔离），产物仅发布形态。**这是 S5 最容易踩的坑**：dev/prod 双份装载逻辑必须测试双覆盖。
- **风险**：
  - dev 源码路径与 prod 产物路径的行为漂移（测试必须两态都跑）；
  - 30 个插件真源搬出后，convergence baseline 快照漂移（按流程重新 record，审批见 AGENTS.md）；
  - 启动时序：14 内核同步装完 → 30 产物异步装载 → bootGate 审计——首帧 UI 与 Agent 会话之间的空窗，需要测试覆盖（mock 环境 + 真机）。

### S6 manifest/schema + 三层源 + 收尾

- `types.ts`：manifest 增三层源/优先级字段（patch 语义：安装包出厂 → 用户数据目录覆盖 → 外部插件），`roster.patch.ts` 接入覆盖裁定（对齐 DSH patch layer，见立案 §4-3）。
- 文档同步：`docs/plugins/README.md`（平台契约总览、装载解析优先级）、`AGENTS.md`/`CLAUDE.md` 插件面段、`CONVENTIONS.md` 如有引用。
- `docs/plans/plugin-bundle-retirement-plan.md` 本图纸归档标记竣工（进 docs/archive）。
- **验证**：全量门禁 + 真机验收（见 §4）。

## 3. 验证门禁（每 S 必过）

| 门禁 | 命令 |
|---|---|
| 前端逻辑 | `cd src-ui && npx vitest run`（**先 `$env:NODE_ENV='test'`**） |
| 前端构建 | `cd src-ui && npm run build` |
| 前端格式 | `cd src-ui && npx biome ci .`（0/0） |
| 组合层 | `cd src-ui && npm run verify:convergence` |
| 产物构建 | `node scripts/build-builtin-plugins.mjs` |
| 壳 | `cd src-tauri && cargo test`（plugin_assets 白名单改动时） |

## 4. 真机验收（S6 后，用户跑）

1. 改任一出厂插件视觉/逻辑（如 paper-shell 或 fs-domain）→ 重新构建产物 → 替换安装包产物 → 重启应用生效，**全程不重编译 exe**。
2. 冷启动：整棵树 settle + 全 ACTIVE 审计通过后才放开会话；无时序竞态。
3. 人为制造依赖缺失（删一个供应商产物）→ fail-loud 报错明确（插件名 + 缺服务），不白屏不带病。
4. 禁用任一 feature → 下次启动不装载、其余照常。
5. 三层源：用户数据目录产物覆盖安装包出厂产物生效。

## 5. 给执行 agent 的红旗（踩过/预估的坑）

- 薄壳 ≠ 真源：S3 不把真源搬走，目标就不成立——别被"现有产物能装"骗过去。
- 贡献注册序是字节契约（表序）：装载顺序任何改动前先看 loader.ts:457 注释 + 组合快照测试。
- vendored cordis 内核禁就地改（`src/cordis/` 目录纪律）——装载语义补丁打在 loader 层，不碰内核。
- `NODE_ENV=production` 环境坑：vitest/npm 命令一律先清变量。
- dev/prod 双态（S5）必须双覆盖测试，否则 dev 热重载假象掩盖 prod 断层。
- S2/S3 期间任何一步都不许先 commit 再补测试（AGENTS.md 铁律 3）。

## 6. 决策点定案速查（详见立案 §4）

① 装载时序 = 依赖图 + boot 审计（fail-loud，无人工 critical 分级）② 懒装载 = 废弃 ③ 三层源 = DSH patch layer 覆盖语义 ④ dev = 源码热重载、产物仅发布形态。