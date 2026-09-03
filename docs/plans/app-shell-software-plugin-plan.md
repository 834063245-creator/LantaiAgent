# 软件级插件（app shell）— 立案与施工图纸

> 状态：**Proposed·Draft（2026-09-03 立案，未开工）**
> 一句话：为兰台补「软件级插件」能力——四件套（窗口原语 / 插件数据目录 /
> 进程服务生命周期治理 / 后台唤醒回调），让完整软件能以插件形态住进兰台、
> 被 Agent 协议驱动；附端到端软件示例 `examples/plugins/notes-app/`
> （对位基本插件范本 `examples/plugins/hello/`）。

## 0. 一句话施工目标

把兰台插件从「贡献零件」（面板/命令/工具/渲染器/prompt 段）升级到「承载完整软件」：
装载即给数据地盘、开窗即视图、工具驱动即干活、卸载即整体回收。Agent 调用面
（工具通道 / seam / 审批门）已齐，本计划只补齐软件独立存活的基础设施，
并交付一个软件级插件示例作为范本。

## 1. 背景与动机

### 1.1 形态验证

「软件级插件」形态已有外部商品化先例（把完整 Agent 引擎作为进程外 subagent
接进宿主的产品级插件），证明成立且被市场接纳。本计划不依赖任何外部实现，
按兰台自身路线（cordis 内核 + S5 产物化 + 既有工具通道）独立自建；外部先例
仅作验收语义参照（如异步任务 minimal 定位键回调），不复刻其实现细节。

### 1.2 责任切分（用户拍板，2026-09-03）

**协议面是插件作者的义务，宿主只提供基础设施。** 插件贡献者可选择不开放协议面
（纯 GUI 软件），那是他的选择，**允许装载但不进 Agent 主路**（用户拍板
2026-09-03：喜欢插就让他们插，没必要拒装）。宿主不为「软件不配合」负责，
也不承诺视觉兜底进编排。

### 1.3 兰台现状与缺口演进

- S5 竣工后终态：14 内核 + 30 出厂产物，插件通道 = 面板/命令/工具/渲染器/prompt
  段/seam 七域；改插件 = 换产物，永不重编译 exe。
- 已有（不用再建）：工具贡献通道（ctx.tools，模型可直接调）、seam 裁剪域、
  审批门（dynamic-runner 首激活 approval）、进程外能力面雏形
  （`examples/plugins/dataflow-mcp/`：manifest 声明外部 MCP server，
  `./` 前缀 args 相对插件目录，进程 kill 挂 fiber disposer）、宿主桥
  （`window.__lantai_plugin_host__`：createElement/react/hooks/Overlay/rpc/
  notify/loadCss/mods）。
- 缺（本计划补）：① 应用级视图通道（面板 ≠ 窗）；② 插件数据目录（现无
  dataDir 概念，插件数据散落各处）；③ 进程服务生命周期治理（mcp 雏形没有
  「就绪探测/健康检查/崩溃重启/优雅回收」）；④ 后台唤醒回调（minimal 定位键
  PTC 式压缩交付）。
- 三缺 + 一包装收敛为一个原语判断（用户）：**软件插进来 = 在画布上开一扇窗**，
  窗带三样契约：空间所有权、开合即生命周期、窗后地盘。

## 2. 终态

### 2.1 app shell 四件套（宿主提供的基础设施）

| # | 件 | 职责 |
|---|---|---|
| A | **窗口原语（应用视图通道）** | manifest 声明 `app` 入口与窗模式；宿主窗口注册表（开/关/聚焦/停靠/浮动状态）+ 管理 UI 面（启动器/任务栏，形态由用户设计定稿）+ 窗口设施 API（供插件工具执行体调用；工具语义归插件，宿主不实现窗口工具）；窗内渲染完全归软件，**iframe 真隔离** |
| B | **插件数据目录** | 装载即分配 `<dataDir>/plugins/<id>/`；fs API 暴露；随插件生命周期，卸载整体回收、备份一个目录全家走 |
| C | **进程服务生命周期治理** | manifest 声明 `service`（命令/就绪约定/重启策略/启动策略）；宿主 spawn → 探活 → 健康检查 → 崩溃重启 → 优雅回收 |
| D | **后台唤醒回调** | 插件长任务完成 → 宿主唤醒主 Agent + minimal 定位键，内容按需取（复用现有子任务唤醒/事件通道包装，不造新轮子） |

