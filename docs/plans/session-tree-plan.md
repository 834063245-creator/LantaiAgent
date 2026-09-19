# 会话树（枝）——从任意节点开枝

> 立项：2026-09-18（用户提「想做会话分支」；追问后裁定 **要的是会话树**——理由「画布式交互契合树状会话」）。
> 性质：**数据结构 + 交互新增**。app 层为主；**不动事件词表、不动 phase-5 投影契约**；头行加可选字段，旧卷照读。
> 状态：**P1 已落地（2026-09-18，施工记录见 §12）；P2-P4 未开工**——三项裁定已定（§9）。
> 结论一句话：**树做在卷之间——节点自包含（每枝一卷，前缀复制）、边落头行（`parent`）、画布当画布用
> （枝落成流区、边落成引线）；分叉点是流内任意**已落定节点**，删除按树的语义**连坐**整棵子树。**

## 0. 病灶：今天只有「销毁」，没有「分叉」

「改」「重发」两个按钮的实现是**破坏性撤回**：`editUserMessage` / `resendUserMessage`
（`src-ui/src/app/chat/chat-core.ts:1609-1637`）→ `retractUserMessage`
（`src-ui/src/ui/chat-session.ts:2080-2116`）→ `agent.retractTurnAt` → 追加 `session/retract` 事件
（`src-ui/src/agent/session-log.ts:337-343`）+ UI 消息同区间 splice。**原路在投影里被抹掉**，
用户想从某个节点换一条路走、并留档对比，没有任何办法。

但**历史其实还在**：`session/retract` 只记 `{fromIndex,toIndex}`，`project()` 是只读 fold
（`src-ui/src/agent/session-log.ts:305-359`），日志无压实、无删除 ⇒ **今天每一次「改 / 重发」都在
`.ndjson` 里留下一条没有出口的旧枝**，只是从没被读过。

⇒ 缺的不是历史，是**边**：谁能从哪个节点继续长。

枝**不是「改」的替代品**：改 = 原地重写（破坏性，历史留在日志里但不可达）；枝 = 从任意节点另起一条
（非破坏性，两条路都在场）。两者共存。

## 1. 定案（三条腿）

| 腿 | 形态 | 为什么这么定 |
|---|---|---|
| **节点** = 卷 | 每枝一卷，卷本体 = 父卷前缀的**复制** + 自己的后续事件 | 自包含 ⇒ **读侧独立**（父卷被外部删/拷走，子卷照常打开；崩溃局部化）；卷枚举/发号/剪枝/导出**零改动** |
| **边** = 头行 | `SessionLogHeader` 加 `parent?: {id, atSeq}`（write-once） | 边在 app 层，**不进 phase-5 快照** ⇒ 零 BCR（见 §1.1） |
| **面** = 画布 | 枝落成流区、边落成朱砂引线、切枝 = 切卷 | 画布本就是「一纸多卷」；引线那支笔在出处引导那批已做完 |

### 1.1 为什么不做「卷内树」（一份日志多枝、投影按枝遍历）

| | 卷内树 | **枝即卷（本方案）** |
|---|---|---|
| 要动 | `SESSION_EVENT_KINDS` 冻结集、`project()` 线性 fold → 树遍历、`deriveMessages` 逐字节等价、phase-5 契约快照重录（`src-ui/tests/convergence/specs/phase-5.test.ts:1-13`）⇒ **BCR 级** | 头行一个可选字段 ⇒ 门禁面照常 |
| 深坑 | `derivePayload` 的工具结果折叠边界 `_toolFoldBoundary` 是**运行时累积态**，文件头自述「重算只能得到无状态近似，与累积值在 retract / 替换后会分叉」（`src-ui/src/agent/session-log.ts:16-20`）——**它在树上没有良定义** | 每卷仍是线性日志，投影一行不改 |
| 节点载体 | 一卷内多枝 | 每枝一卷（git 同构：树是引用关系，不是文件格式） |

DSH 的 fork 是同一族做法（`packages/core/session/src/index.ts:1236-1251`：`seed = 前缀事件` +
`inheritedEventCount` + 头行 `parentSession`，子会话物化自己的产物）——兰台照此，但选**复制前缀**
而非引用父卷前缀（读侧不跨文件拼接）。

