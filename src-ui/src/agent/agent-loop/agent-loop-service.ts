// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// agent loop 注册表（平台化 Phase 5 · D13，2026-08-28）——ctx.agentLoop。
//
// 裁定（agent-platformization-plan §3 D13）：流式循环从「永久特权」降为
// **第一方默认实现**（agent/agent-loop/default-loop.ts，行为逐字节一致）。
// 构造期解析：`agentLoop.active() ?? defaultAgentLoop`（AgentOptions.agentLoop
// 显式注入优先——会话工厂/runtime 装配传 ctx 解析产物；无 cordis 环境的
// 直接构造 = 默认实现，单一实现无兼容分支）。第三方通常不替换 loop
// （事件/服务才是扩展面），但契约上可——注册即接管（后注册胜）。
//
// 注册纪律：ContributionRegistry 单一内核复用（重名 id 装载期拒绝 +
// disposer 双守卫）；服务构造即登记默认实现（出厂面自足——无外部注册也
// 有完整可运行 loop，P5-C1 可替换路径证明的一部分）。

import { ContributionRegistry } from '../../composition/services';
import { type Context, Service } from '../../cordis';
import { defaultAgentLoop } from './default-loop';
import type { AgentLoop } from './types';

export class AgentLoopService extends Service {
  private registry = new ContributionRegistry<AgentLoop>('agentLoop');

  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
    // 出厂默认实现（构造期登记——注册表永不为空，装配面免空判）
    this.registry.register(defaultAgentLoop);
    setActiveAgentLoop(this);
  }

  register(loop: AgentLoop): () => void {
    return this.registry.register(loop);
  }

  list(): AgentLoop[] {
    return this.registry.list();
  }

  /** 当前生效 loop（后注册胜——与 llm/renderers 覆盖语义一致）。 */
  active(): AgentLoop {
    const all = this.registry.list();
    return all[all.length - 1] ?? defaultAgentLoop;
  }
}

// ── 消费读取面（活动服务——services.ts 同款第 3 类可变态）──

let _activeService: AgentLoopService | null = null;

function setActiveAgentLoop(svc: AgentLoopService): void {
  _activeService = svc;
}

/** 解析当前生效 loop：注册表活动服务 → 后注册胜；无服务环境 → 默认实现
 *  （单一实现——本表达式不是兼容分支，是默认 provider 的装配缺省）。 */
export function resolveAgentLoop(): AgentLoop {
  return _activeService?.active() ?? defaultAgentLoop;
}

/** 测试复位（生产不调用）。 */
export function resetAgentLoopForTests(): void {
  _activeService = null;
}

// ── ctx 通道声明 ──

declare module '../../cordis/context' {
  interface Context {
    /** agent loop 注册表（平台化 Phase 5 · D13）——默认实现构造期登记，
     *  替换实现 register 即接管（后注册胜）。 */
    agentLoop: AgentLoopService;
  }
}

/** 挂载插件（loader 第一方表——先于任何会话装配）。 */
export const agentLoopServicePlugin = {
  name: 'hologram/agent-loop-service',
  apply(ctx: Context) {
    new AgentLoopService(ctx);
  },
};
