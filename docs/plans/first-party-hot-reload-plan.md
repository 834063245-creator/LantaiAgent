# 第一方代码「改完即生效」——开发热更工作流 + 渲染器插件通道化

> 状态：✅ **全计划竣工（2026-08-31：P0+P1+增补一二三四全部落地）**——面向兰台（HoloGram）
> 一句话：把「改代码 → 重新打包（分钟级、每次都要）」变成「改代码 → 秒级看到效果」：
> P0 立开发热更工作流（零成本），P1 让渲染器等 UI 扩展点走插件通道（生产包也可热替换），
> 增补一/二把通道化扩到 kind='feature' 全量（23 个内置插件产物），增补三补工具面入批，
> 增补四（同日施工）落位移式装载机制并全批竣工。落地明细：dev.cmd + docs/dev-workflow.md（P0）；
> 渲染器插件通道化 P1a-f（下方各节）；UI 四面 + 18 工具/段插件通道化（增补四施工节）。
>
> **增补（2026-08-31，用户拍板）**：用户确认 **dev 模式不可用**（环境所限，原因不论）——
> P0 对本用户价值归零（竣工件保留不拆），生产包热重载升格为**唯一热更路径 = 必要工程**。影响与排定：
> 1. P1 基础设施（esbuild 管线 / plugin_assets 兜底解析 / 设置面板重载 / 宿主桥 React 面）转公共设施；
> 2. **范围拍板（同日追问拍板）：不逐个迁，UI 面四面整批一次到位**——canvas-nav（书脊+侧边栏）、
>    paper-shell（纸壳主界面）、settings-domain（设置面板）、compose-dock（组合停靠面板）。
>    盘点依据：45 个第一方插件中 21 个 service（平台地基，无视觉迭代，非目标原文明确不外置）与
>    16 个 Agent 工具域（纯逻辑注册 + 独立工具契约门禁，热替换要多背契约同步）均不迁；
>    **space-demo（Stage-2 验收脚手架，无产品功能）顺带退役**——其「外部插件消费 ctx.space 写法范本」
>    价值由迁移后的 canvas-nav 实体接替。
> 3. 整批理由（解「逐个迁反复返工」）：桥面（React + ctx 消费面）、**面板携 CSS 注入方案**、
>    BUILTIN_PLUGINS 表变化引发的收敛快照 change request——**各做一次，四面机械复用**；
>    逐个迁则桥面返工风险×4、收敛快照走四次。
> 4. 封口规矩：此后**新 UI 面一律以 builtin 插件形态出生**（renderers 为样板），存量清零后不再有迁徙。
> 5. 迁徙增量 = ①源码迁 builtin 目录 + manifest.json（P1b 同款）②构建管线扩四面产物（P1c 同款，
>    含 CSS 产物或注入）③宿主桥补 ctx.space / dock-store 等消费面④first-party-manifest 守护 +
>    收敛快照同步。通道化后该面迭代环 = 改源码 → esbuild 秒级出产物 → 设置面板重载 → 生效（不重启）。
> 6. 开工时机：P1 落 commit 后接续（loader.ts / first-party-manifest.ts / PluginsPage.tsx 为其同批
>    文件，避免在途冲突）；估算与渲染器批同量级（2-3 天）。
>
> **增补二（2026-08-31，用户拍板「把工具面也迁了」）**：范围从四面扩为 **feature 全量通道化**——
> 1. **边界线画在 kind 字段上**：first-party-manifest 的 kind='feature' 全迁（22 个 = 4 UI 面
>    + 16 工具域 + prompt-segments + capability-segments），kind='service'（21 个平台地基）不迁
>    ——规则零判断成本，杜绝「这个迁不迁」的逐案争论；renderers 已竣工、space-demo 退役如前。
> 2. 施工两波（同一批内，设计一次）：**先 UI 四面**（桥面/CSS 方案在此波验证定形），**后工具域
>    + 段贡献 18 个机械铺开**（无 CSS、无面板桥面增量；zod/agent 依赖随 esbuild 自包含进各自
>    产物，插件名保持不变——S4-4 甲 patch/preset 寻址 'plugin/hologram/<域>-domain/<工具名>' 零漂移）。
> 3. **工具面热重载生效语义**：重载影响下一次装配——已开会话的工具注册表是装配期快照，不被中断
>    （Agent 手中的工具不热换，新会话即用新版）；这是特性非缺陷，语义与装配期真值族 noCache 设计同构。
> 4. 门禁：gen:tool-contract 按源码生成不受装载路径影响（不变）；verify:convergence 快照重录
>    **一次** change request（22 插件表变化一并入）；工具域测试直引源码组件与产物双走查（P1f 同款）。
> 5. 估算：UI 波 + 工具波合计 3-5 天；全量门禁（tsc/biome/vitest/convergence/cargo）收尾一次。

