// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git porcelain 解析——git 域收口（kernel-capability-c3-design.md §8）自 Rust
// 迁回 TS 的编排面：git_cap 能力口返回 run_git stdout 文本，本模块把它解析成
// 退役前 builtin.git 插件的结构化输出（行为零漂移——utils::parse_status /
// git_status 头解析 / git_log \x00 split 的逐行转录）。
//
// 消费方：agent/tools/coding.ts 的 git_status/git_log 模型族工具 +
// agent/state-inject.ts 的状态栏注入。

/** git_status files 元素（Rust utils::parse_status 同形——键是 path 非 file）。 */
export interface GitStatusFile {
  path: string;
  status: string;
  staged: boolean;
  old_path?: string;
}

export interface GitStatusParsed {
  branch: string;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

export interface GitLogCommit {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

/** Rust str::lines() 语义（\n 分割 + 每行尾部单个 \r 剥除 + 末行无换行容忍）。 */
function rustLines(raw: string): string[] {
  if (raw === '') return [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** `git status --porcelain` 文件行解析（Rust utils::parse_status 逐行转录）：
 *  每行 `XY <path>`（X = staged 态 / Y = worktree 态）；重命名行为
 *  `R  old -> new`。状态映射与 staged 判定保持原实现语义不变。 */
function parseStatusPorcelain(raw: string): GitStatusFile[] {
  return rustLines(raw)
    .filter((l) => l !== '')
    .map((line) => {
      const st = line.length >= 4 ? line.slice(0, 2) : '  ';
      const path = line.length >= 4 ? line.slice(3).trim() : line;
      const trimmed = st.trim();
      let status: string;
      if (trimmed === 'M') status = 'modified';
      else if (trimmed === 'A') status = 'added';
      else if (trimmed === 'D') status = 'deleted';
      else if (trimmed === 'R') status = 'renamed';
      else if (trimmed === 'C') status = 'copied';
      else if (trimmed === '?') status = 'untracked';
      else if (st.startsWith(' ') && st.endsWith('M')) status = 'modified';
      else if (st.startsWith(' ') && st.endsWith('D')) status = 'deleted';
      else status = 'modified';
      const staged = !st.startsWith(' ') && st !== '??';
      const isRename = st.includes('R');
      let displayPath = path;
      let oldPath: string | undefined;
      if (isRename && path.includes(' -> ')) {
        const parts = path.split(' -> ');
        displayPath = parts[1] ?? path;
        oldPath = parts[0];
      }
      const file: GitStatusFile = { path: displayPath, status, staged };
      if (oldPath !== undefined) file.old_path = oldPath;
      return file;
    });
}

/** `git status --branch --porcelain` 输出解析（Rust git_status 头解析 + parse_status
 *  的逐行转录）：首行 `## <branch>...<upstream> [ahead N, behind M]` 头部，
 *  其余行 = porcelain 文件行。返回与退役前插件输出同形的结构。 */
export function parseGitStatusPorcelain(raw: string): GitStatusParsed {
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const lines = rustLines(raw);
  const firstLine = lines[0] ?? '';
  if (firstLine.startsWith('## ')) {
    const header = firstLine.slice(3);
    const dotPos = header.indexOf('...');
    if (dotPos >= 0) {
      branch = header.slice(0, dotPos);
      const rest = header.slice(dotPos);
      for (const part of rest.split(/[[\],]/)) {
        const trimmed = part.trim();
        if (trimmed.startsWith('ahead ')) {
          ahead = Number.parseInt(trimmed.slice(6), 10) || 0;
        } else if (trimmed.startsWith('behind ')) {
          behind = Number.parseInt(trimmed.slice(7), 10) || 0;
        }
      }
    } else {
      branch = header.trim();
    }
  }
  return { branch, ahead, behind, files: parseStatusPorcelain(lines.slice(1).join('\n')) };
}

/** `git log --pretty=format:%H%x00%h%x00%s%x00%an%x00%ai` 输出解析（Rust
 *  git_log 的 \x00 split 逐行转录）：每行一提交五字段，缺字段行丢弃。 */
export function parseGitLogCommits(raw: string): GitLogCommit[] {
  const commits: GitLogCommit[] = [];
  for (const line of rustLines(raw)) {
    if (line === '') continue;
    const parts = line.split('\x00');
    if (parts.length >= 5) {
      commits.push({
        hash: parts[0] ?? '',
        short: parts[1] ?? '',
        message: parts[2] ?? '',
        author: parts[3] ?? '',
        date: parts[4] ?? '',
      });
    }
  }
  return commits;
}
