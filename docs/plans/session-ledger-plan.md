# 案卷总目（Session Ledger）— 会话管理收敛计划

> 立项：2026-08-23 · 状态：Proposed·Draft（已拍板收敛方向，未开工）
> 触发：用户实机反馈「新开一卷没什么用」→ 链路排查 → 用户定调「会话管理要做收敛，复杂度降下来，别堆成屎山」。
> 前置事实源：`src-ui/src/ui/chat-session.ts`（会话 CRUD/持久化）、`src/state/session-store.ts`（摊开集真相）、`app/panels/SpineRack.tsx`（C8 书脊列）、`app/SessionsHome.tsx`（档案首页）、`shell/rows/cold-start.ts` / `shell/rows/persistence.ts`（冷启动与落盘接线）。

## 0. 一句话

给会话立一本账：**档案号 = 卷号、开合有册、落盘两动词**——书脊列与档案首页退化为这本账的两个视图，不再各自记账。

## 1. 诊断（2026-08-23 实测代码结论）

### 1.1 两本账现状

| | 案头（书脊列） | 档案库（首页） |
|---|---|---|
| 记什么 | 内存里摊开的卷（sess store `sessions[]`） | 磁盘案卷文件（`listSavedSessions` 目录扫描） |
| 谁写 | 另起一卷/换卷/合卷 | 轮次完成自动存/合卷自动存/续开 |
| 互通 | 无成员查询、无查重 | 无摊开标记、无去重 |

中间只有三座窄桥（合卷自动存、轮次完成自动存、续开），桥外两边互相不知道对方存在。

### 1.2 五道裂缝（均已代码定位）

| # | 裂缝 | 定位 |
|---|---|---|
| F1 | **首页「＋ 新建案卷」是空壳**：只 `openPanel('paper')`，不建任何会话；冷启动已静默恢复最后一卷 → 重启后点「新建」看到的是旧对话 | `SessionsHome.tsx` `onNewSession` |
| F2 | **续开不查重**：`loadSessionFromDisk` 无条件 append，已摊开的卷可克隆出同号双脊（旧句柄被顶掉未 dispose，合掉一条另一条变死卷） | `chat-session.ts` `loadSessionFromDisk` |
| F3 | **后台卷落盘窗口期**：turn-done 存的是**当前翻开**的卷（`saveActiveSession`）；后台卷跑完的那轮不落盘，切回前关应用即丢 | `shell/rows/persistence.ts` + `scheduleAutoSave` |
| F4 | **摊开集不持久**：哪几卷开着、谁活跃，无处落盘；重启只回一卷（`_active.json` 只记 lastId） | `_active.json` 形状 |
| F5 | **发号器只靠跟踪文件续命**：`nextSessionId` 仅从 `_active.json`/localStorage 推；`scanMaxSessionId` 写好但**全项目零调用**（死代码）。跟踪文件+localStorage 双失效时新卷可与旧档撞号，保存直接覆盖 | `chat-session.ts` 发号链 |

### 1.3 状态散布（定性：**保留，不动**）

会话载荷分五片：元数据（sess store）/ Agent 句柄（agentSessionState）/ 消息（msgStore）/ 草稿（input-store）/ 纸面摆放（paper-store）。**这五片都是按 sessionId 分片的载荷仓，不是竞争性账本——本计划不合并它们**（合并会大面积触碰冻结文件 chat-session.ts，收益低风险高）。要收敛的是**身份、开合、发号、落盘策略**这四件事的归属。

## 2. 目标与非目标

**目标**（四件事归一处）：
1. 身份：档案号 = 卷号，一个实体一个号，全生命周期不撞号
2. 开合：摊开集（谁开着/谁活跃）有册可查、随重启恢复
3. 发号：单一发号源，`scanMaxSessionId` 上岗
4. 落盘：收编为 `save(sessionId)` / `append(sessionId)` 两个动词，谁跑完存谁

**非目标**：
- 不动多 Agent 并发核心（agentSessionState 句柄生命周期、exec 隔离照旧）
- 不动 C8 书脊隐喻与交互（恒显/换卷/双击改名/合卷自动存全保留）
- 不合并五片载荷仓（见 §1.3）
- 不动「启动落点恒为案卷首页」拍板（工作集在后台恢复，落点不变）
- localStorage 双层存储本批**不砍**（保留为崩溃加速器；复活守卫 P1-14 语义收编进账本对账函数，物理退役另立观察项）

## 3. 设计：总目

### 3.1 磁盘形状（每工作区一份，含零目录工作区）

`.lantai/sessions/_ledger.json`（`_active.json` 的继任者，一次性迁移）：

```jsonc
{
  "version": 2,
  "open": [ { "id": 230, "label": "…" } ],   // 摊开集（重启恢复工作集的依据）
  "activeId": 230,                            // 活跃卷
  "nextSessionId": 231,                       // 发号器（与 scanMax 对账后的值）
  "savedAt": "…"                              // 总目自身写入时间
}
```

- 旧 `_active.json`：迁移期读到即吸收（lastId → open 单卷 + activeId），首次写总目后不再读；两版共存窗口为零外部用户，干净切换
- 卷文件（`{id}.json`）形状不变——总目只管开合与发号，卷内容仍归卷文件
- 档案目录列表（首页）**继续走目录扫描**，不从总目派生——档案全量唯一真相是磁盘目录，总目只记工作集，避免再造第二本全量账

### 3.2 内存形状

