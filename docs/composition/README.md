# 组合层（Composition Layer）— 用户指南

> S2 竣工（2026-08-20）· S4 preset/热重载/安装通道竣工（2026-08-20）·
> S4-4 甲：插件贡献行/段进组合解析域（2026-08-23）·
> ①b：builtin 行表退役，tools 域全量走插件贡献行（2026-08-23）·
> P3：seam 裁剪域进组合解析域——llm/subagents/fs/shell/sessionPersistence/graph
> provider 与 loopEvents 事件面开关可被 patch/preset 寻址（2026-08-27）。
> 组合架构的「数据外化」段：工具行 / prompt 段 / capability / 壳行 /
> seam provider 的「禁哪些、换哪段文本、插哪些段」从编译期 TS 表外化为
> 用户可改的 patch 数据文件。设计件：
> `docs/plans/composition-architecture/designs/S2-composition-externalization.md`
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
| `capabilities` | `plan-tools`、`converge-tools`、`graph-hooks`… | 会话级工具/hook（真源 `agent/blueprint.ts`；id = capability key） |
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

## seam 裁剪域（七——平台化 Phase 3）

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
| `seam/graph` | `builtin/rust-graph` | 图分析后端（`ctx.graph`） |
| `seam/loopEvents` | `turn/start`、`subagent/spawn`… | D4 emit 观测事件（事件面开关——裁决域 tool/guard 等不开放） |

**语义（注册表 = 实现真源，组合 = 裁剪真源）**：

- 禁用某行 = 从对应 seam 的「后注册胜」消费视图剔除该 provider；**替换
  默认 provider** = 插件/动态贡献一个替代 provider（后注册即胜）+（需要时）
  禁用默认行。全部禁用 = 消费面响亮报错（`FS_PROVIDER` / `PROVIDER_DIALECT` /
  `SUBAGENT_PROVIDER` / `SESSION_PERSISTENCE_PROVIDER` / `GRAPH_PROVIDER`
  / `SHELL_PROVIDER`——显式降级非静默）。
- **晚注册可见**：解析之后新注册的 provider 不被误裁（除非其 id 显式在
  禁用集）——组合表达「裁剪谁」，不表达「冻结清单」。
- `seam/loopEvents` 禁用事件 = 该事件不再广播（观测面裁剪；事件非模型可见、
  不进 session log，禁用不影响 loop 执行本身）。
- **生效时机 = 调用期**：seam 消费面按当前组合的禁用集在每次调用时过滤
  （与 Phase 2 调用期扫描语义一致）；会话级 compositionOverride 的 seam 面
  不穿线（裁剪是全局组合语义）。
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
    `plugin/hologram/web-domain/web_fetch` 工具行 + `graph-hooks`
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

## 已知涟漪（行禁用的降级面——如实记录，不修复）

| 禁用 | 后果 | 定性 |
|---|---|---|
| 工具贡献行（单工具行或整族行） | 该工具/族工具不注册；领域收敛优雅降级（该域动作缺席则域工具不生成） | 机制安全 |
| 任一工具行 | system prompt 规则 #13/#14 仍静态枚举全量域工具名 → 模型可能调到不存在的工具，报 unknown tool 后自适 | 已知限制（动态生成延期） |
| `converge-tools` | 旧细粒度名全可见（66 工具面替 14 域工具）；功能等价，前缀缓存按新面重算 | 文档声明 |
| `task-tools` / `spawn-tool` | 回退行表版 task_* / agent_spawn | 文档声明 |
| `graph-hooks` | 无图上下文注入、无 preflight 图钩——**图优先核心工作流被关闭** | **强警告：可禁，自担** |
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