Agent 调用面规则：**协议面是进主路的条件，不是装载的条件**。贡献工具
（ctx.tools 或 manifest.tools 通道，已有）→ Agent 可驱动、可测试、进编排主路；
无工具 → 可装载、可开窗给人用，Agent 驱动不了，不承诺视觉兜底进编排。

### 2.2 manifest 扩展草案（形状，schema 以 S1-S3 施工定稿为准）

```jsonc
{
  "name": "notes-app",
  "version": "1.0.0",
  "entry": "entry.js",
  "app": {
    "entry": "./app/index.html",   // 窗内容入口（插件自包含，相对插件目录）
    "mode": "floating",            // floating | dock | fullscreen
    "title": "便签"
  },
  "service": {
    "command": "node",             // 后台服务进程（相对插件目录解析，沿用 `./` 约定）
    "args": ["./server.cjs"],
    "ready": { "stdout": "notes-ready" },  // 就绪约定：stdout 匹配 | port 就绪 | file 存在
    "restart": "on-crash",         // off | on-crash
    "lifecycle": "lazy"            // lazy（首次调用拉起，空闲回收）| eager（装载即拉起，卸载才停）| with-window（随窗开合，关窗即回收）
  },
  "dataDir": true,                 // 装载即分配插件专属数据目录
  "tools": [
    { "name": "notes_list", "readOnly": true },
    { "name": "notes_create", "parameters": { "type": "object", "properties": { "title": { "type": "string" }, "body": { "type": "string" } }, "required": ["title"] } },
    { "name": "notes_export", "async": true }   // 异步任务：提交即返回卡片，完成宿主唤醒
  ]
}
```

### 2.3 示例：`examples/plugins/notes-app/`（软件级插件范本）

对位 `examples/plugins/hello/` 之于基本插件，本示例是「软件级插件」的范本，
覆盖四件套闭环：

- **窗口（A）**：便签列表 + 编辑视图，窗内独立布局；
- **数据目录（B）**：便签数据存插件数据目录 `notes.json`，卸载即回收；
- **服务（C）**：`server.cjs` 零依赖 Node 进程管存储与导出，`node` + `./server.cjs`
  声明，就绪 stdout 探测，生命周期 lazy（首次调用或开窗拉起，空闲回收），
  卸载随插件回收；README 顺带讲三档启动策略差异；
- **工具面（协议面强制）**：`notes_list` / `notes_create` / `notes_delete` /
  `notes_export`（异步）/ `notes_open`（经窗口设施开窗，演示「Agent 命令窗口
  开合走插件工具」链路），模型可直接驱动；
- **异步（D）**：`notes_export` 模拟长任务，演示提交即卡片 + 完成后台唤醒
  minimal 回调。
- **README.md**：像 hello 范本那样逐零件讲解（哪些是宿主给的、哪些是插件自己
  的责任、复制它做新软件要改哪几处）。

## 3. 现状确诊（2026-09-03 摸码）

| 文件 | 现状 | 本次角色 |
|---|---|---|
| `src-ui/src/plugins/types.ts` | PluginManifest schema（inject/permissions/displace/mcpServers 等） | 扩 `app`/`service`/`dataDir` 字段 + zod schema + 校验 |
| `src-ui/src/plugins/loader.ts`（~700 行） | 装载器：BUILTIN_PLUGINS + loadBuiltinPlugins + loadExternalPlugins + loadOne；**宿主桥定义处（145-199）**：createElement/react/hooks/Overlay/rpc/notify/loadCss/mods | 装载时分配数据目录 + 服务拉起/回收接线 + 窗口注册 |
| `plugins/mcp-bridge.ts` | 外部 MCP server 挂接：stdio 进程 kill 挂插件 fiber disposer | C 的进程管理结构参照，升级为通用 service 治理 |
| `src-tauri/src/plugin_assets.rs` | 资产通道 /plugins 白名单 | 数据目录 RPC + 插件资产寻址扩面 |
| Rust 壳 app/services | 命令族业务 | 新增插件数据目录 RPC（枚举目录/读写/删除，边界锁死 plugin 根） |
| `examples/plugins/hello/` | 基本插件范本（manifest.tools 声明通道 + entry.js toolHandlers） | 范本结构参照 |
| `examples/plugins/dataflow-mcp/` | 进程外能力面雏形（mcpServers 声明 + server.cjs） | C 的前身，升级参照 |
| `src/composition/tool-rows.ts` + 工具通道 | 插件工具行 `plugin/<id>` 折算进 buildToolRegistry | 工具面零改动（协议面已有） |
| UI 侧（canvas-nav / paper-shell / compose-dock） | 面板 -> 视口现状 | 窗口原语落点：新视口容器组件（iframe 载体，§4-3 已拍板）+ postMessage 白名单桥 |

