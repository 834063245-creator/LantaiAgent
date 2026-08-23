# 兰台交接棒 7 —— P4 插件化开工：P4a 调研毕 + 基线补录毕 + B① 障碍勘定

> 2026-08-23 下午会话 · 下一窗口从本文件起读
> 上棒：lantai-handoff-baton6.md（第 6 棒：Value 化第二步 + C 段 C1-C12 收官）

## 0. 本棒干了什么（全部已 commit）

1. **P4a 契约调研 ✅**（C13 判据达成）：`docs/research/p4a-dsh-contract-notes.md`。
   核心结论：DSH 模型面 ToolSchema 三字段与兰台完全同构；参数声明的公共分母 =
   可序列化 JSON Schema（DSH 自研 DSL 编译目标就是它，schemastery/zod 都不是工具面）；
   226 包 peer 全量统计，L1/L2 工具类最小 peer 面 6-7 个（llm/session/invariants
   兰台无对应物，路线 A 要 stub）；版本纪律前提仍成立（peer 全 workspace:^，
   根版本 0.1.0-rc.8 在靠近 npm 发布）。**路线 A 启动信号建议改为「peer 出现
   非 workspace 版本」**。
2. **convergence 基线补录 ✅**（commit 5b5c20a9）：30b54f84（shell 粘性 cwd）与
   15930f65（code_execution）两个已批准提交的重录执行不完整——补录剩余 6 快照
   （tool-schemas.full/plan × standard+minimal、minimal fixture、minimal effective
   5→6）。change request 在案（baseline-change-request-shell-cwd-completion.md，
   用户会话拍板「准了」）。**教训：commit 声明「基线经批准重录」时，record 必须
   standard + minimal 两轮都跑全，别只录一个文件。**
3. plans/README 修订：rpc Value 化 ✅ 已毕行（随并行窗口 commit 落 HEAD）。

## 1. B① 试金石批：开工前勘定的真实障碍（本会话最重要的产出）

计划 §5 P4 批次表写「①②③ 无障碍纯搬运」——**过于乐观**。逐族实证后修正：

| 族 | 障碍 | 结论 |
|---|---|---|
| **git / search** | 无（只依赖 codingExec——装配期新闭包但语义无状态） | **真无障碍，可搬** |
| web | minimal preset 寻址 `builtin/web` 禁用它；行搬进插件通道后脱离 roster 组合解析域（roster 只认 builtin 行，agent-builder.ts:266 注释明示「组合解析域目前只含 builtin 行——patch/preset 寻址插件行属 S4-4 机器桥批扩展」） | 需「plugin 行纳入组合解析域」通道先行 |
| ask / wait | 依赖装配期真值：ask 族的 ui 回调每次装配换、wait 的 subAgentPool 按装配变化；而 ToolContribution.factory 是注册期缓存、实例跨装配复用（plugin-tool-rows.ts instanceCache）——直接搬 = 跨面板串扰（INVARIANTS #1 同族雷） | 需贡献签名按装配传参（factory 收 ToolRowContext）或另行设计 |

**搬运的零漂移分析**（下一窗口实施时直接用）：

- git/search 搬走后**可见面序不变**：可见域工具序由 DOMAIN_SPECS 声明序驱动
  （convergeRegistry 在装配末端重建，与注册序无关）；git/search 旧名经
  collectHiddenToolNames 隐藏，走哪条通道注册都一样。phase-0 快照应零漂移。
- ask 族**不能**轻动：ask_user 是细粒度可见名，schemas() 位置 = 注册序；
  搬到 plugin 通道会排到 wait 之后 → baseline `ask_user, wait` 翻转成
  `wait, ask_user` → 漂移 + 前缀缓存重算。
- ToolContribution.factory 现签名 `() => Tool`（services.ts:162）；git/search
  搬运需向后兼容放宽（可选接收装配上下文）。**注意 hello 范本与
  docs/plugins/README.md §3 的外部插件契约是「无参 factory + 实例缓存」——
  放宽签名时别破坏外部插件语义**（建议：factory?: (ctx?) => Tool，无参仍合法）。

## 2. 下一窗口的工作序

1. 读本棒 → docs/research/p4a-dsh-contract-notes.md（10 分钟）；
2. **B① 实施批**：搬 git + search 两族为第一方插件（范本：plugins/settings-plugin.ts
   的域插件形状 + loader.ts BUILTIN_PLUGINS 表加行）。注意：
   - 装配序影响：git/search 行从 builtinToolRows() 表移除，贡献经 ctx.tools 注册，
     pluginToolRows() 叠在 builtin 之后——旧名注册序变了但可见面不变（见上分析）；
   - 搬完跑 verify:convergence（standard 不设 env 直接跑 + minimal 显式），
     phase-0/phase-1 应零漂移；若 effective 漂了先停下分析，别急着 record；
   - vitest 全量 + npm run build + biome 改动文件零新增；
3. 把 §1 的障碍表写回 agent-plugin-architecture-plan.md §5 P4 批次表
   （①批次表内容修正 + web/ask/wait 标注通道依赖）；
4. 之后按计划：A-1 prompt-sections 贡献通道（~1 天）→ B④。

## 3. 环境与雷区备忘

- **本机并行窗口在途工作（勿混 commit）**：paper-shell B 段审美循环已由
  vision 会话落地（README「审美循环 ✅ 全收」行 + taste-ledger 四条 + 
  PaperPanel.css / renderer-service.tsx / measure.ts / paper-v3a.test.ts /
  paper-visual-decisions.test.ts / .shots/）——全部未提交，属另一条线，
  commit 时必须排除。
- subagent 派遣用的免费模型（opencode zen / x-preview-f-free）当前 400：
  「This model always engages in thinking and cannot be disabled」——
  派子 agent 会三连败，本会话改为亲自做。下一窗口如需 subagent，先换模型。
- B 段审美循环的 vision 模型问题已解决（并行窗口用「文字重判」跑完了 B1-B5），
  DeepSeek V4-Flash-Vision-Exp（2026-08-21 上线）未用上——充值问题挂起中。
- convergence record 的正确姿势：`npm run record:convergence`（不是裸设
  CONVERGENCE_RECORD=1 跑 verify——gate.mjs 要 record 子命令，防呆会拦）；
  minimal 侧要 `$env:CONVERGENCE_PRESET='minimal'; npm run record:convergence`。

## 4. 本棒提交清单

- 5b5c20a9 — 基线补录（6 快照 + change request）
- 本棒提交 — C13 标记（agent-plugin-architecture-plan.md）+ P4a 调研笔记 + 本交接单
