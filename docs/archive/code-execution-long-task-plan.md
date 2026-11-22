# code 模式长任务：P0 止血 / P1 作业面 / P2 增补（已竣工）

> **已归档（2026-11-22 · 竣工）**：P0/P1/P2 全部落地，三个 commit：`0357b4a5`（P0 止血）·
> `b09ab612`（P1 作业面）· `6db4a258`（P2 增补 + baseline 变更）。
> 现状入口 = `INVARIANTS.md` §18（行为契约）+ `docs/plans/README.md`。
> **本文是历史记录，不是现状依据。**
>
> 实机验收按 2026-10-28 口径**默认通过**（用户：「验收默认全过，有问题我自然会主动修的」）；
> 判据见 §4.7，出问题时按该节回查。

---

## 1. 立案与病灶

触发：用户在 `code` preset 下调 `code_execution` 跑 `npx vitest run`，**永远跑不完**。

三条机制（逐条取证）：

| # | 事实 | 代码位置 |
|---|---|---|
| ① 外层硬墙 | `runCode` 缺省 `timeoutMs = 120_000`，装配层未传参；到点 `finish()` → `worker.terminate()` | `agent/code-run/host.ts` |
| ② 内层更慢 | shell `run` 的 `timeoutMs` 缺省 **300_000**、上限 600_000；到点由 Rust **promote** 成后台 job | `plugins/builtin/shell-domain/shell-tools.ts`；`agent/runtime/queued-shell.ts` |
| ②′ promote 落地 | Rust 超时分支 emit `shell:done{promotedJobId, promotedTimeoutMs, promoted}` | `src-tauri/src/commands/process_cap.rs:848-854` |
| ③ 超时即弃 | `finish` 置 `settled` 后不再回话；嵌套调用**无 signal** | `host.ts` / `agent.ts` |
| ④ 审计浅冻结 | `sessionLog.append` = `Object.freeze({seq,ts,kind,data})`，`data.args` 与分发共用引用 | `agent/session-log.ts:276-279` |

⇒ **②③ 叠加**是主因：内层还没到 promote 点，外层先死；死时不 abort 内层、不交付句柄 →
孤儿进程 + 零信息；模型重试再叠一个 vitest，**越跑越慢**。这不是「120 太小」，是
「超时那一下的处置方式错了」。

## 2. 不变量（已落 `INVARIANTS.md` §18）

> **INV-1 永不孤儿** · **INV-2 预算穿透** · **INV-3 不静默（超时清账）** · **INV-4 选择权在模型**

## 3. DSH PTC 对账（`d:\useful\deepseek-harness`）

| 层 | DSH 做法 | 出处 |
|---|---|---|
| 内层 | 每条 bash 命令从启动就是 job；前台超时（120s）不杀，返回 `[still running after Nms; moved to background job <id>]`；`promoteOnTimeout` 默认 true | `packages/shell/tool-bash/README.md` |
| 外层 | 超时 = 协作撤销：`runController.abort()` 让在途嵌套调用收到 signal（注释原话 *"instead of orphaned"*）；3s `stopGraceMs` | `core/tool-executor-ptc/src/ptc.ts`、`ptc-runtime-node/src/config.ts:51` |
| 跨轮 | 作业完成通知（busy 注入下一步 / idle 唤醒）、`job_output(wait)`、`job_list`、`job_kill`；`run_code` 的 `timeoutMs` 模型可见（120000/600000） | `packages/jobs/tool-jobs/README.md`、`ptc.ts:114-123` |
| 中断 | 撤销 + 宽限 + 保留变量（persistent），下一轮复用 VM | `2026-10-29-retained-ptc-interruption.md` |

**未对齐项（明确不做）**：持久执行 / scoped REPL（`src-ui` 无 JS parser 依赖，自动复制顶层
声明成本远超收益；若将来要做，走「显式 state 对象 + reset 动作」而非自动扫描）、
typed tool returns、Python 后端、e2b、`inspect()` 图像输出通道。

