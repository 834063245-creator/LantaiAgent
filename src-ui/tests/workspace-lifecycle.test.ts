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
//   工作区外面。修复 = 恢复链尾部 RPC 全部 withTimeout 有界化 + 状态机 busyMs +
//   stuckRecover 逃生口。
// - 2026-11-05 入口 UX 批（用户拍板）：冷启动不再预开工作区；进入工作区改成
//   「导航先发生」（纸壳展卷页承接 3~5s 的绑定/装配/展卷）——首页的 isBusy 守卫
//   整段删除，逃生口搬到展卷页（20s）。本文件守护新形态。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');
const rowsWs = readFileSync(path.resolve(process.cwd(), 'src/shell/rows/workspace.ts'), 'utf8');
const homeSrc = readFileSync(path.resolve(process.cwd(), 'src/plugins/builtin/sessions-home/SessionsHome.tsx'), 'utf8');
const coldStartSrc = readFileSync(path.resolve(process.cwd(), 'src/shell/rows/cold-start.ts'), 'utf8');
const sheetSrc = readFileSync(path.resolve(process.cwd(), 'src/plugins/builtin/paper-shell/EnteringSheet.tsx'), 'utf8');
const gateSrc = readFileSync(path.resolve(process.cwd(), 'src/plugins/builtin/paper-shell/PaperEntryGate.tsx'), 'utf8');
const entryStoreSrc = readFileSync(path.resolve(process.cwd(), 'src/state/workspace-entry-store.ts'), 'utf8');

/** 截取从 anchor 开始、长度为 span 的源码窗口做断言。 */
function windowOf(anchor: string, span = 4000): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`锚点不存在: ${anchor}`);
  return src.slice(i, i + span);
}

