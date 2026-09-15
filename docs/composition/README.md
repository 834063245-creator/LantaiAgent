# 组合层（Composition Layer）— 用户指南

> S2 竣工（2026-08-20）· S4 preset/热重载/安装通道竣工（2026-08-20）·
> S4-4 甲：插件贡献行/段进组合解析域（2026-08-23）·
> ①b：builtin 行表退役，tools 域全量走插件贡献行（2026-08-23）·
> P3：seam 裁剪域进组合解析域——llm/subagents/fs/shell/sessionPersistence/graph
> provider 与 loopEvents 事件面开关可被 patch/preset 寻址（2026-08-27）。
> 组合架构的「数据外化」段：工具行 / prompt 段 / capability / 壳行 /
> seam provider 的「禁哪些、换哪段文本、插哪些段」从编译期 TS 表外化为
> 用户可改的 patch 数据文件。设计件：
> `docs/archive/composition-architecture/designs/S2-composition-externalization.md`
> （S2）与 `.../S4-preset-realm-distribution.md`（S4）。

## 一分钟上手

在 `~/.lantai/composition/roster.patch.yml`（Windows：
`%USERPROFILE%\.lantai\composition\roster.patch.yml`）写 patch：

```yaml
# 禁用 web 工具行 + 禁用某个插件工具行 + 在行为规则段后插入团队定制段
tools:
  - id: plugin/hologram/web-domain/web_fetch
    disabled: true
  - id: plugin/hologram/shell-domain/run_shell
    disabled: true
shell:
  - id: hologram/shell-sandbox-probe
    disabled: true
prompt:
  - insert:
      - id: team-rules
        after: behavior-rules
        text: |
          【团队定制规则】
          1. 提交信息用中文。
          2. 不改 docs/archive/ 下任何文件。
```

（①b 起 builtin 行表退役——全部十四族工具行均走
`plugin/hologram/<域>-domain/<工具名>` 贡献行寻址；第一方 prompt 段 id
亦可寻址；seam provider/事件经 `seam/<域>` 域寻址。完整寻址域见
§「四个行域」与 §「seam 裁剪域」。）

保存即生效（S4-2 热重载）：**新 Agent 装配（新会话）即用新组合；在途
会话保持创建时点的组合不变**。没有这个文件（或文件为空）= 出厂组合。

## 四个行域

| 域 | 行 id 举例 | 寻址对象 |
|---|---|---|
| `tools` | `plugin/hologram/web-domain/web_fetch`、`plugin/hologram/shell-domain/run_shell`、`plugin/hologram/engine-domain/tools`… | 插件贡献行（`ctx.tools` 通道折算，①b 起为唯一行源——git/search/fs/shell/agent-isolation/web + wait/ask/memory/skill/task/agent/hologram/browser-desktop 十四族；粒度 = 单工具行或 hologram/browser-desktop 整族行） |
| `prompt` | 第一方段 id（`behavior-rules`、`multi-agent`…）、已插入段 id、插件段贡献 id | system prompt 段（真源 `prompt-sections.ts` `firstPartyPromptSections()`——13 段经 `ctx.prompts` 通道贡献；S4-4 甲起全量进寻址域：disable/text 覆盖/insert 锚定第一方段 id 均合法） |
| `capabilities` | `plan-tools`、`converge-tools`、`state-hooks`… | 会话级工具/hook（真源 `agent/blueprint.ts`；id = `AgentCapability.id`（2026-09-14 前叫 `key`，已退役）） |
| `shell` | `hologram/shell-graph`、`hologram/shell-cold-start`… | 壳引导行（真源 `composition/shell-rows.ts`；行实现 `src-ui/src/shell/rows/*`） |

> **寻址域（S4-4 甲 + ①b，2026-08-23）**：patch/preset 的组合解析域 =
> **当前通道贡献快照**（`factoryComposition()` 读取时点收编——插件工具行
> `plugin/<插件名>/<工具名>` 与 prompt 段贡献都在寻址面内；①b 起 builtin
> 行表退役，插件贡献行是 tools 域唯一行源）。
> 寻址粒度：插件工具行 = 单工具；整族行 = `plugin/hologram/engine-domain/tools`
>（hologram——名字面装配期才知）与 `plugin/hologram/browser-desktop-domain/tools`
>（browser/desktop 53 工具——族内新增工具自动覆盖，名面不被清单锁死），
> 整族一行寻址。无通道贡献装载的环境（理论态——生产 boot 必有第一方
> 插件）解析域退化为空行表 + 空段表。贡献的 register/dispose = 组合输入
> 变更：下次解析自动重取（cache 代数失效），在途会话不动（创建时点冻结）。
> 卸载/禁用整个插件仍走插件开关（设置 → 插件），不走组合 patch。

