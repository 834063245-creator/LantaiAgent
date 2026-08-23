# S2 设计件 — 组合外化（roster patch 数据文件 + 装配穿线 + 壳装配行化）

> 状态：**待批准**（2026-08-20 预写；与 S1 设计件同一流程——用户批准后 S2-0 即可开工，批准记录落此处）。
> 性质：S2 是组合架构计划的「数据外化」段。S1 把装配来源收进三张 TS 表（机制就位、数据仍在编译期）；S2 把「禁哪些行、换哪段文本、插哪些段」外化为用户可改的 patch 数据文件，把 `blueprint.standard()` 的真源换成行管道，并把 main.ts 909 行（实测）硬编码壳装配改为壳行驱动。本件划定 schema、解析语义、文件通道、穿线路径、批次序列与零漂移规则。
> 对标实证（2026-08-20 源码查验）：DSH `packages/bundle/base/cordis.patch.yml`（451 行 roster：id 寻址 / config 整体替换 / disabled / insert）、`packages/bundle/web-app/cordis.patch.yml`（分层 disable + insert 范本——「行序无装载语义」与「禁用而非删除」两段注释是本件的直接教材）、`packages/boot/app-boot/src/profile.ts`（bundle 层 → profile 层 → --patch overlay 的分层组合）、`apps/web/src/main.ts`（10 行薄引导）。

## 1. 问题陈述

S1 竣工后组合「机制」全就位，但三件事仍钉死在编译期：

| 现状（2026-08-20 实测） | 钉住的事实 | S2 冲击点 |
|---|---|---|
| `composition/tool-rows.ts` 14 行 + `composition/prompt-sections.ts` 13 段 + `agent/blueprint.ts` 14 capability（手写 `standard()`） | 行集合与表序 = 编译期 TS 常量 | 禁一个内置工具 / 换一段 persona 需要改代码重编译发版 |
| main.ts 909 行：init() 465 行装配 + switchWorkspace 族 ~300 行 + actions 115 行 | 壳的接线内容与顺序 = 入口文件私有知识 | 「学 DSH 8 行薄引导」无从谈起；壳装配不可寻址、不可禁用 |
| 四 service（panels/commands/tools/providers）挂根 ctx（S1-1） | 外部贡献通道就位、暂无第一方消费面 | **S2 不动它**——消费面是 S3 域行化 / S4 分发的事 |

验收口径（计划 README S2 节原文）：**改一个用户层 patch 文件即可禁用一个内置工具 / 换一段 persona（无需重编译）；main.ts 净减行；全门禁绿。**

## 2. 设计

### 2.1 行域模型：四域、行实现留代码、patch 只做增量

组合数据分四个**行域**（row domain），每域一张「出厂行表」（既有/新增 TS 表）+ 一个 id 注册空间：

| 域 | 出厂行表（真源） | 行 id 现状/惯例 | 消费面 |
|---|---|---|---|
| tools | `composition/tool-rows.ts` `builtinToolRows()`（14 行） | `builtin/<family>`（S1 事实） | `buildToolRegistry` 末端行装配 |
| prompt | `composition/prompt-sections.ts` `builtinPromptSections()`（13 段） | 裸 id（`behavior-rules`…，S1 事实） | `assembleSystemPrompt` 表序 concat |
| capabilities | `agent/blueprint.ts` 新拆 `builtinCapabilities()`（14 项，即现 `standard()` 数组原样搬家，id = 现 key） | key 即 id（`plan-tools`…） | `AgentBlueprint.fromRoster()`（新） |
| shell | `composition/shell-rows.ts`（新，§2.6） | `hologram/shell-<block>`（插件名风格） | `src/shell/boot.ts` 启动编排 |

**关键结构决策（对 DSH 的第一处刻意偏离）：出厂层是代码，不是 yml 文件。** DSH 的 base patch 是 451 行 yml，因为它的行是 npm 包（`name` 字段寻址包管理器解析的模块）；HoloGram 出厂行是编译期 factory（id 寻址代码内实现），若再用 yml 复述一遍全量清单就是双真源，必然漂移。**学的是 patch 语义（id 寻址 / disabled / insert / last-write-wins），不是文件形态。** 用户 yml 永远只写增量（delta），出厂清单的唯一真源是三张 TS 表 + 壳行表。

### 2.2 patch 文件：形状与位置

