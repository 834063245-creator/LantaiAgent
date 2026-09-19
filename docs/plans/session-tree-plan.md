# 会话树（枝）——从任意节点开枝

> 立项：2026-09-18（用户提「想做会话分支」；追问后裁定 **要的是会话树**——理由「画布式交互契合树状会话」）。
> 性质：**数据结构 + 交互新增**。app 层为主；**不动事件词表、不动 phase-5 投影契约**；头行加可选字段，旧卷照读。
> 状态：**P1 + P1′ + P0 修 + P2 + P3 已落地（2026-09-18，施工记录见 §12）；P4（可选）未开工**——三项裁定已定（§9）。
> 入口 = **消息动作行**（与「改 / 重发 / 抄」同行；用户两次纠偏后定案，见 §5 与 §12.2）。
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
- **入口 = 消息自己的动作行**（2026-09-18 用户两次纠偏后定案）：块 hover 出现的
  「改 / 重发 / 抄」那一行加「立枝」——**主流 agent 软件的分支入口都挂在消息身上**
  （每条回复/来文的动作里），不在会话列表、不在标题栏、不在卷首。来文块与回复块都给。
  **落地前先犯过两次错**（侧栏「＋ 另起一卷」旁、卷首组合芯片旁）——两次都是位置错，
  记在 §12 以防回漂；守护 = `tests/paper-block-branch-op.test.tsx`。
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
| **P1 数据原语** | ✅ **已落地**：头行 `parent` + 父边归一化（§1.3）+ `createBranchVolume(fromId, atSeq?)` | ① 新卷 `.ndjson` 头行带 parent，事件 = 父卷前缀 + adopt；② 打开它，内容与父卷切点一致；③ **父卷文件字节零变化**；④ 重启后血缘仍在；⑤ 继承区内立枝 → 边归到上层卷（§1.3 用例）——逐条见 §12.1 |
| **P1′ 节点定位与入口** | ✅ **已落地**：投影锚点（`deriveMessageAnchors`）+ `resolveBranchPoint` + **消息动作行的「立枝」**（`use-block-ops`） | ① 来文块切点 = 该来文 seq、回复块切点 = 本轮末尾；② 未落定/句柄缺席 ⇒ 具名拒绝；③ 中段切点立枝只到该节点为止；④ 入口位置守护（`[改,重发,抄,立枝]` / `[抄,立枝]`）——见 §12.2 |
| **P0 修（用户报）** | ✅ **已落地**：立枝路径绕过空间权威入口 ⇒ 新卷进了案头却不飞（落点可能在视口外，用户视角 =「没摊开」）。修 = 调用层唯一一处 `activeSpace()?.expand(String(sid))` | 点「立枝」⇒ 新枝卷在纸上可见**且视角飞到它**；父卷字节零变化；连点两次不产生悬空定位请求——见 §12.3 |
| **P2 树面与连坐** | ✅ **已落地**：清单行 `parentId` + `CATALOG_VERSION` 2 + 侧栏树形 + 书脊标「枝」 + 未落定节点**置灰** + **删除连坐** | ① 未落定节点置灰且原因可读；② 删父卷连坐整棵子树（**含在继承区立枝的孙卷**——按归一化后的边）；③ 子树里任一卷在运行 ⇒ 整体拒绝并列出；④ 中断重入后不留孤儿（§8 后序删除）——见 §12.4 |
| **P3 画布承接** | ✅ **已落地**：枝卷落位（P0 修后即有）+ 卷首→父卷那个节点的**朱砂引线**（复用出处引导那一支笔）+ 点引线溯源 | ① 立枝即在纸上可见、引线指得对；② 父节点不在视口内时引线仍出屏（出处引导同款判据）——见 §12.5 |
| **P4（可选）** | ⏳ **未开工**：空间手势立枝 / 旧枝考古 / 轮内插入处不截断（整轮末尾的精确判据） | 单独立项时定 |

门禁（每批）：`cd src-ui && npm run build` + `npx vitest run` + `npx biome ci .`。
P1′ 动了 `src-ui/src/agent/session-log.ts`（fold 加锚点）⇒ 已过 `npm run verify:convergence` **双轨零漂移**；
P2/P3 未动 `agent/**` 与 `composition/**`（只新增 import），仍逐批跑双轨确认零漂移。

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

## 12. 施工记录（2026-09-18）

### 12.1 数据原语（P1，commit `6cd80395`）

**落点**（app 层为主；**未碰冻结文件** `ui/chat-session.ts`、**未动** `src/agent/**`）：

