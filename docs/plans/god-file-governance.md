# 上帝文件治理（god-file governance）

> 状态：**P1 + P2 + P3 已落地（2026-11-06）**——门禁、chat-session 拆解、纸壳分片、PaperPanel 拆解均已进主干；余 Rust 宽度型文件（登记不拆，见 P4）。
> 门禁 = `src-ui/tests/god-file-budget.test.ts`（未登记文件 ≤ 1000 行；已登记只减不增）。

## 0. 要裁什么（结论在前）

**结论：不是全库腐烂，是几个尖峰在加速。** 产品源码 912 文件 23.8 万行，中位数 103 行；
≥1000 行的 50 个文件占了 34% 代码量。问题不在平均，在**两处热点**——

| 热点 | 实测（2026-11-06） | 为什么算病灶 |
|---|---|---|
| 聊天编排 | `ui/chat-session.ts` 2730 行 / 57 导出 / 8 个职责区；`app/chat/chat-core.ts` 2119 行 / 单类 80+ 方法；`agent/agent.ts` 2486 行 | 一年 97 / 92 / 124 次提交；chat-session 在**冻结名单**上却 7/25 的 1099 行长到 2730（+148%）——冻结只阻止了拆，没阻止长 |
| 纸壳 | `PaperPanel.css` 6778 行 / 804 选择器 / 179 个主题段；`PaperPanel.tsx` 单组件体 1278 行；ComposerDock 61 个 hook 调用 | CSS 两个月 +91%（9/4 3541 → 6778）；一年 122 次提交，当天还在改 |

第三类（Rust 大文件：`lsp_manager.rs` / `query_adapter.rs` / `framework_routes` / `memory.rs` 等 29 个）
是**宽度型**（22 框架检测 / CSR 索引 / 平台沙箱），churn 极低（`memory.rs` 一年 2 次提交）——
**只登记不拆**，不占本线工期。

## 1. 为什么会有今天（三条根因）

1. **纪律只管「文件集」，不管「单文件多大」**：`ui/` 的「只减不增」= 13 个文件不少一个，
   没有一处会因为某个文件写到 3000 行而变红。
2. **目录级水线试过，撤了**：`privileged-zone-freeze.test.ts` 头注（2026-09-24）——多窗口并行施工时，
   别人的正当改动会把目录总量判红（实测立账 15 分钟后 +277 行）。**所以本线不做目录水线。**
3. **拆过又长回来**：`agent.ts` 9/15 收敛到 1905，六周回到 2486；`PaperPanel.tsx` 9/3 拆到 1172，
   六周回到 1739。**没有封顶的拆分只是一次性动作。**

## 2. 门禁口径（三条）

- **物理行数**（末尾换行不算一行），与 `plugin-home-ledger.test.ts` 同一把尺子；
- **未登记文件 ≤ 1000 行**——新文件要长成上帝文件，先拆或先登记；
- **已登记文件只减不增（ratchet），但登记值是「上限档」不是当前行数**——实测值向上取整
  到 100（2026-11-06 用户定调「DEBT 表可以调一下」：原版逐行卡死，日常改一行就红，
  噪音大于信号）。档内自由，**跨档**才需要同 commit 改数字并写一句为什么；
  降到 1000 行以下必须销账（文件不存在同理）。

登记表在 `src-ui/tests/god-file-budget.test.ts` 的 `DEBT`，46 条 = 三棵 src 树实测（P1/P2 拆完后的余账）。
扫描面 = `src-ui/src` + `engine/src` + `src-tauri/src`（不含 tests 与生成物）。

## 3. 批次

### P1 ✅ 已落地（2026-11-06）

**① 门禁**：`god-file-budget.test.ts`（见 §2）。

**② 第一刀：`ui/chat-session.ts` 2730 → 67 行公开面**，实现按文件里**既有的分区注释**拆到
`src-ui/src/app/chat/session/`（13 个模块，行数见下）。行为零变更：
公开面由 `ui/chat-session.ts` 原样再导出，**34 个调用方（5 源码 + 29 测试）零改动**——
测试 diff 为零是「行为零漂移」的最强证据。

| 模块 | 行 | 职责 |
|---|---|---|
| `session-types.ts` | 76 | ChatSession / SessionContext / 内部来文判据 |
| `session-registry.ts` | 149 | 面板级注册表访问器（句柄 / exec 账 / 轮次对 / 全量重置） |
| `session-titles.ts` | 125 | 卷名维护（首条来文派生 + 一次模型概括） |
| `session-crud.ts` | 458 | 会话 CRUD（切换 / 懒建句柄 / 关闭 / 新建） |
| `session-paths.ts` | 296 | 工作区会话根 + 卷快照形状 + 发号账 |
| `session-catalog.ts` | 404 | 卷目录投影 + 每卷写链 + 落盘结果账 |
| `session-volume-guard.ts` | 45 | 已删卷写拒绝名单（原 `_removedVolumes` 收成显式 API） |
| `session-save.ts` | 306 | 快照落盘 / 防抖自动存 / 改名即存 |
| `session-read.ts` | 175 | 卷读取（快照 / 清单 / 档号列表） |
| `session-restore.ts` | 401 | 单卷续开 / 批量恢复 / 真删 |
| `session-rebuild.ts` | 302 | 从 provider 会话重建 UI 消息与轮次对 |
| `session-retract.ts` | 131 | 轮次撤回（TurnIdBridge 对位） |
| `session-export.ts` | 79 | 对话导出 |

