# 兰台 Provider 系统设计定稿

> 生成：2026-08-07 · 状态：定稿基线（施工按本文档执行，改动需回写本文档）
> 2026-08-07 二次全链路审计 + 收口已完成，见文末「二次审计与收口（P4）」——此后端/前端状态以该节为准。
> 范围：API Key 加密存储（后端）→ Provider 抽象层 → 模型目录 → 设置 UI 全链路。

## 一句话

Provider 系统 = **两种协议实现**（Anthropic / OpenAI 兼容）+ **一份数据目录**（7 厂商 JSON）+ **一条创建入口**（`createProvider` 工厂），密钥由 Rust 后端加密保管，前端只经 RPC 存取。

## 现状盘点（2026-08-07 实测）

### 后端（src-tauri）— 基本完好

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/credential.rs` (632 行) | DPAPI / Keychain / SecretService 三平台密钥存储 | ✅ 完整，有测试 |
| `src/rpc.rs` L414-426 | `credential_store/get/delete` 路由 | ✅ 完整 |
| `src/commands/identity.rs` | 命令封装 | ✅ 完整 |
| `credential.rs` L13-14 注释 | 声称「失败回退 localStorage 明文」 | ⚠️ 与 2026-08-04 治理后的现状矛盾 |

### 前端核心（src-ui/src/provider/）

| 文件 | 职责 | 状态 |
|---|---|---|
| `types.ts` (207 行) | Message/Chunk/ToolCall/Provider 抽象 + classifyError + sanitizeToolPairing | ✅ 完整，测试覆盖 |
| `anthropic.ts` (433 行) | Anthropic Messages API：手写 SSE + 4 缓存断点 + thinking effort | ✅ 完整 |
| `openai.ts` (307 行) | OpenAI 兼容（DeepSeek/Moonshot/Minimax/Qwen） | ✅ 完整 |
| `index.ts` (34 行) | `createProvider` 工厂（按 kind 分派） | ✅ 完整 |
| `retry.ts` (59 行) | 3 次指数退避重试 | ✅ 完整，测试覆盖 |
| `shared.ts` (109 行) | sseEvents / prewarm / fetchJsonWithTimeout / write 预览提取 | ✅ 完整 |
| `catalog.ts` (123 行) | 静态目录 + 动态模型合并 | ✅ 完整，测试覆盖 |
| `catalog/*.json` | 7 厂商模型数据（deepseek 4 / anthropic 14 / openai 29 / moonshot 10 / minimax 3 / qwen 5 / glm 3 / ollama 3 / opencode 2） | ✅ 已含 GLM/Ollama；opencode 为 GO 套餐网关端点（2026-08-17 新增） |

### 设置与 UI

| 文件 | 职责 | 状态 |
|---|---|---|
| `settings.ts` (227 行) | ProviderSettings/AppSettings + 密钥落盘治理 + add/remove/update | ✅ 已治理 |
| `SettingsPanel.tsx` + `settings/*` | 五 tab 设置面板；Provider 页已拆为信号源控制台 | ✅ 可用（P5 重构） |
| `ModelSelector.tsx` (233 行) | 可搜索下拉 + 动态刷新 | ✅ 可用 |
| `runtime.ts` L16 | `createProvider` import | ⚠️ 死代码（未使用） |

### 使用方（不参与改造，只消费）

- `workspace.ts:601` — 主 Agent provider 创建（启动时一次）
- `agent.ts:1447` — 主对话循环 `prov.stream`
- `agent.ts:2045-2080` — 摘要模型自动选择（运行时读 settings）
- `FileTranslatorPanel.tsx:275` — 翻译器复用 provider 基础设施
- `chat-session.ts` / `ChatFooter` / `ChatBeacon` — 展示当前 provider

### 测试基线

- `tests/provider-*.test.ts` 5 个文件 59 用例 **全绿**（vitest）
- `npx tsc --noEmit` 通过

## 数据流全景

```
                      ┌─────────────── Rust 后端 ───────────────┐
  SettingsPanel ──RPC──> credential_store/get/delete ──> credential.rs
       │                     (DPAPI 加密, credentials.enc)
       │ localStorage(无明文)
       v
  settings.ts (AppSettings.providers[])
       │
       v
  createProvider(settings) ──kind──> anthropic.ts | openai.ts
       │
       ├─ prewarm()     → 预热 TCP+TLS
       ├─ fetchModels() → /models 动态模型 → mergeDynamicModels(catalog)
       └─ stream()      → POST + SSE → Chunk* → Agent 主循环 / 摘要 / 翻译器
```

## 数据契约（定稿）

### ProviderSettings（settings.ts）

```ts
interface ProviderSettings {
  kind: 'anthropic' | 'openai'; // 协议，不是厂商
  name: string;                 // 唯一标识（credential 的键名也用它）
  apiKey: string;               // 会话内明文，持久化权威=加密凭据
  baseUrl: string;              // 完整端点前缀（含 /v1）
  model: string;
  thinking?: string;            // 仅 anthropic：''|'off'|'low'|'medium'|'high'|'max'|数字
}
```

铁律：
1. `apiKey` **永不落 localStorage**（settings.ts saveSettings 抹空）——权威在 `persistSecrets` 写入的系统加密凭据
2. `name` 全局唯一——它是 provider 身份、credential 键、动态模型合并键的三合一

### ProviderSettings.headers 与配方（2026-09-17；2026-09-24 配方改文件批）

网关怪癖（如 OpenCode GO 强制的 `x-opencode-session`）此前只能改代码发版——
本版做成用户可编辑数据：

- `ProviderSettings.headers?: Record<string, string>`：写入边界严格校验、加载边界
  容忍毒化（`provider/custom-headers.ts`；同 INVARIANTS #11）。三方言请求
  （stream / prewarm / fetchModels）一并携带；**合并序「自定义头在前、内核必需头与
  凭据头在后」且按键（小写）去重**——HTTP 头名大小写不敏感，同名不同大小写会被
  Fetch 合并成 `"a, b"` 污染凭据头（实测钉住），故自定义头不能覆写
  `Authorization` / `x-api-key`。
- 设置页「高级」面：请求头文本编辑（每行 `Name: Value`，注释行忽略）。

**⚡ 2026-09-24 配方改文件批：导入/导出两个动作退役，配方 = 一份磁盘文件。**

病灶：配方此前只是设置页里一段剪贴板 JSON（导出 = 复制、导入 = 粘贴套用）——
没有落点、不能 diff、不能进 git、agent 碰不到，每次分享/复用都要人来回复制粘贴。
现在它是**一份 YAML 文件**：复制文件即导入，文件本身就是导出，agent 直接改。

- **用户级**（唯一权威面）：`~/.lantai/providers.yml`；**项目级**（可选）：
  `{工作区}/.lantai/providers.yml`，同 id **整节覆盖**用户级（一个仓库的内网网关
  不该污染全局）。路径由 Rust 侧计算（`plugin_assets::providers_file`，尊重
  `HOLOGRAM_PROVIDERS_FILE`），RPC `providers_dir` 只回目录、前端拼文件名。
- **一行 provider = 一个顶层键，键名即身份**（= 系统凭据键）。可写字段：
  `kind` / `baseUrl` / `model` / `models` / `thinking` / `headers` / `modelOverrides`
  / `modelMeta` / `authMode` / `oauthProvider`。
- **权威三分（互不重叠，各自只有一处）**：意图 → 本文件；密钥 → 系统凭据库
  （`apiKey` 写进文件 = 点名报错——明文落盘会被误分享）；**运行态读数**
  （`lastTest` 连接探针、`catalog` 目录快照）→ localStorage，不进文件（照 DSH
  `settings-file`「文件里只放用户层」的分工）。存量迁移：首启时文件还没有内容 ⇒
  把旧 localStorage 存档里的 provider 行写出去；此后文件即权威。
- **热生效**：Rust `providers_watcher.rs`（mtime 轮询 1s + settle 去抖，照
  `composition_watcher` 同款）emit `providers:changed` → 前端 `providers-store`
  重读 → 投影换新 + 复用 `settings-saved` 广播（UI 重读 + 逐会话重解析）。
- **写盘保注释**：UI 保存是「读-改-写 + leaf-diff」（`providers-doc.applyProvidersDoc`，
  照 DSH settings-file 的 YAML 渲染）——只手改动的叶子值、只删没了的键，手写注释与
  排版在未触及的节点上逐字保留（阵列内注释与改动标量的行内注释会随值走，空间归一为
  单空格——与 DSH 记录的限制同款）。
- **校验纪律**（照 DSH「boot fails loud, reload keeps last good」落到本仓库语义）：
  **逐节校验**——坏节只坏自己（点名到 provider、该节回落上次可用值、其余节照常）；
  **整份解析失败** ⇒ 保留上次可用文档 + 报错 + **拒绝写盘**（绝不覆盖人手稿）。
  错误面在 设置 → 提供方 → 配置文件卡片（路径 / 本行错误 / 其它节错误 / 重读入口）。
- **agent 可直接读写**：prompt 段 `provider-config` 注入文件绝对路径与可改字段清单；
  沙箱读写白名单（`sandbox.rs`）与安全层（`permissions/safety.rs`）按**精确文件名**
  放行 `providers.yml`（`.lantai` 整目录不放行）。

### ModelDescriptor（types.ts）

```ts
interface ModelDescriptor {
  id: string; kind: 'anthropic' | 'openai'; provider: string;
  baseUrl: string; reasoning: boolean;
  input: 'text'[];            // ← 定稿：仅 text。多模态未落地前禁写 'image'
  cost: ModelCost; contextWindow: number; maxTokens: number;
}
```

### Provider 接口

```ts
interface Provider {
  name(): string;                              // 提供方身份（settings.providers[].name）
  model(): string;                             // 真实模型 id（2026-09-12 立；会话覆盖后的生效值）
  stream(signal, req): AsyncGenerator<Chunk>;  // 唯一真实路径
  prewarm?(): void;
  fetchModels?(): Promise<ModelDescriptor[]>;
  lastModelMeta?(): Record<string, ModelMeta>; // 同一次拉取的元数据（落盘面真源，2026-09-11）
}
```

> ⚠️ `name()` 与 `model()` 是两回事，**不可混用**（2026-09-12 事故）：前者是提供方
> 身份（如 `commandcodegoat`），后者是被调用的模型（如 `deepseek/deepseek-v4.1-flash`）。
> 可观测面（`turn/start` / `request/start` 载荷、`llm response` 日志）历史上把
> `name()` 填进名为 `model` 的字段，排查时被误导。开放面契约 v25 起两者分账。

## 架构裁决（半成品问题逐条定稿）

| # | 现状现象 | 裁决 | 落点 |
|---|---|---|---|
| 1 | kind 仅 anthropic/openai 两种 | **保持**。新厂商优先走 openai 兼容端点；协议不兼容才新增 kind（现阶段无此需求，不做） | 本文档 |
| 2 | deepseek beta 模型挂 kind=anthropic | **保留**。这是特性——DeepSeek 提供 Anthropic 兼容端点；目录里加注释说明「kind=协议，provider=厂商」 | catalog 注释 |
| 3 | `input: ['text','image']` 图像假声明 | **砍**（P0 时点）。Message.content 是 string，请求构建器无图像块；等真实传图入口出现再做（breaking change，单独立项）。**修订（2026-09-09，multimodal-image B1-B5 落地）**：传图入口已建——content 保持 string（引用旁挂 `Message.images`，纯文本 wire 形态字节不变），已知 vision 款 catalog seed 声明已开闸 + 目录外款经 `ModelOverrides.input` 补声明（见 §modelOverrides）；「假声明」前提失效，正/负清单由 `tests/provider-catalog.test.ts` 精确钉死 | anthropic.ts/openai.ts fetchModels |
| 4 | anthropic.ts `reasoning_tokens: 0` 写死 | **保留 + 注释**。Anthropic Messages API usage 无此字段，0 是事实正确 | 注释 |
| 5 | 动态模型 `reasoning: false` 写死 | **修**。按模型 id 启发式（含 think/reasoning/思考 关键词）；静态目录元数据仍优先。**修订（2026-09-11）**：启发式收口到 `provider/model-meta.guessReasoningFromId`（按协议分野，anthropic/responses 两条既有内联判定一并收编），且升级为「端点披露优先、启发式兜底」——端点给 `supported_parameters`/`capabilities` 证据时以证据为准，启发式猜测绝不进落盘元数据表（见文末 §模型元数据拉取与持久化） | openai.ts / model-meta.ts |
| 6 | 快速添加 chips 只填 name+kind | **修**。chips 同步带出 `defaultModel.baseUrl` | SettingsPanel.tsx |
| 7 | `defaultPricing` 硬编码三厂商 | **修**。优先读 catalog `cost`，读不到才走现有 fallback | settings.ts |
| 8 | runtime.ts 死 import | **删** | runtime.ts |
| 9 | credential.rs 过时注释 | **修**。对齐「apiKey 权威=加密凭据，localStorage 仅非敏感配置」 | credential.rs |
| 10 | 无「测试连接」 | **P1 新增**。复用 prewarm/fetchModels 或直接最小 stream 探测 | SettingsPanel.tsx |
| 11 | 主对话流无空闲超时 | **P1 新增**。参照 callSummaryLLM 60s idle 模式（agent.ts:2085） | ~~agent.ts~~ → provider/idle-stream.ts（P4 提取，三处复用） |
| 12 | provider 切换重建链 | **验证项**。确认 `agent:config-changed` 事件 → `Workspace.applyAgentConfig` 重建 agent；文档锁定它为唯一切换入口 | 验收 |
| 13 | SSE 不解析 `event:`/多行 data | **保持**。所有目标服务商均单行 data；边界写入 shared.ts 注释 | 注释 |
| 14 | 目录缺 GLM/Ollama | **可选**。ollama 走 `http://localhost:11434/v1` openai 兼容，apiKey 可空；按需手写条目即可 | catalog/*.json |
| 15 | 目录数据维护（价格/窗口） | **定稿口径（2026-08-07）**：目录 = 开箱体验优化，非必需。全部消费点已有 fallback（clampMaxTokens 不钳制 / 窗口 fallback 200K / 摘要 fallback 主模型 / 徽章显示 LIVE / defaultPricing 硬编码回退）。厂商不提供元数据接口是行业现状；成熟 agent 软件（Chatbox/Cline/Cherry Studio）同为「手写列表 + /models 拉 ID」。**远程价格表（models.dev / LiteLLM GitHub raw）不做自动拉取**——国内网络 models.dev 不通、GitHub raw 时好时坏，引入启动依赖得不偿失。**修订（2026-09-11，实测推翻前半句）**：「厂商不提供元数据接口」对**聚合网关不成立**——实测用户网关 `/models` 69/69 条带 `context_length` + 人类可读 `name`（OpenRouter 系还给 `architecture.input_modalities` / `supported_parameters`，Gemini 给 `inputTokenLimit`，Ollama `/api/show` 给 `capabilities` + `model_info.<arch>.context_length`）。故改为「端点披露多少就认多少」（`provider/model-meta.ts`）并**持久化**到 `ProviderSettings.modelMeta`；**远程第三方价格/元数据表仍不拉取**（裁决后半句不变） | 本文档 / model-meta.ts |

## 目录地位定稿（2026-08-07）

- **必需层**：URL + KEY + 模型名（手填或 /models 动态拉 ID）——无目录可跑
- **开箱层**：静态 catalog JSON（baseUrl/kind/默认模型）——低频手写维护
- **可选增强层**：远程价格同步（models.dev/litellm）——**不做**。要最新价格时按需手改 JSON

## 实测缺陷修复记录（2026-08-07）

### 缺陷 1：读 KEY 链路断裂 — key 前后被加双引号（已修）

- **症状**：key 存好后再读回前端，最前/最后面多出字符（JSON 双引号）
- **根因**：`rpc` 返回 JSON 编码字符串（`"sk-xxx"` 带引号，全仓库调用方均 `JSON.parse`），唯独 `settings.ts restoreSecrets` 直接 `stored.trim()` 未解析。2026-08-04 治理（localStorage 不再存明文）前此路径从未真正走到——旧版 localStorage 有明文 key，restoreSecrets 跳过读凭据；治理后首次暴露
- **修复**：`parseRpcString`（settings.ts）——JSON 编码/纯字符串/`null` 三态兼容；`restoreSecrets` 走它
- **回归测试**：`tests/settings-secrets.test.ts`（7 用例，mock bridge）

### 缺陷 2：模型下拉偶发失效 — 点选后 model 不填充（已修）

- **症状**：ModelSelector 点选模型偶发不填充
- **根因**：P1-A 改造把 `updateProvider` 从函数式 `setSettings(s => ...)` 改成闭包快照 + `commit`。`ModelSelector` 的 onChange 连续两次调用（model + baseUrl 自动填充），第二次基于旧 settings 克隆 → **覆盖掉第一次的 model 修改**。原版函数式更新可安全累积，是 P1-A 引入的回归
- **修复**：`updateProvider` 改回函数式 setSettings（连续调用安全累积）；落盘统一收口到 `useEffect(settings → saveSettings)`（updater 内不可做副作用）
- **验证**：tsc + 全量测试；下拉两连改场景人工验证

### 缺陷 3：key 填进去没被保存 — 回填竞态 + 误删（已修）

- **症状**：输入 key 后重开面板 key 丢失；多 provider 时其他凭据可能被误删
- **根因 A（回填竞态覆盖）**：面板挂载时 `restoreSecrets(loadSettings())` 异步回填——快照在用户已输入后到达时整体 `setSettings(s)`，**把刚填的 key 冲掉**（回填快照里 key 为旧值/空）
- **根因 B（空 key 误删）**：`persistSecrets` 对空 key 执行 `credential_delete`——state 与凭据因异步回填暂时不同步时，遍历会把**未回填的 provider 凭据误删**
- **修复**：
  - 回填改函数式合并：只填充仍为空的 key，不覆盖用户已输入
  - `persistSecrets` 空 key 不再 delete（删除只走 `removeSecret`：删 provider / 用户主动清空输入框）
  - `commitSecret` 只处理当前 provider：非空 store、空 removeSecret
- **回归测试**：persistSecrets 只 store 非空 + 永不误删（settings-secrets.test.ts，9 用例）

## 防再乱的规则（施工期强制）

新增一个 provider 的五步检查表（写进 CLAUDE.md 或本文档附录）：

1. `catalog/{name}.json` 加模型条目——`kind` 填**协议**（openai 兼容优先），`provider` 填厂商名
2. `baseUrl` 写完整端点前缀（含 `/v1`）
3. SettingsPanel 零改动（chips/ModelSelector 自动出现）
4. `tests/provider-catalog.test.ts` 补断言（厂商名、默认模型、kind）
5. 真机验证一轮带工具对话

## 分期施工计划

### P0 — 定稿落地（纯清理，零行为风险）

> 状态（2026-08-07）：**已完成**。

- [x] 删 `runtime.ts:16` 死 import（P1-C 顺手完成，含 `defaultPricing` 死 import）
- [x] 修 `credential.rs` L13-14 过时注释（对齐「apiKey 权威=加密凭据」）
- [x] 砍图像假声明：anthropic.ts/openai.ts fetchModels `input: ['text']` + **全量清理 6 个 catalog JSON 中 52 处 `"image"` 声明**
- [x] 动态模型 reasoning 启发式（openai.ts `guessReasoning` 导出，think/reason/r1/deepseek-v[34] 关键词）
- [x] anthropic.ts `reasoning_tokens: 0` 加注释（Anthropic usage 无此字段，0 是事实正确）
- [x] shared.ts SSE 边界注释（单行 data 契约，不支持 event:/多行）
- [x] catalog.ts 顶部注释（kind=协议非厂商；JSON 不支持注释故落于此）
- [x] 补测试：静态目录无 image 断言 + mergeDynamicModels 合并/跳过 + guessReasoning 启发式（provider-catalog.test.ts）
- [x] **额外修复**：`cargo test --bin hologram` 编译失败（utils.rs 残留 `clamp_depth` 死测试引用已删函数）——删除后解锁整个 bin test target：192 测试全绿，含 credential 4 项
- **验收**：`npx vitest run provider` 全绿（749 全量）+ `npx tsc --noEmit` 0 错 + `cargo test --bin hologram` 192 通过 ✓

### P1-A — 设置面板即时保存（方案 A，2026-08-07 定稿）

**原则**：面板是编辑器，不是事务——任何改动立即落盘，无 dirty 状态，无丢失风险。

| 操作 | 行为 |
|---|---|
| 字段编辑（baseUrl/model/thinking/temperature 等） | onChange 即时 `saveSettings`（localStorage 轻量） |
| apiKey 编辑 | onBlur 触发 `persistSecrets`（避免逐字符写 DPAPI 文件） |
| 切换当前 Provider | 立即 `saveSettings` |
| 添加 Provider | 一步到位表单（name/kind/key/baseUrl/model），确认即落盘 + 写凭据 + 激活 |
| 删除 Provider | confirm 后落盘 + `removeSecret` |
| 关闭面板 | 无确认弹窗（无未保存态） |
| 「应用」按钮 | 仅触发 onSave 重建链（字体缩放 / agent 重建 / 会话恢复），带成功反馈 |

**移除**：`dirty` state、`handleClose` 的 dirty 弹窗（L246-249）、`handleSave` 的 confirm 校验弹窗（L258-259，改为行内红字提示）。

- [x] SettingsPanel.tsx 即时保存改造（commit / commitSecret / handleApply，2026-08-07）
- [x] 添加表单一步到位（name/kind/key/baseUrl/model；catalog chips 带出 baseUrl+默认模型）
- **验收**：改字段→关闭→重开不丢；切换/添加/删除重开生效；`persistSecrets` 仅 key 失焦时写

### P1-B — 思考强度落地（三断点）

- [x] anthropic 「自动」模式补 `budget_tokens`（anthropic.ts L295，缺字段部分 API 版本 400）
- [x] `disableThinking` 语义统一到 anthropic：createProvider 时 `disableThinking → thinking='off'`（index.ts），翻译器/摘要路径自动受益
- [x] ~~openai 协议思考强度 UI：仅落「深度思考」开关 + 说明文案（不编造 effort 参数——仓库无 DeepSeek effort 证据，API 支持后再加）~~ → **已过时（2026-08-09）**：DeepSeek V4 官方文档已支持 `reasoning_effort`，见 P12
- **验收**：anthropic 翻译轮 thinking 关闭；「自动」模式真机不再 400；Agent 页开关真机生效

### P1-C — 其余协议硬化

- [x] `defaultPricing` 优先读 catalog（settings.ts：getModel 有 cost 即用，否则回退硬编码）
- [x] 「测试连接」按钮（SettingsPanel：最小 1-token 流式请求，15s 超时，classifyError 分类提示）
- [x] 主对话流空闲超时（agent.ts L1447：60s 无 chunk 视为挂起，自动中止并提示；外部 signal 只转发不直传）——P4 已提取为 `provider/idle-stream.ts`，主循环/摘要/main.ts 数据流解析三处复用
- [x] 顺手清理 runtime.ts 死 import（createProvider / defaultPricing，P0 遗留）
- **验收**：tsc 0 错 + 746 测试全绿；真机 DeepSeek 一轮对话

### P2 — 目录收口（2026-08-07 定稿：远程价格表不做，仅按需手写）

- [ ] ollama.json（本地端点，apiKey 可空路径验证）——**按需**手写
- [ ] glm.json（zhipu openai 兼容）——**按需**手写
- ~~远程价格同步（models.dev / LiteLLM GitHub raw）~~ **取消**：国内网络 models.dev 不通、GitHub raw 不稳定，目录非必需（裁决 #15），引入启动依赖得不偿失
- **验收**：`getCatalogProviders()` 含新厂商，五步检查表全过

### P3 — 真机回归（用户挂起，2026-08-07 暂不做）

- [ ] DeepSeek（openai 协议）带工具一轮
- [ ] Claude（anthropic 协议）带 thinking + 工具一轮
- [ ] 翻译器一轮（disableThinking 路径）
- [ ] 摘要模型自动选择路径一轮（触发条件：多 provider 有 key）——P4 已修复该路径的死链（见下），此前从未真正触发过
- [ ] 设置保存 → provider 切换 → 旧会话继续（重建链验证项 #12）

## 二次审计与收口（P4，2026-08-07 完成）

> 动机：P0–P1 后用户仍反馈「改来改去到处都有问题」。对后端→前端做全链路复审，结论：**协议层健康，病灶在胶水层**——读设置的姿势被复制了 5–6 份且漏了 1 份，造成静默断链。以下为修复定稿。

### 修复的断链级 bug

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 摘要模型自动选择从未生效 | `selectSummaryProvider` 读裸 `loadSettings()`，key 不落 localStorage 后 `keyed` 恒空 | 改走 `loadSettingsWithSecrets()`（agent.ts），新增 summary-model-selection.test.ts 钉死 |
| 清空 key 后旧 agent 仍在服务 | `ChatCore.setAgent(null)` 对 null 早退，旧 factory/provider 保持注册 | setAgent(null) 真正拆除：清 factory 注册 + `clearPanelAgents`（chat-core.ts / chat-session.ts） |
| 会话工厂双快照拼配置 | factory 用新设置算定价/窗口，却传外层闭包捕获的旧 provider | workspace.ts `_buildProvider()` 唯一创建收口；factory 从自己的新快照构建 provider |
| main.ts 数据流 NL 解析裸奔 | 无超时、signal 永不中止、忽略 ChunkType.Error | 接入 `streamWithIdleTimeout` + Error chunk 处理 + 静态 import |

### 收口（消除「复制即腐烂」）

- `loadSettingsWithSecrets()` = 读设置（含密钥）的**唯一入口**；`restoreSecrets` 不再被外部直接调用
- `getActiveProvider` 5 份内联克隆全删，统一 import（保留 agent.ts 无 fallback 变体——语义不同，非克隆）
- 60s 流式空闲超时提取为 `provider/idle-stream.ts`（主循环 / 摘要 / 数据流解析三处复用）
- 厂商 URL 字面量唯一化：`ANTHROPIC_DEFAULT_BASE_URL`（anthropic.ts）+ `PROVIDER_PROTOCOL_DEFAULTS` / `defaultBaseUrl()` / `isFactoryBaseUrl()`（settings.ts，catalog 优先）
- 设置变更响应式：`onSettingsSaved(cb)` 订阅（saveSettings 触发），ChatFooter/ChatBeacon/ChatHint 不再渲染期裸读 localStorage；ChatHint 不再解析 `[Agent] provider=` 日志串
- `sanitizeToolPairing` 去掉 agent 侧重复调用（provider 线格式关口仍在）
- SettingsPanel 刷新模型改用组件态快照（与测试连接一致）

### 删除的死代码

`_setActiveProvider` · `ProviderSettings.maxTokens` · `AppSettings.permissions` · `AgentOptions.maxTokens` 全链（option→字段→传参，唯一写入恒 0）· buildToolRegistry→agent-builder→coding.ts 的三层死 `provider` 参数 · `parse_keychain_dump_providers`（macOS 死函数 + 其测试）· identity.rs 三个从未注册的 `#[tauri::command]` 摆设

### 后端加固（credential.rs / rpc.rs）

- **损坏不再静默丢 key**：`credentials.enc` 解密失败先改名备份为 `credentials.enc.corrupt-<ts>` 再重建；备份失败则整体报错，永不覆盖仅存密文
- **原子写入**：tmp + rename（Win 覆盖语义兜底），崩溃不留半截文件
- **进程级写锁**：store/delete 串行化，8 线程并发测试不丢 key；get 无锁（原子 rename 保证一致读）
- **不堵 executor**：rpc 三个 credential 分支改 `spawn_blocking`
- **错误不再混淆**：macOS get 区分「未找到(44)」与真错误；macOS/Linux delete 幂等但真错误上抛
- `com.lantai.app`（cred_path）vs `com.lantai.hg`（tauri identifier）不一致**故意保留**——路径迁移 = 现存用户丢 key，已注释钉死

### 行为变化（有意为之）

- `addProvider` 改 catalog 优先：添加 `deepseek` 带出 DeepSeek 官方端点而非 `api.openai.com`（对齐裁决 #6）
- ChatHint 在 key 配好即显示就绪（不再等 setupAgent 诊断串）
- `isFactoryBaseUrl` 识别面扩到 qwen/moonshotai/minimax 出厂 URL（原 3 个 URL 数组的超集，同意图）

### 已知限制（如实记录）

- macOS/Linux 凭据分支在 Windows 主机上 cfg 编译不到，仅走查未真机验证
- `clearPanelState` 丢弃 exec 状态时未 `stop()`（handle dispose 会中止 runtime 侧，影响小）——既有缺口，列入后续
- `src-tauri/tests/hologram_dispatch_test.rs` 集成测试编译失败（engine API 漂移）——**既有问题，与 provider 无关**，需单独修
- biome check 仓库级基线噪音（未触及文件同样失败），构建门禁以 tsc 为准

### P4 验收（2026-08-07 实测）

- `npx tsc --noEmit` 0 错 · `npx vitest run` **771 全绿**（758 既有 + 13 新增）· `cargo test --bin hologram` **196 全绿**（含凭据 9 项）· 全量 diff 第三方复查结论 SHIP

## P5 — Provider 设置页 UX 重构（2026-08-08 完成）

> 动机：用户反馈 Provider 页「乱七八糟」。把 Provider 标签页从「下拉 + 竖排表单」重构为
> 「信号源控制台」，并修复两个数据丢失级缺陷（删除/清空 Key 的凭据时序错误）。

### 交互结构

- **左侧信号源列表**：每行一个 provider，状态点 = 未配置 / 已配置 / 正常 / 异常，
  当前使用中带「当前」角标；底部「＋ 添加信号源」。
- **右侧调谐控制台**：头部（名称/协议徽章/状态 pill/设为当前）+ 连接配置
  （API Key / 模型 / Base URL / Anthropic 思考等级）+ 诊断（测试连接 + 上次测试）+ 危险区（删除）。
- **添加弹层**：目录 chips 一键添加（name/kind/baseUrl/model 全带出，添加后自动聚焦 Key 输入框），
  或自定义表单（名称/协议/Base URL/模型/Key）。
- **面板内确认弹窗**（ConfirmDialog）替换原生 alert/confirm——删除、清除 Key、
  放弃未保存更改、空 Key/空模型强制保存。
- **保存按钮仅在 dirty 时可用**；dirty 状态在面板头部以「有未保存更改」chip 展示。

### 状态模型

- `ProviderSettings` 新增可选 `lastTest`（`{ status, latencyMs, at, message? }`，
  非敏感，随 localStorage 持久化）——左侧状态点与「上次测试」行的事实源。
- 测试结果按 provider 独立存储（`Record<name, phase/msg>`），切换信号源不再串台。
- `keyDirtyMap`（本会话内 Key 是否未保存）驱动「已保存到系统凭据 / 未保存 · 保存后写入」chip；
  保存成功后整体复位。
- `providerStatus()`（settings/status.ts）为状态推导唯一入口。

### 凭据时序（P0 修复）

- **删除 Provider**：只暂存删除（state + dirty），`removeSecret` 移到保存流程——
  用户取消/关闭面板不再丢 Key。
- **清除 Key**：显式「清除」按钮或手动清空输入框都会暂存清除；保存时才真正删系统凭据，
  杜绝「清空后重开面板 Key 复活」。输入新 Key 自动取消清除暂存。
- **Base URL placeholder / 重置** 按当前 provider 的 catalog 默认值计算，不再写死 deepseek。
- **模型刷新无 Key** 时明确提示「请先填写 API Key」，不再伪装成「未获取到新模型」。

### 组件拆分（SettingsPanel 单文件瘦身）

```
SettingsPanel.tsx（外壳：tab / dirty / 保存 / 凭据暂存）
└── settings/
    ├── ProviderPage.tsx       编排：选中态、测试 Map、添加/删除/清除确认
    ├── ProviderList.tsx       左侧信号源列表
    ├── ProviderDetail.tsx     右侧控制台（复用 ModelSelector）
    ├── AddProviderSheet.tsx   添加弹层（目录 chips + 自定义）
    ├── ConfirmDialog.tsx      面板内确认弹窗
    └── status.ts              状态推导 / 延迟 / 时间格式化
```

### 验证（2026-08-08 实测）

- `npx tsc --noEmit` 0 错
- `npx vitest run` **798 全绿**
- vite dev（浏览器 mock）+ headless Chrome CDP 真机冒烟：13 项交互断言全过
  （初始状态 / 无 Key 测试提示 / 添加弹层 / chips 一键添加 / Key 聚焦 /
  未保存 chip / 删除确认弹窗 / 删除后回落），零运行时错误

## P6 — 保存拆域 + 聊天面板模型切换（2026-08-08 完成）

> 用户反馈三点：① Provider 保存不应与全局设置共用一个事务；② 聊天面板左下角
> 模型按钮点开直接弹设置面板，不是真正的模型切换；③ 思考强度缺聊天面板入口。
> 用户明确拒绝自动保存（不接受其复杂度），故采用**手动、按域独立保存**。

### 保存拆域（Provider 独立保存）

- `SettingsPanel` 拆出 `providerDirty` 与全局 `dirty` 两条状态线。
- Provider 页所有变更走 `onCommitProvider`（只标 providerDirty），
  页内出现「有未保存的信号源更改 + 保存 Provider」保存条；
  Provider tab 下隐藏底部全局保存按钮。
- 全局保存（Agent / 显示等 tab）与 Provider 保存共用 `runSavePipeline()`
  （落盘 + 删暂存凭据 + 写新 Key + 重建 Agent）。落盘是全量的，
  因此任一保存成功后两个 dirty 标志一并复位，避免保存条/按钮残留假状态。
- 关闭确认按 dirty 组合给出不同文案；移除全局保存时空 Key/空模型的
  confirm 拦截（空 Key 是合法状态，如本地端点）。

### 聊天面板模型切换器（ModelSwitcher）

- 左下角模型徽章点击展开弹层（不再直接弹设置面板）：
  - 当前信号源模型列表（静态目录 + 动态模型，含推理/上下文/价格徽章）
  - 其他信号源一键切换（空模型自动带出 catalog 默认模型）
  - 思考强度：Anthropic 信号源 = effort 下拉（自动/低/中/高/极限/关闭）；
    OpenAI 兼容信号源 = 深度思考开关（全局 disableThinking）
  - 底部「管理 Provider…」进入完整设置
- 任何操作立即 `saveSettings` + `bus.emit('agent:config-changed', { reason: 'model-switched' })`（与设置面板保存同一重建入口）。

### 验证（2026-08-08 实测）

- `npx tsc --noEmit` 0 错
- `npx vitest run` 全绿
- CDP 真机冒烟：Provider 页保存条出现/独立保存、聊天面板弹层展开/切模型/切信号源/思考强度

## P7 — 按词收敛：Protocol（2026-08-08 完成）

> 依据 CONTEXT.md「模型接入」词表的第一刀：把「协议」从字符串字面量与三份 `kindLabel`
> 拷贝中收敛出来。

- `provider/types.ts` 新增 `Protocol = 'anthropic' | 'openai'` 领域类型；
  `ProviderSettings.kind` / `ModelDescriptor.kind` 统一引用它。
- **存储键名 `kind` 保持不变**（localStorage 遗留名），只收类型与展示层；
  改存储键名需带迁移，见类型注释。
- `ui/react/settings/protocol.ts` 是协议标签唯一事实源（`PROTOCOL_LABELS` /
  `protocolLabel` / `isAnthropic`）；删除 ProviderList / ProviderDetail / ModelSwitcher
  三份 `kindLabel` 与 AddProviderSheet 内联三元。
- ModelSelector / ProviderDetail / AddProviderSheet 的 props 与 entry 类型统一为 `Protocol`。

### 验证

- `npx tsc --noEmit` 0 错
- provider/settings 相关 48 项测试全绿

## P8 — 按词收敛：ConnectionProbe（2026-08-08 完成）

> 依据 CONTEXT.md「ConnectionProbe」词条：把「测试连接」的三个表示
> （持久化结果 / UI 瞬时态 / 嵌入 provider 的结构拷贝）收敛为一套类型。

- `settings.ts`：`ProviderTestResult` 更名 `ConnectionProbe`，新增 `ProbeOutcome`；
  `ProviderSettings.lastTest` 字段名与存储形状不变（遗留名），仅类型统一。
- `ProviderDetail`：删除内联的 `lastTest` 结构拷贝（改为引用 `ConnectionProbe`）；
  `TestUiState` 更名 `ProbeUiState`，`phase` 类型基于 `ProbeOutcome`。
- `ProviderPage`：`tests` Map 与探针结果统一使用 `ProbeUiState` / `ConnectionProbe`。

### 验证

- `npx tsc --noEmit` 0 错，`ProviderTestResult` / `TestUiState` 零残留
- provider/settings 相关 48 项测试全绿

## P9 — 按词收敛：ProviderId（2026-08-08 完成）

> 依据 CONTEXT.md「ProviderId」词条：把 Provider 身份从裸 `string` 中救出来，
> 类型层面钉死「身份 = 系统凭据键 = 动态模型合并键」三合一语义。

- `CONTEXT.md` 新增 **ProviderId** 词条。
- `settings.ts`：`ProviderId`（branded string）+ `providerId()` 唯一构造入口；
  `ProviderSettings.name` / `AppSettings.activeProvider` / `removeSecret` /
  `addProvider` 全部类型化。运行时仍是 string，localStorage 存储键零迁移。
- `ProviderPage`：`tests` / `keyDirtyMap` / `keyVisibleMap` 从 `Record<string,…>`
  改为 `Map<ProviderId,…>`；`selected` / `delTarget` / `clearTarget` 类型化。
- `ProviderList` / `AddProviderSheet` / `ModelSwitcher` 身份相关 props 与 entry 类型化。
- `SettingsPanel`：`pendingDeletes` / `pendingClears` 改为 `ProviderId[]`。

### 验证

- `npx tsc --noEmit` 0 错
- provider/settings 相关 48 项测试全绿；全量 798 通过
- CDP 真机冒烟 8/8：tests Map / keyDirtyMap / keyVisibleMap / 添加 / 删除 / 保存条，零运行时错误

## P10 — 按词收敛：ThinkingPolicy（2026-08-08 完成）

> 依据 CONTEXT.md「ThinkingPolicy」词条：把「思考策略」的档位、标签与预算映射
> 收进单一模块，消除 ProviderDetail / ModelSwitcher 的选项重复与 anthropic.ts 的内联映射。

- 新增 `provider/thinking.ts`：`ThinkingEffort` / `ThinkingMode` / `StoredThinking` 类型、
  `THINKING_MODES`（档位 + 标签，唯一事实源）、`THINKING_EFFORT_BUDGETS`（档位 → token 预算）、
  `DEEP_THINK_LABEL`（全局开关文案）、`withThinkingDisabled`（全局开关对单 Provider 的生效语义）。
- `settings.ts` / `anthropic.ts`：`thinking` 字段类型收敛为 `StoredThinking`
  （含历史遗留数字预算）；存储字段名与形状不变。
- `anthropic.ts`：内联 effortMap 删除，改引 `THINKING_EFFORT_BUDGETS`。
- `provider/index.ts`：`disableThinking → 'off'` 的语义收口到 `withThinkingDisabled`。
- `ProviderDetail` / `ModelSwitcher`：选项列表改引 `THINKING_MODES`；两处「深度思考」文案统一用 `DEEP_THINK_LABEL`。

### 验证

- `npx tsc --noEmit` 0 错；档位文案零残留（只在 thinking.ts）
- provider/settings 相关 48 项测试全绿
- CDP 真机冒烟 11/11：保存拆域 + 聊天面板切换器 + 思考强度写入，零运行时错误

## P11 — 按词收敛：Vendor（2026-08-08 完成）

> 依据 CONTEXT.md「Vendor」词条：`ModelDescriptor.provider` 实际承载的是厂商
> （如 deepseek / anthropic），不是 Provider 实例——字段更名 `vendor`，语义钉死。

- `provider/types.ts`：`ModelDescriptor.provider` → `vendor`。
- 6 个 catalog JSON 的 `"provider"` 键全部改为 `"vendor"`（65 条目录条目；
  catalog JSON 是仓库数据而非用户存储，零迁移）。
- `catalog.ts`：`findModels` / `searchModels` 按 `vendor` 匹配；
  `getCatalogProviders` 更名 `getCatalogVendors`（返回厂商名）。
- `openai.ts` / `anthropic.ts` 的 `fetchModels` 描述符、`ModelSelector` /
  `ModelSwitcher` 排序过滤、`agent.ts` 摘要模型选择的 `keyed` 匹配全部改用 `vendor`。

### 验证

- `npx tsc --noEmit` 0 错；`getCatalogProviders` / `m.provider` 零残留
- provider/settings/摘要模型相关 51 项测试全绿；全量 798 通过
- CDP 真机冒烟 19/19：目录 chips 一键添加 / ProviderId 交互 / 聊天切换器 / 思考强度，零运行时错误

## P12 — OpenAI 兼容 effort 落地：DeepSeek reasoning_effort（2026-08-09）

> 动因：P1-B 裁决「不编造 effort 参数」基于当时仓库无 DeepSeek effort 证据；
> 2026-08-09 复查官方文档，DeepSeek V4（deepseek-v4-pro / deepseek-v4-flash，
> 2026-04-24 发布）已支持 OpenAI 格式 `thinking` + `reasoning_effort`。
> LiteLLM / Cherry Studio / vLLM 均已修复 pass-through，领域已确认。

### 事实（官方文档）

- DeepSeek V4：`thinking: {type: enabled|disabled}` + `reasoning_effort`
  有效值 `high`（默认）/ `max`；`low`/`medium` 服务端静默按 `high`，`xhigh` 按 `max`。
- OpenAI 官方：`reasoning_effort: low|medium|high`（无 max）。
- Anthropic：无 `reasoning_effort`，思考强度 = `thinking.budget_tokens`（已实现）。

### 方案：统一档位 → 每家 wire 参数（fan-out，不做「服务端自动转换」）

| 档位 | DeepSeek V4 | OpenAI 官方 | Anthropic |
|---|---|---|---|
| 自动（''） | 不传（默认 high） | 不传 | auto budget 16000 |
| 低 low | UI 不提供（wire 按 high） | `low` | 4000 |
| 中 medium | UI 不提供（wire 按 high） | `medium` | 8000 |
| 高 high | `high` | `high` | 16000 |
| 极限 max | `max` | 降级 `high`（UI 标注） | 32000 |
| 关闭 off | `thinking:{type:'disabled'}` | 同左 | 不发送 thinking 块 |

### 落地

- `provider/thinking.ts`：`EffortVendor` / `effortVendor()`（name / baseUrl / model
  识别）+ `toOpenAIEffort()`（wire 映射）+ `thinkingModesFor()`（UI 档位可见性）
  作为唯一事实源。
- `provider/openai.ts`：`OpenAIConfig.thinking` 接管 per-provider 档位，请求体
  发送 `thinking` + `reasoning_effort`；不再只依赖全局 `disableThinking`。
- `provider/index.ts`：openai 分支与 anthropic 一致，`disableThinking → thinking='off'`。
- UI：ProviderDetail / ModelSwitcher 按厂商显示档位：
  DeepSeek = 自动/高/极限/关闭；OpenAI = 自动/低/中/高/极限（按高发送）/关闭；
  Anthropic 维持六档；其余 OpenAI 兼容厂商（MiMo/GLM 等）无 effort 证据，
  维持「深度思考」开关、不编造参数。

### 验证

- `npx tsc --noEmit` 0 错；新增 thinking 映射 + openai 请求体测试全绿
- 真机回归（并入 P3 挂起项）：DeepSeek 高/极限/关闭 各一轮对话

## P13 — 全链路断链根治：LLM 本地反向代理（CORS 绕开）+ 切换链路修复（2026-08-16）

> 动机：用户实测「配置多个供应商，切换后全部无法实际调用」。审计结论——
> **provider 请求从 WebView 直接 fetch 受浏览器 CORS 限制**：Anthropic 返回 403 且无
> `Access-Control-Allow-Origin`（浏览器必被挡）、OpenAI 当前不可达；只有 DeepSeek 等少数
> 厂商放行。而全仓库测试全部 mock 了 fetch，从未真机跑通一条真实 LLM 调用（P3「真机
> 回归」一直挂在「用户未做」），所以代码全绿但真实链路从未打通。成熟 Agent 软件
> （Cline / Cherry Studio / Chatbox）均把 LLM HTTP 走后端转发以绕开 CORS。

### 修复：Rust 本地反向代理（`src-tauri/src/llm_proxy.rs`）

- 起一个 `127.0.0.1:14570`（被占则 +1 重试）的 hyper server + reqwest client：
  前端把真实目标 URL 放 `x-hologram-target` 头，POST/GET 到本代理；代理流式转发、
  **SSE 逐块透传**，并给每个响应加 `Access-Control-Allow-Origin: *`。
- 前端 `provider/transport.ts`：`proxyFetch()` 优先走代理，端口取不到（dev/测试）回退直连。
  `openai.ts` / `anthropic.ts` / `shared.ts` 的 `sendWithRetry` / `fetchJsonWithTimeout` /
  `prewarmEndpoint` 全部改经 `proxyFetch`。前端既有 SSE 解析（`sseEvents` / `readSSE`）不变。
- 安全：仅绑定 127.0.0.1；只接受 GET/POST/OPTIONS；目标必须是绝对 http/https
  （允许本地端点如 Ollama）；请求体 64MB 上限。
- RPC：`rpc.rs` 新增 `llm_proxy_port`，前端 `transport` 惰性取端口并缓存。

### 修复：切换链路两个运行时 bug

1. **`Agent.setProvider` 未写穿 ctx 服务表**（`agent.ts:431`）——热切换后新 spawn 的
   子 Agent 从 `context.child()` 继承旧 provider/旧 Key，导致「切换后子任务仍用旧供应商」
   与「provider 调用混乱」。修复：`setProvider` 里 `this._ctx?.set('provider', prov)`。
2. **清空 API Key 的拆除路径不重置 `_lastAgentCfgKey`**（`workspace.ts`）——重新填入相同
   `name/kind/key/baseUrl/model` 时 `_agentRebuildKey` 与残留键相同，重建被跳过，
   provider/agent 永远起不来。修复：拆除分支 `this._lastAgentCfgKey = null`。

### 验证（2026-08-16 实测）

- `cd src-tauri && cargo test llm_proxy` 通过（含端到端 SSE 透传测试：代理把上游两段
  `data:` + `[DONE]` 完整透传）。
- 前端 `npx tsc --noEmit` 0 错；`npx vitest run tests/provider-*` 全绿
  （新增 provider-transport.test.ts：代理转发 / 直连回退 / 端口缓存）。
- 真机 CORS 证据：DeepSeek 放行 CORS（直连可通）；Anthropic 403 无 CORS 头（必须走代理）。

> 遗留：P3 的「带工具真实对话 / Claude thinking / 翻译器 / 摘要」仍应在 Tauri 真机各跑一轮
> 才算完整验收（此前的审计只到代码层）。

## P14 — 能力协商：per-model 档位声明 + 真 socket 测试层 + 用户覆盖（2026-08-22）

> 动机：用户反馈「各家的思考强度、最大输入输出、上下文窗口全都不一致，中间还有
> 各种各样的问题」。P12 的 vendor fan-out 表（effortVendor 按 name/baseUrl/model
> 字符串嗅探 + low→high 静默归一）正是这类不一致的温床——每来一个新厂商就要改
> thinking.ts 的代码，且「选了低实际发高」这种静默替换让问题无从诊断。
> 解法参照 DSH 的 adapter-owned capability 架构（决策记录
> `2026-07-24-adapter-owned-reasoning-effort-capabilities.md`）：**模型支持什么
> 是数据，不是代码**——per-model 声明、seam 层验证、UI 照单渲染、清单外档位
> 在任何网络 I/O 之前响亮报错、永不静默钳制或替换。

### 数据模型（ModelDescriptor，provider/types.ts）

- `thinkingEfforts?: readonly ThinkingEffort[]` — 声明支持的档位（canonical 词表
  子集）。缺省 = 无证据 = UI 不显示档位选择器 + 请求永不发送 effort 参数。
- `thinkingOff?: boolean` — 「关闭」是否可表达。
- `deepseekThinking?: boolean` — DeepSeek 思考方言（reasoning_effort 需
  `thinking:{type}` 包裹；api.deepseek.com 及透传该方言的网关声明）。
- canonical 词表扩为六档：`minimal/low/medium/high/xhigh/max`（对齐 pi-ai canonical 集；
  存储值向后兼容，旧存量子集不受影响）。
- `ProviderSettings.contextWindow?/maxTokens?` — 用户覆盖（见下）。

### 数据来源与裁决纪律

- **信源**：厂商官方文档核实（2026-08-22 用户核实 DeepSeek V4 `low` 档成立——
  该修正推翻了 pi-ai thinkingLevelMap 的 `low=null` 声明，也证明单一信源会 stale）；
  pi-ai `thinkingLevelMap` 仅取 **wire=canonical 恒等条目**（glm-5.2 的 `low=high`
  替换映射**不采纳**——静默替换正是本 Phase 要杀的东西）。
- **per-route 语义**：同一模型 id 经不同路由的声明可以不同（DSH 同款裁决）——
  直连 deepseek 条目声明 `low/high/max + off + 方言包裹`；opencode zen 网关条目
  按 pi-ai 网关证据声明 `high/max`（bare，无包裹）；qwen-token-plan 网关的
  deepseek 条目声明 `high/max` + 包裹。目录外/动态模型一律零声明。

### wire 翻译（openai.ts buildChatRequest，声明驱动）

| 存储档位 | 声明内行为 | 声明外/无声明行为 |
|---|---|---|
| 自动 `''`/数字遗留 | 不发参数 | 不发参数 |
| 命名档位 | `reasoning_effort` 原值；DeepSeek 方言加 `thinking:{type:'enabled'}` 包裹 | **抛错**（`assertEffortDeclared`，发请求前；无声明模型放行——目录外端点兼容） |
| 关闭 `off` | DeepSeek 方言 `thinking:{type:'disabled'}`；OpenAI 官方 5.1+ `reasoning_effort:'none'` | 不发参数（全局 disableThinking 对未知模型降级为模型默认，不编造） |

- **修复 P12 潜伏 bug**：P12 曾对 OpenAI 官方端点发送 `thinking:{type:'enabled'}`
  包裹（DeepSeek 扩展字段，OpenAI 严格校验会 400，从未真机验证）。P14 起包裹
  仅由 `deepseekThinking` 声明驱动。
- anthropic.ts：budget 方言 uniform（`THINKING_EFFORT_BUDGETS` 六档 2048→32000），
  目录声明了清单的模型过同一 `assertEffortDeclared` 门禁；目录外不拦。

### UI（ProviderDetail / ProviderPage）

- 档位表 = `thinkingOptionsFor(getModel(model))`：自动档恒有、声明档位按词表序、
  声明 off 才有关闭。无声明 → 不显示选择器（回退全局「深度思考」开关）。
- 新增「上下文窗口 / 最大输出 token」覆盖字段（存 `ProviderSettings
  .contextWindow/.maxTokens`，0=用目录值）——目录数据 stale 时无需发版即可纠正。
- 生效优先级：Agent 全局设置 > Provider 覆盖 > 目录值 > 200K 默认
  （`workspace._effectiveContextWindow`）；maxTokens：Provider 覆盖 > 目录值
  （`clampMaxTokens` 三参形态，`createProvider` 收口传参）。

### 真 socket 测试层（tests/provider-realsocket.test.ts）

本地 `node:http` SSE server 走完整链路：`createProvider → stream → proxyFetch`
（测试环境无 Tauri → `llm_proxy_port` mock 回退 → 端口 0 → 自动直连）→
`sendWithRetry → sseEvents → Chunk`。覆盖：

- OpenAI 兼容全链路（文本/推理/工具流/usage/cache 拆解/粘连帧 TCP 语义）
- Anthropic 全链路（message_start/工具流/thinking 签名/usage/粘连帧）
- wire 断言：DeepSeek thinking 包裹 + `reasoning_effort:low` 原值；Anthropic
  budget 16000 + `x-api-key`/`anthropic-version` 头；maxTokensOverride 真钳制
- 流内 error → Error chunk；**声明外档位 → 服务器零请求**（I/O 前拦截实证）
- 空闲超时（`streamWithIdleTimeout` 短超时 + 挂死流）

这一层补的是 P13 审计的「全仓库测试 mock 了 fetch、真实链路从未打通」在协议栈
维度的缺口（真机对厂商端点的回归仍是 P3 人工项）。

### 退役清单（本 Phase 删除）

`effortVendor` / `toOpenAIEffort` / `thinkingModesFor`（name/baseUrl/model 嗅探链）
/ `EffortVendor` / `OpenAIWireEffort` 类型 / P12 的 low→high、max→high 静默归一。

### seam 收口：退役 _agentRebuildKey 手工 diff（恒 swap，2026-08-22）

P13 #2 修复的「拆除路径忘重置 diff 键」、历史遗漏的 temperature、本次差点漏掉的
maxTokens 覆盖——三个 bug 同根：**手写字段枚举必然漂移**。P14 退役整条链：

- 删除 `Workspace._agentRebuildKey` / `_lastAgentCfgKey`（摘要键 + 跳过分支）。
- `applyAgentConfig` 改**恒 swap**：每次配置信号都从同一份新鲜快照
  `_buildProvider(s)` 重建 provider 并原子换引用（`setProvider` + 
  `forEachAgent` + ctx 写穿）。在途请求持旧引用跑完、下一轮起用新 provider——
  DSH 快照语义的单活跃 provider 形态。
- 成本论证：`setProvider` = 引用 swap + ctx map 写 + 清摘要缓存（廉价）；
  信号频率 = 用户保存/切换动作（非热路径，`applyAgentConfig` 本就每次做
  `loadSettingsWithSecrets` RPC）；prewarm fire-and-forget 3s 自灭。
- 守护测试：`tests/provider-hotswap.test.ts`（注释剥离后的静态扫描 + 拆除路径
  行为断言）。

**为何不做 DSH 式完整注册表**（LlmService 多路由 + 原子 replace；历史名 ProvidersService，
2026-08-27 平台化 Phase 1 升格更名）：DSH 的
registry 服务「多 provider 路由并发在册」的场景（每请求按 route 选 adapter、
waterfall 拦截、配置面声明路由）；兰台是**单活跃 provider** 形态——`_buildProvider`
单一创建收口（P4 已建）+ `setProvider` 写穿（P13 已建）+ 恒 swap（本次）即为
兰台的正确 seam。把 DSH 的注册表照搬过来服务一个永远只有一个 active provider 的
系统是架构空转；`composition/services.ts` 的 LlmService 通道（S1 注册语义）在方言收口时兑现为活通道（见下节）。

### 已知边界（如实记录）

- opencode/qwen 网关对 `low` 档的透传行为未核实（pi-ai 网关条目 `low=null`），
  按网关证据保守声明；厂商侧变化时改 JSON 即可，代码零改动。
- glm/mimo/qwen 自有思考方言（`enable_thinking` 等）未接入——无恒等 wire 证据，
  零声明处理，待官方文档核实后加条目。
- o3-deep-research / o4-mini-deep-research 零声明（pi-ai 无该模型 tlm 数据）。

## P15 — Provider 数据模型重构：可用模型列表 + 最近使用默认 + per-model 覆盖（2026-08-26）

> 动机：从「一 Provider = 一模型」到多模型化（本 Phase 前已由方案甲实现会话级覆盖），
> 暴露 P14 遗留的三个反人类点：① 创作坞下拉倒静态目录全集（配一个显示一大堆）；
> ② 「默认模型」与「可用模型」两个控件并列、上下文/最大输出按 Provider 一个值管所有模型；
> ③ 「设为当前」是全局单 provider 时代的遗物。参考 DSH 的模型一等对象语义，重构数据模型。

### 数据模型（当前真源，settings.ts）

> ⚡ 2026-09-23 三层重构后：`models` = **启用集**、`catalog` = **目录快照**、
> `model` + 会话覆盖 = **选中**；思考档位下沉到 `ModelOverrides.thinking`
> （见文末「追裁 · 模型配置面三层 + 思考档位下沉」）。

```ts
interface ProviderSettings {
  kind: 'anthropic' | 'openai';
  name: ProviderId;          // 连接身份 = 凭据键 = 动态模型合并键（三合一不变）
  apiKey: string;            // 会话内明文，持久化权威 = 加密凭据
  baseUrl: string;
  model: string;             // 新会话默认 = 最近使用（自动跟从创作坞，非手动设置）
  thinking?: StoredThinking; // 本家默认档位（未单独设置过档位的模型用它）
  lastTest?: ConnectionProbe;
  models?: string[];         // **启用集**（创作坞下拉可选面；缺省 = [model]，零迁移）
  catalog?: string[];        // **目录快照**：最近一次拉取的全量 id（2026-09-23 三层）
  modelOverrides?: Record<string, ModelOverrides>; // per-model 覆盖（用户手改）
  modelMeta?: Record<string, ModelMeta>;           // per-model API 拉取元数据（2026-09-11）
}
interface ModelOverrides {
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[]; // 输入模态声明（multimodal-image B5 · D-8①）
  thinking?: StoredThinking;    // per-model 思考档位（2026-09-23 思考下沉）
}
interface ModelMeta {        // provider/model-meta.ts —— 端点真披露的字段（不编造）
  name?: string; contextWindow?: number; maxTokens?: number;
  input?: ('text' | 'image')[]; reasoning?: boolean;
  thinkingEfforts?: ThinkingEffort[]; thinkingOff?: boolean;
  fetchedAt: number;
}
```

- **`models` = 用户的启用集**（2026-09-23 三层重构修订）：Provider 页「模型目录」里
  勾选的模型；创作坞下拉只列它（`effectiveModels`），不再倒静态目录全集。
  「从 API 拉取」（现名「刷新目录」）**只写 `catalog` 与 `modelMeta`，不动本字段**
  ——配一个提供方不再等于把端点给的几十上百个模型全灌进配置面（用户实测病灶）。
  vendor 一律用 provider 名（自定义 provider 复用目录模型 id 时分组/切换对准该
  provider，杜绝写错家 400）。
- **`model` = 新会话默认 = 最近使用**：`compose-store.setModel` 定向写该 provider 行
  model + activeProvider（新鲜 loadSettings 读改写单字段，不整份快照 → A4 clobber
  不复活）；只影响新卷/未改卷出生默认，已存在会话走覆盖（applyAgentConfig 会话级
  分支按会话解析，A1「切一个拖累全部」不复发）。
- **`modelMeta` = API 拉取元数据的持久化层**（2026-09-11 彻查修复，见文末追加裁决）：
  「从 API 拉取」经方言的宽容解析层（`provider/model-meta.parseModelEntry`）把端点
  真披露的字段（`context_length` / `name` / `architecture.input_modalities` /
  `supported_parameters` / `inputTokenLimit` / Ollama `capabilities`+`model_info.*`）
  解析出来，由 `plugins/builtin/settings-domain/model-sync.applyFetchedModels`（批 9f-1 起随包；此前 `provider/model-sync.ts`）单一入口落进暂存 → 保存持久化。
  此前只落 id 列表，元数据随进程消失，聚合网关的模型重启后一律吃 200K 假默认。
  **四层解析链（单一权威源 `settings.ts`）**：`modelOverrides` ?? `modelMeta` ??
  目录 seed ?? 默认。消费面全部走链：`modelContextWindow` / `modelMaxTokens` /
  `modelInput` / `modelReasoning` / `modelThinkingEfforts`，以及方言请求期的
  `modelDescriptor(p, id)`（经 `ProviderRuntimeArgs.describeModel` 注入，使 provider
  级元数据真正抵达 wire——档位协商 `thinkingCapability` 与输出钳制 `clampTokens`）。
  设置页「参数」面板按模型标注来源（手动设置 / API 拉取 · 日期 / 目录 / 未提供）。
- **`modelOverrides` = per-model 上下文/最大输出/输入模态（用户手改，链首）**（取代 P14 的
  per-provider `contextWindow/maxTokens` 单字段——遗留存储值在 `loadSettings` 即清洗）：
  `modelContextWindow` / `modelMaxTokens` 解析
  （覆盖 ?? API 拉取 ?? 目录值 ?? 默认）；workspace `_contextWindowFor` 与 `createProvider`
  `maxTokensFor(model)`（请求时按模型解析，取代构造时固定的 maxTokensOverride）消费。
  **`input` = 输入模态覆盖**（2026-09-09，multimodal-image B5 · D-8①）：生效声明走
  `modelInput(p, modelId)` 合并链（`['text','image']` 覆盖 ?? API 拉取 ?? 目录
  `ModelDescriptor.input` ?? `['text']`——不编造能力），三消费面同链——`createProvider`
  的 `inputModalities` 能力戳（请求期图投影 D-8③）、创作坞附图门禁（入口显隐 D-8②）、
  ModelSelector「视」徽标。GLM-4V/Qwen-VL 等目录外 vision 模型经 Provider 页参数面板
  「视觉模型」开关补声明（on = `['text','image']`，off = 清覆盖回落声明）；catalog seed
  已声明已知 vision 款（anthropic/openai 全线 + deepseek vision-exp 独立款——主线按 DSH
  权威保持纯文本）。
- **`activeProvider` = 最近使用的 provider**（「设为当前」按钮退役）；Provider 列表
  角标叫「新会话默认」。`addProvider` 仍设 activeProvider = 新家，`removeProvider`
  回落 next[0]。
- **思考档位常驻**：per-model 档位来自生效描述符声明（API 拉取或目录，P14）；无声明
  的模型给「自动/关闭」协议安全兜底（assertEffortDeclared 对 ''/off 不拦），不再整控件
  消失。现实：当前主流端点均不披露档位清单——`thinkingEfforts` 在拉取面只认端点显式
  给出的数组（过 canonical 词表），未披露即不显示档位选择器（不编造）。

### 退役清单（本 Phase 删除）

- 「设为当前」按钮 + ProviderDetail 的 `isCurrent` / `onSetCurrent`（activeProvider
  语义反转，不再手动指定）。
- 「默认模型」目录选择器 + `handleModelChange`（可用模型列表为唯一模型配置面）。
- per-provider `ProviderSettings.contextWindow / maxTokens`（改 per-model
  `modelOverrides`）；`maxTokensOverride`（构造时固定）→ `maxTokensFor(model)`。
- `ModelSelector.onRefreshModels` 死代码（拉取能力迁 Provider 页「可用模型」区）。

### P14「为何不做 DSH 注册表」口径更新

P14 写「兰台是单活跃 provider 形态」，P15 后修正为：**多 provider 在册、activeProvider
只是新会话默认（最近使用），不承担运行期路由**——请求仍由 live provider 按名现解析
（Phase C），会话热切换按会话解析（方案甲）。DSH 的多路由注册表依旧不照搬（架构空转），
`composition/services.ts` 的 LlmService 通道在方言收口时兑现为活通道（同节追裁）。seam 仍是
`_buildProvider` 单一创建收口 + live 按名现解析。

## 追加裁决 · 方言收口与目录装载（2026-08-27，用户拍板「直接干到位」）

上节「空壳保留」口径自本日起废止——ProvidersService 从死壳变为**方言贡献道的活通道**，
但多路由注册表依然不照搬：路由权在 live 按名现解析，本道只管「协议方言怎么建」，不管
「哪个提供方被选中」。四条：

1. **方言贡献道**（LlmService 真实消费闭环兑现）：
   - `LlmAdapterContribution = { id, kind, create(rt: ProviderRuntimeArgs): Provider }`
     （2026-08-27 平台化 Phase 1 定名；替换 `{ id, factory: () => unknown }` 死形状）。
   - `createProvider` 的二元 if/else 改为方言解析：同 kind 贡献**后注册胜**
      （对齐 renderer-service 覆盖语义，dispose 分层恢复）；平台化 Phase 1 起
      内核回落分支拆除，未命中任何 adapter → `PROVIDER_DIALECT` 响亮报错并点名可用方言。
   - **修复潜伏静默 bug**：旧实现未知 kind 一律跌进 openai 分支（拼错 `"anthromorphic"`
     也能跑通但语义全错），违反宪法「错误不静默」。
2. **Protocol 类型开放集挂起**：第三方方言要新增 kind 字面量时才扩存储联合类型
   （挂在 ADR #0002 的 kind=协议语义上单独裁决）。当前贡献道的合法用法是覆盖两种内核
   方言；目录/设置仍按闭合字面量校验。
3. **目录装载 glob 化**：`CATALOG_FILES` 硬编码 import 表退役，换
   `import.meta.glob('./catalog/*.json', { eager: true })`——加厂商 = 丢一个 json 进
   目录，零代码挂载。重复 id 权威规则 = 文件名字母序先者得（字母序恰与原手排一致，
   opencode/deepseek 共享 id 的既有归属不变，tests 钉死）。
4. **P-next（未做，非遗漏）**：用户家目录 `~/.lantai/provider-catalogs/*.json`
   外置 overlay——需要异步读取道与失败面的完整设计，硬塞半成品违反本 spec 第 #3
   裁决的同源纪律。触发条件：出现「不改包体接入自定义网关目录」的真实需求。
5. **平台化 Phase 1 升格（2026-08-27 夜，agent-platformization-plan D2 修订版 · 用户拍板 A 路线）**：
   - 通道升格为平台 seam 并更名：`ProvidersService`/`ctx.providers` →
     `LlmService`/`ctx.llm`；读取面 `activeProviderContributions()` →
     `activeLlmAdapters()`；贡献类型 → `LlmAdapterContribution`。
   - **内核回落 if 分支拆除**：anthropic/openai 改由第一方
     `plugins/llm-adapters-plugin.ts` 经 `ctx.llm.register` 贡献为默认 adapter
     （loadBuiltinPlugins 表序第二行，先于外部插件保持「后注册胜」覆盖方向）；
     `provider/index.ts` 只余「贡献扫描 → 未命中 PROVIDER_DIALECT 响亮报错」。
   - 裸环境语义变更：此前未装配也走内核兜底，现响亮报错（P1-C2 显式降级）——
     生产装配恒经 loadBuiltinPlugins 无感知差异；测试以「装配复现 helper」先行。
6. **平台化 Phase 2 落地纪要（2026-08-27 深夜，agent-platformization-plan D11）**：
   - 后端能力四 seam 落地：`ctx.fs`（11 动作）/ `ctx.shell`（四动作；**ctx.subprocess
     并入 ctx.shell**——spawn/stdio/进程树即后台任务族，无第二消费者不开空通道）/
     `ctx.sessionPersistence`（六动词，含实测发现的 `log_append` 会话事件日志动词）/
     ~~`ctx.graph`~~（hologram_call 派发）——**已随图谱功能全量退役，2026-09-09**。
   - 统一形状：`composition/*-service.ts`（2026-09-14 M1 收口后 = `ContributionChannel` 单一内核，见 `composition/contribution-channel.ts`）+
     `agent/*-provider.ts` 默认 provider（动作→命令恒等映射）；fs/shell 走 dispatch
     腰注入（meta/_agent_id 全量透传），sessions 直连 typedRpc（基础设施无 meta），
     graph 走 agentInvoke（**该 seam 已退役，2026-09-09**）。
   - 强制层不旁路：gate 在 executor 管道层、先于工具 execute——P2-C3 守卫测试
     钉死「plan 激活拦截时 provider 与 dispatch 双未触」（fs/shell seam 各一）。
   - 消费面收口：tool-fs（coding.ts）/ tool-shell / agent-store / hologram holoExec
     全部改经注册表；chat-session 卷落盘与 Monaco file-viewer 保持 typedRpc（P5 统一）。

### 验证

- 每 commit 门禁：vitest 1793-1794 passed / 4 skipped · build ✓ · convergence exit 0 ·
  biome ci 0/0。
- 测试增量：compose-store（setModel 最近使用语义 + activeProvider 跟随）、
  model-selector-compact（配置面只列 / 同家多模型 / 自定义 provider 分组 / 不可用态 /
  运行中守卫 / 同款 no-op）、provider-page-staging（可用模型增删 + 默认顶位 + per-model
  参数）、composer-dock-rework（思考 pill + 兜底 + 运行中守卫接线）、
  provider-openai-thinking / provider-realsocket（maxTokensFor）。
- 实机验收：用户逐条（Provider 页可用模型 / 创作坞下拉 / 思考常驻 / 自定义 provider 分组）。

## 追裁 · 模型价格表拆除（2026-09-06 拍板）

> 动因：用户反馈「不再维护模型价格表」——手写 catalog 价格的维护成本大于收益
> （价格天然会 stale，改价需发版）；同时添加提供方页改为「拉模型 + 设默认」后，
> 模型列表来自 provider 的 `/models`（价格从 API 不可知）。压缩层曾按价格选最便宜的
> 摘要模型、估算压缩成本——经用户确认：**压缩层保留，只做价格解耦**（固定费率），
> DSH 压缩移植不启动。

### 拆除面（代码 + 数据）

1. **目录 JSON**：`cost` 字段全删（9 个 catalog/*.json）；`ModelCost` 类型与
   `ModelDescriptor.cost` 退役（provider/types.ts）。
2. **展示**：模型下拉的价格徽章 / 元信息（`$x/y per M`）删除——目录元数据只剩
   上下文窗口与推理标记；`hasMetadata` 只按窗口判定。
3. **Agent Pricing 面**：`Pricing` / `computeCost` / `AgentConfig.pricing` /
   `AgentOptions.pricing` / `AgentAssemblyInputs.pricing` / `AgentLoopHost.pricing` /
   `AgentEvent.pricing` / `setProvider(prov, pricing)` / `setPricing` / `getPricing`
   全链拆除（workspace 不再传 defaultPricing；Usage 事件不再带 pricing）。
4. **压缩解耦**（压缩层保留）：
   - `CompactionTracker` 成本估算改固定费率（DEFAULT_C_IN/OUT 保留，pricing 参数删）。
   - `maybeTune/tuneCompactionParams` 不再收 pricing。
   - 摘要模型「自动选最便宜 keyed 模型」退役（`selectSummaryProviderImpl` 删）——
     `summaryProviderImpl` 固定返回主模型（host.prov + host.contextWindow）。
   - 压缩报告去 `$` 成本行（`compactionEventCost` 删）；`hologram_compaction_stats`
     不再输出成本。
5. **生成器**：`scripts/regen-catalogs.cjs` 不再写 cost（LiteLLM 源仍可对拍窗口）。
6. **收敛**：phase-3/phase-6 的 AgentConfig 字段清单去掉 `pricing`。

### 行为变化（对用户可感知）

- 模型选择 UI 不再显示「$输入/输出每 M」价格徽章。
- 压缩统计/报告不再显示美元金额行（token 统计保留）。
- 长会话不再自动换「更便宜的摘要模型」（此前几乎未触发——见 2026-08-07 修复注）。
- **添加提供方页改为两步式（连接 → 拉模型 → 设默认）**（见 P16 追裁，若同日落地）。

### 验收

- vitest 全量绿 · tsc --noEmit 0 错 · biome ci 0/0 · verify:convergence exit 0。

## 追裁 · 模型元数据拉取与持久化（2026-09-11，用户彻查报告拍板「按 A 全链做」）

> 用户提问：「提供方从 API 拉取模型，到底有没有拉到上下文容量、视觉、思考强度这些
> 参数？是不是没把参数持久化给模型设置？」彻查结论：**一条都没落地**，且其中一部分
> 是「端点给了、我们扔了」。

### 彻查结论（修复前现状）

1. **三处 fetchModels 硬编码「只读 `data[].id`」**（openai.ts / anthropic.ts /
   responses.ts）：`name` 回落生 id、`contextWindow`/`maxTokens` 写死 0、
   `input` 写死 `['text']`、`thinkingEfforts` 一律不设。传输层（`fetchJsonWithTimeout`）
   **没有丢数据**——完整 JSON 就在内存里，是在 `.map()` 映射成 `ModelDescriptor` 的
   那一步被主动丢弃。
2. **实测反证**：用户配置的聚合网关 `api.commandcode.ai/provider/v1/models` 返回
   69 条模型，**69/69 条都带 `context_length`**（实测分布 200000×7、256000×6、
   262144×3、400000×4、500000×2、1000000×34、1048576×9、1050000×3）与人类可读
   `name`——全部被丢弃。另一家 `opencode.ai/zen/go/v1/models` 只给 id（无物可拉）。
3. **零持久化**：拉取结果只落 `ProviderSettings.models`（id 字符串数组）；
   元数据只进进程内 `catalog._dynamicModels`（且**只拉 active provider、只在
   setupAgent 那一次**）；可持久化的 `modelOverrides` 只有手工入口。后果：用户存档
   100 个模型里 98 个（gemini-vision / claude-opus / GLM / omni 系）窗口一律按
   **200000** 算（真实 200K～1.05M，最多差 5 倍）、视觉一律关闭、思考档位选择器不显示。
4. **请求期读全局 `getModel`**：方言（`thinkingCapability` / `clampMaxTokens`）
   无 provider 上下文——即便解析出元数据也到不了 wire 层。
5. **遗留死字段**：旧存储的 per-provider `contextWindow`/`maxTokens`（P14 已拆为
   per-model）代码「读都不读」，用户存档里仍留着，是最初的误配来源之一。

### 修复（全链）

1. **宽容解析层** `provider/model-meta.ts`（新）：从任意方言里认字段——`context_length`
   / `context_window` / `max_context_length` / `max_model_len` / `inputTokenLimit`
   （窗口）、`max_completion_tokens` / `outputTokenLimit`（输出上限）、
   `architecture.input_modalities` / 平铺 `input_modalities` / Ollama `capabilities`
   （视觉）、`supported_parameters` / `capabilities` / 布尔 `reasoning`（推理）、
   `thinking_efforts`（档位，过 canonical 词表过滤）、Ollama `model_info.<arch>.context_length`。
   **纪律不破（P14）**：认得就填，认不得留空——未披露字段保持「窗口 0 / input
   `['text']` / 无档位声明」的未知语义，绝不推测。id 启发式（`guessReasoningFromId`，
   原 `openai.guessReasoning` 迁入 + anthropic/responses 两条既有内联判定收编）
   只在端点未披露时生效，且**不进落盘元数据表**（猜测不是证据）。
2. **持久化面** `ProviderSettings.modelMeta`：Provider 新增 `lastModelMeta()`（工厂闭包
   side-channel，live 层回指同一次拉取的内层实例），落盘经 `plugins/builtin/settings-domain/model-sync.ts`（批 9f-1 起随包）
   的 `applyFetchedModels` **单一写入口**（字段级合并，未披露字段保留 last-good；
   空壳元数据不落盘）。
3. **四层解析链**（`settings.ts` 单一权威源）：`modelOverrides` ?? `modelMeta` ??
   目录 seed ?? 默认，落地为 `modelContextWindow` / `modelMaxTokens` / `modelInput` /
   `modelReasoning` / `modelThinkingEfforts` / `modelDescriptor`。
4. **元数据抵达 wire**：`ProviderRuntimeArgs.describeModel` 注入三方言，请求期
   `assertEffortDeclared(thinkingCapability(describe(model)))` 与 `max_tokens` 钳制
   改读 provider 作用域描述符——网关模型第一次拿到自己的窗口与档位声明。
5. **拉取点统一**：设置页手动刷新、添加提供方两步式（含 OAuth 登录后拉取）→
   `applyFetchedModels`（元数据随行落盘）；`workspace.setupAgent` 后台拉取改为
   **全部 provider**（此前只拉 active），但只落内存目录不写 settings（避免与设置页
   未保存的暂存互相覆盖）——持久化仍走「从 API 拉取」这个显式动作。
6. **遗留死字段清理**：`loadSettings` 就地删除 per-provider `contextWindow`/`maxTokens`
   （同 apiKey `"null"` 清洗惯例），下次保存落回干净状态。
7. **UI 展示来源**：Provider 页 per-model 参数面板标注每个值的来源（手动设置 /
   API 拉取 · 日期 / 目录 / 未提供），并把编造的 `200000` 占位符改为「未知」；
   模型行补「视」徽标（与创作坞附图门禁同链）。

### 行为变化（用户可感知）

- 拉取模型后，**上下文窗口 / 最大输出 / 视觉 / 推理**随 settings 持久化，重启仍在；
  聚合网关的模型不再吃 200K 假默认（实测该网关 69 条从 200K 归位到真实值）。
- 模型下拉显示 API 给的人类可读名（此前一律生 id），并新增「视」徽标。
- 设置页参数面板显示每个值的来源，不再把默认值当目录值展示。
- 后台目录拉取覆盖全部提供方（切到非活动家不再是空目录）。

### 验收

- 新增 `tests/provider-model-meta.test.ts`（25 例：各方言字段识别 / 四层链 / 落盘合并 /
  端到端「拉取 → 落盘 → 重启后生效 → 抵达请求体」）。
- 全量 vitest 279 文件 2842 passed / 4 skipped · tsc --noEmit 0 错 · biome ci 0/0 ·
  verify:convergence exit 0。

## 追裁 · 模型配置面三层 + 思考档位下沉（2026-09-23，用户实测报告拍板方案 A）

> 用户三问的落点：①「从 API 拉了 81 个可用模型，为什么创作坞的模型选择器里根本
> 没有那么多」；②「思考强度在我的 provider 里看起来是供应商级全局生效，不是分模型」；
> ③「配置模型时 API 拉到的模型从来没让我选择就全在列表里了 —— 整个 UX 是乱的」。
> 彻查结论：前两问各有硬机制（下拉链上有 `.slice(0, 30)`；思考档位是提供方行级单值），
> 第三问是**领域对象缺一层**——目录（远端事实）/ 启用（用户选择）/ 选中（跑哪一卷）
> 挤在同一个字段与同一个控件里。

### 病根（修复前现状）

1. **一个 `models: string[]` 身兼三义**：① 远端目录快照 ② 用户启用集 ③ 创作坞可选面。
   于是「从 API 拉取」必然等于「全部灌进配置面」：`AddProviderSheet.handleFetch`
   直接 `setModels(ids)`、`model-sync.mergeIntoProvider` 取 `pulledIds + 既有` 的
   **并集**（只增不减），全程没有一步问过用户「这 81 个里要哪几个」。
2. **`.slice(0, 30)`**：初版选择器（`8c00891f`）对**静态目录搜索**的「前 30 条」
   展示上限；compact 面的可选面后来换成「已配置模型」后，这条上限退化成配置列表的
   天花板——配多少都只列 30 个（且是 id 字母序前 30，多提供方时还会互相挤占）。
3. **思考档位是提供方行级单值**（`ProviderSettings.thinking`），per-model 覆盖表里
   没有它；设置页那个 select 的**档位表却只由 `provider.model`（默认模型）决定**
   ——控件长得像模型的设置，却既不绑定模型、作用域也不可见。会话侧
   `compose-store.setModel` 还把行值**快照**进会话覆盖，等于把一个档位带给之后切到的
   每个模型（「供应商级全局生效」的观感来源之一）。
4. **坞里读全局目录**：创作坞 pill 的档位表读 `getModel(model)`（进程内目录），
   设置页与请求期读 provider 作用域描述符（`modelDescriptor`）——同一模型两处可以
   显示不同的档位表（拉取失败/重启后尤其明显）。

### 修复（三层 + 下沉）

1. **目录（新 `ProviderSettings.catalog`）**：`applyFetchedModels` 只写目录快照
   （**整份替换**——远端下架的模型离开目录）与 `modelMeta`，**`models` 一行不碰**；
   空拉取不清 last-good 目录。旧存档（`models` = 历史并集）语义 = 全部已启用，零迁移。
2. **启用（`models`）**：Provider 页新增「模型目录」折叠区（搜索 + 全部添加 + 全部移除 +
   逐行「添加/移除」+ 窗口/视觉提示），**点行上的「添加」才进启用集**；已启用但不在目录里的
   （手工添加的）不受目录变动影响。「从 API 拉取」改名「**刷新目录**」——名字即新语义。
   添加弹层同样分家：拉取只填目录（**一个都不自动添加**），行首「＋」/「全部添加」才是添加，
   确认只带已添加的，目录快照随行落盘（收方不必先拉一次）。
   > ⚡ 用户 UX 复盘（同日）：行业流程是「拉取 → **再有一个添加模型的步骤**」，我们原先缺
   > 的正是这一步——所以拉取**不预勾**；唯一例外是 OAuth 登录后的模板默认模型 seed
   > （一个、且具名告知：订阅的 /models 不一定可用，空手落地会被「确认添加」拦下）。
3. **选中**：`model`（新会话默认 = 最近使用）+ 会话覆盖（compose-store）不变。
4. **思考档位下沉**：新增 `ModelOverrides.thinking` + 单一解析尺子
   `modelThinking(p, id)` = per-model 覆盖 ?? 行值。三面同链：设置页参数面板
   （每模型一行，含「随本家默认」= 清覆盖）、创作坞 pill（换源到
   `modelDescriptor(provider, model)`）、live provider 请求期。档位表同理收口到
   `thinkingOptionsOrDefault`（设置页与坞共用；无声明模型的「自动/关闭」兜底不再各抄一份）。
   行级 select 更名「**默认思考档位**」并显式标注作用域（作用于没单独设置过的模型）。
5. **会话不再快照行值**：`compose-store.setModel` 写 `thinking: undefined`（= 按目标模型
   解析）；`workspace.applyAgentConfig` / 会话工厂只把**会话显式覆盖**写进 live 的
   覆盖槽（此前未改卷的卷也被钉上全局快照里的行值，per-model 档位永不生效）。
6. **拆掉 `.slice(0, 30)`**（配置面不截断）。
7. **配方**：`catalog` 与 `modelOverrides[*].thinking` 进白名单（导出/导入对称，
   非法档位整单拒绝）。

### 行为变化（用户可感知）

- 「刷新目录」不再改变可用模型：**拉取 = 看远端有什么，添加 = 决定我用什么**（两步各有动词）。
- 创作坞模型下拉列出**全部**已启用模型（不再止于 30 条）。
- 每个模型有自己的思考档位；设置页行级那个是「没单独设置过的模型用它」。
- 创作坞 pill 与设置页显示同一个档位表与同一个生效值（同一把尺子）。

### 已知边界（如实记录）

- 档位清单仍由**模型声明**裁决（P14）：端点未披露 `thinking_efforts` 的模型，
  设置页与坞都只给「自动 / 关闭」（不编造命名档位）。网关若想开放档位，
  需在 `/models` 响应里显式声明，或在配方里带上 `thinkingEfforts` 元数据。
- **目录拉取的失败面只在设置页**（2026-09-23 用户拍板 A）：C5（2026-08-27）起
  创作坞分组头的「目录获取失败」徽标随本批撤除——坞是消费面，看到也做不了补救，
  且失败与「下拉里有哪些模型」无关（不清 last-good）；原因与重试归设置页
  「模型目录」区（`ProviderDetail` 就地显示原文 + 「刷新目录」重试）。
  `getDynamicFetchFailure` 仍是宿主桥已发布键（产物可能取用），故不随本批撤键。
- 删行不清失败标记：同一进程内用同名重建提供方会看到一条陈旧提示，直到首次拉取成功。

### 守护

- `tests/ui/provider-model-catalog.test.ts`（新增 8 例：刷新目录不动启用集 /
  行上「添加/移除」/ 全部添加与全部移除不牵连手工条目 / 拉取失败双侧不动 / 目录搜索 /
  **添加弹层的「拉取 → 添加」两步**：拉取后一个都没添加、未添加即确认被拦并指名那一步、
  添加后只带已添加的 + 目录快照随行）。
- `tests/provider-live.test.ts`（思考三层：同家两模型各发自己的档位 / 未覆盖回落行值 /
  会话覆盖压过 per-model 且 undefined 不冻结）。
- `tests/provider-thinking.test.ts`（`modelThinking` 链 + 兜底表）、
  `tests/compose-store.test.ts`（setModel 不再快照、setGlobalThinking 落 per-model）、
  `tests/providers-doc.test.ts`（**配方文件层**，2026-09-24：逐节解析/坏节只坏自己/
  整份 fatal 不覆盖手稿/注释保留的 leaf-diff 往返/身份与密钥不进文件/modelMeta 往返；
  原 `provider-recipe.test.ts` 与 `settings-provider-headers.test.ts` 的用例随之整批
  迁入这一把尺子）、
  `tests/ui/provider-page-staging.test.ts`（参数面板写/清覆盖）、
  `tests/composer-dock-rework.test.tsx`（pill 值换源 + provider 作用域档位表）、
  `tests/model-selector-compact.test.tsx`（40 个模型列全 40 条）。
