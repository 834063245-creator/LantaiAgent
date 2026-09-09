// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// seam 裁剪面（平台化 Phase 3，2026-08-27）——组合解析产物对各 seam 消费视图
// 的运行时读点（叶模块：零项目内依赖，供 composition/agent 两层安全 import）。
//
// 职责二分（单一权威源裁定，agent-platformization-plan Phase 3 施工设计）：
//   - **注册表 = 实现真源**（谁存在）：六个 seam service 的活动注册表
//     （active*Providers / activeLlmAdapters）；
//   - **组合 = 裁剪真源**（谁生效）：roster 解析产物 per-seam 禁用集——
//     composition-store 的三个写入口（setResolved / setError / resetToFactory）
//     是唯一灌入点（applySeamDisabled）。
//
// 消费视图 = 活动注册表 − 禁用集。**晚注册可见**：组合解析后新注册的
// provider / 动态事件（不在解析时点快照里）不被误裁——除非显式出现在禁用集。
// 过滤收在消费单点（各 service 的 active* 读面 + events.emitLoopEvent），
// 调用方零改动；默认态（空禁用集）= 与 Phase 2 行为逐字节一致。
//
// 域清单：六个 swappable seam（ctx 键名）+ loopEvents（D4 事件面开关域——
// 仅 emit 观测域可开关；tool/guard|preflight|around 是强制层裁决语义，
// 禁用 = 绕 planGate，不开放）。域键即 patch 的 `seam/<域>` 域名后缀。
//
// 模块级可变态归属（CONVENTIONS §1.10 第 4 类——初始化后随组合写入点替换的
// 单键值；生命周期 = 进程，无跨工作区所有权问题：裁剪面是全局组合语义）。

/** seam 域清单（单一真源；roster 的 patch schema 与解析循环由此驱动）。
 *  （graph 域随图谱功能全量退役移除，2026-09-09。） */
export const SEAM_DOMAINS = ['llm', 'subagents', 'fs', 'shell', 'sessionPersistence', 'loopEvents'] as const;

export type SeamDomain = (typeof SEAM_DOMAINS)[number];

/** 各 seam 域的禁用 id 集（ResolvedComposition.seamDisabled 的形状）。 */
export type SeamDisabledMap = Readonly<Record<SeamDomain, readonly string[]>>;

/** 空裁剪面 = 出厂态（与 Phase 2 行为逐字节一致）。 */
export const EMPTY_SEAM_DISABLED: SeamDisabledMap = {
  llm: [],
  subagents: [],
  fs: [],
  shell: [],
  sessionPersistence: [],
  loopEvents: [],
};

let current: SeamDisabledMap = EMPTY_SEAM_DISABLED;

/** 组合写入口灌入（composition-store 三 setter 唯一调用；resolved.seamDisabled）。
 *  undefined/缺域 = 该域无裁剪（容错——解析产物形状演进期不炸消费面）。 */
export function applySeamDisabled(map: SeamDisabledMap | null | undefined): void {
  if (!map) {
    current = EMPTY_SEAM_DISABLED;
    return;
  }
  current = { ...EMPTY_SEAM_DISABLED, ...map };
}

/** 指定域的当前禁用 id 集（消费单点的过滤源；每次返回新 Set——调用方不得持有缓存）。 */
export function seamDisabled(domain: SeamDomain): ReadonlySet<string> {
  return new Set(current[domain] ?? []);
}

/** 当前裁剪面只读快照（诊断/测试面）。 */
export function currentSeamDisabled(): SeamDisabledMap {
  return current;
}

/** 复位出厂态（测试拆卸 / 组合回退兜底）。 */
export function resetSeamDisabled(): void {
  current = EMPTY_SEAM_DISABLED;
}