---

## 1. 背景与现状（已查证，非猜测）

**用户痛点**：Agent 改前端代码（如媒体渲染器），用户必须重新 `cargo tauri build` 才能看到效果，每次几分钟。

**项目实际的热更能力有三个层次**：

| 层次 | 机制 | 代码位置 | 生效方式 |
|---|---|---|---|
| 外部插件 | 动态 import ESM + fiber 热插拔（D6） | `plugins/loader.ts`（activate/deactivateExternalPlugin）、`plugin_assets.rs`（127.0.0.1:14570 通道，MIME/CORS/遍历防护齐全） | 装/卸/启用/禁用 **运行时即时生效**，零重启 |
| 组合配置 | composition_watcher 轮询 | `src-tauri/src/composition_watcher.rs` → `composition:changed` → patch-loader | 改 `roster.patch.yml` 1-2 秒生效（只热配置） |
| 第一方源码 | 编译期 bundle | `BUILTIN_PLUGINS`（loader.ts）+ React 组件 | ❌ **必须重新构建** |

**关键发现**：渲染器（`composition/asset-renderers.tsx`）本来就是设计上的插件面——`renderer-service.tsx` 头注明言「插件换的是这个 kind 长什么样」，`ctx.renderers` 注册表支持后注册胜。但它目前是编译期内置的，改了要重打包。**通道是通的，缺的是把第一方 UI 扩展点接上通道**。

## 2. 目标与非目标

**目标**：
1. 改第一方前端代码后，秒级看到效果（不再每次重打包）；
2. 生产包也能对特定扩展点做运行时热替换（不重启应用）。

**非目标**：
- 不改第三方插件安全/信任模型；
- 不把全部第一方代码外置（服务层/装配层仍编译进包——它们不需要热更）；
- 不做在线插件商店/自动升级。

## 3. 方案一（P0）：开发迭代工作流立即可用

现实：Vite dev server（`vite.config.ts` devUrl 1420）本就支持 HMR——**dev 模式改代码保存即生效，零代码改动**。用户一直跑生产包所以感受不到。

**交付**：
1. 根目录 `dev.cmd`（对齐既有 `build.cmd` 的 Windows 包装）：
   - 起 `cargo tauri dev`（自动先跑 `beforeDevCommand: npm run dev`，Vite HMR + 开发窗口一条命令）；
2. `docs/dev-workflow.md`：dev 模式怎么用、与生产包差异、错误怎么看；
3. 承诺：Agent 改完前端代码，用户 dev 模式保存即见；生产发布前仍过一次 `cargo tauri build` 全量验证。

**验收**：跑 `dev.cmd` → 改 `asset-renderers.tsx` 保存 → 窗口内行为即时更新，无需重编译。

**成本**：半天内，纯新增脚本/文档，零架构风险。

## 4. 方案二（P1）：渲染器插件通道化——生产包也可热替换

**思路**：把「媒体等资产渲染器」从编译期 bundle 迁为「第一方内置插件」：源码留仓库，构建管线产出 ESM 产物 + manifest.json，随包携带；运行时经插件通道装载（与第三方插件同一条 D6 热插拔链路），设置面板给「重新加载」按钮 → 重激活 fiber 替换渲染器行。

**落地步骤（每步独立可验）**：

