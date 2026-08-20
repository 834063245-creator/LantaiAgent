# S4 设计件 — preset realm + 热重载 + npm 分发 + 机器桥 + hello 闭环

> 状态：**已复审（代理，2026-08-20）——待用户放行后交新窗口落地**（复审记录见 §7.1：三处设计错误已实证修正）
> 性质：组合架构计划 S4 段的全量设计。前置已完成：S0（装载通道）/ S1（注册表化 + preset 维度基建）/ S2（组合外化——四域行 + 用户层 patch + 12 壳行）。
> 排程依据（计划 README 三次修订）：S4 提前到纸之前——preset realm 恰是 V5 壳切换要用的机器（观测台 preset / 纸壳 preset = 同一组合引擎的确定性双装配）；前端工程期间组合层「除 S3 外全部完工且经 hello 闭环验证」。
> DSH 实证对标：`packages/preset/agent-presets/**`（preset 词汇/发现/装载/会话记录四件套）+ `packages/bundle/web-app/cordis.patch.yml` §「agent plane moves behind presets」（host plane / preset plane 分界判据）；文件路径均给出供执行者直接查阅。

## 1. 问题陈述

S2 终态是「**应用级**组合一次解析，启动期生效」：composition-store 持单一 resolved 组合，所有会话共享。这与组合架构的终点之间还有五个缺口（G0 为复审实查新发现——比四个功能缺口更前置：它使「外部插件」这个概念目前实际为零）：

| # | 缺口 | 现状证据 | S4 目标 |
|---|---|---|---|
| G0 | **四 service 零消费者**：插件经 ctx.panels/commands/tools 注册的贡献没有任何渲染面/装配面读取——S1 建了注册表但消费闭环从未接线 | 实查：`ctx.tools.list` / `ctx.panels.list` / `ctx.commands.list` 全仓零调用（仅 services.ts 自身）；面板渲染读 `PANEL_DEFS` 常量、命令面板读 `listActions()`、工具装配读行表 | §2.3 消费闭环批（panels/commands 即时生效 + tools 下次装配生效），hello 闭环的硬前提 |
| G1 | **组合不随会话变**：每个 Agent 拿同一个 resolved；「这个会话要精简工具面 / 那个会话要全量」不可表达 | `workspace.setupAgent` 只读 `useCompositionStore.getState().resolved`（启动期快照） | per-session preset：会话挂自己的行组合（DSH agent preset 同构）；preset 选择落会话日志可重建 |
| G2 | **改 patch 必须重启**：S2 明确声明「热重载延期至 S4」 | `docs/composition/README.md` 生效时机段 | patch 热重载：改 `roster.patch.yml` → 触发在途会话外的新装配即时生效（在途会话保序不变——字节契约纪律） |
| G3 | **插件只有手放**：`~/.hologram/plugins/` 纯手工；无安装/卸载/更新通道，无示例工程 | 插件目录现状为空；plugin-store 只有装载状态 | npm tarball 源安装（Rust `plugin_install` + 设置面板「插件」节）+ `examples/plugins/hello/` 从零到跑通 |
| G4 | **机器桥无产品化通道**：外部进程桥的零件齐全（Rust `protocol_bridge_spawn` + `createTauriProcIO` + `McpClient` stdio/url 双传输 + `mcpClients` 装配入口），但无声明式挂接面——外部插件只能用宿主编译期 MCP 面，不能自带「spawn 一个机器进程」的行 | `agent/mcp/tauri-io.ts`（桥适配已组装但零消费者）；dsh-bundle `cordis.patch.yml`（模板已写过一次：hologram-mcp 行 + failOnStartupError） | 可选组件：插件 manifest 声明 mcp server → loader 经机器桥装配 `mcp__<server>__*` 工具族 |

另有一个排程特有的硬需求（G5）：**V5 壳切换的地基**。纸壳开工时「观测台 preset / 纸壳 preset」需要 preset realm 已就位——S4 是它唯一的前置窗口（前端工程后不再有组合层施工窗口）。

## 2. 设计

### 2.1 preset 模型（G1 核心）

**Preset = 命名的 ResolvedComposition 工厂。** 与 DSH 的关键同构/差异：