**确认缺漏**（grep 实证）：`src-ui/src/plugins/` 下无 dataDir/pluginData 任何概念；
宿主桥无全屏视图/窗口能力；UI 贡献通道只有面板与渲染器。

## 4. 决策点（待用户拍板，开工前定）

1. **窗口↔服务绑定策略：三档声明，已拍板（2026-09-03）**。lazy / eager /
   with-window，默认 lazy；回收语义一并写死（见决策 4）。常驻引擎型软件
   用 eager，随用随起的用 lazy，窗口即外壳的用 with-window。
2. **数据目录生命周期**：随插件，不随窗口；卸载整体回收；备份一个目录全家走
   （无争议，按此定）。
3. **UI 隔离边界：iframe 真隔离（已拍板 2026-09-03）**。窗内容 = 插件自己的
   独立 HTML（相对插件目录寻址），天然隔离，宿主导航/状态/React 树不可达。
   代价：窗内拿不到宿主桥 `window.__lantai_plugin_host__`，需要
   **postMessage 白名单桥**按需暴露宿主能力——方法级白名单，不整体开放 mods。
   默认最小集：`fs`（插件数据目录读写）+ `notify`；其余按需申请，清单随 S3 施工定。
4. **关窗回收：默认杀（已拍板 2026-09-03，用户指出「默认不杀 = 进程泄露」）**。
   生命周期归属写死，任何服务必须有明确回收出口，不设「挂着不杀」的默认态：
   - `with-window`：关窗即回收（默认）；需要保活的场景（全局引擎、多窗/Agent
     引用）显式 `closeBehavior: "keep-alive"` 声明；
   - `eager`：随插件生命周期，卸载才停，窗只是浏览面；
   - `lazy`：首次调用/首次开窗拉起，**空闲回收**（无窗且超过 idle 超时无调用
     即停，再调用再拉起，idle 默认值如 5 分钟，随 S2 定）。
5. **无协议面软件：允许装载，不拒（已拍板 2026-09-03）**。装载无门槛，
   无工具也能装、能开窗给人用（iframe 隔离下攻击面可控）。但 Agent 编排主路
   仍以协议面为准：没工具 = Agent 驱动不了，不承诺视觉兜底进编排。这类插件
   明确定位为「人用的软件」，manifest 无 tools 时装载不告警不拦截。
6. **窗口管理器归宿主自建，工具语义归插件（2026-09-03 用户修正）**：
   启动器/任务栏/窗口注册表是平台自带 UI 隔间（OS 的任务栏不是 app），
   第一方产物形态（与 canvas-nav 并列走产物流，可热更）；不开放给第三方
   贡献任务栏位，避免 UI 失控。**窗口管理 UI 面形态由用户参与设计定稿**
   （设计件，未定稿前不施工）。宿主只提供窗口设施 API（开/关/聚焦/查询，
   供插件工具执行体调用，进宿主桥或 ctx 开发者面）；窗口开合的工具语义
   归插件——Agent 要操作窗口，走插件贡献的协议层工具（如 `notes_open`）
   注册进 tools seam（与「tools 从内核拆出」方向一致：内核不实现任何
   具体工具，宿主不留窗口工具面）。第三方插件只能声明自己的窗、管理自己
   的窗，不能管理别人的窗。

## 5. 施工步骤（每步独立验证，门禁全绿才进下一步，一个 commit 粒度）

### S0 基线确认（无代码改动）
- 跑全部门禁记录基线：`vitest`（先清 `NODE_ENV`）、`npm run build`、
  `biome ci .`、`verify:convergence`、`cargo test`（src-tauri）。
- 确认 `tests/plugin-loader.test.ts` / `tests/first-party-manifest.test.ts` /
  `tests/face-keys.test.ts` / `tests/plugin-boundary.test.tsx` 覆盖面。
- **验收**：基线数字记录在案。

### S1 插件数据目录（最薄，先建，B 是 A/C/D 的公共底座）
- `types.ts`：manifest 加 `dataDir: true`（schema + 校验，缺省 false 不分配）。
- Rust 侧：新增数据目录 RPC（`plugin_data_*`：resolved 路径枚举/读写/删除），
  根锁死 `<dataDir>/plugins/<id>/`，`..` 越界拒绝（复用现有路径校验纪律）。
