# 内置插件名册单一真源 — 施工计划

> 状态：**✅ 已竣工（2026-09-06 当日施工，方案 B + manifest 退役获批）**
> 一句话：兰台第一方内置插件的「名单」被五张手抄镜像表重复持有，任何一处漏同步
> 都是产线功能消失（2026-09-06 小地图事故即 Rust 白名单漏 `hologram/paper-minimap`）。
> 本计划把名单收敛为单一权威名册，其余表面从它派生或受它对拍守卫——**新增/退役
> 一个内置插件只动一处，五表面自动一致，漂移 = 门禁红**。

## 0. 事故原点（2026-09-06，minimap 消失）

- 小地图插件化时前端四处登记点（factory-products / build UI_FACES / first-party-
  manifest / host-modules）齐备，Rust `BUILTIN_PLUGIN_NAMES` 第五处漏加。
- 后果：打包版资产通道对 `hologram/paper-minimap` 的 manifest fetch 404 → 产物
  装载 error → `ctx.overlays` 无贡献 → 小地图整体消失；插件页显示「装载失败」。
- `git log -S 'paper-minimap' -- src-tauri` 全历史为空——Rust 表从未加过。
- 修复 commit `6b9c1f35`（补白名单 + 双向对拍守卫 + host.aliased 形态归队）。
- **但这只是堵住这一个洞。五张表的漂移风险仍在**——下次加任何内置插件，仍要
  人肉同步五处，漏一处就是下一个消失的功能。

## 1. 现状确诊（2026-09-06 摸码实证）

### 1.1 五张「名单」表

| # | 表 | 位置 | 内容 | 谁消费 | 职责 |
|---|---|---|---|---|---|
| ① | 产物 manifest.json ×31 | `src-ui/src/plugins/builtin/<dir>/manifest.json` | name/entry/inject/version/description（+历史 displace 死字段） | loader `validateManifest` + `manifestStage`、产物通道寻址 | **产物自描述**——跟产物走，天然不可替代 |
| ② | first-party-manifest.ts | `src-ui/src/plugins/first-party-manifest.ts` | 45 条 name→{version,description,kind}（14 service + 31 feature） | loader（boot 记录/断层对账）、plugin-store 类型、PluginsPage 分组 | **身份+元数据**（超集：含无目录的 14 内核 service） |
| ③ | factory-products.ts | `src-ui/src/plugins/factory-products.ts` | 31 个产物插件对象引用，**表序=字节契约** | loader（dev 展开 + 产物装载序 `factoryOrder`） | **装载序**（dev 源码装载面 + 产物通道保序） |
| ④ | build-builtin-plugins.mjs | `scripts/build-builtin-plugins.mjs` | UI_FACES(5) + TOOL_DOMAINS(16) + SEGMENTS(2) + PROVIDERS(7) + renderers 特例 | 产物构建（esbuild 规格：hostModule/face/define/entry） | **构建规格**（非统一参数只有少量特例） |
| ⑤ | BUILTIN_PLUGIN_NAMES | `src-tauri/src/plugin_assets.rs` | 31 个 `"hologram/…"` 字符串 | 资产通道 `is_builtin_plugin_path`（用户根缺失时回退内置根判定） | **资产回退白名单** |

### 1.2 关键事实

- **① 不可替代**：manifest.json 是产物的自描述部分，随产物进 dist-plugins，loader
  在装载时校验它（name===dirId、inject 合并）。它已经是「每产物自己声明自己是谁」。
- **⑤ 是唯一 Rust 侧表**：全仓 `src-tauri` 里 `hologram/` 字面量只有
  `BUILTIN_PLUGIN_NAMES` 一处真表（其余是测试夹具/反向用例）。无 build.rs 生成先例
  （现 build.rs 仅 `tauri_build::build()`），但 `cargo tauri build` 会先跑前端构建
  （`npm run build` → `build-builtin-plugins.mjs`），生成时序可行。
- **②③④ 是 TS 侧三张镜像**：② 是超集（含 14 service），③④ 是 31 feature 的两个
  不同投影（装载序 vs 构建规格）。③④ 的值（插件对象引用 / esbuild 参数）本质由
  「目录 + 少量特例标注」决定，名单本身可推导。
