# 兰台交接棒 9 —— P4 B④ 试点落地：memory/claude-md 段迁 ctx.prompts 第一方插件通道

> 2026-08-23 晚会话（续第 8 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton8.md（第 8 棒：B① git/search 迁插件通道 + A-1 prompts 第六 service）

## 0. 本棒干了什么

1. **B④ 试点批 ✅**（本棒主活，commit 见 §4）：memory / claude-md 两段从
   `builtinPromptSections()` 出厂表迁入 `ctx.prompts` 第一方插件通道。
   - `plugins/prompt-segments-plugin.ts`：promptSegmentsPlugin（inject
     ['prompts']，B① git-search-plugin 同款形状）；段定义留
     `prompt-sections.ts` 单一真源（`migratedPromptSections()` 导出）。
   - `composition/first-party-prompts.ts`：清单单一真源 +
     `withFirstPartyPromptChannel` 通道腰（镜像 first-party-tools.ts）；
     loader 表尾接清单（promptsServicePlugin 之后，inject 可解析）。
   - **零漂移按构造**：迁出段 = 表尾后缀，贡献恒在末尾 = 表尾原位——
     convergence 双 preset 实测字节全等（baseline 零触碰）。
   - phase-0 夹具 system-prompt.fixture 包通道腰（async 化，B①
     buildStandardRegistry 同款先例）；composition-prompt-sections /
     composition-roster 测试适配；新钉面
     `tests/prompt-segments-plugin.test.ts` 5 例。
2. **B④ 障碍表勘定修正（写回计划 §5）**——两处推翻 baton8 的预判：
   - **动态插值段无 ①c 缓存障碍**：prompt 通道无实例缓存，render 每装配
     重调直收 PromptSectionContext——试点即迁动态段（memory/claude-md）
     验证了这一点。
   - **真障碍是拼装序约束（新列勘定依据第 ④ 条）**：贡献恒在解析产物
     末尾（A-1 定型语义），迁中段段 = 拼装序变化 = 击穿 fixture + 前缀
     缓存。**零漂移迁移仅限表尾后缀**——baton8 列的静态段
     （behavior-rules 等）反而必须最后迁。剩余批次按表尾逆序：
     graph-snapshot → multi-agent → env/model-identity → … → 静态五段收尾。
   - 寻址域收窄同 B①：patch 寻址 memory/claude-md 报「未知段 id」整体
     拒绝（错误可见）；composition README 边界注已扩。
3. 文档回写：plan §5（勘定依据 ④ + B 表 ④ 行落地）、S2 设计件行域表、
   composition/plugins README 各一处、prompt-sections/loader 文件头。
4. 验证：目标 5 文件 61 例绿 → convergence standard+minimal 顺序跑双绿 →
   tsc --noEmit 零错 → 本批 8 文件 biome 全绿（全仓 249 errors 是既有
   债、全在未触碰文件）→ 全量 vitest 159 文件 1570 passed / 1 skipped /
   0 failed（含并行窗口在途 paper-shell 改动同场全绿）。

## 1. 本机环境坑（沿袭 baton8 §1，全部继续有效）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位（shell D:\tmp vs 文件工具 C:\Users\...\Temp）——跨工具
   传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑。

## 2. 下一窗口的工作序

按计划 §5 P4 剩余批次：

1. **B④ 续批**（试点机制已验证，纯机械推进）：graph-snapshot 迁通道（表尾
   逆序第 3 段）→ 再后 multi-agent。每批 = 表移除 + migratedPromptSections
   追加 + 双 preset convergence（零漂移按构造）。到 multi-agent 迁完时
   静态段开始入场（visual-discipline → collaboration-mode → graph-discipline
   → behavior-rules……注意 behavior-rules 在完整面是首段，它迁完 = 全表
   迁空、builtinPromptSections() 退役——届时 assembleSystemPrompt 的
   「解析产物」概念需要重新审视（空表 + 全贡献 = 纯插件面）。
2. **② 可搬三族**（fs/shell/agent-isolation，同 ①a 形状照抄 git-search-plugin）。
3. **A-2 hooks/preflight 暴露面**（~1-2 天）：插件参与工具管道。
4. 依赖链不变：①b web + browser-desktop ← S4-4；①c wait/ask + memory/
   skill/task/agent ← 按装配传参设计；⑤ ← A-3；⑥ ← A-2。

## 3. 环境与雷区备忘

- **并行窗口 paper-shell 线**：B 段审美循环已由并行窗口收官（commit
  `d08891c0`，本会话中段落地）；收官后又开新活仍未提交——
  `src-ui/src/app/panels/PaperPanel.tsx` / `src-ui/src/paper/selection.ts` /
  `src-ui/src/state/paper-store.ts`（commit 时继续排除；**并行窗口仍在动，
  提交前重新 `git status` 核对清单**）。
- subagent 免费模型 400 问题（baton7 记录）本会话未复测——全程亲做。
- convergence record 正确姿势不变（本批零漂移，baseline 无需重录）。
- biome 全仓 249 errors / 336 warnings 是既有债（本批 8 文件全绿）——
  别误当回归；修不修属独立清理批。

## 4. 本棒提交清单

- `793b0e91` — refactor(composition): P4 B④ 试点——memory/claude-md 段迁 ctx.prompts 第一方插件通道（12 文件）