完整 id 清单以各真源文件为准——它们是唯一权威源。

## seam 裁剪域（七——平台化 Phase 3；S6 P2a 起**按 Agent 取值**）

Phase 1/2 开放的全部 swappable seam 并进组合解析域：每个 seam provider
（或 D4 事件）是一条可寻址行，域键 = `seam/<ctx 键名>`（`seam/` 前缀与四个
行域键隔离——`shell` 键已被壳行域占用）：

| 域 | 行 id 举例 | 裁剪对象 |
|---|---|---|
| `seam/llm` | `builtin/anthropic`、`builtin/openai` | LLM adapter（`ctx.llm`——同 kind 后注册胜） |
| `seam/subagents` | `builtin/in-process` | 子代理 provider（`ctx.subagents`） |
| `seam/fs` | `builtin/rust-fs` | 文件系统后端（`ctx.fs`） |
| `seam/shell` | `builtin/rust-shell` | shell/子进程后端（`ctx.shell`） |
| `seam/sessionPersistence` | `builtin/rust-sessions` | 会话持久化后端（`ctx.sessionPersistence`） |
| ~~`seam/graph`~~ | ~~`builtin/rust-graph`~~ | 已退役——随图谱功能全量退役，2026-09-09 |
| `seam/loopEvents` | `turn/start`、`subagent/spawn`… | D4 emit 观测事件（事件面开关——裁决域 tool/guard 等不开放） |

**语义（注册表 = 实现真源，组合 = 裁剪真源）**：

- 禁用某行 = 从对应 seam 的「后注册胜」消费视图剔除该 provider；**替换
  默认 provider** = 插件/动态贡献一个替代 provider（后注册即胜）+（需要时）
  禁用默认行。全部禁用 = 消费面响亮报错（`FS_PROVIDER` / `PROVIDER_DIALECT` /
  `SUBAGENT_PROVIDER` / `SESSION_PERSISTENCE_PROVIDER`
  / `SHELL_PROVIDER`——显式降级非静默）。
- **晚注册可见**：解析之后新注册的 provider 不被误裁（除非其 id 显式在
  禁用集）——组合表达「裁剪谁」，不表达「冻结清单」。
- `seam/loopEvents` 禁用事件 = 该事件不再广播（观测面裁剪；事件非模型可见、
  不进 session log，禁用不影响 loop 执行本身）。
- **生效时机 = 调用期**：seam 消费面按**本 Agent 组合**的禁用集在每次调用时
  过滤（与 Phase 2 调用期扫描语义一致）。
- **裁剪面按 Agent 取值（S6 P2a，2026-09-15；此前是全局一份）**：
  - **有组合上下文的路径**：fs/shell 工具族按 executor 注入的 `_owner_id`
    （= Agent bus id）查装配期登记的裁剪面（`composition/seam-scope.ts`，Agent
    构造期 `ctx.effect` 登记、拆卸即清）；`ctx.subagents` 消费点直接用本 Agent
    的组合；`emitLoopEvent` 读**本 Agent 那条总线**上灌入的视图（`setSeamView`，
    emit 调用点零改动）。
  - **无组合上下文的旧路径**（UI 直调 / 无 agent 的工具路径 / 第三方 provider
    自测）：读 `composition-store` 灌入的**全局当前选择**——语义 = P2 前行为，
    逐字零漂移。
  - 因此**同一份注册表、同一个工具实例**，两卷可各走各的 provider（A 卷裁掉
    替换实现即走 builtin 本地实现，B 卷裁掉默认实现即走替换实现，互不串味）。
  - **`seam/sessionPersistence` 例外（如实声明）**：该 seam 的消费面是会话
    存储基础设施（读盘在装配之前），本轮仍只读全局当前选择——per-volume
    后端要「读也按该卷组合」，需要另立「卷 → 组合」外部索引，属独立批次。
- 权限咽喉 / plan gate / 审计在 executor 管道层与 RPC 平台面——**换
  provider、禁 provider 均不豁免强制层**（P2-C3 守卫测试钉死）。

```yaml
# 例：换默认 fs 后端（插件贡献了 my/fs 后）+ 关掉 subagent 观测事件
seam/fs:
  - id: builtin/rust-fs
    disabled: true
seam/loopEvents:
  - id: subagent/spawn
    disabled: true
```

