# 兰台交接棒 12 —— S4-4 机器桥整批（甲+乙）+ ①c 无缓存行：三批落地

> 2026-08-23 深夜会话（续第 11 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton11.md（第 11 棒：B④ 收官 + ② 三族）

## 0. 本棒干了什么

按 baton11 §2 工作序接手前三项，三批各自验证链全绿后提交（含一项
开工前的补漏提交）：

1. **开工补漏 ✅**（commit `bbcf524d`，2 文件）：查实第 11 棒 ② 批提交
   `20d8771d` 只进了新增侧（coding-domain-plugins.ts），`git-search-plugin.ts`
   旧源/测试的删除漏 staging 一直留在工作区（HEAD 里已成孤儿）——精确
   补提两个删除，仓库态与 baton11 验证全绿时的工作区态对齐。
2. **S4-4 甲 ✅**（commit `02ff20ab`，26 文件）：插件贡献行/段进组合解析域。
   - **快照式解析域**：`factoryComposition()` 收编通道贡献——tools 域
     = `builtinToolRows()` + `pluginToolRows()`（builtin 在前、贡献行随后），
     prompt 域 = `activePromptContributions()`。patch/preset 可寻址
     `plugin/<贡献 id>` 行与贡献段 id（含 13 第一方段）。
   - **合流语义退役**：`assembleSystemPrompt` sections 提供即精确清单
     （不再末端追加贡献）、缺省 = 当前贡献；B④ 收官的两条临时位序
     （插入段恒在贡献之前 / insert 同名贡献段不拒）与 B①/② 的寻址拒绝
     全部消灭。
   - **buildToolRegistry 单循环**：行表源 = 组合解析产物（缺省 =
     factoryComposition().tools 完整基座），旁路 pluginToolRows 循环退役
     ——装配序不变零漂移按构造。
   - **贡献变更 = 组合输入变更**：prompt-service 新增
     `onPromptContributionsChanged`（镜像 tools 通道）；preset-assembly
     cache 键加贡献代数（register/dispose 递增 → 全键失效）+ 新增
     `reapplyComposition()`（error 态跳过 / factory 态重新快照 / ok 态
     重解析回写 composition-store）；bootShell 装配贡献监听
     （armContributionsWatcher）。
   - convergence 夹具：MINIMAL_PRESET.toolRows 改惰性 thunk（在
     withFirstPartyToolChannel 腰内求值——模块装载期求值会丢贡献行），
     buildStandardRegistry 收 thunk 数组兼容。
3. **S4-4 乙 ✅**（commit `591cc345`，17 文件）：MCP 机器桥。
   - **manifest.mcpServers 可选字段**（zod strict + refine：stdio 必须
     command 禁 url / http 反之；failurePolicy 枚举 lazy|startup-error）。
   - **`plugins/mcp-bridge.ts` 新文件**：一个 server = 一条工具贡献
     （id `<插件名>/mcp/<server名>` → 行 id `plugin/<插件名>/mcp/<server名>`
     进寻址域——与甲合流可被 patch/preset 寻址禁用）；stdio 经注入 IO
     （生产 = Rust protocol_bridge + 新 `plugin_dir` RPC 解析 command
     相对插件目录；裸名走 PATH）/ http 直连；kill 与贡献注销挂同一
     fiber 的 ctx.effect（插件卸载 → 进程链式停，R15 对策）。
   - **ToolContribution.factory 放宽** `Tool | Tool[] | Promise`（乙整组
     形态）；**pluginToolRows 空集不缓存**（lazy 失败 = 空集 + warn，
     下次装配重试——服务器恢复后新会话即得工具面；断线重连监督是
     未决项，v1 以装配期重试承担）。
   - **loader 包装插件**：manifest 声明 mcpServers 时 entry.apply 后注册
     桥贡献（inject 并集补 'tools'）；startup-error 急连接失败 →
     包装 apply reject → 插件 error 记录（失败隔离既有路径）。
   - Rust 侧：`plugin_dir` RPC（名字围栏同 uninstall + 测试）；RPC 契约
     文档再生成（153 方法——旧文档 155 是 Unity 摘除后的陈旧数字，
     实际表 152 行 + plugin_dir）。
