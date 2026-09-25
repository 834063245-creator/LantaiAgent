# provider 数据面归家 · 施工单（批 9f）

> 状态：**侦察已完成、判定已出（2026-09-26）**；本文件 = 施工依据（真源账本 = 
> [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md) §2.1 / §6.5 的 9f 条）。
> 口径：物理行（`(Get-Content).Count`）；消费者矩阵 = 全树 `import` 实测（脚本口径：按
> specifier 解析后比对相对 `src/` 的 posix 路径，内核 = `plugins/builtin/` 之外）。

## 1. 病灶与原始判断

账本 §2.1 立账：`settings-domain` 半迁移 —— 批 1 收了 MCP/插件/技能三页（1,103）、批 9d 收了
Provider 控制台 8 件（2,740），余「provider 设置数据层」`settings.ts` **703** 与核内
`provider/**` **16 件 3,502**。账本 §6.5 的 9f 条给的初步拆法 = 「应用配置核心留内核 +
Provider 数据面随包（内核读点走登记接缝）」，并注明**与 `provider/**` 是同一件设计，需先出施工单**。

## 2. 实测消费者矩阵（本单的依据）

### 2.1 `settings.ts`（705 行）按导出逐个实测

| 桶 | 个数 | 导出 |
|---|---|---|
| **A. 可随包**（内核零消费者 **且单产物取用**） | 9 | `ProbeOutcome` · `ConnectionProbe` · `modelMaxTokens` · `defaultBaseUrl` · `isFactoryBaseUrl` · `persistSecrets` · `removeSecret` · `addProvider` · `removeProvider` |
| **B. 仅内核用**（判内核平台） | 6 | `ModelOverrides` · `ProviderRuntime` · `installProvidersProjection` · `installProvidersFileReadyCheck` · `storedProviderRows` · `parseRpcString` |
| **C. 两侧都用**（拆点） | 14 | 形状三件（`AppSettings` / `ProviderSettings` / `ProviderId`）· 配置核心（`loadSettings` **内核 12** · `saveSettings` 内核 4 · `autoUpdateCheckEnabled`）· provider 读点（`getActiveProvider` 内核 3 · `updateProvider` · `modelContextWindow` · `modelInput` · `modelThinking` · `modelDescriptor` · `providerId` · `loadSettingsWithSecrets`） |

> **A 桶复核（2026-09-26 二次实测，判据：看「产物包 host 面」而非 `host-modules.ts`——后者是内核桥
> 注册表不是消费者）**：原列 13 个里 4 个实为跨产物/内核表 ⇒ 归 C 桶：`effectiveModels`（`compose-dock` +
> `settings-domain`）· `canvasWheelMode`（`paper-shell` + `settings-domain`）· `onSettingsSaved`
> （`compose-dock` + `paper-shell`）· `PROVIDER_PROTOCOL_DEFAULTS`（`llm-adapters` 单产物取用，但它是
> `defaultBaseUrl` 与适配器的**端点真源单点**、内核表 ⇒ 留内核，照批 2a 的注记）。

**C 桶的内核读点在哪**：`shell/boot.ts`（启动即 `loadSettings` 读语言/字号）· `shell/rows/{persistence,drag-drop,update-check}` ·
`state/{compose-store,mode-store}` · `ui/chat-session` · `composition/preset-assembly.ts`（preset 选择写读）·
`workspace.ts`（工作区装配取 provider 行与模型窗口）· `provider/**` 七件（`credentials` / `index` / `live` /
`model-sync` / `oauth` / `providers-doc` / `providers-store`）。

### 2.2 `provider/**`（16 件 3,502 行）按文件实测