| 维度 | DSH | HoloGram S4 | 理由 |
|---|---|---|---|
| preset 本体 | 一个目录 = 一份 cordis.yml（**插件行**组合） | 一个目录 = 一份 `roster.patch.yml`（**四域行**组合） | HoloGram 的行是数据不是插件包；复用 S2 的 patch schema/解析引擎零新语义 |
| 装载机制 | cordis scope realm（mount 进 agent 的 context 层，service 隔离） | **纯函数解析 + 显式传参**：`resolveRoster(factory, [userPatch, presetPatch])` → 装配面已有可选参数 | HoloGram 装配面是函数参数不是 ctx service；realm 的「per-session service 隔离」问题（DSH 泄漏守卫那套）在这里不存在——组合是值不是注册副作用 |
| 生效面 | tools + systemPrompt sections + delegation | **tools + prompt + capabilities** 三域（shell 域对会话无意义——壳引导是应用级一次性的，preset 不碰） | 壳行禁用是应用级决策；会话级组合不含壳 |
| 信任模型 | system（部署自带）/ user（`$DSH_HOME/.agent-presets`，等同 shell 信任） | 同款二分：system preset（应用内置，`src/composition/presets/`）+ user preset（`~/.hologram/presets/`） | 与 DSH 的 authoring 纪律一致：user root 可写、system 只读 |
| 会话记录 | header 深冻 + `agent-preset/selected` 事件（newest wins，重建读 resolveSessionPreset） | 会话头 + 选择事件同构（复用现有 session-log 事件体系；**新增事件 kind 走 Phase 5 立规：spec AST 白名单 + gate 计数**） | 「模型可见 ⟺ 已记录」是 DSH 那条纪律的原样移植——preset 决定模型看到的 schema/段，必须可重建 |

**目录形态**（学 DSH：composition 是纯行列表，metadata 独立文件）：

```
~/.hologram/composition/presets/<preset-id>/
├── roster.patch.yml   # 组合本体（S2 patch schema 原样复用：四域 + 禁/覆/插）
└── preset.yml         # 显示元数据（name/description/order——纯展示，装载失败降级为无元数据不拒载）
```

**复审修正：preset 落在 composition 根的子目录**（初稿为 `~/.hologram/presets/` 平级目录）——理由：(a) **零 Rust 新路由成本**：`/composition/presets/<id>/roster.patch.yml` 在 S2 既有通道（resolve_asset 逐段校验 + 前缀约束）下今天就能取到；(b) `HOLOGRAM_COMPOSITION_ROOT` 测试隔离对 preset 同样生效；(c) 用户组合数据单根收口。代价是 Rust 加一条**目录索引路由**（`GET /composition/presets/` → JSON 数组，镜像插件索引的做法——约 30 行）。

- preset id 规则照抄 DSH `PRESET_ID`：`/^[a-z0-9][a-z0-9-]*$/`——id 是路径段，这是**围栏规则不是风格规则**（`..` / 分隔符 / 绝对名会把组合挪出授权根）。
- **内置 system preset 表**（`src/composition/presets.ts`）：`standard`（零 patch = 出厂组合）+ `minimal`（禁 browser-desktop/web/graph-hooks…的精简面，V5 共居期的「纸壳 preset」原型）。system preset 不落盘——它是代码常量（与 S2「factory 层不出 yml」同一裁定）。system 优先：user preset 与内置同名 id 时内置胜（DSH「earlier root wins」同款——内置 id 是部署事实，用户不可影子化）。
- **层序**：`factory → 用户层 patch（~/.hologram/composition/roster.patch.yml）→ preset patch`。preset 是最上层——用户层表达「这台机器的基线」，preset 表达「这个会话的裁剪」，裁剪叠加在基线之上（同 id 后写胜前写，S2 语义零改动）。
- **选择持久化**：`AppSettings` 加 `composition: { preset: string }`（缺省 `'standard'`；settings 读取的缺省容错走既有 AppSettings 扩展先例）。**一个字段、两个消费作用域**：boot 壳解析读它（shell 域条目 → 引导哪套壳行——V5 双装配的挂点）+ Agent 装配读它（tools/prompt/capabilities 域条目）。preset 文件自己决定说哪些域——「minimal」只说 agent 三域，「纸壳 preset」届时会带 shell 域条目。改 preset：壳作用域重启生效（壳行无 dispose 语义，S2 裁定不变），装配作用域下次装配生效。

### 2.2 穿线：会话怎么拿到自己的组合

数据流（全部走既有信号通道，无新总线——事件总线归零铁律）：

