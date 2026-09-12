// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/tool-text — 脚注（tool）/程文（code）载荷的展示规整：渲染、测量与墨迹
// 共用的单一变换。
//
// 缘起（2026-08-30 会话流渲染专项）：ToolBody 直接平铺 args 原始 JSON 串
// （单行长串靠 break-all 硬折），展开后不可读。此处规整为 pretty JSON；
// 测量端（measure.ts 的 tool/code argsH）必须消费同一变换——否则测高与
// 渲染行数漂移（镜像纪律）。
//
// 2026-09-14 工具卡可读性专项（用户报「展开之后乱得要死，看着跟乱码一样」）——
// 三条病灶（真机载荷实测）与对策：
//   ① ANSI 转义裸奔：shell 输出实况 `\u001b[0m\u001b[36mChecked 703 files…`，
//      终端的颜色指令在纸面上是字面乱码 → sanitizePayloadText 剔除转义序列
//      与其余 C0 控制字符，CR 归一为换行（进度条覆盖写不留残影）；
//   ② JSON 双重转义：载荷是「JSON 文本里的 JSON 值」时，Windows 路径实况
//      `"\\\\?\\D:\\HoloGramHG\\docs\\adr\\…"` 双反斜杠刺眼 → 走 JSON.parse
//      取真值再打印，字符串值解转义（单反斜杠路径直接可读）；
//   ③ 单行巨串无结构：search/fs/graph 动辄 20–30KB 单行 JSON，break-all 把
//      每个 token 从中间剁开 → 结构化打印（一键一行 + 缩进 + 标量类型着色 +
//      短容器内联 + 数组条目列表化），行数由同一模型投影（toolLinesText），
//      测量/渲染/墨迹三面逐字同源。
//
// 产物形状：ToolDisplay = { text, lines }——lines 是结构化行（渲染层逐片着色），
// text 是行的逐字投影（测量/墨迹消费，与渲染文本内容完全一致）。纯文本载荷
// lines = null（渲染层直出 text，不逐行分词——47KB 文件内容不炸成几千个节点）。

/** 行内片段语义（渲染层映射 CSS 类；'plain' 无类）。 */
export type ToolTone =
  | 'key' // 键名
  | 'str' // 字符串值（含引号）
  | 'num' // 数字/布尔/null 字面量
  | 'punct' // 结构符号：花括号/方括号/逗号/列表标记
  | 'note' // 注记：项数、「… 其余 N 行」截断说明
  | 'plain'; // 原样文本

/** 展示行内片段——渲染逐片着色，文本即展示内容。 */
export interface ToolSpan {
  text: string;
  tone: ToolTone;
}

/** 展示行：缩进级 + 可选列表标记 + 行内片段。 */
export interface ToolLine {
  /** 缩进级（每级 2 空格——mono 字体下与测量逐字对齐）。 */
  level: number;
  /** 数组条目标记（`· `——纸面列表同款符号）。 */
  marker?: boolean;
  parts: ToolSpan[];
}

/** 载荷展示模型。 */
export interface ToolDisplay {
  /** 展示文本（测量/墨迹消费；与 lines 的渲染文本逐字一致）。 */
  text: string;
  /** 结构化行；null = 纯文本载荷（渲染层直出 text）。 */
  lines: ToolLine[] | null;
}

/* ── ① 洁净：ANSI 转义与 C0 控制字符 ── */
/* biome-ignore-start lint/suspicious/noControlCharactersInRegex: 本模块的职责就是识别并剔除控制字符——转义序列必须按字面写 */
/** CSI 序列（`\u001b[36m` 等，含参数/中间字节）。 */
const ANSI_CSI_RE = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]/g;
/** OSC 序列（`\u001b]0;标题\u0007`——窗口标题类，含未闭合兜底到串尾）。 */
const ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g;
/** 单字符转义 + 字符集选择序列（`\u001b(B` / `\u001b)0` / `\u001b#8` 等）。 */
const ANSI_ESC_RE = /\u001b(?:[()*+#%][0-9A-Za-z]?|[@-Z\\-_])/g;
/** 其余 C0 控制字符 + DEL（保留 \t \n \r——换行与制表是版式语义）。 */
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/* biome-ignore-end lint/suspicious/noControlCharactersInRegex: 同上 */

/** 载荷洁净化：ANSI 转义剔除 + CR 归一换行 + 其余控制字符剔除。
 *  渲染/测量/墨迹三面共用（展示文本的唯一上游）。 */
export function sanitizePayloadText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESC_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CTRL_RE, '');
}

