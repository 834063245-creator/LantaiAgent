# 工作区接线贡献面（+ 随包引擎产物化作为第一消费者）· 最小设计件

> 状态：**Proposed·Draft（2026-09-24 立项，等真机验收结果定稿）**
> 缘起：[`plugin-extraction-inventory.md`](plugin-extraction-inventory.md) §7 第 11 条——
> 随包引擎（`plugins/bundled-engine.ts`，186 行）是内核里最后一处「非插件目录的产品接线」。
> 复核后判定：卡住它的**不是** MCP 声明面缺动态语义，而是两件更基础的事（§2）。
> 前置：该链路真机从未跑通（`plans/README.md` 欠账表），**先验收再定型**（§7 清单）。

## 1. 目标

1. 让**产物**能在「工作区激活点」接线（起常驻 MCP server / 注册工具行 / 挂 fiber effect），
   从而把随包引擎从内核装载链搬进 `plugins/builtin/bundled-engine/` 产物；
2. 保持两条既有纪律不动：**manifest 声明是纯数据面**（不给它加占位符/动态语义）、
   **MCP 机器桥对第三方仍是声明式**（运行期注册只对第一方产物开）；
3. 用户可感行为逐位不变：开关默认关（`lantai.bundledEngine.enabled`）、回执三态
   （wired / failed / off）、一进程一工作区根、离开工作区即停。

## 2. 现状事实（2026-09-24 实测，file:line）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 引擎注册在**工作区激活点**、以**工作区 fiber ctx** 为宿主，且**必须在注册表构建之前** | `workspace.ts:813` `registerBundledEngineTools(this._fiber.ctx, this.path)`；序契约注释在 `workspace.ts:796-797` |
| 2 | 工作区 fiber 是根内核上的 cordis scope（`initCordisKernel().plugin(workspaceScopePlugin)`），`ws.ctx` 即其 ctx | `workspace.ts:199` · `:180` |
| 3 | 生命周期归属天然正确：工具行挂 fiber ctx ⇒ 离开/切换即 `fiber.dispose()` 摘行 + 治理器杀进程树，**无额外清理代码** | `workspace.ts:799-804` · `:293` |
| 4 | 产物**拿不到工作区生命周期**：插件只在装载期拿一次 `apply(ctx)`；无「工作区开/关」hook | 全域 grep：`registerBundledEngineTools` 唯一调用方 = `workspace.ts:813` |
| 5 | 产物**拿不到 MCP 桥**：`registerMcpServerTools` 只在装载链内被调（loader / user-mcp / bundled-engine） | `loader.ts:936` · `user-mcp.ts:140` · `mcp-bridge.ts:693` |
| 6 | 桥的 IO 面很窄：`McpBridgeIO = { createProcIO, pluginDir }`——`pluginDir` 覆写是引擎绕开 `plugin_dir` RPC 的唯一手段 | `mcp-bridge.ts:70-81` · `bundled-engine.ts:137-143` |
| 7 | `ctx.space` **不是**这个面：它是画布空间 API（regions / focus / place / expand / collapse），与工作区（project root）生命周期无关 | `composition/space-service.ts:53-159` |
| 8 | manifest 的 `mcpServers` 是静态数据（name/transport/command/args/failurePolicy/readOnly/restart/lifecycle），**无占位符、无每工作区多实例语义** | `plugins/types.ts:43-93` |
| 9 | 第一方产物取内核能力已有专用面：`faceDeps`（封印 `FaceBridgeSeal` + `host-surface.baseline.json` 指纹守卫） | `plugins/builtin/host-modules.ts`（552 行）· `tests/host-surface-seal.test.ts` |

## 3. 为什么**不**扩 manifest 声明面（否掉的方案）

给 `mcpServers` 加 `${workspace.root}` 占位符 + `resolveFrom` + `scope: workspace` 看起来更省，
但代价是把「运行时逻辑」塞进「安装期可审的纯数据」里：占位符解析、每工作区多实例、
异根拒绝的语义都要在声明层表达。**机器桥的全部价值在于声明是数据**（`docs/plugins/README.md`
§2/§3：纯声明面、安装前可审）。动态能力应该走**代码面**（第一方产物），不是把数据面撑成小语言。

## 4. 设计

### 4.1 部件一：工作区接线贡献面（新通道，公开）✅ **已落（2026-09-26）**

