# 组合架构（composition-architecture）— 施工史

> 已竣工各阶段（S0-S2、S4）的完整落地记录、批次 commit 序列、设计件执行史。**现状看 [`README.md`](README.md)**。
> 原 README 的 D0 访谈记录、各阶段「落地记录」段、设计件索引原文归档于此。

## D0 — 宿主选择（2026-08-20 四问访谈）

**访谈结论（用户四答要点）：**
1. 产品终局：HoloGram = **两个产品共居一个软件实例**（代码图谱 + Agent 工作台），因集成需求合体，产品定义上确为两物。
2. 白纸 §5.2 表仅初版；Agent 层动不动取决于整套设计定稿之后。
3. DSH 平台赌注：**不接受全部押注**——「DSH 是 agent 软件，我也是 agent 软件，我依赖 DSH 活，我的 agent 就没了身份定义」。
4. 耦合带处置：「为什么重写为 DSH 插件，而不是重写为我自己的插件？」

**决策合成：世界 B（DSH 宿主）出局。** 它的真实成本从来不是工程量，是产品身份。剩世界 A：**自己的插件体系——仿 DSH 的模式，不仿 DSH 的形态**（ADR 已定案「同构但不同形」）。DSH 插件在本架构中的唯一角色是既有的 `hologram-dsh`：**机器暴露给 DSH 的方向**（机器供应商，不是租客），已建成运行。

**两产品形式化（内核线即产品分界线）：**
- **产品 G（图谱机器）**：engine + 认知层。居内核线之下，宿主无关——已同时服务三个消费者：自家 Agent（TCP 9777）、DSH（dsh-bundle stdio MCP）、外部 MCP 客户端。
- **产品 A（Agent 产品）**：组合层 + 壳 + 会话/工具/面板。居内核线之上，一切皆行——兰台的身份所在。
- 耦合带（宪法第 6 条）= A 消费 G 的桥，永久特权。

**排程史（诚实记录）**：上午稿 = 并行（被否，优化错了资源）；下午稿 = 三阶段串行把白纸当阶段 2（被否，把创作工程塞进机械工程模板）；二次稿 = 两独立工程 + S4 纯排后；终稿 = 用户主动序：**S0-S2 → S4 → 纸 → S3**。

白纸与组合层在架构上收敛而非竞争：其块协议本身就是一个插件面——块渲染器 = ctx service 行，白纸壳 = 组合层的又一个消费者（V3b 已落地第五贡献通道 `ctx.renderers`）。

## S0 — 装载通道 + 插件内核 — ✅ Done（2026-08-20）

**落地记录：** S0A spike 取三分支之 ✅（假设证实：webview 从 14570 import ES module 可行）。S0B 落地 `plugin_assets.rs`（静态路由：遍历防护/仅 GET/仅 loopback/MIME 含 .wasm/JSON 错误/junction 测试）+ `plugins/types.ts`（zod manifest）+ `plugins/loader.ts`（失败隔离永不 reject/disabled 跳过/inject 装载期校验/端口经 llm_proxy_port RPC 解析）+ `state/plugin-store.ts` + main.ts 接线 7 行。手动验收全过（坏插件 error 状态不炸应用、hello 装载成功、disabled 实测、生产 origin `tauri.localhost` import 随 `cargo tauri build` 验证）。加载协议纪律（import 白名单）顺延至 S1 落地。

## S1 — 注册表化 — ✅ Done（2026-08-20，9 commits）

**落地记录：** 按设计件批次序列 S1-0…S1-5 全部完成（`cd9092fa`…`55c5177a`），每批独立全绿。核心交付：preset 维度基建（gate/快照路由/contributions 显式参数）→ 四 service（ContributionRegistry 内核：装载期重名拒绝 + disposer 双守卫）→ 工具行表 `composition/tool-rows.ts`（14 行全部内置族，表序=组合序）→ 装配末端整体改读行表（`createCodingTools` 兜底退役）→ system-prompt section 注册表（13 段，两装配面 applicable 分流）→ `DockPanelId` union 退役（string 开集 + panel-def 装载期校验）。§2.4 零漂移规则全程生效：每批不设 CONVERGENCE_PRESET 跑 verify:convergence，baseline 零触碰（S1-4 曾拦下一处 \n 分隔符漂移——安全网实战有效）。

## S2 — 组合外化 — ✅ Done（2026-08-20）

**落地记录：** 设计件经用户授权代理复审后 6 批全落地（`28f6612d` 设计件 → S2-0 `6d4667c4` → S2-1 `02a7f751` → S2-2 `39850ea9` → S2-3 `51267323` → S2-4 `0ff58774` → S2-5 文档收尾），每批独立全绿。核心交付：`composition/roster.ts` 解析引擎（四域行模型 + last-write-wins + all-or-nothing + 诊断）→ 装配面穿线（toolRows/sections/fromRoster 全带出厂缺省参数）→ 用户层通道（Rust `/composition/` 路由 + patch-loader + composition-store）→ 12 壳行拆解 main.ts（919 → 37 行）→ 用户文档 `docs/composition/README.md`。

## S4 — preset realm + 分发 — ✅ Done（2026-08-20）