| 件 | 内容 |
|---|---|
| `src-ui/src/app/chat/session-log-store.ts` | 头行加 `parent?: {id, atSeq}` + 形状判据 `isSessionLogParentRef`；`parseHeader` 毒化容忍（脏血缘当根卷，不把整卷判损坏） |
| `src-ui/src/app/chat/session-branch.ts`（新） | `resolveBranchOrigin`（§1.3 归一化）+ `createBranchVolume`（校验 → 发号 → 原子写盘 → 交给既有开卷路径摊开） |
| `tests/session-branch.test.ts`（新） | 验收判据 + 拒态 |
| `tests/helpers/session-files.ts` | 夹具 `logText` 加可选 `parent`（7 个消费者的兼容加法） |

**验收判据的状态**（全部有测试钉住）：

1. 头行带 parent + 事件 = 父卷前缀**字节同源**（`expect(枝事件行).toEqual(父事件行)`）；
   开卷后多一条 `session/reset{adopt}`（真 Agent 装配用例断言四种 kind 序）。
2. 内容与切点一致（UI 消息面 + 真句柄 `getSession()` 面双断言）。
3. **父卷字节零变化**（立枝前后整份文件字符串比对）。
4. 血缘在盘上：清面板态后重开，血缘与内容都在（头行 write-once）。
5. 归一化：继承区内归上层卷、正好等于边界继续上溯、自己区域内归本卷、根卷归自己、缺卷返回 null。

**拒态零副作用**（一个字节都不落）：未落定（悬空 `tool_call`）/ 断尾坏行 / 空卷 / 源卷不存在。

**两处实现判据的裁定**（留痕，防回漂）：

- **组合继承取「事件优先、头行兜底」**：`resolveSessionPreset()`（S4-1b 首事件方案，newest-wins）优先，
  无该 kind 的旧卷退回头行出生记录——与开卷路径同判据族（`readVolumeData` 的 `cache?.presetId ?? header.presetId`），
  但**不读那份 MB 级的投影缓存**（立枝只为一个字段不值当）。
- **断尾/坏行的父卷拒绝立枝**：认领到的前缀虽安全，但父卷文件带垃圾 ⇒ 立出来的枝与父卷**字节不同源**
  （父卷下次打开还会被截断修复，两卷会悄悄分叉）。宁缺毋滥——先让恢复链修好。

### 12.2 入口纠偏 + 节点定位（P1′，本批）

**用户两次纠偏**（都是位置错，记此防回漂）：

| 错法 | 为什么错 |
|---|---|
| 放进侧栏「＋ 另起一卷」旁 | 侧栏**默认不展开**（纸开只起书脊态）⇒ 唯一入口默认不可见；且侧栏是**卷集管理**，立枝是**对本卷**的动作，语义层级不对 |
| 放进卷首组合芯片旁（拟） | 同上第二半：卷首是「本卷身份」（组合/卷名/日期），不是「对话动作」；**分支按钮的行业位置是消息自己的动作行** |

**定案落点 = 消息动作行**（与「改 / 重发 / 抄」同一行，`use-block-ops.ts`）——来文块与回复块都给。

| 件 | 内容 |
|---|---|
| `src-ui/src/agent/session-log.ts` | `project()` 产出**投影锚点**（每条消息的来源事件 seq，与 messages 同长同序）+ 只读派生 `deriveMessageAnchors()`；三条变异路径（push / reset / adopt / retract）与 messages **同步推进** |
| `src-ui/src/app/chat/session-branch.ts` | `resolveBranchPoint(storeId, sid, node)`——节点 → 切点（纯同步零 I/O）：UI `_id` →（`canRetraceUserTurn` 触发的尾对齐）→ 投影下标 →（锚点）→ 事件 seq →（`danglingToolCalls`）→ 落定校验 |
| `src-ui/src/app/chat/chat-core.ts` | `branchFromMessage(msg, sessionId)`（`branchFromTail` 随侧栏入口一并删除——零消费者不留） |
| `paper-shell/use-block-ops.ts` | 动作行加「立枝」（`key:'branch'`）；渲染期**不置灰**（判定是 O(消息数)，逐块跑会拖帧）——不可立枝的原因由点击后的具名 toast 兜住 |
| `canvas-nav/SessionSidebar.tsx` + `session-sidebar.css` + `tests/session-sidebar-ux.test.tsx` | 侧栏那套**整段撤回**（含 CSS 与测试，不留兼容残迹） |
| `tests/session-log.test.ts` | 锚点四条：同长同序 / retract 同步 splice / adopt 换头保尾 / 整段 reset 全归该事件 |
| `tests/session-branch.test.ts` | 节点定位四条：来文块锚点 / 回复块落本轮末尾 / 未落定具名拒绝（同卷来文块仍可立枝）/ 句柄缺席具名拒绝；另加**中段切点**（枝只到该来文为止、父卷零变化） |
| `tests/paper-block-branch-op.test.tsx`（新） | **入口位置守护**：来文块 ops = `[改, 重发, 抄, 立枝]`、回复块 = `[抄, 立枝]`，点击落到 `core.branchFromMessage(本块, 本卷)` |

