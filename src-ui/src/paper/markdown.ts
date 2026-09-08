// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/markdown — 正文（markdown 块）单一解析：渲染层与测量层共用的模型。
//
// 缘起（2026-08-30 会话流渲染专项）：TextBody 旧实现只按双换行分段平铺，
// 标题/列表/强调/链接/表格全部以字面量进纸——「没有 markdown 渲染」的直接根因。
//
// 为什么自写解析器而不是 react-markdown：本仓纸面纪律是「measure.ts 镜像 CSS、
// 测高是唯一真相」——块高由 canvas 预测量喂绝对定位布局，渲染与测量必须消费
// **同一个结构模型**，否则两边结构漂移 = 块重叠。单一解析（parsePlanItems /
// parseCircledSegments 同款先例）让渲染器与测量器共用本文件输出，结构漂移
// 结构性不成立。react-markdown（package.json 既有依赖）黑盒渲染无法镜像测量。
//
// 覆盖子集（agent 产出的常见面）：ATX 标题 1-4 / 段落 / 有序无序列表（一层
// 嵌套递归）/ 引用 / 围栏码 / GFM 表格 / 分隔线 / 行内：加粗·斜体·删除线·
// 行内码·链接。流式容忍：未闭合围栏按已闭合产出（块随 token 生长）；
// 未配对的强调标记按字面量保留。超出子集的行→段落兜底，不丢字。

/** 行内片段：text 恒有；标志位任一为真 = 富行内（测量端按偏窄宽度保守计高）。 */
export interface MdInline {
  text: string;
  /** 加粗 */
  b?: boolean;
  /** 斜体 */
  i?: boolean;
  /** 删除线 */
  s?: boolean;
  /** 行内码（内部不再解析嵌套标记） */
  c?: boolean;
  /** 链接目标（href 存在时 text 为链接文字） */
  href?: string;
  /** 行内数学（LaTeX 源码，不含 `$` 定界符；text 同存源码供测量近似）。
   *  KaTeX 渲染为不可折行原子（break:never）——见 renderer/measure 镜像。 */
  math?: string;
}

export type MdBlock =
  | { t: 'p'; inl: MdInline[] }
  | { t: 'h'; lv: 1 | 2 | 3 | 4; inl: MdInline[] }
  | { t: 'list'; ord: boolean; start: number; items: MdListItem[] }
  | { t: 'quote'; blocks: MdBlock[] }
  | { t: 'code'; lang?: string; text: string }
  | { t: 'math'; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: MdInline[][]; rows: MdInline[][][] }
  /** 远端图（B4 · D-9）：独立行 `![alt](http/https)` 专用块型——src 已过协议
   *  白名单；非白名单源（data:/file:/相对路径等）在解析层降级 alt 文本，
   *  不产本块型。渲染/测高共用固定盒（measure 镜像），加载态不改版面。 */
  | { t: 'img'; alt: string; src: string };

export interface MdListItem {
  inl: MdInline[];
  /** 项内嵌套块（更深层列表 / 缩进续行 / 引用）——递归解析产物 */
  sub?: MdBlock[];
  /** 任务列表复选框（GFM `- [ ]` / `- [x]`；2026-09 scientific-rendering #15）：
   *  true = 待办 `[ ]`，false = 已完成 `[x]`；undefined = 普通列表项。 */
  check?: boolean;
}

/* ── 行内解析 ── */

interface InlineFlags {
  b?: boolean;
  i?: boolean;
  s?: boolean;
}

/** 行内码/链接内部的邻接片段合并（同标志位合并，减少无谓 span）。 */
function mergeInline(out: MdInline[], seg: MdInline): void {
  const last = out[out.length - 1];
  if (
    last &&
    !!last.b === !!seg.b &&
    !!last.i === !!seg.i &&
    !!last.s === !!seg.s &&
    !!last.c === !!seg.c &&
    last.href === seg.href &&
    last.math === seg.math // math 段按源码隔离（相邻两公式不合并——渲染不可折行原子）
  ) {
    last.text += seg.text;
    return;
  }
  out.push(seg);
}

