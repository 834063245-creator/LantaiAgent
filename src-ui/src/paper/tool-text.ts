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
//
// 2026-09-19 程文（code）输出换代（用户报「输出栏一点没处理，跟乱码一样」）
// ——两条病灶 + 一条形态缺口（69 个存盘 code_execution 结果实测）：
//   ① 完成值二次编码：程序 `return <字符串>` 时完成值经 JSON.stringify 再编码
//      一层，真换行变字面 `\n`、引号变 `\"`（45/52 个字符串完成值样本，转义
//      噪音占 10.1% 字符）→ 数据面不再对字符串完成值编码（code-run/bootstrap），
//      展示面对存量旧卷补一条「字符串载荷解开」（toolDisplay 路径⓪，层数封顶）；
//   ② 信封当正文：`── logs ──` / `── result ──` / `[code_execution 失败]` 是
//      自产信封，此前整段直出 → codeSections 解析成真段，段头走 .pp-sec-head
//      同一套（日志 / 完成值 / 错误），测量端消费同一 codeDisplay。
//
// 同批的值级展开与尽力结构打印（同一病灶的另一半：字符串值不是「一个字段」
// 而是文档/结构，「模型自己 slice 过的 JSON」不是合法 JSON 但结构还在）：
//   - 值级：长字符串值是 JSON 容器 → 当结构渲染；是多行文档 → 块引 `key: │`
//     + 逐行正文；是截断的嵌 JSON（含 `"{\"a\":…` 双层编码）→ 尽力结构；
//   - 整段/整行/长 token：同上三条兜底（bestEffortLines——串外定界符换行，
//     串内只做 JSON 转义的忠实还原）。
// 真机 83 个存盘 code_execution 结果回放：含 >800 字符单行的样本 41 → 6，
// 字面 `\n` 转义总数 2410 → 15，最长物理行 14698 → 3500（残差 = 表格行/CLI
// 帮助这类本来就长的单行，可视换行即可）。

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

/** 值级展开门槛（2026-09-19）：字符串值里嵌的**文档/结构**多长才值得摊开。
 *  短值内联照旧（`path: "a.md"` 摊成三行是倒退）。 */
const VALUE_BLOCK_MIN = 120;
/** 值级展开层数上限（防「字符串套 JSON 套字符串」深链）。 */
const MAX_EXPAND = 2;

/* ── 尽力而为结构打印（被截断的 JSON）── */

/** JSON 形态判据（松）：容器开头 + 紧跟键引号/字面量——`[任务已完成, exit code: 0]`
 *  这类 shell 行不误判（`[` 后是汉字/字母即出局）。 */
