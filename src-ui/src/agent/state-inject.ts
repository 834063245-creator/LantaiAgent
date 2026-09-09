// 状态注入 — Agent 循环的项目状态钩子。
//
// 模式：异步刷新，同步读取。数据通过异步方式收集
// （从 workspace 生命周期回调中 fire-and-forget）并缓存在内存中。
// 钩子同步读取缓存 — 热路径中无异步操作。
//
// 注入点：
//   TurnStart  — onSessionPersisted → 刷新缓存 → 下一轮看到新数据
//   PreRead    — read_file_content 钩子 → 同步读取 diag + blame 缓存
//
// 所有调用都能优雅降级 — 数据不可用时不注入任何内容。
//
// （[简报]/[时间轴] 注入随图谱功能全量退役删除，2026-09-09——
//  run_check 约束检查与引擎时间线均属图数据面；[Git]/[构建]/[LSP]
//  与引擎无关照常保留。）

import { kernelGitCall } from '../rpc-contract';
import type { BuildResult } from './cache-store';
import {
  getBlameCache,
  getBuildResultCache,
  getCacheEpoch,
  getGitCache,
  getGitCacheTs,
  hasBlameEntry,
  setBlameEntry,
  setBuildResultCache,
  setGitCache,
} from './cache-store';
import { parseGitStatusPorcelain } from './git-porcelain';

export type { BuildResult, GitStatusSummary } from './cache-store';
export { invalidateBlameEntry } from './cache-store';

/** LSP 诊断的结构类型 — 与 ui/lsp-client 的 LspDiagnostic 结构一致，
 *  在 agent 层本地定义以保持单向边界（诊断数据由调用方注入）。 */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string | number;
}

/** 诊断数据源 — 由 workspace 注入（UI 拥有 LSP 客户端）。 */
export type DiagnosticsSource = (filePath: string) => LspDiagnostic[];

// ── Git 状态缓存 ──

const GIT_CACHE_MS = 5000;

/** Fire-and-forget 刷新。从 onSessionPersisted 或 turn-start 调用。 */
export async function refreshGitStatus(projectPath: string): Promise<void> {
  const now = Date.now();
  const cached = getGitCache();
  if (cached && now - getGitCacheTs() < GIT_CACHE_MS) return;
  const epoch = getCacheEpoch();
  try {
    // git 域收口（R3-c）：git_status 经 git_cap 能力口直呼（kernelGitCall 用户
    // 路径）——stdout porcelain 在 TS 解析（git-porcelain.ts；形状 = 退役前插件
    // 输出 / Rust utils::parse_status 同形）。
    const status = parseGitStatusPorcelain(await kernelGitCall('git_status', { repo_path: projectPath }));
    // 工作区已切换（缓存被 reset）— 旧项目的在途结果直接丢弃
    if (getCacheEpoch() !== epoch) return;
    setGitCache(
      {
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        dirtyCount: status.files.length,
        dirtyFiles: status.files.slice(0, 15),
      },
      now,
    );
  } catch {
    /* silent */
  }
}

/** 钩子同步读取。 */
export function getGitStatusCached() {
  return getGitCache();
}

// ── Git blame 缓存 ──

/** 对特定文件进行 fire-and-forget 刷新。在 agent 读取文件前调用。 */
export async function refreshGitBlame(projectPath: string, filePath: string): Promise<void> {
  if (hasBlameEntry(filePath)) return;
  if (!filePath.match(/\.(ts|tsx|js|jsx|rs|py|go|java|rb|cs|kt|swift|php|lua|css|html)$/)) return;
  const epoch = getCacheEpoch();
  try {
    // git 域收口（R3-c）：git_blame 经 git_cap 能力口直呼（kernelGitCall 用户
    // 路径）——blame porcelain 行解析本就在 TS（下方逐行扫描）。
    const raw = await kernelGitCall('git_blame', { repo_path: projectPath, file: filePath });
    // 工作区已切换（缓存被 reset）— 旧项目的在途结果直接丢弃
    if (getCacheEpoch() !== epoch) return;
    const lines = raw.split('\n');
    const authors = new Set<string>();
    let latestAuthor = '';
    let latestTime = '';
    for (const line of lines) {
      if (line.startsWith('author ')) {
        const a = line.slice(7).trim();
        if (a) {
          authors.add(a);
          latestAuthor = a;
        }
      }
      if (line.startsWith('author-time ')) latestTime = line.slice(12).trim();
    }
    if (latestAuthor) {
      const ago = latestTime ? timeAgo(parseInt(latestTime, 10) * 1000) : '';
      setBlameEntry(
        filePath,
        `${latestAuthor}${ago ? ', ' + ago : ''}${authors.size > 1 ? ` (+${authors.size - 1} others)` : ''}`,
      );
    }
  } catch {
    /* silent */
  }
}

