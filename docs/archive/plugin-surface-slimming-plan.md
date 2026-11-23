# 插件面减形与贡献者体验（施工单）

> **状态**：已归档（2026-11-23 竣工，批 0–5 全落；契约 v71 → **v74**）。
> 落地面：`governed: true` 一档受治进程 · `tools[].async` 退役 · `engines` 兼容声明 ·
> 未知顶层字段转 warnings · 契约工具包（一页纸 / JSON Schema / validate CLI / 模板）·
> 插件医生 + 外部重载。全量 vitest / build / biome / doc-sync / doc-check / convergence 绿。
> **来由**：三问——软件级插件的生命周期归谁、UI 归谁、有多少能转移给插件面。
> 结论：不转移不变量；先删零消费者形状，再把宿主保证与开发者工具做厚。
> **一句话**：宿主少管功能、多管不变量；这一轮只做「减形 + 开发者体验」，不新增运行时能力。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 本单。

## 0. 决定（先看这页）

| # | 决定 | 理由 |
|---|---|---|
| 1 | 生命周期、安装卸载、沙箱、进程监督、窗口仲裁**不下放** | 卸载保证、进程树、跨插件仲裁不能外包；下放 = 每个插件各写一份 |
| 2 | `mcpServers[].lifecycle` 三档 → `governed: true`；删 `eager` / `with-window` | 真实消费者只有 `lazy`；另两档除测试外 0 消费者 |
| 3 | 删 `tools[].async`；后台唤醒只留 MCP `lantai/deferred` 一条路 | 工具口异步 0 消费者；MCP 路是 notes-app 真在用的 |
| 4 | **冻结**：`app.documents`（批 1+2 已落，批 3 在办）、`permissions`（安全门）、`mode: dock/fullscreen`（0 消费者，产品面暂留一版） | 已规划/安全项不误删；窗口模式等窗口管理重做再定 |
| 5 | **不动**：`activation`（bundled-engine 真实消费者）、`restart`、`app.url`（office）、`dataDir`、桥、安装/卸载 | 有消费者或属不变量 |
| 6 | 这一轮唯一「加」的是开发者体验：一页契约 + JSON Schema + validate CLI + 模板 + 插件医生 + 外部重载 + `engines` | 减支持成本，不增运行时 API |
| 7 | 新规矩：新 manifest 字段需 **≥2 个真实消费者**或一个明确产品承诺 | 防止下一轮又长回来 |

**不做**：`chrome:'self'`、插件自管进程、第三方任务栏/启动器位、通用插件设置 schema、
`@lantai/plugin` npm 包/完整 testkit（触发条件见 §7）。

## 1. 消费者审计（2026-11-23）

直接相关的宿主侧 18 个文件约 **5.9k 行**（不含测试/文档）：约 **4.2k 内核/契约**、
约 **1.6k 第一方产品 UI**（架阁、设置页、窗框）。仓内 app 形态 manifest 只有 3 个：
`notes-app` / `md-editor` / `office`；第三方 app 样例为 0。

| 宿主形状 | 真实消费者 | 处置 |
|---|---|---|
| `app.entry`（自包含 HTML） | notes-app / md-editor | 留 |
| `app.url`（环回远端页） | office | 留（1 个，成本低） |
| `dataDir` | notes-app / md-editor | 留 |
| `mcpServers` | notes-app / dataflow-mcp / bundled-engine | 留 |
| `lifecycle: lazy` | notes-app / bundled-engine | 改为 `governed: true` |
| `lifecycle: eager` | 0（只有测试） | 删 |
| `lifecycle: with-window` | 0（只有测试） | 删 |
| `restart: on-crash` | bundled-engine | 留 |
| `activation` | bundled-engine（代码路径，[wiring.ts:157](../../src-ui/src/plugins/builtin/bundled-engine/wiring.ts)） | 留——**不是死代码** |
| `tools[].async` | 0 | 删（MCP deferred 保留） |
| `app.documents` | 0（[文档通道批 1+2 已落](../plans/plugin-document-channel-plan.md)，批 3 待办） | 冻结 |
| `permissions` | 0 | 冻结（安全门，不扩） |
| `mode: dock / fullscreen` | 0（全 floating） | 冻结 |
| `frame:'self'`（面板） | canvas-nav ×2 | 留（家具特权，不是软件级） |

**注意**：`activation` 的「零声明」只指 manifest 面；bundled-engine 在 `apply` 里用代码路径
`ctx.activation.declare` 接引擎的 lazy 档（[wiring.ts:157](../../src-ui/src/plugins/builtin/bundled-engine/wiring.ts)），
删它会退回「装配期拉起 / 空闲回收」而不是「所有持卷关了就停」。本单不动它。

