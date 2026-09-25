// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent loop 活动面（S5b，plugin-bundle-retirement）——
// AgentLoopService 类与挂载插件产物化（plugins/builtin/agent-loop-service/）后
// 留在内核的**模块级活动服务面**：runtime.ts 的 resolveAgentLoop() 读此面，
// 产物域的 AgentLoopService 构造器经宿主桥（faceDeps.setActiveAgentLoop）
// 写此面——内核/产物共享同一份模块态（函数引用桥接，非内联副本）。
//
// 批 9h-2（2026-09-26）：**出厂默认实现随包**（`agent/agent-loop/default-loop.ts`
// → `plugins/builtin/agent-loop-service/default-loop.ts`）⇒ 本文件不再持有兜底实现：
// `resolveAgentLoop()` 无服务时**具名 fail-loud**（此前回落 `defaultAgentLoop`，
// 那正是「实现留内核」的欠账）。名册同批把该产物标 `required`（不可禁用：loop 缺席
// = 一个会话都跑不起来），故生产态走不到这条错误上——它是装载链断掉时的诊断面。

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

/** 缺服务时的具名错误（fail-loud：不静默造一个空 loop 让会话假跑）。 */
const AGENT_LOOP_UNAVAILABLE =
  'AGENT_LOOP_UNAVAILABLE: agent loop 注册表缺席——请确认内置产物 hologram/agent-loop-service 已装载' +
  '（它由 loader 从产物通道装载；该产物不可禁用）。';

/** 解析当前生效 loop：注册表活动服务 → 后注册胜；无服务 = 具名 fail-loud
 *  （批 9h-2：内核不再持有出厂实现兜底）。 */
export function resolveAgentLoop(): AgentLoop {
  if (!_activeService) throw new Error(AGENT_LOOP_UNAVAILABLE);
  return _activeService.active();
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
