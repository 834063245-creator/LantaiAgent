// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Hooks —— Agent 调工具时自动注入状态上下文
//
// 两层架构：
//   1. PreflightHook（pre-tool）：edit_file / write_file 之前 → ⚠️ 诊断警告注入结果顶部
//   2. 状态 hooks（post-tool）：read_file → 📋 诊断 + git blame；
//      run_shell（构建/测试命令）→ 📊 构建结果缓存 + 即时摘要
//      （[构建] turn-start 注入的数据源 = cacheBuildResult）。
//
// 设计约束：
//   - 注入内容 < 800 字符，避免膨胀 token
//   - 结果接近 32KB 上限时跳过注入
//   - Hook 崩溃静默降级，绝不影响工具结果
//
// （图谱 hooks——GraphContext/EngineSnapshot/graph-context/graph-preflight——
//  随图谱功能全量退役删除，2026-09-09；构建结果解析与缓存原寄居 graph-context
//  hook 的 run_shell 分支，随批独立成 build-result hook 保留。）
//
// 批 6c（2026-09-24）：**第一方出厂 hook 实现已归产物包** `plugins/builtin/state-hooks/`
// （state-read / state-preflight / build-result / board-file-tracking 四工厂 + 构建输出解析器）。
// 本文件自此只剩**机制**：两个接口 + 两个注册表类（七处内核消费：agent / context / events /
// runtime / subagent-spawn / agent-loop 契约 / composition/hook-service）。内核 capability 经
// `agent/state-hooks-impl.ts` 登记表取用出厂实现（service 类：缺实现装配期 fail-loud）。

// ── Hook 接口 ──

import type { Disposer } from './lifecycle';

export interface Hook {
  name: string;
  shouldEnrich(toolName: string, args: Record<string, unknown>): boolean;
  enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string>;
}

// ── HookRegistry ──

/** 单 hook 富化超时——hook 是结果路径上的观测增强面，诊断源卡死
 *  不得拖住工具结果（超时回落到未富化结果；错误路径已有 catch 降级）。
 *  3s：诊断富化是毫秒级本地查询的正常量级，超过即视为源不可用。 */
const HOOK_ENRICH_TIMEOUT_MS = 3_000;

export class HookRegistry {
  private hooks: Hook[] = [];

  /** 注册 hook 并返回所有权清理器（Phase 1 disposer 契约）。幂等。 */
  register(hook: Hook): Disposer {
    this.hooks.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  async apply(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
    let enriched = result;
    for (const hook of this.hooks) {
      try {
        if (hook.shouldEnrich(toolName, args)) {
          enriched = await Promise.race([
            hook.enrich(toolName, args, enriched),
            new Promise<string>((resolve) => setTimeout(() => resolve(enriched), HOOK_ENRICH_TIMEOUT_MS)),
          ]);
        }
      } catch (e) {
        // Hook 崩溃静默降级
        console.error(`[HookRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    return enriched;
  }
}

// ── Preflight Hook（pre-tool）──
// 在 edit_file / write_file 执行前注入诊断上下文（LSP errors/warnings），
// 返回 ⚠️ 警告字符串注入到工具结果顶部。

export interface PreflightHook {
  name: string;
  /** 哪些工具触发预检 */
  shouldCheck(toolName: string, args: Record<string, unknown>): boolean;
  /** 返回警告字符串（注入结果顶部），或 null 表示无风险 */
  check(toolName: string, args: Record<string, unknown>): string | null;
}

export class PreflightHookRegistry {
  private hooks: PreflightHook[] = [];

  /** 注册 preflight hook 并返回所有权清理器（Phase 1 disposer 契约）。幂等。 */
  register(hook: PreflightHook): Disposer {
    this.hooks.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** 运行所有匹配的 hook 并聚合其警告（原来是首个匹配生效，
   *  会静默遮蔽后续每个 hook）。 */
  check(toolName: string, args: Record<string, unknown>): string | null {
    const warnings: string[] = [];
    for (const hook of this.hooks) {
      try {
        if (hook.shouldCheck(toolName, args)) {
          const warning = hook.check(toolName, args);
          if (warning) warnings.push(warning);
        }
      } catch (e) {
        console.error(`[PreflightHookRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }
}
