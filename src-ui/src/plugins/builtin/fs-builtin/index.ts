// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 内置 fs provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/fs-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。
//
// fs 域收口（kernel-capability-c3-design.md）：execute 从 tool_call 信封
// （寻址 builtin.fs 插件——已退役）换 fs_cap 能力口直呼——dispatch 即 exec
// （executor 注入 is_agent 到 fs_cap 顶层，与 searchCapTool 同构）。模型族
// 工具 schema 真源已回 TS zod（coding.ts FS_CAP_SCHEMA）。
// R4-4b：edit 换 editor_cap 直呼（builtin.editor 退役——R4 窗最后在册插件）。
// tool_call 信封的 TS 消费面随 R5 脚手架拆除清零。
// （constraints/write_constraints 两动作随图谱全量退役移除，2026-09-09——
//  hologram.constraints.yaml 读写仅服务引擎 run_check，兰台侧已无消费方。）
//
// 双表职责：
//   FS_ACTION_TO_CAP —— execute 换轨动作→fs_cap action + 模型键→snake 键映射；
//   edit 分支在本文件内直呼 editor_cap。

import type { FsAction, FsProvider } from '../../../composition/fs-service';
import type { Context } from '../../../cordis';

// （FS_PLUGIN_TOOL_BY_ACTION 信封目标表已随 R4-4b builtin.editor 退役删除——
//  edit 动作换 editor_cap 直呼（见 execute 分支）；tool_call 信封的 TS 消费面
//  清零。）

/** fs 动作 → fs_cap 能力口动作 + 模型面键（camelCase）→ fs_cap 顶层 snake 键。
 *  edit 不经 fs_cap：edit_file 走 editor_cap（编辑含 diff 应用语义）——
 *  在 execute 分支直呼。 */
const FS_ACTION_TO_CAP: Record<FsAction, { action: string; keys: Record<string, string> }> = {
  read: {
    action: 'read',
    keys: { filePath: 'file_path', offset: 'offset', limit: 'limit', lineNumbers: 'line_numbers' },
  },
  write: { action: 'write', keys: { filePath: 'file_path', content: 'content' } },
  edit: { action: '', keys: {} }, // editor_cap 直呼（见 execute 分支）
  list: { action: 'list', keys: { path: 'path', filterIgnored: 'filter_ignored' } },
  glob: { action: 'glob', keys: { pattern: 'pattern', path: 'dir' } },
  mkdir: { action: 'create_dir', keys: { path: 'path' } },
  move: { action: 'rename', keys: { from: 'from', to: 'to' } },
  rename: { action: 'rename', keys: { filePath: 'from', newName: 'to' } },
  delete: { action: 'delete', keys: { path: 'path' } },
};

/** 把模型面 args（camelCase + meta）映射为 fs_cap 顶层 snake 参数。
 *  meta 键（_agent_id/_owner_id/_forceGate）原样透传（executor 注入身份）。
 *  read 行号 opt-in（2026-09 工具缺陷报告 Bug 1 拍板）：缺省返回文件原文
 *  （line_numbers=false——行号前缀是装饰，绝不默认混入 payload）；模型显式
 *  lineNumbers:true 才带 cat -n 行号。旧内部键 raw 静默吞掉（缺省原文语义
 *  下 raw:true 与默认等价——历史调用方零破坏）。 */
function toCapArgs(action: FsAction, args: Record<string, unknown>): Record<string, unknown> {
  const { action: capAction, keys } = FS_ACTION_TO_CAP[action];
  const out: Record<string, unknown> = { action: capAction };
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_')) {
      out[k] = v; // meta 透传（snake 已保留下划线）
      continue;
    }
    if (action === 'read' && k === 'raw') continue; // 历史内部键：缺省即原文，吞掉
    out[keys[k] ?? k] = v;
  }
  if (action === 'read') {
    out.line_numbers = args.lineNumbers === true;
  }
  return out;
}

/** 默认 Rust fs provider（id 'builtin/rust-fs'）——R3-b 起 execute 经 fs_cap
 *  能力口直呼（dispatch 即 executor 的 codingExec——注入 is_agent，与 search
 *  直呼同构）。留信封动作（edit）保持原路径。
 *  形状兼容（R3-b）：fs_cap 返回结构化 JSON（read={path,content}、write={path}
 *  等），本层组装成 builtin.fs 插件原工具输出形状——工具 execute 返回给模型的
 *  字符串不漂移（编排归 TS 的本体；read 解包 content / write 回执含预览）。 */
export const builtinFsProvider: FsProvider = {
  id: 'builtin/rust-fs',
  async execute(action, args, opts) {
    const cap = FS_ACTION_TO_CAP[action];
    if (!cap.action) {
      // edit（R4-4b）：editor_cap 直呼（builtin.editor 插件退役——模型面键
      // filePath/oldString/newString/replaceAll 顶层映射 snake；meta（含
      // _forceGate/_agent_id）原样透传）。
      if (action === 'edit') {
        const keys: Record<string, string> = {
          filePath: 'file_path',
          oldString: 'old_string',
          newString: 'new_string',
          replaceAll: 'replace_all',
        };
        const out: Record<string, unknown> = { action: 'edit_file' };
        for (const [k, v] of Object.entries(args)) {
          if (k.startsWith('_')) {
            out[k] = v; // meta 透传（snake 已保留下划线）
            continue;
          }
          out[keys[k] ?? k] = v;
        }
        return opts.dispatch('editor_cap', out, opts.onProgress, opts.signal);
      }
      throw new Error(`fs-builtin: 动作 '${action}' 无能力口目标（fs 域收口后非 edit 动作应走 fs_cap）`);
    }
    const raw = await opts.dispatch('fs_cap', toCapArgs(action, args), opts.onProgress, opts.signal);
    // read：fs_cap 返回 {path, content}——解包 content（缺省原文；lineNumbers:
    // true 时为 cat -n 行号格式，Text 语义不变）。
    // 附图信封（2026-09-18 按路径读图）：读到图片字节时输出无 content 键
    // （{path, image, attachment, imageNote}）——原样透传，引用由 executor 的
    // parseToolImageOutput 消费（下方 typeof content 检查天然放行）。
    if (action === 'read') {
      try {
        const parsed = JSON.parse(raw) as { content?: unknown };
        if (typeof parsed.content === 'string') return parsed.content;
      } catch {
        // 非 JSON（异常文本）——直通
      }
      return raw;
    }
    // write：补回执读数（2026-09-16 反馈回路审计）。本文件头 72-74 行早就写明
    // 「write 回执含预览」，但实现只 `{path}` 结构化透传 = 零信息：模型写完看不到
    // "写进去的是什么"，只能靠重复写来确认（而重复写是幂等的，所以危害是空转而非
    // 破坏）。这里给的是**入参侧**读数（行数/字符数）——不是盘上真相，回执里点名
    // 回读入口，别让它被当成盘上证据。
    if (action === 'write') {
      const content = typeof args.content === 'string' ? args.content : '';
      const lines = content === '' ? 0 : content.split('\n').length;
      try {
        const parsed = JSON.parse(raw) as { path?: unknown };
        if (typeof parsed.path === 'string') {
          return `${raw}\n[fs] 本次入参 ${lines} 行 / ${content.length} 字符 → ${parsed.path}（入参读数，非盘上核对）。要确认盘上内容用 fs(read)。`;
        }
      } catch {
        // 非 JSON（异常文本）——直通
      }
    }
    // 其余动作直通（list/glob 的 JSON 字符串；write 已在上方补读数）。
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