4. **①c 无缓存行 ✅**（commit `48db43e2`，19 文件）：拍板 #2 路线一。
   - **ToolContribution 新增 `noCache` 声明标记**：pluginToolRows 对
     noCache 贡献不进实例缓存、每装配重调 factory——与乙批「空集不
     缓存」统一成一套缓存分家机制（无状态族缓存 / 真值族 noCache /
     瞬态族空集重试）。
   - **七族迁移**：wait/ask + memory/skill/task/agent + hologram（③
     变体）从 tool-rows 行表迁 coding-domain-plugins——noCache 贡献
     工厂直收当次 rowCtx（subAgentPool / ui 回调 / 可选 registry /
     graphData 开关），无跨装配串扰；**行表 9→2**（余 web/browser-desktop
     是 ①b 迁移候选——寻址前置已就位）。
   - **hologram 整组形态**（关键实现裁决）：工具名面装配期才知（引擎/
     mock schema 各异）——不走 per-tool 名清单，一行贡献
     `plugin/hologram/engine-domain/tools` 承载整族（Tool[] factory，
     乙形态）。首版 per-tool 名清单把动态面锁死成 2 个静态名
     （dataflow 对），convergence 打回（count 14→12 少 ops/lsp）后改
     整组形态——jsdom 下 loadHologramSchemas 走 bridge→mockInvoke 返回
     36 schema 非空，graph/ops/lsp 域工具零漂移恢复。
   - **测试探针换代**：builtin/wait 等旧行 id 探针全面翻案（roster/
     presets/assembly/wiring/hot-reload 五文件）——builtin/web +
     builtin/browser-desktop（builtin 表存活行）与
     plugin/hologram/wait-domain/wait（贡献行）分场景使用。

## 0.5 验证记录（三批各自全链）

- 甲：目标 16 文件 152 例绿；convergence standard+minimal 零漂移 ×2；
  tsc 零错；全量 1598 passed（graph-engine-toggle 全量期假红 ×2 单跑绿）。
- 乙：mcp-bridge 7 例 + loader 12 例（ProcIO 注入 fake 走真 MCP JSON-RPC
  行协议）；cargo bin 410 全绿（含新增 plugin_dir 测试；os_sandbox 首轮
  FAILED 为输出交叠误读——总结果 0 failed 单跑 17/17）；convergence 双
  preset 零漂移；全量 1605 passed。
- ①c：coding-domain 12 例（noCache 机制钉面：wait 两装配不同实例 vs
  shell 缓存行同实例 / ask ui 回调装配期换新 / hologram 动态面与缺帐
  空集 / 条件族缺帐空集）；convergence 双 preset 零漂移（注册序变化经
  DOMAIN_SPECS 声明序收敛消化——可见面逐字节不变）；全量 162 文件
  1610 passed / 0 failed（本次全量无假红）；gen:tool-contract 同 commit
  （隐藏名清单 1 行序变：web/browser 前、engine 族居中、task/agent 尾）。
- biome 附带修复：composition-wiring/mcp-bridge 等文件 --write 归一。

## 1. 本机环境坑（沿袭 baton8-11 §1，全部继续有效 + 本棒新增）

1. `NODE_ENV=production` 渗入——每条 shell 命令开头
   `Remove-Item Env:NODE_ENV`。
2. TEMP 路径错位——跨工具传文件用绝对路径。
3. 并行 vitest 假失败——convergence 与全量 vitest 必须顺序跑；
   graph-engine-toggle 全量期假红单跑即绿（本棒三批全量各撞一次）。
4. 多窗口还原——staging 前重新 `git status` 核对 + 关键编辑在位抽查
   （本棒三批提交前都做了 grep 抽查，无还原事故）。
