// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 宿主生命周期贡献面守卫（批 10 同窗，2026-09-26）——两条新通道的语义钉住：
//   A. `ctx.workspaces`（工作区接线贡献面，设计件 §4.1）
//   B. `ctx.shellRows`（壳行贡献通道，设计件 §9.2）
//
// 判据（逐条对应设计件表）：
//   ① 服务装载后可登记、disposer 摘行（登记经 ctx.effect = fiber 生命周期）；
//   ② 工作区接线**按注册序串行**（不是并发）；
//   ③ 单个贡献抛错**不阻断**其余贡献、也**不阻断工作区打开**（错误具名经 scope.report）；
//   ④ 无服务环境（工具/单测）= 空贡献面，激活/引导路径零行为变更；
//   ⑤ 贡献壳行**追加在内核行之后**（注册序）——`bootShell` 的取用面同源。

import { describe, expect, it } from 'vitest';
import { builtinShellRows } from '../src/composition/shell-rows';
import {
  activeShellRows,
  activeShellRowsService,
  resetShellRowsForTests,
  ShellRowsService,
} from '../src/composition/shell-rows-service';
import {
  activateWorkspaceContributions,
  activeWorkspaces,
  resetWorkspacesForTests,
  WorkspacesService,
} from '../src/composition/workspaces-service';
import { Context } from '../src/cordis';

describe('ctx.workspaces —— 工作区接线贡献面', () => {
  it('登记 / 注册序串行 / disposer 摘行', async () => {
    resetWorkspacesForTests();
    const svc = new WorkspacesService(new Context());
    expect(activeWorkspaces()).toBe(svc);
    const order: string[] = [];
    const offA = svc.onActivate(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('a');
    });
    svc.onActivate(() => {
      order.push('b');
    });
    await activateWorkspaceContributions({ root: '/ws', ctx: new Context(), report: () => {} });
    // 串行：a 的 await 完成后才轮到 b（并发的话 b 会先入列）
    expect(order).toEqual(['a', 'b']);
    offA();
    order.length = 0;
    await activateWorkspaceContributions({ root: '/ws', ctx: new Context(), report: () => {} });
    expect(order).toEqual(['b']);
    expect(svc.count).toBe(1);
  });

  it('失败隔离：一个贡献抛错不阻断其余，且经 scope.report 具名可见', async () => {
    resetWorkspacesForTests();
    const svc = new WorkspacesService(new Context());
    const seen: string[] = [];
    const reports: Array<{ status: string; reason?: string }> = [];
    svc.onActivate(() => {
      throw new Error('炸了');
    });
    svc.onActivate(() => {
      seen.push('after');
    });
    await expect(
      activateWorkspaceContributions({
        root: '/ws',
        ctx: new Context(),
        report: (r) => reports.push({ status: r.status, reason: r.reason }),
      }),
    ).resolves.toBeUndefined(); // 不 reject（不阻断工作区打开）
    expect(seen).toEqual(['after']);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.reason).toContain('炸了');
  });

  it('无服务 = 空贡献面（零行为变更）', async () => {
    resetWorkspacesForTests();
    expect(activeWorkspaces()).toBeNull();
    await expect(
      activateWorkspaceContributions({ root: '/ws', ctx: new Context(), report: () => {} }),
    ).resolves.toBeUndefined();
  });
});

describe('ctx.shellRows —— 壳行贡献通道', () => {
  it('登记 / list 注册序 / disposer 摘行', () => {
    resetShellRowsForTests();
    const svc = new ShellRowsService(new Context());
    expect(activeShellRowsService()).toBe(svc);
    const off = svc.register({ id: 'plugin/x/a', boot: () => {} });
    svc.register({ id: 'plugin/x/b', boot: () => {} });
    expect(svc.list().map((r) => r.id)).toEqual(['plugin/x/a', 'plugin/x/b']);
    off();
    expect(svc.list().map((r) => r.id)).toEqual(['plugin/x/b']);
  });

  it('贡献行追加在内核行之后（引导序 = 内核表序 → 贡献注册序）', () => {
    resetShellRowsForTests();
    const svc = new ShellRowsService(new Context());
    svc.register({ id: 'plugin/hologram/settings-domain/shell-update-check', boot: () => {} });
    const kernelIds = builtinShellRows().map((r) => r.id);
    const bootOrder = [...kernelIds, ...activeShellRows().map((r) => r.id)];
    expect(bootOrder.at(-1)).toBe('plugin/hologram/settings-domain/shell-update-check');
    expect(bootOrder.length).toBe(kernelIds.length + 1);
    // §4-9：update-check 已随包 ⇒ 内核表末位是 shell-cold-start（内核行 11 → 10）
    expect(kernelIds.at(-1)).toBe('hologram/shell-cold-start');
    expect(kernelIds).not.toContain('hologram/shell-update-check');
  });

  it('无服务 = 空集（零行为变更）', () => {
    resetShellRowsForTests();
    expect(activeShellRowsService()).toBeNull();
    expect(activeShellRows()).toEqual([]);
  });
});
