# 组合边界：为什么兰台不做（也做不到）DSH 式全体插件化

> 日期：2026-08-20 · 状态：Accepted
> 关联：`docs/plans/composition-architecture/README.md`（本 ADR 划边界，该计划在边界内施工）
> 取代叙事：`.lantai/plans/plan-1787199847398-bu20.md`（plugin-ecosystem v1）中「宿主壳永不插件化」的宪法表述——本 ADR 给出更精确的边界定义
> 性质：对 2026-08-19/20 两日 DSH 源码实证对标讨论的定案总结

## 1. 参照系澄清：DSH 的真实形态

对标前必须先纠正参照系。「DSH = 一切皆插件的 TS 单体」是误读。实证（D:\useful\deepseek-harness）：

- **DSH 是双平面系统**：host 平面（Node 进程）+ browser 平面。browser 插件被关在冻结 module table 后面（`packages/client/web/src/seed.ts`：仅 react / cordis / ui-primitives 等 10 个包可 resolve），摸不到 fs、不能 import 任意 npm 依赖——**这与兰台 webview 插件将过的日子是同一种约束**。
- **「一切皆插件」的本体是组合均匀性**：第一方与第三方走同一条组合管道（`packages/bundle/base/cordis.patch.yml` 451 行 roster——工具/工具注册表/system-prompt/LLM adapter/sandbox/审批/telemetry 全是行；`web-app/cordis.patch.yml` 把整个 agent plane 禁用改为 per-session preset）。它不是「机器可编程」。
- **DSH 的机器答案恰恰是外部进程模式**：本部署（`C:\Users\Administrator\.dsh\profiles\web\package.json`）中 DSH 的代码智能来自 `hologram-dsh` bundle——兰台的 Rust 引擎作为 stdio MCP 行被组合进去（`dsh-bundle/cordis.patch.yml`：`hologram-mcp` 行 + `failOnStartupError: false`）。**DSH 借的是兰台的机器；兰台在羡慕的，是自己已经供出去的东西。**

结论：把「接近 DSH」当失败是参照系错位。DSH 自身对机器层的答案就是 HoloGram 引擎这个形态。

## 2. 五层闸门图纸（实证查验，2026-08-20）

| 层 | 闸门 | 实证 | 可拆性 |
|---|---|---|---|
| 0 物理定律 | webview 非 Node：无 fs/child_process/native | DSH browser 平面同样受限（seed.ts） | 永久，只能绕 |
| 1 进程/语言边界 | 机器面 = `rpc.rs` 133 方法 + 引擎 37 MCP 工具，编译期冻结；新增机器能力 = 宿主发版 | `rpc-contract.ts` 头注、`mcp_manager.rs` | 架构选择的既付代价；但 agent 工具 execute 跑在 webview（`agent/tool.ts`）——**新工具 ≠ 新机器能力**，此墙比直觉矮 |
| 2 代码加载 | 生产 webview 全部 import 是编译期 vite chunk；asset protocol 未开（`capabilities/default.json`）、无自定义协议（`main.rs` 仅 `invoke_handler`） | dynamic import 扫描：14 处全是静态可分析 | 工程缺口——`llm_proxy.rs`（127.0.0.1:14570，已带 CORS）加静态路由即解锁；S0 立项 |
| 3 组合层缺失 | 无行模型：工具面由 `buildToolRegistry` + `blueprint.standard()` 编译期决定；无 id 寻址/config 覆盖/preset realm | 但 per-session 组合数据流已就位（`workspace.ts` registry 按工作区构建、`runtime.createAgent` 每会话消费） | **主战场，全额可建**（组合层计划 S1-S4） |
| 4 制度约束 | convergence 8 baseline 钉死全局装配序；冻结文件清单；biome 两受权出口；vendored cordis 禁就地改 | agent-core-convergence 全 7 phase 资产 | 最贵的墙：需要 re-derive（per-preset 分组）而非删除 |
| 5 信任模型 | 完全信任、无沙箱、本地 + npm tarball 分发 | 用户 2026-08-19 拍板 | 不构成限制 |

## 3. 三档判决