/* ── ② 结构化打印（JSON 载荷）── */

/** 每级缩进空格数（字面空格写进展示文本——渲染与测量消费同一串，字体宽窄无关）。 */
const INDENT = '  ';
/** 内联容器展示长度上限（超过就摊成多行）。 */
const INLINE_MAX = 84;
/** 内联标量数组元素上限。 */
const INLINE_ARRAY_MAX = 8;
/** 内联标量对象键数上限。 */
const INLINE_OBJECT_MAX = 5;
/** 展示行上限（超限截断并留「其余 N 行」注记——20–30KB JSON 不炸 DOM）。 */
const MAX_LINES = 400;

/** 字符串值展示文本：解转义后的字面（Windows 路径单反斜杠直接可读）；
 *  引号是字符串的语法标志（值内引号转义回写）；换行/制表转义回字面——
 *  一条字段恒一行，行数与测量同源。 */
function quoteString(s: string): string {
  return `"${s.replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** 键名展示：含空白/冒号/引号的键加引号（展示面歧义防御）。 */
function displayKey(k: string): string {
  if (/[\s:"]/.test(k)) return `"${k.replace(/"/g, '\\"')}"`;
  return k;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 标量片段（字符串/数字/布尔/null）；非标量返回 null。 */
function scalarSpan(v: unknown): ToolSpan | null {
  if (v === null) return { text: 'null', tone: 'num' };
  switch (typeof v) {
    case 'string':
      return { text: quoteString(v), tone: 'str' };
    case 'number':
      return { text: String(v), tone: 'num' };
    case 'boolean':
      return { text: String(v), tone: 'num' };
    default:
      return null;
  }
}

const PUNCT = (text: string): ToolSpan => ({ text, tone: 'punct' });
const KEY = (k: string): ToolSpan => ({ text: `${displayKey(k)}: `, tone: 'key' });

/** 逗号连接（逗号本身是结构符——单独成片，渲染端可弱化）。 */
function joinSpans(items: ToolSpan[][], sep = ', '): ToolSpan[] {
  const out: ToolSpan[] = [];
  items.forEach((it, i) => {
    if (i > 0) out.push(PUNCT(sep));
    out.push(...it);
  });
  return out;
}

function spansText(parts: ToolSpan[]): string {
  let s = '';
  for (const p of parts) s += p.text;
  return s;
}

/** 内联形态（单行可读容器）：短对象/短标量数组 → 片段；不适合内联返回 null。 */
function inlineSpans(v: unknown): ToolSpan[] | null {
  const scalar = scalarSpan(v);
  if (scalar !== null) return [scalar];
  if (Array.isArray(v)) {
    if (v.length === 0) return [PUNCT('[]')];
    if (v.length > INLINE_ARRAY_MAX) return null;
    const items = v.map(inlineSpans);
    if (items.some((x) => x === null)) return null;
    const body = joinSpans(items as ToolSpan[][]);
    if (spansText(body).length > INLINE_MAX) return null;
    return [PUNCT('['), ...body, PUNCT(']')];
  }
  if (isRecord(v)) {
    const entries = Object.entries(v);
    if (entries.length === 0) return [PUNCT('{}')];
    if (entries.length > INLINE_OBJECT_MAX) return null;
    const items: ToolSpan[][] = [];
    for (const [k, val] of entries) {
      const inner = inlineSpans(val);
      if (inner === null) return null;
      items.push([KEY(k), ...inner]);
    }
    const body = joinSpans(items);
    if (spansText(body).length > INLINE_MAX) return null;
    return [PUNCT('{'), { text: ' ', tone: 'plain' }, ...body, { text: ' ', tone: 'plain' }, PUNCT('}')];
  }
  return null;
}