```
preset-store（新 zustand：roster + 选择态）
  ↑ discovery：内置表（代码）+ /composition/presets/ 索引 + 逐 preset 取 roster.patch.yml/preset.yml

boot：ensureCompositionLoaded 后追加 preset 解析
  → resolved = resolveRoster(factory, [用户层 patch, settings.composition.preset 对应 patch])
  → composition-store.setResolved（S2 store 原样复用——preset 只是多了一层 patch 输入）
  → bootShell 消费 .shell（壳作用域）；Agent 装配消费 .tools/.prompt/.capabilities

装配入口：runtime.createAgentFromContext(ctx, opts)
  ├─ ctx.presetId ? 会话级覆盖解析（cache 键：presetId + 用户层内容 hash）
  │            : useCompositionStore.resolved（boot 解析产物，S2 现状路径零变化）
  └─ 组合产物 → buildToolRegistry(toolRows) / buildSystemPrompt(sections) / fromRoster(capabilities)
```

- **cache 键**：`presetId + 用户层 patch 的内容 hash`——热重载（G2）换用户层后 cache 自动失效。解析本身廉价（纯函数 + 表聚合），cache 只为**引用稳定**：同一组合的多次装配产出同一个对象，浅比较消费者不误触刷新。
- **创建时点绑定**：preset 在 Agent 创建时解析并冻结进该会话（对齐 DSH「running session keeps the composition it began with」）；在途会话不随 preset 编辑热切——**字节契约纪律的自然延伸**（表序变 = 前缀缓存失效事件，只发生在会话边界）。
- **复审补充——装配粒度的精确语义**（实查 `workspace.ts` setupAgent：工具注册表**每个工作区构建一次**，工作区内全部会话共享；`runtime.createAgentFromContext` 经 `ctx.tools` 拿到的是这一个注册表）：
  - **S4 交付的 preset 选择粒度 = 装配（assembly）级**：workspace Agent 装配、占位 Agent、子 Agent 三处读当前默认 preset。聊天会话共享工作区装配面——「每对话各挂一个 preset」的 UI（DSH 新会话 chip 同构）属 V5 壳，S4 只交付机制不交付选择器（§6 未决项）。
  - **会话级覆盖的机制位**：会话工厂（workspace 的 agent factory，每次聊天会话新建 Agent 的那条路）已具备挂接点——若 resolved ≠ 工作区默认组合，工厂为该会话构建**会话作用域注册表**（`buildToolRegistry({toolRows: resolved.tools, ...})`，deps 全部工作区级可复用）并经 AgentContext 传入；`createAgentFromContext` 加可选 composition 覆盖参数（缺省 `this._composition`，S2 零漂移）。S4-1 用单测钉此路径（无生产 UI 消费——机制完整、选择器留给 V5）。
- **子 Agent 继承**：spawn 时显式透传父会话的 ResolvedComposition（子 Agent 与父同一组合面——否则子 Agent 看到的工具面与父会话记录不可对拍）。

### 2.3 消费闭环接线（hello 三通道的前提——复审发现的最大缺口）

**实查结论（2026-08-20）：四 service（panels/commands/tools/providers）自 S1-1 落地以来零消费者。** `ctx.tools.list()` 无调用方——插件经四通道注册的贡献**从未流进任何渲染面或装配面**：面板渲染读 `PANEL_DEFS` 常量、命令面板读 `listActions()`、工具装配读行表 + mcpClients。S0 的 hello 手动验收只验证了「装载成功 + console 打印」，未验证三通道端到端。**S4 的 hello 闭环（§2.8）以此为硬前提——接线批必须先于 hello 批**，否则「1 面板 + 1 工具 + 1 命令」装上全是哑的。

接线设计（每条都是「合流点」不是「改写点」——既有常量面零改动）：

| 通道 | 合流点 | 机制 |
|---|---|---|
| panels | `DockRail` / `DockPanel` 的清单来源：`PANEL_DEFS` 常量 → `panelDefs()` 函数 = 常量 + `ctx.panels.list()` | **即时生效**：panels 贡献变更（register/dispose）→ `bumpPanelDefs()` 信号（新 zustand 信号 store，`state/panel-defs-store.ts`，turn-done-store 同款 tick 模式）→ DockRail/DockPanel `useSyncExternalStore` 重渲染 |
| commands | `CommandPalette` 的 `listActions()` → 合并 `ctx.commands.list()`（折算为 AppAction 形状：`action.type: 'local'` + handler 调用贡献的执行面） | **即时生效**：palette 每次打开已重取列表（`tick` 信号在 open 时刷新——实查 CommandPalette.tsx:21-28）；命令贡献再挂同一个 bump 信号即可 |
| tools | `buildToolRegistry` 的行表源：`composition.tools`（含 builtin + preset 禁用结果）→ 叠加 `ctx.tools.list()` 折算的 ToolRow（id 前缀 `plugin/<name>/`） | **下次装配生效**（S1 既有语义）：不触即时信号；插件工具经行表名冲突装载期拒绝（既有 `ToolRegistry.register`） |
| providers | **不接线**（S1 即声明「组合引擎消费在 S2」，但 S2 未消费——实际无消费者；外部插件用不上自定义 provider） | 留注册表现状；hello 不演示此通道；文档如实标注「预留」 |

