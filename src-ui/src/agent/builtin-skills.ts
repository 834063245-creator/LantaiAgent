// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 出厂技能（builtin skills）——随 exe 分发的第三发现根（2026-09-08）。
//
// 背景：技能系统只扫两个磁盘根（项目 .lantai/skills + 用户 ~/.lantai/skills）
// ——分发 exe 给用户时两个根都是空的，Agent 手里没有任何「怎么写插件」
// 的有效信息（cordis 动态插件能力开放给模型，但模型不知道 manifest
// schema / entry 规则 / 宿主桥 / def 形状）。本模块把第一方技能编译进
// bundle：随 exe 逐位分发、无磁盘种子、无版本漂移（exe 更新即同步更新）。
//
// 优先级：项目 > 用户 > 出厂（scanSkills 收集序实现同名去重——用户/
// 项目可用同名技能覆盖出厂版，出厂面不可删不可改）。
// 形状对齐 SkillDef（name/description/whenToUse/prompt）；无 dir（不在
// 盘上——${LANTAI_SKILL_DIR} 占位符不适用，内容必须自包含）。

/** 出厂技能条目（SkillDef 的构造材料——source/dir 由 scanSkills 补全）。 */
export interface BuiltinSkillDef {
  name: string;
  description: string;
  whenToUse?: string;
  prompt: string;
}

