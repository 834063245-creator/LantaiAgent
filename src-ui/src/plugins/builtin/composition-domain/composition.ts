// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition 域工具——**创作者模式的那双手**（2026-10 最小闭环）。
//
// 定位（对照 DSH creator mode 的 Cordis 组合作者面）：DSH 让 Agent 在工作区写
// bundle、用 plugin_manager 安装；兰台的 Agent shell 写不了工作区外的
// ~/.lantai/composition/（沙箱边界），所以「写 preset」必须是专用工具，不能靠
// 文件系统 + 说明书。本工具就是那条专用通道：读组合、验组合、写组合。
//
// 门控（最小权限，与 DSH 把 plugin_manager 只给 cordis preset 同构）：本行
// defaultOff——标准/精简组合里模型**看不到也调不到**；只有 creator preset
// 用 disabled:false 回开。
//
// 安全边界：
//   · 只能写**用户层 preset 目录**（builtin id 直接拒绝——内置同 id 胜，写了也不生效）；
//   · 写前必须通过 schema + 行可寻址性双重校验（写坏一个 preset = 以后选中它必被拒，
//     等于把用户锁在一个坏组合上）；
//   · 已存在同名 preset 默认**拒写**（overwrite=true 才覆盖），沿 preset-authoring 的
//     拒覆盖纪律；
//   · 写后立刻重扫（发现 → 重应用），新 preset 当场出现在清单里。

import { z } from 'zod';
import {
  builtinPresets,
  type CompositionPatch,
  CompositionPatchError,
  defineTool,
  discoverPresets,
  factoryComposition,
  isValidPresetId,
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelWriteFile,
  type PresetEntry,
  parsePatchYamlText,
  type ResolvedComposition,
  reapplyComposition,
  resolveRoster,
  stringifyPatchYaml,
  type Tool,
  typedRpc,
  usePresetStore,
} from './host';

export const COMPOSITION_ACTIONS = ['list', 'read', 'validate', 'write', 'delete', 'rename', 'copy'] as const;
export type CompositionAction = (typeof COMPOSITION_ACTIONS)[number];

/** 落盘 / 发现 IO（生产 = RPC；测试注入假件——本模块因此零网络依赖）。 */
export interface CompositionIo {
  /** 组合根绝对路径（`~/.lantai/composition/`，按需创建；服务端算路径）。 */
  dir(): Promise<string>;
  /** 读一个文件；不存在 → null（拒覆盖的判据）。 */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  /** 删一个文件（不存在 → 不报错：删除是幂等的）。 */
  deleteFile(path: string): Promise<void>;
  /** 重扫（discoverPresets + reapplyComposition）。 */
  rescan(): Promise<void>;
}

/** 组合解析读面（生产 = 内核组合层；测试注入假件）。 */
export interface CompositionDeps {
  roster(): PresetEntry[];
  factory(): ReturnType<typeof factoryComposition>;
  resolve(patch: CompositionPatch): ResolvedComposition;
}

export const rpcCompositionIo: CompositionIo = {
  dir: () => typedRpc('composition_dir', { open: false }),
  readFile: async (path) => {
    try {
      return await kernelReadFile(path);
    } catch {
      return null;
    }
  },
  writeFile: async (path, content) => {
    await kernelWriteFile(path, content);
  },
  makeDir: async (path) => {
    await kernelCreateDirectory(path);
  },
  deleteFile: async (path) => {
    await kernelDeleteFile(path);
  },
  rescan: async () => {
    await discoverPresets();
    reapplyComposition();
  },
};

const kernelDeps: CompositionDeps = {
  roster: () => usePresetStore.getState().roster,
  factory: () => factoryComposition(),
  resolve: (patch) => resolveRoster(factoryComposition(), [patch]),
};

/** 目录拼接（Windows / POSIX 都吃 `/`——Rust 侧 resolve 会归一）。 */
export function presetDirPath(root: string, id: string): string {
  return root.replace(/[/\\]+$/, '') + '/presets/' + id;
}

/** 组合摘要（写盘后/校验后给人看的那几行）——只报计数与缺口，不倾倒全表。 */
export function summarizeComposition(c: ResolvedComposition): string {
  const seams = Object.entries(c.seams)
    .map(([k, rows]) => k + '=' + rows.length)
    .join(' ');
  const disabledSeams = Object.entries(c.seamDisabled)
    .filter(([, ids]) => ids.length > 0)
    .map(([k, ids]) => k + ':' + ids.join(','))
    .join(' ');
  const decl = c.activationDecl;
  const declText =
    (decl.requires.length > 0 ? ' requires=' + decl.requires.join(',') : '') +
    (decl.exclusive.length > 0 ? ' exclusive=' + decl.exclusive.join(',') : '');
  return [
    'tools=' + c.tools.length,
    'prompt=' + c.prompt.length,
    'capabilities=' + c.capabilities.length,
    'shell=' + c.shell.length,
    'seams[' + seams + ']',
    disabledSeams ? 'seam-disabled[' + disabledSeams + ']' : '',
    declText.trim(),
  ]
    .filter((s) => s !== '')
    .join(' ');
}

