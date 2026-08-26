# 兰台交接棒 11 —— P4 B④ 收官 + ② 三族：纯插件面双批落地

> 2026-08-23 晚会话（续第 10 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton10.md（第 10 棒：B④ 续批 graph-snapshot + 五项拍板定案）

## 0. 本棒干了什么

用户明确定调「进度推进太慢，每个窗口接手范围要扩大」——本窗口按 baton10
§2 工作序的前**两项整项**接手，两批各自验证链全绿后提交：

1. **B④ 收官 ✅**（commit `adc3750c`，19 文件）：剩余 10 段一次性迁完
   （multi-agent → identity-brief），13 段全量经 ctx.prompts 通道贡献。
   - `builtinPromptSections()` 退役删除（段表空壳删除，拍板 #3 落地）；
     `migratedPromptSections()` 更名 `firstPartyPromptSections()`（对齐
     firstPartyPromptPlugins/firstPartyToolPlugins 命名族）。
   - **收官批改为单批一次性迁完**（非逐段批）：末态全量经通道后零漂移按
     构造成立（空解析产物 + 13 贡献 ≡ 原 10 表内 + 3 贡献），中间表尾逆序
     状态是过渡态无需逐批落地——baton10 的逐批序是为小窗口设计的，
     大窗口单批更省（测试探针只改一次到终态）。
   - **「解析产物」语义重审落进 prompt-sections.ts 文件头**（4 条）：
     ①出厂面 = 解析产物（缺省空表）+ 通道贡献；无通道环境 = 空提示词
     （obstacle ③ 注册面依赖扩大——buildSystemPrompt/phase3-e2e/
     preset-assembly 测试已包通道腰）；②roster prompt 域寻址面 = 仅已
     插入段（寻址第一方段 id 报「未知段 id」整体拒绝）；③两条临时语义
     （插入段恒在贡献之前 / insert 同名第一方段不拒）S4-4 甲消灭；
     ④prompt 通道无实例缓存，动态插值段每装配现算。
   - 钉面重排：roster prompt 域探针全改 insert-only + 「寻址拒绝」专测；
     wiring 样本组合改「插入两段 + 覆盖已插入段」；patch-loader 合法
     patch 样本改 insert 链。
2. **② 三族 ✅**（commit `20d8771d`，20 文件）：fs/shell/agent-isolation
   迁 ctx.tools（同 ①a：无状态 codingExec，实例缓存语义等价）。
   - **文件合并**：git-search-plugin.ts → **coding-domain-plugins.ts**
     （git mv 保历史），五族（git/search/fs/shell/agent-isolation）一文件
     共享 familyContributions helper；测试同步更名
     coding-domain-plugins.test.ts（五族贡献面 + fs/shell 序钉自
     composition-tool-rows 移入）。
   - 行表 12→9 族；行 id builtin/fs・shell・agent-isolation 退役（寻址
     报「未知行 id」——S4-4 甲恢复）。
   - **契约文档再生成同 commit**：gen-tool-contract 的隐藏名清单按注册序
     枚举——三族工具移到插件行尾，文档 1 行序变（tool-contract-doc.test
     守护，改工具面必须再生成）。
   - 探针换代：builtin/fs・builtin/shell 禁用探针换 builtin/web・
     builtin/wait（roster/presets/patch-loader/discovery/wiring 五处）。
   - 文档回写扩到根文档：AGENTS/CLAUDE/ARCHITECTURE/CONVENTIONS 的装配
     叙事 + REGISTRY_OWNERSHIP 注册点表。

## 0.5 验证记录（两批共用纪律，各自全链）

- B④：目标 10 文件 111 例绿；convergence standard+minimal 零漂移 ×2；
  tsc 零错；biome 15 文件绿；全量 1592 绿（graph-engine-toggle 2 例为
  已知并行干扰假失败，单跑 6/6 绿）。
- ②：目标 9 文件 110 例绿；convergence 双 preset 零漂移 ×2；tsc 零错；
  biome 10 文件绿；**终跑全量 160 文件 1594 passed / 1 skipped /
  0 failed 全绿**（中间三次全量共出现过 4 例红：tool-contract-doc
  = 契约文档未再生成（真差异，gen 后绿）；graph-engine-toggle×2 +
  paper-v3b×1 = 并行窗口在途文件干扰（他们正在改 PaperPanel/agent.ts/
  selection 等），单跑即绿）。
