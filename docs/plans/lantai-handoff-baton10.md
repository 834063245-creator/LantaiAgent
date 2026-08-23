# 兰台交接棒 10 —— P4 B④ 续批：graph-snapshot 迁 ctx.prompts 第一方插件通道

> 2026-08-23 深夜会话（续第 9 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton9.md（第 9 棒：B④ 试点 memory/claude-md 迁插件通道）

## 0. 本棒干了什么

1. **B④ 续批 ✅**（commit 见 §4）：graph-snapshot（表尾逆序第 3 段）从
   `builtinPromptSections()` 迁入 `ctx.prompts` 第一方插件通道。
   - 表 11→10 段；`migratedPromptSections()` = [graph-snapshot, memory,
     claude-md]。
   - **序保真勘定（本批最重要发现）**：表尾逆序迁移下，新迁段在原表中
     先于已迁段——必须插 `migratedPromptSections` 数组**头部**。试点批
     注释「后续批次在此追加」是错的：试点两段恰好 append == 正确序
     （掩盖了坑）；本批若照抄，贡献序会翻成 memory→claude-md→
     graph-snapshot = 拼装序漂移，击穿快照。已勘正源码注释 +
     plan §5 勘定依据 ④。
   - convergence 双 preset 零漂移实测（baseline 未动）。
   - 钉面适配：composition-roster 两探针（「锚可指禁用行」后继断言改
     表尾落位；撞段探针改 multi-agent 现表尾）；prompt-segments-plugin
     测试扩三段序断言 + snapshot 命中/跳过；composition-prompt-sections
     计数 10+3。
   - 文档回写：plan §5（勘定依据 ④ + B 表 ④ 行「试点 + 首续批已毕」）、
     S2 行域表（表 10 段）、composition/plugins README、
     loader/first-party-prompts/prompt-segments-plugin/phase-0 四文件头。
2. **多窗口还原事故（纪律升级，务必读）**：验证链运行期间，并行窗口对
   本会话 8 个已编辑文件（prompt-sections.ts / 三测试文件 / 四文档）
   执行了外部还原（git restore 类操作）——目标测试与 convergence 全绿
   **之后**，文件内容悄悄回到 HEAD，若不核对险些带病提交（幸存 4 文件：
   prompt-segments-plugin.ts / first-party-prompts.ts / loader.ts /
   phase-0.test.ts）。处置：8 文件全部重放 + 全链重验 + 立即提交保护。
   **教训：验证绿 ≠ 提交时文件还在**——多窗口下验证与提交之间的窗口期
   就是风险敞口；验证完立即 commit，staging 前 git status 之外还要对照
   预期文件清单确认编辑仍在（发现被还原 → 重放 + 重验，不要信旧绿灯）。
3. 验证记录：目标 3 文件 40 例绿（重放前后各一次）；convergence
   standard+minimal 42/42 ×2（两次，零漂移）；tsc --noEmit 零错；biome
   本批 8 文件绿；全量 vitest 160 文件 1588 passed / 1 skipped /
   0 failed（第一次跑 1 failed：message-bus agent_inbox——在并行窗口
   在途区，单跑 51/51 绿 + 复跑全量全绿，定性瞬时干扰，非本批回归）。

## 1. 本机环境坑（沿袭 baton8/9 §1，全部继续有效）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位（shell D:\tmp vs 文件工具 C:\Users\...\Temp）——跨工具
   传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑。
4. **新增：多窗口还原**——并行窗口可能 git restore 你的在途编辑（本棒
   实锤，8 文件被还原）；编辑→验证→提交一气呵成，验证后别闲逛。

## 2. 下一窗口的工作序

按计划 §5 P4 剩余批次：

1. **B④ 续批**（机制与勘定已齐，纯机械推进）：multi-agent 迁通道（表尾
   逆序第 4 段；`migratedPromptSections` **头插**保序）→ 再后
   env/model-identity → … → 静态五段收尾。每批 = 表移除 + migrated
   头插 + 双 preset convergence（零漂移按构造）+ 钉面表尾探针换代。
   - **multi-agent 批的特殊注意**：roster 测试有两处以 multi-agent 为
     **探针本体**的用例（disable 语义 + insert 锚可指禁用行）——迁出后
     它们脱离寻址域，用例要么换探针段（如 model-identity 成为新表尾）
     要么改造为「寻址拒绝」探针（同 memory/claude-md 先例：寻址报
     「未知段 id」整体拒绝）。
   - 到 behavior-rules 迁完 = 全表迁空、`builtinPromptSections()` 退役
     ——届时 assembleSystemPrompt 的「解析产物」概念需重审（空表 +
     全贡献 = 纯插件面）。
2. **② 可搬三族**（fs/shell/agent-isolation，同 ①a 形状照抄
   git-search-plugin）。
3. **A-2 hooks/preflight 暴露面**（~1-2 天）：插件参与工具管道。
4. 依赖链不变：①b web + browser-desktop ← S4-4；①c wait/ask + memory/
   skill/task/agent ← 按装配传参设计；⑤ ← A-3；⑥ ← A-2。

## 3. 环境与雷区备忘

- **并行窗口两条线**：paper 线已收官（`19fc0279`，本会话中途落地——
  PaperPanel/paper-store/selection/chat-session 等 9 文件）；agent/
  provider 线仍在途（agent.ts / chat-agent-handle.ts / message-store
  stash「agent-domain-check」/ provider-settings 全家 / ModeIndicator /
  ModelSelector / SettingsPanel / settings / CONTEXT.md /
  lantai-design-spec 等 + 新增 mode-indicator-model-menu.test.ts）——
  提交时继续排除；**并行窗口仍在动，staging 前重新 `git status` 核对**，
  并提防 §1.4 的还原事故。
- message-bus agent_inbox 有一次瞬时失败记录（全量首跑 1 failed，单跑
  与复跑全绿）——若再见，先怀疑并行干扰，单跑复验再定性。
- subagent 免费模型 400 问题（baton7 记录）本会话未复测——全程亲做。
- convergence record 正确姿势不变（本批零漂移，baseline 无需重录）。
- biome 全仓既有债不变（本批 8 文件全绿）——别误当回归。

## 4. 本棒提交清单

- `9166a682` — refactor(composition): P4 B④ 续批——graph-snapshot 段迁
  ctx.prompts 第一方插件通道（12 文件）
