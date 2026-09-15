# 会话内容存盘审计（2026-09-15）

> 触发：用户报「兰台 agent 的会话内容存盘有问题，各种意外退出甚至正常退出会导致会话丢内容」。
> 方法：代码全链审计（TS 写链 + seam + Rust 能力口 + 进程退出路径）＋ 本机运行时物证
> （`.lantai/sessions/*.json` mtime/savedAt 对账、`.lantai/logs/ui.log`、`.lantai/audit.jsonl`、
> Windows 事件日志、`%APPDATA%\com.lantai.app\.window-state.json`）＋ 既有测试基线实跑 ＋ git/docs 编年。
> 锚点：HEAD `a87b620a`。**本次只读，未改任何产品代码。**
> 关联：`docs/session-checkpoint-design.md`（语义时刻设计的唯一真源，自述「未实施」）·
> `INVARIANTS.md` #11/#12 · `CONVENTIONS.md` §1.7（持久化写链）/:364（错误不静默）。

---

## 0. 结论（先给答案）

会话丢内容**不是**单点 bug，是**四层缺陷的叠加**，且用户感知到的「意外退出丢、正常退出也丢」
两个症状各有独立成因：

| # | 机制 | 一句话 | 等级 |
|---|---|---|---|
| M1 | **在途轮次零持久化** | 一轮从用户输入到轮次结束之间，磁盘上没有任何痕迹；此间崩溃/退出/关机 = 整轮（用户消息＋助手输出＋全部工具结果）全丢 | 🔴 主因 |
| M2 | **退出 flush 名存实亡** | 唯一退出钩子 `beforeunload` 在 Tauri/WebView2 关窗时不触发；钩子里只重挂 500ms 防抖 + fire-and-forget 写；Rust 侧 `Destroyed` 后直接 `std::process::exit(0)` | 🔴 主因 |
| M3 | **系统关机 = 强杀** | 用户「正常关机」在应用侧与 kill 无异（实测：应用活到关机那一刻，未落盘内容随进程消失） | 🔴 主因 |
| M4 | **写面无串行化** | 同一卷多个写者（防抖/后台卷/改名/合卷/失活/退出）并发全量写，到达顺序无保证 → 旧快照覆盖新快照（静默回滚） | 🟠 隐患 |
| M5 | **原子写崩溃窗口无恢复面** | `write_atomic` = target→`.bak`→tmp→target，两次 rename 之间进程死亡 ⇒ 卷文件整体消失；读面无 `.bak`/`.tmp` 回退，且画布剪枝会把该卷从 `canvas.json` 抹掉（看起来像永久删除） | 🟠 隐患 |
| M6 | **无句柄 = 静默不落盘** | `saveActiveSession`/`saveSessionById` 在句柄缺席时静默 `return`（无日志无提示）；`saveAllSessions` 又只覆盖案头摊开的卷 | 🟠 覆盖面漏洞 |
| M7 | **退出时防抖被重挂** | 退出钩子 `scheduleAutoSave` 先 `clearTimeout` 再 `setTimeout(500ms)` —— 把待落盘推迟到窗口消失之后 | 🟡 次因 |
| M8 | **空 projectPath 拼出工作区外路径** | `workspaceSessionsDir('')` = `/.lantai/sessions`（相对 CWD 解析）→ 启动早期读写被安全闸拒绝（日志实证） | 🟡 次因 |
| M9 | **读面静默跳过** | `listSavedSessions` 单卷读失败/10s 超时 → 该卷静默不进列表（只 console），侧栏「少一卷」 | 🟡 次因 |

**根因（与 `docs/session-checkpoint-design.md` §0 同判）**：本仓从未定义「会话什么时候算已持久化」。
落盘时机全是**偶然时机**（轮次结束回调、防抖计时器、合卷、失活、退出钩子），而每一次重构
（铺卷化石 → 双轨写盘 → 归零重建 → workspace-session-ownership）都在重新洗牌这些偶然时机，
没有一次把语义时刻（模型请求前 / 工具副作用前）接上线——该设计件 `:3-4` 自述「设计定稿，**未实施**……
两个触发点只有定义，没有接线」，`:391-393` 明文「不是实施授权」。

---

## 1. 实锤：本工作区 2026-09-15 丢了一整轮

