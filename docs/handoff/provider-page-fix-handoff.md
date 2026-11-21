# 兰台 Provider 页修复交接

日期：2026-11-21
分支：main
Provider 修复已提交；工作区可能仍有其他窗口的未提交改动，禁止 reset/checkout 覆盖。
下个窗口只处理剩余风险，不要重做已完成修复。

## 0. 结论

Provider 页问题来自多写入面、多真相源、缺少保存事务与配置指纹，不是单纯 CSS。

本轮已修：保存前校验、保存串行化与 revision、外部文件冲突阻断、凭据删除失败上抛、fatal last-good、删除/同名重建运行态清理。
已修：Provider 名大小写唯一、OAuth 缓存与多账号选择、探针指纹、草稿测试不落持久状态、Provider 本地状态串台、思考档位能力/会话分层。

**R1/R2 本轮已完成**：跨重启独立 intent 备份 + fatal/坏节回落；保存前 revision + 磁盘原文冲突闸 +
未点名有效节保留。实现见 `providers-store.ts`，回归见 `tests/providers-store.test.ts`。

**R5 本轮已完成（产品拍板 A + 自动回落第一个）**：`model` 从 providers.yml 意图迁出，
成为本机「最近使用」运行态；Provider 页只管理 `models`，目录/可用集移除当前模型时自动回落第一个。

**R1-R7 已完成，R9 本轮未复现**：R3 两阶段保存；R4 凭据 revision 让同长度换 Key 也失效旧探针；
R6 ModelSelector 显示元数据统一走 provider 作用域描述符；R7 添加弹层可选新行 OAuth 账号。
代码风险项已清空，只剩 R8 真实设备人工验收。

## 1. 思考档位最终语义


1. 模型能力/档位声明：Provider → 可用模型 → 参数 → 推理档位声明。
   来源为 API 拉取 / 内置目录 / 手动覆盖 / 未声明；只描述模型支持哪些档、每档 wire 值是什么。
2. 本次会话用哪一档：创作坞 → 模型选择器 → 思考；Provider 页不保存默认思考档位。

供应商返回数组：显示档位，wire 默认按档位名原值发送。
供应商返回对象：显示档位到 API 参数值的映射。
供应商未返回：显示未声明；创作坞只给自动/关闭安全兜底，可在 Provider 页手动覆盖补声明。

当前只认 canonical：minimal / low / medium / high / xhigh / max。私有词必须补明确映射，不能静默猜。

### 1.1 模型归属（R5 最终语义）

- `providers.yml` 只写 `models`（可用模型）；不再写 `model`。
- `model` = 本机「最近使用」运行态（localStorage），创作坞切模型时自动记；新卷/未改卷跟从它。
- Provider 页高亮显示「最近使用」，不是可编辑的 Provider 默认项。
- 目录/可用集移除当前最近模型：自动回落剩余列表第一个；空集则为空。
- 老文件的 `model` 走一次性迁移（`legacyModel`）；本机已有最近值时本机优先，下次 Provider 保存从文件消失。

## 2. 风险清单 R1–R9 与完成情况

### R1（高）fatal 后跨重启 last-good（本轮已完成）
- 独立键 `hologram_provider_intent_backup_v1` 保存完整 intent 快照（不含 Key / 探针 / catalog / modelMeta）。
- 每次非 fatal、非空文本装载后刷新快照；重启后先把备份灌入 last-good，因此整份 fatal 和「整节读不出来」都能回落。
- fatal 时 `providersFileReady` 仍为 false（不写盘、不剥本机意图）；UI 明示「从本机 intent 备份恢复」。
- 回归：fatal 跨重启、重启后坏节回落、localStorage 只剩运行态壳。

### R2（高）外部文件冲突仍是 watcher 级（本轮已完成）
- 保存请求携带编辑起点 `expectedRevision`；watcher 已重读而面板仍是旧草稿时直接拒写。
- 写盘前再比磁盘原文与 `lastFileText`：watcher 尚未送达的外部修改也挡住；磁盘读不到时不按空文件重建。
- 磁盘上存在、patch 未覆盖且不在 `pendingDeletes` 的有效节用 `keep` 原样保留（注释/前向字段不动）；只有显式删除才移除。
- 全局 tab 保存不再顺手重写 provider 文件，缩小无关写入面。
- 回归：外部改写直拒、过期 revision 拒写、未点名节保留、显式删除生效。

### R3（中）保存仍非原子事务（本轮已完成）
- 明确采用**两阶段语义**（跨文件/密钥库不做伪原子承诺）：
  ① provider.yml + 非敏感 settings 提交；② 系统凭据删除/写入。