| 文件 | 行 | 内核消费者 | 判定 |
|---|---|---|---|
| `types.ts` | 494 | **50**（agent 全层 + paper + state + 契约载体） | **留内核**（LLM seam 形状真源，已在契约清单） |
| `providers-doc.ts` | 524 | 1（`providers-store`） | 留内核（平台：`~/.lantai/providers.yml` 权威读写） |
| `providers-store.ts` | 465 | 3（`runtime` / `shell/boot` / `shell/rows/workspace`） | **留内核平台** |
| `model-meta.ts` | 284 | 5（`live` / `model-sync` / `providers-doc` / `types` / `settings`） | 留内核（被上表三件依赖） |
| `catalog.ts` | 250 | 2（`settings` / `workspace`） | 留内核平台（工作区装配读目录） |
| `error-catalog.ts` | 199 | 2（`agent.ts` / `retry.ts`） | 留内核（agent 运行时错误分类） |
| `oauth.ts` | 187 | 1（`live`） | 留内核（`live` 与设置页共用；OAuth 面经桥） |
| `live.ts` | 163 | 1（`workspace`） | 留内核平台（工作区造 provider） |
| `credentials.ts` | 157 | 2（`live` / `workspace`） | 留内核平台（凭据解析） |
| `thinking.ts` | 155 | **10**（agent 层 + state + settings） | 留内核（思考档位语义） |
| `vendor-templates.ts` | 145 | 2（`catalog` / `settings`） | 留内核共享（模板数据表） |
| `custom-headers.ts` | 133 | 1（`providers-doc`） | 留内核（providers.yml 写入面） |
| `index.ts` | 116 | 1（`live`） | 留内核（`ctx.llm` seam 装配） |
| `transport.ts` | 100 | 3（`composition/patch-loader` / `preset-discovery` / `plugins/loader`） | 留内核（组合层/装载链读点） |
| **`model-sync.ts`** | **73** | **0** | ✅ **随包**（唯一零内核消费者的件） |
| `idle-stream.ts` | 57 | 1（`agent.ts` 看门狗） | 留内核（运行态活性守卫） |

## 3. 判定（本单结论）

1. **`provider/**` 判内核平台面**（`types` / `providers-store` / `providers-doc` / `catalog` /
   `live` / `credentials` / `oauth` / `transport` / `model-meta` / `vendor-templates` /
   `custom-headers` / `index` / `thinking` / `error-catalog` / `idle-stream` = 15 件 3,429 行）：
   内核**启动链 / 壳行 / 工作区装配 / agent 运行时**都在读它们，随包即「内核 ↛ 产物源码」违例
   （批 8a 守卫钉死）。登记方式照 §4-5 / §4-10 先例：名册 `shared` 认领 + 账本一行判据，
   **不造登记接缝**（接缝是给「内核需要、产物持有」的场景；此处内核自己就是唯一真源）。
2. **真正随包的只有两处**（内核零消费者）：
   - `provider/model-sync.ts` **73**（拉取结果落盘层，唯一写入口；消费者 = `settings-domain` 一域）；
   - `settings.ts` 的**产品专属编辑面**：`ProbeOutcome` / `ConnectionProbe` / `modelMaxTokens` /
     `defaultBaseUrl` / `isFactoryBaseUrl` / `addProvider` / `removeProvider` / `persistSecrets` /
     `removeSecret` ≈ **132 行**（消费者 = `settings-domain` 一域；经宿主桥的键随之销账）。
3. **`settings.ts` 余部（≈ 480 行）留内核**：应用配置核心（`AppSettings` 四节 +
   `loadSettings` / `saveSettings` / `onSettingsSaved` / `canvasWheelMode` / `autoUpdateCheckEnabled`）
   + provider 数据面内核读点（`getActiveProvider` / `updateProvider` / 五个 model helper / 形状三件）
   ——**它们有 1~12 个内核读点**，且 `effectiveModels` / `onSettingsSaved` 被多产物共用 ⇒ 按判据留内核。
4. **口径更正（写给账本）**：账本 §2.1 原估「settings.ts 703 + provider 3,502 ⇒ 9f ≈ −700」偏大；
   两次实测后切完 = **−205 行**（`model-sync.ts` 73 + 产品专属编辑面 132），其余 4,000 行**有内核平台
   读点或跨产物取用** ⇒ 判共享，不做接缝。
   与 §4-10（`asset-kinds` 581 判共享）同一条判据。

