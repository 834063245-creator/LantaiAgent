// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset 作者面（P-1 authoring 环境，2026-09-14）——单二进制下"用户不动源码就能
// 配出一个 preset"的那条链路（设计件
// docs/plans/composition-architecture/designs/S6-per-agent-composition.md §2 序列 F）。
//
// 分工（不发明新能力）：
//   - 目录路径与打开：`composition_dir` RPC（服务端算路径，按需 create_dir_all）；
//   - 落盘：既有 `fs_cap write / create_dir`（`kernelWriteFile` /
//     `kernelCreateDirectory`，UI 用户路径只解析）——**不新开写通道**；
//   - 校验：preset id 走 `isValidPresetId` 同一把围栏（id 是路径段）；
//   - 发现：`rescanPresets()`（免重启重扫，取代 boot-once 的"改完要重启"）。
//
// IO 注入（`PresetAuthoringIo`）：生产走 RPC；测试注入假件——本模块因此零网络
// 依赖，落盘语义（拒覆盖 / 模板内容 / 路径拼接）全部可单测。

import { kernelCreateDirectory, kernelReadFile, kernelWriteFile, typedRpc } from '../rpc-contract';
import { reapplyComposition } from './preset-assembly';
import { type DiscoverPresetsOptions, discoverPresets } from './preset-discovery';
import { builtinPresets, isValidPresetId, type PresetEntry } from './presets';

/** 作者面文件（固定两名——与发现层约定的目录形态一致）。 */
export const PATCH_FILENAME = 'roster.patch.yml';
export const META_FILENAME = 'preset.yml';

/** 组合根绝对路径（按需创建；`open` = 用系统文件管理器打开）。
 *  路径由 Rust 侧计算（`~/.lantai/composition/`），前端不拼家目录。 */
export async function compositionDir(open = false): Promise<string> {
  return typedRpc('composition_dir', { open });
}

/** 免重启重扫（P-1 ④）：重跑 discovery（重写 roster）→ 按当前选择重解析回写组合面。
 *
 *  动机：discovery 此前是 boot-once（`shell/boot.ts` 的 `presetDiscovery ??=`），
 *  且 preset 子树不在 watcher 范围（`composition_watcher.rs` 只盯根级文件）——
 *  用户新建/修好一个 preset 后**看不到它**，会当成功能坏了。
 *
 *  语义：先发现后应用；发现失败（通道不可用）保持现有 roster 与应用面
 *  （「没有通道不是错误」——沿 discovery 纪律）；error 态跳过应用
 *  （用户层 patch 被拒时错误可见优先，沿 reapplyComposition 语义）。 */
export async function rescanPresets(opts: DiscoverPresetsOptions = {}): Promise<void> {
  await discoverPresets(opts);
  reapplyComposition();
}

/** 作者面 IO（生产 = RPC；测试注入假件）。 */
export interface PresetAuthoringIo {
  /** 组合根绝对路径（按需创建；open = 打开文件管理器）。 */
  compositionDir(open: boolean): Promise<string>;
  /** 读一个文件；不存在 → null（拒覆盖的判据）。 */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  makeDir(path: string): Promise<void>;
}

/** 生产 IO（RPC）。`kernelReadFile` 抛错 = 文件不可读（不存在/无权限）——
 *  对"目标目录已存在"的判定按「能读到本体或元数据即视为已存在」从严处理。 */
export const rpcAuthoringIo: PresetAuthoringIo = {
  compositionDir: (open) => typedRpc('composition_dir', { open }),
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
};

/** 路径拼接（Windows / POSIX 都吃 `/`——Rust 侧 resolve 会归一）。 */
export function presetDirPath(root: string, id: string): string {
  return `${root.replace(/[/\\]+$/, '')}/presets/${id}`;
}

/** 模板来源（内置 preset 的真源在 `composition/presets.ts`，不另抄一份）。 */
export type TemplateSource = 'standard' | 'minimal';

/** 模板 patch 内容——从**运行时内置表**派生（真源单一：内置 preset 定义改了，
 *  模板跟着改），再补一段人读的注释头（写文件的人第一眼要看到的就是"这文件
 *  能写什么"）。
 *
 *  standard：零 patch = 出厂全量 → 模板给一份**注释齐全的空骨架**
 *  （告诉作者五个域各写什么形状，但不给任何生效的增量——不给"改坏也没关系"
 *   的假安全感）。
 *  minimal：直接把内置 minimal 的启用增量写成 YAML（现成范例）。 */
