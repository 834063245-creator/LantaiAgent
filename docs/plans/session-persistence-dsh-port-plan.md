# 会话存盘换轨：DSH 参照审计与移植计划（2026-09-15）

> 触发：用户拍板「预期在这改来改去，不如看看别人都是怎么存盘的」——去 `D:\useful\deepseek-harness`
> （HEAD `4e84901e64`）读参照实现。
> 前置：本仓 `docs/session-persistence-audit.md`（四层缺陷审计）+ commit `d563ce74`（P0 止血）。
> 结论一句话：**DSH 与兰台差的不是「什么时候保存」，而是「什么是真相」**——DSH 的真相是
> append-only 事件日志 + 写后队列；兰台的真相是一份全量快照 JSON，所以每次落盘都要重写
> 1–2MB，于是只能「轮末存一次」，于是丢就丢一整轮。P0 是安全网，换轨才是解药。

---

## 一、DSH 的实际做法（七根支柱，逐条附证据）

### 1. 真相 = 事件日志（append-only JSONL），不是快照

`packages/core/session/src/index.ts`：`Session` 是事件流（`append`/`snapshotEvents`/`seq`），
消息是**投影**（`packages/session/session-projection`），落盘面是每卷一份追加日志：

```
<root>/--<project-key>--/<encoded-session-id>/session.jsonl        （session-persistence-jsonl/src/format.ts:234-241）
```

头行 = session 元数据（`type:'session'` + `version` + id/createdAt/cwd/preset/…），其后每行一个事件。

### 2. 写 = 增量 append + fsync，批量窗口 200ms

- `appendLines`：`open(path,'a')` → `writeFile(content)` → **`handle.sync()`**；
  失败时**回滚到写入前的 size** 再抛（否则重试同批次会产生重复 seq）——`index.ts:693-731`。
- 批量调度 `SessionWriteBehind`（`session-persistence/src/write-behind.ts`）：
  事件入队 → 空队列时起一个**固定 200ms 窗口**（`DEFAULT_WRITE_BATCH_MAX_DELAY_MS`，`coordinator.ts:46`）
  → 窗口到或显式 flush 才落盘；**写失败把整批 splice 回队首 + 暂停自动写 + 上报背景失败**
  （`:139-158`）——不丢事件、不静默。
- 首次 append 与「物化头行」**原子提交**（`appendBatch` 契约，`coordinator.ts:195-207`）；
  纯惰性创建：`create()` 只记意图，产物在首个事件批次才出现（`coordinator.ts:738-743`）。

### 3. 检查点 = 「排空队列」，挂在三个语义时刻（fail-closed）

`packages/session/session-checkpoint-policy/src/index.ts`：

| 挂钩 | 位置 | 语义 |
|---|---|---|
| `llm/stream` | 模型适配器派发**之前** | 已记录的请求前缀必须已持久 → 拒绝即不派发（`afterCheckpoint`，`:29-38`） |
| `tools/execute` | **顶层**工具体执行前（嵌套复用外层已持久点） | 副作用前把「宣布要做什么」落盘（`:70-75`） |
| `agent/pre-step` | 每个 step 开始 | 把上一步提交的全部内容落盘（`:79-82`） |

关键：检查点动作只是 `await ctx.sessions.flush(session)`（`coordinator.ts:710-724` 的
`ensureMaterialized` + write-behind `flush()` 屏障）——**没有第二种写模式**，因为是增量写，
排空队列就是几 KB 的 append。这是兰台设计件 `docs/session-checkpoint-design.md` §2「零新写模式」
想做的事，DSH 用「增量写」把它变成廉价的。

### 4. 崩溃恢复 = 扫描 → 保留连续前缀 → 截断断尾 → **合成收尾事件**

- 扫描器 `SessionLogScanner`（`format.ts:337-455`）：只认**换行结尾的完整行**；
  记录 `committedBytes`（安全截断点）；seq 必须连续（gap = 损坏）；损坏行之后的第一个
  `turn/end` 才是硬错误，否则算断尾。
- 断尾标记 `tornMarker{truncateTo}` 交给协调器，`commitRepair()` = **truncate + fsync → 追加合成收尾**
  （`index.ts:469-478`），并 `logger.warn` 报「从断尾恢复、丢弃了不完整尾字节」。
