// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ── Goal 续行驱动器（2026-11-12 自 app/chat/chat-core 整件搬出）──
//
// 目标域的状态真源在会话日志（agent/goal/service + 每卷 session-log），本文件只管
// **什么时候开下一轮**：读目标 → 判相位/轮预算/卷身份 → 经 runAgentTurn 跑一轮 →
// 按收尾裁决暂停 / 停用续行 / 再排下一轮。
//
// 卷身份（2026-11-12 收口，三条负向先例都长在这条线上）：
//   ① 目标轮全程钉在**发起时刻的目标卷**——运行账、收尾裁决、下一轮排队都不许换卷；
//   ② 切卷后不得拿「此刻翻开哪卷」的宿主去裁决别的卷的轮；
//   ③ 排程撞上本卷还在跑时不丢弃，改挂到该卷账的空闲转变上（一次性去重）。
//
// 与 ChatCore 的接缝只有几样：panelId、每卷 exec 账（isRunning / onChange）、
// 按卷取句柄、runAgentTurn（轮次脚手架留在 core——直人轮 / 命令轮 / 目标轮共用
// 一份，这里只负责「开不开下一轮」）。测试从 scheduleGoalDrive 进。

import type { ChatAgentHandle } from '../../agent/chat-agent-handle';
import type { ExecStateInstance } from '../../agent/execution-state';
import { parseGoalCommand } from '../../agent/goal/command';
import {
  blockGoal,
  clearGoal,
  createGoal,
  disarmGoal,
  editGoal,
  type GoalHost,
  pauseGoal,
  readGoal,
  resumeGoal,
} from '../../agent/goal/service';
import { goalHostOf } from '../../agent/goal/session-registry';
import type { GoalView } from '../../agent/goal/types';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';

/** 目标驱动器对 ChatCore 的全部依赖——不给类，只给能力位。 */
export interface GoalDriverHost {
  /** 面板实例（每卷账的隔离键 / 具名诊断用）。 */
  readonly panelId: string;
  /** 活动卷 id（无卷 = null）。 */
  activeSessionId(): number | null;
  /** 活动卷的 Agent 句柄（未装配 = null）。 */
  agentOf(): ChatAgentHandle | null;
  /** 活动卷的 exec 账（无卷 = 面板级兜底账）。 */
  activeExecOf(): ExecStateInstance;
  /** 按卷取 exec 账（排程判空闲 / 收尾裁决都用**目标卷**那本）。 */
  execStateOf(sid: number): ExecStateInstance;
  /** 按卷取句柄（目标轮按目标卷的句柄开轮）。 */
  agentOfSession(sid: number): ChatAgentHandle | null;
  /** 轮次脚手架（在 ChatCore：直人轮 / 命令轮 / 目标轮共用）。 */
  runAgentTurn(opts: {
    runKind?: 'turn' | 'wake' | 'goal' | 'compact' | 'subagent';
    bubble?: string;
    goalTurn?: { sid: number | null };
    drive: (signal: AbortSignal) => Promise<unknown>;
    onSettled?: (info: { aborted: boolean; error?: unknown }) => void;
  }): Promise<void>;
}

/** 目标状态条的数据源（会话面板 store 的 goalView 槽）。 */
export interface GoalViewSink {
  setGoalView(view: GoalView | null): void;
}

export class GoalDriver {
  /** 目标续行调度合并位（微任务去重——同一收尾窗口只排一次下一轮）。 */
  private _goalDriveScheduled = false;
  /** 「等本卷空闲再排」的一次性订阅（sid → 退订）：同一卷只挂一个，避免重复排程。 */
  private readonly _goalIdleWait = new Map<number, () => void>();

  constructor(
    private readonly host: GoalDriverHost,
    private readonly sink: () => GoalViewSink,
  ) {}

  /** 面板拆除/切工作区时解订阅（否则同一执行账跨实例复用会漏订而累积）。 */
  dispose(): void {
    for (const off of this._goalIdleWait.values()) off();
    this._goalIdleWait.clear();
  }

  /** 本卷目标宿主（Agent 在 goal 注册表里的登记）；Agent 未就绪 = undefined。 */
  goalHost(): GoalHost | undefined {
    return goalHostOf(this.host.agentOf()?.id);
  }