一个文件、固定名、四个域键（缺哪个域 = 该域无增量）：

```yaml
# ~/.lantai/composition/roster.patch.yml
tools:
  - id: builtin/shell        # 禁整个 shell 族（run_shell/bash_* + shell 域工具）
    disabled: true

prompt:
  - id: behavior-rules       # 换一段 persona：整段文本替换（同槽位、同参与条件，只换文本）
    text: |
      你是我的专属编码助手。规则一……规则二……
  - id: multi-agent
    disabled: true
  - insert:                  # 插入新文本段（仅 prompt 域可 insert）
      - id: my-team-convention
        after: collaboration-mode   # 锚点：插在该段之后（before: 反向；缺省 = 追加表尾）
        text: |
          ## 团队约定
          提交信息用中文，格式 conventional commits。

capabilities:
  - id: auto-tune
    disabled: true

shell:
  - id: hologram/shell-keyguard
    disabled: true
```

- **格式 yml**（计划已拍板）：用户手编文件需要注释与多行文本块，JSON 两者皆无。解析走 `yaml`（eemeli/yaml v2，纯 JS 零传递依赖）→ 结构交给 zod v4 校验——与 `plugins/types.ts` 的 manifest 完全同一纪律（parse 产 unknown，schema 产校验 + 类型，禁手写平行接口）。
- **操作全集（S2）**：`disabled`（四域皆可）· `text` 覆盖（仅 prompt 域）· `insert` 文本段（仅 prompt 域，带 `before`/`after` 锚）。tools/capabilities/shell 域出现 `text` 或 `insert` → schema 直接拒绝（错误不静默：没有「写了但什么都不发生」的字段）。
- **insert 为何带位置锚（对 DSH 的第二处刻意偏离）**：DSH 行序无装载语义（activation 由服务可用性驱动），append 即可；HoloGram 行序 = 字节契约（表序 = 组合序 = 前缀缓存语义），插到哪必须显式声明。锚点必须存在于当前工作列表（含已禁用行——禁用行在最终一步才被丢弃，锚在禁用行旁插入的段落落位于该行原位）。
- **同一 yml 语义边界**：一条 prompt 域行 `disabled` 与 `text` 互斥（refine 拒绝）；既无 `disabled` 又无 `text` 的条目拒绝（无操作条目 = 手误）；insert 条目 `before`/`after` 互斥但可都缺（追加表尾）。

### 2.3 解析语义（DSH 实证 + 三条本地纪律）

`resolveRoster(factory: FactoryComposition, layers: CompositionPatch[]): ResolvedComposition` —— **纯函数**（同输入同输出，不读环境不读时钟）：

1. **逐层逐条按序应用**，每条 entry 按 id 在当前工作列表里寻址；**last-write-wins**：后层对同一行的 `disabled` 覆盖先层。
2. **`text` 覆盖 = 整段替换**（对齐 DSH「patch replaces the targeted row's whole config rather than merging」）：被覆盖段保留原 id、原表位、原 `applicable` 参与条件，仅 render 换成 `() => text`。动态插值（graphSnapshot/memory 等）随覆盖丢失——用户换整段就接管整段，文档如实声明。
3. **insert 逐条即时生效**：同层先插的段可作后插段的锚（insert A after X，再 insert B after A）。
4. **终步才丢禁用行**：工作列表全程保留 disabled 标记，最后一步过滤。产出 = 四域存活行列表（按最终表序）+ 诊断信息（禁用/覆盖/插入的 id 清单）。

**错误政策（all-or-nothing，按文件）**：yml 语法错 / zod 校验失败 / 未知 id / insert 撞已有 id / 锚点不存在 —— **整个 patch 文件拒绝**，任何一条都不应用，回退出厂组合；错误进 console.error 与 composition-store（状态 error + 原因），应用正常起。理由：(a) 部分应用 = 静默错配（用户以为禁了，实际没禁）；(b) 对齐 INVARIANTS #11.2 的纪律——用户级数据文件是毒化源，读路径必须「拒绝 + 可见 + 兜底」，不能让一个坏文件变成每次启动必炸。

### 2.4 分层与通道

**层序（先出厂、后用户）**：