- **ToolRow 折算规则**：`ctx.tools` 的 `ToolContribution { id, factory }` → ToolRow `{ id: 'plugin/' + 插件名 + '/' + id, factory }`——插件名前缀防与 builtin 行 id 撞名；factory 缓存实例（注册时调用一次，dispose 时清缓存——工具实例不随每次装配重建）。
- **重名语义**：两个插件贡献同名 id → 前缀不同不撞；插件贡献 id 撞 builtin 行 id → 前缀不同不撞；**真正的撞名**是两个工具 `Tool.name()` 相同 → 行表装载期既有拒绝兜住。
- **生效时机差异写进用户文档**（对齐 S1 声明）：面板/命令即时，工具下次装配（S4-2 热重载后 = 新会话即见）。
- **此接线为 S4 新增批 S4-1.5**（见 §3 批次表），验收即 hello 三通道的机制单测。

### 2.4 会话日志与重建（G1 的可重建半边）

**复审修正（2026-08-20）：HoloGram 的 SessionLog 没有 header 概念**（实查 `agent/session-log.ts`：仅 `events[]` 流 + 序列化，无 SessionHeader 同构物）——DSH 的「header 深冻 + selected 事件」不能平移。改用**首事件方案**：

- 会话构造（`session/reset` init）时**必发一条 `preset/selected`**——首条即创建时点事实（等价 DSH header 的语义位）；
- 空白会话期改选 preset → 追加同名事件；重建时 newest-wins（照抄 `resolveSessionPreset` 的倒序扫描，只是无 header 兜底——首事件承担该位）；
- **Phase 5 立规操作**：新事件 kind = `SESSION_EVENT_KINDS` + `SessionEventDataMap`（Record 关系编译期对齐）+ spec AST 白名单 + gate 计数同步 + 差分矩阵补场景。这动 session-log 冻结面——**必须走 baseline change request 流程**（record + 审批），设计件只立契约不预支快照。事件 data 形状：`{ presetId: string }`（无裸对象嵌套——投影面最小化，deriveMessages 不消费此 kind）。

### 2.5 热重载（G2）

S2 延期清单的兑现：**`composition-store` 加「重载」动作**，不是新通道。

```
文件监听：Rust 侧 fs watcher（既有 workspace watcher 同款）监听 ~/.hologram/composition/
  → Tauri 事件 composition:changed
  → patch-loader 重跑（幂等：同一 ensureCompositionLoaded 已有，抽出 reload() ）
  → composition-store.setResolved / setError（all-or-nothing 语义原样）
  → 新 Agent 装配即用新组合；在途会话不动（2.2 冻结语义）
```

- **作用域**：监听根 = `~/.hologram/composition/` 整树（preset 子目录在树内），但事件处理**只对根级 `roster.patch.yml` 触发 reload**——preset 文件变更不自动重解析（在途会话组合本就冻结；preset 切换是显式动作 = 下次解析即重扫）。文档如实声明。
- **失败面**：坏 patch 重载 → store error + factory 兜底 + console 可见（S2 语义原样），UI 不弹窗（错误不静默 ≠ 打扰）。
- **诊断呈现**：composition-store 的 status/error/patchOrigin 进设置面板「组合」只读节（顺手交付——plugin-store 同款可见性纪律）。

### 2.6 npm tarball 分发（G3）

**安装 = 下载 + 校验 + 解包到插件目录**，全在 Rust 侧（webview 无 fs；复用既有零件）：