- 装载侧：loadOne 时 dataDir=true 则分配目录（幂等），卸载 fiber disposer 回收
  （回收为可配置：直接删 vs 留 `.trash`，默认留 `.trash` 安全网）。
- 宿主桥：加 `fs` 数据目录面（读/写/列/删，锁定 plugin 根）。
- **验证**：新测试：a) 装载即目录存在；b) 卸载回收（trash）；c) 越界路径拒绝；
  d) 缺省不分配不侵入。

### S2 进程服务生命周期治理（C，mcp-bridge 升级为通用 service）
- `types.ts`：manifest 加 `service` 字段（command/args/ready/restart/lifecycle）。
- 新 `plugins/service-manager.ts`（或扩 mcp-bridge）：spawn（相对插件目录解析，
  沿用 `./` 约定）→ ready 探测（stdout 匹配 | 端口就绪 | 文件存在，上限如 60s）
  → 健康检查（可选 probe 命令）→ 崩溃重启（on-crash 策略，有退避）→ 优雅回收
  （kill 挂 fiber disposer，现有先例）。
- 服务地址注入：工具执行时能拿到服务端口/就绪状态（ctx 或宿主桥读面）。
- **验证**：新测试：a) spawn + 就绪探测成功/超时两路径；b) 崩溃重启策略生效；
  c) 卸载回收进程树；d) 就绪前工具调用语义（等待 vs 报错，按决策定）；e) 三档
  启动策略各自回收出口（with-window 关窗回收 / eager 卸载回收 / lazy 空闲回收）
  测试钉死。
- **兼容**：mcpServers 保留原语义不动（它是协议桥不是服务治理，两者并存）。

### S3 窗口原语（A，最厚）
- `types.ts`：manifest 加 `app` 字段（entry/mode/title）。
- 窗口注册表（zustand app 级 store）：open/close/focus/dock 状态，按插件 id
  与 role 寻址。
- 视口容器组件（`src/app/` 下新组件）：**iframe 载体（§4-3 拍板）**渲染窗内容，
  entry 相对插件目录寻址；浮动/停靠/全屏三种模式布局；iframe 隔离。
- **postMessage 白名单桥**：窗内向宿主要能力走方法级白名单（默认最小集
  fs 数据目录读写 + notify）；宿主向窗内广播以加载完成/卸载告警为限。
- 窗口即视图生命周期：开 = 实例化 + （with-window 时）服务拉起；关 = 实例
  回收 + （with-window 时）服务回收。
- **窗口管理 UI 面（第一方产物，与 canvas-nav 并列走产物流；形态由用户
  参与设计，设计定稿后才施工）**：启动器（已装载软件级插件清单 + 开窗入口）
  与任务栏/浮标（打开中窗口切换 + 关闭）；浮动窗即画布上可拖物件，贴合画布
  底座；面板收敛为其停靠态的一部分。
- **窗口设施 API（宿主能力面，不是工具面）**：开/关/聚焦/查询窗口的
  facility（进宿主桥或 ctx 开发者面）；工具语义归插件——插件在 tools seam
  贡献「开窗」语义工具（如 `notes_open`），执行体调设施 API。宿主内核不
  实现任何窗口工具（与「tools 从内核拆出」方向一致）。
- **验证**：新测试（组件 + store）：a) 开窗渲染内容；b) 关窗回收实例；
  c) 三模式切换；d) 与画布底座共存不抢 pan（Canvas 的 panning 纪律）；
  e) 窗口内容不炸宿主（内容异常隔离，不 fail-loud 宿主）；f) 插件工具经
  窗口设施开窗可用（Agent 调 notes_open → 设施 → 窗口出现）端到端样例
  测试；g) 管理 UI 面走产物流装载（与 canvas-nav 同通道守护）。

### S4 后台唤醒回调（D，复用包装）
- 盘点现有唤醒链路（子任务完成唤醒父 Agent / goal 反馈 / emitLoopEvent），
  包装成插件可声明的 deferred：提交长任务 → 完成/失败唤醒主 Agent → minimal
  定位键回调（`{status, taskId, sessionId}` 形状），内容凭定位键按需取。
- 异步工具语义：manifest.tools 加 `async: true` 声明；执行即返回卡片，
  完成后台唤醒（对位兰台现有卡片/任务形态）。
- **验证**：新测试：a) 异步提交立即返回；b) 完成后台唤醒带 minimal 键；
  c) 失败唤醒带定位键；d) 唤醒不占上下文（回调体极小，测试钉死形状）。

