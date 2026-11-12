# Goal 目标域 · DSH 移植（2026-10-23）

> 状态：**在办（收尾观察期）** —— 源码面完成（2026-10-27 `6c1da811`）；验收口径 2026-10-28 = **默认通过**，用户报问题即修；exe 已重建，不再占待办（目标 `goal-a2a63841`）。
> 2026-11-12 修补批（见 §13）：驱动器**卷身份**与**重排时机**收口 —— 修「目标停在 active/armed 却再也不续行」。
> 进度：P1 ✅ 18 例 · P2 ✅ 14 例 · P3 ✅ 11 例 · P4 ✅ 8 例 · P5 ✅（状态条 / 基线 / 文档 / 门禁）。
> 决策：**不再修补**现行 `goal-manager + goal-loop + goal_report` 一套，按 DSH 的
> goal 栈整件替换。参照真源：`D:\useful\deepseek-harness\packages\goal\`
> （`goal` 服务 / `tool-goal` / `command-goal` / `goal-round-driver`）。

## 1. 为什么换

现行实现是「项目级记录目录 + 一次 `/goal` 拉起一条 while 循环」：

- 目标记录落 `.lantai/goals/`，与会话卷脱钩 ⇒ 恢复/fork/撤回都不认它；
- 循环在一个 run 里反复 `runLoop`，中断语义靠错误文案猜（`BodyStreamBuffer`
  被当失败、`failed` 永久不可恢复）；
- 完成靠专用 `goal_report` 工具 + 正文正则兜底，工具面每轮动态注册/注销；
- 没有「轮」的显式记账（记录里的 `iteration` 是开工时的旧值），没有上限的真实约束；
- 状态条随 V5 拆除丢失，`panel-store.goalRecord` 成为死字段。

DSH 的模型是「**每会话一个持久目标 + 三个常驻工具 + 独立续行驱动器**」：

| 件 | 职责 |
|---|---|
| `goal` 服务 | 事件溯源状态（`goal/change`）、CAS 修订、阶段机、进程本地 activation |
| `tool-goal` | `get_goal` / `create_goal` / `update_goal`（含执行期授权与 blocked 阈值） |
| `command-goal` | `/goal` 命令语法（裸调用=状态，`<objective>`=创建） |
| `goal-round-driver` | 空闲时自动开下一轮（`<goal_round>` 提示、预约-准入-围栏、轮上限） |

关键性质（全部照抄）：目标活在**会话日志**里，重启/恢复/fork 都在；自动续行是
**进程本地授权**，重启后一律 disarmed，必须人 `/goal resume`；完成/受阻只能由
「直人轮」或「本目标当前轮」上报；受阻需连续 ≥3 轮且必须给具体原因；轮上限
（默认 256）是唯一预算。

## 2. 状态模型（照抄，改名适配）

```ts
type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
type GoalActivation = 'armed' | 'disarmed';   // 进程本地，永不持久化

interface GoalSnapshot {
  id: string;            // goal-<uuid>
  revision: number;      // 每次持久变更 +1（CAS）
  objective: string;
  phase: GoalPhase;
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
}
interface GoalView extends GoalSnapshot {
  roundsStarted: number; // 已准入轮数（由 goal/round 事件推进）
  createdAt: number; updatedAt: number;
  activation: GoalActivation;
}
```

- 每卷至多一个当前目标；`complete` 的目标可被新 create 直接替换，其余阶段必须先
  `edit` / `pause` / `resume` / `clear`。
- `clear` 写墓碑（revision+1），历史留在日志里。
- 变更一律带 `{id, revision}`，陈旧引用报 `GOAL_STALE_REVISION`，不静默覆盖。
- `resume` 只在轮预算仍有剩余时接受；模型不得 resume 一个 paused 目标（人才能）。

## 3. 持久化与折叠

`session-log.ts` 新增两个 kind（无消息投影）：

- `goal/change`：`{ operation, goal?, cleared?, roundsStarted, createdAt, updatedAt }`
  —— 变更后的完整快照（照 DSH：事件携带全量，折叠只认快照 + 严格校验）；
- `goal/round`：`{ goalId, revision, round }` —— 轮被**准入**（`<goal_round>` 消息
  进入会话）时追加；`roundsStarted` 只由它推进。

折叠 `deriveGoal()`（SessionLog 第四个读面，与 `deriveMessages` 同一 fold 家族）：

- 只消费 `goal/change` / `goal/round`；
- 严格校验：revision 连续 +1、阶段转移合法、`roundsStarted` 连续、blocked 必带原因；
- 首次非法即 `failure`，此后目标访问 fail-closed（命令/工具报「目标日志损坏」），
  但**不阻断普通会话**；
- `session/reset` 不重置目标（目标独立于消息）；`session/retract` 只抹消息类事件，
  目标事件本就不可抹除。

`goal/round` 的事件落点 = Agent 侧 `runGoalRound` 追加 `<goal_round>` 消息的同一段
代码（先 append 事件，再 append 消息），顺序保证「有轮事件 ⇔ 模型看得到这轮提示」。

## 4. 服务面与归属

内核新增 `src-ui/src/agent/goal/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | 纯类型（GoalPhase/GoalView/GoalRef/错误码） |
| `domain.ts` | 状态机纯函数：resolveCreate/edit/pause/resume/complete/block/clear + 校验 |
| `fold.ts` | `deriveGoal(log)`：严格回放 + failure |
| `session-registry.ts` | ownerId（bus id）→ 目标宿主（Agent 自身，窄接口）；进程级键控自清理（CONVENTIONS §1.10 第 3 类，Agent 装配登记、dispose 注销） |
| `service.ts` | 面向工具/命令的门面：`get/create/edit/pause/resume/complete/block/clear/disarm` + activation 缓存 |