- **新 RPC `plugin_install`**：`{ source, expectName? }` → 下载（reqwest 已在依赖树）→ 校验 manifest（name 匹配 expectName / entry 白名单——复用 TS 侧同款规则的 Rust 镜像？**不**——manifest 校验留在 TS loader 既有单一入口，Rust 只做「tar 解包 + 路径安全」）→ 解包（**新依赖 `tar` + `flate2`** crate，纯解包无传递风险）→ 落 `~/.hologram/plugins/<name>/`（原子：先解到 `.tmp-<rand>` 再 rename；重名拒绝）。
- **路径安全**（tar slip 防护）：解包条目逐条校验——拒绝绝对路径 / `..` 段 / 符号链接条目（tar crate unpack 不带内置防护，必须手写 entry 检查；这是 v1 P3 原案 + DSH 供应链警告的合并）。
- **供应链警告（用户已拍板的完全信任模型，如实声明不加固）**：安装 UI 顶部常驻警告文本「插件是本机全信任代码：可读写文件、起子进程、调 133 个 RPC。npm 上的包 ≠ 审核过的包」。不做签名/校验和（v1 已拍板，ADR §5 信任模型维持）。
- **卸载/禁用**：卸载 = `plugin_uninstall` RPC（Rust 删目录 + TS 侧 reload 插件清单）；禁用 = `plugin_set_enabled` RPC（Rust 读改写 plugins.json 的 disabled 集——S0 已定文件形状 `{"disabled": [...]}`，webview 无盘权必须走 RPC；**初稿漏列此命令，复审补**）。两者均重启生效（装载是 boot 期一次性——与组合层「下次装配」语义对齐，UI 提示条如实声明）。
- **更新**：同一 source 重装 = 先装 `.tmp` 校验后换名（卸载+安装的原子复合）——**第一版不做版本比较**（tarball 里 manifest.version 已有，比较逻辑属锦上添花，写进未决项）。

**安装 UI**：SettingsPanel 新 tab「插件」（现有 5 tab 旁加第 6 个）：
- 已装列表（plugin-store 现状渲染：name/version/status/error + 禁用开关 + 卸载按钮）；
- 安装输入框（source 三形态：**(a)** registry 规格 `{ name, version?, registry? }`——缺省 `https://registry.npmjs.org`、registry 字段可覆写（镜像友好）；**(b)** tarball——URL 或本地文件路径（开发期 `npm pack` 产物），同一解包校验路径；**(c)** 本地目录——**复制**进 plugins 根后校验 manifest（loader 只扫自己根，指向外部目录无效——初稿「走既有目录扫描语义」表述错误，复审修正）；
- 常驻供应链警告条。

### 2.7 机器桥（G4，可选批）

**插件声明式挂接外部 MCP server**——dsh-bundle 模板的产品化：

- **manifest 扩展**（`plugins/types.ts` PluginManifestSchema 加可选字段）：
  ```yaml
  mcpServers:
    - name: my-engine          # mcp__my-engine__* 前缀
      transport: stdio | http
      command: ./bin/engine    # stdio: 相对插件目录解析
      args: [...]
      url: ...                 # http: 直连
      failurePolicy: startup-error | lazy   # 缺省 lazy：进程挂了工具报错不炸装载
  ```
- **装载路径**：loader 装插件 → manifest 的 mcpServers 逐个经 `createTauriProcIO`（stdio）或直连（http）构造 McpClient → `registerMcpTools` 进**该插件的装配贡献**。关键裁定：MCP 工具是**工具行贡献**（composition 的 tools 域），不是旁路注册——装载期把每个 mcpServer 折算成一条 ToolRow（factory = 惰性连接 + 工具注册），行 id `plugin/<插件名>/mcp/<server名>`。这样 preset/patch 可以禁用某插件的某个 MCP server（`builtin` 族同款寻址语义），组合均匀性不破。
- **进程生命周期**：bridge 的 kill 归插件 fiber disposer（插件禁用/卸载 → spawn 的进程链式停）。`failurePolicy: lazy` 对齐 dsh-bundle 的 `failOnStartupError: false` 哲学：瞬态机器不是装载失败的合格理由。
- **明确边界**（ADR §5 维持）：这是「插件挂外部机器」，不是「进程内宿主插件」——后者永久关闭，本批不开口子。

### 2.8 hello 闭环（G5 验收工装）

`examples/plugins/hello/`——**「假装是外人」的从零验证**：

