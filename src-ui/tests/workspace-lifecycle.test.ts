// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace 生命周期守护（T0 静态断言，仿 tests/convergence/gate.mjs 的源码断言先例）。
// 回归背景：
// - H3：forceClearState()（deactivate 超时的紧急路径）此前不调 disposeAll ——
//   每个存活 Agent 的 60s 巡检 timer 永久存活，_enforceTTL 会继续对共享后端发
//   agent_isolation_discard（真实删除 git worktree）；saveState('done') 不落盘留死账。
// - H4（2026-09-09 图谱退役）：runCheck/scheduleCheck/_checkTimer/_active 守卫
//   面随 [简报] run_check 全链退役删除——本守卫测试随行为同批删除。
// - 卡死锁死（2026-09-09 实机事故）：引擎二进制缺席 → 冷启动恢复链挂死 →
//   状态机永停 'switching' → 首页 isBusy 守卫拦截一切点击，用户被锁在所有
//   工作区外面。修复三件：恢复链尾部 RPC 全部 withTimeout 有界化；状态机
//   busyMs 让守卫可判「卡死」；workspaceFlow.stuckRecover 逃生口 + 首页
//   「强制重置」按钮。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');
const rowsWs = readFileSync(path.resolve(process.cwd(), 'src/shell/rows/workspace.ts'), 'utf8');
const homeSrc = readFileSync(path.resolve(process.cwd(), 'src/app/SessionsHome.tsx'), 'utf8');

/** 截取从 anchor 开始、长度为 span 的源码窗口做断言。 */
function windowOf(anchor: string, span = 4000): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`锚点不存在: ${anchor}`);
  return src.slice(i, i + span);
}

describe('forceClearState 紧急路径清理（H3）', () => {
  const body = windowOf('async forceClearState(): Promise<void> {');

  it('disposeAll 在 runtime = null 之前调用（同步），且委托 bag 统一释放', () => {
    const dispose = body.indexOf('.disposeAll()');
    const detach = body.indexOf('this.runtime = null');
    expect(dispose, 'forceClearState 必须调 disposeAll').toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(-1);
    expect(dispose, 'disposeAll 必须先于 runtime 解绑').toBeLessThan(detach);
    // 其余清理（cache）走 fiber effect 单一机制 — forceClearState 委托 _fiber.dispose()
    // #13 修复：fiber.dispose() 改为 await（防与新工作区创建竞态）
    expect(body).toContain('await this._fiber.dispose()');
    expect(body).toContain('bumpWorkspaceEpoch()');
  });

  it('agent 注入缓存清理登记进 bag（reset-agent-caches 清理器）', () => {
    expect(src).toContain("'reset-agent-caches'");
    expect(src).toContain('resetAgentCaches()');
  });
});

describe('回首页真关工作区（2026-09-08 生命周期修复）', () => {
  const leave = rowsWs.slice(rowsWs.indexOf('async function leaveToHome'));

  it('leaveToHome 必须 deactivate 活动工作区（停 Agent/fiber）', () => {
    expect(leave).toContain('workspace.deactivate(chatPanel)');
    expect(leave).toContain('withTimeout');
    expect(leave).toContain('shellRefs.workspace = null');
  });

  it('leaveToHome 清理 projectPath（单一权威 = shell-store）并关 paper 面板', () => {
    expect(leave).toContain("setProjectPath('')");
    expect(leave).toContain("closePanel('paper')");
  });

  it('leaveToHome 推进状态机到 idle（期间 deactivating 防并发切区）', () => {
    expect(leave).toContain("canTransition('deactivating')");
    expect(leave).toContain("forceState('idle')");
  });

  it('escLayer 不再关 paper（回首页 = 有副作用的离开操作，防误触）', () => {
    const esc = rowsWs.slice(rowsWs.indexOf('function escLayer'), rowsWs.indexOf('export const workspaceFlow'));
    expect(esc).toContain("dock.isOpen('settings')");
    expect(esc).not.toContain("closePanel('paper')");
  });

  it('leaveToHome 导出进 workspaceFlow（PaperPanel 确认后调用面）', () => {
    const flow = rowsWs.slice(rowsWs.indexOf('export const workspaceFlow'));
    expect(flow).toContain('leaveToHome');
  });
});

