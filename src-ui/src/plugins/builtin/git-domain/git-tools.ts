// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git 域工具族（**归家后真源**，2026-09-24 批 4c-1）。
//
// 来历：原 `agent/tools/coding.ts`（一文件载五族）的 git 段整段移出——族内
// schema/编排/description 逐字保留，只把内核依赖改走包内宿主面（`./host`）。
// 内核侧仍留 `agent/git-porcelain.ts`（被 `agent/state-inject.ts` 消费 ⇒ 宿主→插件禁反，
// 随批 6 state-hooks 一并搬）；本包经 faceDeps 取用它的两个解析器。
//
// 表序与描述字节 = 模型面契约（convergence 快照对拍），禁改。

import { z } from 'zod';
import { parseGitLogCommits, parseGitStatusPorcelain, type Tool, type ToolExecutor, toInputJsonSchema } from './host';

// ═══════════════════════════════════════════════════════════════
// git 域模型族 zod 真源（kernel-capability-c3-design.md git 域收口 R3-c，
// 2026-09-05）：builtin.git 插件信封退役，git 域 13 模型族工具 schema 真源
// 回 TS zod——逐键等价于退役前 manifest 的 schema 发射（键名/description/
// default/int 界/additionalProperties 全对齐，convergence 快照
// stableStringify 字典序下零漂移；fs 域 R3-b 同款范式）。git_blame 无模型面
// （state-inject 内部消费）；git_diff_staged 由 git_diff 工具层双目标路由
// 派发（schema 同 unstaged，不经本表模型面）。
// ═══════════════════════════════════════════════════════════════

/** git_status schema——manifest 字节转录（path）。 */
const gitStatusSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_diff_unstaged schema——manifest 字节转录（path/file default "."/staged
 *  default false；staged 由工具层消费做双目标路由，不下沉能力口）。 */
const gitDiffSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  file: z.string().default('.').describe('Optional: specific file to diff. If omitted, shows all unstaged changes.'),
  staged: z.boolean().default(false).describe('Set to true to show staged changes instead of unstaged'),
});

/** git_log schema——manifest 字节转录（path/count default 10）。 */
const gitLogSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  count: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .default(10)
    .describe('Number of recent commits to show (default: 10)'),
});

/** git_stage schema——manifest 字节转录（path/files 逗号串——模型面契约，
 *  工具层拆单后以 files 数组派发）。 */
const gitStageSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  files: z.string().describe('File path(s) to stage, separated by commas. Use "." to stage all.'),
});

/** git_commit schema——manifest 字节转录（path/message/_forceGate）+ files
 *  自动暂存键（2026-09 工具缺陷报告 Bug 2 拍板：commit 接受 files 参数时
 *  先自动暂存再提交，与其它写类工具的参数语义对齐）。 */
const gitCommitSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  message: z.string().describe('Commit message (conventional commits format recommended)'),
  files: z
    .string()
    .optional()
    .describe(
      'File path(s) to stage before committing, separated by commas (same syntax as git stage). Omit to commit whatever is already staged.',
    ),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_push schema——manifest 字节转录（path）。 */
const gitPushSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_pull schema——manifest 字节转录（path）。 */
const gitPullSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_init schema——manifest 字节转录（path——manifest 原文是目录语义）。 */
const gitInitSchema = z.object({
  path: z.string().describe('Absolute path to the directory'),
});

/** git_checkout schema——manifest 字节转录（path/branch/_forceGate）。 */
const gitCheckoutSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  branch: z.string().describe('Branch name to switch to'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_create_branch schema——manifest 字节转录（path/branch）。 */
const gitCreateBranchSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  branch: z.string().describe('New branch name'),
});

/** git_discard schema——manifest 字节转录（path/file/_forceGate）。 */
const gitDiscardSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  file: z.string().describe('File path to discard changes for (relative to repo root)'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_stash_push schema——manifest 字节转录（path/message 可选识别位——退役前
 *  业务即不传给 git，保持原样）。 */
const gitStashPushSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  message: z.string().optional().describe('Optional stash message for identification'),
});

/** git_stash_pop schema——manifest 字节转录（path）。 */
const gitStashPopSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
});

/** git 域动作 → zod schema（schema 真源表；键 = 能力口 action = 退役前
 *  builtin.git 工具名）。 */