/** 钩子同步读取。 */
export function getGitBlameCached(filePath: string): string | null {
  return getBlameCache()[filePath] ?? null;
}

// ── 构建/测试结果缓存 ──

/** 由 run_shell 钩子在测试/构建命令完成时调用。
 *  ownerId 为产生该结果的 Agent（executor 注入的 _agent_id）。 */
export function cacheBuildResult(result: ReturnType<typeof getBuildResultCache> & {}, ownerId?: string | null): void {
  setBuildResultCache({ ...(result as BuildResult), ownerId: ownerId ?? null });
}

/** 构建结果的最大滞留时间 — 超时未消费视为陈旧，丢弃不注入。
 *  （无匹配消费者的条目，如子 Agent 产生的结果，靠它兜底清理。） */
const BUILD_RESULT_MAX_AGE_MS = 10 * 60 * 1000;

/** 格式化缓存的构建/测试结果用于 turn-start。读取时消费。
 *  consumerId 提供时只消费同属该 Agent 的条目；
 *  属于其他 Agent 的留在槽位里等本尊，避免跨会话张冠李戴。 */
export function formatBuildResult(consumerId?: string): string | null {
  const r = getBuildResultCache();
  if (!r) return null;
  if (Date.now() - r.ts > BUILD_RESULT_MAX_AGE_MS) {
    setBuildResultCache(null); // 陈旧 — 清除不注入
    return null;
  }
  if (consumerId && r.ownerId && r.ownerId !== consumerId) return null; // 别的 Agent 的 — 不消费
  setBuildResultCache(null); // 消费 — 只注入一次
  const icon = r.outcome === 'pass' ? '✅' : '❌';
  return `[构建] ${icon} ${r.command}: ${r.summary}`;
}

// ── 格式化器 — 从缓存数据构建可注入字符串 ──

/** 格式化 git 状态用于 turn-start 注入。 */
export function formatGitStatus(): string | null {
  const git = getGitCache();
  if (!git || git.dirtyCount === 0) return null;
  // 形状真源 = Rust utils::parse_status（键是 path——旧手写 file 字段名与
  // Rust 不符，曾致有脏文件时 undefined.replace 崩，2026-09-01 边界校验批修复）。
  const fileList = git.dirtyFiles
    .map((f) => `${f.path.replace(/\\/g, '/').split('/').pop()}(${f.status[0].toUpperCase()})`)
    .join(', ');
  return `[Git] ${git.branch}${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''} | ${git.dirtyCount} 脏: ${fileList}`;
}

/** 格式化诊断信息用于 pre-read 注入。 */
export function formatDiagnostics(filePath: string, getDiags: DiagnosticsSource): string | null {
  const diags = getDiags(filePath);
  if (diags.length === 0) return null;
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity === 'warning');
  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} errors`);
  if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
  if (parts.length === 0) return null;
  const top3 = diags
    .slice(0, 3)
    .map((d) => `L${d.startLine + 1}: ${d.message.slice(0, 80)}`)
    .join('; ');
  const fname = filePath.replace(/\\/g, '/').split('/').pop();
  return `[LSP] ${fname}: ${parts.join(', ')}${top3 ? ` — ${top3}` : ''}`;
}

/** 格式化 git blame 用于 pre-read 注入。 */
export function formatBlame(filePath: string): string | null {
  const blame = getGitBlameCached(filePath);
  if (!blame) return null;
  const fname = filePath.replace(/\\/g, '/').split('/').pop();
  return `[Git] ${fname}: ${blame}`;
}

// ── Turn-start 快照 — 用于 system-reminder 注入的完整状态块 ──

/** 从所有缓存数据源构建完整的 turn-start 注入块。
 *  consumerId 用于 buildResult 的归属匹配（见 formatBuildResult）。 */
export function buildTurnStartBlock(consumerId?: string): string {
  const lines: string[] = [];
  const git = formatGitStatus();
  if (git) lines.push(git);
  const build = formatBuildResult(consumerId);
  if (build) lines.push(build);
  return lines.length > 0 ? lines.join('\n') : '';
}

/** 为指定文件构建 pre-read 注入块。 */
export function buildPreReadBlock(filePath: string, getDiags: DiagnosticsSource): string {
  const lines: string[] = [];
  const diag = formatDiagnostics(filePath, getDiags);
  if (diag) lines.push(diag);
  const blame = formatBlame(filePath);
  if (blame) lines.push(blame);
  return lines.join('\n');
}

// ── 辅助函数 ──

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