物证全部来自 `D:\HoloGramHG\.lantai\`（本机时区 UTC+8，日志为 UTC）：

| 时刻（本地） | 事件 | 来源 |
|---|---|---|
| 09-15 00:18:09 | 卷 `23.json` **最后一次落盘**（`savedAt=2026-09-14T16:18:09Z`，1,217,272 B，149 条 provider 消息 / 3 个 user turn） | `sessions/23.json` mtime + `savedAt` 字段 |
| 00:19:07 | 下一轮 `turn started` | `logs/ui.log` |
| 00:19:20 → 02:06:26 | **2333 条工具调用审计记录**（1166 Read / 1149 Bash / 17 次编辑），流重试至 01:29 | `audit.jsonl` |
| 全程 | **`23.json` 零写入** | 文件 mtime 不动 |
| 02:06:06 | 前端 2s 轮询停止（JS 侧最后活动） | `ui.log` 末行 |
| 04:12:24 | 应用被写入 `.window-state.json`（tauri-plugin-window-state 在 App exit 时落盘） | `%APPDATA%\com.lantai.app\.window-state.json` |
| 04:12:28 | 系统关机（`EventLog 6006` + `Kernel-Power 109`）；此前 **01:12:23 已有一次用户发起关机**（`User32 1074`, `shutdown.exe`） | Windows System 日志 |
| 07:59:31 | 系统启动 → 08:10 应用重启 → 08:16 应用关闭 | `Kernel-General 12` + `bridge.log`/`ui.log` |

**结论**：这一轮（用户消息 + 助手全部输出 + 2333 次工具调用所产生的内容）**没有任何一部分**在磁盘上，
重启后不可恢复。`sessions/` 目录里没有 `.bak`/`.tmp.N` 残留 ⇒ 不是原子写窗口事故，就是 M1+M2/M3：
**内容从未被写出去**，然后应用被正常关机终结。

### 1.1 退出 flush 没有产生任何落盘（行为反证）

同一份物证还能证明「退出钩子没干活」，而不只是「beforeunload 可能不触发」：

- 08:10 那次启动**建过本卷 Agent 句柄**（`ui.log`：`agent created: main-1789431029103-jf91`，08:10:29）——
  推导依据：该次运行 `canvas.json` 的摊开集只有 `23` 一卷（`{"spread":[{"sessionId":23,…}]}`），
  启动恢复对摊开卷走 `hydrateSessionAgentVisible` 惰性水合，故该句柄所属卷只能是 `23`。
  若 `saveAllSessions()` 落盘成功，`23.json` mtime 应为 08:16 前后 —— 实测仍是 `00:18:09`。
- 该次退出究竟是「点 X 关窗」还是「任务管理器结束进程」，日志无法区分（两者都不留痕）——
  但这不影响结论：**该退出没有产生任何落盘**；且「点 X」路径本身也不具备 flush 能力（M2 第 1–3 条为代码事实）。
- `canvas.json` / `canvas-pins.json` / `canvas-strips.json` 三件 mtime **全部停在 08:12:41**。
  `saveCanvasState` → `state/canvas-store.ts:409-442` 是**无条件写三件**（无脏标记短路），
  退出钩子 `persistence.ts:96` 会调它 —— 三件没被重写 ⇒ 该钩子没有产生任何调用。
- 旁证：历史 22 个卷文件里也**从未出现过**「同一秒内多卷齐写」的簇（`saveAllSessions` 会留下这种簇），
  仅有的两处 1–4s 相邻写可用换卷解释。

---

## 2. 逐机制：代码位置与证据

### M1 在途轮次零持久化（🔴）

**落盘触发面全表（代码实况，唯一真源）**：

| 触发源 | 位置 | 时机 |
|---|---|---|
| 轮次结束（流收尾） | `src-ui/src/ui/chat-stream.ts:500-508`（`finishTurn` → `scheduleAutoSave`） | 轮次**结束**后 |
| turn-done 信号 | `src-ui/src/shell/rows/persistence.ts:21-42` | 同上（后台卷→`saveSessionById`；活跃卷→防抖） |
| 合卷 | `src-ui/src/ui/chat-session.ts:357-376`、`:445` | 用户合卷时 |
| 改名即存 | `src-ui/src/app/chat/chat-core.ts:718-722` | 用户改名时 |
| 工作区失活 | `src-ui/src/workspace.ts:248`（`await saveActiveSession`） | 切工作区时（**唯一 await 的写**） |
| 退出 | `src-ui/src/shell/rows/persistence.ts:83-111` | 见 M2 |

**全部在「轮次结束之后」**。`docs/session-checkpoint-design.md` §3.1/§3.2 定义的
「模型请求前（触发点 A）/ 工具副作用前（触发点 B）」检查点**未接线**（全仓 grep 无实现）。
曾经的第二写面（会话事件 NDJSON）已随 agent-store 内存化退役（`a09e2324`，2026-09-02）——
如今在途轮次在磁盘上**零痕迹**：`ui.log` 只有日志行，`audit.jsonl` 只有权限记录，都不含消息内容。

→ **一轮的暴露窗口 = 整轮时长**（本机实测有 1h47m 的轮；`session-checkpoint-design.md:92-94` 早就点名
「请求窗口可到 10s+、流式生成数十秒、崩溃丢整轮」，只是没接线）。

### M2 退出 flush 名存实亡（🔴）

四重缺陷叠在同一条链上：

1. **钩子不触发**：全仓唯一退出钩子是 `shell/rows/persistence.ts:83` 的 `window.addEventListener('beforeunload', …)`；
   全仓**无** `onCloseRequested` / `getCurrentWindow` / `tauri://close-requested` 消费（grep 0 命中）。
   WebView2/Tauri 关窗不保证触发 `beforeunload`（上游：[WebView2Feedback#3217](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3217)、
   [tauri discussions#4963](https://github.com/orgs/tauri-apps/discussions/4963)、[tauri#2996](https://github.com/tauri-apps/tauri/issues/2996)；
   Tauri 官方替代形态 = `onCloseRequested` + `preventDefault()`）。
2. **钩子内没有强制 flush**：`:87` `scheduleAutoSave(ws.path)` = **重挂 500ms 防抖**（`chat-session.ts:780-797`
   先 `clearTimeout` 再 `setTimeout`，窗口关闭后永不触发）；`:88` `saveAllSessions().catch(() => {})` 是
   **未 await 的 fire-and-forget 且静默吞错**（同文件 `:31-36` 刚为「后台卷落盘失败静默吞」立过可见化规矩，
   `chat-session.ts:790-794` 也为 autosave 立了 toast——唯独退出这条留 `catch(()=>{})`）。
3. **Rust 侧硬退**：`src-tauri/src/main.rs:72-92` `WindowEvent::Destroyed` → drain（≤3s）→ **`std::process::exit(0)`**。
   没有任何「请前端先 flush」的通道或握手；进程一退，在途 IPC 写全部消失。
4. **注释化石**：`persistence.ts:74-76` 声称「`saveActiveSession` 内的 LocalStorage 写入是同步的，
   因此即使 RPC 磁盘写入未完成，也能在窗口关闭前完成」——localStorage 备份链已在 `899190b1`（2026-08-25）
   整体拆除（`chat-session.ts:651`/`:823` 自述「磁盘是唯一事实源」）。**这句话在 08-25 之后就是假的。**

### M3 系统关机 = 强杀（🔴）

实测（§1）证明：用户点「关机」时应用还活着（`.window-state.json` 落盘于 `04:12:24`，关机序列 `04:12:28`），
但内存里的整轮内容随进程一起消失。Windows 关机对应用是 `WM_QUERYENDSESSION` 级别的终止——
本仓既没有 Rust 侧 `RunEvent::ExitRequested` 拦截，也没有前端 `pagehide`/`visibilitychange` 兜底
（全仓 grep：`pagehide`/`visibilitychange` **0 命中**）。→ **「正常退出」这条用户抱怨完全成立。**

### M4 写面无串行化（🟠）

- `writeSessionSnapshot`（`chat-session.ts:653-665`）直接 `await sessionExecute('save_volume', …)`，
  **无每卷写队列/写锁**。`CONVENTIONS.md:184` 的串行写链铁律只覆盖 agent 事件日志（`_eventAppendChain`），
  卷快照不在其内——规则的覆盖缺口。
- 并发写者：turn-done 防抖 + 后台卷 `saveSessionById` + 改名即存 + 合卷快照 + 失活 await +
  退出 `saveAllSessions`（`Promise.all` 并发）+ 轮次结束（后台卷 finishTurn 也会触发活跃卷防抖）。
- Rust 侧 `confined_fs::write_atomic`（`confined_fs.rs:123-150`）不是临界区：
  两个写者的 `remove .bak` / `rename(target→.bak)` / `rename(tmp→target)` 可交错，
  `had_original` 判定可被对方抢跑；Windows `rename` 语义为覆盖 ⇒ **迟到的旧快照覆盖新快照 = 静默回滚**。
  （对照：`commands/editor_cap.rs:72` `checked_write_atomic` 有进程级锁 + 乐观并发校验——卷写链没有。）

### M5 原子写崩溃窗口无恢复面（🟠）

`write_atomic` 时序（`confined_fs.rs:129-142`）：写 `{path}.tmp.{seq}` → `rename(path → path.bak)` →
`rename(tmp → path)` → 删 `.bak`。进程在两次 rename 之间死亡 ⇒ **卷文件整体不存在**（内容只在 `.bak` 或 `.tmp.N`）。

- 读面**无回退**：provider `plugins/builtin/sessions-builtin/index.ts:36-43` 只读 `{id}.json`；
  `list_volumes` 同样只列 `.json`（消费方 `chat-session.ts:861` 过滤后缀）⇒ 该卷从侧栏消失。
- 剪枝会把它从画布抹掉并回写 `canvas.json`（`app/chat/chat-core.ts:830-857`）⇒ 用户视角 = **永久删除**，
  实际内容还躺在 `.bak`/`.tmp` 里（无任何代码会去捡）。
- 无 fsync（`std::fs::write` + rename）：断电/硬复位下 rename 可能先于数据落盘。
- 现状：本机 22 个卷文件**未发现** `.bak`/`.tmp` 残留 ⇒ 该窗口目前是风险而非已发生事故。

### M6 无句柄 = 静默不落盘（🟠）

- `saveActiveSession`（`chat-session.ts:675-676`）与 `saveSessionById`（`:718-719`）：`if (!agent) return;`
  —— 句柄缺席（未水合、工厂失败、`session-composition.ts:101-102` 切 preset 拆句柄）时该卷落盘被**静默跳过**：
  无日志、无 toast、无计数。
- `saveAllSessions`（`chat-core.ts:745-748`）只遍历**案头摊开的卷**，且逐个过上述门槛 ——
  退出收尾的实际覆盖面远小于文档承诺的「全部有内容卷」（`docs/archive/session-ledger-plan.md:95`）。

### M7 退出时防抖被重挂（🟡）
见 M2 第 2 条：`scheduleAutoSave` 在退出钩子里**延后**而不是**立即触发**。⇒ 任何「最后 500ms 内的变更」
在任何退出形态下都不落盘（`AUTO_SAVE_DELAY_MS = 500`，`chat-session.ts:778`）。

### M8 空 projectPath 拼出工作区外路径（🟡）
`workspaceSessionsDir(projectPath)`（`chat-session.ts:582-584`）= `` `${projectPath.replace(/[\\/]+$/, '')}/.lantai/sessions` ``；
`projectPath === ''` ⇒ `/.lantai/sessions`（相对进程 CWD 解析）。实证 `ui.log`：
`2026-09-14T15:50:50Z`（本地 23:50:50）连续 5 条
`invoke failed … path "\\?\D:\.lantai\sessions" is outside project directory "D:\HoloGramHG"`，
`2026-09-15T00:10:26Z`（本地 08:10:26）同款。读侧被 catch 成「目录缺席 = 不剪枝」（安全），
写侧若落在该窗口 = 落盘失败。

### M9 读面静默跳过（🟡）
`listSavedSessions`（`chat-session.ts:869-893`）逐卷读，失败 → `console.error` 后 `return null`；
另有 10s 总超时 `resolve([])`（`:884-889`）——超时即**整表清空**。二者都只进 console，
侧栏表现为「卷不见了」。同族病灶已在画布面修过（`51758e94`「列表超时静默抹画布」），卷列表面未修。

---

## 3. 与文档/承诺的偏差（纸面 vs 代码）

| 承诺 | 出处 | 代码实况 |
|---|---|---|
| 「beforeunload 全卷保存」已交付 | `docs/plans/HISTORY.md:18`、`docs/archive/session-ledger-plan.md:95`、`docs/plans/README.md:105` | 钩子不触发 + fire-and-forget + 静默吞错（§M2） |
| 「关窗兜底主链 = localStorage 同步写」 | `persistence.ts:74-76`（注释）、`94baef8b` 提交正文 | localStorage 链 08-25 整体拆除（`899190b1`） |
| 「会话什么时候算已持久化」有定义 | `docs/session-checkpoint-design.md:386-388` | 该文档 `:3-4`/`:391-393` 自述未实施、零接线（全仓 grep 无 A/B 触发点） |
| 「全部有内容卷在退出时落盘」 | `session-ledger-plan.md:95`、`persistence.ts:80-81` | 只遍历案头摊开卷且要求句柄在场（§M6） |
| 持久化路径沿用串行写链 | `CONVENTIONS.md:184` | 只覆盖 agent 事件日志；卷快照写链无串行（§M4） |
| 写入/持久化错误不得静默吞 | `CONVENTIONS.md:364` | 退出钩子 `catch(()=>{})`×3；无句柄早退无痕；读面失败仅 console（§M2/M6/M9） |

**结论**：本仓对会话持久化的「已交付」描述与代码**不一致**，且不一致的方向都是「纸面比代码强」。
用户体感「丢内容」正是这些纸面保证在真实退出路径上不存在的结果。

---

## 4. 测试覆盖空洞（实跑基线）

实跑：13 个文件 / 108 用例**全绿**（命令见 §6）。被钉住的只有：
落盘目标路径、快照字段、空卷跳过、墓碑形状、seam 四动作、防抖 per-panel 隔离 + epoch 守卫（源码文本断言）。

**六项零覆盖**（逐项 grep 确认，无任何用例）：

| 空洞 | 说明 |
|---|---|
| (a) 退出前 flush | 测试树 `beforeunload`/`unload`/`pagehide` **0 命中**；`saveAllSessions` 仅作为桩出现且无行为断言；最近的 `persistence-signal-routing.test.ts:38-40` 反而把 turn-done 订阅 mock 成 no-op |
| (b) 同卷并发写顺序 | 并发测试只覆盖会话列表竞态；`sessions-seam.test.ts:117` 断的是**顺序**调用数组 |
| (c) 在途轮次持久化 | 无 running/流式中触发保存并断言落盘内容的用例 |
| (d) 原子写崩溃窗口 | 会话卷唯一实际写函数 `confined_fs::write_atomic`（`:123`）**无任何测试**（有测试的是兄弟函数 `write_bytes_atomic` 与另一模块 `utils::write_atomic`） |
| (e) 无句柄卷的落盘语义 | 只有反向保证「有句柄才写」（`audit-fixes.test.ts:220` 注释），无「无句柄时该不该写/该不该报错」 |
| (f) 退出时防抖定时器行为 | 唯一定时器测试是 per-panel 隔离（`audit-fixes.test.ts:200`）；无「退出时 pending 防抖被清空或立即触发」断言 |

⇒ 改这块代码时，这六项没有任何测试会变红。**修复必须自带测试**（见 §5 门禁）。

---

## 5. 修复方案

> 原则（沿用 `docs/session-checkpoint-design.md` §2）：**复用唯一写链**（不得新建第二持久化轨道）、
> **零新写模式**（只有「原子全量替换」与「OS 追加」两个原语）、**fail-open + 可见**（失败不阻断主流程但必须可见）、
> **单写者原则**（同卷只有一个写面）。

### P0 —— 止血（丢内容立刻停止扩大）

1. **退出路径改成真 flush（Tauri v2 官方形态）**
   `getCurrentWindow().onCloseRequested(async (e) => { e.preventDefault(); await flushAllForExit(); await getCurrentWindow().destroy(); })`；
   另加 `pagehide` / `visibilitychange(hidden)` 兜底（覆盖系统关机/注销时窗口不可交互的形态）。
   Rust 侧核对：`main.rs:72-92` 的 `Destroyed → drain → exit(0)` 保留为**兜底**（不再作为唯一路径），
   并给 flush 一个与 drain 预算对齐的**硬超时**（3s 级），超时也要写清「哪些卷未落盘」。
2. **`flushAllForExit()`**：先取消防抖（清 `_autoSaveTimers`，不是重挂），再 `await` 全部**有内容**的卷
   （案头卷 + 磁盘已存且有新变更的卷），串行或小并发（避免 M4 自伤），失败**可见**（toast + 日志 + 计数）。
3. **触发点 A：模型请求前检查点**（`session-checkpoint-design.md` §3.1 定稿即施工规格）
   挂在平台化 P5 后的第一方默认循环 `src-ui/src/agent/agent-loop/`（「组装请求 → 发起请求」之间），
   复用既有 `save_volume` 写链 + 既有防抖合并 + fail-open 可见。
   ⚠ `agent-loop/types.ts`/`default-loop.ts` 是**开放面契约文件** ⇒ 改它们须按
   `composition/contract-version.ts` 四步流程升版，并过 `npm run verify:convergence`（standard + minimal 双轨）。
   效果：崩溃最多丢「当轮模型输出」，**用户已说的话永不丢**（当前最大的体感痛点）。
4. **无句柄卷不再静默**：`saveActiveSession`/`saveSessionById` 的无句柄早退改为可见降级
   （去重 warn + 状态条），且退出收尾换用**不依赖句柄**的快照源（`uiMessages` 与 msgStore 本就独立于句柄，
   见 `chat-session.ts:690` 双面快照）——让句柄缺席不再等于「这一卷放弃写」。
5. **`workspaceSessionsDir('')` 直接判失败**（响亮报错，不再拼出 `/.lantai/sessions`）。

### P1 —— 结构性堵漏

6. **同卷写串行化 + 单调裁决**（M4）：每卷一条写队列（promise 链，末次胜 + 合并窗口），
   写者携带 `revision`/`savedAt`，Rust 或 TS 侧拒绝「旧快照覆盖新快照」。
   Rust 侧可选加固：把 `confined_fs::write_atomic` 纳入 `editor_cap.rs:72` 同款进程级锁。
7. **原子写恢复面**（M5）：读面在 `{id}.json` 缺失时回退 `.bak`（并记录一次可见 warn）；
   成功写入后清理同 id 的 `.tmp.*` 残留；`write_atomic` 增加 fsync（数据先于 rename 落盘）。
   ⚠ 与 `session-checkpoint-design.md` §6.6/§9.3「不做卷版本化 / .bak 多副本，等第一次真实损坏事故再决」
   存在张力——本审计建议的最小形态是**只读回退**（不引入多副本写入面），需用户裁决。
8. **读面不再静默跳过**（M9）：`listSavedSessions` 失败/超时的卷以「读取失败」条目标记可见，
   而不是从列表里消失；10s 总超时改为**部分结果**（已读到的先返回），不整表清空。

### P2 —— 覆盖与验证

9. **补六项空洞测试**（§4）：退出 flush（含「有句柄无句柄」「在途轮次」「pending 防抖」三种前置）、
   并发写顺序（旧不得覆盖新）、检查点 A/B 语义时刻、`write_atomic` 崩溃窗口注入（kill 在两次 rename 之间
   应能读到旧内容或 `.bak` 回退）、无句柄卷落盘、关机/关窗路径的 JS 钩子存在性（源码文本断言亦可）。
10. **大卷写放大**（`session-checkpoint-design.md` §9.1）：每轮检查点 × MB 级快照（本机最大 2.26 MB）
    需实测；必要时上脏标记（同轮已检查点且会话未变异则跳过）——这是唯一的降价手段，不得引入增量第二轨道。

### 门禁（改完必须全绿，AGENTS.md 铁律）

```
cd src-ui && npx vitest run          # 现基线 108 用例全绿
cd src-ui && npm run build           # tsc --noEmit + vite build
cd src-ui && npx biome ci .          # 0 errors / 0 warnings
cd src-ui && npm run verify:convergence   # 双轨（standard + minimal）——动 agent/** 或 composition/** 必跑
cd src-tauri && cargo test           # 壳 411 + 集成 1 基线
```

---

## 6. 独立复核（任何人可重跑）

```powershell
# ① 卷最后落盘时刻 vs 其后是否有轮次（丢内容的判据）
Get-ChildItem D:\HoloGramHG\.lantai\sessions\*.json | Sort-Object LastWriteTime |
  ForEach-Object { "{0:yyyy-MM-dd HH:mm:ss}  {1,9}  {2}" -f $_.LastWriteTime,$_.Length,$_.Name }
Select-String -Path D:\HoloGramHG\.lantai\logs\ui.log -Pattern '"message":"turn started"' |
  Select-Object -Last 5 | ForEach-Object { $_.Line }

# ② 该轮里到底发生了什么（工具调用 = 内容存在过的证明）
Select-String -Path D:\HoloGramHG\.lantai\audit.jsonl -Pattern '"ts":"2026-09-14T1[6-8]:' |
  Where-Object { $_.Line -match '"ts":"([^"]+)"' -and $Matches[1] -ge '2026-09-14T16:19:07' } |
  Measure-Object                                   # → 2333 条

# ③ 关机时刻（「正常退出」）
Get-WinEvent -FilterHashtable @{LogName='System'; Id=@(1074,6006,6005,109,12);
  StartTime=[datetime]'2026-09-14T22:00:00'} | Sort-Object TimeCreated |
  ForEach-Object { "{0:MM-dd HH:mm:ss} id={1}" -f $_.TimeCreated,$_.Id }
Get-Item "$env:APPDATA\com.lantai.app\.window-state.json" | Select-Object LastWriteTime  # → 04:12:24

# ④ 退出钩子是否落过盘：三件画布文件 + 卷文件 mtime 应停在最后一次真实写入，而非退出时刻

# ⑤ 测试基线
cd D:\HoloGramHG\src-ui; $env:NODE_ENV='test'; npx vitest run tests/chat-session.test.ts tests/sessions-seam.test.ts tests/audit-fixes.test.ts
```

---

## 7. 待裁决项（需用户拍板）

0. **实施进度（2026-09-15 当日）**：用户拍板「实施 P0」+「批准 `.bak` 只读回退」——
   P0-1/P0-2/P0-3/P0-4/P0-5 已落地（见 §8 施工记录）；P1-7（`.bak` 只读回退）待 P1 批次。
1. **P0-1 的关窗形态**：改为「拦截关窗 → flush → destroy」（关窗延迟最多 ~3s，用户可感知但可见），
   还是「关窗不拦 + 依赖触发点 A 的语义时刻保证」？本审计建议**两者都做**（拦截给最后一道保险，A 保证日常）。
2. **P1-7 的 `.bak` 只读回退**是否违反 `session-checkpoint-design.md` §6.6 的「不做多副本」裁决（建议：只读回退不算多副本写入面，但需显式裁决并写回该文档）。
3. **P2-10 的检查点频率**（每轮一次全量写 vs 脏标记降频 vs 大卷阈值）——建议接线后按实测数据定参。
4. **`audit.jsonl` 能否作为崩溃恢复的旁证面**（它包含该轮工具调用的权限记录）：只用于「提示用户哪些副作用可能已发生」，
   还是也用于内容重建？本审计建议**只做提示**（内容重建 = 第二恢复轨道，与单写者原则冲突）。

---

## 8. 施工记录（P0 批次，2026-09-15）

改动面与对应机制：

| 机制 | 施工内容 | 落点 |
|---|---|---|
| M2/M3/M7 | 退出收尾重写为**一条 flush 三个入口**：① `watchWindowClose`（Tauri `onCloseRequested`）→ `preventDefault` → await flush → `destroy`；② `pagehide` / `visibilitychange(hidden)`（系统关机/注销/休眠）；③ `beforeunload`（浏览器 dev 面保留为最优努力）。三者单飞去重；flush 有 2500ms 硬预算并**逐卷报异常**（不再 `catch(()=>{})` 静默） | `shell/rows/persistence.ts`、`bridge.ts`（`watchWindowClose`）、`src-tauri/capabilities/default.json`（+`core:window:allow-destroy`） |
| M7 | `cancelScheduledAutoSave`（取消防抖、不重挂）+ `ChatCore.flushSessionsForExit`（取消防抖 → drain 在途写 → 全卷显式落盘 → 再 drain） | `ui/chat-session.ts`、`app/chat/chat-core.ts` |
| M4 | **每卷写链**：同文件写串行化（`enqueueVolumeWrite`，键 = 目标路径）+ `drainVolumeWrites()`；写链失败不阻断后续写 | `ui/chat-session.ts` |
| M6 | `SessionSaveOutcome`（saved / skipped-empty / skipped-no-handle / skipped-no-workspace / failed）+ `SessionSaveReport` 汇总；无句柄/无工作区不再静默 `return`，**一次性 warn 可见** | `ui/chat-session.ts`、`app/chat/chat-core.ts` |
| M8 | `workspaceSessionsDir('')` 响亮报错（不再拼出 `/.lantai/sessions`）——消费方各自降级（读侧空集） | `ui/chat-session.ts` |
| M1 | **触发点 A 接线**：loop 监听面 `request/start`（D4 可观测面，**不改 agent-loop 契约文件**）→ 该卷立即落一次快照；在途合并（同卷至多一条）；fail-open 且失败留痕；工作区代际守卫 | `shell/rows/persistence.ts`、`agent/runtime/runtime.ts`（`onLoopEvent` 转发）、`agent/chat-agent-handle.ts`（可选能力位） |

测试（新增 `src-ui/tests/session-exit-flush.test.ts`，8 用例）钉住：退出 flush 取消防抖 + 全卷落盘 + 汇总、
无句柄可见跳过、空工作区不落盘、**同卷并发写串行（旧快照不得最后落盘——撤掉写链真变红，实测复现 v1 覆盖 v2）**、
写链失败不阻断、空路径守卫、**触发点 A 落盘**与在途合并。

门禁实跑：`vitest run` 3076 passed / 4 skipped（1 项 `event-catalog-doc` 因编辑期文件锁 EBUSY 假红，复跑绿）、
`biome ci .` 0/0、`npm run build` 绿、`npm run verify:convergence` **双轨 exit 0**、`cargo test`（壳）见提交记录。

**仍未覆盖**（P1/P2 面）：`.bak` 只读回退、真实崩溃注入（kill 在两次 rename 之间）、大卷写放大实测、
`listSavedSessions` 失败卷的可见化（M9）。

---

## 9. 换轨后状态（2026-09-15 三期竣工回写）

用户拍板「看别人怎么存盘的」→ 按 DSH 参照换轨（计划与施工记录见
`docs/plans/session-persistence-dsh-port-plan.md`）。**§2 的机制表在换轨后的命运**：

| 机制 | 换轨后 | 说明 |
|---|---|---|
| M1 在途轮次零持久化 | ✅ 结构性解决 | 事件日志增量落盘（200ms 窗口）+ 每个模型请求前排空队列（触发点 A）⇒ 崩溃最多丢「窗口内事件」，不再丢整轮 |
| M2 退出 flush 名存实亡 | ✅ 解决（P0 + 换轨） | P0 的三入口（onCloseRequested / pagehide / visibilitychange）保留；动作从「写 N 卷 MB 级快照」变为「排空队列」（KB 级） |
| M3 系统关机 = 强杀 | 🟡 窗口大幅收窄 | 同上：关机最多丢窗口内增量（触发点 A 已把「用户说的话」钉在请求前） |
| M4 写面无串行化 | ✅ 解决 | P0 每卷写链（同文件串行）+ 写后队列本身单写者 |
| M5 原子写崩溃窗口无恢复面 | ⚪ **随架构消失** | 日志是 append-only（无 rename 窗口）；**`.bak` 只读回退需求作废**——半截记录由断尾截断修复，不需多副本 |
| M6 无句柄 = 静默不落盘 | ✅ 解决 | P0 的 outcome + 可见 warn；且内容真源改为日志后，「句柄在场」不再是落盘前提 |
| M7 退出时防抖被重挂 | ✅ 解决 | 退出路径改为「取消防抖 + 排空队列」 |
| M8 空 projectPath 拼错路径 | ✅ 解决 | `workspaceSessionsDir('')` 响亮报错（P0） |
| M9 读面静默跳过 | 🟡 部分解决 | 卷集改按 `.ndjson` 认卷后，读取失败仍只进 console（可见化未接线） |

**权威面终态**：`.ndjson` 事件日志 = 卷本体与内容真源（扫描 + 断尾修复 + 悬空工具调用
配平后 replay 投影）；`.json` = 带 `{seq, ver}` 的 UI 投影缓存（陈旧即不采信、重建）。
契约面随之升到 v33（`delete_volume` 退役 / 新增 `delete_log`）。

**仍留的口子**（详见计划文档末节）：日志体积无压实策略；跨进程多实例并发未裁决。
（触发点 B 已收官：宣布落盘 → 排空屏障 → 才执行工具体；phase-5 事件序列基线两轨重录，
CR 见 `docs/archive/agent-core-convergence/baseline-change-request.md`。）