| 能力 | 判决 | 路径 |
|---|---|---|
| **组合均匀性**（第一方第三方同管道、行寻址、preset、「一切皆插件」的本体） | **全额可达** | 纯 TS 平面工程；kernel/blueprint/per-session 数据流均已就位 |
| **机器即行**（插件挂接任意外部机器进程） | **可达，模板已写过一次** | 外部进程模式（`dsh-bundle/cordis.patch.yml` 即参考实现）+ 通用桥（S4 可选） |
| **进程内宿主插件**（wrap fs / 换 sandbox 策略 / hook agent loop 于宿主进程内） | **永久关闭** | webview 物理边界；DSH host 插件的等价物在本架构中不存在。这是唯一的真死刑，且它不是「一切皆插件」的本体 |

## 4. 决策：为什么「不做」是理性选择而非妥协

组合均匀性既然可达，为什么不做到底？三条理由，每条都独立成立：

1. **Agent↔engine 耦合是产品核心，不是债。** 图优先工作流（graph preflight/impact、plan-graph-hook、执行腰）的存在理由就是兰台是代码图谱产品；DSH 没有这层耦合因为它不做这个产品。拆耦合带去换插件自由度，等于把产品的差异化内核交给组合层——本末倒置。这条边界同时回答「为什么兰台的插件架构注定与 DSH 不同形」：**专属架构的『专属』就落在这里。**（2026-08-20 四问访谈补记：产品终局定式为**两产品共居**——图谱机器（G：engine + 认知层，宿主无关，已同时服务兰台 Agent / DSH / 外部 MCP 客户端三方）与 Agent 产品（A：组合层 + 壳，身份所在）。内核线即 G/A 分界线，耦合带即 A 消费 G 的桥。用户同时据此否决「全部押注 DSH」：DSH 是 agent 软件，兰台也是——寄居即失去身份。详见组合计划 D0 节。）
2. **组合税是永久税。** 落地之后每个新功能必须写成行，否则特权代码重新堆积、架构烂回「带插件的单体」。DSH 在付这个税（其 patch 文件全是法条级注释文档）。接受它才配拥有组合均匀性；不接受，墙开了也会重新砌上。
3. **工程优先级的现实。** 一轮完整前端重构在前（无论落在兰台还是 DSH 宿主），convergence 体系是花了 7 个 phase 建立的保护资产——它的重设计（per-preset 分组）要付在刀刃上，与前端重构排程咬合（组合层计划 S3 协作纪律），而不是两场大迁移叠 diff。（2026-08-20 排程补记，同日二次修订：组合层与 paper-shell 为两个独立工程——前者机械工程（绿灯模式），后者创作工程（月级人机共同创作，沟通-修改-测试循环为本体），无主从阶段关系。唯一硬依赖：纸壳装配 V3b 需组合层 S1。组合层 S3/S4 保留为收尾段，触发条件 = 纸方向定稿（先于纸迁旧面板 = 给可能被废除的面做返工）。见组合计划 D0 排程节。）

## 5. 永久边界 vs 延期项

**永久（写进宪法，不再复议）**：进程内宿主插件 · Agent↔engine 耦合带拆解 · 星图 scene 插件化 · typert 式跨进程类型协议 · Rust 面新增插件暴露（插件复用既有 133 方法面）。

**延期（可后补的加法，按需启动）**：Node sidecar 宿主臂（补上它才触达第 3 档关闭的能力；dsh-bundle 已证外部进程模式覆盖机器扩展大头，故不预支）· marketplace · HMR · 插件 SDK d.ts 分发 · wasm 面。

## 6. 后果

**正面**：宪法从矛盾（「宿主永不插件化」×「走向插件生态」）变为自洽（内核线定义 + 线外皆行）；「怎么做都不对」的认知失调消解——根源是拿正确的直觉（特权线必须移动）去审一份口子计划；插件宇宙九成自由度不经过机器层，先建组合层是唯一正确顺序。

**负面（诚实记录）**：插件对机器新能力永远是租客，新机器能力 = 宿主发版；兰台的插件架构与 DSH「同构但不同形」——组合层可对标，宿主政策层永久异形；接受这个差距是本 ADR 的代价。

## 7. 与计划的关系

本 ADR 定义边界与不做清单；`docs/plans/composition-architecture/README.md` 在边界内施工（S0-S4）；`agent-plugin-architecture-plan.md` 的 D8（生态观望、形状兼容、零依赖）继续有效，其 P4 路线 B 由组合层计划承载。