## patch 语法

### 禁用（四个行域 + 七个 seam 域通用）

```yaml
tools:
  - id: plugin/hologram/browser-desktop-domain/tools
    disabled: true
```

- `disabled: false` 合法：显式重新启用（供 overlay 覆盖上一层的禁用）。
- 同层同 id 多条 → 后写覆盖前写（last-write-wins）。
- **「默认关」行**（S6 P1b，2026-09-15）：插件可在贡献面声明 `defaultOff`——该行**装载照常
  注册**（通道在册、可寻址、可诊断），但**默认不进任何组合**；让它进组合的唯一方式就是在本域写
  `disabled: false`（同一个语义位，零新语法）。诊断面把它归「**未选中**」栏，与「**被禁用**」
  （显式 `disabled: true`）分开——「某行不见了」的两种原因处置动作不同。设置 → Agent →
  组合节即按三栏呈现（第三栏 = **seam 裁剪**：`seam/<域>` 被禁的 provider / 事件 id）。

### 覆盖段落文本（仅 `prompt` 域）

```yaml
prompt:
  - id: behavior-rules
    text: |
      新的规则文本…
```

`text` 整段替换渲染输出；段的 id / 位置 / applicable 条件保持不变。
S4-4 甲起可覆盖第一方段与插件贡献段（动态插值段被覆盖后丢失插值
语义——用户换整段就接管整段）。

### 插入新段（仅 `prompt` 域）

```yaml
prompt:
  - insert:
      - id: team-convention
        after: collaboration-mode   # 或 before: xxx；都不写 = 追加到表尾
        text: |
          ## 团队约定
          …
```

- `before` / `after` 互斥，锚点是现有段的 id（被禁用的段也可作锚；S4-4 甲
  起可锚定第一方段/插件贡献段）。
- 插入段的 id 不得与任何现有段 / 已插入段撞名（含通道贡献段——S4-4 甲
  统一撞名拒绝）。
- prompt 段是纯数据（id + applicable + render）；factory 层的 render 逻辑
  永不出 yml——插入段的 `text` 是静态文本。

### 应用语义

- **层序**：出厂表（代码）→ 用户层（本文件）→ preset 层（见 §「preset」）。
- **跨层 last-write-wins**；禁用行只在最终一步过滤（锚可指向禁用段）。
- **all-or-nothing**：patch 里任何一条非法（未知 id / insert 撞 id / 锚点
  不存在 / 域字段越界）→ **整个 patch 拒绝**，回退出厂组合，错误进
  console（`[composition]` 前缀）与设置面板「组合」节——不会半应用。
- **生效时机（S4-2 热重载）**：保存文件 → watcher 检出 → 重载 → 新
  Agent 装配即用新组合；在途会话不动（创建时点冻结——前缀缓存纪律）。
  删除文件 → 显式回退出厂组合。坏 patch → 可见报错 + factory 兜底
  （旧组合撤下不残留）。patch 文件被拒期间 preset 层不叠加（错误可见
  优先）。

## preset（命名的行组合叠加层——S4）

Preset = 给组合起个名字，需要时一键切换。层序与语义：

```
factory（出厂表）
  → 用户层 patch（roster.patch.yml——「这台机器的基线」）
  → preset patch（「这个会话的裁剪」——叠加最上层）
```

- **内置 system preset**（代码常量，不落盘）：
  - `standard`——零 patch = 出厂组合（缺省）；
  - `minimal`——精简面：禁 `plugin/hologram/browser-desktop-domain/tools`、
    `plugin/hologram/web-domain/web_fetch` 工具行 + `state-hooks`
    capability（V5「纸壳 preset」的原型；①b 起 builtin 行 id 退役改
    枚举 plugin 行）。
- **用户 preset**：`~/.lantai/composition/presets/<id>/`——`roster.patch.yml`
  （组合本体，语法与本文件的 patch 完全相同）+ `preset.yml`（显示元数据：
  name/description/order，纯展示）。
- **id 围栏**：`/^[a-z0-9][a-z0-9-]*$/`（id 是路径段——防 `..`/分隔符/
  绝对名把组合挪出授权根）。
- **同 id 内置胜**（用户不可影子化内置 preset）。
- **坏 preset**：发现层报 broken（设置面板可见），装配回退 factory——
  不炸发现。
- **选择**：设置 → Agent → 「组合」节的 preset 选择器（持久化）。生效：
  装配作用域（tools/prompt/capabilities）下次装配生效；壳作用域（shell
  域条目）重启生效（壳引导一次性的——「纸壳 preset」双装配的挂点在 V5）。