export async function templatePatchYaml(from: TemplateSource): Promise<string> {
  const entry = builtinPresets().find((p) => p.id === from);
  const header = [
    '# 兰台组合补丁（preset 本体）——由「复制内置为模板」生成。',
    `# 来源：内置 preset「${from}」。`,
    '#',
    '# 这是**叠加层**：出厂组合 → 用户层 patch（~/.lantai/composition/roster.patch.yml）',
    '#              → 本 preset。同 id 后写胜。',
    '# 可写域与形状（全部可选，不写的域 = 无增量）：',
    '#   tools:        [ { id: <行 id>, disabled: true|false } ]   # disabled:false = 回开「默认关」的行',
    '#   capabilities: [ { id: <capability id>, disabled: true } ]',
    '#   shell:        [ { id: <壳行 id>, disabled: true } ]       # 重启生效',
    '#   prompt:       [ { id: <段 id>, disabled: true } | { id: <段 id>, text: <整段替换> }',
    '#                   | { insert: [ { id: <新段 id>, text: <内容>, before|after: <锚点 id> } ] } ]',
    '#   seam/<域>:    [ { id: <provider 或事件 id>, disabled: true } ]  # 域 = llm|subagents|fs|shell|sessionPersistence|loopEvents',
    '#',
    '# 行 id 可寻址性由装配期校验（写错不会静默：选中该 preset 会被拒绝并给出原因）。',
    '# 文件位置：~/.lantai/composition/presets/<本目录名>/roster.patch.yml',
    '',
  ].join('\n');

  if (!entry || from === 'standard') {
    // 空骨架：注释即文档，零生效增量。
    return `${header}tools: []\n`;
  }
  // 现成范例：把内置 minimal 的增量序列化成 YAML（用 yaml 包的 stringify 而不是
  // 手拼——避免转义/缩进差异造出不可解析的文件）。
  const { stringify } = await import('yaml');
  return `${header}${stringify(entry.patch, { lineWidth: 0 }).trimEnd()}\n`;
}

/** 元数据文件（纯展示；坏元数据降级为无元数据不拒载——发现层语义）。 */
export function templateMetaYaml(id: string, from: TemplateSource): string {
  return [`name: ${id}`, `description: 由内置 ${from} 复制而来（改 roster.patch.yml 定义组合）`, ''].join('\n');
}

export interface CreatePresetResult {
  ok: boolean;
  /** 失败原因（ok=false 时必有）。 */
  error?: string;
  /** 成功时的落盘路径（诊断/展示用）。 */
  dir?: string;
}

/**
 * 从内置 preset 复制一份模板到用户组合目录。
 *
 * 拒覆盖（**关键安全件**）：目标目录已存在（本体或元数据任一可读）→ 拒绝，
 * 绝不覆盖用户已有文件（`fs_cap write` 本身是覆盖语义）。
 *
 * id 围栏：`isValidPresetId`（`/^[a-z0-9][a-z0-9-]*$/`——id 是路径段，
 * 这是围栏规则不是风格规则）；内置 id 也拒绝（内置胜的语义下，同 id 用户
 * preset 会被 discovery 剔除，写进去只会让人困惑）。
 */
export async function createPresetFromTemplate(
  id: string,
  from: TemplateSource,
  io: PresetAuthoringIo = rpcAuthoringIo,
): Promise<CreatePresetResult> {
  const trimmed = id.trim();
  if (!trimmed) return { ok: false, error: '请先填一个 preset id' };
  if (!isValidPresetId(trimmed)) {
    return { ok: false, error: `id 不合法：只允许小写字母/数字/连字符，且不以连字符开头（收到 "${trimmed}"）` };
  }
  if (builtinPresets().some((p) => p.id === trimmed)) {
    return { ok: false, error: `"${trimmed}" 是内置 preset id（内置同 id 胜）——请换一个名字` };
  }

  let root: string;
  try {
    root = await io.compositionDir(false);
  } catch (e) {
    return { ok: false, error: `取组合目录失败：${errText(e)}` };
  }
  const dir = presetDirPath(root, trimmed);
  // 拒覆盖：任一约定文件可读 = 目录已被占用
  for (const name of [PATCH_FILENAME, META_FILENAME]) {
    const existing = await io.readFile(`${dir}/${name}`);
    if (existing !== null) {
      return { ok: false, error: `已存在 ${dir}/${name}——不覆盖已有 preset，请换 id 或先手工改名` };
    }
  }

  try {
    await io.makeDir(dir);
    await io.writeFile(`${dir}/${PATCH_FILENAME}`, await templatePatchYaml(from));
    await io.writeFile(`${dir}/${META_FILENAME}`, templateMetaYaml(trimmed, from));
  } catch (e) {
    return { ok: false, error: `写盘失败：${errText(e)}` };
  }
  return { ok: true, dir };
}

/** 组合目录里发现的用户 preset（roster 过滤，作者面展示用）。 */
export function userPresetsOf(roster: PresetEntry[]): PresetEntry[] {
  return roster.filter((p) => !p.builtin);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