### 1.2 「枝即卷」不是妥协

- **切枝就是切卷**：现有 `switchSession` / 摊开 / 收起 / 改名 / 删除 / 导出全部照旧
  （`src-ui/src/ui/chat-session.ts:277-315`）——树不需要发明「路径游标」这类新状态。
- **读侧独立 vs 删除连坐是两件事**（正交，别混）：自包含买的是「读不依赖父卷在场」；
  而**删除**按树的语义走——删父卷**连坐**整棵子树（用户裁定，见 §9）。级联删除不会因为内容是复制来的
  而变得可有可无：那 N 份前缀副本本来就是一体的。
- **画布是本色**：`{ws}/.lantai/canvas.json` 已经管着摊开集 / 流区 / 钉 / 纸条；树的空间布局属于画布态，
  不是新存储。

### 1.3 父边归一化（连坐的正确性前提）

在**继承区**内立枝时，「父 = 当前卷」会画出错的边：

> B 从 A 的 `seq 50` 分出（B.parent = `A@50`，B 自己的区域是 `51..`）；随后 C 从 B 的 `seq 30` 分出——
> 30 落在 B 的**继承区**里，那份内容其实来自 A。此时 C 的边若记成 B，树会把 C 挂在 B 的分叉点下游
> （画错），而**级联删除会删错子树**。

**规则**：边归到「**自己的区域覆盖 cut 的那个卷**」——从直接来源卷起沿 `parent` 上溯，直到
`cut > 该卷.parent.atSeq`（无 parent 的卷即根）；`cut == parent.atSeq` 视为全部继承，继续上溯。
立枝时算一次即定（不落冗余字段）；删除时按**同一规则**重建图，不能只信 `_index.json` 里的直接父指针。

## 2. 形态（磁盘 / 内存 / 清单）

1. **头行**：`SessionLogHeader`（`src-ui/src/app/chat/session-log-store.ts:38-45`）加
   `parent?: {id: number; atSeq: number}`。`atSeq` = 继承到的最后一个事件 seq（= 前缀长度）。
   **version 保持 1**：可选字段是加法而非格式断裂；升 version 会让现有**全部**卷被定向拒读
   （`session-log-store.ts:146-153` 的版本硬判），代价与收益不成比例。旧卷无此字段 = 无父（天然合法）。
2. **枝卷的诞生 = 现有开卷序列换个前缀来源**：工厂前先登记 preset（继承父卷 `resolveSessionPreset()`，
   newest-wins）→ `restoreInPlace(父卷前缀)`（`session-log.ts:269-274`）→ `adoptSessionLog(当前系统提示)`
   → `attachSessionLogStore(materialize)` 首批把「头行 + 前缀事件」原子写盘
   （`session-log-store.ts:267-284`）。**读路径一行不改**（日志优先的 `loadSessionFromDisk` 照吃）。
3. **清单行**：`SavedSessionRow`（`chat-session.ts:846-852`）加 `parentId?: number`；
   `CATALOG_VERSION` 1 → 2（版本不认即重建，机制现成——`chat-session.ts:854-861`）。
4. **id**：每工作区单调整数，枝卷占新号（`chat-session.ts:577-578`）；父子在磁盘上是**平级文件**，
   不是目录嵌套 ⇒ 卷集/发号/对账零改动。
5. **组合**：枝卷继承父卷组合——这既是省事也是**省钱**（前缀事件逐字节同源 ⇒ 提供方前缀缓存命中）。
   注意：枝卷**出生即带历史**，按现有判据它不再是空白卷 ⇒ 组合芯片是只读档
   （`isSessionBlank` 同一把尺子，`src-ui/src/app/chat/session-composition.ts:69-73`）——
   **出生那一刻的组合即终局**，集成时以实测为准。

## 3. 分叉点判据（节点即事实）

1. **可分支节点 = 流内任意"已落定"的节点**：用户消息 / 助手文本 / 工具调用卡片 / 工具结果 /
   子代理卡片 / 计划卡……（节点粒度见 §4）。
