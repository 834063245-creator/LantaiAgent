// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace 生命周期守护（T0 静态断言，仿 tests/convergence/gate.mjs 的源码断言先例）。
// 回归背景：
// - H3：forceClearState()（deactivate 超时的紧急路径）此前不调 disposeAll ——
//   每个存活 Agent 的 60s 巡检 timer 永久存活，_enforceTTL 会继续对共享后端发
//   agent_isolation_discard（真实删除 git worktree）；saveState('done') 不落盘留死账。
// - H4：runCheck 在途 RPC resolve 后无 _active 守卫 —— 旧项目检查结果写进
//   新项目 dock store 并自动弹开 check 面板。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');
const rowsWs = readFileSync(path.resolve(process.cwd(), 'src/shell/rows/workspace.ts'), 'utf8');

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

describe('runCheck/scheduleCheck 切换守卫（H4）', () => {
  it('runCheck 入口有 _active 守卫', () => {
    const body = windowOf('async runCheck(): Promise<void> {');
    expect(body.slice(0, 200)).toContain('this._active');
  });

  it('scheduleCheck 入口有 _active 守卫', () => {
    const body = windowOf('scheduleCheck(): void {');
    expect(body.slice(0, 200)).toContain('this._active');
  });

  it('finally 重武装 checkTimer 前有 _active 守卫', () => {
    const body = windowOf('async runCheck(): Promise<void> {');
    const finallyIdx = body.indexOf('finally');
    expect(finallyIdx).toBeGreaterThan(-1);
    const tail = body.slice(finallyIdx);
    expect(tail).toContain('this._active');
  });
});

describe('回首页真关工作区（2026-09-08 生命周期修复）', () => {
  const leave = rowsWs.slice(rowsWs.indexOf('async function leaveToHome'));

  it('leaveToHome 必须 deactivate 活动工作区（停 watcher/引擎/Agent）', () => {
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