- biome 附带修复：phase3/preset-assembly/roster 三测试文件被并行窗口
  转成 CRLF（index 本就 LF）——biome --write 归一回 LF，git diff 只剩
  内容改动；phase3 既有 `reminder!` 非空断言顺手改 `?.`（既有债清偿）。

## 1. 本机环境坑（沿袭 baton8/9/10 §1，全部继续有效）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位——跨工具传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑；本棒新证：
   **tool-contract-doc 字节对拍 + graph-engine-toggle + paper-v3b 在
   并行窗口活跃期都会假红**（并行窗口在改 agent.ts/PaperPanel 系）——
   全量红先单跑复验再定性，别急着改代码。
4. 多窗口还原——staging 前重新 `git status` 核对 + 关键编辑在位抽查
   （本棒两批提交前都做了 Test-Path/grep 抽查，无还原事故）。
5. **改工具面必须 `npm run gen:tool-contract` 同 commit**（隐藏名清单
   按注册序枚举，行迁移即触发 1 行序变——tool-contract-doc.test 红
   就是提醒，不是并行干扰）。

## 2. 下一窗口的工作序（沿 baton10 §2，前两项已清）

1. **S4-4 机器桥整批**（拍板 #1，~2-3 天，下一主菜）：
   - **甲：插件行纳入 patch/preset 组合解析域**——resolveRoster 工作列表
     接入插件贡献行/段（plugin/<id> 工具行 + ctx.prompts 段）；落地后
     ①b 两族（web/browser-desktop，minimal preset 寻址依赖）即可迁移；
     B④/② 留下的寻址拒绝面 + 两条临时位序语义随之消灭。
   - 乙：manifest mcpServers 进程桥（设计件 S4 §2.7）。
   - 设计依据：S4-preset-realm-distribution.md §2.7 + 本棒 B④ 收官
     语义重审（prompt-sections.ts 文件头 4 条 = 甲的输入）。
2. **①c 无缓存行设计批 + 实施**（拍板 #2 路线一）：依赖装配期真值的
   贡献每装配重创实例——wait/ask + memory/skill/task/agent 四族 +
   ③ hologram 族（graphData 装配期开关 + loadHologramSchemas 动态面）。
   实施面：pluginToolRows 的 instanceCache 对「无缓存行」贡献放行
   （贡献声明式标记或独立通道——设计件定）。
3. **A-2 hooks/preflight 暴露面**（~1-2 天）→ 4. **A-3 capability 贡献面**
   （设计件过用户审批）→ 5. **C11 两基建**（zod↔manifest + permissions.json
   接插件声明）→ 6. C12 dsh-compat 唯一合法挂起（DSH peer 出非
   workspace 版本即启动）。

## 3. 环境与雷区备忘

- **并行窗口两条线**（本棒期间持续活跃）：agent/provider 线在途
  （agent.ts / chat-agent-handle.ts / ModeIndicator / ModelSelector /
  SettingsPanel / provider-settings 全家 / settings.ts / thinking.ts /
  paper selection.ts / paper-store.test.ts / provider-page-staging.test /
  mode-indicator-model-menu.test.ts / CONTEXT.md / lantai-design-spec.md）
  ——提交时继续排除，staging 前重新核对；他们跑 vitest 会造成 §1.3 的
  假失败。
- message-bus agent_inbox 瞬时失败记录（baton10）本会话未复现。
- subagent 免费模型 400（baton7）未复测——全程亲做。
- convergence record 姿势不变（本棒两批零漂移，baseline 无需重录）。

## 4. 本棒提交清单

- `adc3750c` — refactor(composition): P4 B④ 收官——13 段全迁
  ctx.prompts 纯插件面，builtinPromptSections() 退役（19 文件）
- `20d8771d` — refactor(composition): P4 ② 批——fs/shell/agent-isolation
  三族迁 ctx.tools 第一方插件通道（20 文件）