- **⑤ 的语义其实可以更简单**（见 §3 方案 B）：白名单只在「用户根缺失」分支起
  「要不要试内置根」的短路作用；若删掉改为「直接试内置根、存在即回退」，语义
  等价（内置根只装第一方产物），且整张表消失。
- **① 的 displace 字段是死字段**：S5 已退役位移机制（loader 注释「displace 位移
  机制退役——产物是唯一装载面」），但 29/31 manifest 仍带 `"displace": true`。

### 1.3 多真源的代价（用户观察成立）

- 加一个内置插件 = 人肉同步 ≥5 处（目录 + manifest + 清单 + factory-products +
  build UI_FACES/分组 + Rust 白名单）；漏一处即产线功能消失，且常在打包版才暴露
  （dev 模式走源码装载不经资产通道）。
- 退役一个插件 = 同上反向，漏一处留死条目/死白名单。
- 这是典型的**多真源碎裂**——单一权威源（AGENTS 宪法第一条）被五张手抄表架空。

## 2. 目标架构

### 2.1 单一权威名册（新）

建立 **`plugins/builtin-roster.json`（单一真源，JSON 双读）**——以「产物目录」为键
的声明数据文件。TS 侧 `resolveJsonModule` 直接 import（tsconfig 已开），Node 构建
脚本直读（零 loader）——天然双读，无 TS/Node 格式分裂。

```jsonc
// 每条 = 一个内置产物插件的全部事实（scope 名 = "hologram/" + dir，派生不手写）
[
  { "dir": "renderers",     "entry": "index.tsx", "hostModule": "renderer-host",
    "define": { "globalThis.__LANTAI_RENDERER_ROW_PREFIX__": "\"plugin/hologram/renderers\"" },
    "description": "资产表现原语渲染器（…）", "buildOrder": 6 },
  { "dir": "paper-minimap", "entry": "index.ts", "hostModule": "host", "face": true,
    "description": "画布小地图（…）", "buildOrder": 11 }
  // … 31 条全量（表序 = buildOrder 升序，防误插）
]
```

**设计铁律**：
- `name`（`hologram/<dir>`）、产物 `manifest.json` 的 `entry`/`inject`、build 的
  `hostModule`/`face`/`define` 全部**从名册派生**——名册是唯一手写处。
- 装载序用**显式 buildOrder 序号**（可读、可断言、防误插），消费方按 buildOrder
  排序，与现数组隐式序语义等价。
- **名册只承载构建/清单事实，不承载插件对象与依赖面**：plugin 对象（含 name/inject
  /apply）仍由各 `builtin/<dir>/index.ts` 提供（vite 静态分析依赖，且 name/inject
  与 apply 同处才是代码真源）——名册记 dir/buildOrder/entry/hostModule/face/define/
  description，不记 name（派生）与 inject（index.ts 真源）；产物 manifest.json 生成
  时从源码插件对象取 name/inject + 名册取 entry。见 §2.2 ①。
- service（14 内核）仍留 first-party-manifest（无目录、非产物、不进本名册）。

### 2.2 五表面向名册的收敛

| 表 | 收敛方式 |
|---|---|
| ① 产物 manifest.json | **生成**：名册派生 entry/inject/name → 构建期写回各目录 manifest.json（或改为构建 tip 生成到 dist-plugins 的产物 manifest——源码目录的 manifest 退役，只留名册） |
| ② first-party-manifest.ts | **保留身份元数据**（14 service + 描述/分组），但 31 feature 条目改为**从名册对拍**（守卫测试：清单 feature 集 === 名册集），description 从名册读 |
| ③ factory-products.ts | **静态 import 壳 + 名册校验**：保留静态 import（vite 依赖），但数组改由名册驱动排序/完整性校验——守卫测试钉「factoryProducts 展开名序 === 名册 buildOrder 序」「集合 === 名册集」；plugin 对象引用在 factory-products 内静态 import（真源仍是各 builtin/index.ts） |
| ④ build-builtin-plugins.mjs | **从名册读取**：扫名册数组构建 pluginSpecs，删 UI_FACES/TOOL_DOMAINS/SEGMENTS/PROVIDERS 手抄分组 |
| ⑤ Rust BUILTIN_PLUGIN_NAMES | 方案 A：**构建期生成**（build-builtin-plugins.mjs 从名册吐 `builtin_plugin_names.rs`，Rust `include!`）——保留白名单语义但零手抄<br>方案 B：**整体消灭**（§3）——Rust 不再需要名单 |