```
层 0 出厂组合 = 三张 TS 表 + 壳行表（代码真源，永不出 yml）
层 1 用户层   = ~/.lantai/composition/roster.patch.yml（本段交付）
层 2 overlay  = 引擎 API 槽位（`layers: CompositionPatch[]` 数组天然支持多层）；
               S2 无用户面来源——S4 preset realm / 项目级 .lantai/composition/ 落这里
```

**文件通道（S0 同构）**：`plugin_assets.rs` 旁新增 composition 静态路由（复用其 `resolve_asset`/`asset_response`，提取为 pub(crate)）：

- `GET /composition/<相对路径>` → `~/.lantai/composition/<相对路径>`（`HOLOGRAM_COMPOSITION_ROOT` 环境变量覆盖，测试隔离，镜像 `HOLOGRAM_PLUGINS_ROOT`）
- 安全三件套原样继承：percent 解码逐段拒绝 `. `/`..`（含编码形态）+ canonicalize 前缀双保险（junction 逃逸）+ 仅 GET（405）+ 仅 loopback（挂在 llm_proxy 14570 监听，绑定即保证）；32MB 单文件上限同款
- MIME：`.yml`/`.yaml` → `text/plain`（loader 自己 parse 文本，无严格 MIME 消费方）
- `llm_proxy.rs` 分支点加 `strip_prefix("/composition/")` 一行派发（与 "/plugins/" 并列）
- webview 侧 `composition/patch-loader.ts`：经 `llm_proxy_port` RPC 解析 origin（复用 loader.ts 的 `getProxyPort`）→ fetch `/composition/roster.patch.yml`（404 = 无用户层，非错误）→ yaml parse → zod 校验 → `resolveRoster` → 写 composition-store。fetch/import 全部可注入（loader.ts 同款测试面）
- **无通道（浏览器 mock / 代理未起）= 出厂组合**，与 `loadExternalPlugins` 的静默跳过同语义

**生效时机**：S2 组合解析只在启动期发生一次，**改 patch 重启生效**（无需重编译）。热重载（改文件即时重组工具面）明确延期——那需要 agent 装配信号联动（agent-config-store 现成信号可挂），属 S4 preset 体系的一部分，见 §6。

### 2.5 穿线路径：composition-store 是唯一运行时真源

新增 `state/composition-store.ts`（zustand，app 级单例，对齐 plugin-store 先例）：

```
{ status: 'factory' | 'ok' | 'error', patchOrigin?: string, error?: string,
  resolved: ResolvedComposition }   // 启动期写入一次，含诊断（disabled/inserted/overridden id 清单）
```

生产穿线（全部显式参数，无一隐式读盘）：

```
main.ts → bootShell(root)
  ├─ loadCompositionPatch()                     // fetch+parse+resolve → composition-store（错 → factory 兜底 + error 可见）
  └─ shell 行表 = resolved.shell → 逐行 boot（§2.6）

workspace.setupAgent（既有路径，每工作区）
  ├─ buildToolRegistry({ ..., toolRows: resolved.tools })        // 新参数，缺省 = builtinToolRows()
  └─ new AgentRuntime(path, fiberCtx, resolved)                  // 新可选第三参，缺省 = factoryComposition()
       ├─ _assembleAgent 默认 blueprint = AgentBlueprint.fromRoster(resolved.capabilities)
       └─ _assembleAgent 内 buildSystemPrompt(..., resolved.prompt)  // sections 参数透传 assembleSystemPrompt
```

**确定性按构造（S1 §2.3 纪律的延续）**：所有新参数全部带「出厂缺省」——convergence specs、直连测试、任何不传参的调用方拿到的就是现行装配。用户 patch 只经 composition-store 进生产路径，**测试永不读用户盘**。计划 README 的「`blueprint.standard()` 由 roster 行生成」落地为：`standard()` 保留（签名与语义不变，成为 fromRoster(factory) 的快捷方式），`fromRoster` 是新真源——Phase 6 铁律换真源不改语义。

### 2.6 壳行模型：boot 行，不是 cordis 插件

main.ts 的 909 行按 init() 既有执行序切成 **12 条壳行**（`composition/shell-rows.ts` 出厂表，`hologram/shell-*` id）：

