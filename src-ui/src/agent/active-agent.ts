// 活跃根 Agent 登记表 —— 给「没有 turn 的消费者」一个派生入口。
//
// 为什么需要：`Agent.spawnSubAgent` 是实例方法，平时由工具在 turn 内调用
// （tool 执行时手上有父 Agent）。插件面板上的按钮没有 turn，也就没有 Agent
// 引用，于是「点了开始，派 4 个子代理并行跑」这条路走不通。
//
// 登记纪律（照搬本代码库的 setActiveXxx 惯例）：
//   - 只登记**根 Agent**（parentId 为空且 subagentDepth = 0）——子 Agent 由
//     spawnSubAgent 自己造，登记进来会覆盖父级，等于让插件拿子当父；
//   - 按「后建胜」取当前（多会话并存时取最近打开的那个，够用且可预期）；
//   - 注销走 ctx.effect 的对称清理（与 bus-unregister / session-context 同款）。
//
// 消费面只有一个：插件宿主桥的 `host.agent.spawn(...)`（plugins/loader.ts）。

import type { Agent } from './agent';

const roots = new Set<Agent>();

export function registerRootAgent(a: Agent): void {
  roots.add(a);
}

export function unregisterRootAgent(a: Agent): void {
  roots.delete(a);
}

export function listRootAgents(): Agent[] {
  return [...roots];
}

/** 当前根 Agent（后建胜）；无会话时为 null。 */
export function activeRootAgent(): Agent | null {
  const all = [...roots];
  return all.length > 0 ? all[all.length - 1] : null;
}