/** `_` 只在词边界起强调（intraword snake_case 不斜体——CommonMark 直觉）。 */
function emphBoundary(text: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = text[idx - 1];
  return /[\s([{<'"\u4e00-\u9fff，。；：、！？]/.test(prev);
}

function parseInlineInner(raw: string, flags: InlineFlags): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) {
      mergeInline(out, { text: buf, ...flags });
      buf = '';
    }
  };
  while (i < raw.length) {
    const ch = raw[i];
    // 转义：下一字符字面量
    if (ch === '\\' && i + 1 < raw.length && /[`*_~[\]\\$]/.test(raw[i + 1])) {
      buf += raw[i + 1];
      i += 2;
      continue;
    }
    // 行内码：成对反引号内不解析任何标记
    if (ch === '`') {
      const end = raw.indexOf('`', i + 1);
      if (end > i) {
        flush();
        mergeInline(out, { text: raw.slice(i + 1, end), c: true });
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    // 加粗 / 斜体 / 删除线（先试三连标记 ***粗斜***，再退两连）
    const three = raw.slice(i, i + 3);
    if (three === '***' || three === '___') {
      const end = raw.indexOf(three, i + 3);
      if (end > i) {
        flush();
        for (const seg of parseInlineInner(raw.slice(i + 3, end), { ...flags, b: true, i: true })) out.push(seg);
        i = end + 3;
        continue;
      }
    }
    const two = raw.slice(i, i + 2);
    if (two === '**' || two === '__') {
      const marker = two;
      const end = raw.indexOf(marker, i + 2);
      if (end > i) {
        flush();
        for (const seg of parseInlineInner(raw.slice(i + 2, end), { ...flags, b: true })) out.push(seg);
        i = end + 2;
        continue;
      }
    }
    if (two === '~~') {
      const end = raw.indexOf('~~', i + 2);
      if (end > i) {
        flush();
        for (const seg of parseInlineInner(raw.slice(i + 2, end), { ...flags, s: true })) out.push(seg);
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && emphBoundary(raw, i))) {
      const end = raw.indexOf(ch, i + 1);
      // `_` 的闭合同样要落在词边界（snake_a_b 不斜体）；`*` 无此约束
      const closeOk =
        end === raw.length - 1 || ch === '*' || /[\s)\]},.;:!?'"\u4e00-\u9fff，。；：、！？]/.test(raw[end + 1]);
      if (end > i + 1 && raw[end - 1] !== ' ' && closeOk) {
        flush();
        for (const seg of parseInlineInner(raw.slice(i + 1, end), { ...flags, i: true })) out.push(seg);
        i = end + 1;
        continue;
      }
    }
    // 行内数学 $...$（Pandoc 风格界约束防误伤）：
    //   - 开标记：ch === '$'，且前一字符不是字母/数字/反斜杠/美元（`$$` 属块级候选不在此开）
    //   - 内容：到下一个非转义 '$' 之间非空
    //   - 闭标记：`$` 后一字符不是字母/数字（货币 $5、变量 $foo、snake_$x 不误伤）
    //   界约束不查开标记后的空白——`$ E=mc^2 $`（公式内空格）是合法 LaTeX 惯用。
    if (ch === '$') {
      const prevCh = i > 0 ? raw[i - 1] : '\n';
      if (!/[\w\\$]/.test(prevCh)) {
        // 找下一个未转义的 $
        let end = -1;
        for (let k = i + 1; k < raw.length; k++) {
          if (raw[k] === '\\' && raw[k + 1] === '$') {
            k++;
            continue;
          }
          if (raw[k] === '$') {
            end = k;
            break;
          }
        }
        if (end > i + 1) {
          const nextCh = end < raw.length - 1 ? raw[end + 1] : '\n';
          if (!/[\w]/.test(nextCh)) {
            const body = raw.slice(i + 1, end).trim();
            if (body.length > 0) {
              flush();
              mergeInline(out, { text: body, math: body });
              i = end + 1;
              continue;
            }
          }
        }
      }
      buf += ch;
      i++;
      continue;
    }
    // 链接 [text](url)
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(raw.slice(i));
      if (m) {
        flush();
        mergeInline(out, { text: m[1], href: m[2] });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** 行内解析入口（渲染器与测量共用——标志位打平，无嵌套节点）。 */
export function parseInline(raw: string): MdInline[] {
  return parseInlineInner(raw, {});
}

/** 文本是否含数学定界符（块级 `$$` 或行内 `$`）——壳层 RO 判据（含公式的
 *  markdown 块走 ResizeObserver 实测回写，公式高不被静态镜像限制）。
 *  快扫近似（不等同精确解析——`textHasMath('x $5 预算')` 会误报真，但方向
 *  安全：多挂 RO 无副作用，漏挂才会高估错位）。 */
export function textHasMath(text: string): boolean {
  return text.includes('$$') || text.includes('$');
}

/** 文本是否含 GFM 表格（「含竖线行 + 紧随分隔行」快扫——壳层 RO 判据，
 *  与 textHasMath 同款语义：多挂 RO 无副作用，漏挂才高估错位）。
 *  判据与 parseMarkdown 表格分支同源（本行有竖线 && 下一行是分隔行）。 */
export function textHasTable(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && isTableSeparator(lines[i + 1])) return true;
  }
  return false;
}

/** 片段序列 → 纯文本（测量端用：pretext 只测纯文本）。 */
export function mdPlainText(inl: MdInline[]): string {
  return inl.map((s) => s.text).join('');
}

/** 富行内判定（测量端偏窄宽度计高——行内码/加粗/链接/公式改变字宽，宁可多计行）。 */
export function mdHasRichInline(inl: MdInline[]): boolean {
  return inl.some((s) => s.c || s.b || s.i || s.s || s.href !== undefined || s.math !== undefined);
}

/* ── 块级解析 ── */

const FENCE_RE = /^(```|~~~)\s*([^`]*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** 独立行图（B4 D-9）：整行 `![alt](url)`（可带 "title" 后缀——链接同款）。
 *  alt 允许空（`![](url)` 常见）；url 不含空白/括号（对齐 parseInline 链接段）。 */
const IMG_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;

/** 远端图协议白名单（B4 · D-9，抄 DSH remoteImageUrl 纪律）：仅 http/https 绝对
 *  URL 放行；其余协议（data:/file:/javascript:）与相对路径（new URL 无基址即拒）
 *  一律 undefined → 解析层降级 alt 文本。白名单过在解析层而非渲染层——
 *  measure 与 render 消费同一结构，拒绝路径不产生待测盒。 */
export function remoteImageSrc(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    // 非绝对 URL（相对路径等）——与不允许协议同拒（new URL 无基址仅此一种失败）
    return undefined;
  }
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line.replace(/\t/g, '  ')) {
    if (ch === ' ') n++;
    else break;
  }
  return n;
}

function isBlockStart(line: string): boolean {
  const t = line.trimStart();
  return (
    t.length === 0 ||
    FENCE_RE.test(t) ||
    HEADING_RE.test(t) ||
    HR_RE.test(line.trim()) ||
    IMG_LINE_RE.test(t) ||
    t.startsWith('>') ||
    LIST_RE.test(line) ||
    (t.includes('|') && TABLE_SEP_RE.test(t))
  );
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** 表格分隔行判据：`| --- | :---: |` 形态（至少一格是短横）。 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  return TABLE_SEP_RE.test(line);
}

/** 列表块收集：base 层级条目 + 深缩进内容归入当前条目（递归解析成 sub）。 */
function collectList(lines: string[], startIdx: number): { block: MdBlock; next: number } | null {
  const first = LIST_RE.exec(lines[startIdx]);
  if (!first) return null;
  const baseIndent = indentOf(lines[startIdx]);
  const ord = /\d/.test(first[2]);
  const start = ord ? Number.parseInt(first[2], 10) : 1;
  const items: MdListItem[] = [];
  let subLines: string[] = [];
  let i = startIdx;

  const flushItem = (): void => {
    if (items.length === 0) return;
    const item = items[items.length - 1];
    if (subLines.length > 0) {
      const sub = parseMarkdown(subLines.join('\n'));
      if (sub.length > 0) item.sub = sub;
      subLines = [];
    }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, '  ');
    const m = LIST_RE.exec(line);
    if (m && indentOf(line) <= baseIndent + 1) {
      flushItem();
      // 任务复选框（GFM `- [ ]` / `- [x]`，2026-09 #15）：紧贴标记的 `[ ]`/`[x]`
      // 剥出为 check 语义（大小写/空格宽松：`[X]`/`[ x ]` 均收）；其余照常。
      // 仅吃列表项内容首位——非首位 `[x]` 是普通文本（如「先看 [x] 再决定」）。
      let check: boolean | undefined;
      let rest = m[3];
      const cm = /^\[([ xX])\]\s*(.*)$/.exec(rest);
      if (cm) {
        check = cm[1] !== 'x' && cm[1] !== 'X';
        rest = cm[2];
      }
      items.push({ inl: parseInline(rest), check });
      i++;
      continue;
    }
    if (line.trim() === '') {
      // 空行：后面还有同层条目/深缩进内容 → 属于列表（松散列表）；否则收束
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      if (next !== undefined && (LIST_RE.test(next) || indentOf(next) > baseIndent + 1)) {
        i++;
        continue;
      }
      break;
    }
    if (m && indentOf(line) > baseIndent + 1) {
      subLines.push(line.slice(baseIndent + 2));
      i++;
      continue;
    }
    if (indentOf(line) > baseIndent + 1) {
      // 缩进续行（列表项内折行段落）
      subLines.push(line.slice(baseIndent + 2));
      i++;
      continue;
    }
    break;
  }
  flushItem();
  if (items.length === 0) return null;
  return { block: { t: 'list', ord, start, items }, next: i };
}