| # | id | 搬迁内容（main.ts 现行号） |
|---|---|---|
| 1 | hologram/shell-platform | 平台标记 + no-bf 降级 + resize 热区（881-897） |
| 2 | hologram/shell-graph | StarGraph 构造 + WebGL 兜底 + AgentVisualizer + GraphInteraction + setDockStarGraph（96-110, 588-595） |
| 3 | hologram/shell-chat | ChatCore + core-store 注入 + setStarGraph + trail 接线（582-589） |
| 4 | hologram/shell-bridges | unity-event + permission-ask 桥（426-511） |
| 5 | hologram/shell-keyguard | 浏览器快捷键抑制（513-570） |
| 6 | hologram/shell-sandbox-probe | 沙箱健康检查（572-580） |
| 7 | hologram/shell-dataflow-parser | NL→symbol 回退解析器（597-626） |
| 8 | hologram/shell-nav | shell.wire 导航接线（628-643） |
| 9 | hologram/shell-persistence | turn-done 持久化 + agent-config 热切换订阅 + beforeunload（645-654, 772-812） |
| 10 | hologram/shell-actions | registerActions 14 动作（655-770）——只搬注册位置，动作逐个行化是 S3 各域的事 |
| 11 | hologram/shell-workspace | switchWorkspace 族 + reanalyze/toggleDiff/doSearch/escLayer/setupPlaceholderAgent/pickFolder（120-412） |
| 12 | hologram/shell-cold-start | 冷启动决策 + 欢迎屏按钮 + 画布焦点释放（814-822, 828-878） |

- **行形状**：`{ id, boot(shell: ShellRefs) => void | Promise<void> }`。共享句柄进 `src/shell/runtime.ts` 的 ShellRefs（starGraph / chatPanel / workspace / wsMachine / FileViewer 惰性句柄）——**应用级单例句柄**（main.ts 现状的整体平移，对齐 app/shell-store 先例；不是面板业务状态，不触 INVARIANTS #1，也不进 zustand——非响应式 imperative 句柄）。
- **编排器** `src/shell/boot.ts`：语言/字体/右键三行引导职责（原 init 420-422 + 418）就地执行 → `await loadCompositionPatch()` → 按 resolved.shell 表序逐行 `await boot` → `void loadExternalPlugins(root)`。**逐行 await = 保序**（现行 init 的 await 语义不变：bridges 的事件注册先于后续接线完成）。
- **失败隔离**：单壳行 boot 抛错 → console.error + 继续后续行（loader 同款纪律）。行内代码不得假设前行必然成功——沿用 main.ts 现状的 null 检查（starGraph 全链路判空已是事实）。
- **为什么不是 cordis 插件**（设计裁定，先说清楚免返工）：cordis 插件通道留给「有 ctx 生命周期诉求的单元」——S1 的四 service、S3 起注册面板/命令/工具且要 disposer 的域插件。壳行是**启动接线单元**（纯 boot 时序，无服务注册、无 dispose 诉求——根 fiber 的生命周期 = 应用生命周期，dispose 无意义）；DSH 的 browser 行同样是「cordis 存在前经 module table 组合」的启动期单元。两通道分工写进 CONVENTIONS。
- **workspace.ts 本体不动**：壳行只搬 main.ts 侧编排函数；Workspace 类、fiber 登记（INVARIANTS #12 两原语）、epoch 纪律零触碰——壳行是应用级接线，不产生工作区级资源。
- **main.ts 终态**：CSS import + 内核 boot + React render + `void bootShell(...)` ≈ 40-60 行。**「<100 行」是目标口径而非红线**：验收看「净减行 + 引导职责只剩装配」（计划 README 原文即「净减行」）。

### 2.7 零漂移规则（S1 §2.4 延伸，全程生效）

> **每一批施工后，不设 `CONVERGENCE_PRESET` 跑 `verify:convergence`，三个 tool-schemas 快照 + system-prompt.fixture 逐字节零漂移；`tests/blueprint.test.ts` 的 keys 序列断言不红。**

S2 各批全是「换真源/搬迁」类机械改动：无 patch 层时 resolved 输出必须与三张表现状深度相等（`resolveRoster(factory, [])` ≡ 现行表——这条本身作为 S2-0 的构造性测试钉住）。做不到零漂移的批次 = 它做了行为变更，停下写 baseline change request 等审批，与 S1 同一纪律。**baseline 在 S2 全程零触碰。**

### 2.8 已知涟漪（行禁用的降级面，如实记录不修复）