2. **枝包含该节点**：`cutSeq` = 「该节点所属批次全部落定之后」的事件 seq，前缀 = `seq ≤ cutSeq`。
   **不存在「保留之前 / 含这一轮」这种选择**（用户 2026-09-18 裁定：分支不绑定用户侧输入，
   也没有「重写这一轮」的概念）——从节点开枝就是从那个节点往下长。
3. **合法性判据（provider 转写）**：前缀里**每个已宣布的 `tool_call` 都必须有配对结果**。
   批次未落定（正在跑 / 崩溃残留）⇒ 该节点**置灰 + 具名原因**，与 `canRetraceUserTurn`
   （`chat-session.ts:2072-2074`）同一纪律：绝不猜、绝不半切。
   **刻意不采用「悄悄向前归一」**：那会让用户从「第 1 个工具结果」开枝却拿到含第 2/3 个结果的枝（静默改语义）。
   第二道兜底 = `interruptedToolCallClosers`（开卷路径已在用，`session-log-store.ts:397-405`）——
   它兜的是**恢复**，不是分叉。
4. **切点必须已落盘**：`flushSessionLog(父卷)` 先行（写后队列 200ms 窗口，
   `session-log-store.ts:89`），再读盘取前缀。父卷正在跑 ⇒ 只能选已落定节点（第 3 条天然覆盖）。
5. **一键形态**：从**卷尾**立枝 = `cutSeq` 取 flush 后的 `lastSeq`（P1 的入口，UI 不必先有节点选择器）。

## 4. 锚点（节点 → 事件 seq）

- **今天不能用的**：`m1/m2` 是内存发号器产物、重启重铸（`src-ui/src/state/session-store.ts:77-83`）；
  `TurnIdBridge`（uiMsgId → provider 下标）是纯运行时态（`src-ui/src/agent/agent-session-state.ts:33-45`）。
  唯一磁盘稳定的「历史点指针」= `SessionEvent.seq`。
- **节点粒度与它的硬边界**：节点 = **投影消息**（含工具调用卡片 / 工具结果 / 子代理卡片这些各自成事件的块）。
  **同一 assistant 消息内部的文本 / 推理块之间不可切**——`assistant/text` 事件把
  content + reasoning + tool_calls 记为**一个**原子事件（`src-ui/src/agent/session-log.ts:80-81`）；
  工具调用批次内部同样不可切（§3.3）。要突破这条 = 把 assistant 消息拆成多个事件 = 事件词表 +
  投影语义改动 ⇒ BCR，本线不做（§6）。
- **增量** = 在**同一个 fold** 里顺手记「每条投影消息来自哪个事件 seq」（`project()` 是唯一 fold，
  另起一份重算就是同类双源），对外只新增只读派生（如 `deriveMessageAnchors()`）。
  **不新增事件 kind、不改投影语义** ⇒ 不需要 BCR；但该文件在 `src-ui/src/agent/**` 面内
  ⇒ 动手那批必过 `npm run verify:convergence` 双轨。
  **实现随 P2 落地**（P1 刻意不做）：锚点今天没有消费者（P1 入口只有「从卷尾立枝」），
  先埋一个零消费者的派生面 = 本仓明令的死抽象（先例：`BootGateService.assertBootOk` 零消费者在册为债）。
- **节点 → 投影下标** = 复用现有尾对齐纪律（含 `isInternalMessage` 过滤 + 内容确认 + 失配即止，
  `chat-session.ts:2039-2051`）——**绝不按内容搜索下刀**；解析不出 ⇒ 该节点置灰
  （与 `canRetraceUserTurn` 同一把尺子）。
- **别按「第 k 条 `user/message` 事件」硬数**：该 kind 不只用户输入（还有安全边界插入 / inbox / goal 提示），
  上面那把尺子已在过滤它，新代码必须复用同一把。

## 5. 画布形态（本功能的「面」）

- **枝的落位**：立枝 = 摊开一卷（现有 `expand` / `place`），默认落父卷右侧 +16；自动落位只在「刚立枝」
  这一次生效，其后随用户摆（画布是用户的，不是布局器的）。