## 4. 子批切分与出口判据

| 子批 | 内容 | 出口判据 |
|---|---|---|
| **9f-1** ✅ **已落**（2026-09-26） | `provider/model-sync.ts`（73）→ 包内 `model-sync.ts`；`settings.ts` 的产品专属编辑面 **7 个值符号 + 2 个类型再出口**（`provider-data.ts` 129 行）——类型两件（`ProbeOutcome` / `ConnectionProbe`）留内核（`ProviderSettings.lastTest` 自用、类型零成本）；`settings.ts` 706 → **607 行**；顺带消除三处 .tsx **直连内核 `settings.ts` 取值**的副本病灶；宿主面 324 → **327 键**（撤 4 补 7：`applyFetchedModels`/`addProvider`/`persistSecrets`/`removeSecret` 销账；补 `findVendorTemplate`/`getVendorTemplateVendors`/`VENDOR_TEMPLATES`/`getCatalogVendors`/`getDefaultModel`/`modelMaxTokens`/`intentOf`）| `plugin-home:report` 三色数字不变（半迁移不进三色账）；`settings-domain/entry.js` 含 `applyFetchedModels` / `isFactoryBaseUrl` 真身；`settings.ts` 物理行 705 → ≈ 570 |
| **9f-2** | 账目登记：名册 `settings-domain` 加 `shared`（15 件 provider 平台件）+ 账本 §2.1 / §5 / §6.5 落账；`provider/**` 判据一行 | `plugin-home:report` 灰区不变、已认领 +15（provider 件转被认领）；`doc-check` 绿 |
| **9f-3** | 真机验收：重建 exe + CDP——设置页 Provider 面（列表/详情/添加/OAuth/拉取模型）与「配方改文件」写读路径活性；启动零装载失败 | 四条探针（键数 / 产物真身 / 设置页 DOM / 零异常） |

每批门禁照旧：`npm run build` · `npx vitest run` · `npx biome ci .` · `npm run verify:convergence` ·
`npm run build:builtin-plugins` · `npm run gen:host-surface`（改宿主面时）+ 再跑产物构建 ·
`npm run doc-sync` + `npm run doc-check`；收尾重建 exe + CDP + 账本 §5/§6 重测。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| `persistSecrets` / `removeSecret` 是**凭据写面**，随包后写路径改由产物发起 | 二者只经 `rpc-contract`（平台强制层，产物可直用）⇒ 无接缝；真机验收专测「保存密钥 → 读回」一条 |
| `addProvider` / `isFactoryBaseUrl` 依赖 `provider/vendor-templates`（内核共享数据表） | 包内直引内核共享件（与 `asset-domain` 引 `asset-kinds` 同款）；账目按「已被产物认领」记 |
| 销宿主面键时漏改某产物 host.aliased（三处同步纪律） | 每键先 `grep` 全产物 host 面确认单一消费者，再撤；`satisfies FaceBridgeSeal` 由 tsc 兜底 |
| 判共享后「改 provider 数据层仍需重建 exe」 | 承认：这是平台面判据的代价（§4-10 同款取舍）；真需热更的是**编辑面**，本批已把它随包 |

## 6. 不做什么

- **不为 `provider/**` 造登记接缝**（内核自己就是真源；接缝是给「内核需要、产物持有」的场景）。
- **不把 `provider/types.ts` 搬进产物**（50 个内核读点 + 契约载体）。
- **不动**与本批无关的在途文件（`.github/workflows/**` · `engine/**` · 他窗的 `workspace.ts` /
  `chat-session.ts` 改动）；`workspace.ts` 的产品装配欠账归**批 10**
  （[`workspace-activation-channel-design.md`](workspace-activation-channel-design.md)）。