- **P1a 宿主桥扩展**（`plugins/loader.ts`）：`window.__lantai_plugin_host__` 增加 React（`React` 全量 + hooks 子集）——渲染器插件用 JSX 写的源码经 esbuild 编译（`--jsx=transform` + external react），entry.js 从宿主桥取 React，保持「插件自包含、无裸 import」契约不破。
- **P1b 渲染器源码迁目录**：`src-ui/plugins/builtin/renderers/`（manifest.json + 源码；先迁 `media` 试点，验证后再迁其余 grid/chart/metric/graph/html/form）。
- **P1c 构建管线**：新增脚本（esbuild 增量编译该目录 → `dist/plugins/builtin/renderers/entry.js`，秒级）；`tauri.conf.json` resources 增加产物目录随包携带。
- **P1d Rust 兜底解析**（`plugin_assets.rs`）：插件资产解析先查用户插件目录（`~/.lantai/plugins/`），查不到回退内置资源目录（第一方插件同款路径、同款安全校验）。
- **P1e 重载入口**：设置面板插件 tab 对内置插件提供「重新加载」→ `deactivateExternalPlugin` + `activateExternalPlugin`（复用 D6，重 fetch entry.js 后重激活）。
- **P1f 门禁同步**：`first-party-manifest.ts` 条目（守护测试钉死）、`verify:convergence`（BUILTIN_PLUGINS 表变化对拍）、asset-primitives 渲染器测试保持全绿（测试直引源码组件，与插件产物双走查）。

**权衡**：
- 渲染器插件加载失败/崩 → 走既有 `'*'` JSON 兜底，不炸应用；
- 改渲染器代码后，构建插件产物（秒级）+ 点重载 = 生效，比整包构建（分钟级）快一个量级；
- 面板/命令等其它扩展点后续可复刻同一模式（本次不做）。

**验收**：生产包中：改媒体渲染器源码 → 构建产物 → 设置面板「重新加载」→ 新行为生效，应用不重启。

**成本**：约 2-3 个工作日（含管线与测试），是架构动作，建议 P0 之后择机进行。

## 5. 方案三（远期，本次不做）

全部第一方能力外置、插件版本管理、在线分发——不在本次范围，留作后续讨论。

## 6. 风险与回退

| 风险 | 对策 |
|---|---|
| P1 渲染器插件加载失败 | '*' JSOn 兜底 + 出厂内置行保留；失败隔离（loader 永不 reject）已有 |
| dev 模式与生产行为差异 | dev-workflow 文档写明差异；发布门禁仍以生产构建为准 |
| BUILTIN_PLUGINS 表变化引发收敛快照漂移 | P1f 明确列为步骤，按 change request 流程走 |
| esbuild 引入新依赖 | 仅 devDependency，不污染运行时依赖面 |

## 7. 总验收

1. P0：`dev.cmd` 一条命令进开发模式，改渲染器保存即生效；
2. P1（若批）：生产包中媒体渲染器可在设置面板一键重载，重载后新行为生效；
3. 全程：`vitest` / `tsc` / `biome ci` / `verify:convergence` / `cargo test` 全绿。

---

## 8. 增补四施工记录（2026-08-31，当日落地）

> 增补一/二/三的施工批：UI 四面 + 16 工具域 + 2 段贡献全量通道化 + space-demo 退役。
> 与原设计的关键偏差与理由如实记录如下（其余按 P1a-f 样板机械复用）。

### 8.1 位移式装载（对「双行走查」的结构性推广）

渲染器的覆盖语义靠**行 id 分立**（`builtin/<kind>` bundle 兜底行 + `plugin/hologram/renderers/<kind>`
产物覆盖行，resolveRenderer 后注册胜）。但四面/工具域/段贡献的贡献 id 与 bundle 行**共享**
（面板 id `'paper'`/`'settings'`、工具行 `'plugin/hologram/<域>/<工具>'`、段 id）——
ContributionRegistry 重名装载期拒绝，产物行无法与 bundle 行并存。

解法 = **位移（displace）语义**，落在 loader 层（`plugins/loader.ts`）：

- `loadBuiltinPlugins` 给每个 bundle 插件记 fiber 锚点（`builtinFibers`）；
- 产物 manifest 声明 `"displace": true` 且 bundle fiber 在册 → import 前 dispose bundle fiber
  （贡献面**单活互换**，注册表永不见重名）；失败路径重启 bundle 插件（兜底行自动回位）；
