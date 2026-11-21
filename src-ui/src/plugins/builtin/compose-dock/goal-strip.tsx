// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-strip — 创作坞底的目标状态条（2026-10-23 DSH 式目标域；2026-11-17 P6 拆出）。
//
// 为什么单独立文件：它是坞里**唯一自带订阅**的表现件（useSyncExternalStore 读
// panel-store.goalView），与坞主体的状态面零交集——搬家是零语义成本的分家。
// 语义（未变）：有目标才渲染（无目标零占位）；控制动作走同一 `/goal` 命令面，
// 不新造第二条写路径。

import { useSyncExternalStore } from 'react';
import { type ChatCore, getChatStore } from './host';

/** 目标状态条 —— 有目标才渲染（无目标零占位）。数据源 = panel-store.goalView
 *  （GoalDriver.bindGoalLog 随本卷日志的 `goal/round` / `goal/change` 实时重读，
 *  命令面 / 切卷 / 轮次收尾仍兜底刷新）；控制动作走同一 `/goal` 命令面，
 *  不新造第二条写路径。 */
export function GoalStrip({ core }: { core: ChatCore | null }) {
  if (!core) return null;
  return <GoalStripLive core={core} />;
}

function GoalStripLive({ core }: { core: ChatCore }) {
  const panel = getChatStore(core.panelId).panel;
  const goal = useSyncExternalStore(
    panel.subscribe,
    () => panel.getState().goalView,
    () => null,
  );
  if (!goal) return null;
  const run = (arg: string) => {
    const cmd = core.builtinCommands().find((c) => c.id === 'goal');
    if (cmd) core.executeCommand(cmd, arg);
  };
  const phase =
    goal.phase === 'active'
      ? '进行中'
      : goal.phase === 'paused'
        ? '已暂停'
        : goal.phase === 'blocked'
          ? '已受阻'
          : '已完成';
  return (
    <div className="pp-goal-strip" role="status" aria-live="polite">
      <span className="pp-goal-strip__mark" aria-hidden="true">
        🎯
      </span>
      <span className="pp-goal-strip__text" data-tip={goal.objective}>
        {goal.objective}
      </span>
      <span className="pp-goal-strip__meta">
        {phase} · 第 {goal.roundsStarted}/{goal.maxGoalRounds} 轮
        {goal.phase === 'active' && goal.activation === 'disarmed' ? ' · 续行已停' : ''}
      </span>
      {goal.phase === 'active' && goal.activation === 'armed' && (
        <button type="button" className="pp-goal-strip__btn" onClick={() => run('pause')}>
          暂停
        </button>
      )}
      {(goal.phase === 'paused' || goal.phase === 'blocked') && (
        <button type="button" className="pp-goal-strip__btn" onClick={() => run('resume')}>
          继续
        </button>
      )}
      {goal.phase !== 'complete' && (
        <button type="button" className="pp-goal-strip__btn pp-goal-strip__btn--quiet" onClick={() => run('clear')}>
          清除
        </button>
      )}
    </div>
  );
}
