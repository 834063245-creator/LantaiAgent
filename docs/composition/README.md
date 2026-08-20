# 组合层（Composition Layer）— 用户指南

> S2 竣工（2026-08-20）。组合架构的「数据外化」段：工具行 / prompt 段 /
> capability / 壳行的「禁哪些、换哪段文本、插哪些段」从编译期 TS 表外化为
> 用户可改的 patch 数据文件。设计件：
> `docs/plans/composition-architecture/designs/S2-composition-externalization.md`。

## 一分钟上手

在 `~/.hologram/composition/roster.patch.yml`（Windows：
`%USERPROFILE%\.hologram\composition\roster.patch.yml`）写 patch，重启应用生效：

```yaml
# 禁用 shell 工具族 + 禁用沙箱探测壳行 + 覆盖行为规则段
tools:
  - id: builtin/shell
    disabled: true
shell:
  - id: hologram/shell-sandbox-probe
    disabled: true
prompt:
  - id: behavior-rules
    text: |
      【团队定制规则】
      1. 提交信息用中文。
      2. 不改 docs/archive/ 下任何文件。
```

没有这个文件（或文件为空）= 出厂组合，行为与未做组合层时完全一致。

## 四个行域

| 域 | 行 id 举例 | 寻址对象 |
|---|---|---|
| `tools` | `builtin/fs`、`builtin/shell`、`builtin/graph`… | 内置工具族（真源 `src-ui/src/composition/tool-rows.ts`） |
| `prompt` | `behavior-rules`、`collaboration-mode`… | system prompt 段（真源 `prompt-sections.ts`；id 是裸名） |
| `capabilities` | `plan-tools`、`converge-tools`、`graph-hooks`… | 会话级工具/hook（真源 `agent/blueprint.ts`；id = capability key） |
| `shell` | `hologram/shell-graph`、`hologram/shell-cold-start`… | 壳引导行（真源 `composition/shell-rows.ts`；行实现 `src-ui/src/shell/rows/*`） |

完整 id 清单以各真源文件为准——它们是唯一权威源。

## patch 语法

### 禁用（四个域通用）

```yaml
tools:
  - id: builtin/browser-desktop
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

- `before` / `after` 互斥，锚点是现有段的 id（被禁用的段也可作锚）。
- 插入段的 id 不得与任何现有段 / 已插入段撞名。
- prompt 段是纯数据（id + applicable + render）；factory 层的 render 逻辑
  永不出 yml——插入段的 `text` 是静态文本。

### 应用语义

- **层序**：出厂表（代码）→ 用户层（本文件）。多层 overlay 是 S4。
- **跨层 last-write-wins**；禁用行只在最终一步过滤（锚可指向禁用段）。
- **all-or-nothing**：patch 里任何一条非法（未知 id / insert 撞 id / 锚点
  不存在 / 域字段越界）→ **整个 patch 拒绝**，回退出厂组合，错误进
  console（`[composition]` 前缀）——不会半应用。
- **生效时机**：启动期解析一次（冷启动装配前）。**改 patch 需重启应用**；
  热重载是 S4 计划。

## 已知涟漪（行禁用的降级面——如实记录，不修复）

| 禁用 | 后果 | 定性 |
|---|---|---|
| `builtin/<族>` 工具行 | 该族工具不注册；领域收敛优雅降级（该域动作缺席则域工具不生成） | 机制安全 |
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

## 通道与安全

- patch 经 Tauri 壳的本地 HTTP 通道（`127.0.0.1:14570/composition/`，
  与插件资产同一监听）读取；端口被占时自动增位（`llm_proxy_port` RPC 解析）。
- 通道安全件与插件通道同套：路径逐段拒绝（`..` / 编码形态 / 反斜杠 /
  绝对前缀）+ canonicalize 前缀校验 + 仅 GET + 32MB 上限。
- `HOLOGRAM_COMPOSITION_ROOT` 环境变量可重定位根目录（测试隔离用）。

## ⚠️ 完全信任模型

**roster.patch.yml 是全信任输入。** 本层不做任何内容审查——prompt 覆盖
可以改写 Agent 的全部行为规则，capability 禁用可以关掉权限钩子。这与你
手工编辑 `CLAUDE.md` / 改源码是同一信任级别（本机文件 = 本机权限）。
若你的 home 目录不可信，问题不在本层。