| 禁用 | 降级行为 | 定性 |
|---|---|---|
| `builtin/<族>` 工具行 | 该族工具不注册；`convergeRegistry` 已验证优雅降级（`createDomainTools` 按 registry 缺席静默跳过动作，全缺席则该域工具不生成；`hide()` 对缺席名 no-op） | 机制安全 |
| 任一工具行 | system prompt 行为规则 #13/#14 仍枚举全量域工具名 → 模型可能调用不存在的工具，报「unknown tool」后自适 | **已知限制**：规则文本静态；动态随 roster 生成明确延期（§6） |
| `converge-tools` capability | 旧细粒度名全可见（66 工具面替 14 域工具）——功能等价、前缀缓存按新面重算 | 文档声明 |
| `task-tools` / `spawn-tool` | 回退行表版 task_*/agent_spawn（共享 TaskManager / 旧 spawn 路由） | 文档声明 |
| `graph-hooks` | 无图上下文注入、无 preflight 图钩——**产品核心工作流（图优先）被关闭** | 文档强警告：可禁，自担 |
| `hologram/shell-cold-start` | 永远欢迎屏（开项目仍可用） | 文档声明 |
| `hologram/shell-workspace` | 无法打开/切换项目（模块可安全 import，boot 不跑 = refs 未接线，调用一致地失败） | 文档声明 |

原则：**不做行级保护名单**（组合均匀性 = 任何行可禁，DSH 同款自由）；降级面如实写进 `docs/composition/README.md`。内核线本身不是行（四 service 经 `compositionServicesPlugin` 常驻，不由 roster 寻址）——宪法第 2/3 条不受 patch 影响。

### 2.9 config 覆盖：机制延期，首消费者已定（README 四语义的落地映射）

计划 README 所学 DSH 四语义的 S2 落地：**id 寻址 ✓ / disabled ✓ / insert（+位置锚）✓ / config 覆盖 → 以 prompt 域 `text` 覆盖落地首个真消费者**。通用 config 通道（`{ id, config: {...} }` 整体替换、经行声明的 configSchema 校验后穿给 factory）**延期至 S3**：S2 没有一行消费 config，先开通道只剩两种坏结局——静默 no-op（违反错误不静默）或为凑消费者发明假旋钮（违反最小 diff）。S3 第一个带 config 的域行（settings 域）落地时一并加，yml 加可选字段对旧 patch 向后兼容，解析算法结构不变。

## 3. 批次序列（每批独立 commit、独立全绿）

| 批 | 内容 | 验收 |
|---|---|---|
| S2-0 | **roster 数据模型 + 解析引擎（纯加法）**：`yaml` 依赖 + `composition/roster.ts`（zod schema / `CompositionPatch` / `FactoryComposition` / `ResolvedComposition` / `resolveRoster` 纯函数 / `factoryComposition()` 派生器）+ prompt 文本段类型（`PromptTextSection`：id + text，无 applicable） | 构造性测试：`resolveRoster(factory, [])` 与三张表现状深度相等（id + 序）；语义测试全覆盖：disable / text 覆盖保位保 applicable / insert 三种锚 / 锚可指禁用行 / 同层链式 insert / last-write-wins / 未知 id・撞 id・坏锚・域外 text・无操作条目・disabled+text 并存 → 各自整文件拒绝；同输入两次解析输出全等（确定性） |
| S2-1 | **装配面穿线（默认参数 = 现行为）**：`buildToolRegistry` 加 `toolRows?`；`assembleSystemPrompt` 加 `sections?`；blueprint 拆 `builtinCapabilities()` 表（standard() 数组原样搬家）+ `fromRoster()`，`standard()` 变快捷方式；`AgentRuntime` 构造加可选第三参 composition（缺省 factory）；workspace.setupAgent 两处显式穿线 | §2.7 零漂移实测（快照 + blueprint keys 序）；穿线单测：传 resolved（含禁用/覆盖/插入）→ 注册面/prompt 文本相应变化，不传 → 与现状全等 |
| S2-2 | **用户层通道**：Rust `/composition/*` 路由（plugin_assets 复用 + llm_proxy 一行派发 + `HOLOGRAM_COMPOSITION_ROOT`）+ `composition/patch-loader.ts` + `state/composition-store.ts` + boot 接线 | cargo test（404/403 遍历/405/junction/MIME）；loader vitest（fetch 注入 mock：合法 patch 生效 / 坏 yml / 未知 id → store error + factory 兜底 / 404 → factory 非错误）；**手动验收①②**：patch 禁 `builtin/shell` 重启 → 工具面无 shell 域；text 覆盖 `behavior-rules` → 系统提示词换段 |
| S2-3 | **壳行化·上**：`composition/shell-rows.ts` + `src/shell/runtime.ts`（ShellRefs）+ `src/shell/boot.ts` 编排器 + 行 1-10 落 `src/shell/` 模块群；init() 主体出 main.ts | 全门禁 + 手动冒烟（开项目/聊天收发/面板开合/权限卡/快捷键）；main.ts 显著净减（此批后剩 workspace 族 + 冷启动） |
| S2-4 | **壳行化·下**：行 11-12（workspace 流 + cold-start）出 main.ts；main.ts 终态薄引导 | **手动验收③**：main.ts 净减行（909 → 40-60 量级，验收口径 = 引导职责只剩装配）；全门禁 + 全功能冒烟（冷启动恢复缓存 / 无缓存欢迎屏 / 占位 agent） |
| S2-5 | **文档与收尾**：`docs/composition/README.md`（patch 语法参考 + 涟漪表 §2.8 + 重启生效声明 + 完全信任警告）；AGENTS/CLAUDE/CONVENTIONS 组合面纪律更新（四域行表 + 壳行通道分工 + patch 纪律）；计划 README 状态更新；全量门禁复跑（vitest/build/biome/convergence/cargo test） | 文档齐全；`docs/README.md` 索引收口 |