### 2.3 名册位置与归属

- 名册落 `src-ui/src/plugins/builtin-roster.json`（plugins/ 装载链域，见
  factory-products-homing-plan 的 plugins/kernel 分家方向——名册属装载链，随 kernel
  归家时一并挪 `plugins/kernel/`）。
- 消费面：TS 侧经 `resolveJsonModule` import（配一个薄类型包装
  `builtin-roster.ts` 声明类型 + re-export）；Node 侧（build 脚本）`JSON.parse`
  直读——同源单文件，无双格式漂移。

## 3. Rust 白名单的两种终态

### 方案 A：构建期生成（保留白名单语义）

- `build-builtin-plugins.mjs` 从名册吐 `src-tauri/src/builtin_plugin_names.generated.rs`
  （`pub const BUILTIN_PLUGIN_NAMES: &[&str] = &[…];`），Rust `include!` 之。
- 零手抄，漂移不可能（生成器跑在 tauri build 前）。
- 代价：多一个生成物 + include! 间接层；CI 里纯 cargo test（不经前端 build）时
  生成物必须已存在（提交进仓库 or build.rs 兜底）。

### 方案 B：整体消灭白名单（更彻底）

- 语义再审视：白名单唯一作用 = 用户根缺失时「要不要试内置根」。删除它，改为
  serve_plugin_path 用户根缺失分支**无条件试内置根**（`builtin_plugins_root()`
  解析 + `resolve_asset`，文件不存在自然 404）。
- 安全论证：内置根只装第一方产物（打包资源/仓库 dist-plugins）；第三方插件请求
  `plugins/<名>/…` 即使撞名，用户根优先语义不破（先查用户根命中即返回），仅当
  用户根真没有时才回退内置根——此时内置根有同名文件则服务之，与白名单时代等价。
  「避免撞用户同名目录」的初衷由「用户根优先」保证，白名单并非必需。
- 守卫：现有 `builtin_plugin_fallback_end_to_end` / `user_plugin_dir_wins_over_builtin`
  测试改造成「无白名单语义」断言（行为零漂移对拍）。
- 代价：行为微调（非白名单第三方路径在用户根缺失时多一次内置根 stat——可忽略）；
  需重写上述测试的措辞（不是删除测试——是删除「白名单」这个中间概念，测试改钉
  「用户根优先 + 内置根回退」两个最终行为）。

> **推荐方案 B**：第五登记点不是「生成它」而是「让它不存在」。这正是消灭多真源
> 的最彻底形态——不是同步多张表，而是让其中一张表失去存在理由。

## 4. 施工批次（每步门禁全绿再下一步；铁律：新落位即删旧，不双轨并行）

> 2026-09-06 用户铁律追加：**不需要向后兼容**。重构 = 新东西写进来、旧东西当批删除，
> 不搞「重构了但兼容旧代码 → 又新加一路并行」的烂活。因此下列各步都是换轨收口：
> 名册与生成逻辑落位（守卫测试证生成面与旧表现状一致）→ **同一步拆掉被替代的旧表**
> （删分组手抄、删手抄表、删 Rust 白名单、删源目录 manifest），不留兼容路径、不留
> 死代码、不做双读。

