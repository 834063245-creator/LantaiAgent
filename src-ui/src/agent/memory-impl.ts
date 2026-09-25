// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent/memory-impl — 记忆域实现登记表 + 「事实保存授权」共享状态（批 9h-4，2026-09-26）。
//
// 形状照抄批 6/7 的接缝（`agent/plan/plan-impl.ts` / `agent/skill-impl.ts`）：契约面住
// `agent/memory-contract.ts`，实现由产物 `plugins/builtin/memory-domain/` 在 apply 期登记；
// 内核调用点改走下方门面（`createMemoryManager` / `memoryBundleIngest`），缺实现 = 具名 fail-loud。
//
// 为什么授权旗标住内核（不是产物）：它是**跨模块一次性授权**——内核 `chat-core` 的 `/remember`
// 命令授予，产物侧的记忆保存工具消费（`authorizeFactSave` / `consumeFactAuthorization`）。
// 有状态的东西留内核、产物经宿主桥取用，是仓库既定纪律（副本状态分裂是划词白屏那一族事故的根）。

import type { MemoryImplementation, MemoryManagerFace } from './memory-contract';

// 登记表是**栈**（后注册胜 + 对称弹出，对齐 `composition/contribution-channel.ts` 的行语义）：
// 批 9h-5 实测——测试域的装配腰（`withFirstParty*Channel`）会加载并 dispose 贡献者 fiber，
// 单值登记会被那次 dispose 抹掉，导致同一测试里「腰跑完之后」的装配撞 fail-loud；
// 栈式登记下，常驻登记（tests/setup.ts）不会被后来者的弹出波及。
const _impls: MemoryImplementation[] = [];

/** 产物登记实现（`memory-domain` 包 apply 期调用；测试域由 `tests/setup.ts` 复现）。 */
export function registerMemoryImplementation(impl: MemoryImplementation): void {
  _impls.push(impl);
}

/** 当前实现 = 栈顶（未登记 = null——诊断/测试面读用）。 */
export function activeMemoryImplementation(): MemoryImplementation | null {
  return _impls.at(-1) ?? null;
}

/** 对称撤销（产物 fiber dispose）：弹出**本 fiber 注册的那一层**，不波及更早的登记。 */
export function clearMemoryImplementation(): void {
  _impls.pop();
}

/** 测试复位（清空整栈；生产不调用）。 */
export function resetMemoryImplementationForTests(): void {
  _impls.length = 0;
}

/** 缺实现时的具名错误（fail-loud：不静默当成「无记忆」）。 */
const MEMORY_DOMAIN_UNAVAILABLE =
  'MEMORY_DOMAIN_UNAVAILABLE: 记忆域实现缺席——请确认内置产物 hologram/memory-domain 已装载' +
  '（它由 loader 从产物通道装载）。';

function requireImpl(): MemoryImplementation {
  const impl = activeMemoryImplementation();
  if (!impl) throw new Error(MEMORY_DOMAIN_UNAVAILABLE);
  return impl;
}

/** 门面：建工作区级记忆管理器（`workspace.ts` 装配期调用）。 */
export function createMemoryManager(projectPath: string, globalDir?: string): MemoryManagerFace {
  return requireImpl().createManager(projectPath, globalDir);
}

/** 门面：摄入会话到记忆束（`workspace.ts` 会话落盘回调调用；错误由调用方 catch）。 */
export function memoryBundleIngest(
  messages: Array<{ role: string; content: string }>,
  userId?: string,
  sessionId?: string,
): Promise<boolean> {
  return requireImpl().bundleIngest(messages, userId, sessionId);
}

// ── 事实保存授权（一次性旗标：`/remember` 授予 → 下一次 fact save 消费）──
//
// 抗滥用设计（原注释随迁）：Agent 无法自行授予——只有内核 `/remember` 处理器能调
// `authorizeFactSave()`；保存工具消费一次即失效（`consumeFactAuthorization`）。

let _factAuthorized = false;

/** 授权下一次「事实保存」（内核 `/remember` 处理器专用）。 */
export function authorizeFactSave(): void {
  _factAuthorized = true;
}

/** 消费授权（保存工具调用；返回 true = 本次允许）。 */
export function consumeFactAuthorization(): boolean {
  const ok = _factAuthorized;
  _factAuthorized = false;
  return ok;
}

/** 测试复位（生产不调用）。 */
export function resetFactAuthorizationForTest(): void {
  _factAuthorized = false;
}

export type { MemoryEntry, MemoryImplementation, MemoryManagerFace, MemorySavedInfo } from './memory-contract';
