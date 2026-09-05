# 软件级插件（app shell）— 立案与施工图纸

> 状态：**In progress（2026-09-03 立案；2026-09-05 决策点全定稿；2026-09-06 开工，
> S0-S5 竣工——S1 数据目录 / S2 受治治理 / S3 窗口原语 / S4 唤醒回调 / S5
> notes-app 范本已落地；余 S6 文档收口 + 管理 UI 面（设计定稿后）+ 用户真机验收**
> 一句话：为兰台补「软件级插件」能力——四件套（窗口原语 / 插件数据目录 /
> 受治进程生命周期治理 / 后台唤醒回调），让完整软件能以插件形态住进兰台、
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
  dataDir 概念，插件数据散落各处）；③ 受治进程生命周期治理（mcp 雏形没有
  「就绪判定（MCP initialize 握手）/ 崩溃重启 / 三档生命周期 / 优雅回收」）；
  ④ 后台唤醒回调（minimal 定位键 PTC 式压缩交付）。
- 三缺 + 一包装收敛为一个原语判断（用户）：**软件插进来 = 在画布上开一扇窗**，
  窗带三样契约：空间所有权、开合即生命周期、窗后地盘。

## 2. 终态

### 2.1 app shell 四件套（宿主提供的基础设施）

| # | 件 | 职责 |
|---|---|---|
| A | **窗口原语（应用视图通道）** | manifest 声明 `app` 入口与窗模式；宿主窗口注册表（开/关/聚焦/停靠/浮动状态）+ 管理 UI 面（启动器/任务栏，形态由用户设计定稿）+ 窗口设施 API（供插件工具执行体调用；工具语义归插件，宿主不实现窗口工具）；窗内渲染完全归软件，**iframe 真隔离** |
| B | **插件数据目录** | 装载即分配 `<dataDir>/plugins/<id>/`；fs API 暴露（webview 侧走宿主桥 fs，受治进程走 spawn 注入路径）；随插件生命周期，卸载整体回收、备份一个目录全家走 |
| C | **受治进程生命周期治理（决策 8：受治进程 = MCP server 一种）** | manifest `mcpServers` 条目声明治理参数（restart / lifecycle 三档）；mcp-bridge 升级：spawn → initialize 握手即就绪（到点判失败报错）→ 崩溃重启（退避）→ 优雅回收；lazy 首调立即报 `service_not_ready` 并触发拉起（决策 7）；纯 GUI 软件的后端 = 零工具 MCP server |
| D | **后台唤醒回调** | 插件长任务完成 → 宿主唤醒主 Agent + minimal 定位键，内容按需取（复用现有子任务唤醒/事件通道包装，不造新轮子） |