**落地记录：** 设计件经三轮复审后 7 批落地（`c7e089ff` S4-0 → `01c035f8` S4-1a → `8f8b131e` S4-1.5 → `b366422d` S4-2 → `7913d266` S4-3 → `50a1f532` S4-5 → `d4dcb5bf`+`2c4f4bf3` S4-1b），每批独立全绿。核心交付：preset 数据模型（内置表 + `/composition/presets/` 索引路由 + 发现层 + preset-store）→ 装配穿线（createAgentFromContext/createAgent 可选 composition 覆盖参数 + 子 Agent 继承 + 会话工厂会话作用域注册表机制位 + boot 组合链）→ 消费闭环接线（G0 修复：panelDefs()/命令面板/插件工具行折算——四 service 贡献首次流进渲染面与装配面）→ 热重载（composition_watcher → composition:changed → reloadCompositionPatch）→ npm 安装通道（plugin_install 三形态源 + tar-slip 双重围栏 + 原子落盘）→ hello 闭环（`examples/plugins/hello/` 三通道 + 宿主桥 + e2e 钉面）→ 文档全套 → S4-1b（Phase 5 CR 用户批准后实施）：会话 `preset/selected` 首事件 + `baseline/preset-minimal/` 首次冻结（8 快照；per-preset 收敛协议全流程实测）。
S4-4 机器桥（manifest mcpServers）按设计件裁定整体跳过（未决项——hello 三通道不依赖它）。

## S3 — 第一方行化（settings 域样板）— ✅ Done（2026-08-22）

**落地记录：** 触发条件（纸壳交互欠账 C8-C12 落定）满足后立项，设计件裁决六点（tab 型零扩展 / 三层 id 桥接 / runAction 别名翻译层 / 组件 import 面零变化 / 插件落位 src/plugins/ / loader 维持表驱动；config 通道按 S2 纪律继续延期），B1+B2 两批代码落地（每批独立全绿）+ B3 文档收尾。核心交付：`app/actions.ts` 别名翻译层（`ACTION_CONTRIBUTION_ALIASES`：快捷键字面量 → 域贡献 id，静态注册优先、缺席静默、非 local 型显式 warn——快捷键链路 useGlobalKeys 字面量字节级不变）→ `plugins/settings-plugin.ts`（面板 + 命令双贡献，面板字段逐字等值迁移）→ paper 域补齐 V3b 漏的半步（`paper/toggle` 命令贡献）→ `PANEL_DEFS` 常量面清空（全仓唯一 SettingsPanel import 随之归零——S3 比立项时预想更小：组件 import 面仅 1 处，非 briefing 转述的 29 处）→ 壳行 actions 收缩至 open / esc-layer。门禁：全量 vitest 152 文件 1515 passed / 1 skipped（+12 用例 `tests/s3-settings-domain.test.ts`）；convergence 零漂移；biome 改动文件零新增。无头冒烟（vite dev + 浏览器）：ctrl+, 开合往返 ✓ / Ctrl+K 搜「设置」贡献折算行唯一出现且可执行 ✓ / ctrl+P paper 往返 ✓ / 六 tab 渲染完整（截图取证）✓。已知限制如实入档：palette 命令贡献无图标（折算面既定约定，不扩）；「与内置同 id → 内置胜」路径随常量面清空不可达（合流语义保留潜伏，测试改为钉同 id 撞贡献装载期拒绝）。

## 宪法差异（v1 → v2 为什么必须换版）

| 维度 | v1（plugin-ecosystem） | v2（本计划） |
|---|---|---|
| 第一层宪法 | 「宿主壳永不插件化」 | 内核线——壳**容器**仍特权，功能域皆行 |
| 内置 66 工具 | append-only、永不动序 | 默认 roster 的行：可 disabled、可配置 |
| 字节契约 | 全局冻结 | **per-preset 确定性组合**（前缀缓存照吃） |
| 终点 | 「带插件的单体」 | 组合均匀性：第一方 = 出厂默认 roster |

v1 的问题不是零件错了，是宪法与目标矛盾：在冻结宿主的计划上追加阶段，到不了以溶解特权为定义的终点。

## 风险表（施工期风险，历史存档）

R1 convergence 重设计（S1 动 baseline 地基——已安全度过的最大风险段）· R2 字节契约迁移期回归 · R3 双工程 diff 叠加 · R4 组合税 · R5 14570 通道安全 · R6 union→string 类型收紧。

## 明确不做（永久边界，理由见 ADR §5）

进程内宿主插件（webview 物理边界）· Agent↔engine 耦合带拆解（产品核心）· 星图 scene 插件化 · typert 跨进程类型协议 · Node sidecar 宿主臂 · marketplace / HMR / 真沙箱。

## 设计件索引（全部已竣工）

- `work-orders/WO-S0A-spike.md` — 装载通道验证 spike ✅
- `work-orders/WO-S0B-plugin-kernel.md` — 插件内核 ✅
- `designs/S1-convergence-per-preset.md` — preset 维度加法设计 ✅（2026-08-20 用户授权代理执行）
- `designs/S2-composition-externalization.md` — S2 全量设计 ✅（用户授权代理复审执行）
- `designs/S4-preset-realm-distribution.md` — S4 全量设计 ✅（七批落地；S4-1b 经 Phase 5 CR 用户批准）
- `designs/S3-settings-domain-externalization.md` — S3 settings 域行化设计 ✅（2026-08-22）
