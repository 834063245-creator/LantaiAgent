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
//     写**全局当前选择**（applySeamDisabled）。
//
// 裁剪面的两级取值（S6 P2a，2026-09-15——此前只有全局一级）：
//   - **有组合上下文的路径**：传该组合的 seamDisabled 作 view 实参（装配期取值，
//     键 = Agent bus id，携带层见 composition/seam-scope.ts）；
//   - **无组合上下文的旧路径**（无 agent 的工具直调 / UI 直调 / 单测）：
//     view 缺省 ⇒ 读上面的全局当前选择 —— **缺省语义 = P2 前的行为，零漂移**。
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

/** 全局当前选择灌入（composition-store 三 setter 唯一调用；resolved.seamDisabled）。
 *  P2a 起它是**兜底面**：只被「没有组合上下文」的消费路径读到。
 *  undefined/缺域 = 该域无裁剪（容错——解析产物形状演进期不炸消费面）。 */
export function applySeamDisabled(map: SeamDisabledMap | null | undefined): void {
  if (!map) {
    current = EMPTY_SEAM_DISABLED;
    return;
  }
  current = { ...EMPTY_SEAM_DISABLED, ...map };
}

/** 指定域的禁用 id 集（消费单点的过滤源；每次返回新 Set——调用方不得持有缓存）。
 *  view = 调用方所属组合的裁剪面（装配期取值）；**缺省/null = 全局当前选择**
 *  ——无组合上下文的旧路径因此逐字保持 P2 前语义。 */
export function seamDisabled(domain: SeamDomain, view?: SeamDisabledMap | null): ReadonlySet<string> {
  const map = view ?? current;
  return new Set(map[domain] ?? []);
}

/** 全局当前选择只读快照（诊断/测试面；P2a 起仅是无组合上下文的兜底面）。 */
export function currentSeamDisabled(): SeamDisabledMap {
  return current;
}

/** 复位出厂态（测试拆卸 / 组合回退兜底）。 */
export function resetSeamDisabled(): void {
  current = EMPTY_SEAM_DISABLED;
}