const PLUGIN_DEV_PROMPT = `# 为兰台写插件——Agent 操作手册

兰台（Lantai）是插件化架构：**九条贡献通道**（面板 / 命令 / 模型工具 / LLM 协议
适配器 / 块渲染器 / system-prompt 段 / 管道钩子 / 会话能力 / 画布覆盖层）+ **五条
可换后端 seam**（fs / shell / sessionPersistence / subagents / agentLoop）——全部经
同一套注册机制（同一个 \`ContributionChannel\` 内核：id 寻址 + 重名装载期拒绝 +
幂等 disposer + 声明式生效时机），第一方与第三方一致。
用户让你「加个功能 / 写个插件 / 接个工具」时，按本手册动手。

## 0. 先选形态（四条路，按需求定）

| 用户要什么 | 用哪条路 |
|---|---|
| 本会话内 Agent 自己用的工具/能力（快速、临时） | **动态插件**（§1）——cordis 工具当场 define→run，无文件落盘 |
| 面板、命令、重启后仍在的持久功能 | **静态插件**（§2）——写 manifest.json + entry.js 落盘安装 |
| 接一个现成的 MCP server（Node/Python 进程或远程 HTTP） | **MCP 挂接**（§2.6）——零插件代码，声明即接 |
| 一个**能开窗的软件形态**（自己的窗口界面 + 自己的工具，像独立小软件住进兰台） | **软件级插件**（§2.7）——manifest 声明 \`app\`（相对 HTML 或环回 URL），宿主给窗口注册表 + 设施 API + 受治进程随窗开合 |

判断不了时问用户一句：这个功能是「以后一直要有」还是「现在先用一下」。
形态可以叠加：一个插件能同时有面板 + 命令 + 工具 + MCP + 窗口。

## 1. 动态插件（cordis 工具族——最快路径）

你手里有 \`cordis\` 域工具：define（定义不执行）/ run（激活，首次要用户批准，
拒绝即终局不再重问）/ stop / undefine / inspect_list / inspect_self（诊断）。

- \`code\` 是**纯 JS 函数体**：\`return { name?, apply(ctx) { ... } }\`。
  无 TypeScript、无 import、无 JSX。
- 沙箱：window/fetch/document/eval/Function/localStorage/require/process 等
  23 个危险全局在源码内恒为 undefined——拿不到 DOM/网络/存储/动态求值。
- 预算：源码 ≤256KB；apply ≤10 秒；贡献总数 ≤64 条，超限取消并回收。
- \`apply(ctx)\` 收**守卫代理**，只有两个面：
  - \`ctx.effect(fn, label)\`——fn 返回 disposer；
  - \`ctx.<服务>.register(def)\`——**守卫白名单**里的注册面（\`agent/dynamic-runner/sandbox.ts\`
    的 \`GUARDED_SERVICES\`，2026-09-14 校准后 = 九条贡献通道 + 五条 seam 全量 14 面）：
    tools / panels / commands / llm / prompts / hooks / capabilities / renderers /
    overlays / fs / shell / sessionPersistence / subagents / agentLoop。
    白名单与真装配同集由测试对拍（列了平台没有的服务即红），照它写不会踩空。
  - 白名单外的属性访问、任何赋值 → 响亮报错。直调 register 不包 effect
    是合法的（disposer 由宿主回收袋管理）。
- 贡献 def 形状与静态插件完全同构（见 §2.3）——def 缺 id / 缺函数成员
  在 register 时被拒。
- 工具贡献生效时机：**下次 Agent 装配**（新会话）；面板/命令即时。

最小样例（注册一个工具）：

\`\`\`js
return {
  name: 'my-dynamic',
  apply(ctx) {
    ctx.tools.register({ id: 'my/dynamic-tool', factory: () => ({
      name: () => 'my_dynamic_tool',
      description: () => '示例动态工具',
      parameters: () => ({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }),
      readOnly: () => true,
      execute: async (args) => '结果: ' + String(args.q),
    }) });
  },
};
\`\`\`

流程：\`cordis(define)\`（kind=new，idPrefix 3-6 个小写字母）→ \`cordis(run)\`
（用户批准）→ 失败用 \`cordis(inspect_self)\` 看诊断 → 改新版用
kind=existing 追加包 + mode=update 切换（旧包可回滚）。

## 2. 静态插件（持久形态）

### 2.1 文件结构与 manifest

一个目录 + 两个文件，目录名必须等于 manifest 的 \`name\`：

    <插件目录>/
    ├── manifest.json
    └── entry.js

manifest.json 字段（\`name\`/\`version\`/\`entry\` 必填）：

| 字段 | 说明 |
|---|---|
| \`name\` | npm scope 风格 id，≤2 段（\`hello\` 或 \`acme/foo\`），小写字母数字连字符；必须等于目录名 |
| \`version\` | semver 字符串（\`1.0.0\`） |
| \`entry\` | 相对路径 \`.js\`/\`.mjs\`，禁绝对路径与 \`..\` |
| \`description\` | 插件列表展示的一句话 |
| \`inject\` | 依赖的 ctx 服务名数组（如 \`["panels","commands","tools"]\`）——缺依赖时插件挂起等待，装载审计可见 |
| \`permissions\` | 权限类声明数组（\`read\`/\`edit\`/\`bash\`/\`git\`/\`web\`），未获用户授予则不装载（blocked，设置页可见缺哪些） |
| \`tools\` | 声明式工具（§2.4） |
| \`mcpServers\` | 声明式 MCP 挂接（§2.6） |
| \`dataDir\` | \`true\` = 装载即分配专属数据目录（\`<数据根>/<插件名>/ \`，经宿主桥 fs 面读写，卸载随插件回收进 .trash） |
| \`app\` | **软件级插件**（§2.7）：窗内容入口 + 窗模式——\`{ entry: './app/index.html' }\`（插件自包含 HTML）**或** \`{ url: 'http://127.0.0.1:PORT' }\`（环回页；仅本机、禁凭据）；\`mode\`: \`floating\`（缺省）/ \`dock\` / \`fullscreen\`（环回 URL 形态禁 fullscreen） |
| \`displace\` | \`true\` = 位移式装载：与同名内置插件共享行 id（贡献面单活互换）；第三方同名产物声明 true 可覆盖同名内置插件 |

### 2.2 entry.js 规则与宿主桥

- \`export default { name, inject?, apply(ctx) { ... } }\`（或命名导出同形状
  对象；\`toolHandlers\` 是声明式工具的保留命名导出）。
- \`apply(ctx)\` **只做注册动作**——装载期禁止任何 UI 副作用。
- 每个注册返回的 disposer 必须
  \`ctx.effect(() => disposer, '标签')\` 登记——这是生命周期纪律：插件
  卸载即链式回收全部贡献。
- **自包含，零裸 import**：插件运行时没有包管理器也没有 import map，
  \`import 'react'\` 这类解析不了。要 UI/能力走全局宿主桥
  \`globalThis.__lantai_plugin_host__\`：

| 桥键 | 用途 |
|---|---|
| \`createElement\` | React.createElement（无 JSX 构造组件） |
| \`react\` | React 全量（jsx-runtime 形态） |
| \`hooks\` | useState/useEffect/useRef/useCallback/useContext/useId/useImperativeHandle/useLayoutEffect/useMemo/useReducer/useSyncExternalStore |
| \`Overlay\` | 浮层组件 |
| \`rpc\` | \`(method, params) => Promise\` 调宿主 RPC |
| \`notify\` | \`(text)\` 状态栏通知 |
| \`loadCss\` | \`(url)\` 幂等注入插件 CSS |
| \`fs\` | 插件数据目录面（ensure/list/read/write/delete——manifest.dataDir 声明后用） |
| \`windows\` | 开/关/聚焦插件窗口（manifest.app 声明的软件形态） |
| \`deferred\` | 后台唤醒：\`complete(taskId, status, message?)\`（async 工具用） |
| \`mods\` | 宿主模块真实例注册表（进阶） |

### 2.3 贡献通道与 def 形状（全部经 \`ctx.<服务>.register(def)\`）

**panels**（面板，即时生效）：

\`\`\`js
ctx.panels.register({
  id: 'my-panel',            // 稳定 id；同 id 撞名装载期拒绝（不静默覆盖）
  side: 'right',             // 'left' | 'right' | null（null = 不上轨道）
  title: '我的面板',
  icon: 'chat',              // 宿主图标集键名（'agent'/'chat'/'check'/'settings'/'folder-open' 等天文几何图标键）
  askAgent: true,            // 可选：面板内提供「问 Agent」入口
  component: () => ce('div', { style: { padding: 16 } }, '内容'),
});
\`\`\`

**commands**（命令，即时生效，Ctrl+K 可搜）：

\`\`\`js
ctx.commands.register({
  id: 'my/say-hi',           // 惯例 '<插件名>/<动作>'
  label: '打个招呼',
  description: '示例命令',
  group: '插件',
  shortcut: '/hi',           // 输入匹配用
  action: { type: 'local', handler: () => host.notify('👋') },
  // action 四型：{ type:'send', text, displayLabel } 发消息给 Agent
  //           { type:'local', handler() } 本地执行
  //           { type:'fill', text } 填充输入框
  //           { type:'skill', skillName } 执行技能
});
\`\`\`

**tools**（模型工具，**下次 Agent 装配生效**——在途会话看不到，是前缀缓存纪律）：

\`\`\`js
ctx.tools.register({
  id: 'my/query',            // 折算后行 id = 'plugin/my/query'；两个插件前缀不同不撞
  factory: () => ({
    name: () => 'my_query',  // 模型可见工具名（重名装载期拒绝）
    description: () => '做什么',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),  // JSON Schema
    readOnly: () => true,
    execute: async (args) => '结果',   // 返回字符串
  }),
  // noCache: true,          // 依赖装配期真值时用——每装配重调 factory
});
\`\`\`

**renderers**（块渲染器，即时，后注册胜）：

\`\`\`js
ctx.renderers.register({
  id: 'my/kind',             // 惯例 '<源>/<kind>'
  kind: 'my-block-kind',     // 目标块类型字符串；'*' = 兜底渲染器
  component: (props) => ce('div', null, '块内容'),  // props: { block, folded?, ... }
});
\`\`\`

**prompts**（system-prompt 段，下次装配生效）：

\`\`\`js
ctx.prompts.register({
  id: 'my/section',
  applicable: (c) => !!c.projectPath,   // 可选：返回 false 跳过本段
  render: (c) => '\\n\\n## 本项目须知\\n…',   // 产出含自身前导分隔符的完整文本
});
\`\`\`

**hooks**（工具管道钩子，下次装配生效，进阶）：\`{ id, kind: 'enrich' | 'preflight', hook }\`——enrich 富化工具输出、preflight 工具预检。

**capabilities**（会话级能力，下次装配生效，进阶）：

\`\`\`js
ctx.capabilities.register({
  id: 'my/capability',       // 行 id（九条通道统一身份；历史名 key 已退役）
  phase: 'agent',            // 'context' | 'agent'
  when: (scope) => true,     // 可选：返回 false 跳过安装
  install: (scope) => { /* 注册工具/接线；不得做 teardown（归 ctx.effect） */ },
});
\`\`\`

**overlays**（画布覆盖层，即时）：\`{ id, slot: 'composer' | 'right-edge', component }\`。

**llm**（LLM 协议适配器，进阶）：\`{ id, kind: '<协议kind>', label?, create(rt) }\`——为 settings 的自定义协议提供 Provider 工厂，同 kind 后注册胜。

**seam provider**（后端替换，进阶）：\`ctx.fs\`/\`ctx.shell\`/\`ctx.sessionPersistence\`/\`ctx.subagents\`/\`ctx.agentLoop\` 各注册一个替换默认后端的实现——写这个等于换掉兰台的默认引擎，非必要不碰。（\`ctx.graph\` 图分析 seam 随图谱功能全量退役，2026-09-09。）

### 2.4 声明式工具（manifest.tools——更小的信任面）

工具声明放 manifest（数据），执行函数放 entry 的 \`toolHandlers\` 命名导出，
一一对应：

\`\`\`json
"tools": [ { "name": "hello_status", "description": "状态一句话", "parameters": { "type": "object", "properties": {} }, "readOnly": true } ]
\`\`\`

\`\`\`js
export const toolHandlers = { hello_status: async () => '装载正常' };
\`\`\`

加 \`"async": true\` 声明 = 执行即返卡片、宿主登记发起者，插件后台完成后经
宿主桥 \`deferred.complete(taskId, status, message?)\` 唤醒发起 Agent。

### 2.5 权限门禁

\`manifest.permissions\` 声明（\`read\`/\`edit\`/\`bash\`/\`git\`/\`web\`）未被
\`~/.lantai/plugins.json\` 的 granted 段全覆盖 → 不装载（blocked 状态，设置页
可见缺哪些授权）。无声明 = 零摩擦直接装载。

### 2.6 MCP server 挂接（零插件代码）

manifest 声明（或用户级 \`~/.lantai/mcp.json\`，形状同）：

\`\`\`json
"mcpServers": [
  { "name": "engine", "transport": "stdio", "command": "./server.cjs", "args": ["--serve"], "failurePolicy": "lazy", "readOnly": true }
]
\`\`\`

- \`transport\`：\`stdio\`（本地进程，command/args）| \`http\`（远程，url）；
- 相对路径 \`./\` 相对插件目录解析；用户级 mcp.json 的裸名 command 走 PATH
  （npx/node/...），相对形态相对 ~/.lantai 解析；
- \`failurePolicy\`：\`lazy\`（缺省：首装配连接，失败下次重试）|
  \`startup-error\`（装载期急连接，失败 = 插件 error）；
- 可选治理字段 \`restart: 'off' | 'on-crash'\` 与
  \`lifecycle: 'lazy' | 'eager' | 'with-window'\`（声明任一 = 进受治面：
  就绪握手带时限、崩溃退避重启、空闲回收；http 条目声明治理字段会被拒）。
- server 的工具经机器桥折算成宿主工具行（\`plugin/<名>/mcp/<server>\` 寻址，
  组合可禁用）。
- 可选 \`readOnly: true\`：**只读担保**（该 server 全部工具）。缺省不表态——
  按远端 \`annotations.readOnlyHint\` 判，仍无声明则 fail-closed **视为写**
  （plan 模式拦截 + 不进只读并行组）。只读 server 请显式声明；写型 server
  误声明 true 会重现「写动作绕过 plan 门禁」的洞。
- ⚠️ 挂接的子进程是**全权用户进程**（不经 fs 能力口、不受沙箱约束，可写
  任意路径）——需要沙箱/权限类/审计的动作走 shell 域，不挂 MCP。

### 2.7 软件级插件（app shell——带窗口的软件形态）

插件想「像一个小软件一样住进兰台」：有自己的窗口界面 + 自己的工具。manifest 只需
多一个 \`app\` 字段，窗内容**完全归插件**（iframe 真隔离，宿主不实现窗内语义）：

\`\`\`json
"app": { "entry": "./app/index.html", "mode": "floating", "title": "我的小软件" }
\`\`\`

入口二态（互斥，必给其一）：

| 形态 | 写法 | 隔离与能力 |
|---|---|---|
| 资产 HTML | \`"entry": "./app/index.html"\`（\`./\` 相对插件目录；须以 \`.html\` 结尾） | iframe 走 opaque origin，**宿主桥是它唯一的能力通道** |
| 环回远端页 | \`"url": "http://127.0.0.1:PORT"\`（只许本机 127.0.0.1/localhost/::1，禁凭据） | 给 \`allow-same-origin\`（远端页保住自己 origin，同源 SSE/fetch 才通）且**不绑宿主桥**；禁 \`fullscreen\` |

- \`mode\`：\`floating\`（缺省，画布浮动窗）/ \`dock\`（右停靠栏）/ \`fullscreen\`（盖满视口）。
- 窗内要宿主能力走 **postMessage 白名单桥**：默认最小集 = 数据目录 fs 面 + \`notify\`（\`manifest.dataDir: true\` + \`app\` 搭配最顺）。
- 宿主桥 \`windows\` 设施面（插件的工具执行体里调，工具语义归插件）：
  \`open(pluginName) → windowId|null\`（已开则聚焦返回原窗；v1 每插件单窗）、
  \`close(windowId)\`、\`focus(windowId)\`、\`setMode(windowId, mode)\`、
  \`list()\`、\`isOpen(pluginName)\`。
- **与受治进程联动**（S2×S3）：真开新窗才通知治理器——\`lifecycle: 'with-window'\`
  的 MCP server 随之拉起、关窗计数归零即杀；lazy 档有窗时不回收。所以「插件窗口 +
  自带后端进程」的软件形态 = \`app\` + \`mcpServers\`（带 \`lifecycle\`）两条一起声明。
- 卸载收口：定义注销 + 开着窗口全关（受治进程随关窗杀）。
- **当前没有窗口管理 UI 面**（启动器/任务栏形态待用户设计定稿）：开窗靠插件自己的
  工具（如范本 \`notes_open\`）——你写软件级插件时，记得给一个开窗工具，否则用户
  没有入口。
- 完整范本：\`examples/plugins/notes-app/\`（窗口 + 数据目录 + MCP 后端 + async 工具
  五件齐全）；指南：\`docs/cookbook/plugin-as-software.md\`；契约：\`docs/plugins/README.md\`
  §10。

## 3. 装载与验证（你的动作序列）

1. **写文件**：把插件目录写到用户指定位置（问用户或选项目内子目录——
   注意你的 fs 工具有工作区沙箱，写不进 ~/.lantai 时就写在项目里，让用户
   从那里装）。
2. **装载**：指引用户「设置 → 插件 → 安装框填目录绝对路径 → 安装」；
   或让用户把目录放进 ~/.lantai/plugins/（Windows 是
   %USERPROFILE%\\.lantai\\plugins）后重启。安装是**热装载**：面板/命令
   立刻出现，工具/段在**下次 Agent 装配**（新会话）生效。
3. **验证**：设置 → 插件 → 「已安装」组看状态。装载失败显示 error + 错误
   信息（失败隔离——单个插件失败不炸应用）；\`blocked\` = 权限未授予；
   挂起 = inject 依赖未就绪。改 entry.js 后：卸载再装（同版本重装被
   版本守卫拒绝）。
4. **工具面验证**：开新会话让用户确认工具可用。在途会话看不到新工具是
   纪律不是 bug。

## 4. 发布（可选）

插件目录加 \`package.json\`（\`"files": ["manifest.json", "entry.js"]\`）→
\`npm pack\` 产 tarball → \`npm publish --access public\`。用户安装三源：
本地目录路径 / tarball（URL 或 .tgz 路径）/ npm 包名（registry 缺省
registry.npmjs.org）。同名重装升级 = 原子换装；同版本/降级拒绝。

## 5. 红线清单（写插件前自查）

- entry.js **自包含**：零裸 import；React 经宿主桥 createElement/hooks。
- apply **只注册**，无 UI 副作用；disposer 全部经 ctx.effect 登记。
- 同 id 撞名装载期拒绝（throw，不静默覆盖）——选 id 用插件名做前缀防撞。
- 静态插件是**完全信任模型**：装进来 = 本机账户全权限。给用户装第三方
  插件前必须提醒供应链风险（npm 上的包 ≠ 审核过的包）。
- 动态插件是审批 + 沙箱模型：首次激活必须经用户批准；沙箱无进程级硬
  隔离，安全面 = 实现质量——写动态插件时不要试图绕守卫面。
- 图谱引擎（Rust 侧）扩展是源码仓库的事，不走本手册的插件系统。`;

/** 出厂技能表（scanSkills 第三发现根——随 bundle 分发）。
 *  新增出厂技能：本表加行；name 必须小写 kebab-case；内容自包含
 *  （出厂技能无磁盘目录，${LANTAI_SKILL_DIR} 不适用）。 */
export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    name: 'lantai-plugin-dev',
    description:
      '为兰台写插件的完整操作手册——动态插件（cordis 工具）/ 静态插件（manifest+entry+宿主桥+全部贡献通道 def 形状）/ MCP server 挂接 / 装载验证 / 发布',
    whenToUse:
      '用户想给兰台写/装/改插件、加面板/命令/工具/块渲染器/MCP，或想让 Agent 当场扩展兰台能力时——动手前先读本技能',
    prompt: PLUGIN_DEV_PROMPT,
  },
];
