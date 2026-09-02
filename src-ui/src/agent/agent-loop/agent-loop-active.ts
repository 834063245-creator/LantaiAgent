// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent loop 活动面（S5b，plugin-bundle-retirement）——
// AgentLoopService 类与挂载插件产物化（plugins/builtin/agent-loop-service/）后
// 留在内核的**模块级活动服务面**：runtime.ts 的 resolveAgentLoop() 读此面，
// 产物域的 AgentLoopService 构造器经宿主桥（faceDeps.setActiveAgentLoop）
// 写此面——内核/产物共享同一份模块态（函数引用桥接，非内联副本）。

import { defaultAgentLoop } from './default-loop';
import type { AgentLoop } from './types';

/** ctx.agentLoop 的结构形状（产物域 AgentLoopService 类的结构上界；
 *  类本体在 plugins/builtin/agent-loop-service/index.ts，构造满足此面）。 */
export interface AgentLoopServiceFace {
  register(loop: AgentLoop): () => void;
  list(): AgentLoop[];
  active(): AgentLoop;
}

// ── 模块级活动服务（services.ts 同款第 3 类可变态——进程级单例）──

let _activeService: AgentLoopServiceFace | null = null;

/** 产物域 AgentLoopService 构造器经宿主桥回写（faceDeps 键——
 *  函数引用桥接内核闭包，产物调用即设内核态）。 */
export function setActiveAgentLoop(svc: AgentLoopServiceFace): void {
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
    /** agent loop 注册表（平台化 Phase 5 · D13；S5b 产物化后类本体在
     *  plugins/builtin/agent-loop-service/——此声明用结构面，内核/产物
     *  双域类型检查共享）。 */
    agentLoop: AgentLoopServiceFace;
  }
}
