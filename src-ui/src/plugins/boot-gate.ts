// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 装载调度层审计（S4，plugin-bundle-retirement）——
// 装载全部条目 → 等所有 fiber settle（ACTIVE 或 FAILED；PENDING 且依赖永缺
// = 超时判失败）→ 全 ACTIVE 才 provide bootGate 服务；任一 FAILED /
// PENDING 超时 → fail-loud（明确报插件名 + 原始错误，启动不进会话）。
//
// 消费面：创作坞 / Agent 会话入口 inject 'bootGate'——cordis 的 inject 语义
// 自带等待（服务 provide 前消费方 PENDING），消费者零感知。
//
// FiberState 数值对照（vendored cordis const enum 编译期内联，运行时无对象）：
// 0 = PENDING, 1 = LOADING, 2 = ACTIVE, 3 = FAILED, 4 = DISPOSED, 5 = UNLOADING

import { type Context, type Fiber, Service } from '../cordis';

/** boot settle 超时（PENDING fiber 的 await() 立即 resolve——真正卡住的是
 *  LOADING 中的异步 apply 或永不满足的依赖图环）。 */
export const BOOT_SETTLE_TIMEOUT_MS = 30_000;

const FIBER_ACTIVE = 2;

/** bootGate 服务——全树 ACTIVE 审计通过后 provide（会话层 inject 此服务）。 */
class BootGateService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'bootGate');
  }
}

declare module '../cordis/context' {
  interface Context {
    /** boot 审计门（S4）——全插件 settle + 全 ACTIVE 后 provide；
     *  会话入口 inject 此服务确保不进病态会话。 */
    bootGate: BootGateService;
  }
}

/** 收集 root registry 内全部活跃 fiber（boot 审计面）。 */
function collectFibers(root: Context): Fiber[] {
  const fibers: Fiber[] = [];
  root.registry.forEach((runtime) => {
    for (const fiber of runtime.fibers) fibers.push(fiber);
  });
  return fibers;
}

/** 审计结果（fail-loud 时携带逐 fiber 失败清单）。 */
export interface BootAudit {
  ok: boolean;
  failures: string[];
}

/**
 * 装载全部条目后审计——等所有 fiber settle → 全 ACTIVE 才 provide bootGate。
 *
 * settle 语义：`fiber.await()` 对 LOADING fiber 等待惯性完成、对 FAILED 抛错、
 * 对 PENDING fiber 立即 resolve（惯性 undefined）——故 settle 后仍需逐 fiber
 * 检查 state 是否为 ACTIVE；PENDING（state=0）= 依赖永缺，判失败。
 *
 * 超时保底：异步 apply 卡死（LOADING 永不结束）由 BOOT_SETTLE_TIMEOUT_MS
 * 裁定；PENDING 判定本身是确定性的（settle 后查 state）。
 */
export async function auditBoot(root: Context, timeoutMs: number = BOOT_SETTLE_TIMEOUT_MS): Promise<BootAudit> {
  const fibers = collectFibers(root);
  const failures: string[] = [];

  if (fibers.length > 0) {
    // 等 settle（超时保底——惯性中的 LOADING fiber 可能永不结束）
    const timeout = Symbol('timeout');
    const settled = await Promise.race([
      Promise.allSettled(fibers.map((f) => f.await())),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), timeoutMs)),
    ]);

    if (settled === timeout) {
      // 超时——所有非 ACTIVE fiber 都算失败（含 LOADING 卡死 + PENDING 依赖缺）
      for (const fiber of fibers) {
        if (fiber.state !== FIBER_ACTIVE) {
          failures.push(`${fiber.name}: 超时（state=${fiber.state}——异步 apply 卡死或依赖永缺）`);
        }
      }
    } else {
      // settle 完成——逐 fiber 审计
      for (let i = 0; i < fibers.length; i++) {
        const fiber = fibers[i];
        const result = settled[i];
        if (result.status === 'rejected') {
          failures.push(`${fiber.name}: ${(result.reason as Error)?.message ?? String(result.reason)}`);
        } else if (fiber.state !== FIBER_ACTIVE) {
          // PENDING（state=0）= 依赖永缺；DISPOSED/UNLOADING 不该在 boot 期出现
          failures.push(`${fiber.name}: state=${fiber.state}（依赖永缺或非法状态——boot 期应全 ACTIVE）`);
        }
      }
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  // 全 ACTIVE → provide bootGate（会话层 inject 语义放开）
  new BootGateService(root);
  return { ok: true, failures: [] };
}

/** fail-loud 包装——审计失败时抛出结构化错误（启动不进会话）。 */
export function assertBootOk(audit: BootAudit): void {
  if (!audit.ok) {
    throw new Error(
      '[boot-gate] 插件装载失败（fail-loud，不带病运行）:\n' + audit.failures.map((f) => '  - ' + f).join('\n'),
    );
  }
}