- **边的表达**：从枝卷卷首拉一丝**朱砂引线**到父卷的**那个节点**（不是「父卷」这个整体）——
  直接复用出处引导那一支笔（屏幕坐标 / 恒定墨宽 / 定种子相位 / 起笔留白收笔朱点；
  判例见 `docs/plans/pin-provenance-plan.md` §1.1）。**不要新造一种线**：一屏一语言。
- **入口**（节点级，不是"轮"级）：流内任意节点的 hover 动作加「立枝」（现在那里的动作是「改」「重发」等，
  `chat-core.ts:1609-1637`）；侧栏「＋ 另起一卷」旁加「＋ 立枝」（= 从卷尾）。
- **导航**：侧栏树形（`src-ui/src/plugins/builtin/canvas-nav/session-sidebar-model.ts` 的
  `mergeSessionRows` / `splitSections` 加父子段）；书脊与卷首标「枝」。
- **默认只摊开活跃路径**：其它枝收起为签条/小卡（防「一纸十几卷」）。
- **空间动作**（本线的画布契合点）：从某个节点**拖出一条引线落到纸上** = 立枝。放最后一版
  （手势与落位判据要单独设计，不与数据面同批）。

## 6. 刻意不做

- **世界不分叉**（最重要的一条）：枝卷继承的是**对话与上下文**，不继承磁盘 / git / 外部副作用。
  画布上并列的两枝**共享同一个工作区**——这是本功能最容易被误读的地方，UI 必须显式（卷首或引线旁标注），
  否则用户会以为「回到过去重来一遍」而两次真实地改了同一份文件。
  真要做世界分支是另一个数量级（`agent_spawn` 的 worktree 隔离是**每子 Agent 的临时隔离**，
  `src-ui/src/agent/subagent-spawn.ts:127-148`，是参照物不是实现路径）。
- **块级切分**（同一 assistant 消息内文本/推理块之间开枝）：要拆事件 ⇒ BCR，留台阶不封死（见 §4）。
- **卷内树**：留台阶但不封死——「同一卷内两枝并排对比阅读」若真需要，那是多面板并排（S7 搁置件）的正交问题。
- **旧枝考古**（把今天已躺在日志里的旧枝读出来挂上树）：诱人，但只能得到**只读展品**——
  `session/reset` 的整段替换（init / restore / goal）没有父指针，只能按内容对齐 ⇒ 列 P4 可选，不进主线。
- 枝的自动命名 / 自动摘要、枝的合并（把两枝并回一卷）、枝的跨工作区迁移：不做。

## 7. 批次（每批独立可交付、可验收）

| 批 | 范围 | 验收判据 |
|---|---|---|
| **P1 数据原语** | ✅ **已落地**：头行 `parent` + 父边归一化（§1.3）+ `createBranchVolume(fromId, atSeq?)` + 「从卷尾立枝」入口（侧栏 ＋ 立枝） | ① 新卷 `.ndjson` 头行带 parent，事件 = 父卷前缀 + adopt；② 打开它，内容与父卷切点一致；③ **父卷文件字节零变化**；④ 重启后血缘仍在；⑤ 继承区内立枝 → 边归到上层卷（§1.3 用例）——逐条见 §12 |
| **P2 树面与连坐** | **节点锚点派生**（§4，P1 刻意不预埋）+ 清单行 `parentId` + `CATALOG_VERSION` bump + 侧栏树形 + 卷首/书脊标「枝」 + **从任意已落定节点立枝** + **删除连坐** | ① 任意已落定节点可立枝，枝含该节点；② 未落定节点置灰且原因可读；③ 删父卷连坐整棵子树（**含在继承区立枝的孙卷**——按归一化后的边）；④ 子树里任一卷在运行 ⇒ 整体拒绝并列出；⑤ 中断重入后不留孤儿（§8 后序删除） |
| **P3 画布承接** | 枝卷落位 + 引线连回**父卷的那个节点** + 溯源（点引线飞回该节点） | ① 立枝即在纸上可见、引线指得对；② 父节点不在视口内时引线仍出屏（出处引导同款判据） |
| **P4（可选）** | 空间手势立枝 / 旧枝考古 | 单独立项时定 |