归属理由：目标状态是**卷级**的（跟着 SessionLog 走），不属于 chat 面板；工具经
`_owner_id` 解析到注册表，命令经 chat-core 的 agent 句柄直接调用。插件不持内核
实现——`goal-mode` 产物只贡献工具行与 prompt 段，经 `./host` 桥取门面（与
plan-mode 同款）。

## 5. 工具面（DSH → 兰台域工具）

兰台的模型可见面是**域工具**（`DOMAIN_SPECS` 动作折叠），不直接暴露 `create_goal`
这类散名。新增域：

```text
goal(action: get|create|update, objective?, max_goal_rounds?, goal_id?, revision?,
     update_action?, blocked_reason?)
```

- `get`：返回紧凑 JSON `{goal: …|null, activation}`（照 DSH 输出形状）；
- `create`：objective 必填；仅直人轮；已有非 complete 目标时拒绝；
- `update`：`edit` / `pause` / `resume` / `complete` / `blocked`；CAS 必带 id+revision；
  - `edit` / `pause` / `resume`：仅直人轮（`runKind === 'turn'` 且顶层 Agent）；
  - `complete` / `blocked`：直人轮，或本目标当前轮（`runKind === 'goal'` 且轮号匹配）；
  - `blocked`：必须带 `blocked_reason`，且当前 `roundsStarted ≥ 3`（可配）；
- 隐藏实现名 `goal_get` / `goal_create` / `goal_update`（`collectHiddenToolNames()` 派生）。

授权判据在 `Agent` 侧暴露：`currentRunKind(): RunKind | null`、`isTopLevelAgent`；
`goal/round` 的轮号由服务从日志折叠值给出，工具侧不接受调用方自报。

## 6. 自动续行驱动器

宿主 = `chat-core`（它拥有 run 编排与 idle 判据），不是插件：

1. 每次 `_runAgentTurn` 收尾（含 `/goal` 创建后的空闲窗口）调用 `_driveGoal()`；
2. 条件：目标 `active` + `armed` + `roundsStarted < maxGoalRounds` + 本卷空闲
   + 没有待注入的人类消息；
3. 动作：`agent.runGoalRound(signal)` —— claim run(kind `goal`) → append
   `goal/round` → append `<goal_round>` user 消息 → `runLoop`；
   `<goal_round>` 加入 `INTERNAL_PREFIXES`（不渲染成用户气泡）；
4. 上限耗尽 → `block(code: 'round-limit')`；本轮用户停止 → `pause`（不是 failed）；
   轮内异常 → 保留 phase 但 disarmed（错误不静默，toast 说明）；
5. 重启/恢复/fork → activation 缓存为空 = disarmed，人 `/goal resume` 才继续。

与 DSH 的差异（显式记录）：兰台没有「预约-准入围栏」的 inbox 原语，轮事件在
run 启动时追加；若 run 在第一步前被拒（plan 门禁等），该轮仍计一轮。这是
可接受的偏差，记在测试里，不假装等价。

## 7. `/goal` 命令（chat-core）

| 输入 | 结果 |
|---|---|
| `/goal` | 有目标=状态（阶段/轮数/activation/可用命令）；无目标=一行用法 |
| `/goal <objective>` | 创建并 arm；空闲则立刻开第 1 轮 |
| `/goal edit <objective>` | 改目标；无目标报错，complete 则等价新 create |
| `/goal pause` / `resume` / `clear` | 对应变更；resume 检查轮预算 |

控制词只在**整条输入**等于控制词时生效，其余非空后缀一律是目标（`/goal pause after x`
= 创建该字面目标，照 DSH）。裸 `/goal` 不再把历史目标当 toast 弹出来。

## 8. 状态条

纸壳恢复 `GoalStrip`（从 `a621b1e6^` 取旧实现改造）：目标原文 / 阶段 / 第 N·M 轮 /
暂停·恢复·清除。数据源 = 卷级 goal store（由 chat-core 在目标变更与轮结束时刷新）。

## 9. 拆除清单

- `agent/goal-manager.ts`、`agent/goal-impl.ts`、`agent/goal-contract.ts`
- `plugins/builtin/goal-mode/{goal-loop,implementation,index,host,host.aliased}.ts`
  （目录保留给新工具/prompt 产物，名字不变以减少名册/清单漂移）