- preset 文件变更不触发热重载（preset 切换是显式动作——下次解析即重扫）。

## authoring（用户怎么配一份 preset —— P-1，2026-09-14）

**preset 不是出厂物**：它是**用户自己配的环境**，平台只负责把环境给足。设置 →
Agent →「组合」节的「新建 / 修改 preset」块就是这条路径的全部入口：

| 动作 | 做什么 | 说明 |
|---|---|---|
| **打开目录** | 用系统文件管理器打开 `~/.lantai/composition/`（**不存在则按需创建**，含 `presets/`） | 路径由 Rust 侧计算（`composition_dir` RPC），前端不拼家目录；Windows 落 `%USERPROFILE%\.lantai\composition` |
| **复制为模板** | 在 `presets/<id>/` 下写出 `roster.patch.yml`（模板本体）+ `preset.yml`（显示元数据） | 模板源 = 内置 `standard`（注释齐全的空骨架）或 `minimal`（现成范例）；内容从**运行时内置表派生**，不另抄清单 |
| **重新扫描** | 重跑发现层 + 按当前选择重解析 | **免重启**（此前 discovery 是 boot-once 且 preset 子树不在 watcher 范围内 → 新建的 preset 看不到，会被当成功能坏了） |

- **id 围栏**：`/^[a-z0-9][a-z0-9-]*$/`（id 是路径段——防 `..`/分隔符）；
  与内置 preset 同名会被拒（内置同 id 胜）。
- **拒覆盖**：目标目录下已有 `roster.patch.yml` 或 `preset.yml` 时**拒绝写入**
  （绝不抹掉你已写的内容）；改内容请用你自己的编辑器。
- **写错不会静默**：行 id 不可寻址 / 本文件语义错 → 该 preset 在列表里标
  「（损坏）」，选中它会被**拒绝**并给出原因（选择前校验）；解析失败时组合面
  回退「用户层 patch + 出厂组合」，绝不半应用。
- **改完不必重启**：改文件 → 点「重新扫描」即可（热重载 watcher 只盯根级
  `roster.patch.yml`，preset 子树不在其范围——这是显式动作而非遗漏）。
- 元数据文件 `preset.yml` 是纯展示（`name`/`description`/`order`），装载失败
  降级为无元数据，不拒载。

## 程序入口（按组合起卷 —— S6 P4，2026-09-16）

UI 之外的程序（评测自举 / 未来的外部协议驱动 / 插件编排）可以**在起卷时直接指定组合**：

```ts
// app/chat/session-composition.ts
createSessionWithPreset(ctx, presetId)
  → { ok: true, sessionId } | { ok: false, reason }
```

- **优先级链**：显式参数 > 卷级记录 > 全局默认。显式值在**该卷出生那一刻**写进卷级记录
  （单一真源）⇒ 卷头芯片、重开校验、落盘 `presetId` 全部自动一致，**每次开卷不必再带参**。
- **只收 preset id**（不接受内联组合片段）：组合必须是**有限可枚举**的 preset 集合——
  要程序自带组合，先用上面的 authoring 通道把它落到 `presets/<id>/`，再按 id 起卷。
- **不可解析 = 拒绝创建**：不在册 / `requires` 缺插件 / 行 id 不可寻址 ⇒ 返回具名原因，
  **一个卷都不建**（不静默回退——程序入口没有「可见提示」这个载体，回退对程序就是静默）。
- **与 UI 同尺**：UI 芯片在**空白卷**上拨组合走 `selectSessionPreset`（另一条语义：卷已存在）；
  两条路共用同一把尺子（`sessionSelectionError`）与同一份记录真源。
- **不是提权通道**：组合面只能在**已登记面内**裁剪/回开（禁用行 / 默认关行回开 / 插件按需激活），
  **不引入未注册能力**，也不与权限模式联动（能起会话者本就能跑 shell）。

## 卷首组合芯片（S6 P5，2026-09-16）

**每个卷的卷首右上角显示该卷的组合名**——多卷并排时左看右看各自不同：

| 状态 | 样子 | 能做什么 |
|---|---|---|
| **空白卷**（还没跑过一轮） | 可点的「组合 · \<名\> ▾」 | 点开选另一个 preset → **改的是这一卷**（对非活跃卷同样生效，下次装配吃到）；即使句柄不在场也先记下 |
| **跑过一轮** | 只读标签（无下拉） | 不能换——组合决定了模型看到的工具与提示面（字节契约），中途换面会让前缀缓存与已声明能力面不一致；**另起一卷再选** |