**语义边界（诚实）**：回复块的切点走「本轮最后一个已落定节点」，停止条件 = 下一条 `user` 消息——
轮内插入的内部来文（`<system-reminder>` 等）会让行走停下，枝止于该插入之前（仍是**合法且可复现**的
前缀）。精确到「整轮末尾」需 P2 的节点选择器，此处不猜。

**门禁**：动 `src/agent/session-log.ts` ⇒ `npm run verify:convergence` **双轨零漂移**（锚点是新增读面，
投影与载荷字节未变）；vitest 全量 + tsc + vite build + biome ci + doc-check/doc-sync 见提交信息。

### 12.3 P0 修：立枝后视角飞到新枝（用户报，commit `16138a65`）

**现象**：点「立枝」→ 新枝卷建出来了，但**没摊到纸上、视角也没飞过去**。

**判性质（先复现后修）**：立枝后新卷**在案头**（既有用例 ② 钉住 `sessions = [2]`、`activeIdx` 指向它）
⇒ 缺的是**定位**，不是读盘。机理：立枝路径绕过了空间权威入口 `composition/space-service.expand`
（「摊开 + 定位」的单一权威入口，注释原文：调用方不得再自己补 `requestFocus`）；新卷落位由
`paper-shell/use-region-placement` 的 effect 用 `nearestFreeRegion` 补（相对视口中心的**最近空位**，
落点可能在视口外），**没有 requestFocus 就不会飞** ⇒ 用户视角就是「没摊开」。

**修法**（沿用 landmine-map #28 的收口形态，与侧栏行点击 / 案头签条架 / PaperPanel 同款）：
`createBranchVolume` 成功后，由**调用层唯一一处** `chat-core.branchFromMessage` 调
`activeSpace()?.expand(String(sid))`——已摊开卷走 `focus + requestFocus`（飞行），未摊开卷走
「读盘成功才飞」。**不在别处再补 requestFocus**：失败路径照样发请求 = 永不兑现的悬空定位。

**测试**（`tests/session-branch.test.ts` 新增一组，走生产装配面：真 ChatCore + 真 SpaceService）：
① 立枝成功 ⇒ `expand(新卷)` 恰好一次 + `pendingFocusId` = 新卷号（指向真实在案的卷）+ 父卷字节零变化；
连点两次 ⇒ 各飞各的（旧请求被新请求取代）；② 未落定 ⇒ 拒绝时 expand 一次都不调、pending 保持 null。

### 12.4 P2 树面与连坐（commit `c78b8c98`）

| 件 | 内容 |
|---|---|
| `ui/chat-session.ts` | `SavedSessionRow.parentId`（真源 = 卷日志头行）+ `CATALOG_VERSION` **1→2**（不认版本即整份重建，血缘一次到位）；`listVolumeIds` 导出（目录枚举 = 卷集真源，`listSavedSessions` 改走它）；`deleteSessionFile` 返回 `SessionDeleteResult`（失败带原因） |
| `app/chat/session-branch.ts` | `loadBranchLineage`（目录枚举 + 逐卷头行 + 边归一化，**复用 `resolveBranchOrigin` 同一条规则**）+ `branchSubtree`（后序）+ `planBranchDelete` / `deleteBranchSubtrees`（单卷真删由调用层注入——app 层不持有 `SessionContext`） |
| `canvas-nav/session-sidebar-model.ts` | `treeRows` 纯函数（DFS 父子段 / `depth` / `orphan` / 环守卫**绝不吞行**）+ `mergeSessionRows` 带血缘 + `sessionMeta` 出「父卷已删」 |
| `canvas-nav/SessionSidebar.tsx` + `SpineRack.tsx` + 两个 css | 行缩进 + 「枝」标（侧栏与书脊）；删除改走连坐面（一击按真源核对血缘 + 报数，再击连坐删除；批量同款） |
| `paper-shell/use-block-ops.ts` | 「立枝」吃**每卷一趟**派生的判据表（`core.branchPoints`）——未落定即置灰，title = 具名原因；判据并入 ops 缓存戳（跑完即刷新） |
| `plugins/builtin/sessions-builtin` | `delete_log` 的**日志删除失败改为上抛**（原 `.catch(() => '')`）——吞掉就是「报成功而卷还在」 |