- 第二阶段失败时返回 `persisted: true`：配置 dirty 熄灭，`credentialDirty` 独立置位；
  UI 显示「Provider 配置已保存；系统凭据同步未完成」+「重试凭据同步」。
- 重试只跑凭据阶段，不重写 provider 配置；删除成功的条目立即移出 pending，避免重复删。
- 关闭守卫计入 `credentialDirty`；放弃 Provider 暂存也会清掉凭据重试态。
- 回归：配置已保存 + credential_delete 失败 → 独立重试成功 → bar 消失、不重写配置。

### R4（中）probe 指纹对 Key 只记长度（本轮已完成）
- 新增本机凭据 revision（独立键 `hologram_credential_revisions_v1`）；只在
  `credential_store/delete` 真改变值时推进。
- 是否变化按不可逆 FNV-1a Key 摘要判断：同 Key 重写不误伤探针，同长度换 Key 会 bump。
- `providerConnectionFingerprint` 纳入 `credentialRevision(provider)`；摘要本身不写进
  `lastTest`，避免多暴露一份 Key 派生值。
- 回归：`sk-aaaa` → `sk-bbbb`（同长度）后旧探针 stale；同值重写不 bump。

### R5（中）model 仍兼任最近使用与显式默认（本轮已完成）
- 产品拍板：**A = 新会话跟随最近使用**；移除当前模型时**自动回落第一个**。
- `ProviderIntent` 已排除 `model`；文件解析把旧 `model` 收进 `legacyModel` 做迁移。
- `ProviderRuntime` 增加 `model`，localStorage 运行态壳持久化；`saveSettings` 在文件权威下保留它。
- 创作坞 `setModel/setGlobalModel` 改回写本机运行态，不再碰 providers.yml。
- Provider 页投影会把最近模型归一到 `models` 内；外部改 `models` 移除当前项也自动回落。
- UI 文案改为「最近使用」；AddProviderSheet 的初选模型改为「初始模型」。
- 回归：文件 model 迁移/删除、最近使用跨重启、external models 回落、Provider 页移除顶位。

### R6（中）ModelSelector 仍有全局目录显示元数据（本轮已完成）
- `configuredModelDescriptors` 改为逐模型调用 `modelDescriptor(provider, id)`：走该 Provider 的
  seed/meta/override 链，不再用全局 `getModel(id)` 拼显示元数据。
- 收起态人类名同样按当前 Provider 的 descriptor 解析；Provider 不在场才回落到目录。
- 回归：两个 Provider 复用同一模型 id，分别显示各自 meta 名字与视觉能力，不串全局目录。

### R7（低）AddProviderSheet 多 OAuth 账号没有新行账号选择器（本轮已完成）
- 已登录账号列表新增「新行使用账号」下拉：缺省「自动（最近登录）」，多账号可显式选。
- 新登录账号仍默认选中；登出选中账号或账号消失时回落 auto，不留悬空 id。
- 选中的 `oauthAccountId` 同时用于添加前模型拉取，并随新行落 `providers.yml`。
- 回归：两账号列表选择 `user-2` → 添加结果 `oauthAccountId === 'user-2'`。

### R8（必须真机验；自动化已覆盖，人工登录仍待执行）
OAuth 登录/多账号/登出；oauthAccountId 重启生效；watcher 冲突阻断；fatal 重启恢复；Key 删除失败恢复路径。
自动化已覆盖：多账号选择与落盘、两阶段凭据失败重试、conflict/fatal 重启、迁移与回落。
**仍需人工**：真实浏览器 device-flow 授权、多账号实际 token 请求、真机凭据库锁定/恢复。

### R9（已知测试环境问题；本轮未复现）
全量并行时 tests/composer-sheet.test.tsx 的 pp-goal-strip 曾有跨用例污染；单独跑通过，和 Provider 改动无关。
2026-11-30 本轮全量并行复跑：`composer-sheet.test.tsx` 5/5 通过，整套 537 文件 / 5453 用例全绿。
暂按未复现收口；若后续再现，优先查全局 store/localStorage 的测试复位。

## 3. 已验证

- tsc --noEmit：通过（全部改动完成后复跑）。
- **全量 Vitest：537 个测试文件、5453 用例全通过。**
- Provider + 设置 + ModelSelector 过滤套件 43 个测试文件、537 用例：全通过。
- 相邻组合/选择器/提示词套件 9 文件、78 用例：全通过。
- R1/R2 回归：fatal 跨重启备份恢复、坏节跨重启回落、保存时磁盘外部改写冲突、
  watcher 已重读的过期 revision 冲突、未点名有效节保留 / pendingDeletes 显式删除。