**拆法纪律**：只搬字节，不改逻辑（唯二改动是把 `_removedVolumes` 的裸 Set 收成
`isVolumeRemoved / markVolumeRemoved / unmarkVolumeRemoved`、把测试重置口收成
`resetIssueLedgersForTests / resetVolumeGuardForTests`——都是同义改名，行为不变）。
模块间存在少量 ESM 环（crud ↔ restore、catalog ↔ save），**只用到函数级**，
没有模块初始化期取值，运行时等价于原单文件。

### P2 ✅ 已落地（2026-11-06）：纸壳

**① 数值镜像——先验后动，结论是「大头早已收口」**：`type-tokens.ts`（2026-08-30）已经把
测量侧的字体/行距/chrome 常量收成单一真源，`measure.ts` 的 `CHROME_DERIVED` / `MD_TOKENS` /
`FOLIO_TOKENS` 全部从它派生，CSS 侧 72 处 `var(--pp-*)` 引用由 `paper-token-audit` 钉住
「无悬空键」。剩下的裸数字镜像只有一处——`RACK_H = 38`（composer-float.ts）↔
`.pp-rack { height: 38px }`，靠 `tests/composer-float` 的**字面量对拍**拦漂移（两把尺子互相
证明，不是单一真源）。本轮收口：真源搬进 `COMPOSER_TOKENS.rackH`，CSS 改读
`var(--pp-composer-rackH)`，测试从「38 == 38px」改为「两侧同读一颗 token，且 CSS 里不许
再出现这个数字」。

**② 分片**：`PaperPanel.css` 6778 → **38 行入口 + 12 个主题分片**（`@import` 顺序 = 原文件
行序 = 层叠序，禁重排）。每片仍是一个可命名的域，不再是「一个文件装整套纸面」：

| 分片 | 行 | 内容 |
|---|---|---|
| `paper-base.css` | 487 | 根 / 滚动条 / 顶部浮件 / 缩放 / 画布 / 呼吸线 / 流区 / 卷开合 / 桌垫 |
| `paper-folio.css` | 303 | 卷首（天头四行）+ 组合芯片 |
| `paper-block.css` | 715 | 块体基础 + 来文 + 正文 + 数学 |
| `paper-inline.css` | 684 | 折叠行 / 夹注 / 工具卡 / 脚注 / 工具组 / 程文 / 完成值 / 抄录 / 拟策 / 贴黄 |
| `paper-motion.css` | 302 | 让位豁免 / 流式生命感 / 引线 / 锚点 / 枝边 / 匣脚引线 |
| `paper-composer.css` | 731 | 附件行 / 拾遗 / 附图 rail / 创作坞 / 案头 / 书眉 / 读数 / 墨量册 |
| `paper-dock-jobs.css` | 363 | 役册（后台工作监视） |
| `paper-dock-tools.css` | 640 | 墨量线 / 钤印 / 翰律 / 引 / 界栏 / 历史眉批 / 停止钮 |
| `paper-ops.css` | 739 | 消息动作行 / 握把 / 抽纸条 / 划词 / 遮罩 / 宽度 / 缩远 / 眉批栏 / 四角 / 空卷题字 |
| `paper-toc.css` | 558 | 目次带 v4.1 + 骨架 + 阶段锚 |
| `paper-assets.css` | 717 | 资产块兜底 / 表现原语（grid / chart / metric / media） |
| `paper-cards.css` | 529 | graph / board / timeline / citation / chem + 回首页弹层 |

**拆法证据**：12 片正文拼回后与原文件 `git diff --no-index -U0` **只差 7 行**——全部是
本轮 `RACK_H` 收口涉及的注释与 `height` 一行（其余差异 = 分片文件末空行被 biome 规范化）。
入口 `@import` 序即层叠序，产物已验：`entry.css` 与 app bundle CSS 都是内联后的完整规则，
无残留 `@import`。

**③ 断言面**：17 份测试原本按路径 `readFileSync(PaperPanel.css)`——新增
`tests/helpers/panel-css.ts` 的 `readPanelCss()`（入口 + 按序展开分片）后逐个改读法：
**断言的对象仍是同一份样式字节**，只是从「一个文件」变成「这份样式」；`paper-token-audit`
的 `var(--pp-*)` 扫描面同步跟到分片。构建面已验：产物 `entry.css` 与 app bundle CSS 都是
内联后的完整规则（无残留 `@import`）。

