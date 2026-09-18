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

// ═══════════════════════════════════════════════════════════════
// 状态 hooks — 将自维护的项目事实注入工具结果。
// 数据来源：LSP 诊断、Git status/blame、构建/测试结果。
// ═══════════════════════════════════════════════════════════════

import {
  buildPreReadBlock,
  cacheBuildResult,
  type DiagnosticsSource,
  formatDiagnostics,
  invalidateBlameEntry,
  refreshGitBlame,
} from './state-inject';
import { hasImageRefs } from './tool-images';

const MAX_RESULT_BYTES = 30_000; // leave 2KB headroom below 32KB
const _MAX_STATE_BYTES = 600;

/** Pre-read hook — agent 读文件时注入诊断 + blame。
 *  diagSource 由 workspace 注入（UI 拥有 LSP 客户端）。 */
export function createStateReadHook(projectPath: string, diagSource: DiagnosticsSource): Hook {
  return {
    name: 'state-read',
    shouldEnrich(toolName) {
      return toolName === 'read_file_content';
    },
    async enrich(_toolName, args, result) {
      const filePath = String(args.filePath || args.file_path || '');
      if (!filePath) return result;

      // 发后即忘：为下次刷新 blame
      refreshGitBlame(projectPath, filePath).catch(() => {});

      const block = buildPreReadBlock(filePath, diagSource);
      if (!block) return result;
      // 附图信封（fs read 图片，2026-09-18）：不注入状态前缀——前缀会让信封
      // JSON 解析失败、图静默丢。图片本就没有诊断/blame 可注，跳过语义无损。
      if (hasImageRefs(result)) return result;

      const full = `📋 [状态] ${block}\n${'─'.repeat(40)}\n\n`;
      if (result.length + full.length <= MAX_RESULT_BYTES) {
        return full + result;
      }
      return result;
    },
  };
}

/** Preflight hook — 编辑文件前添加诊断上下文。 */
export function createStatePreflightHook(diagSource: DiagnosticsSource): PreflightHook {
  return {
    name: 'state-preflight',
    shouldCheck(toolName) {
      // 工具名必须与注册表（coding.ts）匹配：edit_file / write_file。
      // （'write_file_content' 从未存在过 — 此 hook 在修复前是死代码。）
      return ['edit_file', 'write_file'].includes(toolName);
    },
    check(_toolName, args) {
      const filePath = String(args.filePath || args.file_path || '');
      if (!filePath) return null;
      // 文件即将被改 — blame 缓存即刻失效，下次 pre-read 重新拉取。
      // （edit 最终被门禁拦下也只是多一次无害的重新拉取。）
      invalidateBlameEntry(filePath);
      return formatDiagnostics(filePath, diagSource);
    },
  };
}

// ── BuildResultHook（post-tool）──
// run_shell 的构建/测试命令完成 → 解析结果 + 缓存（[构建] turn-start 注入源）
// + 即时摘要注入结果顶部。原寄居 graph-context hook 的 run_shell 分支，
// 图谱退役后独立成 hook（行为保留：归属标记 / 解析失败回退通用缓存）。

