// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent loop 注册表 · 真源产物（S5b，plugin-bundle-retirement）——
// 原 agent/agent-loop/agent-loop-service.ts 整体迁入；类本体 + 挂载插件
// 在产物域，模块级 _activeService 活动面留内核（agent-loop-active.ts，
// runtime.ts 读它）。运行时依赖（Service/ContributionRegistry/
// defaultAgentLoop/setActiveAgentLoop）经宿主桥 mods.faceDeps 取用——
// setActiveAgentLoop 是内核函数引用（闭包桥接），产物构造器调用它写内核态。

import type { AgentLoop } from '../../../agent/agent-loop/types';
import type { Context } from '../../../cordis';
import { ContributionRegistry, defaultAgentLoop, Service, setActiveAgentLoop } from './host';

/** agent loop 注册表服务（S5b 产物域本体）。 */
export class AgentLoopService extends Service {
  private registry = new ContributionRegistry<AgentLoop>('agentLoop');

  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
    // 出厂默认实现（构造期登记——注册表永不为空，装配面免空判）
    this.registry.register(defaultAgentLoop);
    // 经宿主桥写内核活动面（runtime.ts 的 resolveAgentLoop 读它）
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

/** 挂载插件（产物通道装载；先于任何会话装配）。 */
export const agentLoopServicePlugin = {
  name: 'hologram/agent-loop-service',
  apply(ctx: Context) {
    new AgentLoopService(ctx);
  },
};

export default agentLoopServicePlugin;