const GIT_CAP_SCHEMA: Record<string, z.ZodObject<z.ZodRawShape>> = {
  git_status: gitStatusSchema,
  git_diff_unstaged: gitDiffSchema,
  git_log: gitLogSchema,
  git_stage: gitStageSchema,
  git_commit: gitCommitSchema,
  git_push: gitPushSchema,
  git_pull: gitPullSchema,
  git_init: gitInitSchema,
  git_checkout: gitCheckoutSchema,
  git_create_branch: gitCreateBranchSchema,
  git_stash_push: gitStashPushSchema,
  git_stash_pop: gitStashPopSchema,
  git_discard: gitDiscardSchema,
};

/** git 域动作 → 模型面 description（manifest 字节转录）。 */
const GIT_CAP_DESCRIPTION: Record<string, string> = {
  git_status:
    'Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).',
  git_diff_unstaged:
    'Show the git diff for unstaged changes. Returns unified diff output. Use to review changes before staging/committing.',
  git_log:
    'Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.',
  git_stage: 'Stage files for commit. Use before git_commit to add changes to the staging area.',
  git_commit:
    'Commit changes with a message. Optionally pass files to auto-stage them first (comma-separated, "." stages all — same syntax as git stage); without files, commits whatever is already staged. Returns the commit summary.',
  git_push: 'Push committed changes to the remote repository.',
  git_pull: 'Pull latest changes from the remote repository (fast-forward only, no merge conflicts).',
  git_init: 'Initialize a new git repository in the given directory.',
  git_checkout: 'Switch to a different branch. Use git_create_branch first if the branch does not exist.',
  git_create_branch: 'Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.',
  git_stash_push: 'Stash current uncommitted changes. Use before switching branches with dirty working tree.',
  git_stash_pop:
    'Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.',
  git_discard: 'Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.',
};

/** git 域动作 → readOnly（manifest 字节转录）。 */
const GIT_CAP_READONLY: Record<string, boolean> = {
  git_status: true,
  git_diff_unstaged: true,
  git_log: true,
  git_stage: false,
  git_commit: false,
  git_push: false,
  git_pull: false,
  git_init: false,
  git_checkout: false,
  git_create_branch: false,
  git_stash_push: false,
  git_stash_pop: false,
  git_discard: false,
};

/** 模型面键（manifest 语言）→ git_cap 顶层契约键：path → repo_path 是唯一
 *  折写（c3 §8 repo_path 位）；file/files/message/branch/count 恒等；meta 键
 *  （_agent_id/_forceGate/_callId）原样透传（executor 注入身份）。 */
function toGitCapArgs(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { action };
  for (const [k, v] of Object.entries(args)) {
    if (k === 'path') out.repo_path = v;
    else out[k] = v;
  }
  return out;
}

/** 成功时 git 不打印任何输出的动作——空回执不是错误，但也不该是零信息：模型据此
 *  无法自证"到底做没做"。补一句派生口径 + 回读入口（2026-09-16 反馈回路审计）。 */
const SILENT_GIT_RECEIPTS: Record<string, string> = {
  git_stage:
    '[git] add 完成（git 对成功不打印输出）：暂存区已按 files 更新。要核对用 git(status) 或 git(diff, staged:true)。',
  git_discard: '[git] 工作区改动已丢弃（git 对成功不打印输出）。要核对用 git(status)。',
};

/** git_cap stdout → 模型面输出形状（退役前插件原形状——行为零漂移）：
 *  git_status → JSON {branch,ahead,behind,files}（porcelain 解析，git-porcelain.ts）；
 *  git_log → commits JSON 数组（\x00 split）；其余动作 stdout 直通（diff/blame
 *  的 32K 截断已在能力口内）。唯一增量：零输出动作补可导航回执（见上表）。 */
function shapeGitCapOutput(action: string, raw: string): string {
  if (action === 'git_status') return JSON.stringify(parseGitStatusPorcelain(raw));
  if (action === 'git_log') return JSON.stringify(parseGitLogCommits(raw));
  const silent = SILENT_GIT_RECEIPTS[action];
  if (silent && raw.trim() === '') return silent;
  return raw;
}

/** git 域模型族工具（git 域收口后 schema/description/readOnly 自持 zod 真源，
 *  不再查 builtin.git 镜像）；TS 工具名保持历史名（模型面契约，非能力口
 *  action 名）；execute 走 git_cap 能力口直呼（信封退役；is_agent 由
 *  executor 层 agentInvoke 注入——与 searchCapTool 同构）。 */