5. 改工具面必须 `npm run gen:tool-contract` 同 commit（①c 触发 1 行序变）；
   **新增**：改 RPC 面必须 `node scripts/gen-rpc-contract-md.cjs` 同
   commit（乙批 plugin_dir——且注意旧文档的方法总数可能本身已陈旧，
   以再生成结果为准）。
6. **convergence record 是危险操作**：①c 调试中曾用 CONVERGENCE_RECORD=1
   临时重录 phase-0 baseline 定位差异——**用后必须 `git checkout --`
   恢复**（本棒已恢复且最终以零漂移收尾，未走 CR 流程）。定位差异改用
   gate 报告的期望/实际行对照更安全。
7. **cordis root 的 asyncDispose 不级联 plugin fibers**：测试断言插件
   fiber 的清理链必须显式 `fiber.dispose()`（mcp-bridge 生命周期测试），
   `root[Symbol.asyncDispose]` 只清 root 自己的 effect。
8. **zod schema 常量 TDZ**：子 schema 常量必须声明在引用它的父 schema
   之前（types.ts McpServerDeclSchema 首版声明在后 → 模块装载即炸）。

## 2. 下一窗口的工作序（沿 baton11 §2，前三项已清）

1. **①b web + browser-desktop 迁移**（最后两族，~半天——寻址前置
   甲已就位）：web 行（单工具 web_fetch）+ browser-desktop 行（动态
   import 族）迁 ctx.tools；minimal preset 的寻址行从
   `builtin/browser-desktop`/`builtin/web` 改枚举
   `plugin/hologram/web-domain/web_fetch` +
   `plugin/hologram/browser-desktop-domain/...` 形态（**注意**：presets.ts
   内置 minimal 表 + convergence helpers/presets.ts MINIMAL 派生 + 相关
   测试探针同步）；行表清空后 builtinToolRows() 可退役或留空表（届时
   定）。验证链同 ①c（convergence 双 preset 零漂移是硬门禁——minimal
   行集合变化但可见面不变）。
2. **A-2 hooks/preflight 暴露面**（~1-2 天）：插件参与工具管道
   （富化/门禁）。
3. **A-3 capability 贡献面**（设计件过用户审批）：会话级能力的插件
   装载（⑤ 会话级能力批的前置）。
4. **C11 两基建**（~4 天）：zod↔manifest 可序列化 + permissions.json
   接插件声明。
5. **C12 dsh-compat** 唯一合法挂起（DSH peer 出非 workspace 版本即启动）。

## 3. 环境与雷区备忘

- **并行窗口 agent/provider 线仍在途**（agent.ts / chat-agent-handle.ts /
  ModeIndicator / ModelSelector / SettingsPanel / provider-settings 全家 /
  settings.ts / thinking.ts / paper selection.ts / paper-store.test.ts /
  provider-page-staging.test / mode-indicator-model-menu.test.ts /
  CONTEXT.md / lantai-design-spec.md）——提交时继续排除，staging 前重新
  核对；他们跑 vitest 会造成 §1.3 假失败。
- 机器桥的 DSH reconnect loop 同构重连监督是已声明未决项
  （docs/plugins/README.md §9）——真实用户报告断线需求时再做。
- 机器桥手动验收（engine.exe 当靶子 spawn hologram-engine serve mcp 挂进
  hello 插件）未做——vitest ProcIO 注入 fake 已覆盖行协议层，真机
  验收留给有真实插件的场景。
- subagent 免费模型 400（baton7）未复测——全程亲做。

## 4. 本棒提交清单

- `bbcf524d` — refactor(composition): 补提 ② 批遗漏删除——git-search-plugin
  旧源/测试文件退役（2 文件）
- `02ff20ab` — feat(composition): S4-4 甲——插件贡献行/段进组合解析域，
  全寻址恢复（26 文件）
- `591cc345` — feat(plugins): S4-4 乙——MCP 机器桥：manifest.mcpServers
  声明式挂接外部 server（17 文件）
- `48db43e2` — refactor(composition): P4 ①c——七族迁 ctx.tools 无缓存行，
  行表 9→2（19 文件）