- 合成收尾 `interruptedTurnClosers`（`core/session/src/repair.ts:29-135`）是整套的精华：
  - 未配对的工具调用 → 补 `tool/result`，且**区分两种语义**：
    未记录 start = `TOOL_NOT_STARTED`（「没跑，需要就重试」）／
    已记录 start 无结果 = `TOOL_OUTCOME_UNKNOWN`（「**副作用可能已发生**：只读或幂等才重试，
    否则先核对外部状态或问用户，禁止盲重试」）；
  - 开着的 step 先补 `step/end`，再补 `turn/end{reason:{kind:'interrupted'}}`；
  - 合成事件复用最后一条真实事件的 ts（确定性、不发明未来时间）。

### 5. 并发 = 每会话一条 promise 链，**读也走链**

`coordinator.ts:1197-1213` `serialize(id, op)`：同 id 的所有操作（写、load、inspect、readFrom）
串成一条链，错误不毒化链（下一条照常）。读侧另有 `readStableFile`：**前后两次 stat 的 revision
一致才采信**（`index.ts:310-322`）——避免与写入交错读到半截。
（兰台 P0 只给写加了链，读没加。）

### 6. 派生面 = 「fold 快捷方式，永不是权威」

`packages/session/session-projection-cache/src/index.ts:1-17`：
> "The cache is a fold shortcut, **never an authority**: a row is possibly stale (its `seq` says how
> stale) but never wrong, so every write path is **fail-soft** (a lost write costs a longer tail
> replay on the next cold read) and a `ver` mismatch **discards** the row instead of migrating it."
- 每条记录带 `seq`（陈旧度）与 `ver`（格式版本）；
- 强制写点 = 会话创建 / `turn/end` / 会话销毁（策略，不可配），另有「每 N 事件」与「每 T 毫秒」两个节流；
- 丢了就当没缓存 → 下次冷读重放尾部。

### 7. 生命周期 = dispose 静默点驱动（不是靠退出钩子）

- `retirements: Map<id, Promise>`：会话销毁后其缓冲尾巴仍在 drain，读/加载会等它；
- 后端 dispose 时先重试失败的 retirement、等在途 retirement 结束，再 `close()`
  （`session-persistence/tests/persistence.spec.ts:1992-2080` 钉住这两条）；
- 由此**不需要**「关窗保存全部」这类钩子：日志随时是最新的（≤200ms 窗口），
  进程被杀最多丢窗口内的增量。

### 附带护栏（都值得抄）

| 护栏 | 位置 | 作用 |
|---|---|---|
| 头行 version 拒读 | `format.ts:305-312` + `coordinator.ts:93-97` | 未来格式 → 「升级 harness」，**绝不报「损坏」** |
| append 前深拷贝快照 | `coordinator.ts:755-766` | 调用方后续 mutate 不影响已入队内容 |
| seq 连续性校验 | `coordinator.ts:783-788` | 批次必须接上存储游标 |
| 同 id 已有产物则拒绝 create | `coordinator.ts:734-737` | 防撞号覆写 |
| 路径段编码 | `format.ts:154-169` `encodeSegment` | id 任意字符串 → 单段安全路径（防穿越/碰撞） |
| Windows 持久发布 | `session-persistence-jsonl/src/win32.ts` | `MoveFileExW(MOVEFILE_WRITE_THROUGH)` 等价目录 fsync |
| 版本化事件词表 | `core/session/src/known-event-types.ts` | 未知必需事件 → 拒读而非静默丢 |

---

## 二、兰台 vs DSH：差距表

| 维度 | 兰台现状（`d563ce74` 之后） | DSH | 差距性质 |
|---|---|---|---|
| 真相源 | **卷快照 JSON 即权威**（`messages` + `uiMessages`）；重启「采信 UI 快照，不重建」 | 事件日志即权威；投影缓存明确「永不是权威」 | 🔴 结构性 |
| 写形态 | 每卷**全量重写**（本机 1–2.27MB/次，`write_atomic` tmp→bak→rename） | 增量 append 事件行 + fsync，200ms 批量窗口 | 🔴 写放大 → 检查点昂贵 |
| 检查点 | P0 刚接的「请求前落一次**全量快照**」 | `flush()` 排空队列，挂 llm/stream + tools/execute + pre-step | 🟠 成本与覆盖面 |
| 崩溃恢复 | 无：坏卷过滤掉、半写=整卷消失、断尾无截断、开着的轮次无收尾 | 扫描→连续前缀→截断断尾→合成 closers（含副作用的两种语义） | 🔴 整条链缺失 |
| 写失败 | P0 做了可见化（outcome + warn），但**不回灌重试** | 批次回灌队首 + 暂停自动写 + 上报 | 🟠 |
| 并发 | P0 加了**写**链（键=文件路径） | 每会话链，**读也走链** + 读 revision 双 stat | 🟡 接近 |
| 退出 | P0 加了关窗 flush（要写 N 卷 MB 级） | 不需退出钩子：增量写 + 语义边界 flush + dispose drain | 🟡 P0 会随换轨变廉价 |
| 格式演进 | 无版本拒读（读不进的卷 = 「不存在」） | 头行 version + 定向拒读文案 | 🟡 |
| 事件词表 | **已有**：`SessionLog` 12 种 kind + `deriveMessages/derivePayload` 投影 + 差分测试 | 同类（更细：step/turn 边界、surfaceOp 替换语义） | 🟢 **兰台已完成一半** |
| UI 派生面 | `uiMessages` 当权威（WO-7 快照保真，为保 err/output/asset 块） | projection cache（带 seq/ver，stale 则重放尾部） | 🟠 需给快照加 seq 语义 |
| 落盘 RPC | `agent_session_append`（Rust，`.lantai/agents/{id}/session.ndjson`，追加/truncate 两态 + 6 条钉测）**仍在契约内但零 TS 消费方**（dormant-but-contracted） | — | 🟢 写面地基已在 |