| 步 | 内容 | 验证 |
|---|---|---|
| 0 | **立项定稿**：本计划 + 决策点拍板（方案 B 消灭 Rust 白名单；源码 manifest 退役名册生成） | ✅ 用户已批（2026-09-06） |
| 1 | **立名册 + 生成器**：建 `builtin-roster.json`（31 feature，buildOrder=现 factory 序、description 从 first-party-manifest 抄、face/renderers 特例标注）；建 `scripts/gen-builtin-manifests.mjs`（从名册派生产物 manifest.json 内容，替代各目录手抄）；守卫测试钉「名册 dir 集 === 磁盘目录集」「名册序 === 现 factory 展开序」（证明生成面 = 现状） | vitest + tsc |
| 2 | **④ build 脚本换轨即删分组**：pluginSpecs 从名册读；UI_FACES/TOOL_DOMAINS/SEGMENTS/PROVIDERS 分组常量**删除**（不保留）；重建产物与换轨前逐字节 diff 对拍（31 产物 entry.js/css/face.json） | build:builtin-plugins + diff + tsc |
| 3 | **③ factory-products 换轨即删手抄表**：plugin 对象静态 import 保留（vite 依赖）但数组改从名册 buildOrder 驱动 + 集/序校验；手抄的 13 直接 + spread 序从名册派生 | vitest + convergence + tsc |
| 4 | **⑤ Rust 白名单消灭**：删 BUILTIN_PLUGIN_NAMES + is_builtin_plugin_path，serve_plugin_path 用户根缺失时无条件试内置根；测试改造钉「用户根优先 + 内置根回退」两行为（删白名单专项测试，e2e 改造） | cargo test（plugin_assets 全组） |
| 5 | **① 源目录 manifest 退役 + ② 清单对拍**：31 个 `builtin/<dir>/manifest.json` 删除（产物 manifest 由步 1 生成器写到 dist-plugins）；loader 校验面改用名册派生；first-party-manifest feature 描述从名册读、feature 集从名册对拍；displace 死字段随 manifest 退役一并消失 | vitest + build + biome |
| 6 | **文档 + 落账**：plugins/README 写「加内置插件 = 改名册一处」；docs/plans README/HISTORY 更新；旧计划交叉引用 | doc-sync |

## 5. 决策点（等用户拍板）

> 随设计定稿已收敛两项（名册格式 = JSON 双读；buildOrder = 显式序号），仅剩两项待批：

1. **Rust 白名单终态**：方案 A（生成保留）vs **方案 B（消灭，推荐——第五登记点
   不是生成它而是让它不存在）**？
2. **源码目录 manifest.json 去留**：保留（名册派生它，双份对拍）vs **退役（推荐——
   源码目录只留名册，产物 manifest 由构建期从名册生成到 dist-plugins；源码目录的
   manifest.json 与 displace 死字段一并清剿）**？

## 6. 风险矩阵

| 风险 | 概率 | 影响 | 兜底 |
|---|---|---|---|
| 装载序字节契约漂移（③ 换轨） | 中 | 高 | 显式序号 + convergence 快照对拍零漂移 + loader 测试 |
| 构建产物行为漂移（④ 换轨） | 中 | 中 | 换轨前后产物逐字节 diff 对拍 |
| 名册与磁盘目录脱钩 | 低 | 中 | 批 1 守卫测试（名册集 === 磁盘集）双向钉死 |
| Rust 方案 B 行为回归（第三方撞名/回退语义） | 低 | 中 | plugin_assets e2e 三测试改造钉「用户根优先 + 内置根回退」两行为 |
| 生成物陈旧（方案 A：cargo 直接跑没生成物） | 中 | 低 | 生成物提交进仓库 + 守卫测试对拍 + build.rs 检测 |
| factory-products 静态 import 面（vite 依赖） | 低 | 高 | 名册只承载数据，plugin 对象引用仍静态 import（factory-products 壳），守卫测试钉序/集 |

## 7. 验收（完工即证）

1. **加一个内置插件只动一处**：按文档新增名册一条 → 目录/清单/装载序/构建/白名单
   自动一致（守卫测试证）。
2. **退役一个内置插件只动一处**：删名册一条 → 五面全同步。
3. **无手抄镜像**：git grep 确认 31 个 `hologram/` 产物名在 TS 侧只出现于名册一处
   （或名册派生面），Rust 侧无产物名字面量（方案 B）。
4. **门禁全绿**：cargo test / tsc / vitest / build / biome / verify:convergence。
5. **行为零漂移**：31 产物构建产物逐字节一致；装载序一致；dev/产物双模式 boot 一致。