**清单血缘的单一真源纪律**（本批的架构裁定）：`upsertCatalogRow` 改为「**只更已建行、不新建**」——
快照写面不知道血缘（它在 `.ndjson` 头行里），若由写面建行，那行会永远缺 `parentId` ⇒ 树上的边静默丢失。
新建一律留给补建（读头行），由此得到不变式：**凡在场之行，血缘必已定**。代价 = 新卷首次清点多读它一次
（与「每卷一生一次」的既有预算同族）。

**三条硬规的落地**：① 血缘图**不信 `_index.json`**（目录枚举定卷集 + 逐卷读头行定边；成本诚实说：
一次删除 = 每卷一次整份日志读，几百卷的工作区要几秒——不可逆动作换正确性）；② **后序删**（先子后父：
任何中断点剩下的都还是合法森林，测试对每个截断点验「有父的卷其父都在场」）；③ **逐卷可见**
（`deleted` / `failed`（带原因）/ `blocked`（运行中拦下的选择卷）三分账）。

**测试**：新 `tests/session-sidebar-tree.test.tsx`（6 例）；`tests/session-branch.test.ts` +7 例
（血缘图归一化 / 连坐后序 / 只连自己子树 / 中断点零孤儿 / 运行中整体拒绝 / 部分失败逐卷可见 / 悬空父卷当根卷）；
`tests/session-sidebar-ux.test.tsx` 三条删除用例改写为新路径；`tests/chat-session.test.ts` 目录版本与血缘四例。

### 12.5 P3 画布承接（本批）

| 件 | 内容 |
|---|---|
| `app/chat/session-log-store.ts` | `SessionLogStore.header`（attach 时带入内存，write-once）+ 续开姿态改传**盘上头行**（调用方现造的出生头没有血缘——带错了画布上枝卷就找不到父卷） |
| `app/chat/session-branch.ts` | `branchOriginOf`（血缘读面，**零 I/O**）+ `branchNodeMessageId`（切点 → 父卷里承载它的界面消息：投影锚点 + 用户轮桥，与 `resolveBranchPoint` 同一条链、方向相反） |
| `app/chat/chat-core.ts` | `branchEdge(sessionId)`（父卷 + 那个节点；null = 无句柄/落不到节点 ⇒ 不画线） |
| `paper/provenance.ts` | `tetherAnchorsAt`（锚高由调用方给）——`tetherAnchors` 变成它 + 钉锚高，**选边/留白/收笔规则只有一份**（不新造一种线） |
| `paper-shell/PaperPanel.tsx` + `.css` | 枝边层：常显的一丝朱砂（卷首中线 → 节点缘）+ **受墨带**（加粗透明描边承接点击，墨本身仍是那一丝）+ 点线溯源（飞节点 + 点名一拍） |
| `tests/session-tree-canvas.test.tsx`（新） | 挂真 PaperPanel：无枝边不落笔 / 起笔在卷首左缘且朱点落在**父卷那个节点**的缘上 / 点线飞到节点（视口对准父卷中轴）/ 父节点在屏外时线出屏 |
| `tests/session-branch.test.ts` +1 / `tests/paper-provenance.test.ts` +1 | `branchEdge` 真卷三例（根卷无边 / 来文节点 / 回复节点）；同一支笔的锚高等价式 |

**两处实现裁定**（留痕，防回漂）：
- **锚点不假设单调**：`adopt`（开卷重设头部 system 提示）给头条消息的锚点是**那条 adopt 事件的 seq**
  （比尾部历史都大），故「切点 → 投影下标」只能**全扫取最后一个命中**——遇大即断会在开过卷的卷上直接落空
  （实测：`branchEdge` 返回 null）。
- **枝边常显、钉引线 hover**：树是**结构**不是瞬时手势，且线要能点着溯源（hover 才出现的线点不到）；
  一屏一语言指的是**同一支笔**（屏幕坐标 / 恒定墨宽 / 定种子相位 / 起笔留白 + 收笔朱点），不是同一条触发纪律。
  常显故墨退半档（.55，hover 受墨带时抬回 .9）——防「一纸十几枝」时线成面条。
- **出屏的诚实边界**：父卷整个在屏外时线照样出屏，但仅限**卸载余量**（`use-paper-regions` 的
  STUB_MX 900 / STUB_MY 1200）之内——超出即该流区连几何都卸载了（与出处引导同一条边界，不是本批新引入的）。

**门禁**：`npm run build` ✓；`npx vitest run` 347 文件 / 3550 通过 ✓；`npx biome ci .` 0/0 ✓；
`npm run verify:convergence` 双轨 exit 0 ✓（未改 `agent/**` / `composition/**`，仍跑双轨确认零漂移）。


