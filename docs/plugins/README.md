# HoloGram 插件指南（docs/plugins/README.md）

> S4 竣工（2026-08-20）；S3 第一方行化（2026-08-22）；P4 A-1 prompt 段贡献
> 通道（2026-08-23）。插件 = 经 webview 动态 import 装载的自包含 ES 模块，
> 向宿主注册**面板 / 命令 / 工具 / 块渲染器 / prompt 段**贡献。
> 完全信任模型——安装前必读 §6。从零到跑通的最短路径：
> `examples/plugins/hello/README.md`。
> 第一方插件先例（编译期 bundle 内，不走磁盘通道）：`paper/paper-plugin.ts`
> （面板 + 命令）、`plugins/settings-plugin.ts`（面板 + 命令，S3 样板）、
> `plugins/git-search-plugin.ts`（工具域，P4 B① 样板）。

## 目录

1. [五个概念](#1-五个概念)
2. [插件目录与 manifest](#2-插件目录与-manifest)
3. [通道 API](#3-通道-api)
4. [宿主桥（无裸 import 的平台契约）](#4-宿主桥无裸-import-的平台契约)
5. [安装 / 卸载 / 禁用](#5-安装--卸载--禁用)
6. [⚠️ 完全信任模型（安装前必读）](#6-️-完全信任模型安装前必读)
7. [KV-cache 注意事项](#7-kv-cache-注意事项)
8. [preset（行组合预设）](#8-preset行组合预设)
9. [未决项（如实声明）](#9-未决项如实声明)

## 1. 五个概念

| 概念 | 是什么 | 真源 |
|---|---|---|
| 插件 | 自包含 ESM 模块（`{ name, inject?, apply(ctx) }`） | 本文档 |
| 贡献通道 | `ctx.panels` / `ctx.commands` / `ctx.tools` / `ctx.providers` / `ctx.renderers`（块渲染器，V3b）/ `ctx.prompts`（prompt 段，P4 A-1） | `src-ui/src/composition/services.ts` + `renderer-service.tsx` + `prompt-service.ts` |
| 行（row） | 组合的最小单元——工具族/prompt 段/capability/壳行各有 id | `src-ui/src/composition/*` |
| preset | 命名的行组合叠加层（standard/minimal 内置 + 用户目录） | §8 + `docs/composition/README.md` |
| patch | 四域行的增量数据（禁用/覆盖/插入） | `docs/composition/README.md` |

## 2. 插件目录与 manifest

```
~/.lantai/plugins/<插件名>/
├── manifest.json    # 必需——装载期校验
└── entry.js         # manifest.entry 指定的 ESM 入口
```

`manifest.json` 全部字段：

```json
{
  "name": "hello",                    // 必需。npm scope 风格 id（如 "acme/tools"），须与目录名一致
  "version": "1.0.0",                 // 必需。semver
  "description": "一句话描述",          // 可选。设置面板展示
  "entry": "entry.js",                // 必需。相对路径，.js/.mjs，禁绝对路径/回溯段
  "inject": ["panels", "commands", "tools"]  // 可选。依赖的 ctx 服务——装载期校验存在性
}
```

装载管道（`src-ui/src/plugins/loader.ts`）：扫描目录 → manifest 校验 →
inject 依赖存在性 → webview 动态 import → `root.plugin(obj)`。任何一步
失败 → 插件状态 `error`（设置面板可见），**不炸应用**（失败隔离）。

## 3. 通道 API

通道在 `apply(ctx)` 里注册；**每个注册的返回值（disposer）必须经
`ctx.effect(() => disposer, '标签')` 登记**——这是插件生命周期纪律的全部
（fiber dispose 即干净退出）。

### ctx.panels —— 面板（即时生效）

```js
ctx.effect(
  () =>
    ctx.panels.register({
      id: 'my-panel',          // string 开集；与内置面板同 id → 内置胜（warn 可见）
      side: 'right',           // 'left' | 'right' | null（null = 不上轨道，命令唤起）
      title: '我的面板',
      icon: 'agent',           // ui/icons.ts 的图标名
      askAgent: false,          // 可选。面板内提供「问 Agent」入口
      unmountOnClose: true,     // 可选。关闭即卸载（默认常驻 + CSS 过渡）
      component: MyPanel,      // React 函数组件（经宿主桥 createElement——§4）
    }),
  'my-panel',
);
```

生效语义：register/dispose 即时（面板清单经信号 store bump，DockRail/
DockPanel/命令面板当场重取）。

### ctx.commands —— 命令（即时生效）

```js
ctx.effect(
  () =>
    ctx.commands.register({
      id: 'acme/do-thing',     // 约定 '<插件名>/<动作>'
      label: '做一件事',
      group: '插件',            // 命令面板分组
      shortcut: '/dothing',     // 展示用
      action: {
        type: 'local',          // local（handler 直调）| send | fill | skill
        handler: () => { /* ... */ },
      },
    }),
  'acme/do-thing',
);
```

`send`/`fill`/`skill` 型经聊天面板的命令执行面路由（需要 chat 面板在场）；
命令面板（Ctrl+K）里全部类型可见。

### ctx.tools —— 工具（下次 Agent 装配生效）

```js
ctx.effect(
  () =>
    ctx.tools.register({
      id: 'acme/query',        // 约定 '<插件名>/<工具名>'——折算后行 id = 'plugin/acme/query'
      factory: () => ({        // 注册时调用一次，实例缓存（不随每次装配重建）
        name: () => 'acme_query',      // 模型可见工具名
        description: () => '做什么',
        parameters: () => ({ type: 'object', properties: { /* ... */ } }),
        readOnly: () => true,
        execute: async (args) => '结果',
      }),
    }),
  'acme/query',
);
```

关键语义：

- **生效时机是下次 Agent 装配**（新会话）——工具面变更 = 前缀缓存边界，
  只发生在会话边界（§7）。
- 行 id 折算：贡献 id → `plugin/<贡献 id>`。**注意（2026-08-23 勘正）**：
  patch/preset 的组合解析域当前只含 builtin 行——`plugin/…` 行 id 尚不能
  被 roster.patch.yml 寻址禁用（「组合均匀性」是 S4-4 机器桥批的扩展点，
  届时纳入；当前卸载/禁用插件走 §5 的插件开关，不走红组合）。
- 工具实例缓存：dispose 清缓存（被卸载的工具实例不再进装配）。
- **factory 可选收装配上下文**（2026-08-23 P4 B① 放宽）：折算装配时以
  `factory(rowCtx)` 传入（`ToolRowContext`——`codingExec` 等装配期依赖）。
  外部插件无参 factory 仍完全合法；收 ctx 的贡献自担「首装配实例跨装配
  复用」的语义等价责任（依赖装配期真值的能力不适用——实例缓存会锁存
  首装配真值）。
- 撞名语义：两个插件贡献同名 id → 前缀不同不撞；**真正的撞名**是两个
  工具 `Tool.name()` 相同 → 行表装载期拒绝（duplicate throw）。

### ctx.providers —— 预留（不接线）

注册表现状可用，但当前无消费者（S4-1.5 复审裁定：无消费者不开通道——
先接线只剩静默 no-op 一种坏结局）。真实消费者出现时再开。

### ctx.renderers —— 块渲染器（纸壳，即时生效）

第五贡献通道（paper-shell V3b，2026-08-22）：向纸视图注册块**体**渲染器——
纸壳的块协议（语义声明 + 可插拔渲染器）的插件面。渲染器只渲染块体
（kind 特定内容）；块壳（头部/拖拽手柄/收回按钮）是纸壳结构件，不开放。

```js
ctx.effect(
  () =>
    ctx.renderers.register({
      id: 'acme/markdown',      // 惯例 '<源>/<kind>'；与内置同 kind 并存时后注册胜
      kind: 'markdown',          // 块类型，或 '*'（兜底渲染器）
      component: MyRenderer,     // React 组件，入参 { block }（block.payload 按 kind 取内容）
    }),
  'acme/markdown',
);
```

### ctx.prompts —— system-prompt 段落（下次 Agent 装配生效）

第六贡献通道（P4 A-1，2026-08-23）：向 Agent 系统提示词追加段落——工具指导、
领域约定、团队规范等静态文本面。

```js
ctx.effect(
  () =>
    ctx.prompts.register({
      id: 'acme/conventions',       // 约定 '<插件名>/<段名>'
      applicable: (ctx) => true,     // 可选。返回 false 时本段跳过（如按有无图分流）
      render: (ctx) => `

## 团队约定
- 提交信息用中文
- 不改 docs/archive/ 下任何文件`,   // 产出含自身前导分隔符的完整文本（与内置段同契约）
    }),
  'acme/conventions',
);
```

关键语义：

- **生效时机是下次 Agent 装配**（新会话）——system prompt 在会话创建时点
  拼装，在途会话保持创建时点的段落面不变（前缀缓存纪律，§7）。
- 拼装位置恒在**解析产物末尾**（出厂表或 roster 解析表之后）——贡献段
  不进组合解析域，patch/preset 不能覆盖/禁用/锚定它（同 tools 通道的
  `plugin/…` 行现状；S4-4 机器桥批的扩展点）。
- 段形状与内置段同一契约：`render` 产出**含自身前导分隔符**的完整文本
  （首段用 `\n\n## 标题` 开头；缺前导换行会与上一段粘连——字节面纪律）。
- `applicable` 收全量 `PromptSectionContext`（graphData/projectPath/providerName/
  memorySection 等）——可按装配环境条件参与。
- 重名 id 装载期拒绝（throw）；disposer 经 ctx.effect 登记（同全部通道）。

关键语义：

- 内置灰框渲染器 = 默认行（七 kind：user/markdown/reasoning/notice/diff/plan/tool，
  id 形如 `builtin/<kind>`）；插件贡献同 kind 的行 → **后注册胜**（显式覆盖）。
- `kind: '*'` 是兜底行——无专渲染器的 kind 落这里（专行优先，不劫持）。
- 即时生效（渲染期消费，每帧重取）——与 panels 同族，无需信号 store。
- 消费面：纸视图（PaperPanel）的 BlockView 经 `resolveRenderer(kind)` 解析。

## 4. 宿主桥（无裸 import 的平台契约）

**插件模块经 webview 动态 import 装载——没有包管理器、没有 import map，
裸 import（`'react'`、`'zod'`…）不可解析。插件必须自包含。**

需要宿主能力时经全局桥：

```js
const host = globalThis.__lantai_plugin_host__;
// host.createElement —— React.createElement 形状（面板组件构造）
// host.notify —— 状态栏通知（命令动作的最小 UI 反馈）
```

桥由装载器在装载第一方插件前注入。无桥环境（旧版本/测试降级）时插件
应自行降级（hello 示例的标准写法：`ce = host?.createElement ?? 兜底`）。

工具 schema 的对应纪律：`defineTool` + zod 是**编译期**工具链，运行时
模块用不了——插件侧手写 JSON shape + 入参校验（`execute` 里自己做）。

## 5. 安装 / 卸载 / 禁用

三个 RPC（设置面板「插件」tab 是 UI 面）：

| 动作 | 入口 | 语义 |
|---|---|---|
| 安装 | `plugin_install`（registry 名 / tarball URL·路径 / 本地目录） | 下载→解包→**tar-slip 防护**（绝对路径/`..`/空段/盘符/符号链接逐条拒绝）→`.tmp` 原子落盘→重名拒绝 |
| 卸载 | `plugin_uninstall`（name） | 删目录（幂等；名字围栏防路径逃逸） |
| 禁用 | `plugin_set_enabled`（name, enabled） | plugins.json 读改写（`{"disabled": [...]}`）——不动目录 |

**三者均重启生效**（装载是 boot 期一次性）。更新 = 同名重装（先卸载或
走「卸载 + 安装」的原子复合；版本比较是未决项——§9）。

registry 缺省 `https://registry.npmjs.org`；镜像经 manifest 外的安装参数
`registry` 覆写（安装输入框暂只收包名——镜像参数走 RPC 直接调用）。

## 6. ⚠️ 完全信任模型（安装前必读）

**插件是本机全信任代码：可读写文件、起子进程、调用全部 RPC。npm 上的包
≠ 审核过的包。**

- 不做签名、不做校验和、不做沙箱（v1 已拍板，ADR
  `docs/adr/composition-boundaries.md` §5 信任模型）。
- 唯一边界是装载通道的路径安全（遍历防护）——那是防攻击面不是防恶意
  代码：恶意代码装进来之后**拥有你本机账户的全部能力**。
- 这与你手动改本机文件、跑 `npm install` 是同一信任级别。若你的 home
  目录不可信，问题不在插件层。

## 7. KV-cache 注意事项

DeepSeek 前缀缓存对 tools 段逐字节敏感。组合层的事件面：

| 动作 | 缓存语义 |
|---|---|
| 装/卸/禁用插件（工具通道） | **主动缓存失效事件**——新会话的工具面变了，旧缓存按新面重算（预期成本，不是 bug） |
| preset 切换 | 同上（新组合 = 新表序） |
| 用户层 patch 热重载（S4-2） | 同上 |
| 在途会话 | **永不变**——工具面在会话创建时点冻结（前缀缓存纪律；表序变 = 边界事件，只发生在会话边界） |

## 8. preset（行组合预设）

Preset = 命名的行组合叠加层（S4-1a）。层序：

```
factory（出厂表，代码真源）
  → 用户层 patch（~/.lantai/composition/roster.patch.yml）
  → preset patch（叠加最上层——「这个会话的裁剪」叠在「这台机器的基线」之上）
```

- **内置 system preset**（代码常量，不落盘）：`standard`（零 patch =
  出厂组合）、`minimal`（禁 browser-desktop/web 工具行 + graph-hooks
  capability 的精简面）。
- **用户 preset**：`~/.lantai/composition/presets/<id>/`：

  ```
  ~/.lantai/composition/presets/my-preset/
  ├── roster.patch.yml   # 组合本体（语法同用户层 patch——docs/composition/README.md）
  └── preset.yml         # 显示元数据（name/description/order——纯展示，坏文件降级不拒载）
  ```

- 选择与生效：设置 → Agent → 「组合」节选 preset（持久化到 settings）。
  **装配作用域**（tools/prompt/capabilities）：下次装配生效（新会话即见）；
  **壳作用域**（shell 域——V5 双装配挂点）：重启生效。
- 同 id 内置胜（用户不可影子化内置 preset——内置 id 是部署事实）。
- 坏 preset（yml 语法错/校验失败）：发现层报 broken（设置面板可见），
  装配侧回退 factory——不炸发现。

## 9. 未决项（如实声明）

- ~~**插件 prompt-section 贡献通道**~~ ✅ 已落地（P4 A-1，2026-08-23）：
  `ctx.prompts`（`composition/prompt-service.ts`）——段贡献追加在解析产物
  末尾，下次装配生效；§3。
- **贡献段/行的组合解析域**：patch/preset 当前只寻址 builtin 行——
  `plugin/…` 工具行与 prompt 贡献段纳入寻址域属 S4-4 机器桥批。
- **版本比较/更新提示**：manifest.version 有、UI 显示之；比较逻辑与更新
  流程属增强。
- **preset 的 UI 选择面**：当前只有设置面板默认值 + 新会话携带默认
  （DSH 四面砍到最小——新会话 chip / 会话头标签 / 管理节留给 V5 壳）。
- **机器桥（manifest mcpServers）**：S4-4 可选批——排程紧张时降级未决项
  （外部 MCP server 的声明式挂接；hello 三通道不依赖它）。
- **mcpServers http 传输鉴权**：headers 明文进 manifest——插件目录是
  全信任区，与 command 同级，不做加密仪式。

---

**维护注**：本文件是插件面的人类契约——通道 API / 生效语义 / 信任模型
变更时必须同步更新（规则与代码现状同步铁律）。机器可读的真源：
`src-ui/src/plugins/types.ts`（manifest schema）、
`src-ui/src/composition/services.ts`（四 service）、
`src-ui/src/composition/renderer-service.tsx`（块渲染器）、
`src-ui/src/composition/prompt-service.ts`（prompt 段）、
`src-ui/src/composition/plugin-tool-rows.ts`（工具行折算）。