/** 详细解析结果：块 + 每块起始行号（0 基）。 */
interface MdDetailed {
  blocks: MdBlock[];
  /** 与 blocks 等长——每块的起始行号（0 基，流式追加后行号稳定）。 */
  starts: number[];
}

/** 全量解析（内部）：块 + 起始行跟踪。增量入口 parseMarkdownIncremental 复用。 */
function parseDetailed(text: string): MdDetailed {
  if (!text) return { blocks: [], starts: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  const starts: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }
    const blockStart = i;
    // 围栏码（未闭合按到文末——流式容忍）
    const fence = FENCE_RE.exec(trimmed);
    if (fence) {
      const lang = fence[2].trim() || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner.startsWith(fence[1])) {
          i++;
          break;
        }
        code.push(lines[i]);
        i++;
      }
      blocks.push({ t: 'code', lang, text: code.join('\n') });
      starts.push(blockStart);
      continue;
    }
    // 块级数学：$$ 起行的公式块（单行 `$$x=y$$` 或跨行 `$$\n…\n$$`——
    // 未闭合按到文末，流式容忍同围栏码）。模型科学输出惯用形态：
    //   $$
    //   \hat{y} = \sigma(Wx + b)
    //   $$
    // 单行闭合（$$...$$ 同行首尾）也收——LaTeX display 习惯可省换行。
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2);
      // 同行闭：`$$ 内容 $$`（首行内同时有开与闭）
      const sameLineClose = rest.lastIndexOf('$$');
      if (sameLineClose > 0) {
        const body = rest.slice(0, sameLineClose).trim();
        if (body.length > 0) {
          blocks.push({ t: 'math', text: body });
          starts.push(blockStart);
          i++;
          continue;
        }
      }
      // 跨行闭：收集到含 $$ 的行 / 文末
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner.startsWith('$$')) {
          const tail = inner.slice(2).trim();
          if (tail) body.push(tail);
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const joined = body.join('\n').trim();
      if (joined.length > 0) {
        blocks.push({ t: 'math', text: joined });
        starts.push(blockStart);
      }
      continue;
    }
    // 标题（5/6 级按 4 级收）
    const h = HEADING_RE.exec(trimmed);
    if (h) {
      const lv = Math.min(4, h[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ t: 'h', lv, inl: parseInline(h[2].trim()) });
      starts.push(blockStart);
      i++;
      continue;
    }
    // 独立行图（B4 D-9）：![alt](http/https) → 固定盒 img 块；非白名单源
    // 降级 alt 文本段落（DSH 同语义；alt 空则整行不产块——data: 巨串不灌纸面，
    // 本地路径/data URI 不进图通道，资产通道（show_asset）既有职责不重叠）。
    const img = IMG_LINE_RE.exec(trimmed);
    if (img) {
      const src = remoteImageSrc(img[2]);
      if (src !== undefined) {
        blocks.push({ t: 'img', alt: img[1], src });
        starts.push(blockStart);
      } else if (img[1] !== '') {
        blocks.push({ t: 'p', inl: parseInline(img[1]) });
        starts.push(blockStart);
      }
      i++;
      continue;
    }
    // 分隔线
    if (HR_RE.test(trimmed) && !LIST_RE.test(line)) {
      blocks.push({ t: 'hr' });
      starts.push(blockStart);
      i++;
      continue;
    }
    // 引用：连续 > 行剥标记后递归
    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length) {
        const t = lines[i].replace(/\t/g, '  ').trim();
        if (t.startsWith('>')) {
          quote.push(t.replace(/^>\s?/, ''));
          i++;
          continue;
        }
        break;
      }
      const inner = parseMarkdown(quote.join('\n'));
      if (inner.length > 0) {
        blocks.push({ t: 'quote', blocks: inner });
        starts.push(blockStart);
      }
      continue;
    }
    // 表格：本行有竖线且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitTableRow(line).map(parseInline);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ t: 'table', head, rows });
      starts.push(blockStart);
      continue;
    }
    // 列表
    const list = collectList(lines, i);
    if (list) {
      blocks.push(list.block);
      starts.push(blockStart);
      i = list.next;
      continue;
    }
    // 段落：攒到块级起点/空行。首行无条件收进（孤立块级起点行——如表格分隔行
    // `| --- | --- |`——前面分支不匹配但 isBlockStart 为真，若空转则死循环；
    // 首行进段落保证 i 必前进、解析必终止，语义 = 超出子集的行→段落兜底不丢字）。
    const para: string[] = [lines[i].replace(/\t/g, '  ').trimEnd()];
    i++;
    while (i < lines.length && !isBlockStart(lines[i].replace(/\t/g, '  '))) {
      para.push(lines[i].replace(/\t/g, '  ').trimEnd());
      i++;
    }
    const joined = para.join('\n').trim();
    if (joined) {
      blocks.push({ t: 'p', inl: parseInline(joined) });
      starts.push(blockStart);
    }
  }
  return { blocks, starts };
}

