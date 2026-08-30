// execution-state done(runSignal) 守卫回归 — 并发会话收尾串线根治。
//
// 背景（2026-08-31 运行态挂起诊断）：三处轮次收尾曾用「结算时刻的活跃卷」
// exec 调 done()——切卷后旧卷 exec 永卡 isRunning=true（侧栏石青点常驻/
// 发消息被当插话吞掉），且新轮在跑时被旧轮的迟到 done 打翻状态（停止
// 按钮失效的僵尸轮）。修复 = done() 接受发起轮次的 signal 作 token，
// 仅当它仍是 exec 当前持有的 signal（或 controller 已被 stop 清空）才复位。

import { describe, expect, it } from 'vitest';
import { createExecState } from '../src/agent/execution-state';

describe('ExecStateInstance.done(runSignal) — signal token 守卫', () => {
  it('本轮 signal 仍是当前 signal → 正常复位', () => {
    const exec = createExecState();
    const s1 = exec.start();
    expect(exec.isRunning).toBe(true);
    exec.done(s1);
    expect(exec.isRunning).toBe(false);
    expect(exec.abortSignal).toBeUndefined();
  });

  it('新轮已 start（controller 换代）后旧轮迟到结算 → 不清新轮状态', () => {
    const exec = createExecState();
    const s1 = exec.start();
    const s2 = exec.start(); // start 会 abort 旧 controller 并换代
    exec.done(s1); // 旧轮迟到 settle
    expect(exec.isRunning).toBe(true); // 新轮仍在跑
    expect(exec.abortSignal).toBe(s2); // 新轮 controller 未被清
    exec.done(s2);
    expect(exec.isRunning).toBe(false);
  });

  it('stop 已清 controller → 带旧 signal 的 done 幂等无害', () => {
    const exec = createExecState();
    const s1 = exec.start();
    exec.stop();
    expect(exec.isRunning).toBe(false);
    expect(() => exec.done(s1)).not.toThrow();
    expect(exec.isRunning).toBe(false);
  });

  it('不传 token → 无条件复位（向后兼容旧调用面）', () => {
    const exec = createExecState();
    exec.start();
    exec.done();
    expect(exec.isRunning).toBe(false);
  });
});
