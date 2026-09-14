// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理 provider 注册表（平台化 Phase 1 · D3，2026-08-27）——ctx.subagents seam。
//
// 裁定（agent-platformization-plan §3 D3）：spawnSubAgentImpl 从「唯一实现」降为
// 默认 in-process provider（agent/subagent-provider.ts）；消费面 = Agent.spawnSubAgent
// 单点收口（blueprint spawn-tool 绑定与测试直调都经它）。未来 ACP / 外部后端经本
// 注册表挂接；多 provider 共存时取「后注册胜」为默认（对齐 llm/renderers 覆盖语义）。
//
// 注册纪律：ContributionChannel（自 contribution-channel.ts 单一内核复用——重名 id
// 装载期拒绝 + disposer 双守卫）；disposer 经 ctx.effect 登记（调用方所有权）。

import type { SubAgentSpawnHost } from '../agent/subagent-spawn';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';
import { seamDisabled } from './seam-resolution';

/** 子代理派生请求（字段与 Agent.spawnSubAgent 形参一一对应）。 */
export interface SubAgentSpawnArgs {
  description: string;
  prompt: string;
  onProgress?: (chunk: string) => void;
  mode?: 'fork' | 'fresh';
  toolAllowlist?: string[] | null;
  poolSignal?: AbortSignal;
  asyncMode?: boolean;
  agentIdOverride?: string;
  outputSchema?: Record<string, unknown> | null;
}

/** 子代理派生结果（spawnSubAgentImpl 返回形状）。 */
export interface SubAgentSpawnOutcome {
  text: string;
  err?: string;
}

/** 子代理 provider：一个「子代理执行后端」。默认实现 = 进程内 spawnSubAgentImpl。 */
export interface SubagentProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  /** 从宿主 Agent 面派生一个子代理并等待其完成。 */
  spawn(host: SubAgentSpawnHost, args: SubAgentSpawnArgs): Promise<SubAgentSpawnOutcome>;
}

export class SubagentsService extends Service {
  // 请求期解析语义：spawn 单点收口按 provider id 扫描（后注册胜 + 组合裁剪）。
  private registry = new ContributionChannel<SubagentProvider>('subagents', { timing: 'request' });

  constructor(ctx: Context) {
    super(ctx, 'subagents');
    setActiveSubagents(this);
  }

  register(def: SubagentProvider): () => void {
    return this.registry.register(def);
  }

  get(id: string): SubagentProvider | undefined {
    return this.registry.get(id);
  }

  list(): SubagentProvider[] {
    return this.registry.list();
  }
}

// ── 消费读取面（services.ts 同款间接层；模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeSubagents: SubagentsService | null = null;

function setActiveSubagents(svc: SubagentsService): void {
  _activeSubagents = svc;
}

/** 注册表原始清单（寻址行源——factoryComposition 的 `seam/subagents` 域快照
 *  收编本清单；被组合禁用的行仍在此处，patch 才能重新启用）。 */
export function registeredSubagentProviders(): SubagentProvider[] {
  return _activeSubagents?.list() ?? [];
}

/** 当前子代理 provider 贡献（无服务/无注册 = 空集——Agent.spawnSubAgent 的「后注册胜」扫描源）。
 *  裁剪面（平台化 Phase 3）：组合 `seam/subagents` 域禁用的 provider id 从视图剔除。 */
export function activeSubagentProviders(): SubagentProvider[] {
  const disabled = seamDisabled('subagents');
  return registeredSubagentProviders().filter((p) => !disabled.has(p.id));
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** 子代理 provider 注册表（平台化 Phase 1 · D3）——默认 provider = 进程内实现
     *  （agent/subagent-provider.ts）；消费面 = Agent.spawnSubAgent。 */
    subagents: SubagentsService;
  }
}

/** 子代理 service 挂载插件（loader 第一方表；先于 in-process provider 插件）。 */
export const subagentsServicePlugin = {
  name: 'hologram/subagents-service',
  apply(ctx: Context) {
    new SubagentsService(ctx);
  },
};