const JSON_SHAPE_RE = /^[{[]\s*(?:"|\d|-|true|false|null|\{|\}|\[|\])/;
/** 长 token 解转义折行的门槛：字面 `\n` 个数（与字符门槛合用——短值照旧内联）。 */
const STRING_BREAK_ESCAPES = 3;
const LENIENT_UNESCAPE_RE = /\\(n|t|r|"|\\)/g;

/** JSON 串转义 → 真字符（截断串没有闭合引号也能还原；只认标准五类转义）。 */
function unescapeLenient(s: string): string {
  return s.replace(LENIENT_UNESCAPE_RE, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : c));
}

/** 文本 → 纯文本行（值块引用）。 */
function plainLines(s: string): ToolLine[] {
  return s
    .split('\n')
    .map((l) => (l ? { level: 0, parts: [{ text: l, tone: 'plain' as const }] } : { level: 0, parts: [] }));
}

/** 段头 `key: │` + 块体逐行（值是多行文档/结构时的展开形态）。 */
function emitBlock(
  out: ToolLine[],
  level: number,
  opts: { key?: string; marker?: boolean },
  body: readonly ToolLine[],
): void {
  const lead: ToolSpan[] = [];
  if (opts.key !== undefined) lead.push(KEY(opts.key));
  lead.push(PUNCT('│'));
  out.push({ level, marker: opts.marker, parts: lead });
  for (const l of body) out.push({ level: level + 1 + l.level, marker: l.marker, parts: l.parts });
}

/** 截断 JSON → 尽力结构行（2026-09-19）。真机长行的最大成因：模型自己
 *  `JSON.stringify(x).slice(0, 4000)`——整段 parse 必然失败（尾巴被切掉），
 *  但结构还在。本函数按「串外定界符」换行缩进：`{`/`[` 后降级、`,` 后断行、
 *  `}`/`]` 前回级，**串内一字不改**（只动空白）；长 token 两级兜底：
 *  ① 带成串字面 `\n` 的 → 还原成真换行（截断的编码串没有闭合引号也能还原）；
 *  ② 仍是截断 JSON 串的 → 嵌套一层尽力结构（depth 封顶，防深链）。
 *  前导 `"` 先剥壳解转义再判形态（`"{\"pattern\":…` 这类双层编码的截断串）。
 *  返回 null = 不像 JSON / 没摊出结构（调用方回落纯文本）。 */
function bestEffortLines(text: string, depth = 0): ToolLine[] | null {
  let t = text.trim();
  if (t.slice(0, 1) === '"') {
    const body = unescapeLenient(t.slice(1)).trimStart();
    if (JSON_SHAPE_RE.test(body)) t = body;
  }
  if (t.length < JSON_LINE_MIN || !JSON_SHAPE_RE.test(t)) return null;
  const lines: ToolLine[] = [];
  let buf = '';
  let level = 0;
  let inStr = false;
  let esc = false;
  let strEnd = 0; // buf 内最近一次字符串闭合处（「键: 长值」的切分点）
  const pushToken = (token: string): void => {
    if (token.length >= VALUE_BLOCK_MIN) {
      if ((token.match(/\\n/g)?.length ?? 0) >= STRING_BREAK_ESCAPES) {
        // 长 token 里成串的字面 \n：还原成真内容（一整篇文档不再压成一行）；
        // 首行带 `"key":` 前缀留在本级，续行降一级（块体观感）
        const parts = unescapeLenient(token).split('\n');
        parts.forEach((l, i) => {
          lines.push({ level: i === 0 ? level : level + 1, parts: l ? [{ text: l, tone: 'plain' }] : [] });
        });
        return;
      }
      const nested = depth < MAX_EXPAND ? bestEffortLines(token, depth + 1) : null;
      if (nested) {
        for (const l of nested) lines.push({ level: level + 1 + l.level, parts: l.parts });
        return;
      }
    }
    lines.push({ level, parts: [{ text: token, tone: 'plain' }] });
  };
  const flush = (): void => {
    let token = buf;
    const at = strEnd;
    buf = '';
    strEnd = 0;
    if (!token.trim()) return;
    // 截断的内层串会把「键: 长值」并成一个 token（键串闭合后 inStr 再也不闭合，
    // 于是余下全文都算「串内」）→ 在末个字符串闭合处切回两段，值走长 token 处理。
    // 真机形态：`{"hits":"{\"pattern\":…`（4000 字符单行的成因）。
    if (at > 0 && token.length - at >= VALUE_BLOCK_MIN) {
      const tail = token.slice(at);
      lines.push({ level, parts: [{ text: `${token.slice(0, at)}:`, tone: 'plain' }] });
      token = tail.startsWith(':') ? tail.slice(1) : tail;
    }
    pushToken(token);
  };
  for (const ch of t) {
    if (inStr) {
      buf += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        strEnd = buf.length;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      buf += ch;
      flush();
      level += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      flush();
      level = Math.max(0, level - 1);
      buf = ch;
      continue;
    }
    if (ch === ',') {
      buf += ch;
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return lines.length >= 4 ? lines : null;
}

/** 字符串值 → 展开形态（2026-09-19 值级展开）。真机载荷里字符串值常常不是
 *  「一个字段」而是**一篇文档或一个结构**，旧观感把它们压成一行转义串：
 *   ① 值本身是 JSON 容器（工具返回 JSON 文本 → 程序塞进对象）→ 解出来当结构渲染
 *      （与整段字符串载荷同一条纪律，见 toolDisplay 路径⓪）；
 *   ② 值是新行文本（文件内容 / 清单 / 表格导出）→ 块引 `key: │` + 逐行正文
 *      （真机最刺眼样本 = 一行 14681 字符里塞着 119 个字面 \n 的契约文档）；
 *   ③ 值是被 slice 截断的 JSON（含「字符串里的字符串」形态）→ 尽力结构打印。
 *  返回 true = 已展开（调用方不再走内联/容器分支）。 */
function expandStringValue(
  v: string,
  level: number,
  out: ToolLine[],
  opts: { key?: string; marker?: boolean; expand: number },
): boolean {
  if (v.length < VALUE_BLOCK_MIN || opts.expand >= MAX_EXPAND) return false;
  // 值自己也可能是「字符串里的字符串」（工具返回 JSON 文本 → 程序又塞进对象，
  // 真机 `· "\"{\\"entries\\":…` 形态）→ 与整段载荷同一条解开纪律，层数封顶。
  let text = v;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    const inner = unwrapStringLiteral(text);
    if (inner === null) break;
    text = inner;
  }
  const head = text.trimStart().slice(0, 1);
  if (head === '{' || head === '[') {
    const parsed = tryParseJson(text.trim());
    if (parsed !== undefined) {
      emit(parsed, level, out, { key: opts.key, marker: opts.marker, expand: opts.expand + 1 });
      return true;
    }
  }
  // 截断的嵌 JSON（含 `"{\"a\":…` 双层编码的截断串——剥壳解转义由 bestEffortLines
  // 统一处理）：尽力结构优于原样一行（真机数例：截断的 search/fs 结果串）
  const lenient = bestEffortLines(text);
  if (lenient) {
    emitBlock(out, level, opts, lenient);
    return true;
  }
  if (text.includes('\n')) {
    emitBlock(out, level, opts, plainLines(text));
    return true;
  }
  return false;
}

/** 递归摊行为清单：
 *  - 标量/短容器 → 单行；
 *  - 长字符串值（内嵌文档/结构）→ 值级展开（expandStringValue）；
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
  opts: { key?: string; marker?: boolean; noInline?: boolean; expand?: number },
): void {
  const expand = opts.expand ?? 0;
  if (typeof v === 'string' && expandStringValue(v, level, out, { ...opts, expand })) return;
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
        // 长字符串条目同样值级展开（文档/结构嵌在数组里的形态）
        if (typeof item === 'string' && expandStringValue(item, level + 1, out, { marker: true, expand })) return;
        out.push({ level: level + 1, marker: true, parts: [scalar] });
        return;
      }
      const inline = uniformInline ? itemInline[i] : null;
      if (inline !== null && inline !== undefined) {
        out.push({ level: level + 1, marker: true, parts: inline });
        return;
      }
      emit(item, level + 1, out, { marker: true, noInline: true, expand });
    });
    out.push({ level, parts: [PUNCT(']')] });
    return;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (opts.marker) {
    // 列表条目对象：不套花括号——首字段挂标记，其余字段缩进一级（标记宽两字）
    entries.forEach(([k, val], i) => {
      emit(val, i === 0 ? level : level + 1, out, i === 0 ? { key: k, marker: true, expand } : { key: k, expand });
    });
    return;
  }
  const head: ToolSpan[] = [];
  if (opts.key !== undefined) head.push(KEY(opts.key));
  head.push(PUNCT('{'));
  out.push({ level, parts: head });
  for (const [k, val] of entries) emit(val, level + 1, out, { key: k, expand });
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

/** 字符串载荷解开层数上限（防「套娃 JSON 字符串」无限解）。两层覆盖实况：
 *  程序 `return JSON.stringify(x)`（一层）与工具本身再返回 JSON 串（两层）。 */
const MAX_UNWRAP = 2;

/** 字符串字面量解开（2026-09-19 程文输出换代）：载荷整体是一个 JSON 字符串
 *  字面量时取其本体。真机实况——程序 `return <一段文本>`，完成值经
 *  JSON.stringify 二次编码，于是真换行变字面 `\n`、引号变 `\"`、Windows 路径
 *  `\\?\D:\` 变 `\\\\?\\D:\\`：40 行清单塌成一行 2678 字符，纸面读作乱码。
 *  契约：只认「能 parse 成字符串」且「解开后严格更短」的形态（后者是防环兜底——
 *  JSON 字符串字面量恒比本体长，不满足即不是编码形态，原样返回 null）。 */
function unwrapStringLiteral(text: string): string | null {
  const t = text.trim();
  if (t.slice(0, 1) !== '"') return null;
  const parsed = tryParseJson(t);
  if (typeof parsed !== 'string') return null;
  if (parsed.length >= t.length) return null;
  return parsed;
}

/** 混合载荷里的 JSON 行判据：整行是容器 + 至少这么长才值得展开
 *  （日志里夹的 500 字单行 JSON 是「乱」的主角；短 `{}` 行展开反而更啰嗦）。
 *  字符串字面量行先解开一层再判容器（同 toolDisplay 的整体解开纪律）。 */
const JSON_LINE_MIN = 120;

function lineJson(line: string): unknown | undefined {
  let t = line.trim();
  if (t.length < JSON_LINE_MIN) return undefined;
  if (t.slice(0, 1) === '"') {
    const inner = unwrapStringLiteral(t);
    if (inner === null) return undefined;
    t = inner.trim();
    if (t.length < JSON_LINE_MIN) return undefined;
  }
  const head = t.slice(0, 1);
  if (head !== '{' && head !== '[') return undefined;
  return tryParseJson(t);
}

/**
 * 载荷 → 展示模型。
 * 四条路：
 *   ⓪ 整段是 JSON 字符串字面量（双层编码的文本）→ 解开重走一遍（层数封顶）；
 *   ① 整段是 JSON 容器 → 结构化行（键值行 + 缩进 + 类型着色）；
 *   ② 纯文本里夹长 JSON 行（日志/命令输出常见）→ 逐行展开，**仅当展开后行数
 *      不超上限**——大文件内容不因个别 JSON 行被截断（超限回落纯文本，保住全文）；
 *   ③ 其余 → 纯文本（仅洁净化：ANSI/控制字符/CR）。
 * 解析只对容器/字符串形态尝试：纯文本载荷零解析开销。
 */
export function toolDisplay(raw: string | undefined): ToolDisplay {
  return toolDisplayAt(raw, 0);
}

function toolDisplayAt(raw: string | undefined, unwrapDepth: number): ToolDisplay {
  const clean = sanitizePayloadText(raw ?? '');
  const head = clean.trimStart().slice(0, 1);
  if (head === '"' && unwrapDepth < MAX_UNWRAP) {
    const inner = unwrapStringLiteral(clean);
    if (inner !== null) return toolDisplayAt(inner, unwrapDepth + 1);
  }
  if (head === '{' || head === '[') {
    const parsed = tryParseJson(clean.trim());
    if (parsed !== undefined) {
      const lines: ToolLine[] = [];
      emit(parsed, 0, lines, {});
      const capped = capLines(lines);
      return { text: toolLinesText(capped), lines: capped };
    }
    // 截断的 JSON 容器（模型 slice 过的结果串）：整段 parse 失败但结构还在
    const lenient = bestEffortLines(clean);
    if (lenient) {
      const capped = capLines(lenient);
      return { text: toolLinesText(capped), lines: capped };
    }
  }
  const rawLines = clean.split('\n');
  const needsStructure = rawLines.some((l) => lineJson(l) !== undefined || bestEffortLines(l) !== null);
  if (needsStructure) {
    const lines: ToolLine[] = [];
    for (const line of rawLines) {
      const parsed = lineJson(line);
      if (parsed !== undefined) {
        emit(parsed, 0, lines, {});
        continue;
      }
      const lenient = bestEffortLines(line);
      if (lenient) {
        lines.push(...lenient);
        continue;
      }
      if (line) lines.push({ level: 0, parts: [{ text: line, tone: 'plain' }] });
      else lines.push({ level: 0, parts: [] });
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

/* ── ③ 程文信封分段（code_execution 输出）── */

/** 程文段语义：日志 / 完成值 / 错误（信封解析产物）| out = 无信封载荷的回退段。 */
export type CodeSectionKind = 'logs' | 'result' | 'error' | 'out';

/** 程文段：段头文案 + 段原始文本（尚未过 toolDisplay——折叠行只需长度）。 */
export interface CodeSection {
  kind: CodeSectionKind;
  /** 段头文案（渲染端展示；测量端只消费段序与 gap 判据）。 */
  label: string;
  raw: string;
}

/** 程文段展示模型（渲染 / 测量共用的唯一投影）。 */
export interface CodeDisplaySection extends CodeSection {
  display: ToolDisplay;
}

/* 信封行 —— 生成端 = agent/code-run/code-execution-tool.ts（自产契约，展示面解析）。 */
const CODE_LOGS_MARK = '── logs ──';
const CODE_RESULT_MARK = '── result ──';
/** `── code run failed (exception) ──` */
const CODE_FAIL_MARK_RE = /^── code run failed \(([^)]+)\) ──$/;
/** `[code_execution 失败] kind=exception` */
const CODE_FAIL_HEAD_RE = /^\[code_execution 失败\] kind=(\S+)$/;

/** 程文输出 → 段序（2026-09-19 程文输出换代）。
 *
 *  病灶：输出栏此前整段直出——信封行 `── logs ──` 当正文渲染，日志与完成值
 *  同一段无分界；且完成值是二次编码的字符串时整段是转义乱码（真机 69 个存盘
 *  样本：31 个含 >800 字符单行，最长 14711 字符挤在 2 个物理行里）。
 *  对策：信封是自产契约 ⇒ 解析成真段（段头走 .pp-sec-head 同一套），
 *  完成值段走 toolDisplay 的解转义（纸面读到的是文本本体）。
 *
 *  纪律：段序 = 信封出现序（日志在前、失败在后）；空白段不产出（不支空段头）；
 *  无信封的载荷（旧卷 / `(程序完成，无输出)`）整体落一个 `输出` 段——老卡零回归。
 *  本函数不做 toolDisplay 投影（折叠行只需长度，展示面各自投影）——零解析开销。 */
export function codeSections(raw: string | undefined): CodeSection[] {
  if (!raw) return [];
  const out: CodeSection[] = [];
  let cur: { kind: CodeSectionKind; label: string; buf: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const text = cur.buf.join('\n');
    if (hasPayloadToShow(text)) out.push({ kind: cur.kind, label: cur.label, raw: text });
    cur = null;
  };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === CODE_LOGS_MARK) {
      flush();
      cur = { kind: 'logs', label: '日志', buf: [] };
      continue;
    }
    if (t === CODE_RESULT_MARK) {
      flush();
      cur = { kind: 'result', label: '完成值', buf: [] };
      continue;
    }
    const fail = CODE_FAIL_MARK_RE.exec(t) ?? CODE_FAIL_HEAD_RE.exec(t);
    if (fail) {
      // 失败分类进段头（kind=exception → `错误 · exception`）：信封行的信息
      // 不被丢掉，只是从正文升格成段头。
      flush();
      cur = { kind: 'error', label: `错误 · ${fail[1]}`, buf: [] };
      continue;
    }
    if (cur) cur.buf.push(line);
    else cur = { kind: 'out', label: '输出', buf: [line] };
  }
  flush();
  return out;
}

/** 程文段 + 展示投影（渲染 CodeBody / 测量 measure 两处消费同一产物）。 */
export function codeDisplay(raw: string | undefined): CodeDisplaySection[] {
  return codeSections(raw).map((s) => ({ ...s, display: toolDisplay(s.raw) }));
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