> 落地：`composition/workspaces-service.ts`（`ctx.workspaces`，内核第 17 个 service）；激活点 = `workspace.ts`
> 组合快照之前；守卫 = `tests/host-lifecycle-channels.test.ts`（串行 / 失败隔离 / disposer / 无服务=空面）。
> 契约 **v52 → v53**（与部件三同一次升版）；内核 service 16 → 18、第一方清单 54 → 56。

```ts
// 产物 apply(ctx) 内（一次性登记；每次工作区激活按注册序回调）
ctx.effect(
  () =>
    ctx.workspaces.onActivate(async (scope) => {
      // scope.root       —— 工作区根（绝对路径）
      // scope.ctx        —— 该工作区的 fiber ctx：工具行/effect 挂它的都随 fiber dispose 自动摘
      // scope.report(r)  —— 接线回执（通用；转状态栏 + 诊断面，不落贡献者自己的 store）
      await mountMyStuff(scope);
    }),
  'acme/workspace-hook',
);
```

**语义（逐条可测）**

| 面 | 规定 |
|---|---|
| 调用时机 | 工作区激活点，**`_buildRegistryLocked` 之前**（序契约不变：工具行必须先于注册表构建，否则首装配看不到）；切换工作区 = 旧 fiber dispose → 新工作区重新回调 |
| 调用序 | 多贡献者按**注册序串行 await**（与壳行同纪律），前一个抛错不影响后一个 |
| 失败隔离 | 贡献抛错/超时**不得阻断工作区打开**（现语义保持），错误经 `scope.report` + 诊断面**具名可见**（错误不静默） |
| 生命周期 | 登记者经 `ctx.effect` 登记；工作区侧挂 `scope.ctx` 的一切随 `fiber.dispose()` 回收，**贡献者不需要写 teardown** |
| 子 Agent | 不自动继承（与本仓 hooks/capabilities 同款语义） |
| 缺服务 | 无通道环境（测试/工具环境）= 空贡献面，工作区激活路径零行为变更 |

**推荐命名**：`ctx.workspaces`（服务名 `workspaces`）。备选 `ctx.workspace`——单数读起来像「取当前工作区」，
而本面是**贡献面**不是查询面；当前工作区查询已有 `workspace-scope.ts` / `app/shell-store`。

### 4.2 部件二：MCP 桥对第一方产物可见（推荐 faceDeps，不新开公开面）✅ **已落（2026-09-26）**

> 落地：`host-modules.faceDeps` +4 键（`registerMcpServerTools` / `waitWithin` / `ASSEMBLY_READY_WAIT_MS` /
> `createTauriProcIO`）——宿主面 327 → **331**（指纹 `3a333622`）；第三方面零变化（仍只有
> `manifest.mcpServers` 声明面）。

| 方案 | 形态 | 取舍 |
|---|---|---|
| **A（推荐）** | `host-modules.ts` 的 faceDeps 加 `registerMcpServerTools`（需要时加默认 IO 工厂）；产物经 `host.ts`（dev/测试）/`host.aliased.ts`（产物域）取用 | 零新公开通道；第三方面零变化（仍只有 `manifest.mcpServers` 声明面）；契约载体 = `host-surface.baseline.json`（已有封印 + 指纹守卫） |
| B | 新 ctx 服务 `ctx.mcp.mount({ owner, decls, io })` | 第三方也能运行期挂 server ⇒ 削弱「声明=可审数据」；文档/契约面扩大。**不建议** |

### 4.3 第一消费者：`plugins/builtin/bundled-engine/`（产物化）✅ **已落（2026-09-26）**

> 落地（含**口径更正**）：`plugins/bundled-engine.ts` 292 行按「接线 vs 平台面」切开——**接线**
> （`bundledEngineDecl` + `registerBundledEngineTools`，约 190 行）随 `plugins/builtin/bundled-engine/`
> （`wiring.ts` + `index.ts`：经 `ctx.workspaces.onActivate` 复现 `workspace.ts` 原内联接线与三态回执）；
> **探测 + 开关**（`probeBundledEngine` / `isBundledEngineEnabled` / `setBundledEngineEnabled` /
> `onBundledEnginePrefChanged`，约 100 行）留内核 `plugins/bundled-engine-prefs.ts`——设置面板是**另一产物**
> 且其取用面经 faceDeps，随包会让设置页跨产物取用（本仓无此通道）。内核 `workspace.ts` 的内联接线删除。
> 名册 38 → **39**（`feature`，可禁用 = 引擎天然 kill switch）；清单 56 → **57**；内核 service 18 不变。

