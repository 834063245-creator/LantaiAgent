// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 装配期 seam 作用域（S6 P2a，2026-09-15）——把「组合裁剪面」从模块级单值
// 推进到「每 Agent 一份值」的携带层。
//
// 背景：seam 裁剪面此前是模块级单值（seam-resolution.ts 的 `current`），唯一
// 灌入点 = composition-store 三个 setter ⇒ **一份卷选 minimal 波及所有卷**。
// P2 把「全局当前选择」降级为**无组合上下文的兜底面**，有组合上下文的路径按
// 键（= owner id / Agent bus id）查本表取该组合的裁剪面。
//
// 为什么是键控表而不是 ToolRowContext 值注入（施工单 WO-S6P2 §2 的实测证据）：
// fs/shell 两族的工具实例经 plugins/builtin/contribution-helpers.ts 的
// `family ??= build(rowCtx.codingExec)` **锁存在首次装配的 rowCtx 上** ⇒ 往
// ToolRowContext 扩字段对这两族结构性无效（除非改缓存语义，或把插件通道契约
// 一并改动）。键控表是仓库既有形态：先例 agent/session-context.ts 的
// OwnerContext（装配期注册 + 调用点按 executor 注入的 _owner_id 查表）。
//
// 值 = SeamDisabledMap（**裁剪面**，不是 provider 列表）：注册表仍是实现真源、
// 消费视图仍是「注册表 − 本组合裁剪集」——**晚注册 provider 仍可见**（该语义
// 由 tests/seam-composition.test.ts ② 钉住，本层不引入新语义）。
//
// 生命周期：装配期 registerSeamScope 登记，disposer 由调用方挂 ctx.effect
// （与 session-context 同款）——Agent 拆卸即清行，无泄漏面。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（键控自清理注册表）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引 seam-resolution）——本
// 文件一旦引入 state/*-store 或 composition/preset-assembly 的静态边即成环
// （症状见 tests/composition-import-cycle.test.ts 头注），守卫逐项钉住。

import type { SeamDisabledMap } from './seam-resolution';

const scopes = new Map<string, SeamDisabledMap>();

/** 装配期登记某键（= Agent bus id）的组合裁剪面。返回 disposer（挂 ctx.effect）。
 *  同键重复登记 = 覆盖（后写胜——与注册表面「后注册胜」同序）。 */
export function registerSeamScope(key: string, view: SeamDisabledMap): () => void {
  scopes.set(key, view);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // 幂等 + 只删自己那一版：后注册者已覆盖时不得把新值一并删掉。
    if (scopes.get(key) === view) scopes.delete(key);
  };
}

/** 读某键的裁剪面。未登记（无组合上下文：单测 / UI 直调 / 旧无 agent 路径）→
 *  undefined——消费点据此回退「全局当前选择」（= P2 前的行为，零漂移）。 */
export function seamScopeOf(key: string | undefined | null): SeamDisabledMap | undefined {
  if (!key) return undefined;
  return scopes.get(key);
}

// ── 发起方身份与 seam 裁剪读面（2026-09-24 批 4c-3 从 agent/tools/coding.ts 上收）──
// fs/shell 两族共用的入参解析；两族的产物包经 faceDeps 取用（host 面）。
export function ownerIdOf(args: Record<string, unknown>): string | undefined {
  return typeof args._owner_id === 'string'
    ? args._owner_id
    : typeof args._agent_id === 'string'
      ? args._agent_id
      : undefined;
}

/** 本调用所属 Agent 的组合裁剪面（S6 P2a）——装配期登记、请求期查表
 *  （本文件）。未登记（无组合上下文/UI 直调/单测）= undefined
 *  ⇒ 消费点落全局当前选择（P2 前语义，零漂移）。 */
export function ownerSeamView(args: Record<string, unknown>) {
  return seamScopeOf(ownerIdOf(args));
}

/** 测试隔离辅助——清空全部作用域（生产代码禁用）。 */
export function clearSeamScopesForTest(): void {
  scopes.clear();
}