- `deactivateExternalPlugin` 对被位移插件重启 bundle 行 + 记录翻回 bundle 形态；
- 产物记录统一补 `builtin: true + meta`（设置面板「内置插件」分组不错位）；
- `usePluginPrefs` 的 feature 禁用态对产物通道同样生效（两域一致，下次启动语义不变）；
- **装载序纪律**：内置产物按 BUILTIN_PLUGINS 表序装载（磁盘索引是字母序，直接用会打乱
  贡献注册序——组合解析快照/工具契约/前缀缓存依赖表序），用户插件按索引序殿后。

渲染器不改（无 displace 声明，双行走查语义原样保留）。

### 8.2 Wave-2 薄重导出（对「zod/agent 依赖自包含内联」的偏差）

原增补二设想工具域产物把 zod/agent 依赖 esbuild 内联（自包含）。施工时查明**不可行**：
工具工厂的依赖树携带模块级单例（`composition/graph-service` 的 active 访问器、
`asset-kinds` 注册表、`ui/command-registry` 单例、provider/catalog 动态拉取态）——产物内联
副本会分裂状态（产物工具访问影子单例，静默错乱）。改为**薄重导出产物**：
`builtin/<域>/index.ts` 经宿主桥 mods 取 bundle 域**同一插件对象**（几行 + manifest.json），
displace 位移 = 同一插件的干净重注册。段贡献（prompt-segments/capability-segments）同形——
段定义是 convergence 字节契约面，本就不该随产物内联。自包含契约（产物零静态 import）
仍由构建管线断言；热更语义 = 同一插件重装载，工具面下次装配生效（与拍板 #3 一致）。

### 8.3 UI 四面迁移明细

- 迁移文件：SpineRack/SessionSidebar(+model+css) → `builtin/canvas-nav/`；
  PaperPanel/InkLayer/StatusLine(+css) → `builtin/paper-shell/`；SettingsPanel →
  `builtin/settings-domain/`；ComposerDock/TocStrip/ModelSelector → `builtin/compose-dock/`；
  各面带 `index.ts`（插件对象 + injectFaceArtifactCss）+ `host.ts`（开发/测试域，直连真实模块）
  + `host.aliased.ts`（产物域，宿主桥 mods 取共享真实例，`typeof import('./host')` 对拍防漂移）。
- **宿主桥扩面**（`loader.ts` + `builtin/host-modules.ts`）：hooks 扩全集、`loadCss`（产物
  CSS 幂等注入，define 门控 bundle 域 no-op）、`mods`（faceDeps 依赖真实例 + toolDomains +
  segments 插件对象）；构建期 `react` 别名桥（`react-bridge.cjs`）保证产物零 React 副本
  （@react-aria 等内联依赖也落到宿主 React）。
- **构建管线**：`scripts/build-builtin-plugins.mjs`（原 build-renderer-plugins.mjs 泛化）——
  23 个产物统一 scope 布局 `dist-plugins/builtin/hologram/<dir>/`（**顺带修 P1 缺陷**：
  渲染器首版输出 `builtin/renderers` 单段目录，过不了 loader 的 `manifest.name !== dirId`
  校验，产物实际装不进通道）；产物自包含断言（零静态 import / 零动态裸 import）；
  面组件 CSS 经 esbuild 抽取为 entry.css 随产物携带。
- **boot 序**：main.ts 改为产物装载完成后再跑 bootShell（位移在纸面板直落前完成，
  首帧即终态，无面板闪卸重挂）。
- **space-demo 退役**：删除插件与测试段（paper-space.test.ts 的 demo 用例）。

### 8.4 门禁结果

- first-party-manifest 44 条（45 − space-demo）守护测试同步；
- convergence **零漂移**（原预算的快照重录 change request 免除——convergence 只钉通道腰
  withFirstParty*Channel，bundle 兜底行让装配面与迁移前逐字节一致，实测确认）；
- gen:tool-contract 不受装载路径影响（按源码生成，未动）；
- 全量门禁（biome 0/0 / tsc / vitest 全量 / convergence 双 preset / cargo）见施工 commit。