- `state/goal-store.ts`、`workspace.ts` 的 GoalManager/adoptOrphans、
  `chat-core.ts` 的 runGoal/runGoalResume/showGoalStatus/cancelGoal 旧实现、
  `agent.ts` 的 goalManager 字段与 runGoal/resumeGoal、runtime/context/类型面引用
- `.lantai/goals/` 旧数据：**不读、不迁移**（归档保留；新实现只认会话日志）

## 10. 阶段与门禁

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | session-log 两个 kind + fold + 单测 | ✅ 18 例 |
| P2 | 内核 goal 域（状态机/CAS/activation/注册表）+ 单测 | ✅ 14 例 |
| P3 | goal 工具域 + DOMAIN_SPECS + prompt 段 + 授权 | ✅ 11 例；`gen:tool-contract` 收录 `goal` |
| P4 | 驱动器 + `/goal` 命令 + 旧件拆除 | ✅ 8 例（command 5 + round 3）；旧 4 文件 + 2 测试整删 |
| P5 | 状态条 + 文档 + 基线（host-surface / convergence / doc-sync） | ✅ 状态条进创作坞；基线重录；`doc-sync`/`doc-check` 绿 |

门禁（2026-10-23 终局）：`npm run build` ✅ · `npx biome ci .` ✅ · `npx vitest run`
**4634/4634 全绿** · `npm run verify:convergence` 双轨 ✅（工具面 +1 域，基线按
`baseline-change-request.md` 登记后重录）· `doc-check` ✅ · `gen:host-surface` ✅（faceDeps 换轨）。
顺带拆除两处存量红灯（创作坞 P2 的无障碍名断言、`.pp-comp-pill` 跨产品重复选择器）。

## 11. 已验事实（2026-10-23）

- 模型可见面：新增 `goal(get/create/update)` 一域；full 快照 17 → 18、plan 19 → 20
  （plan 只含 `get`）；其余工具逐字节不变。
- 宿主面：faceDeps 撤 `registerGoalImplementation`、加 11 个 goal 服务键（工具产物经 `./host` 桥）。
- 旧数据：`.lantai/goals/` 不再被读取（归档保留，不迁移）。
- 实机产物需重建 exe 才能生效（旧 exe 的 faceDeps 与新产物偏斜，装载器会具名拒载）。

## 12. 风险

- **授权是近似**：兰台没有 DSH 的 open-turn 事件切片，直人判定用 `runKind`；
  子 Agent 发起的调用一律无直人授权（顶层判定），这是安全侧偏差。
- **轮计数**：无预约围栏，被拒的轮仍计数（见 §6 差异）。
- **基线噪声**：新增工具域/prompt 段必然改 convergence 快照；host faceDeps 去掉
  `registerGoalImplementation` 会改宿主面指纹，必须重建全部产物。

## 13. 修补批（2026-11-12）：驱动器卷身份与重排时机

用户提问：「会不会出现任务没做完，goal 循环停止但 goal 并未清除？」——查证结论 = **会**，
而且是**默认路径**（不是边角竞态）。四条病根都在 `chat-core` 的目标驱动器里，与状态机
（`agent/goal/` 的事件溯源 + CAS + fold）无关：状态机本身每一跳都严格、可回放。

| # | 病根 | 用户可见症状 |
|---|---|---|
| ① | 目标轮用**活跃卷**的运行账（`_activeExec()`），轮内切卷后记录挂到别人的账上 | 本卷两条 loop 并发；停止键停不掉真正在跑的那条 |
| ② | 收尾裁决取**此刻活跃卷**的宿主 | A 轮的成败记到 B 卷头上（A 停在 active、B 被误解为失败/暂停） |
| ③ | 下一轮排程只认「活跃卷空闲」 | 目标卷被切走后**永远不再排**：active + armed，状态条写着「进行中」，实际一动不动 |
| ④ | `sendMessage` 这条真发话路径收尾不排程 | 模型在直人轮里 `goal(create)` 的目标停在**第 0 轮**，直到用户再发一句话或切卷 |

修法（同批）：`_scheduleGoalDrive(sid)` 带上卷身份、该卷还在跑时把这一跳**改挂到空闲转变**
（一次性订阅、按卷去重），`_driveGoal` 抓到条件后全程钉住目标卷（`goalTurn: { sid }` →
exec 账、turnSid、`setUiSessionId`、宿主解析、收尾裁决、下一轮排队），`switchSession` 切回
时重排，`sendMessage` 收尾也排一次。

钉住它们的回归：`tests/goal-driver.test.ts`（8 例，用可控假 Agent 走真实 ChatCore 编排）——
正常推进 / 用户停止 / 轮内异常 / 切卷不跨卷续行 / 切回即接上 / 两卷各自的目标互不代跑 /
直人轮建目标即开第 1 轮 / 账上有别的运行时挂到空闲转变。

**行为变更（用户可感知）**：轮内异常仍然只 disarm（目标保持 active，人可 `/goal resume`），
但现在状态条明确标「续行已停」，toast 也写明恢复入口——旧实现只有一条会滚走的 toast，
纸面上看起来还是「进行中」。