- 搬 `plugins/bundled-engine.ts`（186 行：探测 + 声明构造 + 开关 + 回执订阅）进包；
- 包内 `index.ts` 用 `ctx.workspaces.onActivate` 复现今日 `workspace.ts:813` 的行为（含三态回执）；
- 删内核接线（`workspace.ts` 的 import + 调用点 + `plugins/bundled-engine.ts`）；
- 名册加条目（30 → 31），`first-party-manifest` / `builtin-roster` 守卫自动覆盖；类别建议 `feature`
  （可禁用——开关之外多一层天然 kill switch）。

## 5. 要动的契约面与守卫

| 对象 | 动作 |
|---|---|
| `composition/contract-version.ts` | `OPEN_SURFACE_CONTRACT_FILES` 增登记新通道文件；`OPEN_SURFACE_CONTRACT_VERSION` 47 → 48 |
| `docs/agents/open-surface-contract.md` | 记录版本变更 + 新通道语义（守护测试红着就是没改完） |
| `src/plugins/host-surface.baseline.json` | faceDeps 键集变化 ⇒ 同 commit 重生成 |
| `docs/plugins/README.md` | §3 加「ctx.workspaces」通道段；§2/§3 明确「运行期 MCP 注册只对第一方产物（经宿主桥）」 |
| 新增守护测试 | 面存在 + 注册序串行 + 失败不阻断工作区打开 + fiber dispose 摘行 + 引擎产物装载后行 id = `plugin/bundled-engine/mcp/hologram` |
| 门禁 | `vitest` + `build`（含 `build:builtin-plugins`）+ `biome ci` + `verify:convergence` 双轨 + **重建一次 exe** |

## 6. 批次

| 批 | 内容 | 交付判据 |
|---|---|---|
| 1 | 部件一（通道 + 守卫 + 文档） | 工作区激活路径零行为变更（无贡献者时）；新守卫全绿 |
| 2 ✅ **已落**（2026-09-26） | 部件二（faceDeps 暴露 +4 键）+ 引擎接线产物化（探测/开关留内核） | ✅ 名册 **39 条**；真机四条验收**全通**（见 §7 与账本 §6.5：开关面/回执/进程挂 lantai/离开即停） |
| 3 | 真机验收（§7）+ 文档收尾（`ARCHITECTURE.md` 引擎段 / 插件指南） | 四条验收全勾 |

## 7. 真机验收清单（**先跑这个，再定稿设计**）

打包态跑（随包探测只在 exe 里成立）；若 exe 早于最近改动，先 `build.cmd` 重建一次。

| # | 步骤 | 观察 | 结果 |
|---|---|---|---|
| 1 | 设置面板找到「随包图谱引擎」开关并拨开 → 重开工作区 | 有无回执；无回执时报文是否可读 | ✅ **通过**（2026-09-25 重建 exe 实机）：开关已在场且可用；探测态显示 `已检测到：D:\\HoloGramHG\\target\\release\\hologram-engine.exe`；未打开工作区时回执**可读**：`接线回执：本进程尚未打开过工作区——打开一个工作区后这里会显示接线结果` |
| 2 | 看状态栏 / 设置面板「接线回执」 | 三态之一（wired / failed + 具名原因 / off） | ✅ **通过**：进工作区后回执 = `本工作区已接线：D:/HoloGramHG（7 个引擎工具在册）`；console 同源一行 `[Workspace] 随包图谱引擎已接线：D:/HoloGramHG（7 个工具在册）`；状态栏 pushStatus 同行 |
| 3 | 任务管理器看 `hologram-engine.exe` 是否挂在 `lantai.exe` 下；模型工具面是否出现 `mcp__hologram__*` | 进程在 + 工具面在 | ✅ **通过（进程部分实测）**：`hologram-engine.exe` pid 13812 / ParentProcessId = lantai.exe pid 18328 ⇒ 一进程一根；工具面按**回执口径**（`wired ⟺ 工具面非空`，2026-09-24 立法）为 7 件在册——**未逐名枚举**（UI 无工具清单面；如需逐名，走 MCP 侧 `tools/list` 探针，另立一条） |
| 4 | 切换/离开工作区 | 进程真停（一进程一根、离开即停） | ✅ **通过**：回首页（确认弹层文案 = `离开将关闭当前工作区的图谱引擎与后台分析…`）后 `.pp-root` 消失、`hologram-engine.exe` **进程已不存在**（只剩 `lantai.exe`） |

