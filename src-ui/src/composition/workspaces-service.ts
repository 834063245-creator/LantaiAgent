// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition/workspaces-service — 工作区接线贡献面（批 10 部件一，2026-09-26）。
//
// 病灶（账本 §2.3 `workspace.ts` 行）：工作区激活点里**内联着产品装配**
// （`new Agent/AgentStore/SubAgentPool/GoalManager/MemoryManager/SkillRegistry` +
// 拉起 user-mcp / bundled-engine）——产物无法贡献「工作区打开时要做的事」，
// 于是每个这样的需求都只能把代码写进内核 `workspace.ts`（`bundled-engine` 292 行即此）。
//
// 本面 = 那条缺口的落点：产物在 apply 期 `ctx.workspaces.onActivate(hook)` 登记，
// 工作区激活点按**注册序串行 await** 回调（设计件 §4.1，用户 2026-09-25 裁定 A；
// 第 3 问「允许第三方产物用本面」已裁定：真正敏感的是 MCP 桥，它走 faceDeps 留第一方）。
//
// 语义（逐条可测，与设计件 §4.1 表一一对应）：
//   - **调用时机**：工作区激活点、取组合快照 / `_buildRegistryLocked` **之前**
//     （工具行必须先于注册表构建）；切换工作区 = 旧 fiber dispose → 新工作区重新回调；
//   - **调用序**：注册序串行 await；前一个抛错**不影响**后一个；
//   - **失败隔离**：贡献抛错**不阻断工作区打开**（既有语义保持），错误经 `scope.report`
//     具名可见（错误不静默）；
//   - **生命周期**：登记者经 `ctx.effect` 登记；工作区侧挂 `scope.ctx`（工作区 fiber ctx）
//     的一切随 `fiber.dispose()` 回收，贡献者**不需要写 teardown**；
//   - **子 Agent 不自动继承**（与本仓 hooks / capabilities 同款）；
//   - **缺服务**：无通道环境（工具/单测）= 空贡献面，激活路径零行为变更。

import { type Context, Service } from '../cordis';

/** 接线回执（通用形态；面只负责转状态栏 + 日志，不替贡献者建 store）。 */
export interface WorkspaceWiringReport {
  status: 'wired' | 'failed' | 'off';
  workspacePath: string;
  /** 接线后的可见面规模（如「在册工具数」）——口径由贡献者自定。 */
  toolCount?: number;
  /** 失败原因（人话；status='failed' 时必给）。 */
  reason?: string;
}

/** 一次工作区激活的接线上下文（传给每个贡献回调）。 */
export interface WorkspaceActivationScope {
  /** 工作区根（绝对路径）。 */
  root: string;
  /** 该工作区的 fiber ctx：贡献者挂它的一切随 fiber dispose 自动摘。 */
  ctx: Context;
  /** 接线回执（转状态栏 + 日志；贡献者自己的诊断面由它自己写）。 */
  report(report: WorkspaceWiringReport): void;
}

/** 工作区接线回调。 */
export type WorkspaceActivationHook = (scope: WorkspaceActivationScope) => void | Promise<void>;

/** ctx.workspaces —— 工作区接线贡献面。 */
export class WorkspacesService extends Service {
  private _hooks: WorkspaceActivationHook[] = [];

  constructor(ctx: Context) {
    super(ctx, 'workspaces');
    setActiveWorkspaces(this);
  }

  /** 登记接线回调（注册序 = 调用序）；返回 disposer（调用方经 `ctx.effect` 持有）。 */
  onActivate(hook: WorkspaceActivationHook): () => void {
    this._hooks.push(hook);
    return () => {
      const i = this._hooks.indexOf(hook);
      if (i >= 0) this._hooks.splice(i, 1);
    };
  }

  /** 当前登记数（诊断/测试面读）。 */
  get count(): number {
    return this._hooks.length;
  }

  /** 工作区激活点调用：注册序串行 await，单个抛错不阻断其余（失败隔离 + 具名回执）。 */
  async activate(scope: WorkspaceActivationScope): Promise<void> {
    for (const hook of [...this._hooks]) {
      try {
        await hook(scope);
      } catch (e) {
        // 失败隔离：不阻断工作区打开；错误具名可见（错误不静默纪律）
        scope.report({
          status: 'failed',
          workspacePath: scope.root,
          reason: `接线贡献抛错：${e instanceof Error ? e.message : String(e)}`,
        });
        console.error('[workspaces] 接线贡献抛错（工作区打开继续）:', e);
      }
    }
  }
}

// ── 活动服务读取面（services.ts / root-views-service.ts 同款：模块级单例）──

let _active: WorkspacesService | null = null;

function setActiveWorkspaces(svc: WorkspacesService): void {
  _active = svc;
}

/** 当前服务（无服务 = null——诊断/测试面读用）。 */
export function activeWorkspaces(): WorkspacesService | null {
  return _active;
}

/** 测试复位（生产不调用）。 */
export function resetWorkspacesForTests(): void {
  _active = null;
}

/** 工作区激活点调用面：**无服务 = 空贡献面**（工具/单测环境零行为变更）。 */
export async function activateWorkspaceContributions(scope: WorkspaceActivationScope): Promise<void> {
  await _active?.activate(scope);
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** 工作区接线贡献面（批 10）：产物 apply 期 `onActivate` 登记，
     *  工作区激活点按注册序串行回调。 */
    workspaces: WorkspacesService;
  }
}

/** 挂载插件（`plugins/service-plugins.ts` 表序末位：内核 service 先于产物装载）。 */
export const workspacesServicePlugin = {
  name: 'hologram/composition-workspaces',
  apply(ctx: Context) {
    new WorkspacesService(ctx);
  },
};