- R5 回归：旧 `model` 迁移并从 YAML 删除、最近使用落本机并跨重启、
  外部 `models` 移除当前项自动回落、Provider 页移除当前模型顶位。
- R3 回归：配置提交成功后凭据删除失败 -> 显示第二阶段待重试 -> 只重试凭据成功。
- R6 回归：同名模型 id 按 Provider 显示各自名字/视觉能力，不串全局目录。
- R4 回归：同长度换 Key 推进 revision、旧探针失效；同 Key 重写不 bump。
- R7 回归：两 OAuth 账号选择 `user-2` 后，新行 `oauthAccountId` 正确落盘。
- `composer-sheet.test.tsx` 单跑与全量并行均 5/5 通过。
- build-builtin-plugins：41 个内置插件产物自包含校验通过；face.json 指纹与
  `host-surface.baseline.json`（`aabd497d`）一致。
- 测试命令入口：cd src-ui 后跑 node .\node_modules\vitest\vitest.mjs run（文件列表见 git diff / 新增测试）。

**2026-11-21 第二批（信息架构）实测：**

- tsc --noEmit：通过。
- **全量 Vitest：541 个测试文件、5478 用例全通过**（+4 文件 / +25 用例 = 本批新增四份守护：
  `provider-detail-ia` 9 · `provider-detail-a11y` 5 · `model-reasoning-presets` 5 · `provider-console-css` 6）。
- 既有 Provider 套件（`provider-page-staging` 12 · `provider-model-catalog` 8 · `provider-model-autofill` 2
  等 7 文件 51 例）**零改动通过**——版式重构的行为零漂移证据。
- `npm run build`：通过（含 builtin 产物重建；`provider-console-ia.css` 已进 entry.css）。
- `npm run doc-check`：通过。
- **门禁现状（如实记录）**：仓库级 `biome ci .` 在 HEAD 上就是红的（锁版 2.6.7 实测 27 errors /
  15 warnings；全是未改动文件：`canvas-nav/session-sidebar.css` 的 `noDescendingSpecificity`、
  paper-shell 两片 CSS 与若干 tsx 的 formatter 漂移、`providers-store.ts` 等）。本批只保证
  **改动文件干净**（8 个文件逐个 `biome check` 通过），没有顺手改未触碰文件。
  另：`node_modules` 里 biome 是 2.6.8 而 `package-lock.json` 锁 2.6.7，2.6.8 会把仓库红数抬到 33
  ——复验请用 `npx @biomejs/biome@2.6.7 ci .`。

## 4. 部署警告

设置域 faceDeps 本次新增 `credentialRevision` / `noteCredentialDeleted` / `noteCredentialStored`
（94 键，宿主面基线指纹 `aabd497d`），产物指纹已变。只替换 dist-plugins 不够，旧 exe 会拒载新产物；
必须重建 exe：cd src-tauri && cargo tauri build（或 --no-bundle）。

**2026-11-21 第二批补充**：本批只动页面 TSX 与 CSS（新增 `provider-console-ia.css`），
**faceDeps 键集未变**（face.json 指纹仍是 `aabd497d`）⇒ 产物可只换 dist-plugins；
但若要连 JS 一起生效仍建议按上面的 exe 重建路径走一次。

## 5. 关键文件

Provider 页：ProviderPage/ProviderDetail/ModelReasoningLevels/SettingsPanel/settings-panel-helpers/AddProviderSheet/ProviderList/ProviderAdvanced/provider-data/status。
核心：settings.ts/provider/model-meta.ts/providers-doc.ts/providers-store.ts/live.ts/catalog.ts/oauth.ts。
新增测试：provider-oauth-account-selection/provider-status-fingerprint/provider-thinking-capability-view/ui/provider-model-autofill。
第二批新增：`provider-console-ia.css`（IA 分片）+ `tests/ui/provider-detail-ia.test.tsx` /
`provider-detail-a11y.test.tsx` / `model-reasoning-presets.test.tsx` / `provider-console-css.test.ts`。

## 6. 接手顺序

1. 先读本文和 docs/design/provider-system-spec.md 的思考档位/OAuth 章节。
2. 不重做第 0 节的已修项。
3. R1-R7 已完成；代码风险项清空。
4. 只剩 R8 人工真机验收：OAuth 多账号、文件冲突、fatal 重启、最近模型迁移、凭据重试、
   部署新 exe 后多账号重启仍生效。
