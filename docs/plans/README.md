# docs/plans — 计划与实验入口

> 状态词：Proposed（待评审）· Draft（未执行）· In progress · Landed（代码已落地，剩真机验证）。
> 已完成的施工规格/被取代的 plan 移入 `docs/archive/`。

## 总控表 — 现在在哪，下一步是什么（唯一入口，先看这个）

**当前主线**：HoloGram 正在从「图谱软件 + Agent 工作台」翻转为「纯粹的 Agent 软件」。三个正交工程并行承载：**workspace-flip**（概念翻转，结构）→ **paper-shell**（纸壳前端，视觉/交互）→ **composition S3**（组合层收尾，已解锁）。

```
workspace-flip ✅（批 1-5 竣工 2026-08-22）──→ S3 解锁 + 纸壳 preset 交付
        │
        └─→ paper-shell V2 视觉契约 ──→ V4 打磨环（用户主场）─┐
                                                            │
                          纸壳「能住人」←──────────────────┘
                                    │
                                    ↓
                      paper-shell R3 访谈 → V5 判断半（观测台退役）
                      composition S3 逐域行化（纸需要哪个域就迁哪个）
```

### 里程碑时间轴（倒序 = 最新在上）

| 日期 | 里程碑 | 工程 |
|---|---|---|
| 2026-08-22 | **产品更名执行：兰台 / Lantai 全量落地**（同日拍板→当日施工，零外部用户 = 标识符窗口开放，推翻早前「冻结」预案）。**应用身份**：productName/窗口标题「全息观测站」→「兰台」；identifier `com.hologram.hg` → `com.lantai.app`（凭证目录 com.hologram.app 一并统一，本机 API Key 需重录一次）；updater endpoint 指 `834063245-creator/Lantai`（**repo 改名由用户在 GitHub 执行，改名前不打发布包**）；卸载清理脚本（wix EncodedCommand）同步重编码。**HoloGram 降级为图谱引擎专名保留**（用户定调「图谱是能力不是本体，可单独命名」）：工具域 `hologram(...)`、MCP 工具 `hologram_*`、`.hologram/` 数据目录、`HOLOGRAM_*` env、`hologram.db`、`hologram.constraints.yaml`、engine crate `hologram-engine`、dsh-bundle `@a834063245/hologram-dsh` 均不改。**应用层内部标识全换**：插件桥 `__lantai_plugin_host__`、scoped-store 键 `__lantai_*_stores__`、merge gate `__LANTAI_MERGE_GATE__`、类型 `LantaiPlugin`、src-tauri crate `lantai`、npm `lantai-ui`。system prompt persona「你是兰台的编码 Agent / 由兰台调度」+ browser 工具描述「兰台 webview」→ **convergence baseline 需重录**（standard + minimal 两套 record，change request 在案）。文档：README 头部/定位/badges、AGENTS/CLAUDE 命名架构注记、CONVENTIONS/ARCHITECTURE 标识符引用同步 | 总控 |
| 2026-08-22 | ~~产品命名拍板：兰台 / Lantai~~（当日稍晚升级为上条「全量落地」，冻结预案作废） | 总控 |
| 2026-08-22 | **V1-R3 全弃 → 止损 → 参照物板收敛：印刷品方向通过（首个正判定）**——三假说证伪后经参照物板（R1 iA × R5 Craft）定方向；材质暂定 R4 零纹理；风格源 direction-b 排印宪章 v3 转录为 r5 档；宪章 token 表 / 字形盘点 / 表面清单三件备料落地；打磨 A 段（转录缺口）清账，B 段队列待 vision 会话；用户疲劳态落账，人判项挂起 | paper-shell |
| 2026-08-22 | **workspace-flip 竣工**（批 1-5 五 commit：会话首页 / 零目录会话 / 打开流两段化 / bootShell 接线 / 纸壳 preset——S3 解锁） | workspace-flip |
| 2026-08-22 | workspace-flip 设计件 D9 出稿（六批序列）+ W1 访谈四项粒度拍板；**待用户批准开工** | workspace-flip |
| 2026-08-22 | 纸壳 V3b 壳装配竣工（纸面板迁组合层贡献 + 块渲染器第五通道 ctx.renderers） | paper-shell |
| 2026-08-22 | 纸壳 V3a 骨架内核竣工（pretext 上游测量 / 虚拟化 / 抽纸条 / 方位感 / IME 谓词） | paper-shell |
| 2026-08-22 | 顺序拍板：先结构（#9）后视觉——视觉打磨排后，避免「什么都没做完」陷阱 | 总控 |
| 2026-08-21 | 走查弹毕业（用户判定「感觉是对的」）；块粒度定案（#10 抽纸条） | paper-shell |
| 2026-08-20 | 组合层 S4 竣工（preset realm / 热重载 / npm 安装 / hello 闭环） | composition |
| 2026-08-20 | 组合层 S0-S2 竣工；paper-shell 立项（R1/R2 访谈）；三阶段串行排程拍板 | composition / paper-shell |
| 2026-08-19 | 前端总线归零 + ui/ 拆分竣工（事件系统退役，zustand 统一） | 已归档 |