门禁（每批）：`cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`。
P1 **未动** `src-ui/src/agent/**`（锚点派生已挪 P2）⇒ 不需要 `verify:convergence`；
P2 动 `session-log.ts` 的 fold 时那一道必须补上。

## 8. 风险与本仓已有的坑

| 风险 | 处置 |
|---|---|
| **token 账本被双计** | 账本的 `turns` 是**累计账不是投影**（`src-ui/src/agent/token-meter/types.ts:69-87`），复制即同一笔钱记两次，违反「四桶加总恒等于提供方 `prompt_tokens`」⇒ **枝卷账本从 0 起**，上下文占用是投影、自动重算 |
| **级联删除的原子性** | ① **后序遍历删（先子后父）**：任何中断点剩下的都还是合法的森林，**永不产生孤儿**（父先删则一次失败就留下一片无父卷，正是要防的事）；② 删除是低频道动作 ⇒ 删除前按**磁盘真源**（目录枚举 + 逐卷头行）重建一次血缘图，不只信 `_index.json`；③ 部分失败**可见**（逐卷报，不静默） |
| **磁盘成本** | 前缀是复制不是引用 ⇒ 长卷立枝 = 再写一份前缀；日志压实本就缺（见 `docs/plans/session-persistence-dsh-port-plan.md` §三留的口子 2），立枝会放大。缓解：切点即深度旋钮（从卷尾立枝时可只带最近 N 轮） |
| **卷数膨胀** | 侧栏清点已换成持久化投影清单 `_index.json`（`chat-session.ts:818-861`），枝卷走同一条路；画布默认只摊开活跃路径；未摊开的枝无句柄（懒创建已是现状） |
| **血缘悬空** | 应用内删除必连坐（§9），所以悬空只可能在**外部**删除/拷走时出现 ⇒ 侧栏显示「父卷已删」，不阻塞打开 |
| **误读为「世界回滚」** | 见 §6 第一条：UI 显式标注「同一工作区」 |

## 9. 已拍板（2026-09-18，用户）

| 项 | 裁定 | 落地后果 |
|---|---|---|
| **删父卷是否连坐** | **连坐**——删父卷即删整棵子树。理由（用户原话的意思）：现在各种软件的会话分支**真的会导致无父会话堆积**，分不清哪个会话从哪来 | §1.3 边归一化成为前提（否则删错子树）；删除确认显示「将同时删除 N 枝」；`SessionSidebar` 的两击确认与「运行中拒绝」扩到**整棵子树**；删除走 §8 的后序删除 |
| **分叉点语义** | **从任意节点开枝，含该节点**；分支不绑定用户侧输入，**不存在「重写这一轮」** | §3 节点判据 + §4 节点锚点；原文「保留之前 / 含该回合」选择题作废；入口从「消息行」扩到「流内任意节点」 |
| **枝的 UI 词** | **「枝」** | 代码词 `branch` / `parent`；文案「立枝」「这一枝」「父卷已删」 |

本线当前**无待拍板项**（新的分岔出现时按 CONVENTIONS §0.5 单条上交）。

## 10. 测试面

- **新增**：`tests/session-branch.test.ts`（立枝 / 头行血缘 / 前缀一致 / 父卷零改写 / 开卷续写 /
  继承区内立枝的边归一化 / 删父连坐子树 / 后序删除中断重入后零孤儿）；
  `tests/session-anchors.test.ts`（节点锚点派生：含内部 user 消息、工具批次、retract、compaction）；
  `tests/session-sidebar-tree.test.tsx`（树形、未落定节点置灰、连坐确认文案）。
- **会被打红（同批改写/新增）**：`tests/chat-session.test.ts`（`_index.json` 版本与行形状、
  `deleteSessionFile` 真删断言）；夹具 `tests/helpers/session-files.ts` 及其 7 个消费者（头行夹具加字段）。
- **契约面**：不新增事件 kind ⇒ **不需要 baseline-change-request**；若实现中发现非加 kind 不可，
  按 `docs/archive/agent-core-convergence/baseline-change-request.md` 走审批，本计划即升级为 BCR 件。

## 11. 开工先读（证据指针）