describe('恢复链卡死护栏（2026-09-09 实机事故立法）', () => {
  const home = homeSrc;

  it('switchWorkspace 尾部 RPC 全部有界化——无裸 await（挂起不再永锁 switching）', () => {
    const body = rowsWs.slice(rowsWs.indexOf('async function switchWorkspace'), rowsWs.indexOf('── 离开工作区回首页'));
    for (const anchor of [
      'withTimeout(kernelCreateDirectory(',
      'withTimeout(chatPanel.autoRestoreLastSession(',
      'withTimeout(chatPanel.restoreCanvasSpread(',
    ]) {
      expect(body, `尾部护栏必须覆盖 ${anchor}`).toContain(anchor);
    }
    // 图谱退役（2026-09-09）：workspace_start_watcher（通知泵）随引擎接线
    // 整删——恢复链尾部无引擎侧 RPC，护栏 = 会话根目录/会话/画布恢复三项。
  });

  it('stuckRecover：非 busy no-op + 摘守卫在 leaveToHome 前 + 无条件状态机复位 + 加载态复位', () => {
    const body = rowsWs.slice(
      rowsWs.indexOf('export async function stuckRecover'),
      rowsWs.indexOf('export const workspaceFlow'),
    );
    expect(body).toContain('if (!wsMachine.isBusy) return');
    const unreg = body.indexOf("unregisterCloseGuard('paper')");
    const leave = body.indexOf('await leaveToHome()');
    expect(unreg, '摘 paper 守卫必须先于 leaveToHome（防确认弹层二次拦截）').toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(unreg);
    // leaveToHome 的 forceState('idle') 在 workspace?.active 分支内——卡死冷启动
    // shellRefs.workspace 为 null 时该分支不进，逃生口必须自带无条件复位
    expect(body).toContain('if (wsMachine.isBusy) wsMachine.forceState');
    expect(body).toContain('setLoading(false)');
  });

  it('stuckRecover 导出进 workspaceFlow（首页按钮调用面）', () => {
    const flow = rowsWs.slice(rowsWs.indexOf('export const workspaceFlow'));
    expect(flow).toContain('stuckRecover');
  });

  it('首页守卫可判卡死：STUCK_SWITCH_MS 阈值 + busyMs 读取 + 强制重置按钮', () => {
    expect(home).toContain('STUCK_SWITCH_MS = 60_000');
    expect(home).toContain('shellRefs.wsMachine.busyMs > STUCK_SWITCH_MS');
    expect(home).toContain('workspaceFlow.stuckRecover()');
    expect(home).toContain('强制重置');
  });

  it('状态机 busyMs：进 busy 起算、busy→busy 复合不重置、离 busy 清零（运行时）', async () => {
    const { WorkspaceStateMachine } = await import('../src/lifecycle/state-machine');
    const m = new WorkspaceStateMachine();
    expect(m.busyMs, 'idle 态 busyMs = 0').toBe(0);
    m.transition('switching');
    const t0 = m.busyMs;
    expect(t0, '进 busy 即起算（>=0）').toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.busyMs, 'busy 期间随时间增长').toBeGreaterThan(t0);
    // busy→busy 复合动作（deactivating→switching 是同一用户动作的两段）不重置起点
    m.forceState('deactivating');
    const t1 = m.busyMs;
    expect(t1).toBeGreaterThanOrEqual(5);
    m.forceState('switching');
    expect(m.busyMs, 'busy→busy 不重置起算点').toBeGreaterThanOrEqual(t1);
    // 离 busy 清零
    m.transition('active');
    expect(m.busyMs, '离 busy 清零').toBe(0);
    // 再进 busy 重新起算
    m.transition('switching');
    expect(m.busyMs).toBeLessThan(50);
  });
});