  /** 读本卷目标；日志损坏 = 具名 toast + undefined（普通会话不受影响）。 */
  goalView(): GoalView | undefined {
    const host = this.goalHost();
    if (!host) return undefined;
    try {
      return readGoal(host);
    } catch (e) {
      showToast(`目标状态不可用：${e instanceof Error ? e.message : String(e)}`, 'warn', TOAST_LONG_HOLD_MS);
      return undefined;
    }
  }

  /** 把目标视图写进面板 store（状态条数据源）。 */
  refreshGoalView(): void {
    this.sink().setGoalView(this.goalView() ?? null);
  }

  /** 空闲时排一次目标续行（微任务合并，避免在 turn finally 里递归起轮）。
   *
   *  `sid` = 排程方所属的卷：该卷账上**还在跑**时，这一跳不丢弃，改装到该卷账的
   *  **空闲转变**上（一次性）。为什么必须这样：`_runAgentTurn` 的 finally 里
   *  `run.end()` 之后立刻排程，而同一 finally 还要走 finishTurn / bumpTurnDone——
   *  订阅者可能在这之间再起一条运行（唤醒轮、后台件），驱动器一看「账上在跑」
   *  就放弃，此后再没有人排它：目标停在 active+armed 不动。 */
  scheduleGoalDrive(sid?: number): void {
    if (this._goalDriveScheduled) return;
    if (sid != null && this.host.execStateOf(sid).isRunning) {
      if (!this._goalIdleWait.has(sid)) {
        const off = this.host.execStateOf(sid).onChange(() => {
          if (this.host.execStateOf(sid).isRunning) return;
          this._goalIdleWait.delete(sid);
          off();
          this.scheduleGoalDrive();
        });
        this._goalIdleWait.set(sid, off);
      }
      return;
    }
    this._goalDriveScheduled = true;
    queueMicrotask(() => {
      this._goalDriveScheduled = false;
      void this.driveGoal();
    });
  }

  /** 目标续行驱动器：active + armed + 还有轮预算 + **目标卷**空闲 → 跑一轮。
   *
   *  ⚠ 卷身份（2026-11-12 收口）：目标活在卷里，续行也是给那卷续——一旦抓到开轮条件，
   *  本轮全过程（Agent 句柄、运行账、收尾裁决、下一轮排队）都钉在**发起时刻的目标卷**，
   *  绝不跟着「此刻翻开哪卷」走。旧实现每一步都取活跃卷：切卷后目标轮把记录挂到别的卷、
   *  收尾拿别的卷的相位裁决、下一轮又去驱动另一个卷的目标——三张不同的卷在同一处混用，
   *  正是「目标停在 active/armed 却再也不跑」与「两卷被交替续行」的根因。 */
  async driveGoal(): Promise<void> {
    const sid = this.host.activeSessionId();
    const agent = this.host.agentOf();
    const host = this.goalHost();
    if (!agent || !host || sid == null) return;
    // 本卷账上正在跑（直人轮 / 后台唤醒 / 已在跑的目标轮）：改挂到它的空闲转变上
    // 再排（`scheduleGoalDrive(sid)` 自带一次性订阅去重）。为什么不直接 return：
    // 这一跳可能是**最后一跳**（切卷、/goal resume、切回目标卷都只排这一次），
    // 放弃就再没人排——正是「目标停在 active+armed 不动」的形状。
    if (this.host.execStateOf(sid).isRunning) {
      this.scheduleGoalDrive(sid);
      return;
    }
    let view: GoalView | undefined;
    try {
      view = readGoal(host);
    } catch {
      return; // 损坏已在 goalView 报过；驱动器不重复刷屏
    }
    this.refreshGoalView();
    if (view === undefined || view.phase !== 'active' || view.activation !== 'armed') return;
    // 卷闸：登记之后、开轮之前用户切了卷 ⇒ 本卷不再是目标卷，这一跳作废
    //（重排点 = 切回本卷时的 switchSession）。
    if (this.host.activeSessionId() !== sid) return;
    if (view.roundsStarted >= view.maxGoalRounds) {
      try {
        blockGoal(
          host,
          { id: view.id, revision: view.revision },
          {
            code: 'round-limit',
            message: `Goal reached its configured limit of ${view.maxGoalRounds} rounds.`,
          },
        );
      } catch {
        /* 已终结/被改：下一轮读形自会收敛 */
      }
      this.refreshGoalView();
      showToast(`🚧 目标达到轮上限（${view.maxGoalRounds}），已停止续行。`, 'warn', TOAST_LONG_HOLD_MS);
      return;
    }
    await this.host.runAgentTurn({
      runKind: 'goal',
      goalTurn: { sid },
      drive: (signal) => agent.runGoalRound(signal),
      onSettled: (info) => this.settleGoalRound(sid, info),
    });
  }

