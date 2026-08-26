# 兰台交接棒 8 —— P4 双批落地：B① git/search 迁插件通道 + A-1 prompts 第六 service

> 2026-08-23 下午会话（续第 7 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton7.md（第 7 棒：P4a 调研 + 基线补录 + B① 障碍勘定）

## 0. 本棒干了什么（全部已 commit）

1. **B① 实施批 ✅**（commit `d977587d`）：git/search 两族从 builtinToolRows() 迁入
   ctx.tools 第一方插件通道。
   - `plugins/git-search-plugin.ts`：一域一插件（S3 settings 先例）；贡献 factory
     惰性建族——apply 期经族工厂展开名字清单（真源单一），首装配经
     rowCtx.codingExec 建族、同族贡献共享（apply 闭包，非模块态）；
     缺 rowCtx 显式 throw（错误不静默）。
   - `composition/first-party-tools.ts`：插件清单单一真源 +
     `withFirstPartyToolChannel` 通道腰——**关键机制**：convergence 夹具与
     gen-tool-contract 无 main.ts 引导，不经通道腰快照/文档就丢族
     （buildDomainTool 按注册面过滤 action，缺席 = 域工具 action 静默消失）。
   - `services.ts` ToolContribution.factory 放宽可选收 ToolRowContext（外部
     插件无参契约不变）；plugin-tool-rows 折算穿 ctx；行表 14→12 族；
     loader 表尾接清单。
   - `tests/git-search-plugin.test.ts` 8 例（贡献清单/factory 语义/族 exec
     锁存/生命周期/折算/端到端/真源对拍）。
   - convergence **双 preset 零漂移**；model-tool-contract 重生成（仅附录
     隐藏旧名排列序变，可见面零变化）。
2. **障碍表写回计划 ✅**（随 d977587d）：计划 §5 B 表「①②③ 无障碍纯搬运」
   修正为逐族勘定——①拆 ①a已毕/①b/①c；②③按同族勘定分族标注；三条机制
   约束（组合解析域边界 / 实例缓存锁存 / 域收敛依赖注册面）写进表头勘定依据。
3. **A-1 prompts 通道 ✅**（commit `9f2926ea`）：第六贡献通道 `ctx.prompts`。
   - `composition/prompt-service.ts`：PromptsService + promptsServicePlugin
     （renderer-service 先例）；PromptContribution 形状即 PromptSection
     （render 产出含自身前导分隔符——与内置段同一字节契约）。
   - 合流点 = assembleSystemPrompt 末端追加：无贡献 = 空集 = **零漂移按
     构造**（双 preset 实测）；贡献恒在解析产物末尾，不进 roster 寻址域。
   - 收紧点：服务 dispose 守卫式清空读取面（prompt 是字节敏感面；四
     service 无此清理是面板域既有宽松面，本通道防跨测试串味收紧）。
   - `tests/prompt-service.test.ts` 9 例。
   - 文档勘正顺手批：plugins/composition README 两处超前表述（「patch 可
     寻址 plugin 行」——实际解析域只含 builtin 行）；四份规则书五→六
     service 叙述同步；plan §5 A 表 A-1 落地 + B④ 障碍更新（动态插值段
     同 ①c 缓存锁存——roster text 覆盖已声明丢失插值，插件通道需同款语义）。
4. 前端基线刷新：158 文件 1566 passed / 1 skipped（+git-search 8 +
   prompt-service 9）；AGENTS/CLAUDE 已记 NODE_ENV 陷阱。

## 1. 本机环境三坑（本会话实踩，已在 AGENTS/CLAUDE + 项目记忆）

1. **`NODE_ENV=production` 渗入**：父进程带它时 convergence specs 收集阶段
   报 `No such built-in module: node:`（7 specs 全炸 no tests）——每条 shell
   命令开头 `Remove-Item Env:NODE_ENV`（PowerShell 各命令独立进程，清一次
   不跨命令）。
2. **TEMP 路径错位**：shell 的 `$env:TEMP` = D:\tmp，文件工具写
   C:\Users\Administrator\AppData\Local\Temp——跨工具传文件（如 git commit -F）
   必须用绝对路径。
3. **并行 vitest 假失败**：两套 vitest 并发跑会互扰（graph-engine-toggle
   2 例 + tool-contract-doc 对拍假红）——convergence 门禁与全量 vitest
   必须**顺序**跑。

## 2. 下一窗口的工作序

按计划 §5 P4 剩余批次（详表在 agent-plugin-architecture-plan.md，含机制约束）：

1. **B④ prompt 段落存量迁移**（通道已就位）：甄别迁移——静态段
   （behavior-rules/graph-discipline/visual-discipline/collaboration-mode/
   multi-agent 等）可经 ctx.prompts 直迁；**动态插值段**（graph-snapshot/
   memory/claude-md/env/model-identity）render 收装配期真值，同 ①c 缓存
   锁存障碍——但 prompt 通道无实例缓存（每次拼装重调 render），障碍只剩
   「ctx 传入时机」：迁移时贡献 render 直收 PromptSectionContext 即无障碍
   （与 tools 通道的 rowCtx 锁存不同——这里每装配现算）。先小批试 1-2 段。
2. **② 可搬三族**（fs/shell/agent-isolation，同 ①a 形状照抄 git-search-plugin）。
3. **A-2 hooks/preflight 暴露面**（~1-2 天）：插件参与工具管道——第六通道
   之外的下一个 service 面；消费面在 agent/hooks.ts 的 HookRegistry/
   PreflightHookRegistry。
4. 之后的依赖链：①b web + browser-desktop ← S4-4 机器桥（插件行纳入组合
   解析域）；①c wait/ask + memory/skill/task/agent ← 按装配传参设计；
   ⑤ ← A-3；⑥ ← A-2。

## 3. 环境与雷区备忘

- **并行窗口 paper-shell 线仍未提交**（B 段审美循环：foundation.css /
  PaperPanel.css / renderer-service.tsx / measure.ts / paper-v3a.test.ts /
  paper-visual-decisions.test.ts / .shots/ / docs/plans/paper-shell/ /
  docs/plans/README.md / lantai-design-spec.md）——commit 时继续排除。
- subagent 免费模型 400 问题（baton7 记录）本会话未复测——本会话全程
  亲做未派 subagent；如需派发先试模型。
- convergence record 正确姿势不变：`npm run record:convergence` +
  minimal 侧 `$env:CONVERGENCE_PRESET='minimal'; npm run record:convergence`。
- B①/A-1 都是零漂移批，没动 baseline——baseline 目录无需重录。

## 4. 本棒提交清单

- `d977587d` — B① git/search 迁 ctx.tools 第一方插件通道（20 文件）
- `9f2926ea` — A-1 ctx.prompts 第六贡献通道（11 文件）