## 2. 目标形态

- manifest 删 **2 个形状**（`lifecycle` 三档、`tools.async`）+ **2 个枚举值**（`eager` / `with-window`）；
  `lifecycle` 的位置由 `governed: true` 取代（净字段数不变）；唯一新增是 `engines` 兼容声明（不是能力）。
- 受治进程只剩一种语义：`governed: true` + 缺省 lazy（开窗不回收、空闲 5 分钟回收）；
  `restart: 'on-crash'` 照旧。
- 新贡献者 5 分钟路径：拷模板 → `npm run plugin:validate -- <目录>` → 本地目录装载 → 架阁可见。
- 宿主保证不变：fiber dispose 链、进程树终止、窗口全关、数据 `.trash`、桥白名单、安装/卸载。
- 诊断可读：装载阶段、错误、工具列表、MCP 状态、最近崩溃、窗口、数据目录、契约版本。

## 3. 批次

### 批 0 · 基线与冻结（0.5d）

| 动作 | 说明 |
|---|---|
| 基线 | 先跑一遍 `vitest` / `build` / `biome ci` / `doc-check`，记录绿/红 |
| 索引 | 本单登记进 [`docs/plans/README.md`](README.md) 活跃线；竣工即归档 |
| 冻结 | 本单周期内不加新 manifest 字段（`engines` 除外，见批 4） |

**验收**：基线可复现；无代码改动。

### 批 1 · 受治进程减形（1d）

#### 1A · `lifecycle` → `governed`

| 文件 | 动作 |
|---|---|
| `src-ui/src/plugins/types.ts` | `McpServerDeclSchema` 删 `lifecycle`，增 `governed?: boolean`；`restart` 原样保留 |
| `src-ui/src/plugins/loader.ts` | 退役字段具名拒绝：manifest 里出现 `lifecycle` → error「已退役，改用 governed: true」；governed 判定 = `governed === true || restart !== undefined` |
| `src-ui/src/plugins/mcp-bridge.ts` | `ServerGovernor` 删 `lifecycle` getter 与 `eager`/`with-window` 分支；`registerGovernedServer` 删 eager 装载期拉起；`governedActivationFace` 不再按档过滤 |
| `src-ui/src/plugins/types.ts` | 删 `activation.lazy` 与 `lifecycle: eager` 的互斥 refine（已无 eager） |
| `examples/plugins/notes-app/manifest.json` | `lifecycle: "lazy"` → `governed: true` |
| `src-ui/src/plugins/builtin/bundled-engine/wiring.ts` | `lifecycle: 'lazy'` → `governed: true`（`restart: 'on-crash'` 保留） |

**测试**：`plugin-loader.test.ts`（接受 governed / 拒绝 lifecycle / 拒绝 eager·with-window）、
`mcp-bridge-governance.test.ts`（只测 lazy 路径）、`mcp-activation-refcount.test.ts`
（删 with-window 用例，保留 engine 激活用例）、`plugin-window-store.test.ts`（窗口计数改 lazy 口径）、
`notes-app-loader.test.ts` / `notes-app-example.test.ts`。

**契约**：按四步流程升版（当前 v71 → 下一版）；`open-surface-contract.md` 记一行迁移表。

#### 1B · 删 `tools[].async`

| 文件 | 动作 |
|---|---|
| `src-ui/src/plugins/types.ts` | `ToolManifestDeclSchema` 删 `async`；manifest 里出现 `async` → 具名 error「已退役，改用 MCP deferred」 |
| `src-ui/src/plugins/tool-declarations.ts` | 删 `asyncAwareExecute` 与本文件的 deferred import |
| `src-ui/src/plugins/deferred.ts` | 删工具口 `tasks` / `nextPluginTaskId` / `bindPluginTask` / `completePluginTask`；保留 MCP `callTokens` / `completeMcpDeferred` |
| `src-ui/src/plugins/loader.ts` | 宿主桥删 `deferred` 键（`host.deferred.complete` 不再存在） |
| `src-ui/src/workspace.ts` | 注释只留 MCP 路 |

**测试**：`plugin-deferred.test.ts`（删工具口用例，保留 MCP 路）、`plugin-tool-declarations.test.ts`
（删 async 用例）、`plugin-loader.test.ts`（async 具名拒绝）。

**契约**：再升一版；迁移表写明「工具口异步退役，长任务走 MCP server + `lantai/deferred`」。

#### 1C · 形状守卫（新）