- 1 面板（ctx.panels 注册 + 极简 React 组件）+ 1 工具（ctx.tools 注册 + defineTool/zod——经 §2.3 行表折算进装配面，下次装配生效）+ 1 命令（ctx.commands）——**三通道对齐计划 README 的 hello 规格，不多不少**（起草时曾加「1 prompt section」，复审裁掉：prompt section 的插件贡献通道 S1 未建 service、S4 无真实消费者——按 S2 §2.9 纪律「无消费者不开通道」，设计候选与决策时机见 §6 未决项）；
- `README.md`：照抄一遍从 npm 打包（或本地路径）到装-用-卸的全链路（含截图位）；
- 验收口径：**新窗口执行者只读 examples 文档（不读组合层源码）能把 hello 装上并跑通三通道**——这是 S4 对「前端工程期间组合层静默」的最终担保。

### 2.9 文档全套（S4 验收硬条款）

`docs/plugins/README.md`（新）：manifest 规范（含 mcpServers）+ 四通道 API（ctx.panels/commands/tools/providers + ToolRow 约定）+ 完全信任警告 + **KV-cache 注意事项**（S1 设计件 §2.5 口径：装卸插件/preset 切换 = 主动缓存失效事件，预期成本）+ preset 语法（指向 docs/composition/README.md 扩充后的 preset 段）+ 机器桥声明式块参考。

## 3. 批次序列（每批独立 commit、独立全绿）

批内门禁统一：`build + vitest + biome 零新增 + verify:convergence（不设 preset）`；触 Rust 批加 `cargo test`。**standard 快照零漂移规则全程生效**（S1 §2.4 / S2 §2.7 同款：做不到零漂移 = 行为变更 = 停下写 change request）。

| 批 | 内容 | 验收 |
|---|---|---|
| S4-0 | **preset 数据模型（纯加法）**：`composition/presets.ts`（内置表 standard/minimal + PresetId 规则 + resolvePresetComposition 纯函数 = resolveRoster 叠 preset 层）+ Rust `/composition/presets/` 目录索引路由（约 30 行，镜像插件索引）+ discovery（fetch 注入面：索引 + 逐 preset 取 roster.patch.yml / preset.yml 元数据降级语义）+ preset-store | 纯函数测试：standard ≡ factoryComposition；minimal 的禁用面符合设计；用户 preset 叠加在用户层 patch 之上（同 id 后写胜）；坏 preset 目录 = roster 行报 broken 不炸发现（DSH discovery 同款：占 id 但拒绝装载）；cargo test（索引路由：列表/空目录/遍历拒绝） |
| S4-1 | **装配穿线 + 会话绑定**：createAgentFromContext 读 ctx.presetId → preset 组合（cache：presetId + 用户层 hash）；会话构造必发首条 `preset/selected` 事件（**Phase 5 change request 先行**：SESSION_EVENT_KINDS + DataMap + spec AST 白名单 + gate 计数 + 差分矩阵）+ 重建 newest-wins；会话工厂的组合覆盖参数（会话作用域注册表路径）；子 Agent 透传组合；**minimal preset 的 convergence baseline 冻结**（S2 §6 遗留兑现：helpers/presets.ts 登记从 runtime preset 表派生的 minimal 定义 → `CONVERGENCE_PRESET=minimal` + record + change request + 独立 freeze commit → `baseline/preset-minimal/phase-N/`——per-preset 收敛协议的首次全流程实测） | 穿线单测：带 presetId 的装配工具面/prompt 反映 preset；不带 = S2 现状零漂移；会话重建对拍（首事件 + 后续改选 → 重建用后选）；会话作用域注册表路径（resolved ≠ 工作区默认时工厂自建注册表）；子 Agent 与父同面；minimal baseline freeze 走完全流程（record + CR + freeze commit 三步可审计） |
| S4-1.5 | **消费闭环接线**（§2.3）：panels/commands 合流点 + bump 信号 store；tools 行表折算（`plugin/<name>/<id>` 前缀 + factory 缓存）；providers 留现状 | 单测：插件贡献面板/命令在信号后出现在清单；插件工具行折算正确、撞名走装载期拒绝、dispose 清缓存；hello 前身（mock 贡献）三通道机制全绿 |
| S4-2 | **热重载**：Rust fs watcher → composition:changed 事件 → patch-loader reload() → store 更新；设置面板「组合」只读诊断节 | cargo test（watcher 事件语义）；vitest（loader 重载幂等 + 坏 patch 兜底）；手动验收：改 patch → 新会话即新面、在途会话不变 |
| S4-3 | **npm 安装通道**：Rust `plugin_install`/`plugin_uninstall`/`plugin_set_enabled`（tar/flate2 依赖 + tar-slip 防护 + 原子落盘 + plugins.json 读改写）+ RPC 契约 + SettingsPanel「插件」tab（列表/禁用/卸载/安装框/警告条） | cargo test（解包安全：绝对路径/…/symlink 拒绝；重名拒绝；原子性；set_enabled 的 JSON 读改写）；vitest（store/UI 组件）；手动验收：tarball URL 装上 hello 的前身 |
| S4-4 | **机器桥（可选，门控）**：manifest mcpServers 字段 + loader 折算 ToolRow（`plugin/<插件>/mcp/<server>`）+ 进程生命周期挂 fiber disposer | vitest（manifest 校验/行折算/failurePolicy 语义——ProcIO 注入 mock）；手动验收：示例 MCP server（用 engine.exe 自己当靶子——spawn hologram-engine serve mcp 挂进 hello 插件） |
| S4-5 | **hello 闭环 + 文档全套**：examples/plugins/hello + docs/plugins/README.md + docs/composition/README.md 扩 preset 段 + AGENTS/CLAUDE/CONVENTIONS 纪律回写 + 计划 README 状态 | **「假装是外人」验收**：执行者只读 examples 文档完成装-用-卸三通道；全门禁终跑 |

