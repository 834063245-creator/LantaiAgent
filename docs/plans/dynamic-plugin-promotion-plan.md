# 动态插件「提升」施工计划（promote → 常驻磁盘插件）

> 状态：**在办（已立项，未开工）**——2026-11-17 立，来源 = 用户提交的 issue「动态插件无法沉淀」。
> 一句话：会话里现场造出来的动态插件，经**用户显式审批**后固化成 `~/.lantai/plugins/<name>/`
> （`manifest.json` + `entry.js`），落盘后**完全走既有静态插件四通道**（装/卸/启用/禁用/授权），
> provenance 在设置页可见。
>
> 评审结论：issue 的问题与动机成立，但**技术方案那一栏四条前提里三条直接不成立**（落盘通道 / 原样落盘 /
> permissions 语义），第四条（inject 反推）方向对但不完整，另有一处会让 provenance 静默丢失（§1）——本计划按实测重写。
> 涉及契约升版（v60 → v61）+ 一次 convergence baseline 变更申请（唯一不能自裁的门，§3）。

## 1. 评审结论：issue 技术方案的五处修正

| issue 的说法 | 代码实测 | 本计划的修正 |
|---|---|---|
| 落盘**复用 `plugin_install` 的本地目录通道** | 该通道只做「把**已存在的目录**复制进 plugins 根」（`install_from_local_dir`）；它不写任何文件。而前端要造 `manifest.json`/`entry.js` 就得先写 `~/.lantai/plugins/`——沙箱**用户数据写白名单**只有 `global_memory` / `mcp.json` / `providers.yml` / `composition` 四处，`plugins` 不在其中 | 新增 Rust 命令 **`plugin_promote`**：宿主一次完成「校验 → 版本守卫 → .tmp 原子落盘」。落在既有 `commands/plugin_install.rs` 内（**不新建命令模块**——`platform_boundary_test` 冻结模块清单） |
| 取源码后「按 vendor 原样落盘」 | 动态包 `code` 是**工厂函数体**；静态 `entry.js` 是**自包含 ESM**。原样写盘 = 无导出 → `isPluginShape` 拒载 | 生成**导出壳**：`const __p = (function(){ <函数体逐字节> })(); export default { name, inject, apply: __p.apply }`。正文原样、外壳生成 |
| 两种插件只在「代码形状」上兼容 | **生命周期纪律还有一处硬差异**：静态插件的贡献一律包 `ctx.effect`（fiber 收集 → dispose 链式回收），动态插件的**裸 `register` 是合法姿势**（disposer 由守卫收进 runner 的回收袋）。同一个 `apply` 原样搬过去，静态侧会留下**不受 fiber 管理的僵尸行**（重载后残留 + 重复 id 装载期 throw） | 导出壳里再包一层：`apply: (ctx) => __p.apply(new Proxy(ctx, { get }))`——把裸 register 的返回值收进 `ctx.effect` 袋。**这是 B2 最容易漏、也最难在单测里看出的一项** |
| `inject` 从守卫 ctx 的注册面反推 | 守卫面是**运行期逐次** `reflect.get` 代解析，插件**从不声明 inject**，也没有任何地方记账。提升成静态插件后注入真实 ctx ⇒ 未声明就访问 `ctx.tools` 会抛 `without inject`，**沙箱里能跑、提升后必栽** | `makeGuardedCtx` 的 get 陷阱补一行记账：`record.accessedServices: Set<string>`。inject = 实际访问过的服务（空集 = 不需要服务） |
| `permissions` 默认 `[]` = 「最小权限」 | 反了。`permissions` 是 **Rust 权限咽喉的声明面 / 装载期准入门槛**：声明了但未 granted → `blocked` 且不 import 代码；**无声明 = 零摩擦直接装载**（README §5 原文）。静态插件没有「按 capability 裁剪」的机制 | 默认 `[]` 的语义改为**诚实声明**：审批时用户可勾选权限类写入 manifest；勾了 → 装载为 `blocked` 待授权；不勾 → 照常装载（届时插件全能力可用，与其余静态插件同级） |
| provenance 记在 manifest 里 | `PluginManifestSchema` 是普通 `z.object`，未知键在 `validateManifest` 被**剥离**，`plugin-store` 收不到 | provenance 升为 **manifest 一等字段**（可选 `provenance`），schema + 契约注释同批加 |

另两条已被 issue 自己标「待确认」，实测答案：