## 4. 施工结果

### 4.1 P0 止血（`0357b4a5`）

- `CodeBindingSpec` 增 `deadline?: 'promote' | 'abort'` 与 `defaultTimeoutMs?: () => number | undefined`；
  `invoke(args, ctx?: { remainingMs, signal })`。
- `applyBudget`：**只对声明 promote 的 binding** 压 `timeoutMs` 到 `剩余 - 8s`
  （`MIN_FOREGROUND_MS = 15s` 以下不压，交 abort 兜底）。
- `runController`：跟随外层 signal；`finish` 内**先 abort 再 terminate**。
- `dispatchNestedTool(name, args, signal?)` 第三参 → `tool.execute(..., signal ?? _currentRunSignal)`。
- `inflight` 台账 + `lateSettled`；超时结果追加在途清单。
- 修既有缺陷：`done` 分支原为「先 drain 后 finish」，未 await 的写会拖到超时 → 改为先 abort 再 drain。
- 顺手拆除：`Agent` 上只写不读的 `_codeDispatch` / `setCodeDispatch` / `getCodeDispatch`。

### 4.2 P1 作业面（`b09ab612`）

- `settleGraceMs`（缺省 3s，对齐 DSH stopGraceMs）：程序 return 后写链不排空则到点结算为**完成**。
- 待领信箱：`onLateResult` → `Agent.noteLateNestedResult` → 每步
  `_applyPendingMemoryUpdates` 注入 system-reminder **一次**（上限 8 条 / 800 字；换卷清空）。
- 通知文案：后台完成/停止/停滞/启动 + `promotedText` + 忙等喝止，统一改用
  `shell(action:'output'|'wait'|'kill', jobId:N)`（旧名 `bash_*` 已退休）。

### 4.3 P2 增补（`6db4a258`）

| 项 | 结果 |
|---|---|
| P2-1 `timeoutMs` | 可选参数（默认 120000 / cap 600000）；baseline 双轨 record，2 份 phase-1 effective 快照 +12 行；变更申请已登记 |
| P2-2 输出预算 | 64KB → 256KB（无 spill 面，理由写在常量注释） |
| P2-3 并发配额 | `maxPendingCalls = 128`，超限回 `subcall-limit` + 「await in batches」 |
| P2-4 审计快照 | `structuredClone(args)` 入账，分发仍用原对象 |
| P2-5 持久执行 | **不做**（理由见 §3 未对齐项） |
| P1-3 code 引导 | 第 4 条纪律「分钟级的活别在程序里等」+ 预算数字 256KB |

## 5. 验收判据（§4.7 原文）

1. `code` 组合卷跑 `cd src-ui && npx vitest run`（全量 >120s）。
2. **A**：程序在 ~112s 内结束，文本含 `[任务超时，已转入后台继续运行 —— job N]`。
3. **B**：下一轮 `drain_bg_notifications` 或 `shell(action:'wait', jobId:N)` 拿到 exit code；
   进程表**无第二个 vitest**。
4. **反例回归**：`shell(action:'run', command:'echo hi')` 与改动前逐字一致。

自动化证据（等价面）：`tests/code-execution.test.ts` 50 条 · `tests/code-late-results.test.ts` 3 条 ·
`tests/shell-done-watchdog.test.ts`（promote 文案）· `tests/shell-poll-guard.test.ts`（喝止文案）。

## 6. 风险与回退

- `deadline` 缺省 `'abort'` ⇒ 未声明 promote 的工具行为与旧版等价；P0 三项各自独立 commit，可单 revert。
- P2-1 可单独 revert（快照一并回滚，申请文档标注）。
- 压 timeout 只在「请求值 > 剩余预算」时发生，短命令零影响（用例钉住）。

## 7. 门禁实测（2026-11-22）

`vitest` 546 文件 / 5536 用例全绿 · `tsc --noEmit` · `biome ci` 0/0 ·
`verify:convergence` 双轨（record 后）· `cargo check` · `doc-sync` / `doc-check`。