function gitCapTool(action: string, localName: string, exec: ToolExecutor): Tool {
  const schema = GIT_CAP_SCHEMA[action];
  const parameters = toInputJsonSchema(schema.passthrough());
  return {
    name: () => localName,
    description: () => GIT_CAP_DESCRIPTION[action],
    parameters: () => parameters,
    readOnly: () => GIT_CAP_READONLY[action] ?? false,
    execute: async (args, onProgress, signal) =>
      shapeGitCapOutput(action, await exec('git_cap', toGitCapArgs(action, args), onProgress, signal)),
  };
}

/** git_stage 拆单编排（git_stage 与 git_commit(files) 共用）：'.'/'all' →
 *  git_stage_all；逗号分隔逐文件派发 git_stage。files 模型面是逗号串（与
 *  能力口 files 数组之间的既有折写）。 */
async function stageFilesViaCap(
  exec: ToolExecutor,
  path: string | undefined,
  files: string,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (files === '.' || files === 'all') {
    return shapeGitCapOutput(
      'git_stage',
      await exec('git_cap', toGitCapArgs('git_stage_all', { path }), onProgress, signal),
    );
  }
  const fileList = files
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (fileList.length === 0) {
    throw new Error("git_stage: 'files' 为空——请给出逗号分隔的文件路径，或用 '.' 暂存全部");
  }
  const results: string[] = [];
  for (const f of fileList) {
    const r = await exec('git_cap', toGitCapArgs('git_stage', { path, files: [f] }), onProgress, signal);
    results.push(r);
  }
  // 空回执归一放在**合并后**：逐文件都成功无输出 → 只出一次可导航回执；
  // 任一文件有输出则整体原样直通（不逐条包话术）。
  return shapeGitCapOutput('git_stage', results.join('\n'));
}

/** git 域工具族（S1-2 从 createCodingTools 迁出；P2-3 起 manifest 驱动 →
 *  R3-c git 域收口后 zod 真源 + git_cap 直呼）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createGitTools(exec: ToolExecutor): Tool[] {
  return [
    gitCapTool('git_status', 'git_status', exec),
    {
      ...gitCapTool('git_diff_unstaged', 'git_diff', exec),
      // git_diff 双目标路由（staged → git_diff_staged / 缺省 →
      // git_diff_unstaged）保留在工具层——staged 由本层消费做路由，
      // 不下沉能力口（模型面 schema 与能力口 action 之间的既有折写）。
      execute: (args, onProgress, signal) => {
        const { staged, ...rest } = args as { staged?: boolean };
        return exec(
          'git_cap',
          toGitCapArgs(staged ? 'git_diff_staged' : 'git_diff_unstaged', rest),
          onProgress,
          signal,
        ).then((raw) => shapeGitCapOutput('git_diff_unstaged', raw));
      },
    },
    gitCapTool('git_log', 'git_log', exec),
    {
      ...gitCapTool('git_stage', 'git_stage', exec),
      // git_stage 拆单（'.'/'all' → git_stage_all；逗号分隔逐文件派发）——
      // 模型面 schema（files 逗号串）与能力口 action 之间的既有折写。
      execute: async (args, onProgress, signal) => {
        const files = String((args as { files?: string }).files ?? '').trim();
        return stageFilesViaCap(exec, (args as { path?: string }).path, files, onProgress, signal);
      },
    },
    {
      ...gitCapTool('git_commit', 'git_commit', exec),
      // git_commit files 自动暂存（2026-09 工具缺陷报告 Bug 2）：模型面给了
      // files 就先 stage 再 commit（与其他写类工具「给什么操作什么」的参数
      // 语义对齐）；不给 files 沿用「提交已暂存内容」。stage 失败时错误直接
      // 上抛（不再空手 commit）。
      execute: async (args, onProgress, signal) => {
        const { files, ...rest } = args as { files?: string };
        const filesStr = String(files ?? '').trim();
        if (filesStr !== '') {
          await stageFilesViaCap(exec, (rest as { path?: string }).path, filesStr, onProgress, signal);
        }
        return shapeGitCapOutput(
          'git_commit',
          await exec('git_cap', toGitCapArgs('git_commit', rest), onProgress, signal),
        );
      },
    },
    gitCapTool('git_push', 'git_push', exec),
    gitCapTool('git_pull', 'git_pull', exec),
    // ── Phase 2b: Git 操作 ──
    gitCapTool('git_init', 'git_init', exec),
    gitCapTool('git_checkout', 'git_checkout', exec),
    gitCapTool('git_create_branch', 'git_create_branch', exec),
    gitCapTool('git_discard', 'git_discard', exec),
    gitCapTool('git_stash_push', 'git_stash_push', exec),
    gitCapTool('git_stash_pop', 'git_stash_pop', exec),
  ];
}