Agent 调用面规则：**协议面是进主路的条件，不是装载的条件**。贡献工具
（ctx.tools 或 manifest.tools 通道，已有）→ Agent 可驱动、可测试、进编排主路；
无工具 → 可装载、可开窗给人用，Agent 驱动不了，不承诺视觉兜底进编排。
**工具只有两张门（决策 8，2026-09-05）：工具口（ctx.tools / manifest.tools +
toolHandlers——实现跑在宿主 webview，用宿主设施）与 MCP 路（mcpServers——
实现住在进程里，随 tools/list 进注册表）。四件套不新增第三张门：不设
「工具执行体 fetch 自己进程」的代理层，不做服务地址注入——实现要在进程里
就走 MCP 路，实现不在进程里工具口就够。**

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
  "mcpServers": {                  // 受治进程 = MCP server（决策 8：v1 唯一进程形态）
    "notes": {
      "command": "node",
      "args": ["./server.cjs"],    // 相对插件目录解析，沿用 `./` 约定
      "restart": "on-crash",       // off | on-crash
      "lifecycle": "lazy"          // lazy（首调/首开窗拉起，空闲回收）| eager（装载即拉起）| with-window（随窗开合）
    }
  },
  "dataDir": true,                 // 装载即分配插件专属数据目录
  "tools": [                       // 工具口：只放实现必须在宿主侧的工具（窗口设施类）
    { "name": "notes_open" }
  ]
}
```

要点（决策 8 收敛后）：

- 数据四工具（notes_list / notes_create / notes_delete / notes_export）**不在
  manifest 声明**——实现住在 server.cjs 里，随 tools/list 动态进注册表；
- 就绪 = **initialize 握手完成**（到点上限未握上 = 启动失败报错，免 stdout 匹配）；
- 窗 ↔ server.cjs 之间的 HTTP API 是 **app 内部的事**——manifest 不管、宿主不
  掺和（一个进程两副面孔：对宿主说 MCP，对自己的窗说 HTTP）；
- 进程要碰插件数据目录：路径由宿主 spawn 时注入（env 或 initialize 参数，
  S2 定形），进程用自身 fs 读写。

### 2.3 示例：`examples/plugins/notes-app/`（软件级插件范本）

对位 `examples/plugins/hello/` 之于基本插件，本示例是「软件级插件」的范本，
覆盖四件套闭环：

- **窗口（A）**：便签列表 + 编辑视图，窗内独立布局；
- **数据目录（B）**：便签数据存插件数据目录 `notes.json`——server.cjs 独占
  读写（数据权威单点：窗与工具都经它，不并发打架），卸载即回收；
- **受治进程（C）**：`server.cjs` 零依赖 Node 进程，两副面孔——对宿主 = MCP
  server（stdio，数据四工具随 tools/list 进注册表，就绪 = initialize 握手）；
  对自己的窗 = 极简 HTTP API（前端↔后端，宿主不掺和）。声明在 `mcpServers`
  （`node` + `./server.cjs`，`./` 约定），生命周期 lazy（首调拉起，空闲回收），
  卸载随插件回收；README 顺带讲三档启动策略差异；
- **工具面（协议面强制，两张门各司其职——决策 8）**：notes_list / notes_create /
  notes_delete / notes_export 走 **MCP 路**（实现住 server.cjs）；notes_open 走
  **工具口**（manifest.tools + handler 调窗口设施开窗——实现必须在宿主侧，
  Node 进程碰不到窗口设施；演示「Agent 命令窗口开合走插件工具」链路）。
  模型可直接驱动全部五工具；
- **异步（D）**：`notes_export` 模拟长任务：提交即返回卡片，完成经 MCP 完成
  通知由桥翻译成后台唤醒 + minimal 定位键回调；
- **README.md**：像 hello 范本那样逐零件讲解（哪些是宿主给的、哪些是插件自己
  的责任、两张门各放什么、复制它做新软件要改哪几处）。

## 3. 现状确诊（2026-09-03 摸码）

| 文件 | 现状 | 本次角色 |
|---|---|---|
| `src-ui/src/plugins/types.ts` | PluginManifest schema（inject/permissions/displace/mcpServers 等） | 扩 `app`/`dataDir` 字段 + `mcpServers` 条目治理字段（restart/lifecycle）+ zod schema + 校验 |
| `src-ui/src/plugins/loader.ts`（~700 行） | 装载器：BUILTIN_PLUGINS + loadBuiltinPlugins + loadExternalPlugins + loadOne；**宿主桥定义处（145-199）**：createElement/react/hooks/Overlay/rpc/notify/loadCss/mods | 装载时分配数据目录 + 受治进程拉起/回收接线 + 窗口注册 |
| `plugins/mcp-bridge.ts` | 外部 MCP server 挂接：stdio 进程 kill 挂插件 fiber disposer | **件 C 落点本体**：升级为受治进程管理（握手即就绪、三档生命周期、崩溃重启、空闲回收）——决策 8 后不另立 service-manager / raw service |
| `src-tauri/src/plugin_assets.rs` | 资产通道 /plugins 白名单 | 数据目录 RPC + 插件资产寻址扩面 |
| Rust 壳 app/services | 命令族业务 | 新增插件数据目录 RPC（枚举目录/读写/删除，边界锁死 plugin 根） |
| `examples/plugins/hello/` | 基本插件范本（manifest.tools 声明通道 + entry.js toolHandlers） | 范本结构参照 |
| `examples/plugins/dataflow-mcp/` | MCP 形态先例（mcpServers 声明 + server.cjs） | **notes-app 进程面的直接底本**：治理字段在其形态上加 |
| `src/composition/tool-rows.ts` + 工具通道 | 插件工具行 `plugin/<id>` 折算进 buildToolRegistry | 工具口零改动（协议面已有）；MCP 路沿用既有 tools/list 通道（表序纪律见 §7-6） |
| UI 侧（canvas-nav / paper-shell / compose-dock） | 面板 -> 视口现状 | 窗口原语落点：新视口容器组件（iframe 载体，§4-3 已拍板）+ postMessage 白名单桥 |

**确认缺漏**（grep 实证）：`src-ui/src/plugins/` 下无 dataDir/pluginData 任何概念；
宿主桥无全屏视图/窗口能力；UI 贡献通道只有面板与渲染器。

## 4. 决策点（全部已定稿，2026-09-05）

1. **窗口↔进程绑定策略：三档声明，已拍板（2026-09-03）**。lazy / eager /
   with-window，默认 lazy；三档声明于 manifest `mcpServers` 条目的 `lifecycle`
   字段（决策 8 收敛后受治进程 = MCP server 一种）；回收语义一并写死
   （见决策 4）。常驻引擎型软件用 eager，随用随起的用 lazy，窗口即外壳的
   用 with-window。
2. **数据目录生命周期**：随插件，不随窗口；卸载整体回收；备份一个目录全家走
   （无争议，按此定）。
3. **UI 隔离边界：iframe 真隔离（已拍板 2026-09-03）**。窗内容 = 插件自己的
   独立 HTML（相对插件目录寻址），天然隔离，宿主导航/状态/React 树不可达。
   代价：窗内拿不到宿主桥 `window.__lantai_plugin_host__`，需要
   **postMessage 白名单桥**按需暴露宿主能力——方法级白名单，不整体开放 mods。
   默认最小集：`fs`（插件数据目录读写）+ `notify`；其余按需申请，清单随 S3 施工定。
4. **关窗回收：默认杀（已拍板 2026-09-03，用户指出「默认不杀 = 进程泄露」）**。
   生命周期归属写死，任何受治进程必须有明确回收出口，不设「挂着不杀」的默认态：
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
   （设计件，未定稿前不施工——只 gate S3 的管理面子件，**不阻塞 S0-S2 与
   S3 前段**（窗口注册表 / iframe 载体 / postMessage 桥 / 窗口设施 API），
   推进到管理面前与用户定稿）。宿主只提供窗口设施 API（开/关/聚焦/查询，
   供插件工具执行体调用，进宿主桥或 ctx 开发者面）；窗口开合的工具语义
   归插件——Agent 要操作窗口，走插件贡献的协议层工具（如 `notes_open`）
   注册进 tools seam（与「tools 从内核拆出」方向一致：内核不实现任何
   具体工具，宿主不留窗口工具面）。第三方插件只能声明自己的窗、管理自己
   的窗，不能管理别人的窗。
7. **就绪前工具调用语义：报错，不等待（用户拍板 2026-09-05）**。宿主永不阻塞
   等待受治进程就绪：未就绪时工具调用**立即**返回结构化错误
   （`service_not_ready`，带 starting / not-running 状态）；lazy 档下这个失败
   的调用本身已触发拉起，「等待」由调用方（模型）按需重试承担，宿主只做
   「到点没就绪 → 报错」这一件事。窗口路不设宿主侧就绪门：窗瞬时开，软件
   在窗内自己启动（= 桌面双击语义，人在窗里看着它起）。启动后挂死不归宿主
   管：撞上挂死进程的调用在自己的 I/O 超时上报错；健康检查是可选项
   （MCP ping 为天然探针，默认关），插件要它才装。
8. **工具门面收敛：只有两张门，受治进程 = MCP server 一种（用户拍板
   2026-09-05 选 A）**。工具进主路 = 工具口（ctx.tools / manifest.tools +
   toolHandlers）与 MCP 路（mcpServers，tools/list）两张既有门，四件套不新增
   第三张门：「服务地址注入」与「工具执行体 fetch 自己进程」的代理层砍除。
   需要进程的软件，其后端就是 MCP server——对宿主说 MCP，对自己的窗说自己
   的 HTTP API（app 内部的事宿主不掺和）；纯 GUI 软件的后端 = 零工具 MCP
   server（决策 5 容许空工具面）；v1 不留 raw（非 MCP）进程形态——真出现
   拒绝 MCP 形状的后端需求再扩 manifest，不预建。就绪探测统一为 initialize
   握手完成，stdout 匹配等 raw 探针随之不需要。

## 5. 施工步骤（每步独立验证，门禁全绿才进下一步，一个 commit 粒度）

### S0 基线确认（无代码改动）
- 跑全部门禁记录基线：`vitest`（先清 `NODE_ENV`）、`npm run build`、
  `biome ci .`、`verify:convergence`、`cargo test`（src-tauri）。
- 确认 `tests/plugin-loader.test.ts` / `tests/first-party-manifest.test.ts` /
  `tests/face-keys.test.ts` / `tests/plugin-boundary.test.tsx` 覆盖面。
- **验收**：基线数字记录在案。
- **竣工（2026-09-06）**：基线在案——vitest 全量 257 文件（255 passed / 2
  skipped）、2527 用例（2523 passed / 4 skipped、0 failed）；`npm run build` 绿；
  `biome ci .` 679 files 0 errors；`verify:convergence` standard+minimal 通过；
  `cargo test`（src-tauri）423 bin + 1 集成 = 424 passed、0 failed。四守护测试
  覆盖面确认：plugin-loader（zod 校验 / mcpServers 形状 / 失败隔离 / C11
  工具与权限门禁 / fiber 生命周期 / D6 热重载 / face 对拍门禁）、
  first-party-manifest（清单完备性）、face-keys（面键提取）、plugin-boundary
  （渲染崩溃隔离）。基线 HEAD `1a6b1496`、工作树干净。

### S1 插件数据目录（最薄，先建，B 是 A/C/D 的公共底座）
- `types.ts`：manifest 加 `dataDir: true`（schema + 校验，缺省 false 不分配）。
- Rust 侧：新增数据目录 RPC（`plugin_data_*`：resolved 路径枚举/读写/删除），
  根锁死 `<dataDir>/plugins/<id>/`，`..` 越界拒绝（复用现有路径校验纪律）。
- 装载侧：loadOne 时 dataDir=true 则分配目录（幂等），卸载 fiber disposer 回收
  （回收为可配置：直接删 vs 留 `.trash`，默认留 `.trash` 安全网）。
- 宿主桥：加 `fs` 数据目录面（读/写/列/删，锁定 plugin 根）。
- **验证**：新测试：a) 装载即目录存在；b) 卸载回收（trash）；c) 越界路径拒绝；
  d) 缺省不分配不侵入。
- **竣工（2026-09-06）**：落地面——数据根 `~/.lantai/plugins-data/`（与代码
  安装根分立；`HOLOGRAM_PLUGIN_DATA_ROOT` 测试隔离，env 锁串行纪律同
  PLUGINS_ROOT_TEST_LOCK）；Rust `commands/plugin_data.rs`（ensure/list/read/
  write/delete/recycle——名字 + rel 双围栏 + canonicalize 前缀**锚定插件目录**
  而非数据根：根外与跨插件 junction 逃逸同拒；写入路径用「最深已存在祖先」
  围栏——目标不存在时祖先即安全边界）；rpc 分发 5 臂 + 形态表（ensure/
  list = JsonValue，read 文本 / write/delete unit）；**卸载回收锚点修正**：
  hook 进 `plugin_uninstall`（非计划原文的 fiber disposer——app 退出全量
  dispose fiber，挂 disposer 会把数据目录在每次退出时误删；决策 2「随插件」
  的真实语义 = install↔uninstall 跨度，回收失败降级 warn 不阻断卸载——数据
  留原位是安全方向）；宿主桥 `fs` 面（`data-fs.ts` 真源 pluginDataFs，桥面
  插件名是参数——已装插件全信任区，S3 iframe 窗口面才由容器侧绑定）；
  wrapper apply ensure 先于插件代码、失败 = error 记录（失败隔离）；开放面
  契约升 **v14**（dataDir 字段四步流程走全）；mock 同源 + rpcResultSchemas
  收编 + gen-rpc-contract-md SECTIONS 对齐（顺带清偿 R4-4 遗留的分区
  off-by-4 存量错挂——editor/protocol_bridge/plugin_install 起全部归位）；
  platform_boundary_test 基线按宪法流程更新（「强制层改动 + 宪法审查」标注
  随 commit message）。门禁全绿：vitest 259 文件（2535 passed / 4 skipped）、
  build、biome 682 files 0 errors、convergence 双档零漂移、cargo 431 passed
  （含 plugin_data 7 例 + 卸载钩子端到端）。

### S2 受治进程治理（C：mcp-bridge 升级；决策 8 收敛，不另立 service-manager）
- `types.ts`：`mcpServers` 条目扩治理字段（`restart` / `lifecycle`）+ 校验；
  旧 manifest 不带治理字段 = 现行为不变（兼容）。
- 扩 `plugins/mcp-bridge.ts`：spawn（相对插件目录解析，沿用 `./` 约定）→
  **就绪 = initialize 握手完成**（到点上限如 60s 未握上 = 启动失败报错，
  决策 7）→ 崩溃重启（on-crash 策略，有退避）→ 优雅回收（kill 挂 fiber
  disposer，现有先例）。
- 三档生命周期接线：lazy（首调拉起：未就绪立即报 `service_not_ready` +
  触发 spawn；空闲回收）、eager（装载即拉起，卸载才停）、with-window
  （随窗开合，关窗默认杀，决策 4——S2 在治理层用合成开合事件测，
  S3 接真实窗口开合）。
- 数据目录衔接：spawn 注入插件数据目录路径（env 或 initialize 参数，此步
  定形），进程用自身 fs 独占读写。
- **砍除项（决策 8）**：不做「服务地址注入」，不做 raw service 形态与
  stdout 就绪匹配。
- **验证**：新测试：a) spawn + 握手就绪成功 / 超时两路径；b) 崩溃重启策略
  生效（含退避）；c) 卸载回收进程树完整（含子进程）；d) 未就绪报错不阻塞 +
  lazy 首调报错时已触发拉起、重试可成（决策 7 钉死）；e) 三档启动策略各自
  回收出口（with-window 关窗回收 / eager 卸载回收 / lazy 空闲回收）；f) 旧
  manifest（无治理字段）行为不变。
- **竣工（2026-09-06）**：落地面——治理分岔：mcpServers 条目声明治理字段
  （restart/lifecycle 任一在场）= 受治面（`ServerGovernor` 接管，failurePolicy
  对该条目退役；http 条目声明治理字段 schema 层拒绝——无受治进程面）；皆
  缺席 = 旧形态逐字节不变（mcp-bridge.test.ts 既有套件零改动全绿 = f 钉死，
  dataflow-mcp/hello 示例不经治理面）。开放面契约升 **v15**（治理字段 + http
  拒绝，四步流程走全）。就绪 = initialize 握手 + tools/list 同窗口完成
  （缺省 60s，`raceStartupDeadline`；tools/list 是工具面产出必需，与握手同
  connect() 流——时限覆盖两者）；到点判启动失败 + 清场杀挂壁进程（实测踩中
  `McpClient.disconnect` 在 connect 未完成时早退不杀——治理器对 proc 直杀
  兜底）+ 状态回落 not-running；启动途中进程退出 = `failStart` 口立即判负
  在途 start（不等时限）。崩溃重启（on-crash）：指数退避基值 1s ×2 封顶
  30s（就绪清零）；**退避监管中装配/调用触发面不拉起**（调用触发不得绕过
  退避——防快速崩环 spawn 风暴）；with-window 无窗态崩溃不重启（不该在跑）。
  三档接线（决策 1/4）：lazy（缺省）= 装配/调用/开窗三触发面拉起 + 空闲回收
  **定 5min**（无窗才计时，窗开不回收——「idle 默认值随 S2 定」落定）；
  eager = 装载期 await 拉起（失败 → registerMcpServerTools 抛出 → 插件
  error）+ 卸载才停 + 崩溃无监督时装配/调用**兜底拉起**（实现补充——计划
  只写「装载即拉起，卸载才停」，不加兜底则 eager+restart:off 崩溃即死局）；
  with-window = 随窗开合（开窗拉起/关窗即杀/多窗计数全关才杀）——S2 合成
  事件 `notifyPluginWindowOpened/Closed`（mcp-bridge 导出面，S3 窗口注册表
  接真实开合）。决策 7 fail-fast：未就绪调用立即抛 `service_not_ready`（带
  **调用时**状态 starting/not-running——捕获于触发拉起前，触发会把状态同步
  翻成 starting）+ 触发拉起；受治行 **noCache**（①c 纪律：每装配真打治理器
  ——否则实例缓存挡住装配兜底拉起）。数据目录注入**定形 env**（§2.2「env
  或 initialize 参数」落 env）：`LANTAI_PLUGIN_DATA_DIR` = S1
  plugin_data_ensure 路径，loader wrapper 捕获传入，受治/旧形态 spawn 同注
  （dataDir 契约与治理正交；未声明 dataDir 不注入行为不变）；理由：任意语言
  后端可用 + 握手前即可读（窗 HTTP 面同源消费）+ MCP initialize 参数是协议
  面不掺宿主私货（dataflow-mcp 的 DATAFLOW_ROOT 先例同构）。Rust 侧：
  protocol_bridge_spawn 加 env（**追加非替换** + 键围栏：空/含 '=' 或 NUL
  拒）；kill 升级**进程树终止**——Windows `taskkill /PID /T /F`（孙进程树
  杀 PowerShell PassThru PID 法 cargo 测试钉死）；unix process_group(0) +
  kill -9 -PGID 实现在案但本机无 unix 环境**未实测**（Windows 是本产品验证
  路径）；spawn_process/kill_process_tree 抽无 AppHandle 纯函数（cargo 直测
  面）；rpc 分发 + opt_str_map 帮助函数 + gen-rpc-contract-md OPT_HELPERS
  收编 str_map（契约文档重生成，env 进可选列）。受治 bridgeId **代次后缀
  （#N）**：重启换代不覆盖 Rust PROCS 注册表行——旧代 exit/stdout 事件不
  误伤新代（legacy bridgeId 逐字节不变）。测试 a–f：a/b/d/e + env 注入 +
  with-window 合成事件 + 卸载不复活 = `tests/mcp-bridge-governance.test.ts`
  14 例（时序参数 opts.timing 注入小值——生产缺省单测不可等待）；f 兼容 =
  mcp-bridge.test.ts 既有套件零改动 + plugin-loader schema 兼容用例；loader
  补治理字段 schema 校验 + ensure→env 注入集成用例；c 进程树 = cargo
  `kill_process_tree_reaps_grandchildren`（孙进程存活断言）+ TS 侧 dispose
  杀进程。门禁全绿：vitest 260 文件（2551 passed / 4 skipped）、build、
  biome ci 683 files 0 errors、convergence standard+minimal 零漂移、cargo
  432 bin + 1 集成 passed（含 protocol_bridge 2 新例）。

### S3 窗口原语（A，最厚）
- `types.ts`：manifest 加 `app` 字段（entry/mode/title）。
- 窗口注册表（zustand app 级 store）：open/close/focus/dock 状态，按插件 id
  与 role 寻址。
- 视口容器组件（`src/app/` 下新组件）：**iframe 载体（§4-3 拍板）**渲染窗内容，
  entry 相对插件目录寻址；浮动/停靠/全屏三种模式布局；iframe 隔离。
- **postMessage 白名单桥**：窗内向宿主要能力走方法级白名单（默认最小集
  fs 数据目录读写 + notify）；宿主向窗内广播以加载完成/卸载告警为限。
- 窗口即视图生命周期：开 = 实例化 + （with-window 时）受治进程拉起；关 = 实例
  回收 + （with-window 时）受治进程回收。
- **窗口管理 UI 面（第一方产物，与 canvas-nav 并列走产物流；形态由用户
  参与设计，设计定稿后才施工——时序见 §4-6）**：启动器（已装载软件级
  插件清单 + 开窗入口）与任务栏/浮标（打开中窗口切换 + 关闭）；浮动窗即
  画布上可拖物件，贴合画布底座；面板收敛为其停靠态的一部分。
- **窗口设施 API（宿主能力面，不是工具面）**：开/关/聚焦/查询窗口的
  facility（进宿主桥或 ctx 开发者面）；工具语义归插件——插件在 tools seam
  贡献「开窗」语义工具（如 `notes_open`），执行体调设施 API。宿主内核不
  实现任何窗口工具（与「tools 从内核拆出」方向一致）。
- **验证**：新测试（组件 + store）：a) 开窗渲染内容；b) 关窗回收实例；
  c) 三模式切换；d) 与画布底座共存不抢 pan（Canvas 的 panning 纪律）；
  e) 窗口内容不炸宿主（内容异常隔离，不 fail-loud 宿主）；f) 插件工具经
  窗口设施开窗可用（Agent 调 notes_open → 设施 → 窗口出现）端到端样例
  测试；g) 管理 UI 面走产物流装载（与 canvas-nav 同通道守护）。
- **竣工（2026-09-06）**：落地面——manifest `app` 字段（strictObject：
  entry `./` 前缀相对 HTML + 字符白名单 + 无回溯段，围栏只收 `.html`——
  草案同形；mode 三枚举缺省 floating；title 缺省插件名；未知键拒绝）；
  开放面契约升 **v16**（四步流程走全）。窗口注册表 `state/plugin-window-
  store.ts`（照 dock-store 形态）：defs（装载期登记的定义数据——启动器/
  设施寻址源）+ windows（开着实例——视口渲染源）；**openWindow 返回
  {windowId, opened}**——聚焦已有窗 opened=false（v1 每插件单窗，计划
  「按插件 id 与 role 寻址」的 v1 收缩；多窗计数机制保留在治理器侧）。
  设施 API `plugins/window-facility.ts`：open/close/focus/setMode/list/
  isOpen 六面（宿主桥 `windows` 键真源）+ `mountPluginApp`（装载挂接：
  登记定义 + ctx.effect 卸载收口——摘定义 + 关窗 + 逐窗通知治理器）。
  **真缺陷实测修复**：聚焦已开窗若也发 Opened 事件，治理器窗口计数虚增
  → with-window 关窗不杀（计数归不到零）——openPluginWindow 只在
  opened=true 时 notifyPluginWindowOpened，计数与真实开窗恒等。S2 合成
  事件面就此接上真实开合：开窗拉起（with-window）/ 关窗即杀（决策 4）/
  lazy 窗开不空闲回收。postMessage 白名单桥 `plugins/window-bridge.ts`：
  协议 `lantai-plugin-bridge`（call/result reqId 关联）；**容器侧身份绑定**
  （绑定表 contentWindow → 插件名——消息不携带也不可信插件名，S1
  data-fs「S3 窗口面才由宿主容器侧绑定」承诺兑现；未绑定 source 静默
  丢弃）；方法级白名单默认最小集 fs.list/read/write/delete + notify（其余
  按需申请，白名单外 error 回执不静默）；宿主→窗广播限 bridge-ready /
  window-closing 两种（window-closing 同拍移除尽力而为——收到无保证，
  告警为限，可靠持久化是插件自担「改动即存」）；deps 可注入（fs/notify
  ——测试隔离 RPC 通道）。视口层 `app/plugin-windows/`：PluginWindowsHost
  （body portal——ToastHost 同款纪律避 transform 包含块；无开窗零渲染；
  三模式分流：floating 直渲 / dock 进右栏 .pw-dock（底带让位创作坞
  composer-rise+composer-h-live）/ fullscreen 盖满）；PluginWindowFrame
  （iframe **sandbox="allow-scripts allow-forms allow-modals" 无
  allow-same-origin**——opaque origin 真隔离，窗内容拿不到宿主桥、
  localStorage 等同源存储面不开，数据地盘走桥 fs；书眉拖拽 document 级
  监听 + 视口夹持；帧内指针事件 stopPropagation——pan 抢占防线第二道；
  PluginBoundary 包帧体）；plugin-windows.css（纸面物件三件套：裱边带 +
  活跃落影 + 书眉行；圆角恒 0；token 全走 --paper/--ink/--sheet/--shadow-
  sheet-active；新海拔档 `--z-plugin-window: 460` 进 tokens.css 海拔目录
  ——盖面板、让位牒卡/命令面板）。loader 接线：wrapper needsApp →
  mountPluginApp（origin 闭包捕获）；宿主桥加 `windows` 键。Rust
  plugin_assets.rs：`plugin_mime` 补 html/htm → `text/html; charset=utf-8`
  （iframe 载体渲染必需——octet-stream 被 webview 拒渲染；无新增命令
  模块，platform_boundary 基线不变），traversal 测试补深路径 .html 断言
  （同一 canonicalize 围栏无深度特判）。测试 a–f 全落（g 管理 UI 面
  **gated 待用户设计定稿**，只 gate 该子件）：a/b/c/d/f/e = 三个新测试
  文件 25 例——`tests/plugin-window-store.test.ts`（schema 围栏 + 注册表
  + 设施×治理器集成：开窗 spawn/关窗杀/卸载收口/重开换代 windowId +
  loader 装载接线：装载登记 entryUrl/停用摘除/重装恢复）、
  `tests/plugin-window-bridge.test.ts`（身份绑定/白名单/reqId 关联/垃圾
  输入不炸/广播）、`tests/plugin-windows-host.test.tsx`（开窗渲染 iframe
  src+sandbox/✕ 回收/三模式布局/mousedown 不冒泡 document/书眉拖拽写回
  夹持）。门禁全绿：vitest 261 文件（2576 passed / 4 skipped，基线 2551
  + 新增 25 对账吻合）、build、biome ci 692 files 0 errors、convergence
  standard+minimal 零漂移、cargo 432 bin + 1 集成 passed（MIME 断言并入
  既有两测试，例数持平）。

### S4 后台唤醒回调（D，复用包装）
- 盘点现有唤醒链路（子任务完成唤醒父 Agent / goal 反馈 / emitLoopEvent），
  包装成插件可声明的 deferred：提交长任务 → 完成/失败唤醒主 Agent → minimal
  定位键回调（`{status, taskId, sessionId}` 形状），内容凭定位键按需取。
- 异步工具语义对两张门统一（决策 8）：工具口走 manifest.tools `async: true`
  声明；MCP 路走服务端完成通知（progress / 自定义 notification），由桥翻译成
  同一唤醒。执行即返回卡片，完成后台唤醒（对位兰台现有卡片/任务形态）。
- **验证**：新测试：a) 异步提交立即返回；b) 完成后台唤醒带 minimal 键；
  c) 失败唤醒带定位键；d) 唤醒不占上下文（回调体极小，测试钉死形状）；
  e) MCP 完成通知 → 唤醒的翻译路径。
- **竣工（2026-09-06）**：落地面——唤醒底座盘点结论：**复用 MessageBus
  systemNotify(type:'bg') 通道**（Rust 后台任务 bg:note 的同一条链——投递
  发起 Agent inbox + idle wake 回调触发，Agent 循环边界 _injectInbox 消费注入
  system-reminder；`agent_spawn async:true` → bus result 是同构先例），不造
  新轮子。宿主侧包装 `plugins/deferred.ts`：双注册表（工具口 taskId →
  发起者 / MCP 路 progressToken → 发起者，各有界 500 超限丢最旧——server
  永不发通知/插件忘 complete 是常驻泄漏面）+ **wake handler 扇出面**
  （runtime 层注入——plugins 层不持 bus，多工作区各注册各的、不认领返回
  false 交下一个；无 runtime 认领 = warn 可见，丢失兜底是插件查询工具凭
  taskId 主动取）+ `formatDeferredWakeNote` minimal 定位键格式化。
  **工具口**：manifest.tools `async: true`（开放面契约升 **v17**，四步流程
  走全）→ mountToolDeclarations 包装 execute：宿主生成 taskId
  （`ptask-<ts>-<seq>`）注入 `args._task_id`（插件回执引用同一键）+ 调用期
  登记发起者（executor 注入的 `args._owner_id`——bus id；缺席 = 无 Agent
  语境，完成时降级 warn+false 不炸）；执行立即返回（卡片语义归插件
  handler）；完成经宿主桥新键 `deferred.complete(taskId, status, message?)`。
  缺省 false 同步语义不变（无注入无登记——测试钉死）。**MCP 路**：
  McpClient 加公开 `onNotification` 订阅面（onMessageCbs 原私有）；两路
  （governedTool + legacy mcpClientTool——后者加可选 McpDeferredContext 参，
  bindToken 注入使 registry 不依赖 plugins 层）调用期绑 `dftok-<ts>-<seq>`
  token（`_owner_id` 在场才绑——无 Agent 语境不绑，行为不变），请求经
  `_meta.progressToken` 发出；server 完成通知 **method `lantai/deferred`**
  （params `{progressToken, taskId, status, message?}`——progressToken 是 MCP
  请求↔通知关联的标准锚点，server 原样回带）→ `attachDeferredNotifications`
  翻译成同一唤醒（受治路随 startOnce 挂/teardownProc 摘——每代重启重挂；
  legacy 路随 connectServer 挂/effect 摘）；progress 通知面维持原语义
  （onProgress 转发），未登记 token 的通知静默忽略。**runtime 层接线**：
  `AgentRuntime.sessionIdOf(agentId)` 公开访问器（_agentSessions 查表回
  'default'）；workspace.ts setupAgent 在 bg:note 监听旁
  `registerDeferredWakeHandler`——受理检查（bus.isRegistered）+ sessionId
  解析 + minimal note 经 systemNotify('bg') 注入；teardown 注销
  （`listener:plugin-deferred-wake`）。测试 a–e 10 例
  `tests/plugin-deferred.test.ts`：a 提交即回卡片 + _task_id 注入 + 调用期
  登记；b complete('completed') → bus bg 注入体恰含定位键 JSON + idle wake
  触发 + 唤醒即消费登记；c 'failed' 同链路；d formatDeferredWakeNote 形状
  钉死（JSON 恰三键 / 归因前缀 / message 截 160 / 全长 <200）；e MCP 路
  fake server 捕获 token → lantai/deferred 回带 → 同一唤醒（含归因工具名
  mcp__engine__notes_export）；+ 无 Agent 语境降级 + async 缺省不变 +
  server 乱发通知静默忽略。门禁全绿：vitest 262 文件（2586 passed / 4
  skipped——基线 2576 + 新增 10 对账吻合）、build、biome ci 694 files 0
  errors、convergence standard+minimal 零漂移（无 Rust 改动，cargo 不适用）。

### S5 示例：`examples/plugins/notes-app/`（软件级插件范本，用户验收主件）
- 按 §2.3 规格落地：app 窗口 + server.cjs（MCP 面 + 窗 HTTP 面）+ 数据目录 +
  两张门五工具 + async 导出 + README 范本。
- 守护测试：`tests/notes-app-example.test.ts` 钉住「示例的四件套形状」：
  manifest 字段齐全、装载即目录、MCP 握手就绪、数据工具随 tools/list 注册进
  registry（族贡献承载，见 §7-6）、notes_open 走工具口、async 回调形状
  （对位 first-party-manifest / hello 的守护套路）。
- **验收**：真机跑通端到端（用户）：装载 → 开窗 → Agent 调 notes_create →
  窗内可见 → notes_export 异步完成唤醒 → 关窗进程回收 → 卸载回收。
- **竣工（2026-09-06）**：落地面——`examples/plugins/notes-app/` 五件：
  manifest（app `{entry: "./app/index.html", mode: floating, title: 便签}` +
  dataDir true + mcpServers `{notes, stdio, node ./server.cjs, lifecycle:
  lazy}` + tools notes_open——§2.3 草案逐字段落地）；entry.js（工具口执行体
  notes_open：调宿主桥 `windows.open('notes-app')`，宿主桥缺席降级文本；
  apply 零副作用——四件套挂接全由 wrapper 承担）；server.cjs（零依赖
  Node，**两副面孔**：MCP stdio——initialize / tools/list 数据四工具 /
  tools/call / **lantai/deferred 完成通知**（progressToken 回带 + 自订
  taskId）；窗 HTTP——127.0.0.1 动态端口 + **CORS `*`**（窗是 sandbox
  iframe 的 opaque origin）+ 端口落 `port.json` 进数据地盘（窗经桥 fs 读到
  再直连）；**数据权威单点 = server 进程**（notes.json 单写者——窗与工具
  都经它不并发打架）；`LANTAI_PLUGIN_DATA_DIR` env 定位地盘（独立裸跑回退
  插件目录 .data/）；notes_export 双模：无 taskId 提交（卡片 +
  `{taskId, progressToken}` 挂账，1.2s 后写导出文件 + 发完成通知），带
  taskId **取结果**（凭定位键按需取——内容不进唤醒体））；app/index.html
  （自包含窗页：桥 SDK——call/result reqId 关联 + bridge-ready 引导 +
  window-closing 告警语义；启动时 fs.read port.json 重试环（lazy 档开窗
  触发拉起，server 可能还在起）；增删经 HTTP 直连 server；notify 演示桥
  面能力）；README（宿主四件套逐件对照表 / 插件自己的责任 / 两张门各放
  什么 / 复制范本改哪五处 / 三档启动策略差异 / 真机验收路径）。守护测试
  两文件 7 例（环境按原生面拆分——真进程集成 node、loader 集成 jsdom）：
  `tests/notes-app-example.test.ts`（@vitest-environment node——**真
  server.cjs 进程集成**：child_process spawn 非 fake IO，lazy 装配触发拉起
  → 握手就绪 → 数据四工具随 tools/list 进 registry（`mcp__notes__*` 四名
  钉死）→ notes_create 落数据地盘 notes.json → notes_list 可见 →
  notes_export 提交即回卡片 + **真 server 发 lantai/deferred → 桥翻译成
  唤醒**（归因 `notes-app · mcp__notes__notes_export` 钉死）→ 凭 taskId
  取导出内容 → 删；窗 HTTP 面：port.json 落盘 + /notes CORS `*` 应答 +
  OPTIONS 预检 204）+ `tests/notes-app-loader.test.ts`（jsdom——真
  manifest + 真 entry 模块装载：ensure 以插件名调用 / 窗口定义登记
  entryUrl / notes_open 行 `plugin/notes-app/notes_open` → 执行调宿主桥
  windows 设施开窗 / 停用摘定义）。**踩坑实录**：①src/bridge.ts 模块顶层
  裸引用 `window`（`'__TAURI_INTERNALS__' in window`）——node 环境真进程
  测试炸，加 `typeof window !== 'undefined' &&` 守卫（webview/jsdom 语义
  逐字节不变，node 回落 mock 通道）；②真 entry 导入：examples 在 src-ui
  根外，file URL 被 vite fs.allow 拒——自包含 ESM（零 import）经 data URL
  装载，逐字节是范本真身；③loader 测试裸 `new Context()` 下 wrapper
  `inject ['tools']` fiber PENDING、apply 静默不跑（交接踩坑 ④ 重现）——
  根先挂 compositionServicesPlugin。**顺带修复**：bridge.ts node 守卫是
  真进程集成测试（任何插件 server.cjs 走 child_process 直测）的地基。
  门禁全绿：vitest 264 文件（2593 passed / 4 skipped——基线 2586 + 新增
  7 对账吻合，bridge 守卫零回归）、build、biome ci 696 files 0 errors、
  convergence standard+minimal 零漂移（示例不进装配面——convergence 夹具
  自持，表序字节契约不受扰动）。**真机验收清单（用户跑）**：装载 → 开窗
  → Agent 调 notes_create 窗内可见 → notes_export 异步唤醒 → 关窗空闲
  回收 → 卸载 `.trash`。

### S6 文档收口
- `docs/plugins/README.md`：平台契约补「软件级插件（app shell）」章：
  四件套 + 两张门规则（决策 8）+ 责任切分（协议面归插件）+ manifest 字段表 +
  装载/回收语义。
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
2. **常驻进程资源**：eager 受治进程（MCP server）随插件常驻，内存/端口占用
   需监控；崩溃重启要有退避防抖动。
3. **生命周期泄露**（§4-4 已立法）：任何受治进程必须有回收出口——lazy 空闲
   回收的 idle 超时、with-window 关窗回收都要测试钉死；卸载时进程树回收完整
   （含子进程，沿用 mcp 先例但补验证）。泄露即 bug。
4. **数据目录权限边界**：插件只能碰自己的根，路径校验不能绕过（复用 Rust
   侧既有路径纪律，测试钉死越界拒绝）。webview 侧走宿主桥 fs、受治进程走
   spawn 注入路径——两侧同根；数据权威单点是插件作者的设计责任
   （范本 notes-app 示范单写者）。
5. **窗口与画布底座冲突**：浮动窗不能抢画布 pan/聚焦（canvas 的 panningRef
   纪律），停靠态不能打乱现有 dock 布局，S3-e 测试钉死。
6. **工具表序漂移**：S5 示例数据工具经 MCP tools/list 进面，属**动态名面族**
   ——必须走「一行贡献承载整族」的 Tool[] factory 形态（P4 ①c 纪律，
   noCacheContributions），不得锁死成静态清单；表序不得扰动既有字节契约
   （DeepSeek 前缀缓存依赖序），S5 验证集成进 convergence 对拍。

## 8. 关联与文档落点

- **件 C 落点本体**：`plugins/mcp-bridge.ts`（升级目标，不只是参照）；MCP
  形态先例 `examples/plugins/dataflow-mcp/`（notes-app 进程面的直接底本）；
  装载调度层 `plugin-bundle-retirement-plan.md`（四件套与装载层正交：
  装载层管「装不装得上」，app shell 管「装上了怎么活」）。
- 示例关联：`examples/plugins/hello/`（基本范本，本次 notes-app 是其软件级
  对位范本）。
- 文档落点：`docs/plugins/README.md` §平台契约补章、`docs/cookbook/` 新指南、
  `docs/plans/README.md` 计划入口登记、竣工转 `docs/archive/`。
- 本计划不触碰：工具行表序、prompt 段、seam 裁剪域、冻结文件
  （chat-session/chat-stream/part-mutator/execution-state）、布局参数。

## 9. 成本粗估（供排期参考）

S1 数据目录 0.5-1 天 · S2 受治进程治理 1-1.5 天（决策 8 收敛后变薄）·
S3 窗口原语（iframe + postMessage 白名单桥 + 窗口设施 API）3-4 天 ·
S4 唤醒回调 0.5-1 天 · S5 示例 1-2 天 · S6 文档 0.5 天。合计 **7-10 天**
（管理 UI 面设计定稿另计）。
依赖序：S1 → S2 → S3 → S4 可部分并行（S3/S4 于 S2 后并行），S5 依赖全建完，S6 收口。