**批次依赖**：S4-0→S4-1 串行（模型→穿线）；**S4-1.5 是 hello 闭环的硬前提**（四 service 零消费者是复审实证——不接线则 hello 三通道全哑），可在 S4-1 后任何时点插入；S4-2/S4-3 可并行（互不触碰）；S4-4 依赖 S4-3（hello 需要 hello 前身先能装）且**可整体跳过**（可选批——若排程紧张，机器桥降级为未决项，不阻塞 hello 闭环：hello 的三通道不依赖 mcpServers）；S4-5 收尾必须最后（依赖 S4-1.5 + S4-3 全绿）。

**S4-1 的 change request 时点**：session-log 冻结面变更（新事件 kind）必须在写码前先走 `docs/plans/agent-core-convergence/baseline-change-request.md` 审批——这是批序列里唯一的流程门，设计件不预支批准。

## 4. 回滚

- S4-0/S4-1 纯加法 + 缺省参数：不传 presetId = S2 末行为；revert 单批即回。S4-0 的 Rust 索引路由 revert 无 TS 依赖残留（loader 404 = 无 preset，非错误——S2 通道同款语义）。
- S4-1.5 接线是合流点不是改写点：PANEL_DEFS / listActions 常量面零改动；revert = 消费面回读常量 + 信号 store 删除。
- S4-2 watcher 是加法：Rust 事件没人听 = 无操作；revert 无 TS 依赖残留（loader reload 动作保留无害）。
- S4-3 安装通道独立：不点安装按钮 = 零行为变化；卸载插件目录 = 干净退出（plugins.json disabled 集是用户数据，保留）。
- S4-4 mcpServers 是 manifest 可选字段：无字段 = 零变化；禁用插件 = 进程停 + 行消失（fiber disposer 链）。
- **session-log 事件（S4-1）不可静默 revert**：事件已写入真实会话后，回滚需先确认无在途会话依赖——写进 S4-1 批的交付说明。

## 5. 风险表（并入计划 README）