  /** 一轮结束后的裁决：用户停止 = 暂停；异常 = 停用续行；正常 = 排下一轮。
   *  `sid` = 本轮所属的**目标卷**（不是收尾时刻的活跃卷）。 */
  settleGoalRound(sid: number, info: { aborted: boolean; error?: unknown }): void {
    // 目标宿主按卷解析：用户中途切卷时 `goalHost()` 已经是另一个卷的宿主了，
    // 拿它裁决本轮的存续 = 把 A 卷的轮记到 B 卷头上（旧实现的第二条混卷路径）。
    const host = goalHostOf(this.host.agentOfSession(sid)?.id);
    if (!host) return;
    let view: GoalView | undefined;
    try {
      view = readGoal(host);
    } catch {
      return;
    }
    this.refreshGoalView();
    if (view === undefined) return;
    if (info.aborted) {
      try {
        pauseGoal(host, { id: view.id, revision: view.revision });
      } catch {
        /* 已不在 active：不必重复暂停 */
      }
      this.refreshGoalView();
      showToast('⏸️ 目标已暂停 — /goal resume 继续', 'info');
      return;
    }
    if (info.error !== undefined) {
      disarmGoal(host);
      this.refreshGoalView();
      // 单轮异常只停**自动续行**（activation 是进程本地授权位）：目标仍是 active，
      // 人可以 /goal resume 接着推。状态条据此显式标「续行已停」——旧实现只有一条
      // 会滚走的 toast，用户在状态条上看到的仍是「进行中」。
      const msg = info.error instanceof Error ? info.error.message : String(info.error);
      showToast(`目标轮失败，自动续行已停用（/goal resume 继续）：${msg.slice(0, 160)}`, 'warn', TOAST_LONG_HOLD_MS);
      return;
    }
    if (view.phase === 'complete') {
      showToast(`✅ 目标达成: ${view.objective.slice(0, 80)}`, 'info');
      return;
    }
    if (view.phase === 'blocked') {
      showToast(`🚧 目标受阻: ${(view.blockedReason?.message ?? '').slice(0, 120)}`, 'warn', TOAST_LONG_HOLD_MS);
      return;
    }
    // 下一轮：目标卷仍是活跃卷时本处直接续；已切走则这一跳放弃——不跨卷替
    // 别的卷开轮（回来后由 switchSession 重排）。
    if (view.phase === 'active' && view.activation === 'armed' && this.host.activeSessionId() === sid) {
      this.scheduleGoalDrive(sid);
    }
  }

  /** `/goal` 状态渲染（无目标 = 用法；有目标 = 阶段/轮数/续行/可用命令）。 */
  showGoalStatus(): void {
    const view = this.goalView();
    if (view === undefined) {
      showToast(
        '当前没有目标。用法: /goal 目标描述 — Agent 会自主循环直到完成；/goal pause · resume · clear 控制当前目标',
        'info',
        TOAST_LONG_HOLD_MS,
      );
      return;
    }
    const phaseLabel =
      view.phase === 'active'
        ? '进行中'
        : view.phase === 'paused'
          ? '已暂停'
          : view.phase === 'blocked'
            ? '已受阻'
            : '已完成';
    const lines = [
      `🎯 ${view.objective.slice(0, 80)}`,
      `状态: ${phaseLabel} · 第 ${view.roundsStarted}/${view.maxGoalRounds} 轮 · 续行: ${view.activation === 'armed' ? '已启用' : '已停用'}`,
    ];
    if (view.phase === 'blocked' && view.blockedReason) {
      lines.push(`受阻: ${view.blockedReason.code} — ${view.blockedReason.message.slice(0, 120)}`);
    }
    const hints =
      view.phase === 'complete'
        ? '/goal <新目标> 替换 · /goal clear 清除'
        : view.phase === 'active'
          ? view.activation === 'armed'
            ? '/goal pause 暂停 · /goal edit <新目标> · /goal clear 清除'
            : '/goal resume 继续 · /goal edit <新目标> · /goal clear 清除'
          : '/goal resume 继续 · /goal edit <新目标> · /goal clear 清除';
    lines.push(`可用: ${hints}`);
    showToast(lines.join('\n'), 'info', TOAST_LONG_HOLD_MS);
  }