5. UI/UX：信息架构 / 参数职责切分 / 档位预设 / 窄窗断点 / 可及名称均已落地（第 7.1 第二批）；
   像素截图基线、窄窗真机目检、读屏真机朗读仍未做，见第 7.2 节。

## 7. UI/UX 交接

> 本节曾在 `94dae0a9` 被整节误删（只删未搬迁）；2026-11-21 已从 `515310a4` 原样还原。
> 7.1 各条已抽查代码对映（推理档位声明 / 视觉三态 select / 放弃暂存并重读 / 结果已失效 /
> 新行使用账号 / 初始模型 / 最近使用高亮）。

### 7.1 已完成的 UI/UX 改动

- 思考档位区改名为「推理档位声明」，加来源 chip：API 拉取 / 内置目录 / 手动覆盖 / 未声明。
- 未手动覆盖时直接展示生效档位与 wire 映射；按钮为「手动覆盖 / 恢复声明」，不再像默认档位选择器。
- 视觉输入由二态开关改为三态 select：跟随声明 / 强制支持图片 / 强制仅文本。
- OAuth 新增「请求使用账号」选择器；缺省「自动（最近登录）」，显式选择后显示手动账号。
- 测试连接显示「结果已失效」提示；草稿测试只留在面板内，不写已保存健康状态。
- 保存条有 saving 状态、外部冲突态、「放弃暂存并重读」出口。
- 新增 Provider 弹层内联显示保存失败错误。
- 改 Key/name/kind/baseUrl 时清空旧拉取态与启用集。
- API Key / Base URL onBlur 清理会写回 React state。
- 恢复默认 URL 仅对该 Provider 默认值判定。
- ProviderDetail 按 provider key 重挂，切行不串本地状态。
- headers textarea 跟随外部 reload 同步。
- 删除后同名重建不继承旧 lastTest/catalog/modelMeta 的视觉残留。

**2026-11-21 第二批（信息架构，§7.2 欠账 ①②③④⑥ 落地；裁定与理由见
[`docs/design/provider-system-spec.md`](../design/provider-system-spec.md) 末节「追裁 · Provider 页信息架构」）：**

- 详情页改「五分区 + 粘顶锚点导航」：连接与凭据 / 模型 / 诊断 / 高级 / 文件（+ 危险区，仅多提供方）。
  分区常量 `SECTIONS` 是 nav 与 DOM 的单一真源；nav 不跟随滚动，`aria-current` 只标用户点过的那节。
- 模型区拆双列：左「可用模型」、右「单模型参数面板」——参数从行内展开改为右侧固定面板
  （行上「参数 / 收起」仍是开关；点开出现、再点收起的行为契约未变）。
- 模型目录留在双列之外（模型区尾部），只做「远端清单 → 添加/移除」；折叠头补 `aria-controls`。
- 手改档位编辑器补四个预设（关/低中高、关/中高、关/高、全部档位）+「按声明重新同步」；
  预设保留声明的 wire 映射（`high → "deep"` 不被冲回档位名）；预设组用 `fieldset + legend`。
- 窄窗断点改看**容器宽度**：`.pp-body` 是 `container-type: inline-size` 落点；
  ≤880px 模型双列→单列，≤720px 双栏→单栏（详情区去第二层滚动、导航取消粘顶）。
- 基线：本仓无 playwright —— 像素截图基线仍未做；本批落地的是**结构基线**
  （分区黄金结构 + CSS 断点契约 + 可及名称/ARIA 关系），见 §7.2 说明。

### 7.2 仍未做 / 能力边界（2026-11-21 第二批后更新）

- **像素级视觉回归基线**仍未做（需浏览器 harness：本仓只有 `scripts/cdp-shot.cjs` 手工截图，
  没有 e2e 工程）。现有替代 = `tests/ui/provider-detail-ia.test.tsx`（分区黄金结构）+
  `tests/ui/provider-console-css.test.ts`（断点/留白/minmax/焦点环契约）。
- **窄窗真机目检**未做：断点已按容器宽度落地（≤880 / ≤720）并有 CSS 契约，但真实面板缩放的手感
  仍需人工看一眼。
- **读屏软件真机朗读**未做：`tests/ui/provider-detail-a11y.test.tsx` 已覆盖可及名称、选项语义、
  `aria-expanded/controls`、`role=switch`；NVDA / VoiceOver 实际朗读仍待人工。
- 分区折叠：除「模型目录」外其余分区常开（内容再增长时再评估要不要折叠）。