**验收结论（2026-09-25，重建 exe）**：四条**全通**（第 3 条的工具面为回执口径通过，逐名枚举另立探针）。
⇒ 批 10 可按 §4 施工（排期见账本 §5：9c-4 → 9f → 批 10 + §4-9 同窗）。

> **本轮现场修掉一个真机阻断缺陷**（详见账本 §0.6）：批 9h-3/9h-4 把「实现登记口」直连内核模块路径，
> 而产物域 esbuild 会把该内核模块整件内联成**副本** ⇒ 登记进副本、内核读不到，实机表现为
> **打开工作区直接失败**（`MEMORY_DOMAIN_UNAVAILABLE`，`[switchWorkspace] setupAgent failed`）。
> 修复 = 登记口经包内宿主桥（faceDeps）落到内核同一份登记表（与 multiagent/subagent 先例一致）；
> 修后四条验收才跑通——**这正是「先验真机再开模」的理由**。

**验收结论决定下一步**：四条全通 ⇒ 按 §4 施工；任一条不通 ⇒ 先修链路（通道设计等它跑通再定，
避免给未验证的消费者开模）。

## 8. 开放问题（需一次裁定）

1. 面的名字：`ctx.workspaces`（推荐）vs 并入 `ctx.space`（否——语义不同，见 §2-7）。
2. 回执面是否通用化：现只有 `state/bundled-engine-store`（引擎专用）。建议面提供 `scope.report`
   统一转状态栏 + 诊断面，避免每个贡献者自带 store（本批只需支撑引擎三态）。
3. 是否允许第三方产物用本面：推荐**允许**（通道一旦公开就开；真正敏感的是 MCP 桥，它走 faceDeps 留第一方）。
4. 贡献超时阈值：现引擎路径无显式超时（`await` 直等）。建议本面给一个可配上限（缺省不设，避免行为变更）。

**用户裁定（2026-09-25）**：1/2/4 按上表推荐值走；**3 = 允许第三方产物用本面**
（理由：真正敏感的是 MCP 桥，它走 faceDeps **留第一方** ⇒ 敏感面并未打开；且宪法第五条
「能换实现 ⇒ 开放面」，第三方早已能经 `ctx.*` 贡献工具/面板/渲染器/命令，属同一档）。

## 9. 同窗部件三：壳行贡献通道（§4-9，2026-09-26 补设计）

> 用户 2026-09-25 裁定 A：**立**，与批 10 **同窗**（两条同属「宿主生命周期贡献面」，
> 一起设计只付一次契约变更）。本节 = 该条的施工依据。

### 9.1 实测事实（file:line）

| 事实 | 位置 |
|---|---|
| 壳行表是**硬编码数组**（11 行，表序 = 引导序） | `composition/shell-rows.ts:50` `builtinShellRows()`（`ShellRow = { id, boot(refs, flowDeps?) }`，:44） |
| 壳行 = **纯 boot 时序**单元（无服务注册、无 disposer 诉求；根 fiber 生命周期 = 应用生命周期） | 同文件头注 :8-12 |
| 行 id 经 roster patch 的 `shell` 域可寻址禁用 | `composition/roster.ts:270`（`shell: builtinShellRows()`） |
| **装载序早于 bootShell**（⇒ 产物 apply 期登记的壳行来得及被收集） | `main.ts:49` `loadBuiltinPlugins(...)` → `:78` `await bootShell()` |
| 唯一「需要 boot 期副作用」的现存实例 = `shell-update-check`（**最后一行**） | `shell-rows.ts:72` → `shell/rows/update-check.ts` 27 行（`bootUpdateCheck()`） |
| 该行开关真源在内核 settings（`updates.autoCheck`），面板手动检查共用 `useUpdateStore` | `shell/rows/update-check.ts:16`；`settings-domain/SettingsPanel.tsx:190,901` |

**结论**：缺口不是「行表不够用」，而是**行表是内核特权数据**——产物无法贡献 boot 期副作用
（`update-check` 这类 27 行的产品件只能永久留内核）。且因为 `shell-update-check` 恰是**最后一行**，
「产物贡献行**追加在末尾**」这一条最简语义就能**逐位复现**今日引导序（零行为漂移）。

### 9.2 设计：`ctx.shellRows`（内核第 18 个 service）✅ **已落（2026-09-26）**