- 内存摊开集真相**仍是 sess store**（20+ 消费点不动）；新增 `state/session-ledger.ts` 模块收口四件事：
  - 总目读写（原子写、防抖、epoch 守卫沿用 H5 纪律）
  - 发号：`nextId = max(总目.nextSessionId, scanMaxSessionId(dir) + 1)`（F5 死代码上岗，工作区装配点对账一次）
  - 成员查询：`isOpen(id)`（首页摊开标记、续开查重共用）
  - 落盘两动词：`save(sessionId)`（全量快照）/ `append(sessionId)`（NDJSON 增量）——三条现存保存路径全部改调这两个
- 书脊列/首页改为经 `isOpen` 查账，不各自维护判断

### 3.3 工作集恢复（重启摊法回来）

- 冷启动：读总目 → 逐卷恢复**消息内容**（读卷文件，便宜）；**Agent 句柄惰性水合**——切换或拟文时句柄缺席才 factory 补建（避免摊 20 卷 = 起 20 Agent；bindSession/exec 态在水合时接）
- 活跃卷指针照总目恢复；无总目 → 旧 `_active.json` 迁移路径 → 无则现行兜底（新建案卷 1）
- 落点仍是案卷首页（拍板不动）；工作集在后台恢复完毕后首页可见「已摊开」标记

## 4. 阶段（L0-L3，按成本排）

> 编号 L 段（Ledger/总目），区别于 agent-plugin 的 P 段与 paper-shell 的 C/V/B 段。

| 段 | 内容 | 判据（测试钉死） | 成本 |
|---|---|---|---|
| **L0 立账** | 总目文件 + 迁移 + 发号对账 + 工作集恢复（内容恢复/句柄惰性水合） | ① 总目读写 roundtrip + 迁移用例；② 重启恢复摊开全集（多卷全回、活跃指针正确）；③ 发号 = max(总目, scan)+1，构造撞号场景不覆盖旧档；④ 惰性水合：切卷/拟文时句柄按需补建 | ~~≈1 天~~ ✅ 已毕（2026-08-23，commit 7345e885 + 572df12e）：模块 state/session-ledger.ts（v2 总目/毒化容忍/发号对账/自然迁移——旧路径恢复成功后首写总目，不显式吸 _active.json）；四动词记账 + restoreFromLedger 多卷恢复（活跃卷真句柄 + 惰性卷 msgStore 预填/纸面恢复）+ ensureSessionAgent 两唤起点（切卷内联/拟文同步兑底）；17 用例全绿 |
| **L1 视图对齐** | 首页「＋ 新建案卷」真建（调 `createNewSession`，空壳死掉；无 key 走 sr-notice 同款守卫）；续开查重（已摊开 → 换卷不克隆）；首页卡片「已摊开」标记（点它 = 换卷进纸面） | ① 新建后 sess store 多一卷且卷文件号正确；② 已开卷续开 = switchSession（书脊不增条、无句柄泄漏）；③ 首页标记 = `isOpen` 投影 | ~半天 |
| **L2 落盘收编** | 两动词收口（save/append）；turn-done 信号携带会话 id，存**跑完的那卷**；beforeunload 存**全部有内容卷**（非仅活跃卷） | ① 后台卷 A 跑完一轮：A 的卷文件更新、活跃卷 B 的文件不动（时间戳断言）；② 关应用前全部有内容卷均已落盘（构造 A 后台/B 前台双卷场景）；③ 现存三保存路径全部改调两动词、旧行为对拍 | ~1 天 |
| **L3 清账守护** | 死代码清点（`scanMaxSessionId` 转正、空壳入口删、无条件 append 改守卫）；一致性守护测试常驻；localStorage 降级评估（观察项，不强制本批） | ① 守护测试：书脊列表 ≡ 总目 open 集；首页摊开标记 ≡ open 集；无重复 open id；② biome 改动文件零新增；③ chat-session 全量既有用例不红 | ~半天 |

## 5. 风险与纪律

| 风险 | 处置 |
|---|---|
| `chat-session.ts` 在冻结名单 | 最小切口；每次改动前 grep `⚠️ INVARIANT`；P0/P2 动刀前全量跑 `tests/chat-session.test.ts`；不动三入口变异协议（`_appendMessage/_replaceSession/_retractSessionRange`） |
| 工作集恢复的异步竞态 | 沿用 H5 epoch 纪律（`getWorkspaceEpoch/isCurrentEpoch`），逐卷恢复写入前校验代际 |
| 总目写入与卷文件写入交错 | 总目只记开合/发号/指针，不含消息——两者无字段竞争；总目写失败走「失败可见」（console.error + 通知），不静默 |
| 惰性水合与 exec 态 | 重启后无运行态（isRunning 恒 false），exec 随水合创建即可；书脊列运行点逻辑不受影响 |
| 首页新建在无 key 冷启动 | 前置守卫 + 纸面直示（复用 SpineRack sr-notice 模式），不走会静默丢弃的 addNotice 路径 |

## 6. 验证门禁

标准前端门禁全适用：`cd src-ui && npm run build` + `npx vitest run` + biome 改动文件零新增。本计划**不触** `src-ui/src/agent/**` 与 `src-ui/src/composition/**`，convergence 基线不动。真机验证项：重启工作集恢复（多卷摊开 → 关 → 开，摊法全回）、后台卷落盘（双卷并发跑一轮后检查卷文件）、续开查重（同卷两次续开只有一条脊）。

## 7. 交付物清单

- `src-ui/src/state/session-ledger.ts`（新模块：总目读写/发号/成员查询/两动词）
- `_ledger.json` 形状 + `_active.json` 一次性迁移
- SessionsHome / SpineRack / loadSessionFromDisk / persistence.ts 壳行 四处消费点改读账
- `tests/session-ledger.test.ts`（新）+ `tests/chat-session.test.ts` 增补（工作集恢复/查重/按卷落盘）
- 本文件随 L 段逐段落 ✅，竣工即归档
