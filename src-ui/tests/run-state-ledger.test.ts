// 运行账 = 运行记录表 —— 起/停/收尾的身份语义回归（2026-09-20 结构性收口）。
//
// 旧规格 `exec-state-done-token.test.ts` 随行为退役**同批删除**（它钉的是
// `done(runSignal?)` 令牌守卫，其中「不传令牌 → 无条件复位」正是被拆掉的病灶面）。
// 本文件按**用户操作序列**新写：这些序列就是真机上反复复现的那几条。
//
// 不变式（整套的靶心）：**「这卷在不在跑」= 账上有没有活的运行记录**；
// 每条记录只能由它的持有者按身份注销 —— 「清掉别人的运行」在类型上不可能。

import { describe, expect, it } from 'vitest';

import { createExecState } from '../src/agent/execution-state';

describe('运行账：运行记录表（谁起谁收，按身份注销）', () => {
  it('① 发一轮 → 账上在跑；这一轮收尾 → 账上空闲（读面唯一事实）', () => {
    const exec = createExecState();
    expect(exec.isRunning).toBe(false);
    expect(exec.runState).toEqual({ running: false, kinds: [], count: 0, since: null });

    const run = exec.beginRun('turn');
    expect(exec.isRunning).toBe(true);
    expect(exec.runState.running).toBe(true);
    expect(exec.runState.kinds).toEqual(['turn']);
    expect(exec.abortSignal).toBe(run.signal);

    run.end();
    expect(exec.isRunning).toBe(false);
    expect(exec.runState.count).toBe(0);
    expect(exec.abortSignal).toBeUndefined();
    // 幂等：重复收尾无害
    expect(() => run.end()).not.toThrow();
  });

  it('② 停后立刻重发：旧轮的迟到收尾**不得**清掉新轮（旧模型靠 done(signal) 守卫，现在靠身份）', () => {
    const exec = createExecState();
    const runA = exec.beginRun('wake'); // 唤醒轮（用户按停前在跑的那一轮）
    const stoppedIds = exec.stopAll(); // 用户按停：账同步空闲（界面立刻给答复）
    expect(stoppedIds).toEqual([runA.id]);
    expect(exec.isRunning).toBe(false);
    expect(runA.signal.aborted).toBe(true);

    const runB = exec.beginRun('turn'); // 用户立刻重发
    expect(exec.isRunning).toBe(true);

    runA.end(); // 旧轮此刻才解旋（工具不认 abort 的慢收尾）——只注销自己那条（已被停注销）= no-op
    expect(exec.isRunning).toBe(true);
    expect(exec.abortSignal).toBe(runB.signal);
    expect(runB.signal.aborted).toBe(false); // 新轮没被误杀

    runB.end();
    expect(exec.isRunning).toBe(false);
  });

  it('③ 作废兜底（discardRuns）：只作废点名记录，绝不误伤新轮', () => {
    const exec = createExecState();
    const runA = exec.beginRun('turn');
    const staleIds = [runA.id]; // 调用方在「停」那一刻记下的身份
    exec.stopAll();
    const runB = exec.beginRun('turn');

    exec.discardRuns(staleIds); // 兜底到点：只作废旧身份
    expect(exec.isRunning).toBe(true);
    expect(exec.abortSignal).toBe(runB.signal);

    exec.discardRuns([runB.id]); // 兜底真作废当前记录 → 界面放出来（记录被丢弃）
    expect(exec.isRunning).toBe(false);
    expect(runB.signal.aborted).toBe(true);
    expect(() => runB.end()).not.toThrow(); // 已被作废后再收尾 = no-op
  });

  it('④ 收尾凭证按 signal 认领（Agent 侧）：已登记的 signal 不再是「无主」的', () => {
    const exec = createExecState();
    const run = exec.beginRun('turn');
    const adopted = exec.runFor(run.signal);
    expect(adopted?.id).toBe(run.id); // 认领到的是同一条记录（不新铸）
    expect(exec.runState.count).toBe(1);

    const foreign = new AbortController().signal;
    expect(exec.runFor(foreign)).toBeNull(); // 无主 signal → 由调用方自行登记
    run.end();
  });

  it('⑤ 记录可加：收尾窗口的旧轮 + 刚起的新轮并存 = 两条都真在跑（谁也不顶掉谁）', () => {
    const exec = createExecState();
    const oldRun = exec.beginRun('wake'); // 上一轮：loop 已返回，记录还在收尾窗口
    const newRun = exec.beginRun('wake'); // 延迟唤醒：下一轮已开跑

    // 旧实现 start() 在这里静默换代（abort 旧 controller）——新模型两条都是事实
    expect(oldRun.signal.aborted).toBe(false);
    expect(newRun.signal.aborted).toBe(false);
    expect(exec.runState.count).toBe(2);
    expect(exec.runState.kinds).toEqual(['wake']); // 种类去重，读面不重复报
    expect(exec.abortSignal).toBe(newRun.signal); // 「最新一条」= 后起的

    oldRun.end(); // 旧轮收尾：只减自己那条
    expect(exec.runState.count).toBe(1);
    expect(exec.isRunning).toBe(true);

    exec.stopAll(); // 用户停止：停的是**在跑的**那几条（已收尾的旧轮不在账上，其 signal 不再由账负责）
    expect(newRun.signal.aborted).toBe(true);
    expect(oldRun.signal.aborted).toBe(false);
    expect(exec.isRunning).toBe(false);
  });

  it('⑥ 压缩与回合不同类：可并存（压缩在途开新轮不再互相清账）', () => {
    const exec = createExecState();
    const compact = exec.beginRun('compact');
    const turn = exec.beginRun('turn');

    expect(compact.signal.aborted).toBe(false); // 不同互斥类：都不中止
    expect(exec.runState.running).toBe(true);
    expect([...exec.runState.kinds].sort()).toEqual(['compact', 'turn']);
    expect(exec.runState.since).not.toBeNull();

    compact.end();
    expect(exec.runState.kinds).toEqual(['turn']); // 压缩收尾只减自己那条
    expect(exec.runState.running).toBe(true);

    turn.end();
    expect(exec.isRunning).toBe(false);
  });

  it('⑦ 停止语义完整：abort 全部在跑记录 + 清权限卡队列（会话版本号不受影响）', () => {
    const exec = createExecState();
    let cardResolved: unknown = null;
    exec.registerPermCard(
      (r) => {
        cardResolved = r;
      },
      () => {},
    );
    exec.enqueuePerm(async () => 'x');
    const before = exec.sessionVersion;
    expect(exec.isBusy).toBe(true);

    const a = exec.beginRun('turn');
    const b = exec.beginRun('compact');
    exec.stopAll();

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(exec.isRunning).toBe(false);
    expect(exec.permCardCount).toBe(0);
    expect(cardResolved).toEqual({ allow: false, remember: false });
    // 停止不动 sessionVersion（那是会话代数，另有写者）
    expect(exec.sessionVersion).toBe(before);
  });
});