- **源码在会话日志里有没有？** 有。`cordis_define` 每次调用落 `tool/call` 事件，`arguments` 是原始 JSON 字符串（含 `code`）。
  但本计划**不**用它做提升输入——提升的输入 = runner 内存里那个包（所有权/审批/包不可变语义都在那儿）。
  「从旧卷捞回插件」是另一个便利功能，另立（§8）。
- **`docs/plugins/README.md` §9 登记过吗？** 没有。§6 只写了「跨会话不可见」，没写「不能沉淀」这个后果。
  本批**同批**补一条 §9 记录。

## 2. 形态决定（自裁项，事后有异议再翻案）

| 项 | 裁定 | 理由 |
|---|---|---|
| 写盘通道 | Rust `plugin_promote`（宿主写），**不是**「前端拼装 → 调 install」 | 前端无盘权；且「审批」与「写入」必须是**同一次不可分调用**，中间不留前端状态 |
| 命令落点 | `commands/plugin_install.rs` 内新增函数 | 平台边界守卫冻结 `commands/mod.rs` 模块清单；本命令属「壳侧写盘必须 Rust」同族 |
| 插件名 | 默认 `<idPrefix>-<序号>`，审批卡里**可改**（自由输入框）；必须过 `PLUGIN_NAME_RE` | 动态 `name` 允许任意 ≤120 字符（中文/空格），而 `manifest.name` 必须逐字等于目录名。**不加 scope**：`plugin_uninstall` / `plugin_dir` 的名字围栏拒收 `/`，加 scope 会让「卸载」这条验收开局即红 |
| 版本 | 初始 `1.0.0`；同名冲突交给既有 `plan_install`（同版本拒 / 降级拒 / 升级换装） | 复用版本守卫，不新造一套 |
| `force` | **永不暴露给模型**；审批卡里也没有 | force 是绕过版本守卫的逃生门，模型不该有 |
| `inject` | `accessedServices` 记账（只写实际访问过的） | 写多了 = 依赖悬挂（fiber PENDING → boot 审计红）；写少了 = 运行期 without inject |
| `permissions` | 默认 `[]`；审批卡里逐条勾选 `read/edit/bash/git/web` | 见 §1 第四条。勾选即写入 manifest，装上来是 `blocked` 待授权 |
| 贡献生命周期 | 导出壳的 `apply` 用**代理 ctx** 跑原 `apply`：`register` 的返回值统一收进 `ctx.effect` | 见 §1 第五条。不包 = 僵尸行（动态版的合法姿势在静态侧是漏洞） |
| 动态版去留 | **保留**（不销毁）；同一 `packageId` 只允许提升一次（重复 = 幂等拒绝） | 禁止要引入两个状态机之间的删除联动（两处真相同步）；收益只是省一份内存副本。provenance 记 `packageId` 即可追溯 |
| 生效时机 | 落盘后立即 `activateExternalPlugin(dirId)`（D6）；**工具面下次装配生效**，面板/命令即时 | 在途会话冻结是 KV-cache 纪律（README §7），不能在当前卷插行 |
| 审批面 | 复用 `askUser`（`ApprovalFromUi` 同源），但换 id 前缀与卡片正文 | D12 信任模型既有语义：拒绝即终局，不得重复请求 |

**审批卡要展示的四件**（issue 要求）：插件名（可改）· 用途（`purpose`）· 将要申请的权限类（勾选）·
源码摘要（`sha256` 前 12 位 + 字节数 + 首行）。源码全文不进卡片（长），但 `cordis_inspect_self` 随时可取。

## 3. 契约与生成物影响（**必做，不是可选项**）

| 面 | 影响 | 手续 |
|---|---|---|
| 开放面契约 | `dynamic-runner-service.ts` / `sandbox.ts` / `plugins/types.ts` 三个在册载体都会变 → **v60 → v61** | `contract-version.ts` 四步：改文件 → bump → `open-surface-contract.md` 加行 → `gen:contract-fingerprint`，**同 commit** |
| 模型工具面 | `DOMAIN_SPECS` 的 `cordis` actions 增 `promote` | `gen-tool-contract-md` 重生成 `docs/agents/model-tool-contract.md` |
| **convergence baseline** | `tool-schemas.full.json` / `tool-schemas.plan.json` 的 cordis 条目（含 action 枚举）会变 → 双轨各两份 | **baseline-change-request 审批**（`docs/archive/agent-core-convergence/baseline-change-request.md` 追加一节）→ `npm run record:convergence` 独立步骤。**这是本计划唯一不能自裁的门** |
| RPC 契约 | `rpc.rs` 方法 + `RpcResultShape`（JsonValue）+ `rpc-contract.ts` | `gen-rpc-contract-md`（带时间戳，不入 doc-sync 字节对拍，走同 commit 纪律） |
| 文档 | README §5（安装通道表加一行）/ §6（动态插件段补「可提升」）/ §9（未决项登记）· cookbook 加一节 | `doc-check` |
| 计数 | 内核插件数 / 出厂产物数**不变**（不新增第一方产物） | 若误动 `SERVICE_PLUGINS` 会被 `doc-facts` 抓 |