| # | 风险 | 对策 |
|---|---|---|
| R12 | session-log 冻结面变更（preset/selected 事件）破会话重建 | Phase 5 change request 先行（批内流程门）；差分矩阵补场景；重建读 resolveSessionPreset 倒序扫描——与 DSH 同构的已验证语义 |
| R13 | preset 组合的缓存失效不彻底（用户层 patch 变了 preset 仍持旧引用） | cache 键 = presetId + 用户层内容 hash（2.2）；穿线单测钉「改用户层后新装配用新组合」 |
| R14 | tar 解包路径逃逸（zip-slip 同构攻击面） | entry 逐条白名单校验（绝对/../symlink 拒绝）+ cargo test 全覆盖 + 原子 rename 落盘 |
| R15 | 机器桥进程泄漏（插件卸载后 spawn 的 server 不死） | kill 挂 fiber disposer（cordis dispose 链）+ 卸载手动验收含进程清单检查；failurePolicy lazy 只影响装载不豁免清理 |
| R16 | 安装 UI 给用户「npm = 安全」的错误暗示 | 常驻警告条（完全信任模型原文）；文档 KV-cache + 供应链段；不做任何「已审核」标记 |
| R17 | preset 与 S3 名义域重叠（settings 域将来也做行配置） | config 通道（S2 §2.9 延期项）仍在 S3 首消费者时落地；S4 的 preset 只做「行组合选择」不做「行内配置」——两层正交，文档写明 |
| R18 | 消费闭环接线触 UI 渲染面（DockRail/DockPanel/CommandPalette——高 fan-in React 面） | 合流点设计最小化：常量面零改写、只加 `panelDefs()` 读取函数 + 一个信号 store；接线批独立 commit 独立门禁；convergence 全程对拍（接线不触 agent/** 时标准面零漂移仍强制） |

## 6. 未决项（S4 施工中/S5+ 定）

- **插件 prompt-section 贡献通道**：设计候选两枚——(a) 第五个 ctx service（`ctx.systemPrompt`，DSH L2 插件同构，动态 render 全表达力）；(b) 插件目录 sidecar yml（静态段落，数据化零代码）。真实消费者出现时再定（S2 §2.9 同款纪律：先开通道只剩静默 no-op 或假旋钮两种坏结局）。hello 三通道不依赖它。
- **preset 的 UI 选择面**：新会话屏的 preset chip / 会话头只读标签 / 设置默认值（DSH 四面：General 行 + 新会话 chip + 头标签 + 管理节）——S4-1 只做**装配与记录机制**，UI 三面照 DSH 形态砍到最小（设置面板「组合」节的 preset 默认值 + 新会话携带默认），完整四面留给 V5 壳（那才是 preset 的主消费场景）。
- **插件版本比较/更新提示**（2.5 延后）：manifest.version 已有，UI 显示之；比较与更新流程属增强。
- **preset 导出/分享**：DSH authoring 的 copy 语义（preset 复制 = 全目录拷贝，无文本编辑面）——用户直接编辑文件即可，authoring 工具属 V5。
- **overlay/项目层 patch**（S2 §6 遗留）：层序已定为 factory → 用户层 → preset；overlay 若来，插在用户层与 preset 之间——槽位语义先写进 docs/composition/README.md 层序说明，实现延期。
- **机器桥的 http 传输鉴权**：mcpServers.http 的 headers 明文进 manifest——插件目录本来就是全信任区，与 command 同级；不做加密仪式。

## 7. 审批与复审记录

### 7.1 代理复审记录（2026-08-20，落地前自查）

复审方法：设计断言逐条对照代码现实实查（S2 复审同款纪律——断言必须有 grep/读文件证据）。抓到三处设计错误并已回写修正：

1. **四 service 零消费者**（G0/§2.3/S4-1.5）：初稿默认 hello 三通道可跑——实查 `ctx.tools.list` 等全仓无调用方，插件贡献从未流进装配/渲染面。修正 = 新增消费闭环接线批，置于 hello 之前。
2. **会话头不存在**（§2.4 修正注）：初稿照抄 DSH「header 深冻 + selected 事件」——实查 HoloGram SessionLog 仅 events 流无 header。修正 = 首事件方案（session/reset init 时必发首条 `preset/selected`）。
3. **hello 超规格**（§2.8 修正注）：初稿给 hello 加了「1 prompt section」——计划 README 规格是三通道，且 prompt-section 贡献通道无 service 无消费者（S2 §2.9 纪律）。修正 = 裁掉，通道设计进 §6 未决项。

### 7.2 复审要点自查（给后续复审者的阅读地图）

1. §2.1 preset 模型对 S2 引擎的复用是否完整（应零新解析语义）；
2. §2.4 动 session-log 冻结面的流程门是否足够（change request 先行）；
3. §3 批次依赖与可选批（S4-4）的裁剪边界是否自洽；S4-1.5 的插入位置是否正确（hello 硬前提）；
4. §2.6 供应链立场是否与 v1 拍板一致（完全信任 + 如实警告，不加固）；
5. 与 V5 排程的咬合：S4 终态是否恰为「纸壳 preset 可双装配」的地基（§1 G5）；
6. §2.2 复审补充的装配粒度语义（工作区共享注册表 vs 会话作用域覆盖参数）是否与 workspace.ts 实现现实一致。

### 7.3 交接

本设计件复审通过后交新窗口执行者落地（S4-0 即可开工——纯函数批风险最低）。执行者注意：§7.1 的三处修正均为设计期实证，落地的第一动作是复核 G0 结论仍成立（grep 四 service 消费者——若 S3 名义域已动则批次表需重排）。
