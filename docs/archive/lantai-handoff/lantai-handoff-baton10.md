# 兰台交接棒 10 —— P4 B④ 续批 + 五项拍板定案：graph-snapshot 迁插件通道

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

## 0.5 五项拍板（2026-08-23 晚，本棒尾部追加——P4 收口方向全部定案）

用户逐项拍定（背景/选项/理由全文见 agent-plugin-architecture-plan.md §5
表注 + 拍板条目）：

1. **S4-4 机器桥复活，整批做**（甲=插件行纳入 patch/preset 组合解析域；
   乙=manifest mcpServers 进程桥，~2-3 天）。理由：一次做完不留增量尾巴。
2. **①c 拍路线一「无缓存行」**：依赖装配期真值的工具族不做贡献实例
   缓存，每装配重创实例（不做代理间接层）。用户理由：所有工具装配时
   统一重创，绝对新鲜。
3. **B④ 收官形态 = 纯插件面**：13 段全迁后 builtinPromptSections() 退役、
   段表空壳删除；拼装器本身不动（只删写死的进货清单，不是拆拼装器）。
4. **A-3 capability 贡献面排进当前工程**：设计件穿插机械批推进，产出
   过用户审批。
5. **对外是目标：C11 两基建排进当前工程**（zod↔manifest 可序列化 ~2 天
   + permissions.json 接插件声明 ~2 天）。用户自举论证：「就算我没有
   用户——我自己也是『一个用户』，做完后加 feature / 移植别人插件都
   可以不碰源码」。

**用户纪律（重要，已入长期记忆）**：「留着等遇到再做」是**推迟**不是
减负——连续五项全部选「现在做完」。可动工项默认全排；唯一合法挂起 =
外部信号依赖型（C12 dsh-compat 等 DSH peer 出非 workspace 版本）。

## 1. 本机环境坑（沿袭 baton8/9 §1，全部继续有效）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位（shell D:\tmp vs 文件工具 C:\Users\...\Temp）——跨工具
   传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑。
4. **新增：多窗口还原**——并行窗口可能 git restore 你的在途编辑（本棒
   实锤，8 文件被还原）；编辑→验证→提交一气呵成，验证后别闲逛。

## 2. 下一窗口的工作序（已按五项拍板定案，穿插推进）

1. **B④ 机械续批**（机制与勘定已齐，随时可跑）：multi-agent 迁通道
   （表尾逆序第 4 段；`migratedPromptSections` **头插**保序）→
   model-identity → env → collaboration-mode → visual-discipline →
   graph-discipline → behavior-rules → 简短面三段（env-brief →
   memory-brief → identity-brief）。每批 = 表移除 + migrated 头插 +
   双 preset convergence（零漂移按构造）+ 钉面表尾探针换代。
   - **multi-agent 批的特殊注意**：roster 测试有两处以 multi-agent 为
     **探针本体**的用例（disable 语义 + insert 锚可指禁用行）——迁出后
     它们脱离寻址域，用例要么换探针段（model-identity 成为新表尾）
     要么改造为「寻址拒绝」探针（同 memory/claude-md 先例：寻址报
     「未知段 id」整体拒绝）。
   - **收官批按拍板 #3 实施纯插件面**：behavior-rules 迁完后简短面三段
     收尾，全表迁空 → builtinPromptSections() 退役、段表空壳删除、
     assembleSystemPrompt「解析产物」语义重审（~半天设计 + 实施）。
2. **② 可搬三族**：fs / shell / agent-isolation——照抄 git-search-plugin
   形状（同 ①a，无状态 codingExec，通道现成）。
3. **S4-4 整批**（拍板 #1，~2-3 天）：甲（插件行纳入组合解析域——
   patch/preset 可点名插件贡献行/段）+ 乙（manifest mcpServers 进程桥，
   设计沿用 S4 设计件 §2.7）。甲落地后 ①b 的 web/browser-desktop 两族
   即可迁移（minimal preset 寻址面随之接入）。
4. **①c 设计批**（拍板 #2 路线一）：无缓存行——依赖装配期真值的贡献
   每装配重创实例；覆盖 wait/ask + memory/skill/task/agent 四族 +
   ③ hologram 族（graphData 装配期开关 + loadHologramSchemas 动态面
   每装配刷新）。
5. **A-2 hooks/preflight 暴露面**（~1-2 天）：插件参与工具管道——⑥ 的
   前置。
6. **A-3 capability 贡献面**（拍板 #4）：设计件穿插上述批次产出 → 用户
   审批 → ⑤ 会话级能力迁移（plan/通信/discovery/merge/board/
   compaction）。
7. **C11 两基建**（拍板 #5，~4 天）：工具声明可序列化（zod↔manifest）
   + permissions.json 接插件声明——对外开放（路线 B）的硬前提。
8. **C12 dsh-compat**：唯一合法挂起项（外部信号依赖：DSH peer 出非
   workspace 版本即启动——P4a 调研已定信号，见
   docs/research/p4a-dsh-contract-notes.md）。

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
- 五项拍板回写（plan §5 表注 + S4 设计件复活注 + 本棒 §0.5/§2）——
  文档提交见本棒尾部 commit。