- **hover 看来源与原因**：`本卷记录（界面拨动，或程序按组合起卷时写入）` / `全局默认（新卷出生默认）`；
  组合不可用时带原因（「不在册…——装配时已回退用户层组合」）。
- **不区分"谁写的"**：界面拨动与程序起卷（见上节）落的是**同一份卷级记录**——所以 hover 只说
  「本卷记录」。要看"这份组合是程序指定的"得另立数据面（本批不做）。
- **远档（缩远到只剩地志标签）看不到芯片**：卷首本身在远档不渲染（缩糊的卷首不如无）——退回来即可。
- 创作坞设置行左端的芯片仍**只反映当前活跃卷**（新卷出生默认 / 空白卷可拨）；两者共用同一把尺子
  （`sessionSelectionError` 严一档 + 空白闸）与同一份记录真源，只是宿主不同。

## 已知涟漪（行禁用的降级面——如实记录，不修复）

| 禁用 | 后果 | 定性 |
|---|---|---|
| 工具贡献行（单工具行或整族行） | 该工具/族工具不注册；领域收敛优雅降级（该域动作缺席则域工具不生成） | 机制安全 |
| 任一工具行 | system prompt 规则 #13/#14 仍静态枚举全量域工具名 → 模型可能调到不存在的工具，报 unknown tool 后自适 | 已知限制（动态生成延期） |
| `converge-tools` | 旧细粒度名全可见（66 工具面替 14 域工具）；功能等价，前缀缓存按新面重算 | 文档声明 |
| `task-tools` / `spawn-tool` | 回退行表版 task_* / agent_spawn | 文档声明 |
| `state-hooks`（原名 `graph-hooks`，2026-09-09 图谱退役时收缩更名） | 无 LSP 诊断注入（state-read）/ 无构建结果注入（build-result）/ 无 state-preflight——模型少两类提示，另受 `hooksEnabled` 总开关约束 | 提示注入类，可禁；禁用后 LSP 诊断与构建缓存提示不再进上下文 |
| `hologram/shell-platform` | 平台 CSS 差异化标记缺失（视觉问题，无功能损失） | 文档声明 |
| `hologram/shell-graph` | 无星图、无文件可视化接线（WebGL 兜底提示层也不铺）；开项目被拒绝 | 文档声明 |
| `hologram/shell-chat` | 无对话面板；开项目 / 占位 agent 均被拒绝 | 文档声明 |
| `hologram/shell-bridges` | 无 Unity 事件桥、无权限请求卡片（权限请求将全部超时拒绝） | 文档声明 |
| `hologram/shell-keyguard` | 浏览器默认快捷键行为回来（F5 刷新可能打断应用态） | 文档声明 |
| `hologram/shell-cold-start` | 永远欢迎屏（开项目动作仍可用） | 文档声明 |
| `hologram/shell-workspace` | 无法打开/切换项目（模块可安全 import，flow 调用一致地失败） | 文档声明 |
| `hologram/shell-update-check` | 无启动自动检查更新（设置面板手动检查不受影响；新版本角标不再出现） | 文档声明 |

## 通道与安全

- patch 经 Tauri 壳的本地 HTTP 通道（`127.0.0.1:14570/composition/`，
  与插件资产同一监听）读取；端口被占时自动增位（`llm_proxy_port` RPC 解析）。
- 通道安全件与插件通道同套：路径逐段拒绝（`..` / 编码形态 / 反斜杠 /
  绝对前缀）+ canonicalize 前缀校验 + 仅 GET + 32MB 上限。
- 通道面（S4-0 扩充）：根级固定文件（roster.patch.yml）+ `presets/`
  目录索引（GET `/composition/presets/` → JSON 数组——含 roster.patch.yml
  的子目录）+ 逐 preset 文件取用。
- `HOLOGRAM_COMPOSITION_ROOT` 环境变量可重定位根目录（测试隔离用）。
- 热重载 watcher：监听根级 roster.patch.yml（mtime 轮询 + 去抖）→
  `composition:changed` 事件 → 前端重载。preset 子树不触发（§ preset）。

## ⚠️ 完全信任模型

**roster.patch.yml 是全信任输入。** 本层不做任何内容审查——prompt 覆盖
可以改写 Agent 的全部行为规则，capability 禁用可以关掉权限钩子。这与你
手工编辑 `CLAUDE.md` / 改源码是同一信任级别（本机文件 = 本机权限）。
若你的 home 目录不可信，问题不在本层。