/** markdown → 块模型（渲染 MarkdownBody 与测量 measureMdBlocks 共用入口）。 */
export function parseMarkdown(text: string): MdBlock[] {
  return parseDetailed(text).blocks;
}

/* ── 增量解析（2026-08-30 性能专项）：流式追加只重解析最后一个块 ── */

/** 增量解析状态：上次的完整文本 + 块 + 最后一块起始行。 */
export interface MdParseState {
  text: string;
  blocks: MdBlock[];
  /** 最后一个顶层块起始行（0 基）；无块 = -1 */
  lastBlockStartLine: number;
}

/** 从指定行号（0 基）截取剩余文本（避免全量 split 分配）。 */
function sliceLines(text: string, startLine: number): string {
  if (startLine <= 0) return text;
  let idx = 0;
  for (let k = 0; k < startLine; k++) {
    const n = text.indexOf('\n', idx);
    if (n < 0) return '';
    idx = n + 1;
  }
  return text.slice(idx);
}

/**
 * 增量 markdown 解析：文本尾部追加（流式）时复用稳定前缀块，只从最后一块
 * 起始行重解析。非追加（编辑/重置）自动回退全量。
 * 正确性根基：块边界由行首标记决定，追加只可能影响最后一个块（段落续行 /
 * 列表续项 / 表格续行 / 未闭合围栏都落在最后一块内）；从最后一块起始行
 * 重解析与全量解析逐字节一致。
 */
export function parseMarkdownIncremental(
  text: string,
  prev: MdParseState | null,
): { blocks: MdBlock[]; state: MdParseState } {
  if (prev && text === prev.text) return { blocks: prev.blocks, state: prev };
  if (!prev || !text.startsWith(prev.text) || prev.blocks.length === 0) {
    const r = parseDetailed(text);
    return {
      blocks: r.blocks,
      state: { text, blocks: r.blocks, lastBlockStartLine: r.starts.length ? r.starts[r.starts.length - 1] : -1 },
    };
  }
  const prefixBlocks = prev.blocks.slice(0, -1);
  const tailText = sliceLines(text, prev.lastBlockStartLine);
  const tail = parseDetailed(tailText);
  const blocks = [...prefixBlocks, ...tail.blocks];
  const lastBlockStartLine = tail.starts.length
    ? prev.lastBlockStartLine + tail.starts[tail.starts.length - 1]
    : prev.lastBlockStartLine;
  return { blocks, state: { text, blocks, lastBlockStartLine } };
}