> 落地：`composition/shell-rows-service.ts` + `shell/boot.ts` 末位追加贡献行；首消费者 `shell-update-check`
> 已随 `settings-domain`（内核壳行 11 → 10，贡献行 1）——引导序逐位复现。**逐行 patch 寻址**未做
> （kill switch = 产物禁用面；见该 service 头注），后续可按需精化。

```ts
// 产物 apply(ctx) 内（一次性登记；bootShell 期按注册序串行 await）
ctx.effect(
  () => ctx.shellRows.register({ id: 'update-check', boot: (refs) => bootUpdateCheck(refs) }),
  'acme/shell-row',
);
```

| 面 | 规定 |
|---|---|
| 装载序 | 内核 `SERVICE_PLUGINS` 表**追加末位**（第 17 个 service）；`builtinShellRows()` 留在内核（11 行不动） |
| 行 id | 贡献行的寻址 id = `plugin/<产物包名>/<行 id>`（对齐 `plugin/hologram/<pkg>/<name>` 先例）⇒ roster patch 的 `shell` 域可禁用（禁用行 = 不接线，调用一致失败——与内置行同涟漪纪律） |
| 引导序 | **内置 11 行（表序）→ 贡献行（注册序）**；`bootShell` 逐行 `await`，行内失败**隔离**（与内置行同款：不阻断后续行、错误可见） |
| 生命周期 | 登记经 `ctx.effect`（fiber dispose 即摘行）；行本身无 teardown（与内置行同款——根 fiber 生命周期 = 应用生命周期） |
| 缺服务 | 无 `ctx.shellRows` 的环境（工具/单测）= 空贡献面，引导序零行为变更 |
| 诊断 | boot 审计行（`plugins/boot-gate`）增加「贡献壳行 N 行（具名）」；被禁用/失败的贡献行具名入账 |

**为什么不是扩 manifest 声明面**：与 §3 同一条理由——壳行是**代码**（boot 闭包）不是数据，
manifest 只能声明数据；且第三方若要在 boot 期跑代码，正路是插件本体（apply 期），
本面就是给「apply 期登记、boot 期执行」这一步的落点。

### 9.3 第一消费者：`shell-update-check` 随包

- `shell/rows/update-check.ts`（27）→ `plugins/builtin/settings-domain/update-check.ts`
  （该包已桥 `useUpdateStore` / `autoUpdateCheckEnabled` / `loadSettings` ⇒ 零新键）；
- `settings-domain/index.ts` 的 apply 用 `ctx.shellRows.register(...)` 复现今日行为（含 `manual` 开关判定）；
- 内核 `shell-rows.ts` 删该行（11 → 10 行），`shell/rows/update-check.ts` 删除；
- 出口判据：`builtinShellRows()` 10 行 + 贡献行 1 行 = 引导序与今日**逐位一致**（末位仍是 update-check）。

### 9.4 要动的契约面与守卫（与部件一同一次升版）

| 对象 | 动作 |
|---|---|
| `composition/contract-version.ts` | 契约清单增 `composition/shell-rows-service.ts`；版本 **v52 → v53**（与 `ctx.workspaces` 同一次升版） |
| `docs/agents/open-surface-contract.md` | 一条变更记录覆盖两条通道（工作区接线 + 壳行） |
| `src/plugins/host-surface.baseline.json` | 本部件**零 faceDeps 新键**（update-check 只用既有键）⇒ 指纹不变 |
| 新增守护测试 | ①面存在且 `builtinShellRows()` 仍是 10 行 + ②贡献行追加在末尾（引导序 = 内置→贡献）· ③行 id 可经 roster patch 禁用 · ④贡献行抛错不阻断后续行 · ⑤fiber dispose 摘行 |
| `docs/plugins/README.md` | §3 加「ctx.shellRows」段（含「boot 期代码 = 产物 apply 期登记」的纪律） |

### 9.5 批次（并入批 10 的 §6 表）

| 批 | 内容 | 交付判据 |
|---|---|---|
| 4（与批 10 同窗） | 部件三（通道 + 守卫 + 文档）+ `shell-update-check` 随包 | 引导序逐位一致（10 + 1）；设置面板「自动检查更新」开关与面板手动检查仍共用同一状态面；真机：启动自动检查失败/成功回执与今日同形 |
| 5 | 真机验收（并入 §7 清单，追加两条：贡献壳行在场 + 禁用该行后不检查） | 追加两条全勾 |