`src-ui/tests/plugin-surface-budget.test.ts`：

- manifest 顶层字段 = 固定 allowlist（当前 12 个；增字段必须改本测试，diff 可见）；
- `lifecycle` / `tools[].async` 不在 schema，且所有 `examples/plugins/**/manifest.json` 不出现；
- `examples/plugins/**` 全部 `validateManifest().ok`。

### 批 2 · 契约工具包（2–3d）

| 文件 | 动作 |
|---|---|
| `docs/plugins/contract-card.md`（新） | 一页纸：能写什么 / 宿主保证什么 / 不能做什么 / 怎么调 / 去哪读全文；从 `docs/plugins/README.md` 顶部链入 |
| `scripts/gen-plugin-manifest-schema.cjs`（新壳）+ `src-ui/scripts/gen-plugin-manifest-schema.ts`（新核） | 用 `z.toJSONSchema(PluginManifestSchema)` 生成 `docs/plugins/manifest.schema.json`；`--check` 对拍；登记进 `scripts/doc-sync.cjs`（照 `gen-tool-contract-md.cjs` 的 tsx 转发壳） |
| `scripts/validate-plugin.cjs`（新壳）+ `src-ui/scripts/validate-plugin.ts`（新核） | 读目录下 `manifest.json` → `validateManifest` → 打印字段路径错误；退出码 = 校验结果；`package.json` 加 `plugin:validate` |
| `examples/plugins/_template/`（新） | 最小模板：manifest.json + entry.js + README；`tests/plugin-template.test.ts` 校验形状 |
| `docs/plugins/README.md` | 顶部加「5 分钟路径」指针；不重抄全文 |

**契约**：无变更（schema 从现有 zod 生成）。JSON Schema 只表达形状；跨字段约束
（如 `governed` / `restart` 组合）仍以 `validateManifest` / CLI 为准。

**验收**：贡献者按 contract-card 走一遍：模板 → validate → 本地装载 → 架阁可见；
JSON Schema 在编辑器里能补全；`doc-sync --check` 绿。

### 批 3 · 插件医生 + 外部重载（2d）

| 文件 | 动作 |
|---|---|
| `src-ui/src/plugins/diagnostics.ts`（新） | 只读聚合：record（status/error/manifest）、声明工具、MCP 治理器状态、窗口 defs/实例、`plugin_dir` / `plugin_data_ensure` 路径、activation 状态、契约版本；内置插件无 `plugin_dir` → 显示「内置」，不当作 error |
| `src-ui/src/plugins/mcp-bridge.ts` | 导出 `governorStatesFor(plugin)`（只读）；`ServerGovernor` 记 `lastStopReason` |
| `src-ui/src/plugins/builtin/settings-domain/PluginsPage.tsx` | 每个插件加「诊断」展开：字段表 + 复制 JSON；复用设置页已有日志导出入口 |
| `PluginsPage.tsx` | 外部插件加「重新加载」：调 `activateExternalPlugin(name)`（既有「先验后拆」路径）；失败保留旧 fiber 并显示 error |
| `src-ui/src/state/plugin-store.ts` | 可选增 `warnings?: string[]`（批 4 未知字段警告的落点） |

**测试**：`plugin-diagnostics.test.ts`（聚合读面）、`plugins-page.test.tsx`（诊断展开 / 重载调用）、
`mcp-bridge-governance.test.ts`（`governorStatesFor`）。

**契约**：无变更（宿主读面，不改插件 API）。

### 批 4 · 兼容性契约（1d）

| 文件 | 动作 |
|---|---|
| `src-ui/src/plugins/types.ts` | 增 `engines?: { lantai?: string }`（semver range） |
| `src-ui/src/plugins/loader.ts` | 读 `__LANTAI_BUILD__.v`（`typeof` 守卫）；版本未知 = 跳过检查并 warn，不阻断开发/测试；不满足 → 具名 error |
| `src-ui/src/plugins/types.ts` | 未知顶层字段 → `warnings`（不静默剥；不阻断装载）；`validateManifest` 返回 `warnings: string[]` |
| `docs/plugins/README.md` | 加「契约版本与弃用」：删除即具名拒绝 + 迁移表；不留兼容层 |
| `docs/agents/open-surface-contract.md` | 升版记录 |

依赖：`src-ui/package.json` 显式加 `semver` + `@types/semver`（当前只有根 `node_modules` 的传递依赖）。

**测试**：`plugin-loader.test.ts`（engines 满足/不满足/未知版本；未知字段 warning）、
`seam-contract-version.test.ts`（版本 + 指纹）。