**最重要的一条**：兰台**已经有**一个事件溯源的 `SessionLog`（`src-ui/src/agent/session-log.ts`：
封闭 kind 集、严格递增 seq、`snapshot()/replay()` 持久化对、`deriveMessages()/derivePayload()`
投影、`onEvent` 监听面、与旧数组逐字节等价的差分测试），**只是没有任何东西把它写到盘上**——
唯一写面（agent-store 的 NDJSON）在 2026-09-02 内存化时退役，设计件 §1.2 描述的
`SessionLog → log_append` 链从未真正接通（`agent/logger.ts` 写的是 ui.log 应用日志，不是会话日志）。

⇒ 移植不是「从零重写」，而是**把已有的内存事件日志接到盘上，并让卷快照降级为投影缓存**。

---

## 三、移植计划（分三期，P0 的成果全部保留）

### Phase 1 —— 写面：SessionLog → append-only NDJSON + 写后队列（骨架）

1. **落点**：`.lantai/sessions/{id}.ndjson`（与现有 `{id}.json` 快照并存；DSH 形态是
   `{id}/session.jsonl`，兰台按「归属即存储位置」沿用扁平命名，少一层目录）；
   头行 = `{type:'session', version:1, id, createdAt, label, presetId, cwd}`。
2. **写后队列（write-behind）**：`SessionLog.onEvent` → 深拷贝入队 → 200ms 固定窗口 /
   显式 `flush()` 触发 append；**失败整批回灌 + 暂停自动 + 上报**（照抄 `write-behind.ts`）。
3. **durable append**：Rust 侧现有 `agent_session_append`（append / `rewrite=true` 两态 + fsync
   语义待补）改为会话日志写口；补齐 **write 失败回滚到原 size** 与 `handle.sync()`。
   经 `ctx.sessionPersistence` seam 加动作（`append_events`），保持「写面单点」纪律。
4. **检查点三挂钩**（复刻 DSH 语义，落点用兰台现成面）：
   - 模型请求前 —— **P0 已接线**（`request/start` loop 监听面），动作从 `saveSessionById`
     换成 `flushSessionLog(sid)`（排队空 = 几 KB append）；
   - 顶层工具执行前 —— `agent/events.ts` 的 eventBus `tools/execute` 面（兰台已有 preflight/around
     节点）；写类工具 fail-closed（与 DSH 一致），读类不挂；
   - step 前 —— `default-loop` 的 `step/start`（已有 emit，零契约改动）。
5. **退出**：P0 的三入口（onCloseRequested / pagehide / visibilitychange）保留，动作退化为
   「排空队列」（不再写 N 卷 MB 级快照）。

**Phase 1 单独就能把丢失上界从「一整轮」压到「≤200ms 事件」**，且不改真相源、不动 phase-5 基线。

### Phase 2 —— 读面：扫描 + 修复 + replay（恢复链）

1. **扫描器**：只认完整行 → 连续前缀 + `committedBytes`（截断点）+ seq gap 即损坏
   （对照 `format.ts:337-455`）；**格式版本拒读先于一切形状校验**（未来格式 →
   「升级兰台」，绝不覆写）。