批内门禁统一：`build + vitest + biome 改动文件零新增 + verify:convergence（不设 preset）`；S2-2 起加 `cargo test`。

## 4. 回滚

- S2-0/S2-1 纯加法 + 默认参数：revert 单批即回（不传参 = S1 末行为）。
- S2-2 通道是加法：删掉 `~/.lantai/composition/` 文件即回出厂组合；Rust 路由 revert 无 TS 侧依赖残留。
- S2-3/S2-4 大搬迁：每批独立 commit，revert 恢复 main.ts 原状；壳模块群随批删除。
- baseline 全程零触碰（§2.7），任何一批出问题不需要动 convergence 资产。

## 5. 风险表（并入计划 README 风险表）

| # | 风险 | 对策 |
|---|---|---|
| R7 | main.ts 909 行大搬迁引入行为漂移（壳行序错/事件注册时序变） | 机械迁移纪律：逐块搬不改逻辑；行序 = 现 init() 执行序（§2.6 表即证据）；每批手动冒烟清单 |
| R8 | 用户 patch 毒化（坏 yml/未知 id） | all-or-nothing 拒绝 + factory 兜底 + store 错误可见（对齐 INVARIANTS #11.2 读路径纪律）；32MB 上限 |
| R9 | 快照漂移（穿线改装配） | §2.7 零漂移规则：无 patch 层 = 构造性等价（S2-0 测试钉住）+ 每批 verify:convergence |
| R10 | 行禁用涟漪超预期（规则文本过时/核心工作流被关） | §2.8 涟漪表如实入用户文档；不做保护名单（组合均匀性），graph-hooks 强警告 |
| R11 | `yaml` 新依赖 | eemeli/yaml v2 纯 JS 零传递依赖；解析结果全部过 zod（manifest 同款纪律），不信任 yml 结构 |

## 6. 未决项（后续批次/阶段定）

- **热重载**（改 patch 即时重组工具面）：agent-config-store 信号 + workspace.applyAgentConfig 现成，S4 随 preset realm 一并设计（那才是「组合随会话变」的正题）。
- **overlay/项目层**：引擎 `layers[]` 槽位已留；S4 落地（项目级 `.lantai/composition/` 或 per-session preset 二选一或都要，届时定）。
- **规则文本动态化**：behavior-rules #13/#14 的工具名清单随 resolved roster 生成——standard 下必须逐字节复现现文本（含 ask_user/Skill/wait/plan 特例序），有真实需求再做。
- **通用 config 通道**：§2.9，S3 第一批 config 消费者落地时加。
- **preset 的 baseline 协议**：首个非 standard preset（S4）出现时，走 helpers/presets.ts 已登记的 freeze 流程；S2 期间只有 standard + 显式参数。

## 7. 审批

本设计件批准后 S2-0 即可开工（纯函数批，风险最低）；S2-2 起每批遵守 §2.7 零漂移规则。批准记录：
