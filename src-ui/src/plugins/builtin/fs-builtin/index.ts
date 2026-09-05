// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 fs provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/fs-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。
//
// fs 域收口（kernel-capability-c3-design.md）：execute 从 tool_call 信封
// （寻址 builtin.fs 插件——已退役）换 fs_cap 能力口直呼——dispatch 即 exec
// （executor 注入 is_agent 到 fs_cap 顶层，与 searchCapTool 同构）。模型族
// 工具 schema 真源已回 TS zod（coding.ts FS_CAP_SCHEMA）。
// R4-4 小面清偿（kernel-capability-d4-handle-design.md）：constraints 两动作
// 换 constraints_cap 直呼（builtin.constraints 退役）；edit 仍留信封
// （builtin.editor——R5 拆信封前最后在册插件）。
//
// 双表职责：
//   FS_PLUGIN_TOOL_BY_ACTION —— 留信封动作 → tool_call 目标（仅 edit）。
//   FS_ACTION_TO_CAP —— execute 换轨动作→fs_cap action + 模型键→snake 键映射；
//   constraints 两动作在本文件内直呼 constraints_cap（见 execute 分支）。

import type { FsAction, FsProvider } from '../../../composition/fs-service';
import type { Context } from '../../../cordis';

/** fs 动作 → tool_call 信封目标（仅 edit——builtin.editor，R4-4 起 constraints
 *  两动作已换 constraints_cap 直呼不经信封）。 */
export const FS_PLUGIN_TOOL_BY_ACTION: Partial<Record<FsAction, { plugin: string; tool: string }>> = {
  edit: { plugin: 'builtin.editor', tool: 'edit_file' },
};

/** fs 动作 → fs_cap 能力口动作 + 模型面键（camelCase）→ fs_cap 顶层 snake 键。
 *  edit/constraints/write_constraints 不经 fs_cap：edit_file 属 builtin.editor
 *  （编辑含 diff 应用语义，editor 能力口后续批）；constraints 读写是
 *  hologram.constraints.yaml 域（独立内部工具，暂留信封）。 */
const FS_ACTION_TO_CAP: Record<FsAction, { action: string; keys: Record<string, string> }> = {
  read: { action: 'read', keys: { filePath: 'file_path', offset: 'offset', limit: 'limit' } },
  write: { action: 'write', keys: { filePath: 'file_path', content: 'content' } },
  edit: { action: '', keys: {} }, // 留信封 → builtin.editor（本批不动）
  list: { action: 'list', keys: { path: 'path', filterIgnored: 'filter_ignored' } },
  glob: { action: 'glob', keys: { pattern: 'pattern', path: 'dir' } },
  mkdir: { action: 'create_dir', keys: { path: 'path' } },
  move: { action: 'rename', keys: { from: 'from', to: 'to' } },
  rename: { action: 'rename', keys: { filePath: 'from', newName: 'to' } },
  delete: { action: 'delete', keys: { path: 'path' } },
  constraints: { action: '', keys: {} }, // R4-4：constraints_cap 直呼（见 execute 分支）
  write_constraints: { action: '', keys: {} }, // R4-4：constraints_cap 直呼（见 execute 分支）
};

/** 把模型面 args（camelCase + meta）映射为 fs_cap 顶层 snake 参数。
 *  meta 键（_agent_id/_owner_id/_forceGate）原样透传（executor 注入身份）。
 *  read 的 raw 与 fs_cap line_numbers 反相：raw 缺省/显式 false → 带行号
 *  （旧 read_file_content 默认）；raw=true → 原文（P1-3 JSON 读取面）。 */
function toCapArgs(action: FsAction, args: Record<string, unknown>): Record<string, unknown> {
  const { action: capAction, keys } = FS_ACTION_TO_CAP[action];
  const out: Record<string, unknown> = { action: capAction };
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_')) {
      out[k] = v; // meta 透传（snake 已保留下划线）
      continue;
    }
    if (action === 'read' && k === 'raw') continue; // raw 单独处理（反相）
    out[keys[k] ?? k] = v;
  }
  if (action === 'read') {
    out.line_numbers = args.raw !== true;
  }
  return out;
}

/** 默认 Rust fs provider（id 'builtin/rust-fs'）——R3-b 起 execute 经 fs_cap
 *  能力口直呼（dispatch 即 executor 的 codingExec——注入 is_agent，与 search
 *  直呼同构）。留信封动作（edit/constraints/write_constraints）保持原路径。
 *  形状兼容（R3-b）：fs_cap 返回结构化 JSON（read={path,content}、write={path}
 *  等），本层组装成 builtin.fs 插件原工具输出形状——工具 execute 返回给模型的
 *  字符串不漂移（编排归 TS 的本体；read 解包 content / write 回执含预览）。 */
export const builtinFsProvider: FsProvider = {
  id: 'builtin/rust-fs',
  async execute(action, args, opts) {
    const cap = FS_ACTION_TO_CAP[action];
    if (!cap.action) {
      // constraints 族（R4-4）：constraints_cap 直呼（builtin.constraints 插件
      // 退役——模型面键 projectPath/content 顶层映射 snake；meta 透传）。
      if (action === 'constraints' || action === 'write_constraints') {
        const keys: Record<string, string> = { projectPath: 'project_path', content: 'content' };
        const out: Record<string, unknown> = {
          action: action === 'constraints' ? 'read_constraints' : 'write_constraints',
        };
        for (const [k, v] of Object.entries(args)) {
          if (k.startsWith('_')) {
            out[k] = v; // meta 透传
            continue;
          }
          out[keys[k] ?? k] = v;
        }
        return opts.dispatch('constraints_cap', out, opts.onProgress, opts.signal);
      }
      // 留信封动作——按原动作路由（edit → builtin.editor）
      const envelope = FS_PLUGIN_TOOL_BY_ACTION[action];
      if (!envelope) throw new Error(`fs-builtin: 动作 '${action}' 无信封目标（fs 域收口后非信封动作应走 fs_cap）`);
      return opts.dispatch(
        'tool_call',
        { plugin: envelope.plugin, tool: envelope.tool, args },
        opts.onProgress,
        opts.signal,
      );
    }
    const raw = await opts.dispatch('fs_cap', toCapArgs(action, args), opts.onProgress, opts.signal);
    // read：fs_cap 返回 {path, content}——解包 content（旧 read_file_content
    // 返回纯文本/行号格式，Text 语义）。
    if (action === 'read') {
      try {
        const parsed = JSON.parse(raw) as { content?: unknown };
        if (typeof parsed.content === 'string') return parsed.content;
      } catch {
        // 非 JSON（异常文本）——直通
      }
      return raw;
    }
    // 其余动作直通（list/glob 的 JSON 字符串、写类回执；write 的展示文案在
    // fs_cap 侧由 TS 组装——见 R3-b 注记；暂返回 {path} 结构化透传）。
    return raw;
  },
};

/** builtin fs provider 贡献插件（loader 表序：fsServicePlugin 之后）。 */
export const builtinFsPlugin = {
  name: 'hologram/fs-builtin',
  inject: ['fs'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.fs.register(builtinFsProvider), 'fs-builtin');
  },
};

export default builtinFsPlugin;