/** 进入流程体（switchWorkspace 起、回首页段前止）。 */
function switchBody(): string {
  return rowsWs.slice(rowsWs.indexOf('async function switchWorkspace'), rowsWs.indexOf('── 离开工作区回首页'));
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
  it('switchWorkspace 尾部 RPC 全部有界化——无裸 await（挂起不再永锁 switching）', () => {
    const body = switchBody();
    for (const anchor of [
      'withTimeout(kernelCreateDirectory(',
      'withTimeout(chatPanel.autoRestoreLastSession(',
      'withTimeout(chatPanel.restoreCanvasSpread(',
    ]) {
      expect(body, `尾部护栏必须覆盖 ${anchor}`).toContain(anchor);
    }
  });

  it('stuckRecover：非 busy no-op + 摘守卫在 leaveToHome 前 + 无条件状态机复位 + 加载态/展卷态复位', () => {
    const body = rowsWs.slice(
      rowsWs.indexOf('export async function stuckRecover'),
      rowsWs.indexOf('export const workspaceFlow'),
    );
    expect(body).toContain('if (!wsMachine.isBusy) return');
    const unreg = body.indexOf("unregisterCloseGuard('paper')");
    const leave = body.indexOf('await leaveToHome()');
    expect(unreg, '摘 paper 守卫必须先于 leaveToHome（防确认弹层二次拦截）').toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(unreg);
    // leaveToHome 的 forceState('idle') 在 workspace?.active 分支内——卡死启动路径
    // shellRefs.workspace 为 null 时该分支不进，逃生口必须自带无条件复位
    expect(body).toContain('if (wsMachine.isBusy) wsMachine.forceState');
    expect(body).toContain('setLoading(false)');
    expect(body, '逃生口必须一并收掉展卷态').toContain('clearWorkspaceEntry()');
  });

  it('stuckRecover 导出进 workspaceFlow（展卷页逃生口调用面）', () => {
    const flow = rowsWs.slice(rowsWs.indexOf('export const workspaceFlow'));
    expect(flow).toContain('stuckRecover');
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

describe('入口 UX 批（2026-11-05）：导航先发生 + 展卷页承接等待', () => {
  it('进入流程顺序：开纸面 → 起展卷态 → 才 await 绑定（点击永不被丢弃）', () => {
    const body = switchBody();
    const openIdx = body.indexOf("dock.openPanel('paper')");
    const beginIdx = body.indexOf('beginWorkspaceEntry(folder, opts?.name)');
    const awaitOpenIdx = body.indexOf('await WorkspaceCls.open(');
    expect(openIdx, '进入流程必须自己打开纸面').toBeGreaterThan(-1);
    expect(beginIdx, '展卷态必须起于第一个 await 之前').toBeGreaterThan(openIdx);
    expect(awaitOpenIdx, '绑定必须晚于导航').toBeGreaterThan(beginIdx);
  });

  it('三段推进 + 失败就地落定（不再抛出/只进状态栏）', () => {
    const body = switchBody();
    expect(body).toContain("setWorkspaceEntryPhase('assembling')");
    expect(body).toContain("setWorkspaceEntryPhase('restoring')");
    expect(body).toContain('failWorkspaceEntry(msg)');
    expect(body, '成功路径由展卷页卸载交还关闭守卫').toContain('clearWorkspaceEntry()');
    // 守卫归展卷页所有（PaperPanel 卸载时的 cleanup 会摘掉流程侧注册的那枚）
    expect(sheetSrc).toContain("registerCloseGuard('paper', guard)");
    expect(sheetSrc).toContain('closeGuards.paper === guard');
    expect(body, '最短停留（防秒开闪烁）').toContain('ENTRY_MIN_MS');
    // 展卷页标题 = 首页给的登记名（点「星云小说」不能翻牌成目录名）
    expect(body).toContain('beginWorkspaceEntry(folder, opts?.name)');
  });

  it('展卷页 = 逃生口新家：20s 回案头 + 8s 慢速提示 + 失败态重试', () => {
    expect(sheetSrc).toContain('STUCK_MS = 20_000');
    expect(sheetSrc).toContain('SLOW_MS = 8_000');
    expect(sheetSrc).toContain('retryWorkspaceEntry');
    expect(sheetSrc).toContain('abortWorkspaceEntry');
    expect(sheetSrc).toContain('回案头');
  });

  it('入口门：展卷态不挂画布（旧区纸面/空案头/可点输入条都不出现）', () => {
    expect(gateSrc).toContain('EnteringSheet');
    expect(gateSrc).toContain('PaperPanel');
    expect(gateSrc).toContain('useWorkspaceEntryStore');
    const i = gateSrc.indexOf('useWorkspaceEntryStore((s) => s.target != null)');
    expect(i).toBeGreaterThan(-1);
    expect(gateSrc).toContain('entering ? <EnteringSheet /> : <PaperPanel />');
  });

  it('首页不再有 busy 守卫：无 isBusy 读面 / 无「请稍候」/ 无强制重置按钮', () => {
    expect(homeSrc).not.toContain('guardBusy');
    expect(homeSrc).not.toContain('wsMachine');
    expect(homeSrc).not.toContain('STUCK_SWITCH_MS');
    expect(homeSrc).not.toContain('请稍候');
    expect(homeSrc).not.toContain('强制重置');
    // 入口 = 直接进（switchWorkspace 自己开纸面 + 起展卷态），并透传登记名
    expect(homeSrc).toContain('workspaceFlow.switchWorkspace(ws, { name: displayName })');
  });

  it('冷启动不再预开工作区（只留启动锚）；进入改由用户动作触发', () => {
    expect(coldStartSrc).not.toMatch(/switchWorkspace\s*\(/);
    expect(coldStartSrc).toContain('Obs.boot(');
    expect(coldStartSrc).toContain('get_last_project');
  });

  it('展卷态是单一写者（流程写、纸壳读）——store 无第二写入口', () => {
    expect(entryStoreSrc).toContain('beginWorkspaceEntry');
    expect(entryStoreSrc).toContain('setWorkspaceEntryPhase');
    expect(entryStoreSrc).toContain('failWorkspaceEntry');
    expect(entryStoreSrc).toContain('clearWorkspaceEntry');
  });
});