  /** 当前目标 ref（命令面 CAS 用）；无目标 = null。 */
  goalRef(): { id: string; revision: number } | null {
    const view = this.goalView();
    return view === undefined ? null : { id: view.id, revision: view.revision };
  }
  /** `/goal` 命令面（DSH `command-goal` 语法，2026-10-23）：
   *  - 裸 `/goal` = 状态/用法（不发起运行、不查历史——旧实现把空参当 status 是 bug）；
   *  - `<objective>` = 创建并 arm，空闲则立刻开第 1 轮；
   *  - `pause` / `resume` / `clear` / `edit <objective>` = 生命周期。
   *  控制词只在**整条输入**等于控制词时生效；其余非空后缀一律是目标原文
   *  （`/goal pause after x` 创建该字面目标——与 DSH 同规）。 */
  async goalCommand(arg: string): Promise<void> {
    const host = this.goalHost();
    if (!host) {
      showToast('目标宿主未就绪（Agent 尚未创建）', 'warn');
      return;
    }
    const command = parseGoalCommand(arg);
    const fail = (e: unknown): void => {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`目标操作失败：${msg.slice(0, 160)}`, 'warn', TOAST_LONG_HOLD_MS);
    };
    const currentRef = (): { id: string; revision: number } | null => {
      const current = this.goalRef();
      if (!current) this.showGoalStatus();
      return current;
    };

    switch (command.kind) {
      case 'show':
        this.showGoalStatus();
        return;
      case 'invalid-edit':
        showToast('用法: /goal edit <新目标>', 'info');
        return;
      case 'pause': {
        const current = currentRef();
        if (!current) return;
        try {
          pauseGoal(host, current);
          this.refreshGoalView();
          showToast('⏸️ 目标已暂停 — /goal resume 继续', 'info');
        } catch (e) {
          fail(e);
        }
        return;
      }
      case 'resume': {
        if (this.host.activeExecOf().isRunning) {
          showToast('当前回合仍在运行 — 先停止（或等它结束）再 /goal resume', 'warn');
          return;
        }
        const current = currentRef();
        if (!current) return;
        try {
          resumeGoal(host, current);
          this.refreshGoalView();
          showToast('▶️ 目标已恢复，自动续行继续', 'info');
          this.scheduleGoalDrive();
        } catch (e) {
          fail(e);
        }
        return;
      }
      case 'clear': {
        const current = this.goalRef();
        if (!current) {
          showToast('没有可清除的目标', 'info');
          return;
        }
        try {
          clearGoal(host, current);
          this.refreshGoalView();
          showToast('目标已清除', 'info');
        } catch (e) {
          fail(e);
        }
        return;
      }
      case 'edit': {
        const current = currentRef();
        if (!current) return;
        try {
          editGoal(host, current, { objective: command.objective });
          this.refreshGoalView();
          showToast('✏️ 目标已更新', 'info');
        } catch (e) {
          fail(e);
        }
        return;
      }
      case 'create': {
        if (this.host.activeExecOf().isRunning) {
          showToast('当前回合仍在运行 — 目标需在空闲时创建（先停止或等它结束）', 'warn');
          return;
        }
        try {
          const view = createGoal(host, { objective: command.objective });
          this.refreshGoalView();
          showToast(`🎯 目标已创建（${view.maxGoalRounds} 轮上限），开始第 1 轮`, 'info');
          this.scheduleGoalDrive();
        } catch (e) {
          fail(e);
        }
        return;
      }
    }
  }
}