**`PaperPanel.tsx` 单组件体**当时刻意留在下一批（它不属于「体量失守」而是「组件形态」，改动面在渲染路径上）——见 P3。

### P3 ✅ 已落地（2026-11-06）：PaperPanel.tsx

`1739 → 871 行`，拆成三件（只搬代码，不改逻辑）：

| 文件 | 行 | 内容 |
|---|---|---|
| `PaperPanel.tsx` | 871 | **视图**：两个 context Provider + 全部 JSX（唯一有 DOM 的一件） |
| `use-paper-panel.ts` | 703 | **装配根**：16 个 `use-*` 域的调用序、共享 ref 载体、拖拽渲染态、context 组装。**hook 调用序是挂载契约**（split-plan §3 的三对硬约束），本文件内禁重排 |
| `paper-panel-parts.tsx` | 379 | **表现件**：文类签映射 / ToolStatusChip / BlockView（单块渲染）/ folioSubLine / DeskShelf |

组件本体只剩 `const { …83 项 } = usePaperPanelAssembly(); return (…)`。三件合计 1953 行
（比原 1739 多 214 = 三份 imports + 头注 + 83 项解构/返回），**逻辑零改动**。

**断言面**：8 份测试原本按路径只读 `PaperPanel.tsx` 做源码级断言，新增
`tests/helpers/panel-source.ts` 的 `readPaperSources()`（同目录全量拼接，口径与
`paper-visual-decisions` 的既有聚合一致）后改读法——断言对象仍是这份源码，只是不再
假设它住在一个文件里。体量账同批销账（`PaperPanel.tsx` 降到 1000 以下，DEBT 删条目）。

### P5 ✅ 已落地（2026-11-12）：chat-core 从"有状态上帝类"退回"无状态门面"

**判据不是行数，是私有可变状态**：治理前 ChatCore 持有 8 个私有可变字段，其中 5 个是
别的域（目标 / 画布 / 流式 / 轮次身份）寄存在它身上的状态；治理后只剩构造期定型的
`_exec` + 注入的 `_goal`（驱动器实例，本身无跨域状态）+ `_syncTimers` / `_execListeners`。

| 刀 | 动作 | 结果 |
|---|---|---|
| ① | 删 3 个 DOM 桩 + `SessionContext` 里 13 个零消费者成员（`panel`/`sessionTabs`/`tabBar`/`flushReasoning`/`flushText`/`clearPendingToolCards`/`updateFooter`/`abort`/`getRunning`/`clearToolUsage`/`clearToolHistory`/`getLastUsageText`/`getLastAgentDiag`） | −69 行，无状态面消失 |
| ② | `sendMessage`（223 行）并入 `_runAgentTurn`：运行账 / 轮次代数 / 气泡 / catch 三分支 / finally 收尾守卫 / 续行排程各只剩一份 | −167 +72，双份脚手架归零 |
| ③ | goal 驱动器 9 个方法整件外移 `app/chat/goal-driver.ts`（`GoalDriver` + `GoalDriverHost` 能力位注入）；chat-core 只留 `goalCommand` / `refreshGoalView` 两个转发 | `goal-driver.ts` 369 行 |
| ④ | `restoreCanvasSpread`（163 行）+ `saveCanvasState` → `app/chat/canvas-restore.ts`；`builtinCommands` 71 行字面量表 → `app/commands/builtin-commands.ts` | 193 + 89 行 |
| ⑤ | `_turnGenBySid` 私有 Map → `session-registry` 的 `turnGenOf / bumpTurnGen`（跨面板实例共用一本，随 `resetSessionState` 归零） | 状态搬出 chat-core |

`2 273 → 1 529` 行，DEBT 档位由 2300 降到 1700。**测试 diff 形状**：`goal-driver.test.ts`
只改了取驱动器的入口（`panel._goal.scheduleGoalDrive`），断言一条未动；
`stop-turn-recovery.test.ts`（轮次代数守卫的考官）**零改动**继续绿。

**为什么 turnGen 不并进 exec 的 `runEpoch`**（本轮核查后的裁定，与事后直觉相反）：
`runEpoch` 数的是**全部**运行（含 goal/wake/compact），拿它判"有没有更新的**轮次**"会把
"后台唤醒起了一条运行"误判成"用户发了新消息"，于是本轮不 finalize、流式助手永久停在
streaming。两者语义边界不同，代数账保持独立、搬去注册表即可。

### P4 登记不拆（本线不动）

Rust 宽度型大文件（29 个）· 测试巨件（`tests/chat-session.test.ts` 2057 行——P1 拆完它没变，测试面这一批不动）
· `renderers/components.tsx` / `measure.ts` 这类「广度型」模块（10 个块类型 / 68 个测量导出）
——它们的大是覆盖面，不是职责混装；拆了只是把同一张表切成几份。

## 4. 判据

- `cd src-ui && npx vitest run`（含 `god-file-budget.test.ts`）
- `cd src-ui && npm run build` · `npx biome ci .`（0/0）
- `cd src-ui && npm run doc-check`