/** 递归摊行为清单：
 *  - 标量/短容器 → 单行；
 *  - 数组 → `[ N 项` 头 + 条目（对象条目走无花括号的列表体：首字段挂 `· `，
 *    其余字段缩进一级——无头浏览器实测 `· ` 与两级缩进等宽，字段左缘对齐）；
 *  - 对象 → `key: {` 头 + 逐键行 + `}` 尾。
 *  数组条目形状一致性：全条目都能内联才逐条内联，否则整列摊开成列表体——
 *  同一列表里一行式与多行式混排是最刺眼的杂乱源。
 *  noInline：条目级禁用内联（列表体强制，嵌套字段的内联不受影响）。 */
function emit(
  v: unknown,
  level: number,
  out: ToolLine[],
  opts: { key?: string; marker?: boolean; noInline?: boolean },
): void {
  if (!opts.noInline) {
    const inline = inlineSpans(v);
    if (inline !== null) {
      const parts: ToolSpan[] = [];
      if (opts.key !== undefined) parts.push(KEY(opts.key));
      parts.push(...inline);
      out.push({ level, marker: opts.marker, parts });
      return;
    }
  }
  if (Array.isArray(v)) {
    const head: ToolSpan[] = [];
    if (opts.key !== undefined) head.push(KEY(opts.key));
    head.push(PUNCT('['), { text: ` ${v.length} 项`, tone: 'note' });
    out.push({ level, marker: opts.marker, parts: head });
    const itemInline = v.map(inlineSpans);
    const uniformInline = itemInline.every((x) => x !== null);
    v.forEach((item, i) => {
      const scalar = scalarSpan(item);
      if (scalar !== null) {
        out.push({ level: level + 1, marker: true, parts: [scalar] });
        return;
      }
      const inline = uniformInline ? itemInline[i] : null;
      if (inline !== null && inline !== undefined) {
        out.push({ level: level + 1, marker: true, parts: inline });
        return;
      }
      emit(item, level + 1, out, { marker: true, noInline: true });
    });
    out.push({ level, parts: [PUNCT(']')] });
    return;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (opts.marker) {
    // 列表条目对象：不套花括号——首字段挂标记，其余字段缩进一级（标记宽两字）
    entries.forEach(([k, val], i) => {
      emit(val, i === 0 ? level : level + 1, out, i === 0 ? { key: k, marker: true } : { key: k });
    });
    return;
  }
  const head: ToolSpan[] = [];
  if (opts.key !== undefined) head.push(KEY(opts.key));
  head.push(PUNCT('{'));
  out.push({ level, parts: head });
  for (const [k, val] of entries) emit(val, level + 1, out, { key: k });
  out.push({ level, parts: [PUNCT('}')] });
}

/** 展示行 → 展示文本（测量/墨迹的逐字投影；渲染文本内容与之一致）。 */
export function toolLinesText(lines: readonly ToolLine[]): string {
  return lines.map((l) => INDENT.repeat(l.level) + (l.marker ? '· ' : '') + spansText(l.parts)).join('\n');
}

/** 行数封顶：超限截首 + 注记（信息不静默丢失——注记报明总量）。 */
function capLines(lines: ToolLine[]): ToolLine[] {
  if (lines.length <= MAX_LINES) return lines;
  const total = lines.length;
  const kept = lines.slice(0, MAX_LINES);
  kept.push({
    level: 0,
    parts: [{ text: `… 其余 ${total - MAX_LINES} 行未展开（共 ${total} 行）`, tone: 'note' }],
  });
  return kept;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 混合载荷里的 JSON 行判据：整行是容器 + 至少这么长才值得展开
 *  （日志里夹的 500 字单行 JSON 是「乱」的主角；短 `{}` 行展开反而更啰嗦）。 */
const JSON_LINE_MIN = 120;

function lineJson(line: string): unknown | undefined {
  const t = line.trim();
  if (t.length < JSON_LINE_MIN) return undefined;
  const head = t.slice(0, 1);
  if (head !== '{' && head !== '[') return undefined;
  return tryParseJson(t);
}

/**
 * 载荷 → 展示模型。
 * 三条路：
 *   ① 整段是 JSON 容器 → 结构化行（键值行 + 缩进 + 类型着色）；
 *   ② 纯文本里夹长 JSON 行（日志/命令输出常见）→ 逐行展开，**仅当展开后行数
 *      不超上限**——大文件内容不因个别 JSON 行被截断（超限回落纯文本，保住全文）；
 *   ③ 其余 → 纯文本（仅洁净化：ANSI/控制字符/CR）。
 * 解析只对容器形态尝试：纯文本载荷零解析开销。
 */
export function toolDisplay(raw: string | undefined): ToolDisplay {
  const clean = sanitizePayloadText(raw ?? '');
  const head = clean.trimStart().slice(0, 1);
  if (head === '{' || head === '[') {
    const parsed = tryParseJson(clean.trim());
    if (parsed !== undefined) {
      const lines: ToolLine[] = [];
      emit(parsed, 0, lines, {});
      const capped = capLines(lines);
      return { text: toolLinesText(capped), lines: capped };
    }
  }
  const rawLines = clean.split('\n');
  if (rawLines.some((l) => lineJson(l) !== undefined)) {
    const lines: ToolLine[] = [];
    for (const line of rawLines) {
      const parsed = lineJson(line);
      if (parsed === undefined) {
        if (line) lines.push({ level: 0, parts: [{ text: line, tone: 'plain' }] });
        else lines.push({ level: 0, parts: [] });
        continue;
      }
      emit(parsed, 0, lines, {});
    }
    if (lines.length <= MAX_LINES) return { text: toolLinesText(lines), lines };
  }
  return { text: clean, lines: null };
}

/** 载荷是否值得展示（洁净化后仍有非空白字符）：空白输出不再支起空段头——
 *  渲染（PayloadSection 可见性）与测量（measure 段高）同判据。 */
export function hasPayloadToShow(raw: string | undefined): boolean {
  return sanitizePayloadText(raw ?? '').trim().length > 0;
}

/** 参数是否值得展示（2026-09-01 三轴审计 F1）：空串/纯空白/`{}`/`[]`/`null` =
 *  空/无意义——错误卡里裸奔的 JSON 骨架是纯噪音。渲染（ToolBody）、测量
 *  （measure tool argsH）、墨迹（inkSourcesFor）与折叠行（foldLabel 待执行判定）
 *  四处消费同一判据——镜像纪律，改判据四处同步。 */
export function hasArgsToShow(args: string | undefined): args is string {
  if (!args?.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed === null) return false;
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (typeof parsed === 'object') return Object.keys(parsed).length > 0;
    return true;
  } catch {
    return true;
  }
}

/** 参数摘要键优先级：edit/shell 族的关键目标（file_path/command）按这些键名先取。 */
const DIGEST_KEY_RE = /path|file|cmd|command|query|url|pattern|skill|description|name/i;
const DIGEST_MAX = 40;

/** 工具参数摘要（折叠行用，2026-08-30 会话流专项）：从 args 取「这个调用干了什么」
 *  的短摘要——优先命中目标键（file_path/command/query…）的首个字符串值，兜底
 *  首个字符串值；非对象取原串。流式未完（JSON 没闭合）按原串首行兜底。 */
export function toolDigest(args: string, max = DIGEST_MAX): string {
  if (!args) return '';
  const shorten = (s: string): string => {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === 'string') return shorten(parsed);
    if (Array.isArray(parsed)) {
      const v = parsed.find((x) => typeof x === 'string' && x.length > 0);
      return typeof v === 'string' ? shorten(v) : '';
    }
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const keyed = entries.find(([k, v]) => DIGEST_KEY_RE.test(k) && typeof v === 'string' && v.length > 0);
      const first = entries.find(([, v]) => typeof v === 'string' && v.length > 0);
      const v = keyed?.[1] ?? first?.[1];
      return typeof v === 'string' ? shorten(v) : '';
    }
    return '';
  } catch {
    const firstLine = args.split('\n')[0] ?? '';
    return firstLine.trim() ? shorten(firstLine) : '';
  }
}