| 要动/要懂 | 先读 |
|---|---|
| 卷本体与投影契约 | `src-ui/src/agent/session-log.ts`（kind 集 / seq 规约 / `project()` / `restoreInPlace`） |
| 落盘面（头行 / 物化 / 修复 / 版本拒读） | `src-ui/src/app/chat/session-log-store.ts` |
| 卷生命周期（建 / 开 / 切 / 合 / 删 / 存） | `src-ui/src/ui/chat-session.ts` |
| 每卷一份的运行时态 | `src-ui/src/agent/agent-session-state.ts` |
| 侧栏与树形落点 | `src-ui/src/plugins/builtin/canvas-nav/`（`SessionSidebar.tsx` + `session-sidebar-model.ts`） |
| 引线判例（画布那条腿） | `docs/plans/pin-provenance-plan.md` §1.1 |
| DSH 参照（fork 语义与边界） | `packages/core/session/src/index.ts` 的 `fork` / `_forkSeed`（外部仓 `D:\useful\deepseek-harness`） |

## 12. P1 施工记录（2026-09-18）

**落点**（app 层为主；**未碰冻结文件** `ui/chat-session.ts`、**未动** `src/agent/**`）：

| 件 | 内容 |
|---|---|
| `src-ui/src/app/chat/session-log-store.ts` | 头行加 `parent?: {id, atSeq}` + 形状判据 `isSessionLogParentRef`；`parseHeader` 毒化容忍（脏血缘当根卷，不把整卷判损坏） |
| `src-ui/src/app/chat/session-branch.ts`（新） | `resolveBranchOrigin`（§1.3 归一化）+ `createBranchVolume`（校验 → 发号 → 原子写盘 → 交给既有开卷路径摊开） |
| `src-ui/src/app/chat/chat-core.ts` | `branchFromTail(sessionId?)` 编排入口 |
| `canvas-nav/SessionSidebar.tsx` + `session-sidebar.css` | 「＋ 立枝」常驻次动作（ghost 档——本屏唯一主动作仍是「另起一卷」，浸墨法则 1②） |
| `tests/session-branch.test.ts`（新，10 例） | 六条判据（含「枝卷在侧栏清单可见」——清单投影 + 缺行补建那条路）+ 四条拒态 |
| `tests/session-sidebar-ux.test.tsx` | 立枝入口在册 + 点击落到 `core.branchFromTail` |
| `tests/helpers/session-files.ts` | 夹具 `logText` 加可选 `parent`（7 个消费者的兼容加法） |

**验收判据的状态**（全部有测试钉住）：

1. 头行带 parent + 事件 = 父卷前缀**字节同源**（`expect(枝事件行).toEqual(父事件行)`）；
   开卷后多一条 `session/reset{adopt}`（真 Agent 装配用例断言四种 kind 序）。
2. 内容与切点一致（UI 消息面 + 真句柄 `getSession()` 面双断言）。
3. **父卷字节零变化**（立枝前后整份文件字符串比对）。
4. 血缘在盘上：清面板态后重开，血缘与内容都在（头行 write-once）。
5. 归一化：继承区内归上层卷、正好等于边界继续上溯、自己区域内归本卷、根卷归自己、缺卷返回 null。

**拒态零副作用**（一个字节都不落）：未落定（悬空 `tool_call`）/ 断尾坏行 / 空卷 / 源卷不存在——
四条各断了「新卷文件不存在 + 案头未变」。

**两处实现判据的裁定**（留痕，防回漂）：

- **组合继承取「事件优先、头行兜底」**：`resolveSessionPreset()`（S4-1b 首事件方案，newest-wins）优先，
  无该 kind 的旧卷退回头行出生记录——与开卷路径同判据族（`readVolumeData` 的 `cache?.presetId ?? header.presetId`），
  但**不读那份 MB 级的投影缓存**（立枝只为一个字段不值当）。
- **断尾/坏行的父卷拒绝立枝**：认领到的前缀虽安全，但父卷文件带垃圾 ⇒ 立出来的枝与父卷**字节不同源**
  （父卷下次打开还会被截断修复，两卷会悄悄分叉）。宁缺毋滥——先让恢复链修好。