/** 可寻址行清单（作者面的事实来源——行 id 只许从这里抄，不许猜）。
 *  fac 显式可注入：测试域不装贡献通道时，内核 factoryComposition() 是空表，
 *  而作者面判据（deps.factory）在测试里是假件——两处必须同一个源。 */
export function rowsDigest(filter?: string, fac: ReturnType<typeof factoryComposition> = factoryComposition()): string {
  const hit = (id: string) => filter === undefined || filter === '' || id.includes(filter);
  const lines: string[] = [];
  const push = (domain: string, rows: Array<{ id: string; defaultOff?: boolean }>) => {
    const kept = rows.filter((r) => hit(r.id));
    if (kept.length === 0) return;
    lines.push(
      '[' + domain + '] ' + kept.length + ' 行' + (domain === 'tools' ? '（★ = 默认关，需 disabled:false 回开）' : ''),
    );
    for (const r of kept) {
      lines.push('  ' + r.id + (r.defaultOff === true ? '  ★' : ''));
    }
  };
  push('tools', fac.tools);
  push('prompt', fac.prompt as Array<{ id: string }>);
  push('capabilities', fac.capabilities as Array<{ id: string }>);
  push('shell', fac.shell as Array<{ id: string }>);
  for (const [seam, rows] of Object.entries(fac.seams)) {
    push('seam/' + seam, rows as Array<{ id: string }>);
  }
  return lines.join('\n');
}

/** 具名条目查找（内置优先 → 用户目录；与 assembly 侧同一判据）。 */
export function findPreset(roster: PresetEntry[], id: string): PresetEntry | undefined {
  return builtinPresets().find((p) => p.id === id) ?? roster.find((p) => p.id === id && !p.builtin);
}

export interface CompositionToolDeps {
  io: CompositionIo;
  deps: CompositionDeps;
}

