import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type ToolExecutor, ToolRegistry } from '../../src/agent/tool';
import { createCodingTools } from '../../src/agent/tools/coding';
import { defineTool } from '../../src/agent/tools/define-tool';
import { createSearchTools, createWebTools } from '../../src/agent/tools/manifest-tools';
import type { TrialGraphData } from './ab-graph';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '.lantai', 'dist', '.cache', 'build', 'out']);
const SRC_EXT = new Set(['.ts', '.rs', '.py', '.js', '.tsx', '.jsx', '.go', '.java', '.cpp', '.c', '.h', '.hpp']);

function walk(root: string, depth: number, limit: number): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; d: number }> = [{ dir: root, d: 0 }];
  while (stack.length > 0 && out.length < limit) {
    const { dir, d } = stack.pop()!;
    if (d > depth) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push({ dir: full, d: d + 1 });
      else if (SRC_EXT.has(path.extname(e.name))) out.push(full);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function searchFiles(
  root: string,
  pattern: string,
  limit: number,
): Array<{ file: string; line: number; match_content: string }> {
  const out: Array<{ file: string; line: number; match_content: string }> = [];
  const lower = pattern.toLowerCase();
  const files = walk(root, 6, 2000);
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        out.push({ file: f, line: i + 1, match_content: lines[i].slice(0, 200) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function resolveInWorktree(wt: string, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(wt, p);
}

function applyUnifiedDiff(content: string, diff: string): string | null {
  let updated = content;
  const hunkRe = /@@[^@]*@@\n((?:[ \-+].*\n?)+)/g;
  let m: RegExpExecArray | null = null;
  let applied = 0;
  hunkRe.lastIndex = 0;
  m = hunkRe.exec(diff);
  while (m !== null) {
    const lines = m[1].split('\n');
    const removed: string[] = [];
    const added: string[] = [];
    let _contextStart = '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith(' ') || line === '') _contextStart = line.slice(1);
    }
    const removedJoined = removed.join('\n');
    const idx = updated.indexOf(removedJoined);
    if (idx >= 0) {
      updated = updated.slice(0, idx) + added.join('\n') + updated.slice(idx + removedJoined.length);
      applied++;
    }
    m = hunkRe.exec(diff);
  }
  return applied > 0 ? updated : null;
}

export function buildTrialRegistry(wt: string, graph: TrialGraphData): ToolRegistry {
  const registry = new ToolRegistry();
  const EXEC_ALIAS: Record<string, string> = {
    write_file_content: 'write_file',
    rename_file_or_dir: 'rename_file',
    delete_file_or_dir: 'delete_file',
    git_stage: 'git_stage',
    git_stage_all: 'git_stage_all',
    git_push: 'git_push',
    git_pull: 'git_pull',
    git_init: 'git_init',
    git_create_branch: 'git_create_branch',
    git_stash_pop: 'git_stash_pop',
  };
  const exec: ToolExecutor = async (nameRaw, args, onProgress) => {
    const name = EXEC_ALIAS[nameRaw] ?? nameRaw;
    const fp = (k: string) => String(args[k] ?? '');
    switch (name) {
      case 'git_cap': {
        // R3-c 能力口直呼（kernel-capability-c3-design.md）：git 域 execute 经
        // git_cap action 分派——路由回本地 mock 的 git_* 工具语义（repo_path
        // 是 git_cap 键，mock 读 path，这里折回；action = 退役前工具名）。
        const { action, repo_path, ...rest } = args as Record<string, unknown>;
        return exec(String(action ?? ''), { ...rest, path: repo_path }, onProgress);
      }
      case 'fs_cap': {
        // R3-b 能力口直呼（kernel-capability-c3-design.md）：fs 域 execute 经
        // fs_cap action 分派——路由回本地 mock 的旧工具语义（file_path/from/to
        // 是 fs_cap snake 键，mock 读 filePath 等旧键，这里折回）。
        const action = String(args.action ?? '');
        const dispatch = (inner: string, map: Record<string, string>) => {
          const mapped: Record<string, string> = {};
          for (const [k, v] of Object.entries(args)) {
            if (k === 'action' || k.startsWith('_')) continue;
            mapped[map[k] ?? k] = String(v);
          }
          return exec(inner, mapped, onProgress);
        };
        switch (action) {
          case 'read':
            return dispatch('read_file_content', { file_path: 'filePath' });
          case 'write':
            return dispatch('write_file', { file_path: 'filePath' });
          case 'delete':
            return dispatch('delete_file', { path: 'path' });
          case 'create_dir':
            return dispatch('create_directory', { path: 'path' });
          case 'rename':
            return dispatch('rename_file', { from: 'filePath', to: 'newPath' });
          case 'glob':
            return dispatch('glob', { dir: 'directory' });
          case 'list':
            return dispatch('list_directory', { path: 'path' });
          default:
            return `错误: fs_cap 未知 action ${action}`;
        }
      }
      case 'process_cap': {
        // R3-d 能力口直呼（kernel-capability-c3-design.md）：shell 域 execute 经
        // process_cap action 分派——路由回本地 mock 的 shell 工具语义（顶参是
        // process_cap snake 键，mock 读 command 原键；后台三动词不收，
        // run_in_background 映回 run_shell 的 runInBackground）。
        const action = String(args.action ?? '');
        const { action: _a, job_id: _j, run_in_background: _rb, ...rest } = args as Record<string, unknown>;
        const mapped: Record<string, unknown> = { ...rest };
        if (typeof _rb === 'boolean') mapped.runInBackground = _rb;
        if (action === 'exec_command') return exec('run_shell', mapped, onProgress);
        if (action === 'bash_output' || action === 'bash_kill' || action === 'bash_wait') {
          return exec(action, { ...mapped, jobId: _j }, onProgress);
        }
        return `错误: process_cap 未知 action ${action}`;
      }
      case 'read_file_content': {
        const p = resolveInWorktree(wt, fp('filePath') || fp('file_path'));
        try {
          return fs.readFileSync(p, 'utf8');
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'search_content': {
        const q = fp('query') || fp('pattern');
        const dir = fp('directory') || fp('dir') || wt;
        const matches = searchFiles(resolveInWorktree(wt, dir), q, 50);
        return JSON.stringify({ matches });
      }
      case 'glob': {
        const pattern = fp('pattern') || fp('path') || '**/*';
        const dir = resolveInWorktree(wt, fp('directory') || fp('dir') || '.');
        const files = walk(dir, 6, 200);
        const filtered = files.filter((f) =>
          pattern
            .split('*')
            .filter(Boolean)
            .every((seg) => f.includes(seg)),
        );
        return filtered.join('\n');
      }
      case 'list_directory': {
        const dir = resolveInWorktree(wt, fp('path') || fp('directory') || '.');
        try {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .map((e) => `path: ${path.join(dir, e.name)}\ntype: ${e.isDirectory() ? 'dir' : 'file'}`)
            .join('\n');
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'run_shell': {
        const cmd = fp('command');
        return new Promise<string>((resolve) => {
          const child = execFile(
            'cmd.exe',
            ['/d', '/s', '/c', cmd],
            { cwd: wt, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const out = stdout || stderr || '';
              if (err && !out) return resolve(`[exit ${(err as any).code ?? 1}]\n${stderr}`);
              const code = (err as any)?.code ?? 0;
              resolve(code === 0 ? out : `[exit ${code}]\n${out}`);
            },
          );
          child.stdout?.on('data', (c: Buffer) => onProgress?.(c.toString()));
          child.stderr?.on('data', (c: Buffer) => onProgress?.(c.toString()));
        });
      }
      case 'write_file': {
        const p = resolveInWorktree(wt, fp('filePath'));
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, String(args.content ?? ''));
          return `已写入 ${p}`;
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'edit_file': {
        const p = resolveInWorktree(wt, fp('filePath'));
        try {
          const content = fs.readFileSync(p, 'utf8');
          const updated = applyUnifiedDiff(content, fp('diff'));
          if (updated === null) return '错误: diff 无法应用（未找到匹配上下文），请改用 write_file 全量重写。';
          fs.writeFileSync(p, updated);
          return `已编辑 ${p}`;
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'delete_file': {
        const p = resolveInWorktree(wt, fp('filePath'));
        try {
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
          else fs.unlinkSync(p);
          return `已删除 ${p}`;
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'create_directory': {
        const p = resolveInWorktree(wt, fp('path') || fp('dir'));
        try {
          fs.mkdirSync(p, { recursive: true });
          return `已创建目录 ${p}`;
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'read_constraints': {
        return '无约束（测试环境）';
      }
      case 'rename_file':
      case 'move_file': {
        const src = resolveInWorktree(wt, fp('filePath') || fp('source') || fp('src'));
        const dst = resolveInWorktree(wt, fp('newPath') || fp('destination') || fp('dest'));
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.renameSync(src, dst);
          return `已移动 ${src} → ${dst}`;
        } catch (e: any) {
          return `错误: ${e?.message || e}`;
        }
      }
      case 'git_status':
      case 'git_diff':
      case 'git_log':
      case 'git_branch':
      case 'git_commit':
      case 'git_checkout':
      case 'git_discard':
      case 'git_stash_push':
      case 'git_stash_pop':
      case 'git_stage':
      case 'git_stage_all':
      case 'git_init':
      case 'git_create_branch':
      case 'git_push':
      case 'git_pull': {
        const gitArgs =
          name === 'git_status'
            ? ['status', '--short']
            : name === 'git_diff'
              ? ['diff', '--stat']
              : name === 'git_log'
                ? ['log', '--oneline', '-10']
                : name === 'git_branch'
                  ? ['branch', '-a']
                  : name === 'git_commit'
                    ? ['commit', '-m', fp('message') || 'wip']
                    : name === 'git_checkout'
                      ? ['checkout', fp('branch') || 'HEAD']
                      : name === 'git_discard'
                        ? ['checkout', '--', fp('file') || '.']
                        : name === 'git_stash_push'
                          ? ['stash', 'push', '-u']
                          : name === 'git_stash_pop'
                            ? ['stash', 'pop']
                            : name === 'git_stage'
                              ? ['add', fp('file') || fp('path') || '.']
                              : name === 'git_stage_all'
                                ? ['add', '-A']
                                : name === 'git_init'
                                  ? ['init']
                                  : name === 'git_create_branch'
                                    ? ['checkout', '-b', fp('branch') || 'wip']
                                    : name === 'git_push'
                                      ? ['push', fp('remote') || 'origin', fp('branch') || 'HEAD']
                                      : ['pull'];
        return new Promise<string>((resolve) => {
          execFile('git', gitArgs, { cwd: wt, timeout: 30_000 }, (err, stdout, stderr) => {
            resolve(err ? `错误: ${stderr}` : stdout || '(无输出)');
          });
        });
      }
      case 'bash_output':
      case 'bash_kill':
      case 'bash_wait': {
        return '错误: 测试环境不支持后台任务管理，请使用普通 run_shell。';
      }
      case 'web_search':
      case 'web_fetch': {
        return '错误: 测试环境无网络工具';
      }
      case 'agent_isolation_create':
      case 'agent_isolation_diff':
      case 'agent_isolation_discard':
      case 'agent_isolation_merge':
      case 'agent_isolation_status': {
        return '错误: 测试环境不支持子 Agent 隔离，请直接在主工作区操作';
      }
      default:
        return `错误: 未知工具 ${name}`;
    }
  };

  // search/web 能力口直呼路由：试验 harness 的 exec 是本地 mock（无 RPC），
  // 能力口名在 mock 面不存在——在此按 action/编排键路由回本地 mock。
  // R2 后 search 直呼 search_cap（snake 键映射后直呼）；R2-d(2) 收窄后
  // 能力口返回统一原始命中集——kernelExec 把本地 search mock 的 {matches}
  // 包成 raw 形状，供 TS 组装层（search-assembly.ts）消费。
  // R4-4 后 web 直呼 web_cap——按 action 路由回 mock（信封时代经 tool_call
  // 解包的同款落点；R5 信封拆除后 tool_call 分支随脚手架退役）。
  const kernelExec: ToolExecutor = (name, args, onProgress, signal) => {
    if (name === 'search_cap') {
      // search mock 语义不变——单字键 directory/pattern 原样保留（mock 读的就是
      // 它们）；命中按文件分组成 {file, match_count, matches} 原始命中集形状。
      return exec('search_content', args, onProgress, signal).then((raw) => {
        const parsed = JSON.parse(raw) as {
          matches?: Array<{ file: string; line: number; match_content: string }>;
        };
        const byFile = new Map<
          string,
          Array<{ line: number; content: string; context: Array<{ line: number; content: string }> }>
        >();
        for (const m of parsed.matches ?? []) {
          const bucket = byFile.get(m.file) ?? [];
          bucket.push({
            line: m.line,
            content: m.match_content,
            context: [{ line: m.line, content: m.match_content }],
          });
          byFile.set(m.file, bucket);
        }
        return JSON.stringify({
          pattern: String(args.pattern ?? ''),
          scanned_files: byFile.size,
          budget_truncated: false,
          files: Array.from(byFile.entries()).map(([file, matches]) => ({
            file,
            match_count: matches.length,
            matches,
          })),
        });
      });
    }
    if (name === 'web_cap') {
      // web_cap {action, ...} → 本地 mock 原生工具名（信封时代解包落点同款，
      // R4-4 直呼换轨后按 action 路由——mock 面 web_search/web_fetch 报
      // 「测试环境无网络工具」原语义）。
      const inner = String(args.action ?? '');
      const rest: Record<string, unknown> = { ...args };
      delete rest.action;
      return exec(inner, rest, onProgress, signal);
    }
    return exec(name, args, onProgress, signal);
  };

  for (const tool of [
    ...createCodingTools(exec, {
      askUser: (req) => req.callback(['继续']),
    }),
    ...createSearchTools(kernelExec),
    ...createWebTools(kernelExec),
  ]) {
    registry.register(tool);
  }

  const graphTools = buildMiniGraphTools(graph);
  for (const t of graphTools) registry.register(t);
  registry.alias('read_file', 'read_file_content');

  return registry;
}

function buildMiniGraphTools(graph: TrialGraphData) {
  const nodeByFile = new Map<string, Array<{ id: string; name: string; kind: string }>>();
  for (const n of graph.nodes) {
    const loc = n.location ?? '';
    const file = loc.replace(/\\/g, '/').replace(/:\d+$/, '');
    const arr = nodeByFile.get(file) ?? [];
    arr.push(n);
    nodeByFile.set(file, arr);
  }
  const inDegree = new Map<string, number>();
  for (const e of graph.edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);

  const findNodes = (q: string) => {
    const lower = q.toLowerCase();
    return graph.nodes
      .filter((n) => n.name.toLowerCase().includes(lower) || (n.location ?? '').toLowerCase().includes(lower))
      .slice(0, 10);
  };

  const impactOf = (symbol: string) => {
    const targets = new Set(graph.edges.filter((e) => e.source === symbol).map((e) => e.target));
    const files = new Set<string>();
    for (const n of graph.nodes) {
      if (targets.has(n.id)) {
        const f = (n.location ?? '').replace(/:\d+$/, '');
        if (f) files.add(f);
      }
    }
    return { target_count: targets.size, files: [...files].slice(0, 20) };
  };

  return [
    defineTool({
      name: 'trace_impact',
      description: '追踪一个符号的下游影响面（哪些文件/节点依赖它）。',
      schema: z.object({ symbol: z.string() }),
      readOnly: true,
      execute: async (args) => JSON.stringify(impactOf(String(args.symbol ?? ''))),
    }),
    defineTool({
      name: 'explore_deps',
      description: '查看一个文件的依赖关系。',
      schema: z.object({ filePath: z.string().optional() }),
      readOnly: true,
      execute: async (args) => {
        const f = String(args.filePath ?? '');
        const norm = f.replace(/\\/g, '/');
        const nodes = [...nodeByFile.entries()]
          .filter(([file]) => file.includes(norm.replace(/:\d+$/, '')))
          .flatMap(([, ns]) => ns);
        const ids = new Set(nodes.map((n) => n.id));
        const deps = graph.edges.filter((e) => ids.has(e.source));
        return JSON.stringify({ nodes: nodes.length, deps: deps.slice(0, 50) });
      },
    }),
    defineTool({
      name: 'get_neighbors',
      description: '查看一个节点的邻居（依赖它/被它依赖的节点）。',
      schema: z.object({ node: z.string() }),
      readOnly: true,
      execute: async (args) => {
        const q = String(args.node ?? '');
        const hit = findNodes(q)[0];
        if (!hit) return JSON.stringify({ neighbors: [] });
        const neighbors = graph.edges
          .filter((e) => e.source === hit.id || e.target === hit.id)
          .map((e) => ({ other: e.source === hit.id ? e.target : e.source, kind: e.kind }));
        return JSON.stringify({ neighbors: neighbors.slice(0, 50) });
      },
    }),
    defineTool({
      name: 'get_community',
      description: '查看社区信息。',
      schema: z.object({ node: z.string().optional() }),
      readOnly: true,
      execute: async () => JSON.stringify({ communities: 1, nodes: graph.nodes.length }),
    }),
    defineTool({
      name: 'fragile_modules',
      description: '列出最脆弱（被依赖最多）的模块。',
      schema: z.object({ limit: z.number().optional() }),
      readOnly: true,
      execute: async (args) => {
        const limit = Number(args.limit ?? 10);
        const byFile = new Map<string, number>();
        for (const n of graph.nodes) {
          const f = (n.location ?? '').replace(/:\d+$/, '');
          if (f) byFile.set(f, (byFile.get(f) ?? 0) + (inDegree.get(n.id) ?? 0));
        }
        const ranked = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
        return JSON.stringify({ fragile_modules: ranked.map(([file, score]) => ({ file, fragility_score: score })) });
      },
    }),
    defineTool({
      name: 'graph_summary',
      description: '图概览：节点/边/社区数量。',
      schema: z.object({}),
      readOnly: true,
      execute: async () => JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length }),
    }),
    defineTool({
      name: 'search_symbols',
      description: '按名称搜索图中的符号。',
      schema: z.object({ query: z.string(), limit: z.number().optional() }),
      readOnly: true,
      execute: async (args) => {
        const limit = Number(args.limit ?? 10);
        return JSON.stringify({ results: findNodes(String(args.query ?? '')).slice(0, limit) });
      },
    }),
  ];
}
