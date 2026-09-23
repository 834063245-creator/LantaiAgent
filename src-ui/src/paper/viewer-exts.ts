// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// paper/viewer-exts — **查看器扩展名分类表**（宿主层单一真源，2026-09-23 B2 起）。
//
// 为什么落宿主层（而不是留在插件里）：同一张表有两张消费面——
//   ① 渲染产物域的查看器认领表（`plugins/builtin/renderers/viewers/*`——相对 import，
//      esbuild 内联，同 `paper/plate-sign.ts` 先例）；
//   ② 宿主层的静态测高（`paper/measure.ts` 的 `viewerBodyH` 要按类给块高：图 320 /
//      音频固定盒 / 代码固定盒 / 其余文件行）。
// `paper` 层**不得反向 import 插件产物**（宿主 → 插件是反向依赖），故表落宿主层、
// 两侧各自 import（纯常量表无实例身份）。
//
// B1 曾把图/音两张小表镜像在 measure.ts 里靠测试对拍；B2 的代码类一次要 ~50 个扩展名，
// 镜像成本超过收益 ⇒ 改为本表单一真源：**加扩展名 = 改这一处**（或新开一类 →
// `viewerBodyH` 加档）。认领唯一性仍由 viewer-registry 装载期拒绝兜底。
//
// 冻结常量表（CONVENTIONS §1.10 模块级归属第 4 类：初始化后只读）。

/** 图片（`<img>`，保守占满上限高——加载后由 RO 实测收敛）。 */
export const VIEWER_IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

/** 视频（`<video>`；测高沿用 B1 前模型 = 文件行 + RO 实测收敛，本批不动）。 */
export const VIEWER_VIDEO_EXTS: readonly string[] = ['mp4', 'webm', 'ogg', 'mov'];

/** 音频（B1：原生 `<audio>` + 固定盒高）。 */
export const VIEWER_AUDIO_EXTS: readonly string[] = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'opus', 'oga'];

/** 代码/文本（B2：hljs 高亮 + 行号列 + 固定盒高 + 行窗口读取）。
 *  未列 json/jsonl/yaml/toml/xml/csv/tsv/md（留给 B7 数据面与 B14 Markdown 查看器——
 *  扩展名路由唯一，先认领者胜，故本批**不碰**这些）。 */
export const VIEWER_CODE_EXTS: readonly string[] = [
  // 脚本/应用语言
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'py',
  'go',
  'java',
  'kt',
  'kts',
  'cs',
  'rb',
  'php',
  'swift',
  'scala',
  'hs',
  'clj',
  'cljs',
  'jl',
  'lua',
  'pl',
  'pm',
  'r',
  'dart',
  // 系统语言
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  // 前端/样式/标记
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  // 数据/查询/配置（文本形态；结构化查看器留 B7）
  'sql',
  'proto',
  'gradle',
  'ini',
  'cfg',
  // shell 家族
  'sh',
  'bash',
  'zsh',
  'ps1',
  'psm1',
  'bat',
  'cmd',
  // 排版/纯文本
  'tex',
  'txt',
  'log',
];

/** 查看器分类（= 测高按类给档的键）。 */
export type ViewerExtClass = 'image' | 'video' | 'audio' | 'code';

/** 类 → 扩展名表（表序 = 类序，取用时按需）。 */
export const VIEWER_EXTS_BY_CLASS: Readonly<Record<ViewerExtClass, readonly string[]>> = {
  image: VIEWER_IMAGE_EXTS,
  video: VIEWER_VIDEO_EXTS,
  audio: VIEWER_AUDIO_EXTS,
  code: VIEWER_CODE_EXTS,
};

/** ext → 类（小写无点；未认领 = undefined → 宿主走文件壳）。模块装载期一次建表。 */
const CLASS_BY_EXT: ReadonlyMap<string, ViewerExtClass> = new Map(
  (Object.entries(VIEWER_EXTS_BY_CLASS) as Array<[ViewerExtClass, readonly string[]]>).flatMap(([cls, exts]) =>
    exts.map((ext): [string, ViewerExtClass] => [ext, cls]),
  ),
);

/** 取扩展名的查看器分类（宿主层判据与插件认领表同源）。 */
export function viewerClassOf(ext: string | undefined): ViewerExtClass | undefined {
  if (!ext) return undefined;
  return CLASS_BY_EXT.get(ext.trim().toLowerCase().replace(/^\./, ''));
}