**验收**：旧宿主 + 新字段 → 明确 warning，不静默；不满足 engines → 设置页 error 写明版本区间。

### 批 5 · 文档收口与归档（0.5d）

- `docs/plugins/README.md` §3 / §10.2 / §10.3 / §10.4：删 `eager`/`with-window`/`tools.async`；
  `lifecycle` 改 `governed`；窗口模式标「冻结」。
- `src-ui/src/plugins/builtin/skill-domain/builtin-skills.ts` §2.7：同步。
- `docs/cookbook/plugin-as-software.md`、`examples/plugins/notes-app/README.md`：同步。
- `docs/agents/open-surface-contract.md`：版本 + 指纹。
- `docs/facts.generated.md`：若插件计数/契约版本被 `doc-facts` 收录，重生成。
- 全部绿后把本单移入 `docs/archive/`，更新 `docs/plans/README.md`。

## 4. 门禁

| 批次 | 命令 |
|---|---|
| 全部 | `cd src-ui && $env:NODE_ENV='test'; npx vitest run` · `npm run build` · `npx biome ci .` · `npm run doc-check` |
| 批 1 / 批 4 | `npm run gen:contract-fingerprint` · `npm run gen:host-surface` · `npm run verify:convergence`（动了 `composition/contract-version.ts`） |
| 批 3 | `npm run gen:host-surface`（新增只读导出进 host 面） · `npx vitest run` |
| 批 2 | `npm run gen:plugin-schema` · `npm run doc-sync`（新生成物入册） |
| 批 5 | `npm run doc-sync` · `npm run doc-check` |

不需要 `cargo test`（本单不动 Rust）。

## 5. 验收

1. **新贡献者路径**：模板 → validate → 本地装载 → 架阁可见，5 分钟内跑通。
2. **旧形状具名拒绝**：manifest 写 `lifecycle` / `async` 得到可行动错误，不是静默剥掉。
3. **现有样例**：notes-app / md-editor / office 装载、开窗、工具面不变。
4. **医生可读**：设置页能看到装载阶段、错误、工具、MCP 状态、窗口、数据目录。
5. **外部重载**：改插件目录 → 点重新加载 → 贡献面更新；失败保留旧 fiber。
6. **兼容性**：engines 不满足时 error 写明区间；未知字段 warning 可见。
7. **形状不回流**：`plugin-surface-budget` 测试绿；文档不再教 `eager`/`with-window`/`async`。

## 6. 风险与回滚

| 风险 | 处置 |
|---|---|
| `lifecycle` 破坏性改名 | 仓内只有 2 个消费者（notes-app / bundled-engine）；旧 manifest 具名拒绝 + 迁移表；按项目授权不留兼容层；按批可 revert |
| `governed` 命名不喜欢 | 落地前改名（`managed` / `resident` 均可）；定名后不再加别名 |
| 窗口模式冻结留下死代码 | 本单不删；窗口管理重做时按实际消费者一次删净 |
| 外部重载双 fiber / 贡献撞 id | 复用 `activateExternalPlugin` 的「先验后拆」；失败保留旧 fiber；测试覆盖失败路径 |
| engines 在测试/产物域版本 unknown | 未知 = 跳过并 warn，不阻断；只为「已知版本且不满足」拒绝 |
| 医生读面扩大维护面 | 只读聚合，不加运行时契约；字段以现有 store/registry 为准，不新建第二真源 |

## 7. 先不做 / 触发条件

- **`chrome:'self'`**（插件自画窗框）：外部 app 插件 ≥10 个，或 ≥3 个明确要求品牌化窗框。
- **插件自管进程**：永不做——进程监督是宿主不变量。
- **第三方任务栏/启动器位**：永不做——UI 失控与安全面。
- **通用插件设置 schema**：永不做——配置住插件窗内；宿主最多给 secret 存储，不给表单。
- **`@lantai/plugin` npm 包 / 完整 testkit**：外部 app 插件 ≥10 个，或 ≥3 个要求类型/测试工具。
- **删 `dock`/`fullscreen`**：窗口管理重做，或出现第二个模式消费者；之前只冻结。
- **复活 `permissions`**：出现真实插件要求「按最小权限授予」时。

## 8. 交付纪律

- 每个子批一个 commit；门禁全绿才 commit；行为变更写进 commit message。
- 文档与代码同 commit；契约变更走四步流程（改文件 → 升版 → 记录 → 指纹）。
- 不混入无关改动；他窗在途改动单独确认。
- 竣工即归档：本单移入 `docs/archive/`，`docs/plans/README.md` 只留一行状态。