### S5 示例：`examples/plugins/notes-app/`（软件级插件范本，用户验收主件）
- 按 §2.3 规格落地：app 窗口 + server.cjs 服务 + 数据目录 + 四工具 +
  async 导出 + README 范本。
- 守护测试：`tests/notes-app-example.test.ts` 钉住「示例的四件套形状」：
  manifest 字段齐全、装载即目录、服务拉起就绪、工具注册进 registry、
  async 回调形状（对位 first-party-manifest/hello 的守护套路）。
- **验收**：真机跑通端到端（用户）：装载 → 开窗 → Agent 调 notes_create →
  窗内可见 → notes_export 异步完成唤醒 → 关窗服务回收 → 卸载回收。

### S6 文档收口
- `docs/plugins/README.md`：平台契约补「软件级插件（app shell）」章：
  四件套 + 责任切分（协议面归插件）+ manifest 字段表 + 装载/回收语义。
- 新 cookbook：`docs/cookbook/plugin-as-software.md`（写一个软件级插件的
  分步指南，notes-app 为全程示例）。
- 本计划转归档；README.md 计划入口登记本线状态。

## 6. 验证与门禁

- 每 S：`vitest` + `npm run build` + `biome ci .` + `verify:convergence`
  全绿（改动涉 agent/composition 则 convergence 必须零漂移；涉 Rust 壳加
  `cargo test`）。
- 新增测试清单见各 S；示例守护测试随 S5。
- 真机验收清单（用户跑，S5 后）：见 §5 S5「验收」。

## 7. 风险与已知矛盾

1. **iframe 隔离 vs 宿主能力可达性**（§4-3 已定甲）：窗内拿不到宿主桥
   `window.__lantai_plugin_host__`，postMessage 白名单桥是必解项不是升级口。
   白名单开面要克制（默认最小集），防窗内第三方内容滥用；窗内容 = 插件
   自包含 HTML，与现有「产物 + 宿主桥」范本双形态并存，S3 施工注意
   别把两条链搅在一起。
2. **常驻服务资源**：eager 服务随插件常驻，内存/端口占用需监控与健康检查；
   崩溃重启要有退避防抖动。
3. **生命周期泄露**（§4-4 已立法）：任何服务必须有回收出口——lazy 空闲回收
   的 idle 超时、with-window 关窗回收都要测试钉死；卸载时进程树回收完整
   （含子进程，沿用 mcp 先例但补验证）。泄露即 bug。
4. **数据目录权限边界**：插件只能碰自己的根，路径校验不能绕过（复用 Rust
   侧既有路径纪律，测试钉死越界拒绝）。
5. **窗口与画布底座冲突**：浮动窗不能抢画布 pan/聚焦（canvas 的 panningRef
   纪律），停靠态不能打乱现有 dock 布局，S3-e 测试钉死。
6. **工具表序漂移**：S5 示例工具加面不得扰动既有表序（字节契约，DeepSeek
   前缀缓存依赖序），S5 验证集成进 convergence 对拍。
## 8. 关联与文档落点

- 前身：`plugins/mcp-bridge.ts`（进程管理先例）、
  `examples/plugins/dataflow-mcp/`（进程外能力面雏形）、S5 bundle 退役计划
  （装载调度层，`plugin-bundle-retirement-plan.md`——四件套与装载层正交，
  装载层管「装不装得上」，app shell 管「装上了怎么活」）。
- 示例关联：`examples/plugins/hello/`（基本范本，本次 notes-app 是其软件级
  对位范本）。
- 文档落点：`docs/plugins/README.md` §平台契约补章、`docs/cookbook/` 新指南、
  `docs/plans/README.md` 计划入口登记、竣工转 `docs/archive/`。
- 本计划不触碰：工具行表序、prompt 段、seam 裁剪域、冻结文件
  （chat-session/chat-stream/part-mutator/execution-state）、布局参数。

## 9. 成本粗估（供排期参考）

S1 数据目录 0.5-1 天 · S2 服务治理 1-2 天 · S3 窗口原语（iframe + postMessage
白名单桥 + 窗口设施 API）3-4 天 · S4 唤醒回调 0.5-1 天 ·
S5 示例 1-2 天 · S6 文档 0.5 天。合计 **7-11 天**（管理 UI 面设计定稿另计）。
依赖序：S1 → S2 → S3 → S4 可部分并行（S3/S4 于 S2 后并行），S5 依赖全建完，S6 收口。