export function createBuildResultHook(): Hook {
  return {
    name: 'build-result',

    shouldEnrich(toolName: string): boolean {
      return toolName === 'run_shell';
    },

    async enrich(_toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
      // 结果过大或看起来是错误时跳过注入（缓存仍然进行）
      const tooLarge = result.length > MAX_RESULT_BYTES;
      const looksLikeError = /^(error|Error|❌)/.test(result.trimStart());

      const cmd = String(args.command || '');
      const isTest = /pytest|jest|cargo.test|npm.test|go.test|python.-m.pytest/.test(cmd);
      const isBuild = /npm.install|cargo.build|pip.install|make|cmake|npx|yarn/.test(cmd);

      if (isTest || isBuild) {
        // 归属标记：executor 在 execute 前往同一 args 对象注入的 _agent_id
        // （streaming-executor.ts）。turn-start 只消费同 Agent 的构建结果，
        // 避免 A 会话跑的结果注入 B 会话的上下文。
        const ownerId = typeof args._agent_id === 'string' ? args._agent_id : null;
        const parsed = parseBuildOutput(cmd, result);
        let snippet: string | null = null;
        if (parsed) {
          cacheBuildResult(parsed, ownerId);
          snippet = parsed.outcome === 'pass' ? `✅ ${parsed.summary}` : `❌ ${parsed.summary}`;
        } else {
          // 回退：无法识别输出格式，缓存通用结果
          // 让 agent 知道命令已运行 — 只是无法解析结果
          const label = cmd.split(' ').slice(0, 2).join(' ');
          const tail = result.slice(-200).replace(/\n/g, ' ');
          cacheBuildResult({ command: label, outcome: 'pass', summary: `完成 (输出未解析)`, ts: Date.now() }, ownerId);
          snippet = `⚠️ 完成，但无法解析输出格式。尾部: ${tail}`;
        }

        if (!tooLarge && !looksLikeError && snippet && snippet.length > 0) {
          const block = `📊 [构建] ${snippet}\n${'─'.repeat(40)}\n\n`;
          if (result.length + block.length <= MAX_RESULT_BYTES) {
            return block + result;
          }
        }
      }
      return result;
    },
  };
}

// ── 辅助函数 ──

// ── 构建/测试输出解析器 ──
/** 将构建或测试命令的 stdout/stderr 解析为结构化结果。 */
function parseBuildOutput(
  cmd: string,
  output: string,
): { command: string; outcome: 'pass' | 'fail'; summary: string; ts: number } | null {
  const label = cmd.split(' ').slice(0, 2).join(' '); // "cargo build", "npm test"
  const ts = Date.now();

  // Cargo build
  if (/cargo\s+build/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    if (/Finished\s+dev/.test(output) || /Finished\s+release/.test(output))
      return { command: label, outcome: 'pass', summary: '编译通过', ts };
    return null;
  }

  // Cargo test
  if (/cargo\s+test/.test(cmd)) {
    const failures = output.match(/failures:/);
    if (failures) {
      const m = output.match(/(\d+)\s+failed/);
      return { command: label, outcome: 'fail', summary: m ? `${m[1]} failed` : '有失败', ts };
    }
    const m = output.match(/test result: ok(?:\.\s+(\d+)\s+passed)?/);
    if (m) return { command: label, outcome: 'pass', summary: m[1] ? `${m[1]} passed` : '全部通过', ts };
    return null;
  }

  // npm test / jest
  if (/npm\s+(test|run\s+test)|jest|npx\s+jest/.test(cmd)) {
    const failures = output.match(/(\d+)\s+failing/);
    if (failures) return { command: label, outcome: 'fail', summary: `${failures[1]} failing`, ts };
    const m = output.match(/Tests:\s+(\d+)\s+passed/);
    if (m) return { command: label, outcome: 'pass', summary: `${m[1]} passed`, ts };
    return null;
  }

  // pytest
  if (/pytest|python\s+-m\s+pytest/.test(cmd)) {
    const failed = output.match(/(\d+)\s+failed/);
    if (failed && parseInt(failed[1], 10) > 0)
      return { command: label, outcome: 'fail', summary: `${failed[1]} failed`, ts };
    const passed = output.match(/(\d+)\s+passed/);
    if (passed) return { command: label, outcome: 'pass', summary: `${passed[1]} passed`, ts };
    return null;
  }

  // 通用构建（make, cmake, npm install, pip, yarn）
  if (/make|cmake|npm\s+install|pip\s+install|npx|yarn/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length + (output.match(/\bERROR\b/g) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    const warnings = (output.match(/\bwarning\b/gi) || []).length;
    if (/^(npm |yarn )/.test(cmd) && output.includes('added'))
      return { command: label, outcome: 'pass', summary: '安装完成', ts };
    if (warnings > 0) return { command: label, outcome: 'pass', summary: `完成 (${warnings} warnings)`, ts };
    return { command: label, outcome: 'pass', summary: '完成', ts };
  }

  return null;
}