## 4. 数据形状

**manifest 新增（可选）字段**（`src/plugins/types.ts`，zod 真源）：

```ts
provenance: z.strictObject({
  kind: z.literal('promoted'),
  sessionId: z.string(),        // 来源会话（owner）
  packageId: z.string(),        // 原始动态包 id，如 dyn-toolv-0003.p1
  definedAt: z.string(),        // 包定义时间（ISO）
  promotedAt: z.string(),       // 审批通过时间（ISO）
  sourceSha256: z.string(),     // 提升时源码字节指纹（防篡改可对拍）
}).optional(),
```

**RPC `plugin_promote` 参数**（snake_case）：

```
{ name, manifest_json, entry_js, provenance_json }
→ { name, dir, replaced: boolean }   // JsonValue
```

Rust 侧校验（全部 fail-loud）：`name` 名字围栏（拒 `..` `/` `\\` `:`）· `manifest.name === name` ·
`entry` 必须是 `entry.js` · manifest 可解析且 `version` 在场 · 走后 `plan_install` 版本守卫 →
`.tmp-*` 写入 → `Fresh: rename` / `Replace: replace_existing`（备份 + 回滚）。

## 5. 改动清单

**新增**

| 文件 | 内容 |
|---|---|
| `src-ui/src/agent/dynamic-runner/promotion.ts` | 纯函数：`buildEntryModule(code, { name, inject })`（导出壳，含 effect 包裹代理）/ `buildManifest(...)` / `summarizeSource(code)`——**不含 RPC**，可纯单元测 |
| `src-ui/tests/dynamic-promotion.test.ts` | 纯函数面（壳生成/名字/摘要）+ 端到端（promote → 新卷装载 active） |

**修改**

| 文件 | 内容 |
|---|---|
| `src-tauri/src/commands/plugin_install.rs` | 新增 `plugin_promote` + 测试（体量账见 B1 行的 DEBT 档位处理） |
| `src-tauri/src/rpc.rs` | 分派 + `RpcResultShape::JsonValue` 登记 |
| `src-ui/src/rpc-contract.ts` | `plugin_promote` 契约条目（加在插件安装通道段） |
| `src-ui/src/agent/dynamic-runner/sandbox.ts` ⚠️契约 | `makeGuardedCtx` 记 `accessedServices` |
| `src-ui/src/agent/dynamic-runner/dynamic-runner-service.ts` ⚠️契约 | `promote(owner, pluginId, packageId, req, approval)`：取包 → 审批 → 组包 → RPC → `activateExternalPlugin` → 记 `promoted` 状态 |
| `src-ui/src/plugins/builtin/cordis-domain/cordis.ts` | 新增 `cordis_promote` 工具（描述写明「必须用户批准」） |
| `src-ui/src/agent/tools/domains.ts` | `cordis` 域 `actions.promote` + 域描述一句话 |
| `src-ui/src/plugins/types.ts` ⚠️契约 | manifest `provenance` 字段 |
| `src-ui/src/plugins/builtin/settings-domain/PluginsPage.tsx` | 已装卡片加 provenance 行（来源会话 / 包 id / 提升时间 / 源码指纹） |
| `src-ui/src/composition/contract-version.ts` ⚠️契约 | v61 + 变更说明 |

**生成物（重跑，勿手改）**：`model-tool-contract.md` · `facts.generated.md` · `open-surface-contract.md` 指纹段 ·
`frontend-rpc-contract.md` · convergence baseline（走审批）。

## 6. 测试