### 下一步（就一条）

**paper-shell R5 打磨环**——方向已定（印刷品，材质=R4 零纹理），A 段转录缺口已清账；建议开 **vision 会话**跑 B 段自检循环（agent 对着黄金样本 direction-b 自我迭代，用户只做终审）。队列与规则见 [`paper-shell/r5-polish-backlog.md`](paper-shell/r5-polish-backlog.md)，今日全部决定见 [`paper-shell/taste-ledger.md`](paper-shell/taste-ledger.md)（注意：用户疲劳态已落账，人判项挂起，勿批量索要判断）。

### 编号系统对照（防绕晕）

| 编号 | 含义 | 所属工程 |
|---|---|---|
| W1、D-W1-x | workspace-flip 访谈轮次/决定 | workspace-flip |
| D9、批 1-6 | workspace-flip 设计件/施工批次 | workspace-flip |
| R1、R2 | 纸的视觉/交互访谈（R1 五项 R2 四项） | paper-shell |
| R3 | 纸的退役访谈（共居期/判据）——**未开**，等「纸能住人」 | paper-shell |
| V0-V5 | 纸的管线阶段（V0 访谈 / V1 原型 / V2 契约 / V3a·V3b 骨架装配 / V4 打磨 / V5 壳切换） | paper-shell |
| V5 机制半 | bootShell 接线 + 纸壳 preset——workspace-flip 批 4-5 承接 | 跨（见两 README） |
| S0-S4 | 组合层阶段（S0 装载 / S1 注册表 / S2 外化 / S3 行化【等纸】/ S4 preset） | composition |
| #1-#10 | paper-shell 待定清单编号（全部已定案/剥离，仅 #4 R3/#5 V2/#6 V4 参数开） | paper-shell |
| D-R1-x … D-R4-x | 历史访谈决定编号（R4 = 现 W1，编号保留不改写） | 各访谈文件 |

## 活跃计划

| 计划 | 状态 | 下一步 |
|---|---|---|
| [`workspace-flip/`](workspace-flip/) | **Done**（2026-08-22 批 1-5 竣工——软件概念翻转：纯会话优先 / 零目录会话一等化 / 图谱后台预热 / bootShell 组合接线 / 纸壳 preset + 主视图落点。五 commit 见计划 README 竣工记录） | 维护态（行为边界与遗留见 README） |
| [`paper-shell/`](paper-shell/) | In progress（2026-08-20 立项，独立创作工程。V0 ✅ → 走查弹 ✅ → V3a ✅ → V3b ✅ → V5 机制半 ✅；V1 三轮负结果后经参照物板收敛：**R5 印刷品方向通过（2026-08-22，首个正判定）**，材质暂定 R4 零纹理） | R5 打磨环 B 段（队列见 r5-polish-backlog.md）；R3 退役访谈等「纸能住人」 |
| [`composition-architecture/`](composition-architecture/) | **S0-S2 Done · S4 Done**（装载通道 / 注册表化 / 组合外化 / preset realm + 分发；宪法见 [`docs/adr/composition-boundaries.md`](../adr/composition-boundaries.md)） | S3 逐域行化——**解锁条件已满足**（workspace-flip 批 5 交付纸壳 preset）；按纸推进按需迁 |
| [`arch-action-plan.md`](arch-action-plan.md) | 批 1/2 完成；批 3 的 13/12/11a/11b 完成，14 部分完成，11c 搁置 | 11c 与 agent 区 any 清理 |
| [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) | P0–P5 已落地 | Windows 真机验证（cfg(windows) 路径） |
| [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md) | 第一至第五批已提交 | Windows 真机 E2E-1/2/3/4/5 |
| [`agent-core-convergence/`](agent-core-convergence/) | **Done** — Phase 0–6 + V0–V6 全部完成；baseline 8 快照冻结 | 维护态：gate 与 baseline 长期守护 |
| [`cordis-migration/`](cordis-migration/) | **Done** — P0-P4 全部落地 | 后续同模式候选按需逐个迁 |
| [`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) | Draft | Linux 环境执行 |
| [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) | Proposed（P4 门控于 DSH 官方接口稳定信号；P1-P3 纯自研独立成立） | P1 工具面文档生成（半天）随时可做 |
| [`ui-react-island-retirement-plan.md`](ui-react-island-retirement-plan.md) | **Done**（2026-08-19） | — |
| [`eventbus-zero-and-ui-split-plan.md`](eventbus-zero-and-ui-split-plan.md) | **Done**（2026-08-19） | — |

## 已归档计划

见 [`docs/archive/README.md`](../archive/README.md）：graph-id-refactor-plan（R0–R10 竣工）、tool-convergence-browser-plan、browser-cdp-suite-plan-2026-08-13 等。