/** 工具工厂（测试注入 io / deps）。 */
export function createCompositionTool(override: Partial<CompositionToolDeps> = {}): Tool {
  const io = override.io ?? rpcCompositionIo;
  const deps = override.deps ?? kernelDeps;

  const schema = z.object({
    action: z.enum(COMPOSITION_ACTIONS).describe('Which operation to perform.'),
    id: z
      .string()
      .optional()
      .describe('Preset id (read/write/delete/rename/copy): lowercase letters, digits and hyphens.'),
    newId: z.string().optional().describe('Target preset id (rename/copy): the new id to create.'),
    yaml: z.string().optional().describe('Patch YAML text (validate/write): the roster.patch.yml body.'),
    name: z.string().optional().describe('Display name written into preset.yml (write).'),
    description: z.string().optional().describe('Display description written into preset.yml (write).'),
    overwrite: z.boolean().optional().describe('write: replace an existing user preset (default false = refuse).'),
    rows: z
      .boolean()
      .optional()
      .describe('list: include the addressable row ids (tool rows, prompt sections, capabilities, shell rows, seams).'),
    filter: z.string().optional().describe('list(rows): only rows whose id contains this substring.'),
  });

  return defineTool({
    name: 'composition',
    domain: 'composition',
    actions: COMPOSITION_ACTIONS,
    readOnlyActions: ['list', 'read', 'validate'],
    description:
      'Read and author agent compositions (presets). A preset is a named patch layered on the factory composition: it enables/disables registered rows, replaces or inserts prompt sections, and caps seams. ' +
      'Use composition(list) to see presets and available row ids, composition(validate) to check a patch before writing it, composition(write) to save a user preset under the composition directory, and composition(delete) to remove one. ' +
      'A preset affects only sessions that select it; an existing session keeps the composition it started with.',
    schema,
    async execute(args) {
      const action = args.action;

      if (action === 'list') {
        const roster = deps.roster();
        const selected = usePresetStore.getState().selected;
        const lines = ['presets（当前全局默认：' + selected + '）'];
        for (const p of roster) {
          const flags = [p.builtin ? '内置' : '用户'];
          if (p.patch === null) flags.push('装载失败');
          const label = p.metadata?.name ?? p.id;
          const desc = p.metadata?.description ? ' — ' + p.metadata.description : '';
          lines.push('- ' + p.id + '（' + flags.join('/') + '）' + (label !== p.id ? ' ' + label : '') + desc);
          if (p.error) lines.push('  ⚠ ' + p.error);
        }
        if (args.rows === true) {
          lines.push('', '可寻址行（patch 里只能写这些 id）：', rowsDigest(args.filter, deps.factory()));
        }
        return lines.join('\n');
      }

      if (action === 'read') {
        if (!args.id) return '拒绝：read 需要 id';
        const entry = findPreset(deps.roster(), args.id);
        if (!entry) return '拒绝：preset 「' + args.id + '」不在册（先用 composition(list) 看清单）';
        if (entry.patch !== null) {
          return [
            '# preset: ' + entry.id + (entry.builtin ? '（内置）' : '（用户）'),
            entry.metadata?.description ? '# ' + entry.metadata.description : '',
            stringifyPatchYaml(entry.patch).trimEnd(),
          ]
            .filter((s) => s !== '')
            .join('\n');
        }
        const root = await io.dir();
        const text = await io.readFile(presetDirPath(root, entry.id) + '/roster.patch.yml');
        return text === null ? '拒绝：' + entry.id + ' 的本体不可读（' + (entry.error ?? '未知原因') + '）' : text;
      }

      if (action === 'validate') {
        if (args.yaml === undefined) return '拒绝：validate 需要 yaml';
        return validateText(args.yaml, deps).text;
      }

      if (action === 'rename' || action === 'copy') {
        if (!args.id) return '拒绝：' + action + ' 需要 id';
        const id = args.id.trim();
        const target = (args.newId ?? '').trim();
        if (target === '') return '拒绝：' + action + ' 需要 newId（新的组合 id）';
        if (!isValidPresetId(id)) return '拒绝：id 不合法：' + id;
        if (!isValidPresetId(target)) return '拒绝：newId 不合法（只允许小写字母/数字/连字符）：' + target;
        if (id === target) return '拒绝：newId 与 id 相同';
        const builtinSrc = builtinPresets().find((p) => p.id === id);
        if (action === 'rename' && builtinSrc) {
          return '拒绝：内置 preset 不能改名（可以先 composition(copy) 成你自己的 id，再改内容）';
        }
        if (builtinPresets().some((p) => p.id === target)) return '拒绝：newId 是内置 id，换一个';
        if (action === 'rename' && usePresetStore.getState().selected === id) {
          return '拒绝：「' + id + '」是当前全局默认组合——先在 设置 › Agent › 组合 里切到别的组合再改名';
        }
        const root = await io.dir();
        const srcDir = presetDirPath(root, id);
        const dstDir = presetDirPath(root, target);
        for (const name of ['roster.patch.yml', 'preset.yml']) {
          const existing = await io.readFile(dstDir + '/' + name);
          if (existing !== null && !(action === 'copy' && args.overwrite === true)) {
            return '拒绝：目标已存在 ' + dstDir + '/' + name + '（换一个 newId，或 copy 时显式 overwrite:true）';
          }
        }
        let yaml: string | null;
        let meta: string;
        if (builtinSrc) {
          // 内置：patch 是代码常量——序列化成 YAML 给用户当起点
          yaml = stringifyPatchYaml(builtinSrc.patch);
          meta = [
            'name: ' + JSON.stringify(target),
            'description: ' + JSON.stringify((builtinSrc.metadata?.description ?? '') + '（复制自 ' + id + '）'),
            '',
          ].join('\n');
        } else {
          // 用户 preset：原样搬字节（保留作者写的注释）
          yaml = await io.readFile(srcDir + '/roster.patch.yml');
          if (yaml === null) return '拒绝：preset「' + id + '」的 roster.patch.yml 不可读（不在册或目录不完整）';
          meta = (await io.readFile(srcDir + '/preset.yml')) ?? ['name: ' + JSON.stringify(target), ''].join('\n');
        }
        try {
          await io.makeDir(dstDir);
          await io.writeFile(dstDir + '/roster.patch.yml', yaml);
          await io.writeFile(dstDir + '/preset.yml', meta);
          if (action === 'rename') {
            for (const name of ['roster.patch.yml', 'preset.yml']) {
              await io.deleteFile(srcDir + '/' + name);
            }
          }
          await io.rescan();
        } catch (e) {
          return (action === 'rename' ? '改名' : '复制') + '失败：' + (e instanceof Error ? e.message : String(e));
        }
        if (action === 'rename') {
          return (
            '已改名为「' +
            target +
            '」：' +
            dstDir +
            '\n注意：已记着旧 id 的卷会显示「不在册」——在新卷上重选该组合即可（或用 composition(list) 确认）。'
          );
        }
        return '已复制为「' + target + '」：' + dstDir;
      }
      if (action === 'delete') {
        if (!args.id) return '拒绝：delete 需要 id';
        const id = args.id.trim();
        // id 是路径段：围栏先过（防 `..` 之类把删除挪出组合根）。
        if (!isValidPresetId(id)) return '拒绝：id 不合法（只允许小写字母/数字/连字符）：' + id;
        if (builtinPresets().some((p) => p.id === id)) {
          return '拒绝：「' + id + '」是内置 preset（内置不可删除）';
        }
        // 删掉全局默认 = 之后所有新卷都解析不出组合：先让用户切走再删。
        if (usePresetStore.getState().selected === id) {
          return '拒绝：「' + id + '」是当前全局默认组合——先在 设置 › Agent › 组合 里切到别的组合再删';
        }
        // 不在册也照删：残留目录 / 发现失败的坏 preset 正是最需要删的。
        const root = await io.dir();
        const dirPath = presetDirPath(root, id);
        try {
          // 两个约定文件都删（不存在不报，删除幂等）：roster.patch.yml 一没，发现层
          // 就不再认这个目录，preset 当场从清单消失。
          for (const name of ['roster.patch.yml', 'preset.yml']) {
            await io.deleteFile(dirPath + '/' + name);
          }
          await io.rescan();
        } catch (e) {
          return '删除失败：' + (e instanceof Error ? e.message : String(e));
        }
        return '已删除 preset「' + id + '」：' + dirPath;
      }

      // write
      if (!args.id) return '拒绝：write 需要 id';
      if (args.yaml === undefined) return '拒绝：write 需要 yaml';
      const id = args.id.trim();
      if (!isValidPresetId(id)) {
        return '拒绝：id 不合法（只允许小写字母/数字/连字符，且不以连字符开头）：' + id;
      }
      const builtin = builtinPresets().find((p) => p.id === id);
      if (builtin) return '拒绝：「' + id + '」是内置 preset id（内置同 id 胜，用户层写不进去）——请换一个名字';

      const checked = validateText(args.yaml, deps);
      if (!checked.ok) return '拒绝写入（校验未通过）：\n' + checked.text;

      const root = await io.dir();
      const dirPath = presetDirPath(root, id);
      if (args.overwrite !== true) {
        for (const name of ['roster.patch.yml', 'preset.yml']) {
          const existing = await io.readFile(dirPath + '/' + name);
          if (existing !== null) {
            return '拒绝：已存在 ' + dirPath + '/' + name + '——覆盖请显式 overwrite: true（默认不抹掉已有内容）';
          }
        }
      }

      const meta = [
        'name: ' + JSON.stringify(args.name ?? id),
        'description: ' + JSON.stringify(args.description ?? '由创作者模式生成'),
        '',
      ].join('\n');
      try {
        await io.makeDir(dirPath);
        await io.writeFile(dirPath + '/roster.patch.yml', checked.canonicalYaml);
        await io.writeFile(dirPath + '/preset.yml', meta);
        await io.rescan();
      } catch (e) {
        return '写入失败：' + (e instanceof Error ? e.message : String(e));
      }
      return [
        '已写入 preset「' + id + '」：' + dirPath,
        '组成：' + checked.text,
        '生效方式：在**空白卷**上选择该组合（卷首「组合」芯片 / 设置 › Agent › 组合），或由程序按组合起卷；已跑过一轮的卷不会中途换面。',
      ].join('\n');
    },
  });
}

type ValidateResult =
  | { ok: false; text: string }
  | { ok: true; text: string; canonicalYaml: string; patch: CompositionPatch };

/** 校验（schema → 行可寻址性；两步都过才算可用）。错误带原因，不静默。 */
export function validateText(text: string, deps: CompositionDeps): ValidateResult {
  const parsed = parsePatchYamlText(text);
  if (!parsed.ok) return { ok: false, text: 'YAML/schema 错误：' + parsed.error };
  let resolved: ResolvedComposition;
  try {
    resolved = deps.resolve(parsed.patch);
  } catch (e) {
    if (e instanceof CompositionPatchError) return { ok: false, text: e.message.replace(/^\[composition\]\s*/, '') };
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
  return {
    ok: true,
    patch: parsed.patch,
    canonicalYaml: stringifyPatchYaml(parsed.patch),
    text: '通过：' + summarizeComposition(resolved),
  };
}