| 面 | 用例 |
|---|---|
| Rust | ① 正常落盘（manifest+entry 在盘、目录名 = name）② 名字围栏（`..` / `a/b` / `C:x` 逐个拒）③ 版本守卫三态（同版本拒 / 降级拒 / 升级换装备份）④ 写失败不留半成品（.tmp 清）⑤ 未审批时零写入 |
| TS 纯函数 | ⑥ 导出壳逐字节含原函数体 ⑦ `inject` 只含访问过的服务 ⑧ 名字非法时显式拒绝并给出合法建议名 ⑧b **壳内的代理把裸 register 收进 effect**（用假 ctx 断言：apply 跑完后 disposer 袋长度 = 注册条数） |
| TS 服务 | ⑨ promote 未审批 → 无 RPC 调用、零落盘 ⑩ 审批拒绝 → 终局（再 promote 不得复用授权）⑪ 同一 packageId 二次 promote = 幂等拒绝 ⑫ `activateExternalPlugin` 被调一次、失败可见 |
| 端到端 | ⑬ define+run 通过 → promote → **新卷**装载为 `active`、工具行在 ⑭ promote 后 stop/undefine 动态版，静态插件不受影响 ⑮ 卸载走 `plugin_uninstall` → 贡献链式回收、无残留行 ⑯ `permissions` 勾选 bash → 装载为 `blocked` 且缺项可见 |
| 生成物 | `doc-sync` 全绿 · `doc-check` 全绿 |

**门禁**（每批都跑）：`cd src-ui && npm run build` · `npx vitest run` · `npx biome ci .` 0/0 ·
`npm run verify:convergence`（双轨）· `npm run doc-sync` · `npm run doc-check`；Rust 批 `cd src-tauri && cargo test`。

## 7. 批次

| 批 | 内容 | 出口条件 |
|---|---|---|
| **B1 · 写盘通道**（Rust） | `plugin_promote` + RPC 分派 + rpc-contract + Rust 测试 | `cargo test` 绿；**未审批零落盘**用例在场。⚠ 体量账：`plugin_install.rs` 现 1306 行、DEBT 档 1400——本批会跨档，须同 commit 把 `tests/god-file-budget.test.ts` 的档位抬到 1600 并写一句理由（该规则允许，前提是**有记录的决策**） |
| **B2 · 组包与服务**（TS 内核） | `promotion.ts` 纯函数 + `accessedServices` 记账 + `DynamicRunnerService.promote` + 测试 ⑥⑦⑧⑨⑩⑪⑫ | vitest / build / biome 绿；契约 v61 四步走完 |
| **B3 · 工具面与 UI** | `cordis_promote` + `DOMAIN_SPECS` + 审批卡 + `PluginsPage` provenance 行 + 端到端 ⑬⑭⑮⑯ | 生成物重生成；**baseline-change-request 审批 + record** 独立提交 |
| **B4 · 文档收口** | README §5/§6/§9 · cookbook · plans 索引 | `doc-sync` + `doc-check` 绿 |

**B1 与 B2/B3 可并行**（B2 的 RPC 调用面按 §4 的参数形状写，B1 按同一份形状实现）。

## 8. 边界（本计划不做）

- **不做「从历史会话恢复插件」**——源码确实在 `tool/call` 事件里，但那是另一个功能（扫旧卷 → 重放 define），
  会把审批面做糊。另立。
- **不做能力级裁剪**（「依赖 bash 的工具不装载」）——静态插件没有按 capability 裁剪的机制，
  要做是新的强制层设计，不在本批。
- **不做 scope 名**（`user/xxx`）——名字围栏不支持，见 §2。
- **不改动态插件现有生命周期**（define/run/stop/undefine 语义逐字节不变）。
- **不新增第一方产物**（`builtin-roster.json` 不动）。

## 9. 验收（六条）

1. 会话内 `define + run` 通过的包，经 promote 后**新开一卷**仍装载为 `active` 且工具可用。
2. 未审批时**零落盘**（不建目录、不写文件、不调 RPC）。
3. `permissions` 默认 `[]`（照常装载）；审批时勾选的类写入 manifest 并装载为 `blocked`，设置页列出缺项。
4. 设置页可见 provenance（来源会话 / 原始 packageId / 定义时间 / 提升时间 / 源码指纹）。
5. 卸载或禁用后贡献链式回收，无残留工具行。
6. 同名冲突走版本守卫（同版本拒、降级拒、升级换装），**模型侧无 `force`**。

## 10. 要用户定的一件事

**baseline 变更申请**（§3）需要你的批准才能 `record`——变更对象是 `tool-schemas.full/plan` 两份快照里
`cordis` 工具的 `actions` 枚举各多一项 `promote`，其余条目逐字节不动。B1/B2 可以先做，B3 卡在这里。