2. **合成 closers（实施期裁定：不补 `turn/end` / `step/*` 事件种类）**——
   计划原写「需要补 kind」，落地时判定**不必要**：
   - 兰台的投影（`deriveMessages`）只认消息事件，轮次开合不参与转写合法性；
     provider 真正在意的是「每个 `tool_call` 必须有配对的 tool 消息」；
   - 悬空调用可从既有事件面直接推出（`assistant/text.message.tool_calls` 宣布 +
     `tool/call` 分发记录 + `tool/result` 配平），不依赖轮号/步号；
   - 副产品：不动 phase-5 事件词表（`SESSION_EVENT_KINDS`）⇒ **不需要
     convergence 基线变更审批**（原计划里那一项作废）。
   两种语义照 DSH（已分发但无结果 = `TOOL_OUTCOME_UNKNOWN`「副作用可能已发生，
   别盲重试」；只宣布未分发 = `TOOL_NOT_STARTED`「没跑，需要就重试」）。
3. **打开路径 = 截断修复 + 补 closers + 落盘**：`openSessionLog` 先截断断尾
   （`truncate_log`），再 `restoreInPlace` + continue，再补悬空调用的 `tool/result`
   并立刻排空——**修复本身是持久化的**，不是内存态调整（DSH `commitRepair` 同义）。
4. **加载路径换轨**（Phase 3 完成权威翻转）：`.ndjson` 有内容 → 扫描+修复+replay →
   `deriveMessages()` 得 provider 消息；`.json` 快照降级为**投影缓存**（带 seq/ver）。

### Phase 3 —— 收尾：快照降级为缓存 + 删除旧恢复面

> **施工状态（2026-09-15）**：Phase 3a（采用原语）已落地并提交；Phase 3b（读路径
> 翻转）待下一批，改动面见下（照此执行即可，不需重新推导）。

**3a 已完成（采用原语）**：
- `session/reset` 新增 `reason: 'adopt'`，投影语义 = **只重设头部 system 提示、
  尾部历史保留**（不产全文副本——整段替换要把全部消息再写一遍，每次开卷 +1 份
  全文，与 append-only 增量背道而驰）；
- `Agent.adoptSessionLog(systemPrompt)`：发一条 adopt 事件 + 内存投影 =
  `deriveMessages()`（复用既有 `_replaceSession` 入口 ⇒ **不动 phase-5 T0 变异
  入口白名单**）；
- 测试 `tests/session-log-adopt.test.ts`（3 例）：投影只换头 / Agent 采用后
  in-memory == deriveMessages / 零漂移（既有 reason 仍整段替换）。

**3b 剩余（读路径翻转，下一批）**：
1. `session-log-store`：新增只读 `readVolumeLogMessages(root,id)`（扫描 + 补悬空
   调用 + `SessionLog.replay` → 消息序列），**不写盘**；
2. `chat-session.readVolumeData`：**日志优先**——有日志 → `messages = 日志派生`，
   `.json` 只当 UI 投影缓存（`uiMessages`/`tokens`/`compose`/`label`），且缓存带
   `{ver, seq}`；`cache.seq < 日志 lastSeq` = 陈旧 → 不用快照（走既有
   `rebuildMessagesFromMessages` 重建），即 DSH 那句「possibly stale but never
   wrong」的落地；无日志 → 卷不存在（旧 `.json` 卷不做兼容读——用户拍板）；
3. 开卷路径：`openSessionLog` 采用成功后调 `agent.adoptSessionLog(...)` 取代
   `setSession([...freshSys, ...快照 messages])`；
4. 卷枚举/删除换轨：`listSavedSessions`/`scanMaxSessionId`/画布剪枝按 `.ndjson`
   认卷；`deleteSessionFile` 真删日志（seam 加 `delete_log` 动作），墓碑语义退役；
5. `writeSessionSnapshot` 增 `ver`/`seq` 字段（缓存新鲜度判据）；
6. 测试面：`chat-session.test.ts` 等 13 个文件 / 108 例里凡以 `.json` 快照为
   权威的断言按「行为退役 → 同批删除 / 行为新增 → 从用户操作序列新写」处理。

---

## 四、待用户拍板

1. **范围**：只做 Phase 1（写面+检查点+退出，丢失上界 ≤200ms，不动基线）／Phase 1+2
   （加恢复链，需动 phase-5 基线审批）／三期全做（含权威翻转与删除旧面）。
2. **落点命名**：`.lantai/sessions/{id}.ndjson`（扁平，跟现状）还是 DSH 形态
   `{id}/session.jsonl`（每卷一个目录，留 session-local 文件位）。
3. **老卷**：legacy 读保留还是按「旧数据不迁移」直接归档。
4. **工具副作用前检查点**是否 fail-closed（DSH 形态：checkpoint 失败就不执行工具）——
   兰台设计件 §3.3 当时刻意选了 fail-open（磁盘满不瘫全功能），这条要重新裁决。
