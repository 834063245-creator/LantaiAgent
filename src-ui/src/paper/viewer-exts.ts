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

/** 表格数据（B7：csv/tsv —— 复用 `grid` 原语；分页/截断横幅在查看器内）。 */
export const VIEWER_TABLE_EXTS: readonly string[] = ['csv', 'tsv'];

/** 结构化数据树（B7：json/jsonl/yaml/toml/xml —— 折叠树；jsonl 逐行独立根）。 */
export const VIEWER_TREE_EXTS: readonly string[] = ['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml'];

/** 归档（B8：**只列目录不解压**；7z 需引库 ⇒ 本包不做，见施工单 §11）。 */
export const VIEWER_ARCHIVE_EXTS: readonly string[] = ['zip', 'tar', 'gz'];

/** 字体（B10：字形样本 + `@font-face` 动态装载）。 */
export const VIEWER_FONT_EXTS: readonly string[] = ['ttf', 'otf', 'woff', 'woff2'];

/** 化学结构文件（B12：mol/sdf/pdb —— molfile 自带 2D 坐标，自绘原子/键）。 */
export const VIEWER_CHEM_EXTS: readonly string[] = ['mol', 'sdf', 'pdb'];

/** 地理数据（B12：外边界 + 要素点简图，不做投影完整实现）。 */
export const VIEWER_GEO_EXTS: readonly string[] = ['geojson', 'kml'];

/** 字幕（B13：时间轴表 + 时长读数）。 */
export const VIEWER_SUBTITLE_EXTS: readonly string[] = ['srt', 'vtt'];

/** 邮件（B13：头字段 + 正文 + 附件列表；附件本身走各自查看器）。 */
export const VIEWER_MAIL_EXTS: readonly string[] = ['eml'];

/** PDF（P2 · B3）——**重依赖**：本体在应用 bundle（pdfjs-dist 走 vite 真分片），
 *  产物侧只登记认领与读取形态（`ViewerDef.heavy = 'pdf'`）。 */
export const VIEWER_PDF_EXTS: readonly string[] = ['pdf'];

/** 3D 模型（P2 · B9）——**重依赖**：本体在应用 bundle（three + 各 loader）。 */
export const VIEWER_MODEL_EXTS: readonly string[] = ['glb', 'gltf', 'obj', 'stl'];

/** Office（P3 · B4）：内容经 officecli 读（走 `process_cap office_exec` 用户路径），
 *  **不读字节** ⇒ 轻查看器，住产物。 */
export const VIEWER_OFFICE_EXTS: readonly string[] = ['docx', 'xlsx', 'pptx'];

/** 旧 Office（P3 · B5 余项）：**不解析**，出文件壳 + 类型标记 + 系统打开出口。 */
export const VIEWER_LEGACY_OFFICE_EXTS: readonly string[] = ['doc', 'xls', 'ppt'];

/** 电子书（P3 · B11）：zip + deflate 自绘解析（零依赖），章节目录 + 正文。 */
export const VIEWER_EPUB_EXTS: readonly string[] = ['epub'];

/** 笔记本（P3 · B11）——**重**：markdown 单元格要复用应用侧渲染器 ⇒ 走 `heavy` 通道。 */
export const VIEWER_IPYNB_EXTS: readonly string[] = ['ipynb'];

/** Markdown 独立查看（P3 · B14）——**重**：同上（复用应用侧 `MarkdownBody` + 标题树）。 */
export const VIEWER_MARKDOWN_EXTS: readonly string[] = ['md'];

/** 兜底查看器（B8：**未认领的扩展名**不再落文件壳）——`hex` 是 catch-all，无认领表：
 *  读字节后先嗅探（可打印 UTF-8 → 文本视图；否则 → hex 视图），两条都带「未认领」横幅。 */
export const VIEWER_CATCHALL_ID = 'hex';

/** 盒高类（B7-B13 的查看器共用一档盒高：静态测高取上限**保守**，挂载后 RO 收敛——
 *  与图片「保守占满上限」、代码「max-height 上限」同一条纪律；将来某类要单独调高，
 *  在 measure 的 `VIEWER_BOX_H` 分支按类给值即可）。 */
export const VIEWER_BOX_CLASSES: readonly ViewerExtClass[] = [
  'table',
  'tree',
  'archive',
  'font',
  'chem',
  'geo',
  'subtitle',
  'mail',
  'pdf',
  'model3d',
  'office',
  'legacy-office',
  'epub',
  'ipynb',
  'markdown-doc',
];

/** 查看器分类（= 测高按类给档的键）。 */
export type ViewerExtClass =
  | 'image'
  | 'video'
  | 'audio'
  | 'code'
  | 'table'
  | 'tree'
  | 'archive'
  | 'font'
  | 'chem'
  | 'geo'
  | 'subtitle'
  | 'mail'
  | 'pdf'
  | 'model3d'
  | 'office'
  | 'legacy-office'
  | 'epub'
  | 'ipynb'
  | 'markdown-doc';

/** 类 → 扩展名表（表序 = 类序，取用时按需）。 */
export const VIEWER_EXTS_BY_CLASS: Readonly<Record<ViewerExtClass, readonly string[]>> = {
  image: VIEWER_IMAGE_EXTS,
  video: VIEWER_VIDEO_EXTS,
  audio: VIEWER_AUDIO_EXTS,
  code: VIEWER_CODE_EXTS,
  table: VIEWER_TABLE_EXTS,
  tree: VIEWER_TREE_EXTS,
  archive: VIEWER_ARCHIVE_EXTS,
  font: VIEWER_FONT_EXTS,
  chem: VIEWER_CHEM_EXTS,
  geo: VIEWER_GEO_EXTS,
  subtitle: VIEWER_SUBTITLE_EXTS,
  mail: VIEWER_MAIL_EXTS,
  pdf: VIEWER_PDF_EXTS,
  model3d: VIEWER_MODEL_EXTS,
  office: VIEWER_OFFICE_EXTS,
  'legacy-office': VIEWER_LEGACY_OFFICE_EXTS,
  epub: VIEWER_EPUB_EXTS,
  ipynb: VIEWER_IPYNB_EXTS,
  'markdown-doc': VIEWER_MARKDOWN_EXTS,
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
